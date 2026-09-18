import { NATIVE_EVENTS, NATIVE_TO_TAVERN } from '@newtavern/sandbox-sdk';

/**
 * 应用内的事件总线。见 docs/M5-CONTRACT.md §4.5。
 *
 * 一处发（生成流程、消息编辑、变量更新），多处收（每个前端卡帧、脚本帧）。
 * 事件名用**新酒馆原生名**（`message:added`），广播给 iframe 时再按
 * `NATIVE_TO_TAVERN` 映射成酒馆助手的名字（`message_received` 等）——
 * 这样应用内部不必背着一张 ST 的历史包袱表。
 *
 * 前端卡自己 `eventEmit` 的事件也会回到这里（宿主再转发给别的帧），
 * 那类事件不做名字映射：卡与卡之间用的是它们自己约定的名字。
 */

export type BusListener = (event: string, args: unknown[]) => void;

const listeners = new Set<BusListener>();

/** 订阅全部事件（帧通道只需要一个订阅者，按 frameId 各自转发） */
export function subscribeBus(listener: BusListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 广播一个原生事件；同时按映射表广播兼容名 */
export function emitNative(event: string, ...args: unknown[]): void {
  deliver(event, args);
  for (const alias of NATIVE_TO_TAVERN[event] ?? []) deliver(alias, args);
}

/** 广播一个兼容名事件（MVU 的 `mag_*`、脚本按钮、卡自己 emit 的） */
export function emitCompat(event: string, ...args: unknown[]): void {
  deliver(event, args);
}

function deliver(event: string, args: unknown[]): void {
  for (const listener of [...listeners]) {
    try {
      listener(event, args);
    } catch (error) {
      console.error('[cards] 事件监听出错', error);
    }
  }
}

export { NATIVE_EVENTS };
