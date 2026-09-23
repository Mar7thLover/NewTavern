/**
 * EJS 渲染器：QuickJS（quickjs-emscripten，release-sync 变体）沙箱里跑模板（M5（三）契约 §4.1）。
 *
 * 安全边界：
 * - 模板是社区卡作者写的任意 JS，**只在 QuickJS 里执行**；宿主不 eval、不 new Function、不用 node:vm。
 * - 沙箱里没有 require / import / fetch / 文件；能碰到的只有前奏里定义的函数，
 *   它们全部经一个同步宿主函数 `__hostCall` 走字符串协议。
 * - 一次组装共用一个 runtime + context（前奏只求值一次），同步组装结束后自动释放；
 *   每段模板 interrupt handler 按墙钟截止（缺省 200ms，含其中 getwi 的递归渲染），
 *   内存上限（缺省 32MB）、栈上限（256KB：再大 QuickJS 还没报栈溢出，V8 的原生栈先爆了）。
 *   任何一段失败，沙箱作废重建，不让坏状态带进下一段。
 * - 超时 / 出错：返回原文，经 `ctx.warn` 报告，不中断组装。
 *
 * 引擎（WASM 模块）在本模块加载时用顶层 await 准备好，之后 `createEjsRenderer` / `render` 都是同步的。
 */

import RELEASE_SYNC from '@jitl/quickjs-wasmfile-release-sync';
import type { TemplateRenderer, WIBook } from '@newtavern/core';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

import { CompileCache, EjsSyntaxError, hasEjs } from './compile.js';
import {
  EjsVariableStore,
  findWorldInfoEntry,
  normalizeVarOptions,
  type EjsWiTitle,
} from './host.js';
import { PRELUDE } from './prelude.js';

export type EjsRenderContext = Parameters<TemplateRenderer>[1];

/** 模板里可直接读的上下文值（ST-PT `prepareContext` 的同名字段） */
export interface EjsEnv {
  userName?: string;
  charName?: string;
  assistantName?: string;
  chatId?: string;
  characterId?: string;
  model?: string;
  lastUserMessage?: string;
  lastCharMessage?: string;
  lastUserMessageId?: number;
  lastCharMessageId?: number;
  lastMessageId?: number;
  generateType?: string;
  runType?: string;
}

export interface EjsHost {
  /** 本次组装可见的世界书（`getwi` 的查找范围；含禁用条目） */
  lorebooks: readonly WIBook[];
  env?: EjsEnv;
}

export interface EjsRendererOptions {
  /** 每次顶层渲染的墙钟上限（含递归 getwi），缺省 200 */
  timeoutMs?: number;
  /** 沙箱内存上限，缺省 32 */
  memoryMb?: number;
}

export interface EjsRenderer {
  render(text: string, ctx: EjsRenderContext): string;
  dispose(): void;
  /** 统计（检查器 / 基准用）：渲染次数与累计耗时 */
  readonly stats: { renders: number; totalMs: number; lastMs: number; failures: number };
}

const DEFAULT_TIMEOUT_MS = 200;
const DEFAULT_MEMORY_MB = 32;
const STACK_BYTES = 256 * 1024;
const UNDEF_MARK = '\u0000undefined';

// ───────────────────────── 引擎 ─────────────────────────

const loadStartedAt = performance.now();
const QuickJS: QuickJSWASMModule = await newQuickJSWASMModuleFromVariant(RELEASE_SYNC);
/** WASM 模块加载耗时（冷启动的一部分，报告里记录） */
export const ejsEngineLoadMs = performance.now() - loadStartedAt;

/** 全进程共享的编译缓存（模板文本 → 函数源码，LRU 500） */
export const ejsCompileCache = new CompileCache(500);

// ───────────────────────── 宿主调用协议 ─────────────────────────

function decodeArgs(json: string): unknown[] {
  const parsed = JSON.parse(json, (_key, value: unknown) =>
    value === UNDEF_MARK ? undefined : value,
  ) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}

function encodeResult(value: unknown): string {
  if (value === undefined) return 'u';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? 'u' : `j${json}`;
  } catch (error) {
    return `e${error instanceof Error ? error.message : String(error)}`;
  }
}

function asKey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function asTitle(value: unknown): EjsWiTitle | null {
  if (typeof value === 'string' || typeof value === 'number') return value;
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { regex?: unknown }).regex === 'string'
  ) {
    const { regex, flags } = value as { regex: string; flags?: unknown };
    return { regex, flags: typeof flags === 'string' ? flags : '' };
  }
  return null;
}

function describeTitle(title: EjsWiTitle): string {
  return typeof title === 'object' ? `/${title.regex}/${title.flags}` : String(title);
}

interface RenderSession {
  store: EjsVariableStore;
  ctx: EjsRenderContext;
  host: EjsHost;
}

function dispatch(session: RenderSession, name: string, args: unknown[]): unknown {
  const { store, ctx, host } = session;
  switch (name) {
    case 'getvar':
      return store.get(asKey(args[0]), normalizeVarOptions(args[1]));
    case 'setvar':
      return store.set(asKey(args[0]), args[1], normalizeVarOptions(args[2]));
    case 'incvar': {
      const delta = args[1] === undefined || args[1] === null ? 1 : Number(args[1]);
      return store.increase(String(args[0]), delta, normalizeVarOptions(args[2]));
    }
    case 'delvar':
      return store.remove(String(args[0]), args[1], normalizeVarOptions(args[2]));
    case 'variables':
      return store.merged();
    case 'getwi': {
      const title = asTitle(args[1]);
      if (title === null) throw new Error('getwi 需要条目标题（字符串 / 正则）或 uid');
      const bookName = typeof args[0] === 'string' ? args[0] : null;
      const hit = findWorldInfoEntry(host.lorebooks, bookName, title);
      if (!hit) {
        ctx.warn(
          `EJS：getwi 找不到条目「${describeTitle(title)}」${bookName ? `（书「${bookName}」）` : ''}`,
        );
        return null;
      }
      const raw = hit.entry.content;
      return {
        content: ctx.prepareWorldInfo ? ctx.prepareWorldInfo(raw) : raw,
        comment: hit.entry.comment ?? '',
        uid: hit.entry.uid ?? null,
        world: hit.book.name,
      };
    }
    case 'compile': {
      const text = args[0];
      if (typeof text !== 'string' || !hasEjs(text)) return null;
      return ejsCompileCache.compile(text);
    }
    case 'macros': {
      const text = args[0];
      if (typeof text !== 'string') return text;
      return ctx.substitute ? ctx.substitute(text) : text;
    }
    case 'warn':
      ctx.warn(`EJS：${String(args[0])}`);
      return undefined;
    default:
      throw new Error(`未知的宿主调用 ${name}`);
  }
}

// ───────────────────────── 渲染 ─────────────────────────

interface Outcome {
  ok: boolean;
  text: string;
  error?: string;
}

function readGlobal(context: QuickJSContext, name: string): unknown {
  const handle = context.getProp(context.global, name);
  try {
    return context.dump(handle);
  } finally {
    handle.dispose();
  }
}

/** QuickJS 报的错（沙箱内异常）——与宿主侧异常（如原生栈溢出）区分开 */
class SandboxError extends Error {}

function formatError(detail: unknown): string {
  if (typeof detail === 'object' && detail !== null) {
    const record = detail as { name?: unknown; message?: unknown };
    const name = typeof record.name === 'string' ? `${record.name}: ` : '';
    return `${name}${String(record.message ?? JSON.stringify(detail))}`;
  }
  return String(detail);
}

function evalOrThrow(context: QuickJSContext, code: string): void {
  const result = context.evalCode(code);
  if (result.error) {
    const detail = context.dump(result.error) as unknown;
    result.error.dispose();
    throw new SandboxError(formatError(detail));
  }
  result.value.dispose();
}

/**
 * 一个 QuickJS runtime + context，前奏只求值一次；同一次组装里的各段依次复用它。
 * 任何一段失败（超时、内存、栈、宿主侧异常）后整个沙箱作废，下一段重建。
 */
class Sandbox {
  readonly runtime: QuickJSRuntime;
  readonly context: QuickJSContext;
  /** 当前这一段的宿主会话（宿主函数据此读写变量、查世界书） */
  session: RenderSession | null = null;
  deadline = 0;
  interrupted = false;
  /** 出过宿主侧异常：QuickJS 内部状态可能不完整，释放时可能触发断言，宁可不释放 */
  poisoned = false;

  constructor(env: EjsEnv, options: Required<EjsRendererOptions>) {
    this.runtime = QuickJS.newRuntime();
    this.runtime.setMemoryLimit(options.memoryMb * 1024 * 1024);
    this.runtime.setMaxStackSize(STACK_BYTES);
    this.runtime.setInterruptHandler(() => {
      if (performance.now() > this.deadline) {
        this.interrupted = true;
        return true;
      }
      return false;
    });
    this.context = this.runtime.newContext();
    const ctx = this.context;
    try {
      const hostCall: QuickJSHandle = ctx.newFunction('__hostCall', (nameHandle, argsHandle) => {
        let reply: string;
        try {
          const session = this.session;
          if (!session) throw new Error('没有正在进行的渲染');
          const name = ctx.getString(nameHandle);
          const args = decodeArgs(ctx.getString(argsHandle));
          reply = encodeResult(dispatch(session, name, args));
        } catch (error) {
          reply = `e${error instanceof Error ? error.message : String(error)}`;
        }
        return ctx.newString(reply);
      });
      ctx.setProp(ctx.global, '__hostCall', hostCall);
      hostCall.dispose();
      // 前奏不算进模板的时限，但也不能无限跑
      this.deadline = performance.now() + 1000;
      evalOrThrow(ctx, PRELUDE);
      evalOrThrow(ctx, `__init(${JSON.stringify(env)})`);
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  run(source: string, session: RenderSession, timeoutMs: number): Outcome {
    this.session = session;
    this.deadline = performance.now() + timeoutMs;
    this.interrupted = false;
    const timeout = (): Outcome => ({
      ok: false,
      text: '',
      error: `超时（>${timeoutMs}ms），已中断`,
    });
    try {
      evalOrThrow(this.context, `__render(${JSON.stringify(source)})`);
      // await 全在沙箱里：宿主函数同步返回，跑完 pending jobs 即结束
      while (this.runtime.hasPendingJob()) {
        const jobs = this.runtime.executePendingJobs(-1);
        if (jobs.error) {
          const detail = this.context.dump(jobs.error) as unknown;
          jobs.error.dispose();
          if (this.interrupted) return timeout();
          return { ok: false, text: '', error: formatError(detail) };
        }
      }
      if (this.interrupted) return timeout();
      const done = readGlobal(this.context, '__done');
      const out = readGlobal(this.context, '__out');
      if (done === 1) return { ok: true, text: typeof out === 'string' ? out : String(out) };
      if (done === 2) return { ok: false, text: '', error: String(out) };
      return {
        ok: false,
        text: '',
        error: '模板在等待永远不会完成的 Promise（沙箱里没有定时器与网络）',
      };
    } catch (error) {
      if (!(error instanceof SandboxError)) this.poisoned = true;
      if (this.interrupted) return timeout();
      return { ok: false, text: '', error: error instanceof Error ? error.message : String(error) };
    } finally {
      this.session = null;
    }
  }

  dispose(): void {
    if (this.poisoned) return;
    try {
      this.context.dispose();
      this.runtime.dispose();
    } catch {
      // 中断 / 内存超限后 QuickJS 偶有对象未回收：放弃这个 runtime，不影响后续渲染
    }
  }
}

/**
 * 渲染器：一次组装一个（持有 host）。沙箱在第一次真正需要渲染时创建，
 * 同一轮同步执行里的各段复用；当前同步任务结束后（microtask）自动释放，
 * 所以调用方不必记得 `dispose`（显式调用也可以）。
 */
export function createEjsRenderer(host: EjsHost, opts: EjsRendererOptions = {}): EjsRenderer {
  const options: Required<EjsRendererOptions> = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryMb: opts.memoryMb ?? DEFAULT_MEMORY_MB,
  };
  /** `setvar(…, { scope: 'cache' })` 的临时写入：整个组装期间共享，不落库 */
  const overlay: Record<string, unknown> = {};
  const stats = { renders: 0, totalMs: 0, lastMs: 0, failures: 0 };
  let sandbox: Sandbox | null = null;
  let disposed = false;

  const release = (): void => {
    sandbox?.dispose();
    sandbox = null;
  };

  const acquire = (): Sandbox => {
    if (sandbox) return sandbox;
    sandbox = new Sandbox(host.env ?? {}, options);
    queueMicrotask(release);
    return sandbox;
  };

  const render = (text: string, ctx: EjsRenderContext): string => {
    if (disposed || !hasEjs(text)) return text;
    // 聊天消息：ST-PT 默认（filter_message_enabled）用一条仅提示词正则把 `<% … %>` 整块删掉，不执行
    if (ctx.site === 'history') return text.replace(/<%(?![%])([\s\S]*?)(?<!%)%>/g, '');

    const startedAt = performance.now();
    const where = ctx.ref ?? ctx.site;
    let outcome: Outcome;
    try {
      const source = ejsCompileCache.compile(text);
      const session: RenderSession = {
        store: new EjsVariableStore(ctx.vars, overlay),
        ctx,
        host,
      };
      const box = acquire();
      outcome = box.run(source, session, options.timeoutMs);
      if (!outcome.ok) release();
    } catch (error) {
      release();
      outcome = {
        ok: false,
        text: '',
        error:
          error instanceof EjsSyntaxError || error instanceof Error ? error.message : String(error),
      };
    }

    const elapsed = performance.now() - startedAt;
    stats.renders += 1;
    stats.totalMs += elapsed;
    stats.lastMs = elapsed;
    if (!outcome.ok) {
      stats.failures += 1;
      ctx.warn(`EJS 模板出错（${where}）：${outcome.error ?? '未知错误'}；已保留原文`);
      return text;
    }
    return outcome.text;
  };

  return {
    render,
    dispose() {
      disposed = true;
      release();
    },
    stats,
  };
}

export { hasEjs };
