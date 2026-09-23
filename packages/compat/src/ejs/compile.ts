/**
 * EJS 模板 → 沙箱里执行的 async 函数源码（ST-Prompt-Template 兼容子集，M5（三）契约 §4.1）。
 *
 * 行为照 ST-Prompt-Template 自带的改版 ejs（`src/3rdparty/ejs.js`，基于 mde/ejs 3.x）：
 * - 标签：`<%` / `<%_`（执行）、`<%=`（输出，**提示词里不转义**——ST-PT 的 `escape` 是恒等函数，
 *   只有楼层渲染才换成 `messageFormatting`）、`<%-`（原样输出）、`<%#`（注释）、
 *   `<%%` / `%%>`（字面量 `<%` / `%>`）；收尾 `%>`、`-%>`（吃掉紧跟的一个换行）、
 *   `_%>`（吃掉后面同一行的空格制表符，再吃一个换行）；`<%_` 吃掉前面同一行的空格制表符。
 * - 改版特有的「嵌套」：标签内部再出现 `<%…%>` 时按层数配对，内层原样并入外层代码。
 * - 代码行里有 `//` 注释却没换行时补一个换行（改版的修补，免得注释吃掉后面拼上去的代码）。
 * - `__append` 丢弃 undefined / null；`print` 是 `__append` 的别名（`outputFunctionName: 'print'`）。
 * - `_with: true`：代码包在 `with (locals) { … }` 里，模板里直接写 `getvar(...)`、`variables.x`。
 *
 * 编译结果只是一段字符串，交给 QuickJS 求值成函数；宿主这边从不执行它。
 */

const TOKEN_RE = /(<%%|%%>|<%=|<%-|<%_|<%#|<%|%>|-%>|_%>)/;

type Mode = 'eval' | 'escaped' | 'raw' | 'comment' | 'literal' | null;

export class EjsSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EjsSyntaxError';
  }
}

/** 快速判断：没有 `<%` 的文本不必进沙箱（ST-PT `evalTemplate` 同样先查开标签） */
export function hasEjs(text: string): boolean {
  return text.includes('<%');
}

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let rest = text;
  let match = TOKEN_RE.exec(rest);
  while (match) {
    if (match.index !== 0) {
      tokens.push(rest.slice(0, match.index));
      rest = rest.slice(match.index);
    }
    tokens.push(match[0]);
    rest = rest.slice(match[0].length);
    match = TOKEN_RE.exec(rest);
  }
  if (rest) tokens.push(rest);
  return tokens;
}

/** 改版 ejs 的嵌套配对：开标签后按层数找到匹配的收尾，中间的 token 原样拼成一段代码 */
function pairNested(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i] as string;
    if (token.startsWith('<%') && token !== '<%%') {
      let level = 1;
      const buffer: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < tokens.length) {
        const inner = tokens[j] as string;
        if (inner.startsWith('<%') && inner !== '<%%') {
          level += 1;
        } else if (inner.endsWith('%>') && inner !== '%%>') {
          level -= 1;
          if (level === 0) {
            out.push(token, buffer.join(''), inner);
            i = j;
            closed = true;
            break;
          }
        }
        buffer.push(inner);
        j += 1;
      }
      if (!closed) throw new EjsSyntaxError(`找不到与「${token}」配对的收尾标签`);
    } else {
      out.push(token);
    }
    i += 1;
  }
  return out;
}

/** mde/ejs `stripSemi`：去掉表达式末尾的分号，免得 `__append(x;)` */
function stripSemi(code: string): string {
  return code.replace(/;(\s*$)/, '$1');
}

/**
 * 编译成函数表达式源码：`(async function (locals, escapeFn) { … })`。
 * 出错时（未闭合标签）抛 `EjsSyntaxError`；JS 语法错误要到沙箱求值时才报。
 */
export function compileEjs(template: string): string {
  const text = template.replace(/[ \t]*<%_/gm, '<%_').replace(/_%>[ \t]*/gm, '_%>');
  const tokens = pairNested(tokenize(text));

  let source = '';
  let mode: Mode = null;
  let truncate = false;
  let line = 1;

  const addOutput = (chunk: string): void => {
    let value = chunk;
    if (truncate) {
      value = value.replace(/^(?:\r\n|\r|\n)/, '');
      truncate = false;
    }
    if (!value) return;
    source += `    ; __append(${JSON.stringify(value)})\n`;
  };

  for (const token of tokens) {
    const newlines = token.split('\n').length - 1;
    switch (token) {
      case '<%':
      case '<%_':
        mode = 'eval';
        break;
      case '<%=':
        mode = 'escaped';
        break;
      case '<%-':
        mode = 'raw';
        break;
      case '<%#':
        mode = 'comment';
        break;
      case '<%%':
        mode = 'literal';
        source += `    ; __append("<%")\n`;
        break;
      case '%%>':
        mode = 'literal';
        source += `    ; __append("%>")\n`;
        break;
      case '%>':
      case '-%>':
      case '_%>':
        if (mode === 'literal') addOutput(token);
        mode = null;
        truncate = token.startsWith('-') || token.startsWith('_');
        break;
      default: {
        if (mode === null) {
          addOutput(token);
          break;
        }
        let code = token;
        if (
          (mode === 'eval' || mode === 'escaped' || mode === 'raw') &&
          code.lastIndexOf('//') > code.lastIndexOf('\n')
        ) {
          code += '\n';
        }
        if (mode === 'eval') source += `    ; ${code}\n`;
        else if (mode === 'escaped') source += `    ; __append(escapeFn(${stripSemi(code)}))\n`;
        else if (mode === 'raw') source += `    ; __append(${stripSemi(code)})\n`;
        else if (mode === 'literal') addOutput(code);
        // comment：什么也不做
        break;
      }
    }
    if (newlines > 0) {
      line += newlines;
      source += `    ; __line = ${line}\n`;
    }
  }

  return [
    '(async function (locals, escapeFn) {',
    '  var __line = 1;',
    '  var __output = "";',
    '  function __append() { for (var i = 0; i < arguments.length; i++) { var s = arguments[i]; if (s !== undefined && s !== null) __output += s; } }',
    '  const print = __append;',
    '  try {',
    '  with (locals || {}) {',
    source,
    '  }',
    '  } catch (e) {',
    '    if (e && typeof e === "object" && !e.__ejsLine) { try { e.__ejsLine = __line; } catch (_) {} }',
    '    throw e;',
    '  }',
    '  return __output;',
    '})',
  ].join('\n');
}

/** 编译缓存：按模板文本缓存源码（LRU，契约 §4.1 500 条） */
export class CompileCache {
  readonly #limit: number;
  readonly #map = new Map<string, string>();
  hits = 0;
  misses = 0;

  constructor(limit = 500) {
    this.#limit = limit;
  }

  get size(): number {
    return this.#map.size;
  }

  compile(template: string): string {
    const cached = this.#map.get(template);
    if (cached !== undefined) {
      // 刷新到最近
      this.#map.delete(template);
      this.#map.set(template, cached);
      this.hits += 1;
      return cached;
    }
    this.misses += 1;
    const source = compileEjs(template);
    this.#map.set(template, source);
    if (this.#map.size > this.#limit) {
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) this.#map.delete(oldest);
    }
    return source;
  }
}
