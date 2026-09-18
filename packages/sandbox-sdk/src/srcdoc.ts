/**
 * 前端卡 iframe 的 `srcdoc` 生成。纯函数，可单测。见 docs/M5-CONTRACT.md §4.2。
 *
 * 文档结构（顺序有讲究）：
 *
 * ```html
 * <meta CSP>            信任级别决定它
 * <base href=宿主源>     本地库用相对路径引，`about:srcdoc` 下没有 base 会解析失败
 * <style>重置 + 主题变量</style>
 * <script src=本地库>    jQuery / lodash / Vue / zod / YAML —— 经典脚本，无需 CORS
 * <script>引导脚本</script>  window.newtavern + 酒馆助手 shim + Mvu，必须在卡之前跑完
 * <body>卡自己的 HTML</body>
 * ```
 *
 * 安全边界写在 CSP 与 `sandbox` 属性两处（后者由宿主组件给）：
 * iframe 没有 `allow-same-origin`（`legacy-unsafe` 除外），所以是 opaque origin，
 * 卡拿不到宿主的 DOM、cookie、localStorage；一切能力只能经 RPC 过来。
 */

import { IFRAME_EVENTS, MVU_EVENTS, TAVERN_EVENTS } from './events.js';
import type { FrontendCardTrustLevel, MirrorSlice, SandboxFrameInfo } from './protocol.js';

export interface SrcdocLibs {
  /** 经典脚本（按顺序注入）：本地打包的 jQuery / lodash / Vue / zod / YAML */
  scripts: readonly string[];
  /** 样式表（FontAwesome 之类） */
  styles?: readonly string[];
}

export interface BuildSrcdocOptions {
  /** 卡自己的 HTML（已去掉 Markdown 围栏） */
  html: string;
  nonce: string;
  frame: SandboxFrameInfo;
  trust: FrontendCardTrustLevel;
  /** 宿主页面的 origin（`location.origin`）：CSP 白名单与 `<base>` 都要它 */
  appOrigin: string;
  /** 本地库 */
  libs: SrcdocLibs;
  /**
   * 社区常用外链（FontAwesome / Tailwind / jQuery UI）。
   * `strict` 下一律忽略；其余级别按设置决定给不给。
   */
  externalScripts?: readonly string[];
  externalStyles?: readonly string[];
  /** 主题槽位变量：`--accent` 这些，卡可以拿来贴合当前世界 */
  themeCss?: string;
  /** guest 引导脚本源码（`guestBootstrapSource()`） */
  bootstrap: string;
  /** 首屏镜像，省掉第一帧的空窗 */
  mirrors?: Partial<Record<MirrorSlice, unknown>>;
  /** `.user_avatar` / `.char_avatar` 的背景图（酒馆助手的老约定，卡里常用） */
  avatars?: { user?: string; char?: string };
}

/** JSON 注入内联脚本：`</script>` 与 `<!--` 都要挡掉，否则卡的数据能提前收尾脚本 */
export function encodeInlineJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    // U+2028 / U+2029 是 JS 的行终止符：直接写进正则字面量会让源码语法错，用构造函数绕开
    .replace(new RegExp('[\u2028\u2029]', 'g'), (match) =>
      match.codePointAt(0) === 0x2028 ? '\\u2028' : '\\u2029',
    );
}

function attr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * CSP：四档信任级别。
 *
 * - `strict`：只允许宿主自己的库与内联样式，**没有网络**（`connect-src 'none'`）。
 * - `standard`（默认）：允许 https 的脚本 / 样式 / 图片 / 字体，`connect-src` 只到宿主
 *   （卡要调外部 API 必须走宿主代理，密钥不进卡）。
 * - `trusted`：`connect-src *`，卡可以自己发请求。
 * - `legacy-unsafe`：同 `trusted`，另外由宿主给 `allow-same-origin`（强警告）。
 *
 * `'unsafe-eval'` 一律给：Vue 的模板编译、zod、卡里的 `new Function` 都要它，
 * 而在 opaque origin 里 eval 能碰到的只有卡自己。
 */
export function buildCsp(trust: FrontendCardTrustLevel, appOrigin: string): string {
  const self = appOrigin;
  const https = trust === 'strict' ? '' : ' https:';
  const connect =
    trust === 'strict'
      ? "'none'"
      : trust === 'standard'
        ? `${self} blob: data:`
        : '* blob: data:';
  return [
    `default-src 'none'`,
    `script-src 'unsafe-inline' 'unsafe-eval' ${self} blob:${https}`,
    `style-src 'unsafe-inline' ${self}${https}`,
    `img-src data: blob: ${self}${https}`,
    `media-src data: blob: ${self}${https}`,
    `font-src data: ${self}${https}`,
    `connect-src ${connect}`,
    `frame-src 'none'`,
    `child-src 'none'`,
    `object-src 'none'`,
    `base-uri 'none'`,
    `form-action 'none'`,
  ].join('; ');
}

/**
 * 卡里的 `min-height: 100vh` 换成宿主给的视口高度变量。
 *
 * 为什么必须换：iframe 的 `vh` 是**它自己的**高度，而它的高度又由内容决定 ——
 * `min-height:100vh` 会和自适应高度互相喂饱，长成一条无限长的白条。
 * 这一段照搬酒馆助手 `replaceVhInContent` 的做法（它踩过同一个坑）。
 */
export function replaceViewportUnits(html: string): string {
  const hasCssVh = /min-height\s*:\s*[^;{}]*\d+(?:\.\d+)?vh/i.test(html);
  const hasJsVh =
    /\.style\.minHeight\s*=\s*["'][^"']*vh/i.test(html) ||
    /setProperty\s*\(\s*["']min-height["']\s*,\s*["'][^"']*vh/i.test(html);
  if (!hasCssVh && !hasJsVh) return html;

  const convert = (value: string): string =>
    value.replace(/(\d+(?:\.\d+)?)vh\b/gi, (match, raw: string) => {
      const parsed = Number.parseFloat(raw);
      if (!Number.isFinite(parsed)) return match;
      const expression = 'var(--nt-viewport-height)';
      return parsed === 100 ? expression : `calc(${expression} * ${parsed / 100})`;
    });

  return html
    .replace(
      /(min-height\s*:\s*)([^;{}]*?\d+(?:\.\d+)?vh)(?=\s*[;}"'])/gi,
      (_match, prefix: string, value: string) => `${prefix}${convert(value)}`,
    )
    .replace(
      /(\.style\.minHeight\s*=\s*(["']))([\s\S]*?)(\2)/gi,
      (match, prefix: string, _quote: string, value: string, suffix: string) =>
        /\d+(?:\.\d+)?vh/i.test(value) ? `${prefix}${convert(value)}${suffix}` : match,
    )
    .replace(
      /(setProperty\s*\(\s*(["'])min-height\2\s*,\s*(["']))([\s\S]*?)(\3)/gi,
      (match, prefix: string, _q1: string, _q2: string, value: string, suffix: string) =>
        /\d+(?:\.\d+)?vh/i.test(value) ? `${prefix}${convert(value)}${suffix}` : match,
    );
}

/** 基础重置：与酒馆助手一致（卡都是照它的环境写的） */
const RESET_CSS = [
  '*,*::before,*::after{box-sizing:border-box;}',
  'html,body{margin:0!important;padding:0;max-width:100%!important;overflow-x:hidden;}',
  // 高度自适应由宿主算，body 不能再自己撑出滚动条
  'body{overflow-y:hidden;}',
].join('');

export function buildSrcdoc(options: BuildSrcdocOptions): string {
  const {
    html,
    nonce,
    frame,
    trust,
    appOrigin,
    libs,
    externalScripts = [],
    externalStyles = [],
    themeCss = '',
    bootstrap,
    mirrors = {},
    avatars = {},
  } = options;

  const external = trust === 'strict' ? { scripts: [], styles: [] } : { scripts: externalScripts, styles: externalStyles };
  const styleTags = [...(libs.styles ?? []), ...external.styles]
    .map((href) => `<link rel="stylesheet" href="${attr(href)}">`)
    .join('\n');
  // 库是**经典脚本**：跨源加载不需要 CORS，`about:srcdoc` 下靠 <base> 解析相对路径
  const libTags = [...libs.scripts, ...external.scripts]
    .map((src) => `<script src="${attr(src)}"></script>`)
    .join('\n');

  const avatarCss = [
    avatars.user ? `.user_avatar,.user-avatar{background-image:url('${attr(avatars.user)}')}` : '',
    avatars.char ? `.char_avatar,.char-avatar{background-image:url('${attr(avatars.char)}')}` : '',
  ].join('');

  // 事件名表随配置注入：引导脚本是自包含的，不能 import
  const config = encodeInlineJson({
    nonce,
    frame,
    trust,
    mirrors,
    tavernEvents: TAVERN_EVENTS,
    iframeEvents: IFRAME_EVENTS,
    mvuEvents: MVU_EVENTS,
  });

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${attr(buildCsp(trust, appOrigin))}">
<base href="${attr(appOrigin)}/">
<style>${RESET_CSS}</style>
<style>:root{${themeCss}}${avatarCss}</style>
${styleTags}
${libTags}
<script>window.__NT_SANDBOX_CONFIG__=${config};</script>
<script>${bootstrap}</script>
</head>
<body>
${replaceViewportUnits(html)}
</body>
</html>`;
}

/** `sandbox` 属性：`legacy-unsafe` 才给 `allow-same-origin`（卡能拿 localStorage，但也不再隔离） */
export function sandboxAttribute(trust: FrontendCardTrustLevel): string {
  const base = ['allow-scripts', 'allow-forms', 'allow-modals', 'allow-popups', 'allow-downloads'];
  if (trust === 'legacy-unsafe') base.push('allow-same-origin');
  return base.join(' ');
}
