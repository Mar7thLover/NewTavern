/**
 * 卡自带前端的 CSS 作用域化。
 *
 * 角色卡 / 世界书 / 预设的「正则前端」经常带一整段 `<style>`，里面写的是
 * `.status-bar { … }`、`:root { --x: … }` 这种全局选择器。直接放进页面会污染整个应用，
 * 也会让两张卡互相打架。这里把它们关进消息自己的作用域：
 *
 *   @scope ([data-nt-html="<uid>"]) { …卡的 CSS… }
 *
 * 顺带做三件事：
 * 1. `:root` / `html` / `body` 改写成 `:scope`——卡把变量定义在 `:root` 上是常态，
 *    不改写的话作用域里读不到。
 * 2. `@keyframes` / `@font-face` / `@property` 提到 `@scope` 外面（规范不允许它们待在里面），
 *    动画名加消息前缀，两条消息里的同名动画不会互相覆盖。
 * 3. 丢掉 `@import`（会发网络请求），抹掉 `expression()` / `javascript:` / `-moz-binding`。
 *
 * 纯字符串处理，不依赖 DOM：服务端与测试里都能跑。
 */

/** 一段顶层规则：`prelude` 是 `{` 之前的部分，`body` 为 null 表示是 `@xxx;` 这种语句 */
interface Chunk {
  prelude: string;
  body: string | null;
}

/** 危险声明：现代浏览器其实都不认了，但白名单该有的样子还是要有 */
const UNSAFE_DECLARATION = /expression\s*\(|javascript\s*:|-moz-binding|behaviou?r\s*:/i;

/** 提到 `@scope` 外面的顶层 at-rule */
const HOISTED =
  /^@(?:-webkit-)?(?:keyframes|font-face|property|counter-style|font-feature-values)\b/i;

/** 可以嵌套、内部还是选择器规则的 at-rule */
const CONDITIONAL = /^@(?:media|supports|container|layer|scope|starting-style)\b/i;

/** 直接丢掉的 at-rule */
const DROPPED = /^@(?:import|charset|namespace|document)\b/i;

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface Split {
  chunks: Chunk[];
  /** 最后一条规则之后剩下的、没有分号收尾的声明（`.x{a:1;b:2}` 的 `b:2`） */
  tail: string;
  /** 遇到了没闭合的 `{`：后面的内容全部丢弃 */
  broken: boolean;
}

/**
 * 把 CSS 切成顶层规则。会跳过注释与字符串，所以 `content: "}"` 不会把大括号算错。
 * 没闭合的尾巴直接丢弃——宁可少一条规则，也不要吐出破掉的 CSS 把 `@scope` 撑开。
 */
function splitChunks(css: string): Split {
  const chunks: Chunk[] = [];
  let index = 0;
  let start = 0;

  while (index < css.length) {
    const char = css[index];

    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close === -1 ? css.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(css, index);
      continue;
    }
    if (char === ';') {
      const prelude = css.slice(start, index).trim();
      if (prelude) chunks.push({ prelude, body: null });
      index += 1;
      start = index;
      continue;
    }
    if (char === '{') {
      const close = matchBrace(css, index);
      if (close === -1) return { chunks, tail: '', broken: true }; // 没闭合：后面的全部丢掉
      chunks.push({ prelude: css.slice(start, index).trim(), body: css.slice(index + 1, close) });
      index = close + 1;
      start = index;
      continue;
    }
    index += 1;
  }
  return { chunks, tail: css.slice(start).trim(), broken: false };
}

function skipString(css: string, start: number): number {
  const quote = css[start];
  let index = start + 1;
  while (index < css.length) {
    if (css[index] === '\\') {
      index += 2;
      continue;
    }
    if (css[index] === quote) return index + 1;
    index += 1;
  }
  return css.length;
}

/** `css[open]` 是 `{`，返回配对 `}` 的下标；找不到返回 -1 */
function matchBrace(css: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < css.length) {
    const char = css[index];
    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      index = close === -1 ? css.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(css, index);
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * 选择器里的 `:root` / `html` / `body` → `:scope`。
 * 卡习惯把自定义属性挂在 `:root` 上，`@scope` 里那是够不着的。
 */
function rewriteSelector(selector: string): string {
  return selector.replace(
    /(^|[\s,>+~])(:root|html|body)(?=$|[\s,>+~{:.[#])/gi,
    (_all, lead: string) => `${lead}:scope`,
  );
}

/** 一条条过声明，把危险的整条扔掉 */
function sanitizeDeclarations(body: string): string {
  return body
    .split(';')
    .filter((declaration) => !UNSAFE_DECLARATION.test(declaration))
    .join(';');
}

/** 递归重写：选择器改写 + 声明净化；嵌套的条件规则继续往下走 */
function rewriteBody(css: string): string {
  const { chunks, tail, broken } = splitChunks(css);
  // 整段都是声明（最常见的情况：一条普通规则的 body）
  if (!chunks.some((chunk) => chunk.body !== null)) return sanitizeDeclarations(css);

  const out: string[] = [];
  for (const chunk of chunks) {
    if (chunk.body === null) {
      // CSS 嵌套：规则之间夹着的声明
      if (!DROPPED.test(chunk.prelude) && !UNSAFE_DECLARATION.test(chunk.prelude)) {
        out.push(`${chunk.prelude};`);
      }
      continue;
    }
    if (CONDITIONAL.test(chunk.prelude)) {
      out.push(`${chunk.prelude}{${rewriteBody(chunk.body)}}`);
    } else if (chunk.prelude.startsWith('@')) {
      out.push(`${chunk.prelude}{${chunk.body}}`);
    } else {
      out.push(`${rewriteSelector(chunk.prelude)}{${rewriteBody(chunk.body)}}`);
    }
  }
  if (!broken && tail && !UNSAFE_DECLARATION.test(tail)) out.push(`${tail};`);
  return out.join('');
}

/** `@keyframes fade` / `@keyframes "fade"` → 名字 */
function keyframeName(prelude: string): string | null {
  const match = /^@(?:-webkit-)?keyframes\s+(?:"([^"]+)"|'([^']+)'|([^\s{]+))/i.exec(
    prelude.trim(),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

export interface ScopeCardCssResult {
  css: string;
  /** 被改名的动画（原名 → 新名），便于排错 */
  renamedKeyframes: Record<string, string>;
}

/**
 * 把一段卡自带的 CSS 关进 `[data-nt-html="<uid>"]` 的作用域。
 *
 * `uid` 只允许 `[A-Za-z0-9_-]`，调用方负责规范化（见 `htmlScopeId`）。
 */
export function scopeCardCss(css: string, uid: string): ScopeCardCssResult {
  const renamed: Record<string, string> = {};
  if (!css.trim()) return { css: '', renamedKeyframes: renamed };

  const hoisted: string[] = [];
  const scoped: string[] = [];

  for (const chunk of splitChunks(css).chunks) {
    if (chunk.body === null) {
      if (!DROPPED.test(chunk.prelude) && chunk.prelude) scoped.push(`${chunk.prelude};`);
      continue;
    }
    if (DROPPED.test(chunk.prelude)) continue;

    if (HOISTED.test(chunk.prelude)) {
      const name = keyframeName(chunk.prelude);
      if (name) {
        const next = `nt-${uid}-${name}`;
        renamed[name] = next;
        hoisted.push(`${chunk.prelude.replace(name, next)}{${chunk.body}}`);
      } else {
        hoisted.push(`${chunk.prelude}{${sanitizeDeclarations(chunk.body)}}`);
      }
      continue;
    }
    if (CONDITIONAL.test(chunk.prelude)) {
      scoped.push(`${chunk.prelude}{${rewriteBody(chunk.body)}}`);
      continue;
    }
    if (chunk.prelude.startsWith('@')) {
      scoped.push(`${chunk.prelude}{${chunk.body}}`);
      continue;
    }
    scoped.push(`${rewriteSelector(chunk.prelude)}{${rewriteBody(chunk.body)}}`);
  }

  let body = scoped.join('');
  for (const [from, to] of Object.entries(renamed)) {
    body = body.replace(new RegExp(`(?<![\\w-])${escapeRe(from)}(?![\\w-])`, 'g'), to);
  }

  const parts: string[] = [];
  if (hoisted.length > 0) parts.push(hoisted.join(''));
  if (body.trim()) parts.push(`@scope ([data-nt-html="${uid}"]){${body}}`);
  return { css: parts.join(''), renamedKeyframes: renamed };
}

/** `style="…"` 的净化：整条丢掉危险声明，其余原样 */
export function sanitizeInlineStyle(style: string): string {
  return style
    .split(';')
    .filter((declaration) => declaration.trim() && !UNSAFE_DECLARATION.test(declaration))
    .join(';');
}

/** 任意 id → 能安全塞进属性选择器的作用域名 */
export function htmlScopeId(source: string): string {
  const cleaned = source.replace(/[^A-Za-z0-9_-]/g, '');
  return cleaned || 'msg';
}
