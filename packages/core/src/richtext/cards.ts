/**
 * 前端卡的识别：把一条消息的正文切成「普通文本」与「要跑脚本的前端卡」两种段。
 * 见 docs/M5-CONTRACT.md §4.1。
 *
 * 社区前端卡实际长什么样（照本机两张真卡核对过）：角色卡的**显示侧正则**把
 * `<StatusPlaceHolderImpl/>` 之类的占位符替换成一整段 HTML，并且**裹在 Markdown 围栏里**：
 *
 * ````text
 * ```
 * <head><script type="module">…Vue 应用…</script><style>…</style></head>
 * <body><div id="app"></div></body>
 * ```
 * ````
 *
 * 所以识别以「围栏 + 内容像 HTML 文档」为主，另外兜一条「没围栏但带 `<script>`」的启发式
 * （ST 那边也有这种卡）。带 `<script>` 的段要进 iframe 沙箱；**不带脚本**的 HTML 继续走
 * M5（一）的内联渲染（净化白名单 + `@scope` CSS），那条路和主题的配合更好。
 *
 * 判定故意收得紧：`js` / `python` 这种明确标了语言的围栏一律不认（那是代码示例，
 * 用户要看的是代码本身），只认不标语言或标了 `html` / `xml` 的。
 */

/** 切出来的段 */
export type CardSegment =
  | { kind: 'text'; text: string }
  | {
      kind: 'card';
      /** 卡的 HTML（已去掉围栏） */
      html: string;
      /** 原文（关掉运行时后按这个渲染，保证「关掉 = 回到以前」） */
      raw: string;
      /** 在这条消息里的序号（同一楼层多个界面时用） */
      index: number;
    };

export interface CardSplitOptions {
  /**
   * 认不带脚本的纯 HTML 文档围栏也算卡（默认 true）。
   * 关掉时只有带 `<script>` 的才进沙箱，其余围栏照旧显示成代码块。
   */
  includeScriptless?: boolean;
}

/**
 * 围栏：``` 或 ~~~，可带语言标记，允许未闭合（流式中卡会先露出半截）。
 * 收尾用 `(?![\s\S])`（真正的文末）而不是 `$` —— 带 `m` 标记时 `$` 是行尾，
 * 非贪婪的正文会在第一行就收工。
 */
const FENCE_RE =
  /^([ \t]*)(`{3,}|~{3,})([^\n`]*)\n([\s\S]*?)(?:\n[ \t]*\2[ \t]*(?=\n|$)|(?![\s\S]))/gm;

/** 只有这些语言标记（或没有标记）才可能是前端卡 */
const CARD_LANGS = new Set(['', 'html', 'htm', 'xml', 'vue', 'svg']);

/** 文档级标签：出现任意一个就当作「这是一份要跑起来的界面」 */
const DOCUMENT_HINT = /<(?:html|head|body|script)\b/i;

/** 没有文档级标签时的兜底：有 `<style>` 且确实有别的元素 */
const STYLED_MARKUP = /<style\b[\s\S]*?<\/style>/i;
const ANY_ELEMENT = /<(?!\/)[a-z][a-z0-9-]*[\s/>]/i;

/** 带脚本 = 必须进沙箱（内联渲染会把 `<script>` 剥掉，卡就成了静态图） */
export function hasScript(html: string): boolean {
  return /<script\b/i.test(html);
}

/** 这段 HTML 像不像一张前端卡 */
export function looksLikeCard(html: string, options: CardSplitOptions = {}): boolean {
  if (html.trim() === '') return false;
  if (hasScript(html)) return true;
  if (options.includeScriptless === false) return false;
  if (DOCUMENT_HINT.test(html)) return true;
  return STYLED_MARKUP.test(html) && ANY_ELEMENT.test(html);
}

/**
 * 切段。没有任何前端卡时返回**单个** text 段（等于原文），调用方可以据此走老路径。
 */
export function splitCardSegments(text: string, options: CardSplitOptions = {}): CardSegment[] {
  if (!text) return [{ kind: 'text', text }];

  const segments: CardSegment[] = [];
  let cursor = 0;
  let index = 0;

  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(text)) !== null) {
    const lang = (match[3] ?? '').trim().toLowerCase();
    const body = match[4] ?? '';
    if (!CARD_LANGS.has(lang) || !looksLikeCard(body, options)) continue;
    if (match.index > cursor) segments.push({ kind: 'text', text: text.slice(cursor, match.index) });
    segments.push({ kind: 'card', html: body, raw: match[0], index: index++ });
    cursor = match.index + match[0].length;
  }

  if (segments.length > 0) {
    if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
    return segments;
  }

  // 没有围栏卡：看看是不是「整段就是一份带脚本的 HTML」
  if (hasScript(text) || /<(?:html|body)\b/i.test(text)) {
    return [{ kind: 'card', html: text, raw: text, index: 0 }];
  }
  return [{ kind: 'text', text }];
}

/** 这条消息里有没有前端卡（渲染前的快速判断，避免白跑一遍切分） */
export function hasCardSegment(text: string, options: CardSplitOptions = {}): boolean {
  return splitCardSegments(text, options).some((segment) => segment.kind === 'card');
}
