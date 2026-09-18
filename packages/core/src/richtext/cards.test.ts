import { describe, expect, it } from 'vitest';

import { hasScript, looksLikeCard, splitCardSegments } from './cards.js';

/** 样本形状照本机两张真实社区卡（长夜月 / 黄金庭院）的正则输出写 */
const realCard = [
  '```',
  '<head><script type="module">import{createApp}from"https://cdn/vue";createApp({}).mount("#app")</script><style>.a{color:red}</style></head>',
  '<body><div id="app"></div></body>',
  '```',
].join('\n');

describe('前端卡识别', () => {
  it('围栏里的 HTML 文档 = 一张卡，前后文本照旧', () => {
    const segments = splitCardSegments(`她抬起头。\n\n${realCard}\n\n然后呢？`);
    expect(segments.map((segment) => segment.kind)).toEqual(['text', 'card', 'text']);
    const card = segments[1];
    if (card?.kind !== 'card') throw new Error('第二段应该是卡');
    expect(card.html).toContain('<div id="app">');
    expect(card.raw.startsWith('```')).toBe(true);
    expect(card.index).toBe(0);
  });

  it('一条消息里两张卡各自编号', () => {
    const segments = splitCardSegments(`${realCard}\n\n${realCard}`);
    const cards = segments.filter((segment) => segment.kind === 'card');
    expect(cards).toHaveLength(2);
    expect(cards.map((card) => (card.kind === 'card' ? card.index : -1))).toEqual([0, 1]);
  });

  it('标了语言的代码围栏不是卡（那是代码示例）', () => {
    const code = '```js\nconst app = document.querySelector("#app");\n```';
    expect(splitCardSegments(code).map((segment) => segment.kind)).toEqual(['text']);
    const htmlCode = '```html\n<div class="x">纯标签</div>\n```';
    // 标了 html 但没有文档标签也没有 style：当普通代码块
    expect(splitCardSegments(htmlCode).map((segment) => segment.kind)).toEqual(['text']);
  });

  it('流式中未闭合的围栏也能认出来（卡先出现再补完）', () => {
    const partial = '```\n<body><script>let a=1;';
    const segments = splitCardSegments(partial);
    expect(segments[0]?.kind).toBe('card');
  });

  it('没有围栏但整段带 <script> → 整条当一张卡', () => {
    const segments = splitCardSegments('<div id="p"></div><script>console.log(1)</script>');
    expect(segments).toHaveLength(1);
    expect(segments[0]?.kind).toBe('card');
  });

  it('普通正文与只有标签的 HTML 不进沙箱（走内联渲染那条路）', () => {
    expect(splitCardSegments('她说：“好。”').map((segment) => segment.kind)).toEqual(['text']);
    expect(
      splitCardSegments('<div class="status">好感度 60</div>').map((segment) => segment.kind),
    ).toEqual(['text']);
  });

  it('includeScriptless=false 时，不带脚本的围栏不算卡', () => {
    const styled = '```\n<style>.a{color:red}</style>\n<div class="a">x</div>\n```';
    expect(splitCardSegments(styled).some((segment) => segment.kind === 'card')).toBe(true);
    expect(
      splitCardSegments(styled, { includeScriptless: false }).some(
        (segment) => segment.kind === 'card',
      ),
    ).toBe(false);
  });

  it('hasScript / looksLikeCard', () => {
    expect(hasScript('<script src="x"></script>')).toBe(true);
    expect(hasScript('<div>x</div>')).toBe(false);
    expect(looksLikeCard('<body><p>x</p></body>')).toBe(true);
    expect(looksLikeCard('只是文字')).toBe(false);
  });
});
