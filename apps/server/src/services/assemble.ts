/**
 * 组装入口——服务端的**唯一**切换点（契约 §5 [S→C]、M3 契约 §9 [AS→SB]）。
 *
 * AS 已在 `packages/core` 实现组装流水线 v2（`assemblePrompt` 返回 `AssembleResult`），
 * 这里直接转发；服务端其余代码只从本文件导入组装相关的符号，便于后续替换/包装。
 */
export { assemblePrompt, DEFAULT_PRESET, diffLayouts } from '@newtavern/core';
export type {
  AssembleAuthorsNote,
  AssembleCharacter,
  AssembleDepthPrompt,
  AssembleGlobalSystemPrompt,
  AssembleHistoryNode,
  AssembleInput,
  AssembleInputV2,
  AssemblePersona,
  AssemblePreset,
  AssembleResult,
  LayoutBreakpoint,
  LayoutDiff,
  LayoutMove,
  LayoutPolicy,
  LayoutProviderCaps,
  LayoutReport,
  PromptIR,
  RegexScript,
  WIActivationSummary,
  WIBook,
  WIEntry,
  WIScanResult,
  WISettings,
  WITimedState,
} from '@newtavern/core';
