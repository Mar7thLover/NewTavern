import fs from 'node:fs';
import path from 'node:path';

import type { Part } from '@newtavern/core';
import {
  ImageBackendError,
  setImageBackendOverride,
  type ImageBackend,
  type ImageGenParams,
} from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { buildAssembleInput } from './services/assemble-input.js';
import { loadChat, loadNodes } from './services/chat-tree.js';
import { PNG_2X3 } from './services/media-fixtures.test-helper.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
  waitFor,
  type SseEvent,
  type TestApp,
} from './test-helpers.js';

/**
 * 外接生图（docs/M4-CONTRACT.md 第二部分 §D.2）：连接分类、imagine 三种模式、job 状态、
 * 节点入树与 head 移动、重画作为 swipe 兄弟、只存资产（前端卡）、组装时跳过生图节点。
 * 后端用测试替身（真实 HTTP 映射在 packages/providers/src/image/image.test.ts）。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body: unknown) => json('POST', body);

const PNG_B64 = Buffer.from(PNG_2X3).toString('base64');

interface Node {
  id: string;
  parentId: string | null;
  siblingSeq: number;
  role: string;
  name: string | null;
  parts: Part[];
  provider: string | null;
  extra: Record<string, unknown> | null;
}

/* ------------------------------------------------------------------ */
/* 替身后端：记录参数，按需失败 / 等中止                                   */
/* ------------------------------------------------------------------ */

const calls: ImageGenParams[] = [];
let behavior: 'ok' | 'fail' | 'hang' = 'ok';
let seedCounter = 100;

const fakeSd: ImageBackend = {
  id: 'image-sd',
  listModels: () => Promise.resolve([{ id: 'model-a.safetensors' }, { id: 'model-b.safetensors' }]),
  async generate(_conn, p, signal, onProgress) {
    calls.push(p);
    onProgress?.(0);
    if (behavior === 'fail') {
      throw new ImageBackendError({
        kind: 'overloaded',
        message: 'SD WebUI：CUDA out of memory',
        status: 500,
        retryable: true,
      });
    }
    if (behavior === 'hang') {
      await new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), {
          once: true,
        });
      });
    }
    onProgress?.(0.5);
    onProgress?.(1);
    seedCounter += 1;
    return { images: [{ mime: 'image/png', data: PNG_B64 }], seed: p.seed ?? seedCounter };
  },
};

setImageBackendOverride('image-sd', fakeSd);
afterAll(() => setImageBackendOverride('image-sd', null));
afterEach(() => {
  calls.length = 0;
  behavior = 'ok';
});

/** 写提示词用的聊天模型：回一段带换行、引号的关键词，验证清洗 */
const writerRequests: { messages: { role: string; content: string }[] }[] = [];
registerFakeAdapter({
  id: 'fake-writer',
  renderMessages: true,
  stream: async function* writerStream(_conn, req) {
    writerRequests.push(req.body as { messages: { role: string; content: string }[] });
    yield { type: 'text.delta', text: '"masterpiece,\n1girl, ' };
    yield { type: 'text.delta', text: 'rain, window"' };
    yield { type: 'stop', reason: 'end' };
  },
});

/* ------------------------------------------------------------------ */

async function setup(options: { stylePrefix?: string; withCharacter?: boolean } = {}) {
  const t = makeTestApp(dataDir);
  const { app, db } = t;
  const imageConn = (await (
    await app.request(
      '/api/connections',
      post({ provider: 'image-sd', label: '本机 SD', baseUrl: '', apiKeys: [] }),
    )
  ).json()) as { id: string; kind: string; baseUrl: string };
  await app.request(
    '/api/settings/imageGen',
    json('PUT', {
      connectionId: imageConn.id,
      defaults: {
        width: 640,
        height: 960,
        steps: 20,
        cfg: 6,
        sampler: 'Euler a',
        negative: 'lowres',
      },
      ...(options.stylePrefix ? { stylePrefix: options.stylePrefix } : {}),
    }),
  );
  const writer = insertConnection(db, dataDir, 'fake-writer');
  await app.request(
    '/api/settings/generation.default',
    json('PUT', { connectionId: writer.id, model: 'writer-model' }),
  );

  let characterIds: string[] = [];
  if (options.withCharacter !== false) {
    const character = db
      .insert(schema.characters)
      .values({
        name: '塞拉菲娜',
        spec: 'v2',
        data: {
          name: '塞拉菲娜',
          description: '{{char}} has long pink hair and green eyes, wears a white dress.',
          personality: 'kind',
          scenario: 'a forest glade',
        },
      })
      .returning()
      .get();
    characterIds = [character.id];
  }
  const chat = (await (await app.request('/api/chats', post({ characterIds }))).json()) as {
    id: string;
  };
  return { ...t, imageConn, writer, chatId: chat.id };
}

async function addMessage(app: TestApp['app'], chatId: string, role: string, text: string) {
  const res = await app.request(`/api/chats/${chatId}/messages`, post({ role, text }));
  expect(res.status).toBe(200);
  return (await res.json()) as { node: Node };
}

async function imagine(app: TestApp['app'], chatId: string, body: unknown): Promise<SseEvent[]> {
  const res = await app.request(`/api/chats/${chatId}/imagine`, post(body));
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

const eventNames = (events: SseEvent[]) => events.map((event) => event.event);
const headOf = (db: Db, chatId: string) => loadChat(db, chatId)?.headNodeId ?? null;

/* ------------------------------------------------------------------ */

describe('生图连接', () => {
  it('新建生图后端：默认 baseUrl、kind=image；?kind=chat 不列它；测试与模型走 listModels', async () => {
    const { app, db, imageConn, writer } = await setup();
    expect(imageConn.kind).toBe('image');
    expect(imageConn.baseUrl).toBe('http://127.0.0.1:7860');

    const all = (await (await app.request('/api/connections')).json()) as {
      id: string;
      kind: string;
    }[];
    expect(all.find((row) => row.id === writer.id)?.kind).toBe('chat');
    const chatOnly = (await (await app.request('/api/connections?kind=chat')).json()) as {
      id: string;
    }[];
    expect(chatOnly.map((row) => row.id)).not.toContain(imageConn.id);
    const imageOnly = (await (await app.request('/api/connections?kind=image')).json()) as {
      id: string;
    }[];
    expect(imageOnly.map((row) => row.id)).toEqual([imageConn.id]);

    const tested = await app.request(`/api/connections/${imageConn.id}/test`, post({}));
    expect(tested.status).toBe(200);
    expect(((await tested.json()) as { modelCount: number }).modelCount).toBe(2);
    const models = (await (
      await app.request(`/api/connections/${imageConn.id}/models`)
    ).json()) as {
      models: { id: string }[];
    };
    expect(models.models.map((m) => m.id)).toEqual(['model-a.safetensors', 'model-b.safetensors']);
    expect(
      (await app.request(`/api/connections/${imageConn.id}/capabilities?model=x`)).status,
    ).toBe(400);
    expect(db.select().from(schema.connections).all()).toHaveLength(2);

    const bad = await app.request('/api/connections', post({ provider: 'image-nope', label: 'x' }));
    expect(bad.status).toBe(400);
  });
});

describe('POST /api/chats/:id/imagine', () => {
  it('没选生图后端 → 400 no_image_backend；自由描述缺 prompt → 400', async () => {
    const { app, db, chatId } = await setup();
    const res = await app.request(`/api/chats/${chatId}/imagine`, post({ mode: 'free' }));
    expect(res.status).toBe(400);
    db.delete(schema.settings).where(eq(schema.settings.key, 'imageGen')).run();
    const none = await app.request(
      `/api/chats/${chatId}/imagine`,
      post({ mode: 'free', prompt: 'x' }),
    );
    expect(none.status).toBe(400);
    expect(((await none.json()) as { error: string }).error).toBe('no_image_backend');
  });

  it('free：事件顺序、参数映射、节点入树（head 下、名字 = 角色名）、head 移动、job done', async () => {
    const { app, db, chatId } = await setup({ stylePrefix: 'watercolor' });
    const { node: last } = await addMessage(app, chatId, 'assistant', '雨停了。');
    const events = await imagine(app, chatId, {
      mode: 'free',
      prompt: 'a cat on the windowsill',
      width: 512,
      negative: 'blurry',
    });

    expect(eventNames(events)).toEqual([
      'job',
      'job',
      'prompt',
      'progress',
      'progress',
      'progress',
      'node',
      'job',
      'done',
    ]);
    expect(events[0]?.data).toMatchObject({ status: 'pending' });
    expect(events[1]?.data).toMatchObject({ status: 'running' });
    expect(events[2]?.data).toEqual({ text: 'watercolor, a cat on the windowsill' });
    expect(events.filter((e) => e.event === 'progress').map((e) => e.data.fraction)).toEqual([
      0, 0.5, 1,
    ]);

    expect(calls[0]).toMatchObject({
      prompt: 'watercolor, a cat on the windowsill',
      negative: 'blurry',
      width: 512,
      height: 960,
      steps: 20,
      cfg: 6,
      sampler: 'Euler a',
    });

    const node = (events.find((e) => e.event === 'node')?.data as { node: Node }).node;
    expect(node.parentId).toBe(last.id);
    expect(node.role).toBe('assistant');
    expect(node.name).toBe('塞拉菲娜');
    expect(node.provider).toBe('image-sd');
    expect(node.parts).toHaveLength(1);
    expect(node.parts[0]).toMatchObject({ type: 'image', mime: 'image/png' });
    expect(node.extra).toMatchObject({
      generatedBy: 'image',
      imagePrompt: 'watercolor, a cat on the windowsill',
      backend: 'image-sd',
      seed: 101,
      mode: 'free',
      width: 512,
      height: 960,
    });
    expect(headOf(db, chatId)).toBe(node.id);

    // 资产落盘为 generated
    const assetId = (node.parts[0] as { assetId: string }).assetId;
    const asset = db.select().from(schema.assets).where(eq(schema.assets.id, assetId)).get();
    expect(asset?.kind).toBe('generated');
    expect(fs.existsSync(path.join(dataDir, asset?.path ?? ''))).toBe(true);

    // job：done，结果带 nodeId
    const jobId = (events[0]?.data as { id: string }).id;
    const job = (await (await app.request(`/api/jobs/${jobId}`)).json()) as {
      status: string;
      kind: string;
      progress: number | null;
      result: { nodeId: string; assetIds: string[]; seed: number };
    };
    expect(job).toMatchObject({ kind: 'image_gen', status: 'done', progress: null });
    expect(job.result).toMatchObject({ nodeId: node.id, assetIds: [assetId], seed: 101 });
    expect((await app.request('/api/jobs/nope')).status).toBe(404);
  });

  it('last_message：先让聊天模型写提示词（清洗后），素材里有最后一条消息', async () => {
    const { app, db, chatId } = await setup();
    await addMessage(app, chatId, 'user', '我们躲进了屋檐下。');
    await addMessage(
      app,
      chatId,
      'assistant',
      '<div>她把伞收起来</div>，窗外的雨越下越大。```js\nignored()\n```',
    );
    const events = await imagine(app, chatId, { mode: 'last_message', lang: 'en' });
    const prompt = events.find((e) => e.event === 'prompt')?.data.text;
    expect(prompt).toBe('masterpiece, 1girl, rain, window');
    expect(calls[0]?.prompt).toBe('masterpiece, 1girl, rain, window');

    // 写提示词的请求：system = 英文模板，user = 素材（最后一条消息，已去 HTML 与代码块）
    const request = writerRequests[writerRequests.length - 1];
    const system = request?.messages.find((m) => m.role === 'system')?.content ?? '';
    const material = request?.messages.find((m) => m.role === 'user')?.content ?? '';
    expect(system).toContain('last message');
    expect(system).toContain('塞拉菲娜');
    expect(material).toContain('[Last message]');
    expect(material).toContain('她把伞收起来');
    expect(material).toContain('我们躲进了屋檐下');
    expect(material).not.toContain('<div>');
    expect(material).not.toContain('ignored()');
    expect(db.select().from(schema.messageNodes).all()).toHaveLength(3);
    const node = (events.find((e) => e.event === 'done')?.data as { node: Node }).node;
    expect(node.extra).toMatchObject({ mode: 'last_message', imagePrompt: prompt });
  });

  it('character：素材是角色资料；没有角色的会话 → 400 no_character', async () => {
    const { app, chatId } = await setup();
    const events = await imagine(app, chatId, { mode: 'character' });
    expect(eventNames(events)).toContain('node');
    expect(events.find((e) => e.event === 'prompt')?.data.text).toBe(
      'masterpiece, 1girl, rain, window',
    );
    const request = writerRequests[writerRequests.length - 1];
    // 中文模板（缺省 lang），{{char}} 已替换；素材是角色资料
    expect(request?.messages.find((m) => m.role === 'system')?.content).toContain('全身立绘');
    expect(request?.messages.find((m) => m.role === 'user')?.content).toContain(
      '塞拉菲娜 has long pink hair',
    );

    const other = await setup({ withCharacter: false });
    const res = await other.app.request(
      `/api/chats/${other.chatId}/imagine`,
      post({ mode: 'character' }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('no_character');
  });

  it('last_message 但还没有消息：SSE 里给 error，job failed，不产生节点', async () => {
    const { app, db, chatId } = await setup();
    const events = await imagine(app, chatId, { mode: 'last_message' });
    expect(eventNames(events)).toEqual(['job', 'job', 'job', 'error']);
    expect(events[2]?.data).toMatchObject({ status: 'failed' });
    expect(events[3]?.data.message).toContain('没有可以描绘的消息');
    expect(loadNodes(db, chatId)).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('重画：同参数新种子，作为原生图节点的兄弟（swipe），head 移到新兄弟', async () => {
    const { app, db, chatId } = await setup();
    const { node: parent } = await addMessage(app, chatId, 'assistant', '开场。');
    const first = await imagine(app, chatId, { mode: 'free', prompt: 'a lantern', height: 704 });
    const original = (first.find((e) => e.event === 'node')?.data as { node: Node }).node;

    const second = await imagine(app, chatId, { redrawOf: original.id });
    const redrawn = (second.find((e) => e.event === 'node')?.data as { node: Node }).node;
    expect(redrawn.id).not.toBe(original.id);
    expect(redrawn.parentId).toBe(parent.id);
    expect(redrawn.siblingSeq).toBe(original.siblingSeq + 1);
    expect(redrawn.extra).toMatchObject({ imagePrompt: 'a lantern', height: 704 });
    expect(redrawn.extra?.seed).not.toBe(original.extra?.seed);
    expect(calls[1]).toMatchObject({ prompt: 'a lantern', height: 704 });
    expect(calls[1]?.seed).toBeUndefined();
    expect(headOf(db, chatId)).toBe(redrawn.id);

    // 只能重画生图节点
    const bad = await app.request(`/api/chats/${chatId}/imagine`, post({ redrawOf: parent.id }));
    expect(bad.status).toBe(400);
  });

  it('后端失败：error 带归一化的 kind 与消息，job failed，head 不动', async () => {
    const { app, db, chatId } = await setup();
    const { node } = await addMessage(app, chatId, 'assistant', '开场。');
    behavior = 'fail';
    const events = await imagine(app, chatId, { mode: 'free', prompt: 'x' });
    const error = events.find((e) => e.event === 'error')?.data;
    expect(error).toEqual({ message: 'SD WebUI：CUDA out of memory', kind: 'overloaded' });
    expect(headOf(db, chatId)).toBe(node.id);
    expect(loadNodes(db, chatId)).toHaveLength(1);
    const jobId = (events[0]?.data as { id: string }).id;
    const job = (await (await app.request(`/api/jobs/${jobId}`)).json()) as {
      status: string;
      result: { error: { kind: string } };
    };
    expect(job.status).toBe('failed');
    expect(job.result.error.kind).toBe('overloaded');
  });

  it('客户端断开：中止后端请求，job failed（abort），不产生节点', async () => {
    const { app, db, chatId } = await setup();
    behavior = 'hang';
    const res = await app.request(
      `/api/chats/${chatId}/imagine`,
      post({ mode: 'free', prompt: 'x' }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (!acc.includes('event: prompt')) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    const jobId = /"id":"([^"]+)"/.exec(acc)?.[1] ?? '';
    // 进行中：GET /api/jobs 能看到 running 与进度
    const running = (await (await app.request(`/api/jobs/${jobId}`)).json()) as {
      status: string;
      progress: number;
    };
    expect(running).toMatchObject({ status: 'running', progress: 0 });
    await reader.cancel();
    await waitFor(() => {
      const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
      return row?.status === 'failed';
    });
    const row = db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId)).get();
    expect((row?.result as { error: { kind: string } }).error.kind).toBe('abort');
    expect(loadNodes(db, chatId)).toHaveLength(0);
  });

  it('attach=false（前端卡 generateImage）：只存资产，发 asset 事件，不写消息树', async () => {
    const { app, db, chatId } = await setup();
    const { node } = await addMessage(app, chatId, 'assistant', '开场。');
    const events = await imagine(app, chatId, { mode: 'free', prompt: 'x', attach: false });
    expect(eventNames(events)).toEqual([
      'job',
      'job',
      'prompt',
      'progress',
      'progress',
      'progress',
      'asset',
      'job',
      'done',
    ]);
    const asset = events.find((e) => e.event === 'asset')?.data as { assetId: string; url: string };
    expect(asset.url).toBe(`/api/assets/${asset.assetId}/file`);
    expect(loadNodes(db, chatId)).toHaveLength(1);
    expect(headOf(db, chatId)).toBe(node.id);
    const file = await app.request(asset.url);
    expect(file.status).toBe(200);
  });
});

describe('组装跳过生图节点', () => {
  it('历史里没有生图节点，其子节点照常；检查器标「已跳过（生图）」', async () => {
    const { app, db, chatId } = await setup();
    await addMessage(app, chatId, 'assistant', '开场白。');
    const events = await imagine(app, chatId, { mode: 'free', prompt: 'x' });
    const imageNode = (events.find((e) => e.event === 'node')?.data as { node: Node }).node;
    const { node: after } = await addMessage(app, chatId, 'user', '好看！');
    expect(after.parentId).toBe(imageNode.id);

    const chat = loadChat(db, chatId);
    const input = buildAssembleInput(db, {
      chat: chat!,
      overrides: {},
      nodes: loadNodes(db, chatId),
      parentId: after.id,
      provider: 'fake-writer',
      model: 'writer-model',
      layoutMode: 'strict',
      caps: {
        thinking: 'none',
        caching: 'none',
        systemInMessages: false,
        reasoningRoundtrip: 'none',
        imageIn: true,
        imageOut: false,
        documentIn: false,
        tools: false,
        structuredOutput: false,
        prefill: false,
        maxContext: 32768,
        maxOutput: 4096,
      },
    });
    const ids = input.history.map((node) => node.id);
    expect(ids).not.toContain(imageNode.id);
    expect(ids).toContain(after.id);
    expect(input.history).toHaveLength(2);
    expect(input.messageCount).toBe(2);

    const inspect = (await (await app.request(`/api/chats/${chatId}/inspect`)).json()) as {
      warnings: string[];
    };
    expect(inspect.warnings.some((w) => w.includes('已跳过（生图）'))).toBe(true);
  });
});
