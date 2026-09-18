import { describe, expect, it } from 'vitest';

import { htmlScopeId, sanitizeInlineStyle, scopeCardCss } from './css.js';

describe('scopeCardCss', () => {
  it('普通规则被关进 @scope', () => {
    const { css } = scopeCardCss('.bar{color:red}', 'm1');
    expect(css).toBe('@scope ([data-nt-html="m1"]){.bar{color:red}}');
  });

  it(':root / html / body 改写成 :scope', () => {
    const { css } = scopeCardCss(':root{--a:1}\nbody .x{color:red}', 'm1');
    expect(css).toContain(':scope{--a:1}');
    expect(css).toContain(':scope .x{');
  });

  it('选择器里的 body 是类名时不误伤', () => {
    const { css } = scopeCardCss('.body-text{color:red}', 'm1');
    expect(css).toContain('.body-text{');
    expect(css).not.toContain(':scope');
  });

  it('@keyframes 提到 @scope 外面并改名，引用一起改', () => {
    const { css, renamedKeyframes } = scopeCardCss(
      '@keyframes fade{from{opacity:0}}\n.x{animation:fade 1s}',
      'm1',
    );
    expect(renamedKeyframes).toEqual({ fade: 'nt-m1-fade' });
    expect(css.startsWith('@keyframes nt-m1-fade{')).toBe(true);
    expect(css).toContain('animation:nt-m1-fade 1s');
  });

  it('@font-face 留在外面', () => {
    const { css } = scopeCardCss('@font-face{font-family:X;src:url(a.woff2)}', 'm1');
    expect(css.startsWith('@font-face{')).toBe(true);
    expect(css).not.toContain('@scope');
  });

  it('@media 里的规则跟着进作用域', () => {
    const { css } = scopeCardCss('@media (max-width:600px){:root{--a:1}}', 'm1');
    expect(css).toContain('@scope ([data-nt-html="m1"]){@media (max-width:600px){:scope{--a:1}}}');
  });

  it('@import 被丢掉', () => {
    const { css } = scopeCardCss('@import url(evil.css);\n.x{color:red}', 'm1');
    expect(css).not.toContain('@import');
    expect(css).toContain('.x{color:red}');
  });

  it('危险声明被摘掉，同一条规则的其余声明保留', () => {
    const { css } = scopeCardCss('.x{color:red;width:expression(alert(1));height:2px}', 'm1');
    expect(css).not.toContain('expression');
    expect(css).toContain('color:red');
    expect(css).toContain('height:2px');
  });

  it('字符串里的大括号不会算错配对', () => {
    const { css } = scopeCardCss('.x::after{content:"}"}\n.y{color:red}', 'm1');
    expect(css).toContain('.y{color:red}');
  });

  it('注释里的大括号不会算错配对', () => {
    const { css } = scopeCardCss('/* { */\n.y{color:red}', 'm1');
    expect(css).toContain('.y{color:red}');
  });

  it('没闭合的尾巴直接丢掉，不会撑开 @scope', () => {
    const { css } = scopeCardCss('.x{color:red}\n.y{color:', 'm1');
    expect(css).toBe('@scope ([data-nt-html="m1"]){.x{color:red}}');
  });

  it('空 CSS 返回空串', () => {
    expect(scopeCardCss('   ', 'm1').css).toBe('');
  });
});

describe('sanitizeInlineStyle', () => {
  it('留下正常声明', () => {
    expect(sanitizeInlineStyle('color:red;font-weight:700')).toBe('color:red;font-weight:700');
  });

  it('摘掉危险声明', () => {
    expect(sanitizeInlineStyle('color:red;background:url(javascript:alert(1))')).toBe('color:red');
  });

  it('丢掉空段', () => {
    expect(sanitizeInlineStyle('color:red;;')).toBe('color:red');
  });
});

describe('htmlScopeId', () => {
  it('只留安全字符', () => {
    expect(htmlScopeId('abc-123_X')).toBe('abc-123_X');
    expect(htmlScopeId('a"]b<c')).toBe('abc');
  });

  it('全被过滤时有兜底', () => {
    expect(htmlScopeId('「」')).toBe('msg');
  });
});
