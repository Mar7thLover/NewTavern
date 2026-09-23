/**
 * 前端卡沙箱的 RPC 协议。见 docs/PLAN.md §3.5、docs/M5-CONTRACT.md §4。
 *
 * 传输：`postMessage` + 请求 id + 结构化克隆。iframe 是 `sandbox` 的（opaque origin），
 * 所以 `event.origin` 永远是 `"null"`、不可作为身份依据；宿主校验两件事：
 *
 * 1. `event.source === frame.contentWindow`（这一帧确实是我建的）；
 * 2. 信封里的 `nonce` 等于 srcdoc 里注入的一次性随机串（别的帧拿不到它）。
 *
 * 同步 API 用**状态镜像**解决：酒馆助手的 `getChatMessages` / `getVariables` /
 * `getCharData` / `substitudeMacros` 都是同步返回的，宿主在相关状态变化时把快照推进
 * iframe，guest 的同步 getter 读镜像；写操作与 `generate` / `triggerSlash` 走异步 RPC。
 */

export type FrontendCardTrustLevel = 'strict' | 'standard' | 'trusted' | 'legacy-unsafe';

export const TRUST_LEVELS: readonly FrontendCardTrustLevel[] = [
  'strict',
  'standard',
  'trusted',
  'legacy-unsafe',
];

/** 协议版本：宿主与 guest 引导脚本一起发版，不匹配时宿主拒绝服务并提示重载 */
export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* 信封                                                                */
/* ------------------------------------------------------------------ */

export interface RpcEnvelope {
  /** 固定标记，用来和页面上别的 postMessage 流量区分 */
  channel: 'newtavern-sandbox';
  version: number;
  /** srcdoc 注入的一次性 nonce，origin 为 null 时据此鉴权 */
  nonce: string;
  /** 每帧绑定的帧 id（消息节点 id + 序号，或脚本 id） */
  frameId: string;
  payload: RpcRequest | RpcResponse | RpcEventMessage | RpcMirrorPush | RpcFrameSignal;
}

export interface RpcRequest {
  kind: 'request';
  id: string;
  method: RpcMethod;
  params: unknown;
}

export interface RpcResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

/** 宿主 → iframe 的事件（酒馆事件总线映射，或 generate 的流式增量） */
export interface RpcEventMessage {
  kind: 'event';
  event: string;
  args: unknown[];
}

/** 宿主推入 iframe 的状态镜像（同步 getter 的数据源） */
export interface RpcMirrorPush {
  kind: 'mirror';
  slice: MirrorSlice;
  snapshot: unknown;
}

/** iframe → 宿主的帧级信号（就绪、高度、未捕获错误、日志） */
export type RpcFrameSignal =
  | { kind: 'ready'; version: number }
  | { kind: 'height'; height: number }
  | { kind: 'error'; message: string; stack?: string }
  | { kind: 'log'; level: 'log' | 'info' | 'warn' | 'error'; args: unknown[] };

export type MirrorSlice =
  | 'chatMessages'
  | 'variables'
  | 'charData'
  | 'macroContext'
  | 'scriptButtons'
  /** 预设：名字列表 + 当前预设（`getPreset` / `getPresetNames` 是同步的，M5（三）§3.2） */
  | 'presets'
  /** 显示侧正则脚本（`formatAsTavernRegexedString` 是同步的） */
  | 'regex'
  /** 主题槽位（`:root{--canvas:…}` 的声明串），切换主题时推，不重建 iframe（§3.4） */
  | 'theme';

/* ------------------------------------------------------------------ */
/* 方法表                                                              */
/* ------------------------------------------------------------------ */

/**
 * 异步 RPC 方法。命名按「领域.动作」，与酒馆助手的函数名一一对应写在注释里，
 * 兼容矩阵在 docs/M5-CONTRACT.md §5。
 */
export const RPC_METHODS = {
  /** setChatMessages */
  chatSet: 'chat.set',
  /** createChatMessages */
  chatCreate: 'chat.create',
  /** deleteChatMessages */
  chatDelete: 'chat.delete',
  /** replaceVariables / insertOrAssignVariables / updateVariablesWith（guest 侧算完再整表替换） */
  variablesReplace: 'variables.replace',
  /** Mvu.parseMessage */
  mvuParse: 'mvu.parse',
  /** Mvu.replaceMvuData（= variablesReplace 的别名，保留独立方法便于审计） */
  mvuReplace: 'mvu.replace',
  /** generate / generateRaw；流式增量走 event 推回 */
  generate: 'generate',
  /** 停止某次 generate */
  generateStop: 'generate.stop',
  /** triggerSlash */
  slash: 'slash.run',
  /** getLorebookEntries */
  bookEntries: 'book.entries',
  /** setLorebookEntries / createLorebookEntries / deleteLorebookEntries */
  bookWrite: 'book.write',
  /** toastr.* */
  notify: 'notify',
  /** replaceScriptButtons / updateScriptButtonsWith */
  scriptButtons: 'script.buttons',
  /** eventEmit：把事件转回宿主总线（再广播给别的帧） */
  eventEmit: 'event.emit',
  /** 主动要一次镜像刷新（卡自己调 reload 之后用） */
  mirrorRefresh: 'mirror.refresh',
  /** registerVariableSchema：guest 已把 zod 转成 JSON Schema（M5（三）§1） */
  variablesRegisterSchema: 'variables.registerSchema',
  /** injectPrompts（M5（三）§3.2） */
  promptsInject: 'prompts.inject',
  /** uninjectPrompts */
  promptsUninject: 'prompts.uninject',
  /** loadPreset：切换会话预设 */
  presetLoad: 'preset.load',
  /** 原生 `newtavern.generateImage`：只生成并存资产，不写消息树（M4（二）§D.3） */
  imageGenerate: 'image.generate',
} as const;

export type RpcMethod = (typeof RPC_METHODS)[keyof typeof RPC_METHODS];

/* ------------------------------------------------------------------ */
/* 载荷                                                                */
/* ------------------------------------------------------------------ */

/** 酒馆助手 `ChatMessage`：message_id 是 root→head 路径上的下标 */
export interface SandboxChatMessage {
  message_id: number;
  name: string;
  role: 'system' | 'assistant' | 'user';
  is_hidden: boolean;
  message: string;
  /** 该楼层的变量快照（酒馆助手的 `data`） */
  data: Record<string, unknown>;
  extra: Record<string, unknown>;
  /** 兄弟消息（swipe）的文本，`include_swipes` 时用 */
  swipes?: string[];
  swipe_id?: number;
  /** 新酒馆特有：节点 id（写操作都按它定位，避免楼层号错位） */
  node_id: string;
}

export interface VariableOption {
  type?: 'message' | 'chat' | 'character' | 'global' | 'script' | 'preset';
  message_id?: number | 'latest';
  script_id?: string;
}

export interface SandboxVariables {
  /** 当前帧所在楼层的快照（MVU 的 stat_data 在这里） */
  message: Record<string, unknown>;
  chat: Record<string, unknown>;
  character: Record<string, unknown>;
  global: Record<string, unknown>;
  script: Record<string, unknown>;
  /** 当前会话预设的变量表（M5（三）§1）；没选预设时是空表 */
  preset?: Record<string, unknown>;
  /** 别的楼层的快照：楼层号 → 快照（宿主按需推，不全量推） */
  byMessageId?: Record<string, Record<string, unknown>>;
}

/** 同步宏替换能用到的上下文（`substitudeMacros` 的子集） */
export interface SandboxMacroContext {
  char: string;
  user: string;
  description: string;
  personality: string;
  scenario: string;
  lastMessageId: number;
  /** 变量宏 `{{getvar::x}}` 读的表（= message 快照） */
  variables: Record<string, unknown>;
}

/** `presets` 镜像：酒馆助手的预设接口是同步的，只能读镜像 */
export interface SandboxPresetsMirror {
  /** 全部预设名（`getPresetNames`） */
  names: string[];
  /** 当前会话在用的预设名（`getLoadedPresetName`）；没选时为 '' */
  loaded: string;
  /** 当前预设换算成酒馆助手 `Preset` 形状（`getPreset('in_use')`）；没选时 null */
  current: Record<string, unknown> | null;
}

/** `regex` 镜像：与显示侧同一套脚本（全局 → 当前预设 → 当前角色卡），字段是 core 的 `RegexScript` */
export interface SandboxRegexMirror {
  scripts: unknown[];
  charName: string;
  userName: string;
}

export interface SandboxScriptButton {
  name: string;
  visible: boolean;
}

/** 前端卡 / 脚本帧的身份与能力 */
export interface SandboxFrameInfo {
  frameId: string;
  kind: 'message' | 'script';
  /** 消息帧：所在节点 id 与楼层号；脚本帧：null */
  nodeId: string | null;
  messageId: number | null;
  /** 脚本帧：脚本 id 与名字 */
  scriptId: string | null;
  scriptName: string | null;
  trust: FrontendCardTrustLevel;
  /** 同一楼层里的第几个界面（酒馆助手 `getIframeName` 用） */
  index: number;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function isRpcEnvelope(value: unknown): value is RpcEnvelope {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record.channel === 'newtavern-sandbox' &&
    typeof record.nonce === 'string' &&
    typeof record.frameId === 'string' &&
    typeof record.payload === 'object' &&
    record.payload !== null
  );
}

export function makeEnvelope(
  nonce: string,
  frameId: string,
  payload: RpcEnvelope['payload'],
): RpcEnvelope {
  return { channel: 'newtavern-sandbox', version: PROTOCOL_VERSION, nonce, frameId, payload };
}

/** 一次性 nonce：128 位随机（宿主生成，注入 srcdoc） */
export function createNonce(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 4; i += 1) {
    out += Math.floor(random() * 0xffffffff)
      .toString(36)
      .padStart(7, '0');
  }
  return out;
}
