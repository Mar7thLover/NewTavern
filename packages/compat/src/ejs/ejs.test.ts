import type { WIBook, WIEntry } from '@newtavern/core';
import { describe, expect, it } from 'vitest';

import {
  compileEjs,
  CompileCache,
  createEjsRenderer,
  ejsCompileCache,
  ejsEngineLoadMs,
  hasEjs,
  type EjsHost,
  type EjsRenderContext,
} from './index.js';

function entry(
  partial: Partial<WIEntry> & { comment: string; content: string; uid: number },
): WIEntry {
  return {
    id: `book:${partial.uid}`,
    bookId: 'book',
    keys: [],
    secondaryKeys: [],
    constant: false,
    selective: false,
    selectiveLogic: 0,
    position: 0,
    order: 100,
    disabled: false,
    ...partial,
  };
}

function book(name: string, scope: WIBook['scope'], entries: WIEntry[]): WIBook {
  return { id: name, name, scope, entries };
}

function setup(host: Partial<EjsHost> = {}, vars?: EjsRenderContext['vars']) {
  const warnings: string[] = [];
  const renderer = createEjsRenderer({ lorebooks: [], ...host });
  const ctx: EjsRenderContext = {
    site: 'worldinfo',
    vars: vars ?? { chat: {}, global: {} },
    warn: (message) => warnings.push(message),
  };
  return { renderer, ctx, warnings, render: (text: string) => renderer.render(text, ctx) };
}

describe('EJS 语法（ST-Prompt-Template 改版 ejs）', () => {
  it('五种标签与字面量', () => {
    const { render, warnings } = setup();
    expect(render('a<% var x = 1 + 1 %>b<%= x %>c<%- "<i>" %>d<%# 注释 %>e<%% f %%>')).toBe(
      'ab2c<i>de<% f %>',
    );
    expect(warnings).toEqual([]);
  });

  it('<%= 在提示词里不做 HTML 转义（ST-PT 的 escape 是恒等函数）', () => {
    const { render } = setup();
    expect(render('<%= "<b>&" %>')).toBe('<b>&');
  });

  it('undefined / null 不输出', () => {
    const { render } = setup();
    expect(render('[<%= undefined %><%- null %>]')).toBe('[]');
  });

  it('-%> 吃掉紧跟的一个换行', () => {
    const { render } = setup();
    expect(render('<% if (true) { -%>\nyes\n<% } -%>\nend')).toBe('yes\nend');
  });

  it('<%_ 吃前面同行空白，_%> 吃后面同行空白与一个换行', () => {
    const { render } = setup();
    expect(render('line1\n   <%_ var a = 1 _%>   \nline2')).toBe('line1\nline2');
  });

  it('嵌套 if / else 与 for 循环', () => {
    const { render } = setup();
    const tpl = [
      '<%_ for (var i = 0; i < 3; i++) { _%>',
      '<%_ if (i === 0) { _%>',
      'zero',
      '<%_ } else if (i === 1) { _%>',
      'one',
      '<%_ } else { _%>',
      'many',
      '<%_ } _%>',
      '<%_ } _%>',
    ].join('\n');
    expect(render(tpl)).toBe('zero\none\nmany\n');
  });

  it('print 输出、代码行尾 // 注释不吃掉后面的代码', () => {
    const { render } = setup();
    expect(render('<% print("a", "b") // 注释 %>c')).toBe('abc');
  });

  it('标签内嵌套 <% %>（改版 ejs 的层数配对）', () => {
    const source = compileEjs('<% var s = "<%= 1 %>"; %><%- s %>');
    expect(source).toContain('var s = "<%= 1 %>"');
  });

  it('未闭合的标签：编译失败，返回原文并告警', () => {
    const { render, warnings } = setup();
    expect(render('x <% if (true) {')).toBe('x <% if (true) {');
    expect(warnings[0]).toContain('找不到与「<%」配对的收尾标签');
  });

  it('JS 语法错误 / 运行时错误：返回原文并告警（带行号）', () => {
    const { render, warnings } = setup();
    expect(render('<% if ( %>')).toBe('<% if ( %>');
    expect(render('a\nb\n<% null.x %>')).toBe('a\nb\n<% null.x %>');
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain('第 3 行');
  });

  it('hasEjs', () => {
    expect(hasEjs('plain')).toBe(false);
    expect(hasEjs('<%= 1 %>')).toBe(true);
  });

  it('上下文值：userName / charName', () => {
    const { render } = setup({ env: { userName: '开拓者', charName: '昔涟' } });
    expect(render('<%= userName %>和<%= charName %>')).toBe('开拓者和昔涟');
  });
});

describe('变量', () => {
  it('getvar 取点路径与下标；[值, 说明] 二元组原样返回', () => {
    const vars = { chat: { stat_data: { 昔涟: { 好感度: [42, '说明'] } } }, global: { g: 1 } };
    const { render } = setup({}, vars);
    expect(render("<%= getvar('stat_data.昔涟.好感度[0]') %>")).toBe('42');
    expect(render("<%= JSON.stringify(getvar('stat_data.昔涟.好感度')) %>")).toBe('[42,"说明"]');
    expect(render("<%= getvar('missing', { defaults: 7 }) %>")).toBe('7');
    expect(render("<%= getvar('g') %>|<%= getvar('g', { scope: 'local' }) %>")).toBe('1|');
    expect(render('<%= variables.stat_data.昔涟.好感度[0] %>')).toBe('42');
  });

  it('setvar 写进工作副本（写时复制，不改调用方的原对象）', () => {
    const inner = { 好感度: 1 };
    const original = { stat_data: { a: inner } };
    const vars = { chat: { ...original }, global: {} as Record<string, unknown> };
    const { render } = setup({}, vars);
    expect(render("<% setvar('stat_data.a.好感度', 5) %><%= getvar('stat_data.a.好感度') %>")).toBe(
      '5',
    );
    expect(inner.好感度).toBe(1);
    expect((vars.chat.stat_data as { a: { 好感度: number } }).a.好感度).toBe(5);
    render("<% setvar('x', 1, { scope: 'global' }) %>");
    expect(vars.global.x).toBe(1);
  });

  it('incvar / decvar / delvar 与作用域简写', () => {
    const vars = { chat: { n: 1 } as Record<string, unknown>, global: {} };
    const { render } = setup({}, vars);
    expect(render("<%= incvar('n') %>,<%= incvar('n', 5) %>,<%= decvar('n', 2) %>")).toBe('2,7,5');
    render("<% delvar('n') %>");
    expect('n' in vars.chat).toBe(false);
    expect(render("<%= setvar('k', 1, 'nx') %>,<%= setvar('k', 2, 'nx') %>")).toBe('1,');
  });

  it('变量写入后 variables 视图随之刷新', () => {
    const { render } = setup();
    expect(render("<%= variables.a %>|<% setvar('a', 3) %><%= variables.a %>")).toBe('|3');
  });
});

describe('getwi', () => {
  const stageBooks = [
    book('黄金庭院', 'char', [
      entry({ uid: 1, comment: '阶段01', content: '一阶段 {{user}}', disabled: true }),
      entry({ uid: 2, comment: '阶段02', content: '二阶段 <%= getvar("n") %>', disabled: true }),
      entry({ uid: 3, comment: '递归', content: '<%- await getwi(null, "递归") %>' }),
      entry({ uid: 4, comment: '嵌套外', content: '外[<%- await getwi("黄金庭院", "阶段02") %>]' }),
    ]),
    book('全局书', 'global', [entry({ uid: 9, comment: '别处', content: '全局条目' })]),
  ];

  it('按标题找（含禁用条目）、异步渲染、嵌套递归', () => {
    const { renderer, ctx } = setup({ lorebooks: stageBooks }, { chat: { n: 8 }, global: {} });
    const withPrepare: EjsRenderContext = {
      ...ctx,
      prepareWorldInfo: (text) => text.replace('{{user}}', '你'),
    };
    expect(renderer.render("<%- await getwi(null, '阶段01') %>", withPrepare)).toBe('一阶段 你');
    expect(renderer.render("<%- await getwi('阶段02') %>", withPrepare)).toBe('二阶段 8');
    expect(renderer.render("<%- await getwi(null, '嵌套外') %>", withPrepare)).toBe('外[二阶段 8]');
    // 主书找不到时模糊搜其余可见的书
    expect(renderer.render("<%- await getwi(null, '别处') %>", withPrepare)).toBe('全局条目');
    // uid
    expect(renderer.render('<%- await getwi(null, 1) %>', withPrepare)).toBe('一阶段 你');
  });

  it('递归超过 5 层：出错返回原文', () => {
    const { render, warnings } = setup({ lorebooks: stageBooks });
    const text = "<%- await getwi(null, '递归') %>";
    expect(render(text)).toBe(text);
    expect(warnings.join('\n')).toContain('递归超过 5 层');
  });

  it('找不到：返回空串并告警', () => {
    const { render, warnings } = setup({ lorebooks: stageBooks });
    expect(render("[<%- await getwi(null, '不存在') %>]")).toBe('[]');
    expect(warnings[0]).toContain('不存在');
  });
});

describe('安全与资源', () => {
  it('没有 require / process / fetch / 宿主函数', () => {
    const { render } = setup();
    expect(
      render(
        '<%= [typeof require, typeof process, typeof fetch, typeof __hostCall, typeof globalThis.__hostCall].join(",") %>',
      ),
    ).toBe('undefined,undefined,undefined,undefined,undefined');
  });

  it('未实现的 ST-PT 函数：抛错并指出函数名', () => {
    const { render, warnings } = setup();
    expect(render('<%= getchar("x") %>')).toBe('<%= getchar("x") %>');
    expect(warnings[0]).toContain('getchar');
    render('<%= _.debounce %>');
    expect(warnings[1]).toContain('_.debounce');
  });

  it('死循环：200ms 内中断，返回原文并告警', () => {
    const { render, warnings } = setup();
    const started = performance.now();
    expect(render('<% while (true) {} %>')).toBe('<% while (true) {} %>');
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(600);
    expect(warnings[0]).toContain('超时');
    // 中断后引擎仍可用
    expect(render('<%= 1 + 1 %>')).toBe('2');
  });

  it('await 里的死循环同样会被中断', () => {
    const { render, warnings } = setup();
    expect(render('<% await Promise.resolve(); while (true) {} %>x')).toBe(
      '<% await Promise.resolve(); while (true) {} %>x',
    );
    expect(warnings[0]).toContain('超时');
  });

  it('内存上限：超过即失败，返回原文', () => {
    const renderer = createEjsRenderer({ lorebooks: [] }, { memoryMb: 8, timeoutMs: 2000 });
    const warnings: string[] = [];
    const text = '<% var a = []; for (;;) a.push({ i: a.length, s: [1, 2, 3] }); %>';
    expect(
      renderer.render(text, {
        site: 'preset',
        vars: { chat: {}, global: {} },
        warn: (m) => warnings.push(m),
      }),
    ).toBe(text);
    expect(warnings[0]).toMatch(/memory|内存/i);
    expect(
      renderer.render('<%= 3 %>', {
        site: 'preset',
        vars: { chat: {}, global: {} },
        warn: () => {},
      }),
    ).toBe('3');
  });

  it('栈溢出：失败，返回原文', () => {
    const { render, warnings } = setup();
    const text = '<% function f(n) { return f(n + 1) + 1; } f(0) %>';
    expect(render(text)).toBe(text);
    expect(warnings[0]).toMatch(/stack|栈|RangeError|InternalError/i);
  });

  it('永不完成的 Promise：返回原文', () => {
    const { render, warnings } = setup();
    const text = '<% await new Promise(() => {}) %>';
    expect(render(text)).toBe(text);
    expect(warnings[0]).toContain('Promise');
  });

  it('聊天消息：<% … %> 整块删掉，不执行', () => {
    const { renderer, ctx } = setup();
    expect(
      renderer.render("你好<% setvar('x', 1) %>呀<%%字面%>", { ...ctx, site: 'history' }),
    ).toBe('你好呀<%%字面%>');
    expect(ctx.vars.chat).toEqual({});
  });
});

describe('编译缓存', () => {
  it('LRU：命中与淘汰', () => {
    const cache = new CompileCache(2);
    cache.compile('<%= 1 %>');
    cache.compile('<%= 2 %>');
    cache.compile('<%= 1 %>');
    expect(cache.hits).toBe(1);
    cache.compile('<%= 3 %>'); // 淘汰 2
    expect(cache.size).toBe(2);
    cache.compile('<%= 2 %>');
    expect(cache.misses).toBe(4);
  });

  it('同一模板第二次渲染走缓存', () => {
    const { render } = setup();
    const text = `<%= "cache-${Math.random()}" %>`;
    const before = ejsCompileCache.hits;
    render(text);
    render(text);
    expect(ejsCompileCache.hits).toBeGreaterThan(before);
  });
});

describe('耗时（记录用）', () => {
  it('冷启动与热渲染', () => {
    const renderer = createEjsRenderer({ lorebooks: [] });
    const ctx: EjsRenderContext = {
      site: 'preset',
      vars: { chat: { n: 1 }, global: {} },
      warn: () => {},
    };
    const text = "<%_ if (getvar('n') > 0) { _%>yes<%_ } _%>";
    const first = performance.now();
    renderer.render(text, ctx);
    const firstMs = performance.now() - first;
    const loops = 50;
    const hot = performance.now();
    for (let i = 0; i < loops; i += 1) renderer.render(text, ctx);
    const hotMs = (performance.now() - hot) / loops;
    console.info(
      `[ejs] WASM 加载 ${ejsEngineLoadMs.toFixed(1)}ms，首次渲染 ${firstMs.toFixed(2)}ms，热渲染均值 ${hotMs.toFixed(3)}ms`,
    );
    expect(hotMs).toBeLessThan(50);
  });
});
