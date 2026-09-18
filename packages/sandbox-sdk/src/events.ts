/**
 * 事件名表。见 docs/M5-CONTRACT.md §5.3。
 *
 * `TAVERN_EVENTS` / `IFRAME_EVENTS` 的字符串**原样照抄酒馆助手 4.9.3**（`@types/iframe/event.d.ts`）：
 * 前端卡写的是 `eventOn(tavern_events.MESSAGE_RECEIVED, …)`，名字必须一模一样。
 * 表是全的，但新酒馆只真的会广播 `EMITTED_EVENTS` 里那些——其余留在表里是为了让
 * `tavern_events.XXX` 不变成 `undefined`（卡拿 undefined 去注册会静默失效，比报错更难查）。
 */

export const IFRAME_EVENTS = {
  MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started',
  MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
  GENERATION_STARTED: 'js_generation_started',
  STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully',
  STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
  GENERATION_ENDED: 'js_generation_ended',
} as const;

export const TAVERN_EVENTS = {
  APP_READY: 'app_ready',
  EXTRAS_CONNECTED: 'extras_connected',
  MESSAGE_SWIPED: 'message_swiped',
  MESSAGE_SENT: 'message_sent',
  MESSAGE_RECEIVED: 'message_received',
  MESSAGE_EDITED: 'message_edited',
  MESSAGE_DELETED: 'message_deleted',
  MESSAGE_UPDATED: 'message_updated',
  MESSAGE_FILE_EMBEDDED: 'message_file_embedded',
  MESSAGE_REASONING_EDITED: 'message_reasoning_edited',
  MESSAGE_REASONING_DELETED: 'message_reasoning_deleted',
  MESSAGE_SWIPE_DELETED: 'message_swipe_deleted',
  MORE_MESSAGES_LOADED: 'more_messages_loaded',
  IMPERSONATE_READY: 'impersonate_ready',
  CHAT_CHANGED: 'chat_id_changed',
  GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
  GENERATION_STARTED: 'generation_started',
  GENERATION_STOPPED: 'generation_stopped',
  GENERATION_ENDED: 'generation_ended',
  SD_PROMPT_PROCESSING: 'sd_prompt_processing',
  EXTENSIONS_FIRST_LOAD: 'extensions_first_load',
  EXTENSION_SETTINGS_LOADED: 'extension_settings_loaded',
  SETTINGS_LOADED: 'settings_loaded',
  SETTINGS_UPDATED: 'settings_updated',
  MOVABLE_PANELS_RESET: 'movable_panels_reset',
  SETTINGS_LOADED_BEFORE: 'settings_loaded_before',
  SETTINGS_LOADED_AFTER: 'settings_loaded_after',
  CHATCOMPLETION_SOURCE_CHANGED: 'chatcompletion_source_changed',
  CHATCOMPLETION_MODEL_CHANGED: 'chatcompletion_model_changed',
  OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
  OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
  OAI_PRESET_EXPORT_READY: 'oai_preset_export_ready',
  OAI_PRESET_IMPORT_READY: 'oai_preset_import_ready',
  WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
  WORLDINFO_UPDATED: 'worldinfo_updated',
  CHARACTER_EDITOR_OPENED: 'character_editor_opened',
  CHARACTER_EDITED: 'character_edited',
  CHARACTER_PAGE_LOADED: 'character_page_loaded',
  USER_MESSAGE_RENDERED: 'user_message_rendered',
  CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
  FORCE_SET_BACKGROUND: 'force_set_background',
  CHAT_DELETED: 'chat_deleted',
  CHAT_CREATED: 'chat_created',
  GENERATE_BEFORE_COMBINE_PROMPTS: 'generate_before_combine_prompts',
  GENERATE_AFTER_COMBINE_PROMPTS: 'generate_after_combine_prompts',
  GENERATE_AFTER_DATA: 'generate_after_data',
  WORLD_INFO_ACTIVATED: 'world_info_activated',
  TEXT_COMPLETION_SETTINGS_READY: 'text_completion_settings_ready',
  CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
  CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
  CHARACTER_FIRST_MESSAGE_SELECTED: 'character_first_message_selected',
  CHARACTER_DELETED: 'characterDeleted',
  CHARACTER_DUPLICATED: 'character_duplicated',
  CHARACTER_RENAMED: 'character_renamed',
  CHARACTER_RENAMED_IN_PAST_CHAT: 'character_renamed_in_past_chat',
  SMOOTH_STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_TOKEN_RECEIVED: 'stream_token_received',
  STREAM_REASONING_DONE: 'stream_reasoning_done',
  FILE_ATTACHMENT_DELETED: 'file_attachment_deleted',
  WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
  OPEN_CHARACTER_LIBRARY: 'open_character_library',
  ONLINE_STATUS_CHANGED: 'online_status_changed',
  IMAGE_SWIPED: 'image_swiped',
  CONNECTION_PROFILE_LOADED: 'connection_profile_loaded',
  CONNECTION_PROFILE_CREATED: 'connection_profile_created',
  CONNECTION_PROFILE_DELETED: 'connection_profile_deleted',
  CONNECTION_PROFILE_UPDATED: 'connection_profile_updated',
  TOOL_CALLS_PERFORMED: 'tool_calls_performed',
  TOOL_CALLS_RENDERED: 'tool_calls_rendered',
  CHARACTER_MANAGEMENT_DROPDOWN: 'charManagementDropdown',
  SECRET_WRITTEN: 'secret_written',
  SECRET_DELETED: 'secret_deleted',
  SECRET_ROTATED: 'secret_rotated',
  SECRET_EDITED: 'secret_edited',
  PRESET_CHANGED: 'preset_changed',
  PRESET_DELETED: 'preset_deleted',
  PRESET_RENAMED: 'preset_renamed',
  PRESET_RENAMED_BEFORE: 'preset_renamed_before',
  MAIN_API_CHANGED: 'main_api_changed',
  WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
  WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
  MEDIA_ATTACHMENT_DELETED: 'media_attachment_deleted',
} as const;

/**
 * MVU 的事件名（照抄原版，**包括 `initiailized` 这个拼写错误**——
 * 社区卡监听的就是这个字符串）。
 */
export const MVU_EVENTS = {
  VARIABLE_INITIALIZED: 'mag_variable_initiailized',
  VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
  COMMAND_PARSED: 'mag_command_parsed',
  VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
  BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
} as const;

/** 新酒馆原生事件（`window.newtavern.on`）；酒馆助手的名字由下表映射过来 */
export const NATIVE_EVENTS = {
  MESSAGE_ADDED: 'message:added',
  MESSAGE_UPDATED: 'message:updated',
  MESSAGE_DELETED: 'message:deleted',
  MESSAGE_SWIPED: 'message:swiped',
  GENERATION_STARTED: 'generation:started',
  GENERATION_ENDED: 'generation:ended',
  GENERATION_STOPPED: 'generation:stopped',
  STREAM_DELTA: 'stream:delta',
  VARIABLES_UPDATED: 'variables:updated',
  CHAT_CHANGED: 'chat:changed',
} as const;

/** 原生事件 → 酒馆助手事件名（一个原生事件可以映射到多个兼容名） */
export const NATIVE_TO_TAVERN: Record<string, readonly string[]> = {
  [NATIVE_EVENTS.MESSAGE_ADDED]: [TAVERN_EVENTS.MESSAGE_RECEIVED, TAVERN_EVENTS.CHARACTER_MESSAGE_RENDERED],
  [NATIVE_EVENTS.MESSAGE_UPDATED]: [TAVERN_EVENTS.MESSAGE_UPDATED, TAVERN_EVENTS.MESSAGE_EDITED],
  [NATIVE_EVENTS.MESSAGE_DELETED]: [TAVERN_EVENTS.MESSAGE_DELETED],
  [NATIVE_EVENTS.MESSAGE_SWIPED]: [TAVERN_EVENTS.MESSAGE_SWIPED],
  [NATIVE_EVENTS.GENERATION_STARTED]: [TAVERN_EVENTS.GENERATION_STARTED],
  [NATIVE_EVENTS.GENERATION_ENDED]: [TAVERN_EVENTS.GENERATION_ENDED],
  [NATIVE_EVENTS.GENERATION_STOPPED]: [TAVERN_EVENTS.GENERATION_STOPPED],
  [NATIVE_EVENTS.STREAM_DELTA]: [TAVERN_EVENTS.STREAM_TOKEN_RECEIVED],
  [NATIVE_EVENTS.CHAT_CHANGED]: [TAVERN_EVENTS.CHAT_CHANGED],
};

/**
 * 新酒馆真的会广播的酒馆助手事件。**兼容矩阵就以这份为准**
 * （docs/M5-CONTRACT.md §5.3 的表由它生成）。
 */
export const EMITTED_EVENTS: readonly string[] = [
  TAVERN_EVENTS.MESSAGE_SENT,
  TAVERN_EVENTS.MESSAGE_RECEIVED,
  TAVERN_EVENTS.MESSAGE_UPDATED,
  TAVERN_EVENTS.MESSAGE_EDITED,
  TAVERN_EVENTS.MESSAGE_DELETED,
  TAVERN_EVENTS.MESSAGE_SWIPED,
  TAVERN_EVENTS.CHARACTER_MESSAGE_RENDERED,
  TAVERN_EVENTS.USER_MESSAGE_RENDERED,
  TAVERN_EVENTS.GENERATION_STARTED,
  TAVERN_EVENTS.GENERATION_ENDED,
  TAVERN_EVENTS.GENERATION_STOPPED,
  TAVERN_EVENTS.STREAM_TOKEN_RECEIVED,
  TAVERN_EVENTS.CHAT_CHANGED,
  TAVERN_EVENTS.APP_READY,
  IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_STARTED,
  IFRAME_EVENTS.MESSAGE_IFRAME_RENDER_ENDED,
  IFRAME_EVENTS.GENERATION_STARTED,
  IFRAME_EVENTS.GENERATION_ENDED,
  IFRAME_EVENTS.STREAM_TOKEN_RECEIVED_FULLY,
  IFRAME_EVENTS.STREAM_TOKEN_RECEIVED_INCREMENTALLY,
  MVU_EVENTS.VARIABLE_INITIALIZED,
  MVU_EVENTS.VARIABLE_UPDATE_STARTED,
  MVU_EVENTS.COMMAND_PARSED,
  MVU_EVENTS.VARIABLE_UPDATE_ENDED,
];

export type TavernEventName = (typeof TAVERN_EVENTS)[keyof typeof TAVERN_EVENTS];
export type IframeEventName = (typeof IFRAME_EVENTS)[keyof typeof IFRAME_EVENTS];
