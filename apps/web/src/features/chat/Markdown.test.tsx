import { enrichRichText } from '@newtavern/core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { Markdown } from './Markdown';

/**
 * 整条渲染链的端到端检查：识别 → Markdown → rehype-raw → 净化白名单 → CSS 作用域化。
 * 用 `renderToStaticMarkup` 直接吐 HTML，不需要 jsdom。
 */

const labels = {
  think: '思考',
  status: '状态',
  ooc: '场外',
  options: '选项',
  summary: '摘要',
  aside: '旁白',
  data: '变量',
};

/** 走完整链路：正文美化开、卡自带前端开 */
function render(text: string): string {
  return renderToStaticMarkup(
    <Markdown html scopeId="m1">
      {enrichRichText(text, { labels })}
    </Markdown>,
  );
}

/** 只开 Markdown，不解析原生 HTML（两个开关都关掉时的样子） */
function renderPlain(text: string): string {
  return renderToStaticMarkup(<Markdown>{text}</Markdown>);
}

describe('正文块渲染', () => {
  it('状态栏落成结构化的行与数值条', () => {
    const html = render('<status>\n好感度：60/100\n</status>');
    expect(html).toContain('data-nt-block="status"');
    expect(html).toContain('data-nt-part="key"');
    expect(html).toContain('data-nt-part="meter-fill"');
    // 比例作为 CSS 变量留在行上，皮肤拿它画刻度 / 水位 / 糖条
    expect(html).toMatch(/--nt-meter:\s*0\.6/);
  });

  it('思考块的正文仍然吃 Markdown（空行式包装真的生效）', () => {
    const html = render('<thinking>她*犹豫*了一下。</thinking>');
    expect(html).toContain('data-nt-block="think"');
    expect(html).toContain('<em');
    expect(html).toContain('犹豫');
  });

  it('块外面的叙述照旧是段落，引号照旧着色', () => {
    const html = render('她说：“进来吧。”\n\n<status>\n时间：黄昏\n</status>');
    expect(html).toContain('text-ink-quote');
    expect(html).toContain('data-nt-block="status"');
  });

  it('状态栏内部不做引号着色', () => {
    const html = render('<status>\n暗号：“月亮”\n</status>');
    expect(html).toContain('data-nt-block="status"');
    expect(html).not.toContain('text-ink-quote');
  });

  it('选项的序号与正文各自成标记', () => {
    const html = render('<options>\n1. 留下\n2. 离开\n</options>');
    expect(html).toContain('data-nt-marker="1"');
    expect(html).toContain('data-nt-part="option-text"');
  });
});

describe('卡自带的 HTML 前端', () => {
  it('保留 class / style / data-* 与结构', () => {
    const html = render('<div class="panel" style="color:red" data-role="hp">血量</div>');
    expect(html).toContain('class="panel"');
    expect(html).toContain('data-role="hp"');
    expect(html).toContain('color:red');
  });

  it('<style> 的 CSS 被关进本条消息的作用域', () => {
    const html = render('<style>.panel{color:red}</style><div class="panel">x</div>');
    expect(html).toContain('<style>@scope ([data-nt-html="m1"]){.panel{color:red}}</style>');
    // 外层容器带上作用域名，@scope 才有落点
    expect(html).toContain('data-nt-html="m1"');
  });

  it(':root 上的变量改写成 :scope，卡照样读得到', () => {
    const html = render('<style>:root{--hp:red}</style>');
    expect(html).toContain(':scope{--hp:red}');
  });

  it('<script> 连内容一起剥掉', () => {
    const html = render('<div>前</div><script>alert(1)</script><div>后</div>');
    expect(html).not.toContain('alert');
    expect(html).not.toContain('<script');
    expect(html).toContain('前');
    expect(html).toContain('后');
  });

  it('iframe / form 被剥掉', () => {
    const html = render('<iframe src="https://evil.test"></iframe><form action="/x"></form>');
    expect(html).not.toContain('<iframe');
    expect(html).not.toContain('<form');
  });

  it('事件属性与 javascript: 链接不留下', () => {
    const html = render('<a href="javascript:alert(1)" onclick="alert(2)">点</a>');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('点');
  });

  it('行内 style 里的危险声明被摘掉，正常的留下', () => {
    const html = render('<div style="color:red;width:expression(alert(1))">x</div>');
    expect(html).not.toContain('expression');
    expect(html).toContain('color:red');
  });

  it('data: 图片能显示（卡里内嵌 base64 是常态）', () => {
    const html = render('<img src="data:image/png;base64,iVBORw0KGgo=" alt="a">');
    expect(html).toContain('data:image/png;base64');
  });

  it('SVG 图标保留绘制属性', () => {
    const html = render('<svg viewBox="0 0 10 10"><path d="M0 0h10" stroke="red"></path></svg>');
    expect(html).toContain('viewBox="0 0 10 10"');
    expect(html).toContain('d="M0 0h10"');
  });
});

describe('缩进排版过的 HTML（卡 / 预设自带的正则吐出来的那种）', () => {
  /** 外层 div 里夹了空行，后面各层缩进 4 格以上——CommonMark 原本会整段当代码块 */
  const nested = [
    '<div style="margin:10px auto;">',
    '    <div style="height:2px;"></div>',
    '    ',
    '    <details style="background:#1a1625;">',
    '        <summary style="padding:12px;">',
    '            <span style="color:#c084fc;">STORY SYNOPSIS</span>',
    '        </summary>',
    '        ',
    '        <div style="padding:15px;">',
    '            <span style="color:#e2e8f0;">海滨沙滩</span>',
    '        </div>',
    '    </details>',
    '</div>',
  ].join('\n');

  it('照常渲染成 HTML，不会掉进代码块', () => {
    const html = render(nested);
    expect(html).not.toContain('<pre');
    expect(html).not.toContain('&lt;div');
    expect(html).toContain('<details');
    expect(html).toContain('<summary');
    expect(html).toContain('海滨沙滩');
  });

  it('围栏代码块照旧是代码块', () => {
    const html = render('```\n<div>x</div>\n```');
    expect(html).toContain('<pre');
    expect(html).toContain('&lt;div');
  });
});

describe('两个开关都关掉时', () => {
  it('HTML 照旧被转义，不解析', () => {
    const html = renderPlain('<div class="panel">x</div>');
    expect(html).not.toContain('class="panel"');
    expect(html).toContain('&lt;div');
  });

  it('普通 Markdown 不受影响', () => {
    expect(renderPlain('**粗**')).toContain('<strong');
  });
});
