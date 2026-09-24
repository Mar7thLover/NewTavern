import { mutate, type LorebookDetail, type PresetDetail } from '../../../lib/api';
import {
  updateCharacter,
  type StudioCharacterDetail,
  type StudioDraftBody,
  type StudioKind,
  type VersionAuthor,
} from '../../../lib/api-studio';
import {
  isLorebookDraftDirty,
  isLorebookDraftValid,
  lorebookDraftToEntries,
  lorebookDraftToRequest,
  lorebookToDraft,
} from '../../library/lorebook-editor';
import {
  isPresetDraftDirty,
  isPresetDraftValid,
  presetToDraft,
  savePresetDraft,
} from '../../library/preset-editor';
import type { CharacterDraft, StudioPair, StudioPatchOp } from '../types';
import {
  compareCharacterVersion,
  compareLorebookVersion,
  comparePresetVersion,
  type ChangeRow,
} from './changes';
import {
  applyCharacterOps,
  applyLorebookOps,
  applyPresetOps,
  lorebookAssistDraft,
  presetAssistDraft,
} from './patch';

/*
 * 三种实体在工作台里的差异点集中在这里：服务端详情 ⇄ 草稿、dirty / 校验、保存、
 * 组装草稿（测试对话 / 检查器）、协作草稿（AI）、补丁合并、版本对比。
 */

export type StudioDetail = StudioCharacterDetail | PresetDetail | LorebookDetail;

const jsonCache = new WeakMap<object, string>();
function jsonOf(value: object): string {
  let json = jsonCache.get(value);
  if (json === undefined) {
    json = JSON.stringify(value);
    jsonCache.set(value, json);
  }
  return json;
}

export function characterDraftDirty(baseline: CharacterDraft, draft: CharacterDraft): boolean {
  return baseline !== draft && jsonOf(baseline) !== jsonOf(draft);
}

export function characterDraftValid(draft: CharacterDraft): boolean {
  return typeof draft.name === 'string' && draft.name.trim() !== '';
}

/** 服务端详情 → 草稿对（基线 = 草稿） */
export function detailToPair(kind: StudioKind, detail: StudioDetail): StudioPair {
  switch (kind) {
    case 'character': {
      const data = (detail as StudioCharacterDetail).data;
      return { kind, baseline: data, draft: data };
    }
    case 'preset': {
      const draft = presetToDraft(detail as PresetDetail);
      return { kind, baseline: draft, draft };
    }
    case 'lorebook': {
      const draft = lorebookToDraft(detail as LorebookDetail);
      return { kind, baseline: draft, draft };
    }
  }
}

export function pairDirty(pair: StudioPair): boolean {
  switch (pair.kind) {
    case 'character':
      return characterDraftDirty(pair.baseline, pair.draft);
    case 'preset':
      return isPresetDraftDirty(pair.baseline, pair.draft);
    case 'lorebook':
      return isLorebookDraftDirty(pair.baseline, pair.draft);
  }
}

export function pairValid(pair: StudioPair): boolean {
  switch (pair.kind) {
    case 'character':
      return characterDraftValid(pair.draft);
    case 'preset':
      return isPresetDraftValid(pair.draft);
    case 'lorebook':
      return isLorebookDraftValid(pair.draft);
  }
}

export function pairName(pair: StudioPair): string {
  if (pair.kind === 'character') {
    return typeof pair.draft.name === 'string' ? pair.draft.name : '';
  }
  return pair.draft.name;
}

/**
 * 组装草稿（§2.4）：只有「有改动且能组装」时才给，否则 undefined（按库里的走）。
 * 世界书只带与基线不同的字段（同 PUT）。
 */
export function assembleDraftOf(pair: StudioPair, id: string): StudioDraftBody | undefined {
  if (!pairDirty(pair) || !pairValid(pair)) return undefined;
  switch (pair.kind) {
    case 'character':
      return { character: { id, data: pair.draft } };
    case 'preset':
      return { preset: { id, data: pair.draft.data } };
    case 'lorebook':
      return {
        lorebook: {
          id,
          name: pair.draft.name.trim(),
          entries: lorebookDraftToEntries(pair.draft, pair.baseline) as Record<string, unknown>[],
        },
      };
  }
}

/** 协作草稿（§3.1 `draft`） */
export function assistDraftOf(pair: StudioPair): Record<string, unknown> {
  switch (pair.kind) {
    case 'character':
      return pair.draft;
    case 'preset':
      return presetAssistDraft(pair.draft);
    case 'lorebook':
      return lorebookAssistDraft(pair.draft);
  }
}

/** 把补丁合进草稿（返回同 kind 的新草稿对） */
export function applyOpsToPair(pair: StudioPair, ops: readonly StudioPatchOp[]): StudioPair {
  switch (pair.kind) {
    case 'character':
      return { ...pair, draft: applyCharacterOps(pair.draft, ops) };
    case 'preset':
      return { ...pair, draft: applyPresetOps(pair.draft, ops) };
    case 'lorebook':
      return { ...pair, draft: applyLorebookOps(pair.draft, ops) };
  }
}

/** 当前草稿 vs 某一版本（恢复会带来的改动） */
export function compareWithVersion(pair: StudioPair, data: unknown): ChangeRow[] {
  switch (pair.kind) {
    case 'character':
      return compareCharacterVersion(pair.draft, data);
    case 'preset':
      return comparePresetVersion(pair.draft, data);
    case 'lorebook':
      return compareLorebookVersion(pair.draft, data);
  }
}

export interface SaveResult {
  /** 保存后的服务端详情（预设两块都没改时为 undefined） */
  detail: StudioDetail | undefined;
  /** 新基线 */
  baseline: StudioPair['baseline'];
}

/** 保存（AI 接受过的改动 author='ai'） */
export async function savePair(
  pair: StudioPair,
  id: string,
  author: VersionAuthor,
): Promise<SaveResult> {
  switch (pair.kind) {
    case 'character': {
      const row = await updateCharacter(id, pair.draft, author);
      return { detail: row, baseline: row.data };
    }
    case 'preset': {
      const row = await savePresetDraft(id, pair.draft, pair.baseline, { author });
      return { detail: row, baseline: row ? presetToDraft(row) : pair.draft };
    }
    case 'lorebook': {
      const submitted = pair.draft;
      const row = await mutate<LorebookDetail>(`/api/lorebooks/${encodeURIComponent(id)}`, 'PUT', {
        ...lorebookDraftToRequest(submitted, pair.baseline),
        author,
      });
      return { detail: row, baseline: lorebookToDraft(row, submitted) };
    }
  }
}
