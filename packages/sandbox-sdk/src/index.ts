/**
 * 前端卡沙箱 SDK。见 docs/PLAN.md §3.5、docs/M5-CONTRACT.md §4。
 *
 * - `protocol.ts`：RPC 信封、方法表、镜像切片、载荷类型
 * - `events.ts`：酒馆助手 / MVU 事件名表与映射
 * - `srcdoc.ts`：iframe 文档生成（CSP、库、引导脚本）
 * - `host.ts`：宿主端帧通道（验身、派发、推镜像）
 * - `guest.ts`：iframe 里的运行时（原生 API + 酒馆助手 shim + Mvu）
 *
 * 宿主侧的装配（把 handlers 接到真实状态）在 `apps/web/src/features/cards/`。
 */

export * from './events.js';
export * from './guest.js';
export * from './host.js';
export * from './protocol.js';
export * from './srcdoc.js';
