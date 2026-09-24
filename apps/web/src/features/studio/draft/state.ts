import type { StudioPair, StudioPatchOp } from '../types';
import { applyOpsToPair } from './adapters';

/*
 * 工作台草稿的状态机（`useStudioDraft` 的纯逻辑部分，单测直接测它）。
 *
 * - baseline：上次保存 / 载入的状态；draft：当前编辑；两者同 kind。
 * - aiTouched：草稿里有 AI 接受进来的改动（保存时 PUT 带 author:'ai'）；保存 / 还原 / 重新载入后清零。
 * - revision：草稿每变一次 +1（检查器按它去抖刷新，免得拿整份草稿做 query key）。
 */

export interface StudioDraftState {
  pair: StudioPair;
  aiTouched: boolean;
  revision: number;
}

export type StudioDraftAction =
  /** 首次载入 / 恢复版本 / 外部重新载入：基线与草稿都换成它 */
  | { type: 'adopt'; pair: StudioPair }
  /** 编辑器改动：传入同 kind 的新草稿；等于基线时视为「放弃修改」 */
  | { type: 'edit'; draft: StudioPair['draft'] }
  /** 接受 AI 改动 */
  | { type: 'applyOps'; ops: readonly StudioPatchOp[] }
  /** 还原到上次保存 */
  | { type: 'revert' }
  /** 保存成功：`submitted` 是发出去的那份草稿；期间没再改就把草稿也换成服务端返回的 */
  | { type: 'saved'; baseline: StudioPair['baseline']; submitted: StudioPair['draft'] };

export function initDraftState(pair: StudioPair): StudioDraftState {
  return { pair: { ...pair, draft: pair.baseline } as StudioPair, aiTouched: false, revision: 0 };
}

export function studioDraftReducer(
  state: StudioDraftState | null,
  action: StudioDraftAction,
): StudioDraftState | null {
  if (action.type === 'adopt') {
    return {
      pair: { ...action.pair, draft: action.pair.baseline } as StudioPair,
      aiTouched: false,
      revision: (state?.revision ?? 0) + 1,
    };
  }
  if (!state) return state;
  const { pair } = state;
  switch (action.type) {
    case 'edit': {
      if (action.draft === pair.draft) return state;
      const reverted = action.draft === pair.baseline;
      return {
        pair: { ...pair, draft: action.draft } as StudioPair,
        aiTouched: reverted ? false : state.aiTouched,
        revision: state.revision + 1,
      };
    }
    case 'applyOps': {
      if (action.ops.length === 0) return state;
      return {
        pair: applyOpsToPair(pair, action.ops),
        aiTouched: true,
        revision: state.revision + 1,
      };
    }
    case 'revert':
      if (pair.draft === pair.baseline)
        return state.aiTouched ? { ...state, aiTouched: false } : state;
      return {
        pair: { ...pair, draft: pair.baseline } as StudioPair,
        aiTouched: false,
        revision: state.revision + 1,
      };
    case 'saved': {
      const untouched = pair.draft === action.submitted;
      return {
        pair: {
          ...pair,
          baseline: action.baseline,
          draft: untouched ? action.baseline : pair.draft,
        } as StudioPair,
        aiTouched: false,
        revision: state.revision + 1,
      };
    }
  }
}
