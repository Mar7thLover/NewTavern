/**
 * 预设编辑器（M6 §4.2）：受控组件 + 草稿模型 + 保存助手。
 * `/presets/:id` 页面、工作台（`features/studio`）与写作页共用。
 */
export { PresetEditor, type PresetEditorProps } from './PresetEditor';
export {
  isPresetDraftDirty,
  isPresetDraftValid,
  normalizeLayoutPolicy,
  presetDraftChanges,
  presetDraftToLayoutPolicyBody,
  presetDraftToUpdate,
  presetToDraft,
  type PresetData,
  type PresetDraft,
  type PresetLayoutMode,
  type PresetLayoutPolicy,
} from './model';
export { savePresetDraft, savePresetLayoutPolicy, useSavePresetDraft } from './api';
