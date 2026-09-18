/* eslint-disable @typescript-eslint/no-explicit-any --
   引导脚本会被 `Function.prototype.toString()` 取源码注入 iframe：它必须是**自包含**的，
   不能引用模块作用域的任何东西（类型也一样，编译后就没了）。所以这里用 any + 局部
   interface 描述形状，协议侧的类型在 protocol.ts，两边靠 M5 契约 §4 对齐。 */

/**
 * iframe 里的运行时（guest）。见 docs/M5-CONTRACT.md §4.3。
 *
 * 三层：
 *
 * 1. **RPC**：`postMessage` 到 `parent`，带宿主注入的一次性 nonce；同步 API 读镜像。
 * 2. **原生 API** `window.newtavern.*`：Promise 化、类型化（d.ts 在 `types.ts`）。
 * 3. **酒馆助手 shim**：`getChatMessages` / `getVariables` / `eventOn` / `Mvu` 等全局函数，
 *    社区卡直接就能跑。没实现的函数不会是 `undefined`——而是调用时报一条明确的
 *    「新酒馆还不支持 X」，比静默失效好查。
 *
 * 为什么不把它写成独立入口再打包：卡的文档是 `srcdoc`，脚本必须**内联**在文档里
 * （opaque origin 下没法保证外部模块的加载顺序早于卡自己的 `type=module`）。
 * 用 `toString()` 取源码是内联的代价最小的办法，代价是这个函数不能有外部引用。
 */
export function sandboxGuest(): void {
  const scope = window as any;
  const config = scope.__NT_SANDBOX_CONFIG__ ?? {};
  const nonce: string = config.nonce ?? '';
  const frame = config.frame ?? { frameId: 'unknown', kind: 'message', index: 0 };
  const mirrors: Record<string, any> = config.mirrors ?? {};
  const CHANNEL = 'newtavern-sandbox';
  const VERSION = 1;

  /* ---------------------------------------------------------------- */
  /* 存储 polyfill                                                     */
  /* ---------------------------------------------------------------- */

  /**
   * opaque origin 里 `localStorage` / `sessionStorage` **一读就抛** SecurityError。
   * 卡自己未必用它，但它们依赖的库会用（`pinia` 拉进来的 `@vue/devtools-kit` 就是
   * 一上来读 localStorage，一抛异常整个模块脚本就死了）——所以先铺一层内存实现。
   *
   * 内存版的语义差别写在兼容矩阵里：**刷新即丢**。要真持久化的卡请用变量表
   * （`getVariables`/`replaceVariables`），那是跟着聊天存的。
   */
  function installStorage(name: 'localStorage' | 'sessionStorage'): void {
    try {
      // 能读就说明是 legacy-unsafe（有 allow-same-origin），用浏览器自己的
      const existing = (window as unknown as Record<string, Storage | undefined>)[name];
      if (existing) void existing.length;
      return;
    } catch {
      /* 继续铺 polyfill */
    }
    const store = new Map<string, string>();
    const memory = {
      get length() {
        return store.size;
      },
      key: (index: number) => [...store.keys()][index] ?? null,
      // Storage 的下标访问（`storage[0]`）不在这层 polyfill 的范围内
      getItem: (key: string) => (store.has(String(key)) ? (store.get(String(key)) as string) : null),
      setItem: (key: string, value: string) => void store.set(String(key), String(value)),
      removeItem: (key: string) => void store.delete(String(key)),
      clear: () => store.clear(),
    };
    try {
      Object.defineProperty(window, name, { value: memory, configurable: true, writable: false });
    } catch {
      /* 连 defineProperty 都不行就只能算了：卡会看到原来的异常 */
    }
  }

  installStorage('localStorage');
  installStorage('sessionStorage');

  /* ---------------------------------------------------------------- */
  /* RPC                                                              */
  /* ---------------------------------------------------------------- */

  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let sequence = 0;

  function send(payload: any): void {
    parent.postMessage({ channel: CHANNEL, version: VERSION, nonce, frameId: frame.frameId, payload }, '*');
  }

  function call(method: string, params?: any): Promise<any> {
    sequence += 1;
    const id = `${frame.frameId}:${sequence}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ kind: 'request', id, method, params: params ?? null });
    });
  }

  function unsupported(name: string): (...args: any[]) => any {
    return (...args: any[]) => {
      const message = `[新酒馆] 这张卡调用了还不支持的酒馆助手接口：${name}（参数 ${args.length} 个）`;
      forwardLog('warn', [message]);
      throw new Error(message);
    };
  }

  /* ---------------------------------------------------------------- */
  /* 事件总线（酒馆助手语义：同名监听按注册序，支持 makeFirst / makeLast）   */
  /* ---------------------------------------------------------------- */

  const listeners = new Map<string, { fn: (...args: any[]) => any; once: boolean }[]>();

  function listenersOf(event: string): { fn: (...args: any[]) => any; once: boolean }[] {
    let bucket = listeners.get(event);
    if (!bucket) {
      bucket = [];
      listeners.set(event, bucket);
    }
    return bucket;
  }

  function dispatch(event: string, args: any[]): void {
    const bucket = listeners.get(event);
    if (!bucket || bucket.length === 0) return;
    for (const entry of [...bucket]) {
      if (entry.once) {
        const index = bucket.indexOf(entry);
        if (index >= 0) bucket.splice(index, 1);
      }
      try {
        const result = entry.fn(...args);
        if (result && typeof result.then === 'function') {
          (result as Promise<unknown>).catch((error: unknown) => reportError(error));
        }
      } catch (error) {
        reportError(error);
      }
    }
  }

  function reportError(error: unknown): void {
    const value = error as { message?: string; stack?: string };
    send({
      kind: 'error',
      message: value?.message ?? String(error),
      ...(value?.stack ? { stack: value.stack } : {}),
    });
  }

  function forwardLog(level: 'log' | 'info' | 'warn' | 'error', args: any[]): void {
    let safe: any[] = [];
    try {
      // 结构化克隆过不去的东西（DOM 节点、函数）先转字符串
      safe = args.map((arg) => (typeof arg === 'object' || typeof arg === 'function' ? String(arg) : arg));
    } catch {
      safe = ['[无法序列化的日志]'];
    }
    send({ kind: 'log', level, args: safe });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    // 只认宿主：`parent` 之外的来源一律丢（别的 iframe 拿不到 nonce，双保险）
    if (event.source !== parent) return;
    const data = event.data as any;
    if (!data || data.channel !== CHANNEL || data.nonce !== nonce) return;
    const payload = data.payload;
    if (!payload) return;
    if (payload.kind === 'response') {
      const entry = pending.get(payload.id);
      if (!entry) return;
      pending.delete(payload.id);
      if (payload.ok) entry.resolve(payload.result);
      else entry.reject(new Error(payload.error?.message ?? 'RPC 失败'));
      return;
    }
    if (payload.kind === 'event') {
      dispatch(payload.event, payload.args ?? []);
      return;
    }
    if (payload.kind === 'mirror') {
      mirrors[payload.slice] = payload.snapshot;
      if (payload.slice === 'variables') dispatch('newtavern:variables', [payload.snapshot]);
      return;
    }
  });

  /* ---------------------------------------------------------------- */
  /* 镜像读取                                                          */
  /* ---------------------------------------------------------------- */

  function messagesMirror(): any[] {
    const list = mirrors.chatMessages;
    return Array.isArray(list) ? list : [];
  }

  function variablesMirror(): any {
    return mirrors.variables ?? { message: {}, chat: {}, character: {}, global: {}, script: {} };
  }

  function macroMirror(): any {
    return mirrors.macroContext ?? { char: '', user: '', lastMessageId: -1, variables: {} };
  }

  /** 深拷贝：镜像是共享对象，卡拿到的必须是自己的副本（不然改了镜像宿主看不见却以为改了） */
  function clone(value: any): any {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map((item) => clone(item));
    const out: any = {};
    for (const key of Object.keys(value)) out[key] = clone(value[key]);
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* 路径工具（lodash 在，但引导脚本不能假设它一定加载成功）                */
  /* ---------------------------------------------------------------- */

  function toPath(path: string): string[] {
    const segments: string[] = [];
    let current = '';
    let index = 0;
    const push = () => {
      if (current !== '') segments.push(current);
      current = '';
    };
    while (index < path.length) {
      const char = path[index];
      if (char === '.') {
        push();
        index += 1;
      } else if (char === '[') {
        push();
        index += 1;
        const quote = path[index];
        if (quote === '"' || quote === "'") {
          index += 1;
          let literal = '';
          while (index < path.length && path[index] !== quote) {
            literal += path[index];
            index += 1;
          }
          index += 2;
          segments.push(literal);
        } else {
          let literal = '';
          while (index < path.length && path[index] !== ']') {
            literal += path[index];
            index += 1;
          }
          index += 1;
          segments.push(literal.trim());
        }
      } else {
        current += char;
        index += 1;
      }
    }
    push();
    return segments;
  }

  function getPath(target: any, path: string): any {
    let cursor = target;
    for (const segment of toPath(path)) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      cursor = cursor[segment];
    }
    return cursor;
  }

  /* ---------------------------------------------------------------- */
  /* 变量                                                              */
  /* ---------------------------------------------------------------- */

  function variableScope(option: any): string {
    const type = option?.type;
    if (type === 'chat' || type === 'character' || type === 'global' || type === 'script') return type;
    if (type === 'preset') {
      forwardLog('warn', ['[新酒馆] preset 作用域的变量还不支持，读到的是空表']);
      return 'preset';
    }
    return 'message';
  }

  function getVariables(option?: any): any {
    const table = variablesMirror();
    const scope = variableScope(option);
    if (scope === 'message') {
      const id = option?.message_id;
      if (typeof id === 'number' && table.byMessageId) {
        const byId = table.byMessageId[String(resolveMessageId(id))];
        if (byId) return clone(byId);
      }
      return clone(table.message ?? {});
    }
    return clone(table[scope] ?? {});
  }

  function replaceVariables(variables: any, option?: any): any {
    const scope = variableScope(option);
    // 先更新镜像（同步 getter 立刻能读到新值），再异步落库
    const table = variablesMirror();
    if (scope === 'message') {
      table.message = clone(variables);
      table.chat = table.message;
    } else {
      table[scope] = clone(variables);
    }
    void call('variables.replace', {
      scope,
      variables,
      ...(option?.message_id === undefined ? {} : { messageId: resolveMessageId(option.message_id) }),
      ...(option?.script_id === undefined ? {} : { scriptId: option.script_id }),
    }).catch((error: Error) => reportError(error));
    return variables;
  }

  function mergeDeep(target: any, source: any): any {
    for (const key of Object.keys(source ?? {})) {
      const value = source[key];
      if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
        mergeDeep(target[key], value);
      } else {
        target[key] = value;
      }
    }
    return target;
  }

  function insertOrAssignVariables(variables: any, option?: any): any {
    const current = getVariables(option);
    return replaceVariables(mergeDeep(current, variables), option);
  }

  function insertVariables(variables: any, option?: any): any {
    const current = getVariables(option);
    const fill = (target: any, source: any) => {
      for (const key of Object.keys(source ?? {})) {
        if (!(key in target)) target[key] = source[key];
        else if (target[key] && typeof target[key] === 'object' && source[key] && typeof source[key] === 'object') {
          fill(target[key], source[key]);
        }
      }
    };
    fill(current, variables);
    return replaceVariables(current, option);
  }

  function deleteVariable(path: string, option?: any): any {
    const current = getVariables(option);
    const segments = toPath(path);
    const last = segments.pop();
    let cursor = current;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') return { variables: current, delete_occurred: false };
      cursor = cursor[segment];
    }
    if (last === undefined || cursor === null || typeof cursor !== 'object' || !(last in cursor)) {
      return { variables: current, delete_occurred: false };
    }
    if (Array.isArray(cursor)) cursor.splice(Number(last), 1);
    else delete cursor[last];
    replaceVariables(current, option);
    return { variables: current, delete_occurred: true };
  }

  function updateVariablesWith(updater: (variables: any) => any, option?: any): any {
    const current = getVariables(option);
    const result = updater(current);
    if (result && typeof result.then === 'function') {
      return (result as Promise<any>).then((value: any) => replaceVariables(value ?? current, option));
    }
    return replaceVariables(result ?? current, option);
  }

  function getAllVariables(): any {
    const table = variablesMirror();
    const out: any = {};
    mergeDeep(out, clone(table.global ?? {}));
    mergeDeep(out, clone(table.character ?? {}));
    mergeDeep(out, clone(table.script ?? {}));
    mergeDeep(out, clone(table.message ?? {}));
    return out;
  }

  /* ---------------------------------------------------------------- */
  /* 消息                                                              */
  /* ---------------------------------------------------------------- */

  /** 负数 = 深度索引（-1 是最新楼层）；`'latest'` 同 -1 */
  function resolveMessageId(id: any): number {
    const list = messagesMirror();
    const last = list.length > 0 ? (list[list.length - 1].message_id as number) : -1;
    if (id === 'latest' || id === undefined || id === null) return last;
    const value = Number(id);
    if (!Number.isFinite(value)) return last;
    return value < 0 ? last + 1 + value : value;
  }

  function parseRange(range: any): [number, number] {
    const last = resolveMessageId('latest');
    if (typeof range === 'number') {
      const single = resolveMessageId(range);
      return [single, single];
    }
    const text = String(range ?? `0-${last}`);
    const match = /^\s*(-?\d+)\s*-\s*(-?\d+)\s*$/.exec(text);
    if (match) return [resolveMessageId(Number(match[1])), resolveMessageId(Number(match[2]))];
    const single = resolveMessageId(Number(text));
    return [single, single];
  }

  function getChatMessages(range: any, option?: any): any[] {
    const [from, to] = parseRange(range);
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const role = option?.role ?? 'all';
    const hide = option?.hide_state ?? 'all';
    return messagesMirror()
      .filter((message) => message.message_id >= low && message.message_id <= high)
      .filter((message) => role === 'all' || message.role === role)
      .filter((message) =>
        hide === 'all' ? true : hide === 'hidden' ? message.is_hidden : !message.is_hidden,
      )
      .map((message) => {
        const copy = clone(message);
        if (!option?.include_swipes) {
          delete copy.swipes;
          delete copy.swipe_id;
        }
        return copy;
      });
  }

  function setChatMessages(messages: any[], option?: any): Promise<void> {
    return call('chat.set', { messages, option: option ?? {} }).then(() => undefined);
  }

  function createChatMessages(messages: any[], option?: any): Promise<void> {
    return call('chat.create', { messages, option: option ?? {} }).then(() => undefined);
  }

  function deleteChatMessages(messageIds: number[], option?: any): Promise<void> {
    return call('chat.delete', {
      messageIds: (messageIds ?? []).map((id) => resolveMessageId(id)),
      option: option ?? {},
    }).then(() => undefined);
  }

  function getCurrentMessageId(): number {
    if (frame.kind !== 'message' || frame.messageId === null) {
      throw new Error('getCurrentMessageId 只能在楼层消息的前端界面里用');
    }
    return frame.messageId;
  }

  function getLastMessageId(): number {
    return resolveMessageId('latest');
  }

  /* ---------------------------------------------------------------- */
  /* 宏（同步子集）                                                     */
  /* ---------------------------------------------------------------- */

  function substitudeMacros(text: string): string {
    if (typeof text !== 'string' || text === '') return text ?? '';
    const context = macroMirror();
    return text
      .replace(/{{char}}/gi, context.char ?? '')
      .replace(/{{user}}/gi, context.user ?? '')
      .replace(/{{description}}/gi, context.description ?? '')
      .replace(/{{personality}}/gi, context.personality ?? '')
      .replace(/{{scenario}}/gi, context.scenario ?? '')
      .replace(/{{lastMessageId}}/gi, String(context.lastMessageId ?? -1))
      .replace(/{{getvar::([^}]+)}}/gi, (_match: string, name: string) => {
        const value = getPath(context.variables ?? {}, name.trim());
        return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
      })
      .replace(
        /{{get_(message|chat|character|global)_variable::([^}]+)}}/gi,
        (_match: string, type: string, path: string) => {
          const value = getPath(getVariables({ type }), path.trim());
          return value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
        },
      );
  }

  /* ---------------------------------------------------------------- */
  /* 生成                                                              */
  /* ---------------------------------------------------------------- */

  let generationSeq = 0;

  function runGenerate(config: any, mode: 'generate' | 'raw'): Promise<string> {
    generationSeq += 1;
    const generationId = config?.generation_id ?? `${frame.frameId}:gen:${generationSeq}`;
    const known = [
      'user_input',
      'should_stream',
      'max_chat_history',
      'ordered_prompts',
      'generation_id',
      'preset_name',
    ];
    const unsupportedFields = Object.keys(config ?? {}).filter((key) => !known.includes(key));
    return call('generate', {
      mode,
      generationId,
      userInput: config?.user_input,
      shouldStream: config?.should_stream !== false,
      maxChatHistory: config?.max_chat_history,
      orderedPrompts: config?.ordered_prompts,
      unsupported: unsupportedFields,
    }).then((result: any) => String(result?.text ?? ''));
  }

  /* ---------------------------------------------------------------- */
  /* MVU                                                              */
  /* ---------------------------------------------------------------- */

  const mvu = {
    events: {
      VARIABLE_INITIALIZED: 'mag_variable_initiailized',
      VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
      COMMAND_PARSED: 'mag_command_parsed',
      VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
      BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
    },
    getMvuData(option?: any): any {
      const data = getVariables(option ?? { type: 'message' });
      if (!data.stat_data) data.stat_data = {};
      if (!data.initialized_lorebooks) data.initialized_lorebooks = {};
      return data;
    },
    replaceMvuData(data: any, option?: any): Promise<void> {
      replaceVariables(data, option ?? { type: 'message' });
      return Promise.resolve();
    },
    parseMessage(message: string, oldData: any): Promise<any> {
      return call('mvu.parse', { message, data: oldData }).then((result: any) =>
        result?.changed ? result.variables : undefined,
      );
    },
    isDuringExtraAnalysis(): boolean {
      return false;
    },
  };

  /* ---------------------------------------------------------------- */
  /* 提示与日志                                                        */
  /* ---------------------------------------------------------------- */

  function notify(level: string, message: string, title?: string): void {
    void call('notify', { level, message: String(message ?? ''), title: title ?? '' }).catch(() => {
      /* 提示失败不值得再报错 */
    });
  }

  const toastr = {
    success: (message: string, title?: string) => notify('success', message, title),
    info: (message: string, title?: string) => notify('info', message, title),
    warning: (message: string, title?: string) => notify('warning', message, title),
    error: (message: string, title?: string) => notify('error', message, title),
    clear: () => undefined,
    remove: () => undefined,
  };

  function errorCatched<T extends (...args: any[]) => any>(fn: T): T {
    return function wrapped(this: any, ...args: any[]) {
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.then === 'function') {
          return (result as Promise<unknown>).then(undefined, (error: unknown) => {
            reportError(error);
            notify('error', (error as Error)?.message ?? String(error));
            throw error;
          });
        }
        return result;
      } catch (error) {
        reportError(error);
        notify('error', (error as Error)?.message ?? String(error));
        throw error;
      }
    } as unknown as T;
  }

  /* ---------------------------------------------------------------- */
  /* 全局初始化协议（waitGlobalInitialized）                            */
  /* ---------------------------------------------------------------- */

  const globalWaiters = new Map<string, ((value: any) => void)[]>();

  function initializeGlobal(name: string, value: any): void {
    scope[name] = value;
    const waiters = globalWaiters.get(name) ?? [];
    globalWaiters.delete(name);
    for (const resolve of waiters) resolve(value);
  }

  function waitGlobalInitialized(name: string): Promise<any> {
    if (scope[name] !== undefined) return Promise.resolve(scope[name]);
    return new Promise((resolve) => {
      const waiters = globalWaiters.get(name) ?? [];
      waiters.push(resolve);
      globalWaiters.set(name, waiters);
    });
  }

  /* ---------------------------------------------------------------- */
  /* 脚本按钮                                                          */
  /* ---------------------------------------------------------------- */

  function getScriptButtons(): any[] {
    const buttons = mirrors.scriptButtons;
    return Array.isArray(buttons) ? clone(buttons) : [];
  }

  function replaceScriptButtons(buttons: any[]): void {
    mirrors.scriptButtons = clone(buttons);
    void call('script.buttons', { buttons }).catch((error: Error) => reportError(error));
  }

  function updateScriptButtonsWith(updater: (buttons: any[]) => any): any {
    const result = updater(getScriptButtons());
    if (result && typeof result.then === 'function') {
      return (result as Promise<any[]>).then((value) => {
        replaceScriptButtons(value);
        return value;
      });
    }
    replaceScriptButtons(result);
    return result;
  }

  function appendInexistentScriptButtons(buttons: any[]): void {
    const current = getScriptButtons();
    for (const button of buttons ?? []) {
      if (!current.some((item: any) => item.name === button.name)) current.push(button);
    }
    replaceScriptButtons(current);
  }

  /** 按钮事件名：宿主点了按钮就广播这个事件（酒馆助手 `getButtonEvent`） */
  function getButtonEvent(name: string): string {
    return `script_button:${frame.scriptId ?? frame.frameId}:${name}`;
  }

  /* ---------------------------------------------------------------- */
  /* 高度自适应                                                        */
  /* ---------------------------------------------------------------- */

  let lastHeight = -1;
  let heightQueued = false;

  function measureHeight(): number {
    const body = document.body;
    const html = document.documentElement;
    if (!body) return 0;
    return Math.max(
      body.scrollHeight,
      body.offsetHeight,
      html ? html.scrollHeight : 0,
      html ? html.offsetHeight : 0,
    );
  }

  function reportHeight(): void {
    if (heightQueued) return;
    heightQueued = true;
    requestAnimationFrame(() => {
      heightQueued = false;
      const height = measureHeight();
      // 1px 抖动不值得一次 postMessage + 重排
      if (Math.abs(height - lastHeight) < 2) return;
      lastHeight = height;
      send({ kind: 'height', height });
    });
  }

  /* ---------------------------------------------------------------- */
  /* 装配                                                              */
  /* ---------------------------------------------------------------- */

  const tavernEvents = config.tavernEvents ?? {};
  const iframeEvents = config.iframeEvents ?? {};

  function eventOn(event: string, fn: (...args: any[]) => any): any {
    listenersOf(event).push({ fn, once: false });
    return { unsubscribe: () => eventRemoveListener(event, fn) };
  }
  function eventOnce(event: string, fn: (...args: any[]) => any): any {
    listenersOf(event).push({ fn, once: true });
    return { unsubscribe: () => eventRemoveListener(event, fn) };
  }
  function eventMakeFirst(event: string, fn: (...args: any[]) => any): any {
    listenersOf(event).unshift({ fn, once: false });
    return { unsubscribe: () => eventRemoveListener(event, fn) };
  }
  function eventMakeLast(event: string, fn: (...args: any[]) => any): any {
    return eventOn(event, fn);
  }
  function eventRemoveListener(event: string, fn: (...args: any[]) => any): void {
    const bucket = listeners.get(event);
    if (!bucket) return;
    const index = bucket.findIndex((entry) => entry.fn === fn);
    if (index >= 0) bucket.splice(index, 1);
  }
  function eventClearEvent(event: string): void {
    listeners.delete(event);
  }
  function eventClearListener(fn: (...args: any[]) => any): void {
    for (const [event, bucket] of listeners) {
      listeners.set(
        event,
        bucket.filter((entry) => entry.fn !== fn),
      );
    }
  }
  function eventClearAll(): void {
    listeners.clear();
  }
  function eventEmit(event: string, ...args: any[]): Promise<void> {
    // 本帧先处理，再转给宿主广播到别的帧
    dispatch(event, args);
    return call('event.emit', { event, args }).then(() => undefined);
  }
  function eventEmitAndWait(event: string, ...args: any[]): void {
    dispatch(event, args);
    void call('event.emit', { event, args }).catch((error: Error) => reportError(error));
  }

  const lorebook = {
    getLorebookEntries: (name: string) => call('book.entries', { name }),
    replaceLorebookEntries: (name: string, entries: any[]) =>
      call('book.write', { name, mode: 'replace', entries }).then(() => undefined),
    setLorebookEntries: (name: string, entries: any[]) =>
      call('book.write', { name, mode: 'set', entries }).then(() => undefined),
    createLorebookEntries: (name: string, entries: any[]) =>
      call('book.write', { name, mode: 'create', entries }),
    deleteLorebookEntries: (name: string, uids: number[]) =>
      call('book.write', { name, mode: 'delete', uids }),
  };

  const native = {
    version: VERSION,
    frame,
    getMessages: getChatMessages,
    setMessages: setChatMessages,
    createMessages: createChatMessages,
    deleteMessages: deleteChatMessages,
    variables: {
      get: getVariables,
      replace: replaceVariables,
      update: updateVariablesWith,
      all: getAllVariables,
    },
    mvu,
    generate: (config_: any) => runGenerate(config_, 'generate'),
    generateRaw: (config_: any) => runGenerate(config_, 'raw'),
    stopGeneration: (generationId: string) => call('generate.stop', { generationId }),
    slash: (command: string) => call('slash.run', { command }),
    lorebook,
    character: () => clone(mirrors.charData ?? null),
    substituteMacros: substitudeMacros,
    notify,
    on: eventOn,
    once: eventOnce,
    off: eventRemoveListener,
    emit: eventEmit,
    refreshMirrors: () => call('mirror.refresh', {}),
    reload: () => window.location.reload(),
  };

  const helper: Record<string, any> = {
    getChatMessages,
    setChatMessages,
    createChatMessages,
    deleteChatMessages,
    rotateChatMessages: unsupported('rotateChatMessages'),
    getVariables,
    replaceVariables,
    insertOrAssignVariables,
    insertVariables,
    deleteVariable,
    updateVariablesWith,
    getAllVariables,
    registerVariableSchema: () => undefined,
    generate: (config_: any) => runGenerate(config_, 'generate'),
    generateRaw: (config_: any) => runGenerate(config_, 'raw'),
    stopGenerationById: (generationId: string) => call('generate.stop', { generationId }),
    stopAllGeneration: () => call('generate.stop', { generationId: null }),
    eventOn,
    eventOnce,
    eventMakeFirst,
    eventMakeLast,
    eventRemoveListener,
    eventClearEvent,
    eventClearListener,
    eventClearAll,
    eventEmit,
    eventEmitAndWait,
    eventOnButton: (event: string, fn: (...args: any[]) => any) => eventOn(getButtonEvent(event), fn),
    getButtonEvent,
    getScriptButtons,
    replaceScriptButtons,
    updateScriptButtonsWith,
    appendInexistentScriptButtons,
    getScriptId: () => {
      if (!frame.scriptId) throw new Error('getScriptId 只能在脚本里用');
      return frame.scriptId;
    },
    getScriptName: () => frame.scriptName ?? '',
    getScriptInfo: () => '',
    replaceScriptInfo: () => undefined,
    getCharData: () => clone(mirrors.charData ?? null),
    getCurrentMessageId,
    getLastMessageId,
    getMessageId: (name: string) => {
      const match = /TH-message--(\d+)--/.exec(String(name));
      if (!match) throw new Error('getMessageId 只接受楼层界面的标识名');
      return Number(match[1]);
    },
    getIframeName: () =>
      frame.kind === 'script'
        ? `TH-script--${frame.scriptName ?? ''}--${frame.scriptId ?? ''}`
        : `TH-message--${frame.messageId ?? 0}--${frame.index ?? 0}`,
    substitudeMacros,
    substituteMacros: substitudeMacros,
    formatAsTavernRegexedString: (text: string) => {
      forwardLog('warn', ['[新酒馆] formatAsTavernRegexedString 还不支持，原文返回']);
      return text;
    },
    triggerSlash: (command: string) => call('slash.run', { command }),
    reloadIframe: () => window.location.reload(),
    errorCatched,
    initializeGlobal,
    waitGlobalInitialized,
    ...lorebook,
    // 明确报错优于静默失效：这些接口新酒馆暂时没有对应概念
    playAudio: unsupported('playAudio'),
    pauseAudio: unsupported('pauseAudio'),
    getAudioList: unsupported('getAudioList'),
    createCharacter: unsupported('createCharacter'),
    deleteCharacter: unsupported('deleteCharacter'),
    getPreset: unsupported('getPreset'),
    setPreset: unsupported('setPreset'),
    loadPreset: unsupported('loadPreset'),
    installExtension: unsupported('installExtension'),
    injectPrompts: unsupported('injectPrompts'),
    registerMacroLike: unsupported('registerMacroLike'),
  };

  // 全局函数：酒馆助手的卡是直接调 `getChatMessages(...)` 的，必须挂在 window 上
  for (const key of Object.keys(helper)) scope[key] = helper[key];
  scope.TavernHelper = helper;
  scope.tavern_events = tavernEvents;
  scope.iframe_events = iframeEvents;
  scope.toastr = scope.toastr ?? toastr;
  scope.newtavern = native;
  scope.Mvu = mvu;

  /** SillyTavern 上下文：只有能对得上的几项；访问没有的字段会给一条明确警告 */
  const stContext: Record<string, any> = {
    chat: messagesMirror(),
    characters: mirrors.charData ? [mirrors.charData] : [],
    chatId: frame.nodeId ?? '',
    substituteParams: substitudeMacros,
    getContext: () => stContext,
    eventSource: {
      on: eventOn,
      once: eventOnce,
      emit: eventEmit,
      removeListener: eventRemoveListener,
    },
    eventTypes: tavernEvents,
  };
  const warned = new Set<string>();
  scope.SillyTavern = new Proxy(stContext, {
    get(target, property: string) {
      if (property in target) return target[property];
      if (typeof property === 'string' && !warned.has(property)) {
        warned.add(property);
        forwardLog('warn', [`[新酒馆] SillyTavern.${property} 还没有对应实现（返回 undefined）`]);
      }
      return undefined;
    },
  });

  window.addEventListener('error', (event: ErrorEvent) => {
    reportError(event.error ?? new Error(event.message));
  });
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    reportError(event.reason);
  });
  const nativeConsole = { warn: console.warn.bind(console), error: console.error.bind(console) };
  console.warn = (...args: any[]) => {
    nativeConsole.warn(...args);
    forwardLog('warn', args);
  };
  console.error = (...args: any[]) => {
    nativeConsole.error(...args);
    forwardLog('error', args);
  };

  if (typeof ResizeObserver !== 'undefined') {
    const observer = new ResizeObserver(() => reportHeight());
    const attach = () => {
      if (document.documentElement) observer.observe(document.documentElement);
      if (document.body) observer.observe(document.body);
      reportHeight();
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
    else attach();
  }
  window.addEventListener('load', () => reportHeight());
  // 图片、字体加载完会改高度；轮询兜底（`ResizeObserver` 在 opaque origin 里偶发不触发）
  const heightTimer = window.setInterval(() => reportHeight(), 1000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(heightTimer);
    eventClearAll();
  });

  send({ kind: 'ready', version: VERSION });
  dispatch('message_iframe_render_started', [helper.getIframeName()]);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () =>
      dispatch('message_iframe_render_ended', [helper.getIframeName()]),
    );
  } else {
    dispatch('message_iframe_render_ended', [helper.getIframeName()]);
  }
}

/**
 * 引导脚本源码：内联进 `srcdoc` 的 `<script>`。
 *
 * `toString()` 拿的是**编译后**的源码（dev 下是 TS 去类型、构建后是压缩过的），
 * 两种都是合法 JS。前提是 `sandboxGuest` 自包含 —— 所以那个函数里没有任何 import。
 */
export function guestBootstrapSource(): string {
  return `;(${sandboxGuest.toString()})();`;
}
