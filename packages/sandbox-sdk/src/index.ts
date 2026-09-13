/**
 * 前端卡 RPC 协议类型。宿主端与 iframe 端引导脚本在 M5 实现，见 docs/PLAN.md §3.5。
 * 传输：postMessage + 请求 id + 结构化克隆；宿主校验 event.source 与一次性 nonce。
 */

export type FrontendCardTrustLevel = 'strict' | 'standard' | 'trusted' | 'legacy-unsafe';

export interface RpcEnvelope {
  /** srcdoc 注入的一次性 nonce，origin 为 null 时据此鉴权 */
  nonce: string;
  /** 每帧绑定的消息节点 id 与能力集 */
  messageId: string;
  payload: RpcRequest | RpcResponse | RpcEventMessage | RpcMirrorPush;
}

export interface RpcRequest {
  kind: 'request';
  id: string;
  method: string;
  params: unknown;
}

export interface RpcResponse {
  kind: 'response';
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface RpcEventMessage {
  kind: 'event';
  event: string;
  payload: unknown;
}

/** 宿主推入 iframe 的状态镜像（同步 getter 的数据源） */
export interface RpcMirrorPush {
  kind: 'mirror';
  slice: 'chatMessages' | 'variables' | 'charData' | 'macroContext';
  snapshot: unknown;
}
