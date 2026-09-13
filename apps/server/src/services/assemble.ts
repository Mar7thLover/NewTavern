/**
 * 组装入口——服务端的**唯一**切换点（契约 §5 [S→C]）。
 *
 * C 已在 `packages/core` 实现 `assemblePrompt` / `DEFAULT_PRESET`（契约 §2），
 * 这里直接转发；早期的临时实现 `assemble-shim.ts` 已删除。
 * 服务端其余代码只从本文件导入组装相关的符号，便于后续替换/包装。
 */
export { assemblePrompt, DEFAULT_PRESET } from '@newtavern/core';
export type {
  AssembleCharacter,
  AssembleHistoryNode,
  AssembleInput,
  AssemblePersona,
  AssemblePreset,
} from '@newtavern/core';
