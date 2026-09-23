import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import {
  assembleForDocument,
  isSummaryPending,
  parseAiRequest,
  resolveWritingTarget,
  startChapterSummary,
  type WritingAiEvents,
  type WritingInspectResponse,
} from '../services/writing-ai.js';
import { streamLlm } from '../services/llm.js';
import {
  createDocument,
  createProject,
  exportProject,
  getVersion,
  isStringArray,
  listProjects,
  listVersions,
  loadDocument,
  loadProject,
  normalizeProjectSettings,
  recordDocumentVersion,
  reorderDocuments,
  restoreVersion,
  toDocumentDetail,
  toProjectDetail,
  updateDocument,
  updateProject,
  validateSettingsPatch,
  WritingError,
  type CreateWritingProjectRequest,
  type UpdateWritingDocumentRequest,
  type UpdateWritingProjectRequest,
} from '../services/writing.js';

/**
 * 长篇写作接口（M7 契约 §3），挂在 `/api/writing`。
 *
 * - 项目：`GET/POST /projects`、`GET/PUT/DELETE /projects/:id`
 * - 文档：`POST /projects/:id/documents`、`PUT /projects/:id/order`、`GET/PUT/DELETE /documents/:docId`
 * - 版本：`GET/POST /documents/:docId/versions`、`GET …/versions/:version`、`POST …/versions/:version/restore`
 * - AI：`POST /documents/:docId/ai`（SSE）、`POST /projects/:id/inspect`
 * - 导出：`GET /projects/:id/export?format=md|txt`
 */

// 前端（WW）复用的请求 / 响应类型
export type {
  CreateWritingDocumentRequest,
  CreateWritingProjectRequest,
  CreateWritingVersionRequest,
  CreateWritingVersionResponse,
  ReorderWritingDocumentsRequest,
  RestoreWritingVersionResponse,
  UpdateWritingDocumentRequest,
  UpdateWritingProjectRequest,
  WritingDocumentDetail,
  WritingDocumentKind,
  WritingDocumentSummary,
  WritingLanguage,
  WritingLayoutMode,
  WritingProjectDetail,
  WritingProjectSettings,
  WritingProjectSummary,
  WritingVersionDetail,
  WritingVersionSummary,
} from '../services/writing.js';
export type {
  WritingAiEvents,
  WritingAiRequest,
  WritingInspectRequest,
  WritingInspectResponse,
} from '../services/writing-ai.js';
export type {
  WritingAction,
  WritingContextReport,
  WritingReportBibleEntry,
  WritingReportReference,
  WritingReportSegment,
  WritingReportSummary,
} from '@newtavern/core';

const SSE_PADDING = 2048;
const PING_INTERVAL_MS = 15_000;

async function readJsonObject(c: Context): Promise<Record<string, unknown> | undefined> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

const invalid = (c: Context, message: string) => c.json({ error: 'invalid', message }, 400);
const notFound = (c: Context) => c.json({ error: 'not_found' }, 404);

function isOptional<T>(value: unknown, check: (v: unknown) => v is T): boolean {
  return value === undefined || check(value);
}
const isString = (v: unknown): v is string => typeof v === 'string';
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** 项目 POST / PUT 共用的字段校验 */
function validateProjectBody(body: Record<string, unknown>): string | null {
  if (!isOptional(body.title, isString)) return 'title 必须是字符串';
  if (!isOptional(body.outline, isString)) return 'outline 必须是字符串';
  if (body.lorebookIds !== undefined && !isStringArray(body.lorebookIds)) {
    return 'lorebookIds 必须是字符串数组';
  }
  if (body.settings !== undefined) {
    if (!isObject(body.settings)) return 'settings 必须是对象';
    return validateSettingsPatch(body.settings);
  }
  return null;
}

function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function createWritingRoutes(db: Db, dataDir: string) {
  const pending = isSummaryPending;

  /** WritingError → JSON；其它异常继续抛 */
  const guard = async (c: Context, fn: () => Promise<Response> | Response): Promise<Response> => {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WritingError) {
        return c.json({ error: e.code, message: e.message }, e.status);
      }
      throw e;
    }
  };

  return (
    new Hono()
      // ── 项目
      .get('/projects', (c) => c.json(listProjects(db)))
      .post('/projects', async (c) => {
        const body = (await readJsonObject(c)) ?? {};
        const error = validateProjectBody(body);
        if (error) return invalid(c, error);
        const row = createProject(db, body as CreateWritingProjectRequest);
        return c.json(toProjectDetail(db, row, pending), 201);
      })
      .get('/projects/:id', (c) => {
        const row = loadProject(db, c.req.param('id'));
        if (!row) return notFound(c);
        return c.json(toProjectDetail(db, row, pending));
      })
      .put('/projects/:id', async (c) => {
        const row = loadProject(db, c.req.param('id'));
        if (!row) return notFound(c);
        const body = await readJsonObject(c);
        if (!body) return invalid(c, '请求体必须是对象');
        const error = validateProjectBody(body);
        if (error) return invalid(c, error);
        const next = updateProject(db, row, body as UpdateWritingProjectRequest);
        return c.json(toProjectDetail(db, next, pending));
      })
      .delete('/projects/:id', (c) => {
        const row = loadProject(db, c.req.param('id'));
        if (!row) return notFound(c);
        db.delete(schema.writingProjects).where(eq(schema.writingProjects.id, row.id)).run();
        return c.json({ ok: true });
      })

      // ── 文档
      .post('/projects/:id/documents', (c) =>
        guard(c, async () => {
          const project = loadProject(db, c.req.param('id'));
          if (!project) return notFound(c);
          const body = (await readJsonObject(c)) ?? {};
          if (body.kind !== undefined && body.kind !== 'chapter' && body.kind !== 'note') {
            return invalid(c, "kind 必须是 'chapter' 或 'note'");
          }
          if (!isOptional(body.title, isString)) return invalid(c, 'title 必须是字符串');
          if (body.afterId !== undefined && body.afterId !== null && !isString(body.afterId)) {
            return invalid(c, 'afterId 必须是字符串');
          }
          const row = createDocument(db, project.id, {
            ...(body.kind === 'note' ? { kind: 'note' } : { kind: 'chapter' }),
            ...(isString(body.title) ? { title: body.title } : {}),
            ...(isString(body.afterId) ? { afterId: body.afterId } : {}),
          });
          return c.json(toDocumentDetail(row, pending), 201);
        }),
      )
      .put('/projects/:id/order', (c) =>
        guard(c, async () => {
          const project = loadProject(db, c.req.param('id'));
          if (!project) return notFound(c);
          const body = await readJsonObject(c);
          if (!body || !isStringArray(body.ids)) return invalid(c, 'ids 必须是字符串数组');
          reorderDocuments(db, project.id, body.ids);
          return c.json(toProjectDetail(db, loadProject(db, project.id) ?? project, pending));
        }),
      )
      .get('/documents/:docId', (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        return c.json(toDocumentDetail(row, pending));
      })
      .put('/documents/:docId', async (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        const body = await readJsonObject(c);
        if (!body) return invalid(c, '请求体必须是对象');
        if (!isOptional(body.title, isString)) return invalid(c, 'title 必须是字符串');
        if (!isOptional(body.text, isString)) return invalid(c, 'text 必须是字符串');
        if (!isOptional(body.summary, isString)) return invalid(c, 'summary 必须是字符串');
        if (!isOptional(body.done, isBoolean)) return invalid(c, 'done 必须是布尔值');
        if (body.content !== undefined && body.content !== null && !isObject(body.content)) {
          return invalid(c, 'content 必须是 TipTap JSON 对象');
        }
        const { row: next, becameDone } = updateDocument(
          db,
          row,
          body as UpdateWritingDocumentRequest,
        );
        // 章节刚标记完成：后台起一次摘要（不阻塞响应；已有未过期的摘要就不重复生成）
        if (
          becameDone &&
          next.kind === 'chapter' &&
          body.summary === undefined &&
          (next.summary === '' || next.summaryStale)
        ) {
          void startChapterSummary(db, dataDir, next.id);
        }
        return c.json(toDocumentDetail(next, pending));
      })
      .delete('/documents/:docId', (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        db.delete(schema.documents).where(eq(schema.documents.id, row.id)).run();
        db.update(schema.writingProjects)
          .set({ updatedAt: new Date() })
          .where(eq(schema.writingProjects.id, row.projectId))
          .run();
        return c.json({ ok: true });
      })

      // ── 版本
      .get('/documents/:docId/versions', (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        return c.json(listVersions(db, row.id));
      })
      .post('/documents/:docId/versions', async (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        const body = (await readJsonObject(c)) ?? {};
        if (!isOptional(body.label, isString)) return invalid(c, 'label 必须是字符串');
        if (body.author !== undefined && body.author !== 'user' && body.author !== 'ai') {
          return invalid(c, "author 必须是 'user' 或 'ai'");
        }
        const version = recordDocumentVersion(
          db,
          row,
          body.author === 'ai' ? 'ai' : 'user',
          isString(body.label) && body.label !== '' ? body.label : null,
        );
        return c.json({ version }, version === null ? 200 : 201);
      })
      .get('/documents/:docId/versions/:version', (c) => {
        const version = Number(c.req.param('version'));
        if (!Number.isInteger(version)) return invalid(c, 'version 必须是整数');
        const detail = getVersion(db, c.req.param('docId'), version);
        if (!detail) return notFound(c);
        return c.json(detail);
      })
      .post('/documents/:docId/versions/:version/restore', (c) => {
        const row = loadDocument(db, c.req.param('docId'));
        if (!row) return notFound(c);
        const version = Number(c.req.param('version'));
        if (!Number.isInteger(version)) return invalid(c, 'version 必须是整数');
        const restored = restoreVersion(db, row, version);
        if (!restored) return notFound(c);
        return c.json({
          document: toDocumentDetail(restored.row, pending),
          savedVersion: restored.savedVersion,
        });
      })

      // ── 检查器：组装但不调用模型
      .post('/projects/:id/inspect', (c) =>
        guard(c, async () => {
          const project = loadProject(db, c.req.param('id'));
          if (!project) return notFound(c);
          const body = await readJsonObject(c);
          if (!body || !isString(body.docId)) return invalid(c, 'docId 必须是字符串');
          const req = parseAiRequest(body);
          if (typeof req === 'string') return invalid(c, req);
          const doc = loadDocument(db, body.docId);
          if (!doc || doc.projectId !== project.id) return notFound(c);
          const settings = normalizeProjectSettings(project.settings);
          // 连接解析失败不报错：检查器在没连模型时也要能看上下文
          let target = null;
          try {
            target = await resolveWritingTarget(db, dataDir, settings, req);
          } catch (e) {
            if (!(e instanceof WritingError)) throw e;
          }
          const { result, budget } = assembleForDocument(db, { project, doc, req, target });
          const response: WritingInspectResponse = {
            connected: target !== null,
            connectionId: target?.connectionId ?? null,
            model: target?.model ?? null,
            layoutMode: settings.layoutMode,
            budget,
            segments: result.ir.segments,
            cachePlan: result.ir.cachePlan,
            report: result.report,
          };
          return c.json(response);
        }),
      )

      // ── AI 动作（SSE）
      .post('/documents/:docId/ai', (c) =>
        guard(c, async () => {
          const doc = loadDocument(db, c.req.param('docId'));
          if (!doc) return notFound(c);
          const project = loadProject(db, doc.projectId);
          if (!project) return notFound(c);
          const req = parseAiRequest(await readJsonObject(c));
          if (typeof req === 'string') return invalid(c, req);
          const settings = normalizeProjectSettings(project.settings);
          const target = await resolveWritingTarget(db, dataDir, settings, req);
          if (!target) {
            return c.json({ error: 'no_connection', message: '未指定连接或模型' }, 400);
          }

          // 动作前先存一版（与上一版相同则不写）
          const beforeVersion = recordDocumentVersion(db, doc, 'user', `before:${req.action}`);
          const { result } = assembleForDocument(db, { project, doc, req, target });

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

            const send = <K extends keyof WritingAiEvents>(event: K, data: WritingAiEvents[K]) =>
              stream.writeSSE({ event, data: JSON.stringify(data) });

            await stream.write(`:${'-'.repeat(SSE_PADDING)}\n\n`);
            const ping = setInterval(() => void stream.write(': ping\n\n'), PING_INTERVAL_MS);

            let text = '';
            let usage: WritingAiEvents['usage'] | null = null;
            let stopReason = 'end';
            let errorMessage: { message: string; kind?: string } | null = null;
            try {
              await send('context', {
                report: result.report,
                model: target.model,
                connectionId: target.connectionId,
              });
              for await (const ev of streamLlm(db, dataDir, {
                connectionId: target.connectionId,
                model: target.model,
                ir: result.ir,
                signal: ac.signal,
                ...(settings.thinking ? { thinking: settings.thinking } : {}),
              })) {
                switch (ev.type) {
                  case 'text.delta':
                    text += ev.text;
                    await send('text', { delta: ev.text });
                    break;
                  case 'reasoning.delta':
                    await send('reasoning', { delta: ev.text });
                    break;
                  case 'usage':
                    usage = {
                      input: ev.input,
                      output: ev.output,
                      cacheRead: ev.cacheRead,
                      cacheWrite: ev.cacheWrite,
                      reasoning: ev.reasoning,
                    };
                    await send('usage', usage);
                    break;
                  case 'stop':
                    stopReason = ev.reason;
                    break;
                  case 'error':
                    errorMessage = { message: ev.error.message, kind: ev.error.kind };
                    break;
                  default:
                    break;
                }
              }
              if (aborted) stopReason = 'abort';

              let summary: string | undefined;
              if (req.action === 'summarize' && !errorMessage && !aborted && text.trim() !== '') {
                summary = text.trim();
                db.update(schema.documents)
                  .set({ summary, summaryStale: false, updatedAt: new Date() })
                  .where(eq(schema.documents.id, doc.id))
                  .run();
              }
              if (errorMessage) {
                await send('error', errorMessage);
              } else if (!aborted) {
                await send('done', {
                  text,
                  stopReason,
                  usage,
                  ...(summary === undefined ? {} : { summary }),
                  beforeVersion,
                });
              }
            } catch (e) {
              await send('error', { message: (e as Error).message });
            } finally {
              clearInterval(ping);
              c.req.raw.signal.removeEventListener('abort', onClientGone);
            }
          });
        }),
      )

      // ── 导出
      .get('/projects/:id/export', (c) => {
        const project = loadProject(db, c.req.param('id'));
        if (!project) return notFound(c);
        const format = c.req.query('format') ?? 'md';
        if (format !== 'md' && format !== 'txt') return invalid(c, "format 必须是 'md' 或 'txt'");
        const body = exportProject(db, project, format);
        const name = `${project.title.trim() || 'untitled'}.${format}`;
        return c.body(body, 200, {
          'content-type': `${format === 'md' ? 'text/markdown' : 'text/plain'}; charset=utf-8`,
          'content-disposition': contentDisposition(name),
        });
      })
  );
}
