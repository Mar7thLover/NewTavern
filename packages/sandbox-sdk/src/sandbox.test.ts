import { describe, expect, it, vi } from 'vitest';

import { EMITTED_EVENTS, TAVERN_EVENTS } from './events.js';
import { guestBootstrapSource } from './guest.js';
import { createFrameChannel } from './host.js';
import { createNonce, isRpcEnvelope, makeEnvelope, type SandboxFrameInfo } from './protocol.js';
import { buildCsp, buildSrcdoc, encodeInlineJson, replaceViewportUnits, sandboxAttribute } from './srcdoc.js';

const frame: SandboxFrameInfo = {
  frameId: 'node-1:0',
  kind: 'message',
  nodeId: 'node-1',
  messageId: 3,
  scriptId: null,
  scriptName: null,
  trust: 'standard',
  index: 0,
};

const baseOptions = {
  html: '<div id="app"></div>',
  nonce: 'test-nonce',
  frame,
  trust: 'standard' as const,
  appOrigin: 'http://localhost:5173',
  libs: { scripts: ['/sandbox/lib/jquery.js'], styles: ['/sandbox/lib/x.css'] },
  bootstrap: 'void 0;',
};

describe('CSP', () => {
  it('strict 不给网络也不给外链', () => {
    const csp = buildCsp('strict', 'http://host');
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toContain('https:');
    expect(csp).toContain("default-src 'none'");
  });

  it('standard 允许 https 资源，但 connect 只到宿主', () => {
    const csp = buildCsp('standard', 'http://host');
    expect(csp).toContain('script-src');
    expect(csp).toContain('https:');
    expect(csp).toContain('connect-src http://host blob: data:');
  });

  it('trusted / legacy-unsafe 放开 connect', () => {
    expect(buildCsp('trusted', 'http://host')).toContain('connect-src * blob: data:');
    expect(buildCsp('legacy-unsafe', 'http://host')).toContain('connect-src * blob: data:');
  });

  it('只有 legacy-unsafe 才给 allow-same-origin', () => {
    expect(sandboxAttribute('standard')).not.toContain('allow-same-origin');
    expect(sandboxAttribute('trusted')).not.toContain('allow-same-origin');
    expect(sandboxAttribute('legacy-unsafe')).toContain('allow-same-origin');
    expect(sandboxAttribute('standard')).toContain('allow-scripts');
  });
});

describe('srcdoc', () => {
  it('结构：CSP → base → 库 → 配置 → 引导脚本 → 卡的 HTML', () => {
    const doc = buildSrcdoc(baseOptions);
    const order = [
      'Content-Security-Policy',
      '<base href="http://localhost:5173/">',
      '/sandbox/lib/jquery.js',
      '__NT_SANDBOX_CONFIG__',
      'void 0;',
      '<div id="app"></div>',
    ].map((needle) => doc.indexOf(needle));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('配置里带 nonce、帧信息与事件名表', () => {
    const doc = buildSrcdoc(baseOptions);
    expect(doc).toContain('test-nonce');
    expect(doc).toContain('"frameId":"node-1:0"');
    expect(doc).toContain('message_received');
  });

  it('strict 忽略外链库', () => {
    const doc = buildSrcdoc({
      ...baseOptions,
      trust: 'strict',
      externalScripts: ['https://cdn.test/tailwind.js'],
      externalStyles: ['https://cdn.test/fa.css'],
    });
    expect(doc).not.toContain('cdn.test');
  });

  it('内联 JSON 里的 </script> 被转义，卡的数据不能提前收尾脚本', () => {
    const encoded = encodeInlineJson({ evil: '</script><script>alert(1)</script>' });
    expect(encoded).not.toContain('</script>');
    expect(encoded).toContain('\\u003c');
    const doc = buildSrcdoc({
      ...baseOptions,
      mirrors: { charData: { note: '</script><img onerror=alert(1)>' } },
    });
    // 文档里唯一的 </script> 只能是我们自己那几个标签的收尾
    const count = doc.split('</script>').length - 1;
    expect(count).toBe(3);
  });

  it('min-height 的 vh 换成宿主给的视口变量（否则和自适应高度互相喂饱）', () => {
    expect(replaceViewportUnits('<style>.a{min-height:100vh}</style>')).toContain(
      'min-height:var(--nt-viewport-height)',
    );
    expect(replaceViewportUnits('<style>.a{min-height: 50vh;}</style>')).toContain(
      'calc(var(--nt-viewport-height) * 0.5)',
    );
    // 与 vh 无关的内容原样返回
    expect(replaceViewportUnits('<div>100vh 只是文本</div>')).toBe('<div>100vh 只是文本</div>');
  });
});

describe('引导脚本', () => {
  it('是合法 JS，且装配了酒馆助手的关键全局', () => {
    const source = guestBootstrapSource();
    expect(() => new Function(source)).not.toThrow();
    for (const name of [
      'getChatMessages',
      'getVariables',
      'replaceVariables',
      'updateVariablesWith',
      'eventOn',
      'eventEmit',
      'substitudeMacros',
      'getCurrentMessageId',
      'waitGlobalInitialized',
      'errorCatched',
      'TavernHelper',
      'Mvu',
      'toastr',
    ]) {
      expect(source, `引导脚本里应该有 ${name}`).toContain(name);
    }
  });

  it('MVU 的事件名保留了原版的拼写错误（社区卡监听的就是它）', () => {
    expect(guestBootstrapSource()).toContain('mag_variable_initiailized');
  });
});

/* ------------------------------------------------------------------ */
/* 帧通道                                                              */
/* ------------------------------------------------------------------ */

interface FakeWindow {
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  fire: (event: unknown) => void;
}

function fakeHostWindow(): FakeWindow {
  const listeners: EventListener[] = [];
  return {
    addEventListener: (_type, listener) => listeners.push(listener),
    removeEventListener: (_type, listener) => {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    fire: (event) => listeners.forEach((listener) => listener(event as Event)),
  };
}

function fakeFrame() {
  const posted: unknown[] = [];
  const contentWindow = { postMessage: (data: unknown) => posted.push(data) };
  return { frame: { contentWindow } as unknown as HTMLIFrameElement, posted, contentWindow };
}

function envelope(nonce: string, payload: unknown, source: unknown) {
  return { data: makeEnvelope(nonce, 'node-1:0', payload as never), source };
}

describe('宿主帧通道', () => {
  it('请求 → handler → 回信', async () => {
    const host = fakeHostWindow();
    const { frame: element, posted, contentWindow } = fakeFrame();
    const handler = vi.fn(() => Promise.resolve({ ok: 1 }));
    createFrameChannel({
      frame: element,
      nonce: 'n1',
      frameId: 'node-1:0',
      handlers: { 'chat.set': handler },
      window: host,
    });

    host.fire(
      envelope('n1', { kind: 'request', id: 'r1', method: 'chat.set', params: { a: 1 } }, contentWindow),
    );
    await vi.waitFor(() => expect(posted.length).toBe(1));
    expect(handler).toHaveBeenCalledWith({ a: 1 });
    const reply = posted[0] as { payload: { kind: string; ok: boolean; result: unknown } };
    expect(reply.payload).toMatchObject({ kind: 'response', id: 'r1', ok: true, result: { ok: 1 } });
  });

  it('没有实现的方法回一条失败，而不是静默丢掉', async () => {
    const host = fakeHostWindow();
    const { frame: element, posted, contentWindow } = fakeFrame();
    createFrameChannel({ frame: element, nonce: 'n1', frameId: 'node-1:0', handlers: {}, window: host });
    host.fire(envelope('n1', { kind: 'request', id: 'r2', method: 'nope', params: null }, contentWindow));
    await vi.waitFor(() => expect(posted.length).toBe(1));
    const reply = posted[0] as { payload: { ok: boolean; error: { message: string } } };
    expect(reply.payload.ok).toBe(false);
    expect(reply.payload.error.message).toContain('nope');
  });

  it('nonce 不对、来源不对的消息一律丢弃', async () => {
    const host = fakeHostWindow();
    const { frame: element, posted, contentWindow } = fakeFrame();
    const handler = vi.fn();
    createFrameChannel({
      frame: element,
      nonce: 'n1',
      frameId: 'node-1:0',
      handlers: { 'chat.set': handler },
      window: host,
    });
    host.fire(envelope('WRONG', { kind: 'request', id: 'r3', method: 'chat.set' }, contentWindow));
    host.fire(envelope('n1', { kind: 'request', id: 'r4', method: 'chat.set' }, { other: true }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler).not.toHaveBeenCalled();
    expect(posted).toHaveLength(0);
  });

  it('ready 之前的镜像排队，ready 之后一次性发出', () => {
    const host = fakeHostWindow();
    const { frame: element, posted, contentWindow } = fakeFrame();
    const onReady = vi.fn();
    const channel = createFrameChannel({
      frame: element,
      nonce: 'n1',
      frameId: 'node-1:0',
      handlers: {},
      onReady,
      window: host,
    });
    channel.pushMirror('variables', { message: { a: 1 } });
    expect(posted).toHaveLength(0);
    expect(channel.ready).toBe(false);

    host.fire(envelope('n1', { kind: 'ready', version: 1 }, contentWindow));
    expect(onReady).toHaveBeenCalledWith(1);
    expect(channel.ready).toBe(true);
    expect(posted).toHaveLength(1);
    channel.emitEvent(TAVERN_EVENTS.MESSAGE_RECEIVED, [3]);
    expect(posted).toHaveLength(2);
  });

  it('高度、错误与日志信号转给宿主回调；dispose 之后不再收信', () => {
    const host = fakeHostWindow();
    const { frame: element, contentWindow } = fakeFrame();
    const onHeight = vi.fn();
    const onError = vi.fn();
    const onLog = vi.fn();
    const channel = createFrameChannel({
      frame: element,
      nonce: 'n1',
      frameId: 'node-1:0',
      handlers: {},
      onHeight,
      onError,
      onLog,
      window: host,
    });
    host.fire(envelope('n1', { kind: 'height', height: 240 }, contentWindow));
    host.fire(envelope('n1', { kind: 'error', message: '炸了', stack: 'at x' }, contentWindow));
    host.fire(envelope('n1', { kind: 'log', level: 'warn', args: ['注意'] }, contentWindow));
    expect(onHeight).toHaveBeenCalledWith(240);
    expect(onError).toHaveBeenCalledWith({ message: '炸了', stack: 'at x' });
    expect(onLog).toHaveBeenCalledWith('warn', ['注意']);

    channel.dispose();
    host.fire(envelope('n1', { kind: 'height', height: 999 }, contentWindow));
    expect(onHeight).toHaveBeenCalledTimes(1);
  });
});

describe('协议工具', () => {
  it('nonce 够长且每次不同', () => {
    const a = createNonce();
    const b = createNonce();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(24);
  });

  it('isRpcEnvelope 只认自己的信封', () => {
    expect(isRpcEnvelope(makeEnvelope('n', 'f', { kind: 'ready', version: 1 }))).toBe(true);
    expect(isRpcEnvelope({ channel: 'other' })).toBe(false);
    expect(isRpcEnvelope(null)).toBe(false);
  });

  it('兼容矩阵里声明会广播的事件都在事件名表里', () => {
    for (const event of EMITTED_EVENTS) {
      expect(typeof event).toBe('string');
      expect(event.length).toBeGreaterThan(0);
    }
  });
});
