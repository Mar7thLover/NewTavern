/**
 * 宿主端的帧通道。见 docs/M5-CONTRACT.md §4.4。
 *
 * 一个 iframe 一个通道。通道只管「收信、验身、派发、回信」，具体每个方法做什么由宿主
 * （`apps/web/src/features/cards/useCardHost.ts`）给的 handlers 决定 —— 这一层不碰 React，
 * 也不碰 API 客户端，才能单测。
 *
 * 验身两条（缺一不可）：
 *
 * 1. `event.source === frame.contentWindow`：同一页面里别的 iframe 发来的消息直接丢。
 * 2. `envelope.nonce === nonce`：srcdoc 里注入的一次性随机串。opaque origin 下
 *    `event.origin` 是 `"null"`，它谁都能伪造，所以 origin **不作为**身份依据。
 */

import {
  isRpcEnvelope,
  makeEnvelope,
  PROTOCOL_VERSION,
  type MirrorSlice,
  type RpcEnvelope,
  type RpcFrameSignal,
  type RpcRequest,
} from './protocol.js';

export type RpcHandler = (params: unknown) => unknown | Promise<unknown>;

export interface FrameChannelOptions {
  /** 目标 iframe；`contentWindow` 在挂载后才有，通道内部每次都重新读 */
  frame: HTMLIFrameElement;
  nonce: string;
  frameId: string;
  /** 方法名 → 实现（见 `RPC_METHODS`） */
  handlers: Record<string, RpcHandler>;
  /** guest 引导脚本跑完了 */
  onReady?: (version: number) => void;
  /** 内容高度变化 */
  onHeight?: (height: number) => void;
  /** 卡里的未捕获错误 */
  onError?: (error: { message: string; stack?: string }) => void;
  /** 卡里的 console.warn / console.error */
  onLog?: (level: 'log' | 'info' | 'warn' | 'error', args: unknown[]) => void;
  /** 监听 message 的窗口，默认 `window`（单测里可以塞假的） */
  window?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export interface FrameChannel {
  /** 推一片状态镜像进 iframe（同步 getter 的数据源） */
  pushMirror: (slice: MirrorSlice, snapshot: unknown) => void;
  /** 往 iframe 里广播一个事件（酒馆助手 `eventOn` 收得到） */
  emitEvent: (event: string, args?: unknown[]) => void;
  /** guest 是否已就绪（没就绪时推镜像会排队，就绪后一次性发出） */
  readonly ready: boolean;
  dispose: () => void;
}

/** 通道：一个 iframe 一个 */
export function createFrameChannel(options: FrameChannelOptions): FrameChannel {
  const host = options.window ?? window;
  let ready = false;
  let disposed = false;
  /** guest 就绪前的镜像与事件（首屏镜像走 srcdoc，这里兜住「刚好在加载中」的更新） */
  const queue: RpcEnvelope['payload'][] = [];

  const post = (payload: RpcEnvelope['payload']): void => {
    if (disposed) return;
    const target = options.frame.contentWindow;
    if (!target) return;
    if (!ready && payload.kind !== 'response') {
      queue.push(payload);
      return;
    }
    // opaque origin 的目标只能用 '*'；内容的可信性靠 nonce + source 双向校验
    target.postMessage(makeEnvelope(options.nonce, options.frameId, payload), '*');
  };

  const flush = (): void => {
    const target = options.frame.contentWindow;
    if (!target) return;
    for (const payload of queue.splice(0)) {
      target.postMessage(makeEnvelope(options.nonce, options.frameId, payload), '*');
    }
  };

  const respond = (id: string, ok: boolean, result?: unknown, error?: Error): void => {
    const target = options.frame.contentWindow;
    if (!target) return;
    target.postMessage(
      makeEnvelope(options.nonce, options.frameId, {
        kind: 'response',
        id,
        ok,
        ...(ok ? { result } : {}),
        ...(ok ? {} : { error: { code: 'error', message: error?.message ?? '调用失败' } }),
      }),
      '*',
    );
  };

  const handleRequest = (request: RpcRequest): void => {
    const handler = options.handlers[request.method];
    if (!handler) {
      respond(request.id, false, undefined, new Error(`宿主没有实现方法：${request.method}`));
      return;
    }
    void (async () => {
      try {
        respond(request.id, true, await handler(request.params));
      } catch (error) {
        respond(request.id, false, undefined, error instanceof Error ? error : new Error(String(error)));
      }
    })();
  };

  const handleSignal = (signal: RpcFrameSignal): void => {
    switch (signal.kind) {
      case 'ready':
        ready = true;
        options.onReady?.(signal.version);
        flush();
        break;
      case 'height':
        if (Number.isFinite(signal.height)) options.onHeight?.(signal.height);
        break;
      case 'error':
        options.onError?.({ message: signal.message, ...(signal.stack ? { stack: signal.stack } : {}) });
        break;
      case 'log':
        options.onLog?.(signal.level, signal.args);
        break;
      default:
        break;
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (disposed) return;
    // ① 必须来自这一帧（同页别的 iframe 一律丢）
    if (event.source !== options.frame.contentWindow) return;
    const data: unknown = event.data;
    // ② 必须带对的 nonce（opaque origin 下 event.origin 不可信）
    if (!isRpcEnvelope(data) || data.nonce !== options.nonce) return;
    if (data.version !== PROTOCOL_VERSION) return;
    const payload = data.payload;
    if (payload.kind === 'request') {
      handleRequest(payload);
      return;
    }
    if (payload.kind === 'ready' || payload.kind === 'height' || payload.kind === 'error' || payload.kind === 'log') {
      handleSignal(payload);
    }
  };

  host.addEventListener('message', onMessage as EventListener);

  return {
    pushMirror: (slice, snapshot) => post({ kind: 'mirror', slice, snapshot }),
    emitEvent: (event, args = []) => post({ kind: 'event', event, args }),
    get ready() {
      return ready;
    },
    dispose: () => {
      disposed = true;
      queue.length = 0;
      host.removeEventListener('message', onMessage as EventListener);
    },
  };
}
