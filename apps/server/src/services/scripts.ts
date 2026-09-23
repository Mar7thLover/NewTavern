import { randomUUID } from 'node:crypto';

import { and, asc, desc, eq, isNull } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 酒馆助手脚本库（全局脚本 + 预设自带脚本）。见 docs/M5-CONTRACT.md 第二部分 §2。
 *
 * 形状照 JS-Slash-Runner 4.9.3 `src/type/scripts.ts`（新格式）与 `src/type/backward.ts`（旧格式）：
 *
 * ```ts
 * Script       = { type:'script', enabled, name, id, content, info, button:{ enabled, buttons:{name,visible}[] },
 *                  data: Record<string,any>, export_with:{ data, button } }
 * ScriptFolder = { type:'folder', enabled, name, id, icon, color, scripts: Script[] }
 * // 旧格式（酒馆助手 3.x）
 * ScriptData   = { enabled, name, id, content, info, buttons:{name,visible}[], data }
 * ScriptItem   = { type:'script', value: ScriptData }
 * ScriptFolder = { type:'folder', id, name, icon, color, value: ScriptData[] }
 * ```
 *
 * 存法：列里是常用字段（name / content / enabled / buttons），`data` 列是**规范化成新格式的原件**
 * （未知字段原样保留），外加两个新酒馆自己的簿记键：
 * - `folder`：导入时脚本所在的文件夹名（新酒馆的库是平的，文件夹展平）；
 * - `sourceEnabled`：抽自预设时原件里的开关（「一键启用」按它恢复，同自带正则）。
 * 导出时以 `data` 为底叠加列值，并去掉这两个簿记键。
 *
 * 角色卡的脚本仍然留在卡的 `extensions` 里（往返无损），不进这张表。
 */

export type ScriptScope = 'global' | 'preset';

export const SCRIPT_SCOPES: readonly ScriptScope[] = ['global', 'preset'];

export interface ScriptButton {
  name: string;
  visible: boolean;
}

/** 对外的一行脚本（`GET /api/scripts`） */
export interface ScriptRow {
  id: string;
  scope: ScriptScope;
  ownerId: string | null;
  name: string;
  content: string;
  enabled: boolean;
  buttons: ScriptButton[];
  /** 酒馆助手 `button.enabled`：false 时脚本按钮整体不显示 */
  buttonsEnabled: boolean;
  /** 作者说明（`data.info`） */
  info: string;
  /** 导入时的文件夹名（`data.folder`） */
  folder: string | null;
  /** 规范化后的原件（新格式 Script + 簿记键） */
  data: Record<string, unknown>;
  displayOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

type DbRow = typeof schema.scripts.$inferSelect;

/** 新酒馆自己的簿记键：导出时去掉 */
const BOOKKEEPING_KEYS = ['folder', 'sourceEnabled'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isScriptScope(value: unknown): value is ScriptScope {
  return typeof value === 'string' && (SCRIPT_SCOPES as readonly string[]).includes(value);
}

/** 按钮列表：认 `{name, visible}`，名字转字符串，visible 缺省 true */
export function normalizeButtons(value: unknown): ScriptButton[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((item) => ({
    name: item.name === undefined || item.name === null ? '' : String(item.name),
    visible: item.visible !== false,
  }));
}

export function toScriptRow(row: DbRow): ScriptRow {
  const data = isRecord(row.data) ? row.data : {};
  const button = isRecord(data.button) ? data.button : {};
  return {
    id: row.id,
    scope: row.scope,
    ownerId: row.ownerId,
    name: row.name,
    content: row.content,
    enabled: row.enabled,
    buttons: normalizeButtons(row.buttons),
    buttonsEnabled: button.enabled !== false,
    info: typeof data.info === 'string' ? data.info : '',
    folder: typeof data.folder === 'string' && data.folder !== '' ? data.folder : null,
    data,
    displayOrder: row.displayOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 原件解析：新格式 / 旧格式 / 数组 / 树                                  */
/* ------------------------------------------------------------------ */

/** 规范化后的一个脚本：新格式原件 + 文件夹名 */
export interface ParsedScript {
  /** 新格式 Script（未知字段保留） */
  script: Record<string, unknown>;
  /** 展平前所在的文件夹 */
  folder: string | null;
  /** 原件里的开关（文件夹关着时算关） */
  enabled: boolean;
}

/** 单个脚本（新格式 Script 或旧格式 ScriptData）→ 新格式 */
function normalizeScript(raw: Record<string, unknown>): Record<string, unknown> {
  const { buttons: legacyButtons, type: _type, value: _value, ...rest } = raw;
  const button = isRecord(raw.button) ? raw.button : undefined;
  const buttons = button ? normalizeButtons(button.buttons) : normalizeButtons(legacyButtons);
  const exportWith = isRecord(raw.export_with) ? raw.export_with : {};
  return {
    ...rest,
    type: 'script',
    enabled: raw.enabled === true,
    name: raw.name === undefined || raw.name === null ? '' : String(raw.name),
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : randomUUID(),
    content: typeof raw.content === 'string' ? raw.content : String(raw.content ?? ''),
    info: typeof raw.info === 'string' ? raw.info : '',
    button: { enabled: button ? button.enabled !== false : true, buttons },
    data: isRecord(raw.data) ? raw.data : {},
    export_with: {
      data: exportWith.data !== false,
      button: exportWith.button !== false,
    },
  };
}

function looksLikeScript(value: Record<string, unknown>): boolean {
  return typeof value.content === 'string' || typeof value.name === 'string';
}

/**
 * 任意导入物 → 平铺的脚本列表。认：
 * - 新格式 `Script` / `ScriptFolder`（`scripts` 数组）；
 * - 旧格式 `ScriptItem`（`{type:'script', value}`）/ 旧 `ScriptFolder`（`value` 数组）/ 裸 `ScriptData`；
 * - 以上任意一种的数组（脚本树）。
 * 文件夹展平，名字记进 `folder`；文件夹关着时里面的脚本按关处理（与酒馆助手的运行判定一致）。
 */
export function parseScriptTrees(input: unknown): ParsedScript[] {
  const out: ParsedScript[] = [];
  const visit = (value: unknown, folder: string | null, folderEnabled: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, folder, folderEnabled);
      return;
    }
    if (!isRecord(value)) return;
    if (value.type === 'folder') {
      const name = typeof value.name === 'string' ? value.name : '';
      // 旧格式文件夹没有 enabled 字段，backward.ts 转换时一律当开
      const enabled = value.enabled === undefined ? true : value.enabled === true;
      const children = Array.isArray(value.scripts) ? value.scripts : value.value;
      visit(children, name || folder, folderEnabled && enabled);
      return;
    }
    // 旧格式 ScriptItem：`{ type:'script', value: ScriptData }`
    const inner = value.type === 'script' && isRecord(value.value) ? value.value : value;
    if (!looksLikeScript(inner)) return;
    const script = normalizeScript(inner);
    out.push({ script, folder, enabled: folderEnabled && script.enabled === true });
  };
  visit(input, null, true);
  return out;
}

/* ------------------------------------------------------------------ */
/* 读写                                                                */
/* ------------------------------------------------------------------ */

export function listScripts(db: Db, scope: ScriptScope, ownerId?: string | null): ScriptRow[] {
  const where =
    scope === 'global'
      ? eq(schema.scripts.scope, 'global')
      : ownerId
        ? and(eq(schema.scripts.scope, 'preset'), eq(schema.scripts.ownerId, ownerId))
        : eq(schema.scripts.scope, 'preset');
  return db
    .select()
    .from(schema.scripts)
    .where(where)
    .orderBy(asc(schema.scripts.displayOrder), asc(schema.scripts.createdAt))
    .all()
    .map(toScriptRow);
}

export function getScript(db: Db, id: string): ScriptRow | undefined {
  const row = db.select().from(schema.scripts).where(eq(schema.scripts.id, id)).get();
  return row ? toScriptRow(row) : undefined;
}

/** 某一组（scope + owner）里下一个 displayOrder */
export function nextScriptOrder(db: Db, scope: ScriptScope, ownerId: string | null): number {
  const last = db
    .select()
    .from(schema.scripts)
    .where(
      and(
        eq(schema.scripts.scope, scope),
        ownerId === null ? isNull(schema.scripts.ownerId) : eq(schema.scripts.ownerId, ownerId),
      ),
    )
    .orderBy(desc(schema.scripts.displayOrder))
    .get();
  return (last?.displayOrder ?? -1) + 1;
}

export interface CreateScriptInput {
  scope: ScriptScope;
  ownerId?: string | null;
  name: string;
  content?: string;
  enabled?: boolean;
  buttons?: ScriptButton[];
  info?: string;
}

export function createScript(db: Db, input: CreateScriptInput): ScriptRow {
  const ownerId = input.scope === 'global' ? null : (input.ownerId ?? null);
  const buttons = input.buttons ?? [];
  const script = normalizeScript({
    name: input.name,
    content: input.content ?? '',
    enabled: input.enabled ?? false,
    info: input.info ?? '',
    button: { enabled: true, buttons },
  });
  const row = db
    .insert(schema.scripts)
    .values({
      scope: input.scope,
      ownerId,
      name: input.name,
      content: input.content ?? '',
      enabled: input.enabled ?? false,
      buttons: buttons as unknown as Record<string, unknown>[],
      data: script,
      displayOrder: nextScriptOrder(db, input.scope, ownerId),
    })
    .returning()
    .get();
  return toScriptRow(row);
}

export interface UpdateScriptInput {
  name?: string;
  content?: string;
  enabled?: boolean;
  buttons?: ScriptButton[];
  buttonsEnabled?: boolean;
  info?: string;
}

export function updateScript(db: Db, id: string, patch: UpdateScriptInput): ScriptRow | undefined {
  const current = db.select().from(schema.scripts).where(eq(schema.scripts.id, id)).get();
  if (!current) return undefined;
  const data: Record<string, unknown> = { ...(isRecord(current.data) ? current.data : {}) };
  if (patch.info !== undefined) data.info = patch.info;
  if (patch.buttons !== undefined || patch.buttonsEnabled !== undefined) {
    const button = isRecord(data.button) ? data.button : {};
    data.button = {
      ...button,
      enabled: patch.buttonsEnabled ?? button.enabled !== false,
      buttons: patch.buttons ?? normalizeButtons(current.buttons),
    };
  }
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.content !== undefined) data.content = patch.content;
  if (patch.enabled !== undefined) data.enabled = patch.enabled;
  const row = db
    .update(schema.scripts)
    .set({
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.content === undefined ? {} : { content: patch.content }),
      ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
      ...(patch.buttons === undefined
        ? {}
        : { buttons: patch.buttons as unknown as Record<string, unknown>[] }),
      data,
      updatedAt: new Date(),
    })
    .where(eq(schema.scripts.id, id))
    .returning()
    .get();
  return toScriptRow(row);
}

export function deleteScript(db: Db, id: string): boolean {
  const row = db.delete(schema.scripts).where(eq(schema.scripts.id, id)).returning().get();
  if (row) {
    // 脚本自己的变量表（`getVariables({type:'script'})`）跟着脚本走
    db.delete(schema.variables)
      .where(and(eq(schema.variables.scope, 'script'), eq(schema.variables.ownerId, id)))
      .run();
  }
  return row !== undefined;
}

/** 预设删除时带走它自带的脚本 */
export function deleteOwnerScripts(db: Db, scope: ScriptScope, ownerId: string): number {
  return db
    .delete(schema.scripts)
    .where(and(eq(schema.scripts.scope, scope), eq(schema.scripts.ownerId, ownerId)))
    .returning()
    .all().length;
}

/** 按给定顺序重排；不认识的 id 忽略 */
export function reorderScripts(db: Db, ids: readonly string[]): void {
  db.transaction((tx) => {
    ids.forEach((id, index) => {
      tx.update(schema.scripts)
        .set({ displayOrder: index, updatedAt: new Date() })
        .where(eq(schema.scripts.id, id))
        .run();
    });
  });
}

export interface ImportScriptsOptions {
  scope?: ScriptScope;
  ownerId?: string | null;
  /** 缺省 false：导入后由前端问一句「现在启用吗」 */
  enabled?: boolean | 'source';
}

/** 导入物 → 入库。返回新行（按原顺序） */
export function importScripts(
  db: Db,
  input: unknown,
  options: ImportScriptsOptions = {},
): ScriptRow[] {
  const scope = options.scope ?? 'global';
  const ownerId = scope === 'global' ? null : (options.ownerId ?? null);
  const parsed = parseScriptTrees(input);
  if (parsed.length === 0) return [];
  let order = nextScriptOrder(db, scope, ownerId);
  return db.transaction((tx) =>
    parsed.map((item) => {
      const enabled = options.enabled === 'source' ? item.enabled : options.enabled === true;
      const button = item.script.button as { buttons: ScriptButton[] };
      const row = tx
        .insert(schema.scripts)
        .values({
          scope,
          ownerId,
          name: String(item.script.name),
          content: String(item.script.content),
          enabled,
          buttons: button.buttons as unknown as Record<string, unknown>[],
          data: {
            ...item.script,
            ...(item.folder ? { folder: item.folder } : {}),
            sourceEnabled: item.enabled,
          },
          displayOrder: order++,
        })
        .returning()
        .get();
      return toScriptRow(row);
    }),
  );
}

/** 酒馆助手 Script 格式（导出）：以原件为底叠加列值，去掉簿记键 */
export function exportScript(row: ScriptRow): Record<string, unknown> {
  const base: Record<string, unknown> = { ...row.data };
  for (const key of BOOKKEEPING_KEYS) delete base[key];
  const exportWith = isRecord(base.export_with) ? base.export_with : {};
  return {
    ...base,
    type: 'script',
    enabled: row.enabled,
    name: row.name,
    id: typeof base.id === 'string' && base.id !== '' ? base.id : row.id,
    content: row.content,
    info: row.info,
    button: { enabled: row.buttonsEnabled, buttons: row.buttons },
    data: isRecord(base.data) ? base.data : {},
    export_with: {
      data: exportWith.data !== false,
      button: exportWith.button !== false,
    },
  };
}

/* ------------------------------------------------------------------ */
/* 预设自带脚本                                                         */
/* ------------------------------------------------------------------ */

/** 预设 JSON 里的 `extensions.tavern_helper.scripts`（旧卡另有 `TavernHelper_scripts`，一并认） */
export function presetEmbeddedScripts(data: unknown): unknown[] {
  const extensions = isRecord(data) && isRecord(data.extensions) ? data.extensions : undefined;
  if (!extensions) return [];
  const helper = isRecord(extensions.tavern_helper) ? extensions.tavern_helper : undefined;
  if (helper && Array.isArray(helper.scripts)) return helper.scripts;
  if (Array.isArray(extensions.TavernHelper_scripts)) return extensions.TavernHelper_scripts;
  return [];
}

function hasOwnerRows(db: Db, scope: ScriptScope, ownerId: string): boolean {
  return (
    db
      .select({ id: schema.scripts.id })
      .from(schema.scripts)
      .where(and(eq(schema.scripts.scope, scope), eq(schema.scripts.ownerId, ownerId)))
      .get() !== undefined
  );
}

export interface EmbeddedScriptsSummary {
  scope: 'preset';
  ownerId: string;
  ownerName: string;
  count: number;
}

/**
 * 把预设自带的脚本抽成 `scope:'preset'` 行（原件不动）。已经抽过的预设跳过（导入 / 回填幂等）。
 * 默认一律关闭：跑陌生预设的脚本要用户点头（与自带正则同一交互）。
 */
export function extractPresetScripts(
  db: Db,
  preset: { id: string; name: string; data: unknown },
  options: { enabled?: boolean } = {},
): number {
  const list = presetEmbeddedScripts(preset.data);
  if (list.length === 0) return 0;
  if (hasOwnerRows(db, 'preset', preset.id)) return 0;
  return importScripts(db, list, {
    scope: 'preset',
    ownerId: preset.id,
    enabled: options.enabled ? 'source' : false,
  }).length;
}

export function summarizeScripts(
  ownerId: string,
  ownerName: string,
  count: number,
): EmbeddedScriptsSummary | null {
  return count > 0 ? { scope: 'preset', ownerId, ownerName, count } : null;
}

/**
 * 一键启用 / 停用某个预设的全部自带脚本。启用时按原件里的开关恢复（`data.sourceEnabled`），
 * 停用时全关。返回状态变了的条数。
 */
export function setOwnerScriptsEnabled(
  db: Db,
  scope: ScriptScope,
  ownerId: string,
  enabled: boolean,
): number {
  const rows = db
    .select()
    .from(schema.scripts)
    .where(and(eq(schema.scripts.scope, scope), eq(schema.scripts.ownerId, ownerId)))
    .all();
  return db.transaction((tx) => {
    let changed = 0;
    for (const row of rows) {
      const data = isRecord(row.data) ? row.data : {};
      const next = enabled ? data.sourceEnabled !== false : false;
      if (next === row.enabled) continue;
      tx.update(schema.scripts)
        .set({ enabled: next, data: { ...data, enabled: next }, updatedAt: new Date() })
        .where(eq(schema.scripts.id, row.id))
        .run();
      changed += 1;
    }
    return changed;
  });
}

/** 回填：老库里导入过的预设补抽脚本（幂等；回填成关闭） */
export function backfillPresetScripts(db: Db): number {
  let total = 0;
  for (const row of db.select().from(schema.presets).all()) {
    total += extractPresetScripts(db, row);
  }
  return total;
}

/**
 * ST 迁移用：库里是否已有这个全局脚本（按原件 id，其次名字 + 正文）。
 * 迁移重跑时跳过已有的。
 */
export function globalScriptKeys(db: Db): Set<string> {
  const keys = new Set<string>();
  for (const row of listScripts(db, 'global')) {
    if (typeof row.data.id === 'string') keys.add(`id:${row.data.id}`);
    keys.add(`nc:${JSON.stringify([row.name, row.content])}`);
  }
  return keys;
}

export function scriptKeysOf(script: Record<string, unknown>): string[] {
  const keys = [`nc:${JSON.stringify([String(script.name ?? ''), String(script.content ?? '')])}`];
  if (typeof script.id === 'string') keys.unshift(`id:${script.id}`);
  return keys;
}
