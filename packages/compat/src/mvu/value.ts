/**
 * MVU 命令里「值」的解析（对齐 MagVarUpdate `parseCommandValue`）。
 *
 * 模型写出来的值什么样都有：`5`、`'早上好'`、`"07:30"`、`{好感度: 5}`、`[1,2,3]`、
 * `10 + 2`、`Math.round(3.6)`、裸字符串 `控制`。解析顺序照抄 MVU，
 * 这样同一条命令在两边得到同一个值：
 *
 * 1. `true` / `false` / `null` / `undefined`
 * 2. `JSON.parse`（标准写法直接过）
 * 3. YAML（宽松写法：单引号、不带引号的键、尾逗号、flow 容器）
 * 4. 算术表达式（`10+2`、`sqrt(16)`、`Math.min(3,5)`）
 * 5. 再试一次 YAML（`07:30` 这类要留成字符串的先在这一步定型）
 * 6. 去掉首尾引号的原样字符串
 *
 * **与 MVU 的唯一差别**：MVU 用 mathjs 求值，我们用自带的小算术求值器
 * （只有数字、四则、`%`、`**`、括号与一张函数白名单）。理由：mathjs 会把
 * `a in b`、单位、矩阵都当表达式，既是 1 MB 依赖也是一片可被模型输出踩到的语义；
 * 变量更新需要的只有「算个数」。认不出就退回字符串，不会报错。
 */

import { parse as parseYaml } from 'yaml';

import { trimQuotes } from './path.js';

/* ------------------------------------------------------------------ */
/* 算术求值（无 eval、无依赖）                                          */
/* ------------------------------------------------------------------ */

type NumberFn = (...args: number[]) => number;

/** 函数白名单：纯函数、结果可复现（`random` 之类不收） */
const FUNCTIONS: Record<string, NumberFn> = {
  abs: Math.abs,
  ceil: Math.ceil,
  cos: Math.cos,
  exp: Math.exp,
  floor: Math.floor,
  log: Math.log,
  log2: Math.log2,
  log10: Math.log10,
  max: Math.max,
  min: Math.min,
  pow: Math.pow,
  round: Math.round,
  sign: Math.sign,
  sin: Math.sin,
  sqrt: Math.sqrt,
  tan: Math.tan,
  trunc: Math.trunc,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, PI: Math.PI, e: Math.E, E: Math.E };

type Token = { type: 'num'; value: number } | { type: 'name'; value: string } | { type: 'op'; value: string };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (/[0-9.]/.test(char)) {
      const match = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(input.slice(index));
      if (!match) return null;
      tokens.push({ type: 'num', value: Number(match[0]) });
      index += match[0].length;
      continue;
    }
    // `Math.sqrt` / `math.pi` 的命名空间前缀直接吃掉，函数名一视同仁
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(input.slice(index));
      if (!match) return null;
      const parts = match[0].split('.');
      if (parts.length > 2) return null;
      if (parts.length === 2 && parts[0] !== 'Math' && parts[0] !== 'math') return null;
      tokens.push({ type: 'name', value: parts[parts.length - 1] as string });
      index += match[0].length;
      continue;
    }
    if (char === '*' && input[index + 1] === '*') {
      tokens.push({ type: 'op', value: '**' });
      index += 2;
      continue;
    }
    if ('+-*/%(),'.includes(char)) {
      tokens.push({ type: 'op', value: char });
      index += 1;
      continue;
    }
    return null;
  }
  return tokens;
}

/** 递归下降：`expr = term (+|- term)*`，`term = unary (*|/|% unary)*`，`unary = (-)? power` */
function evaluateTokens(tokens: readonly Token[]): number | null {
  let position = 0;

  const peek = (): Token | undefined => tokens[position];
  const eat = (value: string): boolean => {
    const token = peek();
    if (token?.type === 'op' && token.value === value) {
      position += 1;
      return true;
    }
    return false;
  };

  const parsePrimary = (): number | null => {
    const token = peek();
    if (!token) return null;
    if (token.type === 'num') {
      position += 1;
      return token.value;
    }
    if (token.type === 'name') {
      position += 1;
      const fn = FUNCTIONS[token.value];
      if (fn) {
        if (!eat('(')) return null;
        const args: number[] = [];
        if (!eat(')')) {
          for (;;) {
            const arg = parseExpression();
            if (arg === null) return null;
            args.push(arg);
            if (eat(',')) continue;
            if (eat(')')) break;
            return null;
          }
        }
        return fn(...args);
      }
      const constant = CONSTANTS[token.value];
      return constant ?? null;
    }
    if (eat('(')) {
      const value = parseExpression();
      if (value === null || !eat(')')) return null;
      return value;
    }
    return null;
  };

  const parseUnary = (): number | null => {
    if (eat('-')) {
      const value = parseUnary();
      return value === null ? null : -value;
    }
    if (eat('+')) return parseUnary();
    const base = parsePrimary();
    if (base === null) return null;
    if (eat('**')) {
      const exponent = parseUnary();
      return exponent === null ? null : base ** exponent;
    }
    return base;
  };

  const parseTerm = (): number | null => {
    let left = parseUnary();
    if (left === null) return null;
    for (;;) {
      if (eat('*')) {
        const right = parseUnary();
        if (right === null) return null;
        left *= right;
      } else if (eat('/')) {
        const right = parseUnary();
        if (right === null) return null;
        left /= right;
      } else if (eat('%')) {
        const right = parseUnary();
        if (right === null) return null;
        left %= right;
      } else {
        return left;
      }
    }
  };

  function parseExpression(): number | null {
    let left = parseTerm();
    if (left === null) return null;
    for (;;) {
      if (eat('+')) {
        const right = parseTerm();
        if (right === null) return null;
        left += right;
      } else if (eat('-')) {
        const right = parseTerm();
        if (right === null) return null;
        left -= right;
      } else {
        return left;
      }
    }
  }

  const result = parseExpression();
  if (result === null || position !== tokens.length || !Number.isFinite(result)) return null;
  return result;
}

/**
 * 日期与时间**不是算术**：`2025-04-10` 按减法算出来是 2011，`07:30` 会被 YAML 读成
 * 60 进制数字。状态栏里这两种恰恰最常见，所以在进求值器之前先拦掉。
 */
const DATE_LIKE = /^\d{1,4}[-/]\d{1,2}(?:[-/]\d{1,4})?$|^\d{1,2}:\d{2}(?::\d{2})?$/;

/** 算出来就返回数字，不是算术就返回 null。单个标识符（`控制`、`sqrt`）一律不算。 */
export function evaluateArithmetic(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed === '' || !/[0-9]/.test(trimmed)) return null;
  if (DATE_LIKE.test(trimmed)) return null;
  // 必须真的有运算符或函数调用，否则交给后面的 YAML / 字符串分支
  if (!/[-+*/%()]/.test(trimmed)) return null;
  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;
  const value = evaluateTokens(tokens);
  if (value === null) return null;
  // 抹掉浮点噪声（MVU 用 toPrecision(12)，保持一致）
  return Number.parseFloat(value.toPrecision(12));
}

/* ------------------------------------------------------------------ */
/* 值解析                                                              */
/* ------------------------------------------------------------------ */

function tryYaml(input: string): { ok: true; value: unknown } | { ok: false } {
  try {
    // 只收标量与容器：YAML 的多文档 / 标签语法在这里没有意义
    return { ok: true, value: parseYaml(input, { merge: false }) as unknown };
  } catch {
    return { ok: false };
  }
}

export function parseCommandValue(raw: string): unknown {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();

  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null') return null;
  if (trimmed === 'undefined') return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // 继续往下
  }

  const relaxed =
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'));
  if (relaxed) {
    const parsed = tryYaml(trimmed);
    if (parsed.ok && typeof parsed.value === 'object' && parsed.value !== null) return parsed.value;
  }

  // 单引号字符串：先让 YAML 按单引号语义拆（`''` 是一个引号）
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    const parsed = tryYaml(trimmed);
    if (parsed.ok && typeof parsed.value === 'string') return parsed.value;
  }

  const arithmetic = evaluateArithmetic(trimmed);
  if (arithmetic !== null) return arithmetic;

  const parsed = tryYaml(trimmed);
  if (parsed.ok) {
    const value = parsed.value;
    // YAML 会把 `07:30` 读成 sexagesimal 数字、把 `2025-04-10` 读成 Date：
    // 这两种在状态栏里都应该保持模型写的字面量
    if (value instanceof Date) return trimmed;
    if (typeof value === 'number' && !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/.test(trimmed)) {
      return trimmed;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return value;
    }
    if (value === null) return trimmed === '~' || trimmed.toLowerCase() === 'null' ? null : trimmed;
    if (typeof value === 'object') return value;
  }

  return trimQuotes(raw);
}
