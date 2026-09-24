import type { CharacterCardData } from '../../lib/api';
import type { StudioKind } from '../../lib/api-studio';
import type { LorebookDraft } from '../library/lorebook-editor';
import type { PresetDraft } from '../library/preset-editor';

export type { StudioKind };

/**
 * AI 协作者的补丁（M6 §3.2，形状与服务端 `services/studio-assist-tools.ts` 一致）：
 * - `set`：`path` 为 JSON Pointer；原路径不存在时**没有 `before` 键**；数组下标 = 原长度表示追加；
 * - `add_entry`：PUT 形态的条目字段 + `uid`；
 * - `update_entry`：`patch` 只含变了的字段，`before` 为这些字段的原值；
 * - `delete_entry`：`before` 为请求草稿里的整条原条目。
 */
export type StudioPatchOp =
  | { op: 'set'; path: string; value: unknown; before?: unknown }
  | { op: 'add_entry'; entry: Record<string, unknown>; uid: number }
  | {
      op: 'update_entry';
      uid: number;
      patch: Record<string, unknown>;
      before: Record<string, unknown>;
    }
  | { op: 'delete_entry'; uid: number; before: Record<string, unknown> };

/** 角色卡草稿 = 完整 CCv3 data（从 GET 拿到的 data 改出来的） */
export type CharacterDraft = CharacterCardData;

/** 三种实体的草稿与基线（同一 kind 的一对） */
export type StudioPair =
  | { kind: 'character'; baseline: CharacterDraft; draft: CharacterDraft }
  | { kind: 'preset'; baseline: PresetDraft; draft: PresetDraft }
  | { kind: 'lorebook'; baseline: LorebookDraft; draft: LorebookDraft };

export type StudioDraftOf<K extends StudioKind> = Extract<StudioPair, { kind: K }>['draft'];
export type AnyStudioDraft = StudioPair['draft'];
