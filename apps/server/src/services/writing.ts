import { countWords } from '@newtavern/core';
import { and, asc, desc, eq, gt, lte, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { ThinkingOptions } from './provider-request.js';

/**
 * 长篇写作的数据层（M7 契约 §1 / §3）：项目、文档、排序、版本、导出。
 * AI 相关（组装、流式、后台摘要）在 `writing-ai.ts`。
 *
 * 接口的请求 / 响应类型都在这里定义，由 `routes/writing.ts` 再导出给前端参照。
 */

export type WritingProjectRow = typeof schema.writingProjects.$inferSelect;
export type WritingDocumentRow = typeof schema.documents.$inferSelect;
export type WritingVersionRow = typeof schema.documentVersions.$inferSelect;

export type WritingLanguage = 'zh-CN' | 'en';
export type WritingLayoutMode = 'cache-aware' | 'strict';
export type WritingDocumentKind = 'chapter' | 'note';

/** 项目设置（`writing_projects.settings`）；未知字段原样保留 */
export interface WritingProjectSettings {
  connectionId?: string;
  model?: string;
  /** 缺省 cache-aware */
  layoutMode: WritingLayoutMode;
  styleGuide: string;
  /** 覆盖内置写作系统提示词 */
  systemPrompt?: string;
  /** token；缺省按模型 maxContext 的 60% */
  contextBudget?: number;
  /** 缺省 zh-CN */
  language?: WritingLanguage;
  thinking?: ThinkingOptions;
  [key: string]: unknown;
}

// ── 响应类型 ───────────────────────────────────────────

export interface WritingProjectSummary {
  id: string;
  title: string;
  chapterCount: number;
  noteCount: number;
  /** 章节字数合计（笔记不计） */
  wordCount: number;
  createdAt: string;
  /** 项目或其任一文档最近一次修改 */
  updatedAt: string;
}

export interface WritingDocumentSummary {
  id: string;
  projectId: string;
  kind: WritingDocumentKind;
  title: string;
  order: number;
  done: boolean;
  summary: string;
  summaryStale: boolean;
  /** 后台摘要正在生成（章节标记完成后触发） */
  summaryPending: boolean;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface WritingDocumentDetail extends WritingDocumentSummary {
  /** TipTap JSON */
  content: Record<string, unknown> | null;
  text: string;
}

export interface WritingProjectDetail {
  id: string;
  title: string;
  settings: WritingProjectSettings;
  lorebookIds: string[];
  outline: string;
  chapterCount: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  /** 按 kind（章节在前）再按 order 排；不含正文 */
  documents: WritingDocumentSummary[];
}

export interface WritingVersionSummary {
  version: number;
  author: 'user' | 'ai';
  label: string | null;
  createdAt: string;
  wordCount: number;
  /** text 的字符数 */
  size: number;
}

export interface WritingVersionDetail extends WritingVersionSummary {
  content: Record<string, unknown> | null;
  text: string;
}

// ── 请求类型 ───────────────────────────────────────────

export interface CreateWritingProjectRequest {
  title?: string;
  settings?: Partial<WritingProjectSettings>;
  lorebookIds?: string[];
  outline?: string;
}

/**
 * `settings` 是**浅合并**：给出的字段覆盖，值为 null 的字段删除，没给的字段不动。
 */
export interface UpdateWritingProjectRequest {
  title?: string;
  settings?: Record<string, unknown>;
  lorebookIds?: string[];
  outline?: string;
}

export interface CreateWritingDocumentRequest {
  kind?: WritingDocumentKind;
  title?: string;
  /** 插到该文档之后（同 kind）；缺省追加到末尾 */
  afterId?: string | null;
}

export interface UpdateWritingDocumentRequest {
  title?: string;
  content?: Record<string, unknown> | null;
  text?: string;
  done?: boolean;
  summary?: string;
}

/** 把给出的 id 依次排成 order 0,1,2…（只动这些文档；都必须属于该项目） */
export interface ReorderWritingDocumentsRequest {
  ids: string[];
}

export interface CreateWritingVersionRequest {
  label?: string;
  /** 缺省 user；前端「保留 AI 结果」后存版用 ai */
  author?: 'user' | 'ai';
}

export interface CreateWritingVersionResponse {
  /** 新版本号；与上一版 text 相同未写入时为 null */
  version: number | null;
}

export interface RestoreWritingVersionResponse {
  document: WritingDocumentDetail;
  /** 恢复前为当前稿存的那一版（与上一版相同则为 null） */
  savedVersion: number | null;
}

// ── 常量与小工具 ───────────────────────────────────────

/** 每个文档保留最近 100 版 */
export const WRITING_VERSION_LIMIT = 100;

const iso = (date: Date) => date.toISOString();

export class WritingError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 读库里的 settings 并补缺省值 */
export function normalizeProjectSettings(raw: unknown): WritingProjectSettings {
  const s = isRecord(raw) ? raw : {};
  return {
    ...s,
    layoutMode: s.layoutMode === 'strict' ? 'strict' : 'cache-aware',
    styleGuide: typeof s.styleGuide === 'string' ? s.styleGuide : '',
  };
}

export function projectLanguage(settings: WritingProjectSettings): WritingLanguage {
  return settings.language === 'en' ? 'en' : 'zh-CN';
}

/** settings 补丁的字段校验；返回错误信息或 null */
export function validateSettingsPatch(patch: Record<string, unknown>): string | null {
  const optionalString = ['connectionId', 'model', 'systemPrompt'];
  for (const key of optionalString) {
    const v = patch[key];
    if (v !== undefined && v !== null && typeof v !== 'string')
      return `settings.${key} 必须是字符串`;
  }
  const v = patch;
  if (
    v.layoutMode !== undefined &&
    v.layoutMode !== null &&
    v.layoutMode !== 'strict' &&
    v.layoutMode !== 'cache-aware'
  ) {
    return 'settings.layoutMode 非法';
  }
  if (v.styleGuide !== undefined && v.styleGuide !== null && typeof v.styleGuide !== 'string') {
    return 'settings.styleGuide 必须是字符串';
  }
  if (
    v.contextBudget !== undefined &&
    v.contextBudget !== null &&
    !(
      typeof v.contextBudget === 'number' &&
      Number.isFinite(v.contextBudget) &&
      v.contextBudget > 0
    )
  ) {
    return 'settings.contextBudget 必须是正数';
  }
  if (
    v.language !== undefined &&
    v.language !== null &&
    v.language !== 'zh-CN' &&
    v.language !== 'en'
  ) {
    return 'settings.language 非法';
  }
  if (v.thinking !== undefined && v.thinking !== null && !isRecord(v.thinking)) {
    return 'settings.thinking 必须是对象';
  }
  return null;
}

/** 浅合并；null 删除字段 */
export function mergeSettings(
  current: WritingProjectSettings,
  patch: Record<string, unknown>,
): WritingProjectSettings {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  return normalizeProjectSettings(next);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

// ── 查询 ───────────────────────────────────────────────

export function loadProject(db: Db, id: string): WritingProjectRow | undefined {
  return db.select().from(schema.writingProjects).where(eq(schema.writingProjects.id, id)).get();
}

export function loadDocument(db: Db, id: string): WritingDocumentRow | undefined {
  return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get();
}

/** 项目的全部文档：章节在前、笔记在后，各自按 order */
export function loadProjectDocuments(db: Db, projectId: string): WritingDocumentRow[] {
  return db
    .select()
    .from(schema.documents)
    .where(eq(schema.documents.projectId, projectId))
    .orderBy(
      sql`case when ${schema.documents.kind} = 'chapter' then 0 else 1 end`,
      asc(schema.documents.docOrder),
      asc(schema.documents.createdAt),
    )
    .all();
}

/** 刷新项目的 updatedAt（文档改动也算项目更新，列表按它排序） */
export function touchProject(db: Db, projectId: string): void {
  db.update(schema.writingProjects)
    .set({ updatedAt: new Date() })
    .where(eq(schema.writingProjects.id, projectId))
    .run();
}

// ── 形状转换 ───────────────────────────────────────────

export function toDocumentSummary(
  row: WritingDocumentRow,
  pending: (docId: string) => boolean = () => false,
): WritingDocumentSummary {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    title: row.title,
    order: row.docOrder,
    done: row.done,
    summary: row.summary,
    summaryStale: row.summaryStale,
    summaryPending: pending(row.id),
    wordCount: row.wordCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toDocumentDetail(
  row: WritingDocumentRow,
  pending?: (docId: string) => boolean,
): WritingDocumentDetail {
  return { ...toDocumentSummary(row, pending), content: row.content ?? null, text: row.text };
}

function chapterStats(docs: readonly WritingDocumentRow[]) {
  const chapters = docs.filter((doc) => doc.kind === 'chapter');
  return {
    chapterCount: chapters.length,
    noteCount: docs.length - chapters.length,
    wordCount: chapters.reduce((sum, doc) => sum + doc.wordCount, 0),
  };
}

export function toProjectDetail(
  db: Db,
  row: WritingProjectRow,
  pending?: (docId: string) => boolean,
): WritingProjectDetail {
  const docs = loadProjectDocuments(db, row.id);
  const stats = chapterStats(docs);
  return {
    id: row.id,
    title: row.title,
    settings: normalizeProjectSettings(row.settings),
    lorebookIds: row.lorebookIds,
    outline: row.outline,
    chapterCount: stats.chapterCount,
    wordCount: stats.wordCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    documents: docs.map((doc) => toDocumentSummary(doc, pending)),
  };
}

export function listProjects(db: Db): WritingProjectSummary[] {
  const projects = db
    .select()
    .from(schema.writingProjects)
    .orderBy(desc(schema.writingProjects.updatedAt))
    .all();
  const docs = db
    .select({
      projectId: schema.documents.projectId,
      kind: schema.documents.kind,
      wordCount: schema.documents.wordCount,
      updatedAt: schema.documents.updatedAt,
    })
    .from(schema.documents)
    .all();
  const byProject = new Map<string, typeof docs>();
  for (const doc of docs) {
    const bucket = byProject.get(doc.projectId);
    if (bucket) bucket.push(doc);
    else byProject.set(doc.projectId, [doc]);
  }
  return projects
    .map((project) => {
      const own = byProject.get(project.id) ?? [];
      const chapters = own.filter((doc) => doc.kind === 'chapter');
      const latest = own.reduce(
        (max, doc) => (doc.updatedAt > max ? doc.updatedAt : max),
        project.updatedAt,
      );
      return {
        id: project.id,
        title: project.title,
        chapterCount: chapters.length,
        noteCount: own.length - chapters.length,
        wordCount: chapters.reduce((sum, doc) => sum + doc.wordCount, 0),
        createdAt: iso(project.createdAt),
        updatedAt: iso(latest),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ── 项目 ───────────────────────────────────────────────

export function createProject(db: Db, body: CreateWritingProjectRequest): WritingProjectRow {
  return db
    .insert(schema.writingProjects)
    .values({
      title: body.title ?? '',
      settings: mergeSettings(normalizeProjectSettings({}), body.settings ?? {}),
      lorebookIds: body.lorebookIds ?? [],
      outline: body.outline ?? '',
    })
    .returning()
    .get();
}

export function updateProject(
  db: Db,
  row: WritingProjectRow,
  body: UpdateWritingProjectRequest,
): WritingProjectRow {
  const patch: Partial<typeof schema.writingProjects.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.outline !== undefined) patch.outline = body.outline;
  if (body.lorebookIds !== undefined) patch.lorebookIds = [...new Set(body.lorebookIds)];
  if (body.settings !== undefined) {
    patch.settings = mergeSettings(normalizeProjectSettings(row.settings), body.settings);
  }
  return db
    .update(schema.writingProjects)
    .set(patch)
    .where(eq(schema.writingProjects.id, row.id))
    .returning()
    .get() as WritingProjectRow;
}

// ── 文档 ───────────────────────────────────────────────

export function createDocument(
  db: Db,
  projectId: string,
  body: CreateWritingDocumentRequest,
): WritingDocumentRow {
  const kind: WritingDocumentKind = body.kind === 'note' ? 'note' : 'chapter';
  const siblings = loadProjectDocuments(db, projectId).filter((doc) => doc.kind === kind);
  let order = siblings.reduce((max, doc) => Math.max(max, doc.docOrder), -1) + 1;
  if (body.afterId) {
    const after = siblings.find((doc) => doc.id === body.afterId);
    if (!after)
      throw new WritingError(400, 'invalid', `afterId 不是本项目同类文档：${body.afterId}`);
    order = after.docOrder + 1;
    // 后面的同类文档整体后移一位
    db.update(schema.documents)
      .set({ docOrder: sql`${schema.documents.docOrder} + 1` })
      .where(
        and(
          eq(schema.documents.projectId, projectId),
          eq(schema.documents.kind, kind),
          gt(schema.documents.docOrder, after.docOrder),
        ),
      )
      .run();
  }
  const row = db
    .insert(schema.documents)
    .values({ projectId, kind, title: body.title ?? '', docOrder: order })
    .returning()
    .get();
  touchProject(db, projectId);
  return row;
}

export interface DocumentUpdateResult {
  row: WritingDocumentRow;
  /** done 由 false 变 true（路由据此起后台摘要） */
  becameDone: boolean;
}

export function updateDocument(
  db: Db,
  row: WritingDocumentRow,
  body: UpdateWritingDocumentRequest,
): DocumentUpdateResult {
  const patch: Partial<typeof schema.documents.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) patch.title = body.title;
  if (body.content !== undefined) patch.content = body.content;
  if (body.text !== undefined) {
    patch.text = body.text;
    patch.wordCount = countWords(body.text);
    // 摘要生成之后正文又改了：摘要过期
    if (body.text !== row.text && row.summary !== '') patch.summaryStale = true;
  }
  if (body.summary !== undefined) {
    patch.summary = body.summary;
    patch.summaryStale = false;
  }
  if (body.done !== undefined) patch.done = body.done;
  const next = db
    .update(schema.documents)
    .set(patch)
    .where(eq(schema.documents.id, row.id))
    .returning()
    .get() as WritingDocumentRow;
  touchProject(db, row.projectId);
  return { row: next, becameDone: body.done === true && !row.done };
}

export function reorderDocuments(db: Db, projectId: string, ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new WritingError(400, 'invalid', 'ids 有重复');
  const own = new Set(loadProjectDocuments(db, projectId).map((doc) => doc.id));
  const foreign = ids.filter((id) => !own.has(id));
  if (foreign.length > 0) {
    throw new WritingError(400, 'invalid', `不属于该项目的文档：${foreign.join(', ')}`);
  }
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(schema.documents).set({ docOrder: index }).where(eq(schema.documents.id, id)).run();
    });
  });
  touchProject(db, projectId);
}

// ── 版本 ───────────────────────────────────────────────

function latestVersion(db: Db, documentId: string): WritingVersionRow | undefined {
  return db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.documentId, documentId))
    .orderBy(desc(schema.documentVersions.version))
    .limit(1)
    .get();
}

/**
 * 写一版：与上一版 text 相同则不写（返回 null）；写入后只留最近 `WRITING_VERSION_LIMIT` 版。
 */
export function recordDocumentVersion(
  db: Db,
  doc: Pick<WritingDocumentRow, 'id' | 'content' | 'text'>,
  author: 'user' | 'ai',
  label: string | null = null,
): number | null {
  const last = latestVersion(db, doc.id);
  if (last && last.text === doc.text) return null;
  const version = (last?.version ?? 0) + 1;
  db.insert(schema.documentVersions)
    .values({
      documentId: doc.id,
      version,
      content: doc.content ?? null,
      text: doc.text,
      author,
      label,
    })
    .run();
  db.delete(schema.documentVersions)
    .where(
      and(
        eq(schema.documentVersions.documentId, doc.id),
        lte(schema.documentVersions.version, version - WRITING_VERSION_LIMIT),
      ),
    )
    .run();
  return version;
}

function toVersionSummary(row: WritingVersionRow): WritingVersionSummary {
  return {
    version: row.version,
    author: row.author,
    label: row.label ?? null,
    createdAt: iso(row.createdAt),
    wordCount: countWords(row.text),
    size: row.text.length,
  };
}

/** 新的在前 */
export function listVersions(db: Db, documentId: string): WritingVersionSummary[] {
  return db
    .select()
    .from(schema.documentVersions)
    .where(eq(schema.documentVersions.documentId, documentId))
    .orderBy(desc(schema.documentVersions.version))
    .all()
    .map(toVersionSummary);
}

export function getVersion(
  db: Db,
  documentId: string,
  version: number,
): WritingVersionDetail | null {
  const row = db
    .select()
    .from(schema.documentVersions)
    .where(
      and(
        eq(schema.documentVersions.documentId, documentId),
        eq(schema.documentVersions.version, version),
      ),
    )
    .get();
  if (!row) return null;
  return { ...toVersionSummary(row), content: row.content ?? null, text: row.text };
}

/** 恢复：先把当前稿存一版，再用该版覆盖正文 */
export function restoreVersion(
  db: Db,
  doc: WritingDocumentRow,
  version: number,
): { row: WritingDocumentRow; savedVersion: number | null } | null {
  const target = getVersion(db, doc.id, version);
  if (!target) return null;
  const savedVersion = recordDocumentVersion(db, doc, 'user', 'before:restore');
  const { row } = updateDocument(db, doc, { content: target.content, text: target.text });
  return { row, savedVersion };
}

// ── 导出 ───────────────────────────────────────────────

export function chapterDisplayTitle(title: string, n: number, lang: WritingLanguage): string {
  if (title.trim() !== '') return title.trim();
  return lang === 'en' ? `Chapter ${n}` : `第${n}章`;
}

/** 按章节顺序导出；章节标题作二级标题（md）；笔记不导出 */
export function exportProject(db: Db, project: WritingProjectRow, format: 'md' | 'txt'): string {
  const lang = projectLanguage(normalizeProjectSettings(project.settings));
  const chapters = loadProjectDocuments(db, project.id).filter((doc) => doc.kind === 'chapter');
  const title = project.title.trim();
  const blocks = chapters.map((chapter, index) => {
    const heading = chapterDisplayTitle(chapter.title, index + 1, lang);
    const body = chapter.text.replace(/\s+$/, '');
    return format === 'md' ? `## ${heading}\n\n${body}` : `${heading}\n\n${body}`;
  });
  if (format === 'md') {
    return `${[...(title ? [`# ${title}`] : []), ...blocks].join('\n\n')}\n`;
  }
  return `${[...(title ? [title] : []), ...blocks].join('\n\n\n')}\n`;
}
