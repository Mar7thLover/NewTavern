import type { PresetDetail, PresetUpdateInput } from '../../../lib/api';
import { moveItem } from '../../scripts/api';

/*
 * 预设编辑器的草稿模型（纯函数，工作台 / 写作页 / 预设页共用）。
 *
 * 草稿 = ST 预设 JSON 原文（`PresetDetail.data`）的一份拷贝 + 名称 + 布局策略。
 * 所有改动都是「浅拷贝改一处」，没碰到的字段（包括未知字段）原样带回服务端，导出因此无损。
 * 条目列表与组装器读的是同一份 `prompt_order`（见 packages/core `readPromptOrder`）。
 * 布局策略（含逐条保真锁）存在 `presets.layout_policy` 列，不进 ST JSON，所以锁不影响导出。
 */

export type PresetData = Record<string, unknown>;

/**
 * 预设的布局策略（服务端 `services/preset-edit.ts` 的 `PresetLayoutPolicy`，形状一致）。
 * 全部可选；整体为 null = 跟随默认。编辑器只改 `mode` 与 `lockedIdentifiers`，其余键原样保留。
 */
export interface PresetLayoutPolicy {
  /** 布局模式；缺省 = 跟随会话 / 导入默认 */
  mode?: 'strict' | 'cache-aware';
  /** 保真锁：锁定的提示词条目 identifier（布局器不得移动） */
  lockedIdentifiers?: string[];
  tailWindow?: number;
  volatileHandling?: 'freeze' | 'warn';
  wiCarrierRole?: 'system' | 'user';
  ttl?: '5m' | '1h';
}

export type PresetLayoutMode = NonNullable<PresetLayoutPolicy['mode']>;

/** 预设编辑器的受控值 */
export interface PresetDraft {
  name: string;
  data: PresetData;
  layoutPolicy: PresetLayoutPolicy | null;
}

/** `prompt_order` 里的一项（`{ identifier, enabled }`，可能带未知字段） */
export type PresetOrderEntry = Record<string, unknown>;
/** `prompts` 里的一项（ST 提示词条目原文） */
export type PresetPrompt = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ */
/* 服务端 ⇄ 草稿                                                        */
/* ------------------------------------------------------------------ */

/** 规整布局策略：去掉空值与空锁表；什么都没有时回到 null（= 跟随默认） */
export function normalizeLayoutPolicy(value: unknown): PresetLayoutPolicy | null {
  if (!isRecord(value)) return null;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (key === 'lockedIdentifiers') {
      if (!Array.isArray(item)) continue;
      const ids = [...new Set(item.filter((id): id is string => typeof id === 'string'))];
      if (ids.length > 0) out[key] = ids;
      continue;
    }
    out[key] = item;
  }
  return Object.keys(out).length > 0 ? (out as PresetLayoutPolicy) : null;
}

/** 服务端详情 → 草稿 */
export function presetToDraft(
  detail: Pick<PresetDetail, 'name' | 'data' | 'layoutPolicy'>,
): PresetDraft {
  return {
    name: detail.name,
    data: detail.data,
    layoutPolicy: normalizeLayoutPolicy(detail.layoutPolicy),
  };
}

/** 草稿 → `PUT /api/presets/:id` 请求体（名称去首尾空白；data 原样） */
export function presetDraftToUpdate(draft: PresetDraft): PresetUpdateInput {
  return { name: draft.name.trim(), data: draft.data };
}

/** 草稿 → 布局策略请求体（`null` = 清空，跟随默认） */
export function presetDraftToLayoutPolicyBody(draft: PresetDraft): {
  layoutPolicy: PresetLayoutPolicy | null;
} {
  return { layoutPolicy: normalizeLayoutPolicy(draft.layoutPolicy) };
}

/** 名称非空才能保存 */
export function isPresetDraftValid(draft: PresetDraft): boolean {
  return draft.name.trim() !== '';
}

const jsonCache = new WeakMap<object, string>();
function jsonOf(value: object): string {
  let json = jsonCache.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    jsonCache.set(value, json);
  }
  return json;
}

function samePolicy(a: PresetLayoutPolicy | null, b: PresetLayoutPolicy | null): boolean {
  const left = normalizeLayoutPolicy(a);
  const right = normalizeLayoutPolicy(b);
  if (left === null || right === null) return left === right;
  return JSON.stringify(left) === JSON.stringify(right);
}

/** 草稿相对基线改了哪几块：`data`（含名称）走 PUT，`layoutPolicy` 单独保存 */
export function presetDraftChanges(
  baseline: PresetDraft,
  draft: PresetDraft,
): { data: boolean; layoutPolicy: boolean } {
  const data =
    draft.name.trim() !== baseline.name ||
    (draft.data !== baseline.data && jsonOf(draft.data) !== jsonOf(baseline.data));
  return { data, layoutPolicy: !samePolicy(baseline.layoutPolicy, draft.layoutPolicy) };
}

export function isPresetDraftDirty(baseline: PresetDraft, draft: PresetDraft): boolean {
  const changes = presetDraftChanges(baseline, draft);
  return changes.data || changes.layoutPolicy;
}

/* ------------------------------------------------------------------ */
/* 读 data                                                              */
/* ------------------------------------------------------------------ */

/** 组装器挑 `prompt_order` 的顺序：100001 → 100000 → 第一份（core `PROMPT_ORDER_DUMMY_IDS`） */
const PROMPT_ORDER_DUMMY_IDS = ['100001', '100000'];

/** 组装实际使用的那份 prompt_order 在数组里的下标；没有返回 -1 */
export function activeOrderIndex(data: PresetData): number {
  const lists = data.prompt_order;
  if (!Array.isArray(lists)) return -1;
  for (const dummyId of PROMPT_ORDER_DUMMY_IDS) {
    const index = lists.findIndex(
      (list) => isRecord(list) && String(list.character_id) === dummyId,
    );
    if (index >= 0) return isRecord(lists[index]) && Array.isArray(lists[index].order) ? index : -1;
  }
  const first = lists.findIndex(isRecord);
  return first >= 0 && Array.isArray((lists[first] as PresetData).order) ? first : -1;
}

export function readOrder(data: PresetData, index = activeOrderIndex(data)): PresetOrderEntry[] {
  if (index < 0) return [];
  const list = (data.prompt_order as PresetData[])[index];
  return ((list?.order as unknown[] | undefined) ?? []).filter(isRecord);
}

export function readPrompts(data: PresetData): PresetPrompt[] {
  return Array.isArray(data.prompts) ? data.prompts.filter(isRecord) : [];
}

/* ------------------------------------------------------------------ */
/* 改 data（全部返回新对象，不改入参）                                  */
/* ------------------------------------------------------------------ */

function replaceOrder(data: PresetData, fn: (order: unknown[]) => unknown[]): PresetData {
  const index = activeOrderIndex(data);
  if (index < 0) return data;
  const lists = [...(data.prompt_order as unknown[])];
  const list = lists[index] as PresetData;
  lists[index] = { ...list, order: fn([...(list.order as unknown[])]) };
  return { ...data, prompt_order: lists };
}

/**
 * 当前 prompt_order 里第 `position` 项（按 `readOrder` 的下标，已跳过非对象项）在原数组里的下标。
 * 原数组里混有非对象项时两者不同；绝大多数预设两者相同。
 */
function rawIndex(order: unknown[], position: number): number {
  let seen = -1;
  for (let i = 0; i < order.length; i++) {
    if (isRecord(order[i])) seen += 1;
    if (seen === position) return i;
  }
  return -1;
}

export function setField(data: PresetData, key: string, value: unknown): PresetData {
  return { ...data, [key]: value };
}

export function setOrderEnabled(data: PresetData, position: number, enabled: boolean): PresetData {
  return replaceOrder(data, (order) => {
    const index = rawIndex(order, position);
    const entry = order[index];
    if (isRecord(entry)) order[index] = { ...entry, enabled };
    return order;
  });
}

/**
 * 把第 `from` 项挪到第 `to` 项的位置（上下移与拖拽共用，语义同脚本库的 `moveItem`）。
 * 只重排 `prompt_order.order` 这一个数组，条目对象原样搬动，其余字段一概不碰——导出因此无损。
 */
export function moveOrderEntry(data: PresetData, from: number, to: number): PresetData {
  if (from === to) return data;
  return replaceOrder(data, (order) => {
    const positions: number[] = [];
    order.forEach((entry, i) => {
      if (isRecord(entry)) positions.push(i);
    });
    if (from < 0 || from >= positions.length) return order;
    const records = moveItem(
      positions.map((i) => order[i]),
      from,
      to,
    );
    // 非对象项（极少见）留在原位，对象项按新顺序填回
    positions.forEach((i, k) => {
      order[i] = records[k];
    });
    return order;
  });
}

export function patchPrompt(data: PresetData, identifier: string, patch: PresetPrompt): PresetData {
  return {
    ...data,
    prompts: (Array.isArray(data.prompts) ? data.prompts : []).map((prompt) =>
      isRecord(prompt) && prompt.identifier === identifier ? { ...prompt, ...patch } : prompt,
    ),
  };
}

export const DEFAULT_DEPTH = 4;
export const DEFAULT_ORDER = 100;

/** 新增自定义条目：追加到 prompts 末尾与当前 prompt_order 末尾（启用） */
export function addPrompt(data: PresetData, identifier: string, name: string): PresetData {
  const withPrompt: PresetData = {
    ...data,
    prompts: [
      ...(Array.isArray(data.prompts) ? data.prompts : []),
      {
        identifier,
        name,
        system_prompt: false,
        role: 'system',
        content: '',
        injection_position: 0,
        injection_depth: DEFAULT_DEPTH,
        injection_order: DEFAULT_ORDER,
        forbid_overrides: false,
      },
    ],
  };
  return replaceOrder(withPrompt, (order) => [...order, { identifier, enabled: true }]);
}

/** 删除条目：prompts 与所有 prompt_order 里都去掉，免得留下悬空引用 */
export function deletePrompt(data: PresetData, identifier: string): PresetData {
  return {
    ...data,
    prompts: (Array.isArray(data.prompts) ? data.prompts : []).filter(
      (prompt) => !(isRecord(prompt) && prompt.identifier === identifier),
    ),
    ...(Array.isArray(data.prompt_order)
      ? {
          prompt_order: data.prompt_order.map((list) =>
            isRecord(list) && Array.isArray(list.order)
              ? {
                  ...list,
                  order: list.order.filter(
                    (entry) => !(isRecord(entry) && entry.identifier === identifier),
                  ),
                }
              : list,
          ),
        }
      : {}),
  };
}

export function newIdentifier(existing: ReadonlySet<string>): string {
  for (;;) {
    const id = crypto.randomUUID();
    if (!existing.has(id)) return id;
  }
}

/* ------------------------------------------------------------------ */
/* 布局策略                                                             */
/* ------------------------------------------------------------------ */

export function lockedIdentifiers(policy: PresetLayoutPolicy | null): ReadonlySet<string> {
  return new Set(policy?.lockedIdentifiers ?? []);
}

export function setLayoutMode(
  policy: PresetLayoutPolicy | null,
  mode: PresetLayoutMode | null,
): PresetLayoutPolicy | null {
  const next: PresetLayoutPolicy = { ...(policy ?? {}) };
  if (mode === null) delete next.mode;
  else next.mode = mode;
  return normalizeLayoutPolicy(next);
}

export function setPromptLocked(
  policy: PresetLayoutPolicy | null,
  identifier: string,
  locked: boolean,
): PresetLayoutPolicy | null {
  const current = policy?.lockedIdentifiers ?? [];
  const without = current.filter((id) => id !== identifier);
  return normalizeLayoutPolicy({
    ...(policy ?? {}),
    lockedIdentifiers: locked ? [...without, identifier] : without,
  });
}

/** 删条目时顺手把它从锁表里去掉 */
export function deletePromptFromDraft(draft: PresetDraft, identifier: string): PresetDraft {
  return {
    ...draft,
    data: deletePrompt(draft.data, identifier),
    layoutPolicy: draft.layoutPolicy?.lockedIdentifiers?.includes(identifier)
      ? setPromptLocked(draft.layoutPolicy, identifier, false)
      : draft.layoutPolicy,
  };
}
