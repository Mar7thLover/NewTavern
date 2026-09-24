import { mutate, type LorebookEntryInput } from '../../../lib/api';

/*
 * 世界书触发模拟（M6 §2.5 + §6 修正第 7 条）：`POST /api/lorebooks/:id/simulate`。
 * 形状与服务端 `routes/lorebooks.ts` 的 `LorebookSimulateRequest` / `services/studio-simulate.ts` 一致。
 */

export interface LorebookSimulateRequest {
  text: string;
  /** 草稿条目（同 PUT 形态）；缺省用已保存的条目 */
  entries?: LorebookEntryInput[];
  /** 覆盖全局扫描深度 */
  scanDepth?: number;
}

export type LorebookSimulateReason = 'constant' | 'key' | 'secondary' | 'recursion' | 'decorator';

export interface LorebookSimulateActivated {
  /** 条目 id；草稿里的新条目为 null，用 index 对应 */
  id: string | null;
  /** 在提交的条目列表（或库里的展示顺序）中的下标 */
  index: number;
  uid: number | null;
  comment: string | null;
  reason: LorebookSimulateReason;
  /** 命中的主键；reason='secondary' 时后面接着命中的副键 */
  matchedKeys: string[];
  position: number;
  depth: number | null;
  order: number;
  /** 第几轮递归激活的（0 = 直接命中） */
  recursionLevel: number;
}

/** 引擎的拒绝原因（core `WIRejectReason`）+ `no-match` */
export type LorebookSkipReason =
  | 'disabled'
  | 'trigger'
  | 'character-filter'
  | 'delay'
  | 'cooldown'
  | 'delay-until-recursion'
  | 'exclude-recursion'
  | 'dont-activate'
  | 'probability'
  | 'budget'
  | 'group-lost'
  | 'empty-content'
  | 'greeting'
  | 'no-match';

export interface LorebookSimulateSkipped {
  id: string | null;
  index: number;
  uid: number | null;
  reason: LorebookSkipReason;
}

export interface LorebookSimulateResult {
  activated: LorebookSimulateActivated[];
  skipped: LorebookSimulateSkipped[];
  warnings: string[];
}

export function simulateLorebook(
  id: string,
  request: LorebookSimulateRequest,
): Promise<LorebookSimulateResult> {
  return mutate<LorebookSimulateResult>(
    `/api/lorebooks/${encodeURIComponent(id)}/simulate`,
    'POST',
    request,
  );
}
