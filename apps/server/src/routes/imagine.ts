import type { Part } from '@newtavern/core';
import { isAbortError, type ImageGenParams } from '@newtavern/providers';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { Db } from '../db/client.js';
import type { AssetsService } from '../services/assets.js';
import {
  insertNode,
  loadChat,
  loadNodes,
  patchChat,
  toChatSummary,
  toMessageNode,
  type ChatRow,
} from '../services/chat-tree.js';
import {
  buildWriterIr,
  clampSize,
  ImageGenError,
  isImageGenNode,
  readImageGenSettings,
  resolveImageConnection,
  resolveWriterTarget,
  writeImagePrompt,
  type ImagineMode,
  type PromptLanguage,
} from '../services/image-gen.js';
import { createJob, getJob, setJobProgress, toJobView, updateJob } from '../services/jobs.js';
import { generatedImageMime } from '../services/media.js';
import type { ProviderService } from '../services/providers.js';

/**
 * 外接生图：`POST /api/chats/:id/imagine`（SSE）与 `GET /api/jobs/:id`。
 * 见 docs/M4-CONTRACT.md 第二部分 §D.2。
 *
 * SSE 事件：`job {id,status}` → [`prompt {text}`] → `progress {fraction}`* →
 * `node {node,chat}`（或 attach=false 时 `asset {assetId,mime,url}`）→ `done`；失败时 `error {message,kind}`。
 */

const SSE_PADDING = 2048;
const PING_INTERVAL_MS = 15_000;
const MODES: readonly ImagineMode[] = ['free', 'last_message', 'character'];

interface ImagineBody {
  mode?: unknown;
  prompt?: unknown;
  negative?: unknown;
  width?: unknown;
  height?: unknown;
  parentId?: unknown;
  /** 重画：同参数新种子，作为该生图节点的兄弟（swipe） */
  redrawOf?: unknown;
  /** false = 只生成并存资产，不写消息树（前端卡 `newtavern.generateImage`） */
  attach?: unknown;
  /** 撰写提示词用的模板语言 */
  lang?: unknown;
}

interface NodeImageExtra {
  generatedBy: 'image';
  imagePrompt: string;
  backend: string;
  seed?: number;
  mode: ImagineMode;
  negative: string;
  width: number;
  height: number;
  jobId: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

function errorPayload(e: unknown): { message: string; kind: string } {
  const record = e as { message?: unknown; kind?: unknown };
  return {
    message: typeof record.message === 'string' && record.message ? record.message : String(e),
    kind: typeof record.kind === 'string' ? record.kind : 'invalid',
  };
}

export function createImagineRoutes(
  db: Db,
  dataDir: string,
  providers: ProviderService,
  assets: AssetsService,
) {
  return new Hono().post('/:id/imagine', async (c) => {
    const chatId = c.req.param('id');
    const chat = loadChat(db, chatId);
    if (!chat) return c.json({ error: 'not_found' }, 404);

    let body: ImagineBody = {};
    try {
      body = ((await c.req.json()) ?? {}) as ImagineBody;
    } catch {
      body = {};
    }

    const settings = readImageGenSettings(db);
    const nodes = loadNodes(db, chatId);

    // ---------- 参数（重画时从原节点取） ----------
    const redrawId = str(body.redrawOf);
    const redrawOf = redrawId ? nodes.find((node) => node.id === redrawId) : undefined;
    if (redrawId && (!redrawOf || !isImageGenNode(redrawOf))) {
      return c.json({ error: 'invalid', message: '只能重画生图消息' }, 400);
    }
    const previous = (redrawOf?.extra ?? null) as Partial<NodeImageExtra> | null;

    const mode: ImagineMode = previous
      ? (previous.mode ?? 'free')
      : MODES.includes(body.mode as ImagineMode)
        ? (body.mode as ImagineMode)
        : 'free';
    const givenPrompt = previous?.imagePrompt ?? str(body.prompt);
    if (mode === 'free' && !givenPrompt) {
      return c.json({ error: 'invalid', message: '自由描述需要 prompt' }, 400);
    }
    if (mode === 'character' && !givenPrompt && !chat.characterIds[0]) {
      return c.json({ error: 'no_character', message: '这个会话没有角色，不能「画角色」' }, 400);
    }
    const attach = body.attach !== false;
    const lang: PromptLanguage = body.lang === 'en' ? 'en' : 'zh-CN';
    const negative =
      typeof body.negative === 'string'
        ? body.negative
        : (previous?.negative ?? settings.defaults.negative);
    const width = clampSize(body.width ?? previous?.width, settings.defaults.width);
    const height = clampSize(body.height ?? previous?.height, settings.defaults.height);

    // 父节点：重画 = 原节点的父；显式 parentId（null = 根）；缺省 = head
    let parentId: string | null;
    if (redrawOf) parentId = redrawOf.parentId;
    else if (body.parentId === null) parentId = null;
    else if (typeof body.parentId === 'string') {
      if (!nodes.some((node) => node.id === body.parentId)) {
        return c.json({ error: 'not_found', message: `节点不存在：${body.parentId}` }, 404);
      }
      parentId = body.parentId;
    } else parentId = chat.headNodeId;

    // ---------- 连接 ----------
    if (!settings.connectionId) {
      return c.json(
        { error: 'no_image_backend', message: '还没有选择生图后端（设置 → 连接 → 生图后端）' },
        400,
      );
    }
    let resolved: ReturnType<typeof resolveImageConnection>;
    let writer: { connectionId: string; model: string } | null = null;
    try {
      resolved = resolveImageConnection(db, providers, settings.connectionId);
      if (mode !== 'free' && !givenPrompt) writer = resolveWriterTarget(db, chat, settings);
    } catch (e) {
      if (e instanceof ImageGenError) {
        return c.json({ error: e.code, message: e.message }, e.status);
      }
      throw e;
    }
    const { conn, backend } = resolved;

    const baseParams: Omit<ImageGenParams, 'prompt'> = {
      negative,
      width,
      height,
      steps: settings.defaults.steps,
      cfg: settings.defaults.cfg,
      ...(settings.defaults.sampler ? { sampler: settings.defaults.sampler } : {}),
      ...(settings.model ? { model: settings.model } : {}),
      ...(conn.provider === 'image-comfy' && settings.comfyWorkflow
        ? { workflow: settings.comfyWorkflow }
        : {}),
    };

    const job = createJob(db, 'image_gen', {
      chatId,
      mode,
      connectionId: conn.id,
      backend: conn.provider,
      parentId,
      attach,
      ...(redrawOf ? { redrawOf: redrawOf.id } : {}),
      width,
      height,
    });

    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      const ac = new AbortController();
      let aborted = false;
      const onClientGone = () => {
        if (aborted) return;
        aborted = true;
        ac.abort();
      };
      c.req.raw.signal.addEventListener('abort', onClientGone);
      stream.onAbort(onClientGone);
      const send = async (event: string, data: unknown) => {
        if (aborted) return;
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      await stream.write(`:${'-'.repeat(SSE_PADDING)}\n\n`);
      const ping = setInterval(() => void stream.write(': ping\n\n'), PING_INTERVAL_MS);

      try {
        await send('job', { id: job.id, status: 'pending' });
        updateJob(db, job.id, { status: 'running' });
        await send('job', { id: job.id, status: 'running' });

        // 1. 提示词：自由描述 / 重画直接用；其余先让聊天模型写
        let prompt = givenPrompt ?? '';
        if (!prompt && writer) {
          const ir = buildWriterIr(
            db,
            { mode: mode as 'last_message' | 'character', chat, nodes, parentId, lang },
            writer.model,
          );
          prompt = await writeImagePrompt(db, dataDir, providers, {
            ...writer,
            ir,
            signal: ac.signal,
          });
        }
        // 画风前缀只在第一次拼；重画沿用原节点里已经拼好的完整提示词
        if (!previous && settings.stylePrefix && !prompt.startsWith(settings.stylePrefix)) {
          prompt = `${settings.stylePrefix}, ${prompt}`;
        }
        updateJob(db, job.id, { payload: { prompt } });
        await send('prompt', { text: prompt });

        // 2. 调后端
        const result = await backend.generate(
          conn,
          { ...baseParams, prompt },
          ac.signal,
          (fraction) => {
            setJobProgress(job.id, fraction);
            void send('progress', { fraction });
          },
        );

        // 3. 落资产
        const imageParts: Extract<Part, { type: 'image' }>[] = [];
        for (const image of result.images) {
          const bytes = Buffer.from(image.data, 'base64');
          const mime = bytes.length > 0 ? generatedImageMime(bytes, image.mime) : null;
          if (!mime) continue;
          const asset = assets.save({
            bytes,
            kind: 'generated',
            mime,
            source: `imagine:${job.id}`,
            meta: {
              prompt,
              backend: conn.provider,
              ...(result.seed === undefined ? {} : { seed: result.seed }),
            },
          });
          imageParts.push({ type: 'image', assetId: asset.id, mime: asset.mime });
        }
        if (imageParts.length === 0) throw new Error('生图后端返回的图片无法识别');
        const assetIds = imageParts.map((part) => part.assetId);

        if (!attach) {
          updateJob(db, job.id, {
            status: 'done',
            result: {
              assetIds,
              prompt,
              ...(result.seed === undefined ? {} : { seed: result.seed }),
            },
          });
          for (const part of imageParts) {
            await send('asset', {
              assetId: part.assetId,
              mime: part.mime,
              url: `/api/assets/${encodeURIComponent(part.assetId)}/file`,
            });
          }
          await send('job', { id: job.id, status: 'done' });
          await send('done', { jobId: job.id, assetIds, prompt });
          return;
        }

        // 4. 入树：当前 head（或指定父节点）下的助手节点，head 移过去
        const fresh = loadChat(db, chatId) as ChatRow;
        const characterName = toChatSummary(db, fresh).character?.name ?? null;
        const extra: NodeImageExtra = {
          generatedBy: 'image',
          imagePrompt: prompt,
          backend: conn.provider,
          ...(result.seed === undefined ? {} : { seed: result.seed }),
          mode,
          negative,
          width,
          height,
          jobId: job.id,
        };
        const row = insertNode(db, {
          chatId,
          parentId,
          role: 'assistant',
          parts: imageParts,
          name: characterName,
          provider: conn.provider,
          model: settings.model ?? null,
          extra: extra as unknown as Record<string, unknown>,
        });
        const updated = patchChat(db, chatId, {
          headNodeId: row.id,
          rootNodeId: row.parentId === null ? (fresh.rootNodeId ?? row.id) : fresh.rootNodeId,
        });
        updateJob(db, job.id, {
          status: 'done',
          result: {
            nodeId: row.id,
            assetIds,
            prompt,
            ...(result.seed === undefined ? {} : { seed: result.seed }),
          },
        });
        const chatSummary = toChatSummary(db, updated);
        await send('node', { node: toMessageNode(row), chat: chatSummary });
        await send('job', { id: job.id, status: 'done' });
        await send('done', { jobId: job.id, node: toMessageNode(row), chat: chatSummary });
      } catch (e) {
        const cancelled = aborted || isAbortError(e);
        const error = cancelled ? { message: '已取消', kind: 'abort' } : errorPayload(e);
        updateJob(db, job.id, { status: 'failed', result: { error } });
        await send('job', { id: job.id, status: 'failed' });
        await send('error', error);
      } finally {
        clearInterval(ping);
        c.req.raw.signal.removeEventListener('abort', onClientGone);
      }
    });
  });
}

/** `GET /api/jobs/:id`：前端刷新页面后续看进度 */
export function createJobsRoutes(db: Db) {
  return new Hono().get('/:id', (c) => {
    const row = getJob(db, c.req.param('id'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(toJobView(row));
  });
}
