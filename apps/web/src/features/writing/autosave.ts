/**
 * 写作页的自动保存调度（M7 契约 §5.3）：
 *
 * - 输入停下 `debounceMs`（1.5 秒）后保存一次；保存进行中又有改动，结束后接着再存；
 * - 第一次改动起计时，`versionEveryMs`（10 分钟）后若仍有未存版的改动，先保存再存一版；
 * - `flush()` 立即保存（切章节、离开页面、AI 动作前都先 flush，让服务端看到的是最新稿）；
 * - 保存失败保持「脏」，`retryMs` 后自动重试。
 *
 * 与编辑器无关：保存什么由调用方的 `save` 决定（读编辑器最新的不可变文档快照）。
 */

export type AutosaveStatus = 'saved' | 'dirty' | 'saving' | 'error';

export interface AutosaveTimers {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export interface AutosaveOptions {
  save: () => Promise<void>;
  /** 定时存版（在保存成功之后调用） */
  snapshot: () => Promise<unknown>;
  onStatus?: (status: AutosaveStatus) => void;
  debounceMs?: number;
  versionEveryMs?: number;
  retryMs?: number;
  timers?: AutosaveTimers;
}

export const AUTOSAVE_DEBOUNCE_MS = 1500;
export const AUTOSAVE_VERSION_MS = 10 * 60_000;
const RETRY_MS = 5000;

const defaultTimers: AutosaveTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class AutosaveScheduler {
  private readonly opts: Required<Omit<AutosaveOptions, 'onStatus'>> &
    Pick<AutosaveOptions, 'onStatus'>;
  private dirty = false;
  private changedSinceVersion = false;
  private saveTimer: unknown = null;
  private versionTimer: unknown = null;
  private inflight: Promise<void> | null = null;
  private disposed = false;
  private status: AutosaveStatus = 'saved';

  constructor(options: AutosaveOptions) {
    this.opts = {
      debounceMs: AUTOSAVE_DEBOUNCE_MS,
      versionEveryMs: AUTOSAVE_VERSION_MS,
      retryMs: RETRY_MS,
      timers: defaultTimers,
      ...options,
    };
  }

  /** 有未保存的改动，或保存还在路上 */
  get pending(): boolean {
    return this.dirty || this.inflight !== null;
  }

  get currentStatus(): AutosaveStatus {
    return this.status;
  }

  /** 编辑器每次改动时调用 */
  markDirty(): void {
    if (this.disposed) return;
    this.dirty = true;
    this.changedSinceVersion = true;
    this.emit(this.inflight ? 'saving' : 'dirty');
    this.schedule(this.opts.debounceMs);
    if (this.versionTimer === null) {
      this.versionTimer = this.opts.timers.setTimeout(
        () => void this.versionTick(),
        this.opts.versionEveryMs,
      );
    }
  }

  /** 立即保存（等进行中的那次结束后再存最新的）；失败时抛出 */
  async flush(): Promise<void> {
    this.clearSaveTimer();
    while (this.inflight) await this.inflight.catch(() => undefined);
    if (!this.dirty) return;
    this.dirty = false;
    this.emit('saving');
    const run = this.opts.save();
    this.inflight = run;
    try {
      await run;
      this.emit(this.dirty ? 'dirty' : 'saved');
    } catch (error) {
      this.dirty = true;
      this.emit('error');
      throw error;
    } finally {
      if (this.inflight === run) this.inflight = null;
    }
  }

  /** 刚手动 / AI 存过一版：重新计时 */
  noteVersioned(): void {
    this.changedSinceVersion = false;
    if (this.versionTimer !== null) this.opts.timers.clearTimeout(this.versionTimer);
    this.versionTimer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.clearSaveTimer();
    if (this.versionTimer !== null) this.opts.timers.clearTimeout(this.versionTimer);
    this.versionTimer = null;
  }

  private schedule(ms: number): void {
    this.clearSaveTimer();
    this.saveTimer = this.opts.timers.setTimeout(() => {
      this.saveTimer = null;
      this.flush().catch(() => {
        if (!this.disposed) this.schedule(this.opts.retryMs);
      });
    }, ms);
  }

  private clearSaveTimer(): void {
    if (this.saveTimer !== null) this.opts.timers.clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private async versionTick(): Promise<void> {
    this.versionTimer = null;
    if (this.disposed || !this.changedSinceVersion) return;
    try {
      await this.flush();
      this.changedSinceVersion = false;
      await this.opts.snapshot();
    } catch {
      // 保存或存版失败：下次改动时重新计时
      this.changedSinceVersion = true;
    }
  }

  private emit(status: AutosaveStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.opts.onStatus?.(status);
  }
}
