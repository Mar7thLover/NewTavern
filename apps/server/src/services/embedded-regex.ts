import { and, desc, eq, inArray } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import { stRegexToScript, toRegexColumns, type RegexScope } from './regex-map.js';

/**
 * 角色卡 / 预设 / 世界书**自带**的正则脚本：导入时抽进 `regex_scripts` 表。
 * 见 docs/M3-CONTRACT.md §3.2 的修正（2026-09-18）。
 *
 * 为什么要抽表（以前角色卡的正则是组装时直接从卡里读的）：
 *
 * 1. **看得见**。用户在「设置 · 正则脚本」里根本不知道卡和预设偷偷带了什么，
 *    出了问题（正文被吃、思维链没藏住）无从查起。
 * 2. **能单独开关**。ST 也是这么设计的：`character_allowed_regex` / `preset_allowed_regex`
 *    两张允许名单，卡自带的正则默认不跑，用户点头才生效。
 * 3. **预设自带的正则以前压根没生效**。本机 14 个预设里有 11 个带正则
 *    （ARGO、小冰块、双人成行……多的 36 条），思维链美化 / 不发送思维链全靠它们。
 *
 * 原件不动：卡 / 预设 / 书里的 `extensions.regex_scripts` 原样保留，导出仍然无损
 * （所以表里的编辑不会写回原件——要那种同步是另一件事，见契约修正）。
 */

/** 抽表时记在 `extra` 里的来源信息 */
export interface EmbeddedRegexExtra {
  /** 原始 ST 条目（往返与「恢复原样」用） */
  raw: unknown;
  /** 原件里它本来是不是禁用的：第一次启用整组时按这个恢复，而不是一律打开 */
  sourceDisabled: boolean;
  /**
   * 关闭来源总开关前，这条脚本是不是禁用的。
   * 只在整组关闭期间存在；重新启用后恢复此状态并删除快照。
   */
  disabledBeforeOwnerToggle?: boolean;
  /** 抽自哪个文件 / 哪张卡（只作展示） */
  ownerName?: string;
}

export type EmbeddedScope = Exclude<RegexScope, 'global'>;

export interface EmbeddedRegexSummary {
  scope: EmbeddedScope;
  ownerId: string;
  ownerName: string;
  /** 抽出来几条 */
  count: number;
}

function embeddedScripts(data: unknown): unknown[] {
  const extensions = (data as { extensions?: unknown } | null)?.extensions;
  const list = (extensions as { regex_scripts?: unknown } | undefined)?.regex_scripts;
  return Array.isArray(list) ? list : [];
}

/** 这个来源已经抽过表了吗（重复导入 / 回填幂等） */
function hasRows(db: Db, scope: EmbeddedScope, ownerId: string): boolean {
  return (
    db
      .select({ id: schema.regexScripts.id })
      .from(schema.regexScripts)
      .where(and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, ownerId)))
      .get() !== undefined
  );
}

export interface ExtractOptions {
  scope: EmbeddedScope;
  ownerId: string;
  ownerName: string;
  /** 角色卡 `data` / 预设 JSON / 世界书 JSON */
  data: unknown;
  /**
   * 抽出来就直接生效吗。默认 `false`：导入时先收进库、问过用户再启用
   * （原件里本来就禁用的那几条，即使用户点了启用也仍然禁用）。
   */
  enabled?: boolean;
}

/**
 * 把一个来源自带的正则抽进表。返回抽出的条数（0 = 没带，或已经抽过）。
 */
export function extractEmbeddedRegex(db: Db, options: ExtractOptions): number {
  const list = embeddedScripts(options.data);
  if (list.length === 0) return 0;
  if (hasRows(db, options.scope, options.ownerId)) return 0;

  let order = 0;
  let count = 0;
  for (const raw of list) {
    const script = stRegexToScript(raw, `${options.ownerId}:${order}`, options.scope);
    if (!script) continue;
    const extra: EmbeddedRegexExtra = {
      raw,
      sourceDisabled: script.disabled,
      ownerName: options.ownerName,
    };
    db.insert(schema.regexScripts)
      .values({
        ...toRegexColumns(script),
        // 没点头之前一律不跑；点了头也只恢复到原件里的状态
        disabled: options.enabled ? script.disabled : true,
        scope: options.scope,
        ownerId: options.ownerId,
        displayOrder: order,
        extra: extra as unknown as Record<string, unknown>,
      })
      .run();
    order += 1;
    count += 1;
  }
  return count;
}

/** 导入接口回给前端的摘要（前端据此问「是否启用」） */
export function summarize(
  scope: EmbeddedScope,
  ownerId: string,
  ownerName: string,
  count: number,
): EmbeddedRegexSummary | null {
  return count > 0 ? { scope, ownerId, ownerName, count } : null;
}

/**
 * 启用 / 停用某个来源的全部自带正则。
 *
 * - 第一次启用时按 `extra.sourceDisabled` 恢复，尊重原件里作者设置的状态；
 * - 关闭时把每条脚本当前的 `disabled` 存进 `extra.disabledBeforeOwnerToggle`；
 * - 再次启用时恢复关闭前的逐条状态，并清掉快照。
 *
 * 快照随 `extra` 持久化，因此刷新页面或重启应用也不会丢失。重复关闭不会把快照
 * 覆盖成「全部禁用」，重复启用也不会把当前状态重置为原件状态。
 */
export function setOwnerRegexEnabled(
  db: Db,
  scope: EmbeddedScope,
  ownerId: string,
  enabled: boolean,
): number {
  const rows = db
    .select()
    .from(schema.regexScripts)
    .where(and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, ownerId)))
    .all();
  const extras = rows.map((row) => (row.extra ?? {}) as Partial<EmbeddedRegexExtra>);
  const hasSnapshot = extras.some((extra) => typeof extra.disabledBeforeOwnerToggle === 'boolean');
  const anyEnabled = rows.some((row) => !row.disabled);

  return db.transaction((tx) => {
    let changed = 0;
    for (const [index, row] of rows.entries()) {
      const extra = extras[index] ?? {};

      if (!enabled) {
        // 已经由总开关关闭时保持第一次快照，避免重复请求把它覆盖成 true。
        const nextExtra =
          hasSnapshot && !anyEnabled
            ? extra
            : { ...extra, disabledBeforeOwnerToggle: row.disabled };
        if (!row.disabled || nextExtra !== extra) {
          tx.update(schema.regexScripts)
            .set({
              disabled: true,
              extra: nextExtra as Record<string, unknown>,
              updatedAt: new Date(),
            })
            .where(eq(schema.regexScripts.id, row.id))
            .run();
        }
        if (!row.disabled) changed += 1;
        continue;
      }

      // 有快照说明这是一次「重新打开」；没有快照且已有子项启用，则是重复请求，保持现状。
      if (!hasSnapshot && anyEnabled) continue;
      const disabled =
        typeof extra.disabledBeforeOwnerToggle === 'boolean'
          ? extra.disabledBeforeOwnerToggle
          : extra.sourceDisabled === true;
      const nextExtra = { ...extra };
      delete nextExtra.disabledBeforeOwnerToggle;
      const hadSnapshot = typeof extra.disabledBeforeOwnerToggle === 'boolean';
      if (disabled !== row.disabled || hadSnapshot) {
        tx.update(schema.regexScripts)
          .set({
            disabled,
            extra: nextExtra as Record<string, unknown>,
            updatedAt: new Date(),
          })
          .where(eq(schema.regexScripts.id, row.id))
          .run();
      }
      if (disabled !== row.disabled) changed += 1;
    }
    return changed;
  });
}

/** 某个来源的脚本（组装与显示侧都用它） */
export function ownerRegexRows(db: Db, scope: EmbeddedScope, ownerId: string) {
  return db
    .select()
    .from(schema.regexScripts)
    .where(and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, ownerId)))
    .orderBy(schema.regexScripts.displayOrder, schema.regexScripts.createdAt)
    .all();
}

/** 来源名（列表展示用）：角色卡 / 预设 / 世界书的当前名字，取不到就用抽表时记的 */
export function ownerNames(db: Db, rows: readonly (typeof schema.regexScripts.$inferSelect)[]) {
  const byScope = new Map<EmbeddedScope, string[]>();
  for (const row of rows) {
    if (row.scope === 'global' || !row.ownerId) continue;
    const scope = row.scope as EmbeddedScope;
    const bucket = byScope.get(scope);
    if (bucket) bucket.push(row.ownerId);
    else byScope.set(scope, [row.ownerId]);
  }
  const names = new Map<string, string>();
  const collect = (
    scope: EmbeddedScope,
    table: typeof schema.characters | typeof schema.presets | typeof schema.lorebooks,
  ) => {
    const ids = byScope.get(scope);
    if (!ids || ids.length === 0) return;
    for (const row of db
      .select({ id: table.id, name: table.name })
      .from(table)
      .where(inArray(table.id, ids))
      .all()) {
      names.set(`${scope}:${row.id}`, row.name);
    }
  };
  collect('character', schema.characters);
  collect('preset', schema.presets);
  collect('book', schema.lorebooks);
  return names;
}

/** 全局脚本的下一个 displayOrder（导入 / 新建时用） */
export function nextGlobalOrder(db: Db): number {
  const last = db
    .select()
    .from(schema.regexScripts)
    .where(eq(schema.regexScripts.scope, 'global'))
    .orderBy(desc(schema.regexScripts.displayOrder))
    .get();
  return (last?.displayOrder ?? -1) + 1;
}
