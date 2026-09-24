/**
 * 世界书编辑器（M6 §4.2）：受控组件 + 草稿模型 + 触发模拟。
 * `/lorebooks/:id` 页面、工作台（`features/studio`）与写作页共用。
 */
export { LorebookEditor, type LorebookEditorProps } from './LorebookEditor';
export {
  isLorebookDraftDirty,
  isLorebookDraftValid,
  lorebookDraftToEntries,
  lorebookDraftToRequest,
  lorebookToDraft,
  type LorebookDraft,
  type LorebookEntryDraft,
  type LorebookEntryPatch,
  type LorebookEntryRole,
} from './model';
export {
  simulateLorebook,
  type LorebookSimulateActivated,
  type LorebookSimulateReason,
  type LorebookSimulateRequest,
  type LorebookSimulateResult,
  type LorebookSimulateSkipped,
  type LorebookSkipReason,
} from './api';
