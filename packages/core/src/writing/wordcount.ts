/**
 * 写作字数（M7 契约 §1）：中文按字、英文按词。
 *
 * - CJK 统一表意文字（含扩展区与兼容区）、日文假名、谚文音节：每个字符计 1；
 * - 全角标点与全角字符（`、。，：；！？《》「」` 等 U+3001–U+303F、U+FF01–U+FF60、U+FFE0–U+FFEE）：每个计 1；
 * - 中文里常用、但码位不在全角区的标点（`“ ” ‘ ’ … — ·`）：只有紧挨着 CJK 字符 / 全角标点时才计 1，
 *   这样英文里的弯引号、破折号不会被算成字；
 * - 其余连续的字母 / 数字（可带 `'` `’` `-` 连接，如 don't、well-known）计 1 个词。
 */

const CJK_CHAR =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}、-〿！-｠￠-￮]/u;
const LOOSE_PUNCT = /[“”‘’…—·]/u;
const TOKEN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}、-〿！-｠￠-￮]|(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}])+(?:['’-](?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}])[\p{L}\p{N}\p{M}])+)*|[“”‘’…—·]/gu;

/** `text[start, end)` 两侧（跳过相邻的同类松散标点）是否紧挨 CJK 字符 / 全角标点 */
function touchesCjk(text: string, start: number, end: number): boolean {
  let i = start;
  while (i > 0 && LOOSE_PUNCT.test(text[i - 1] ?? '')) i -= 1;
  // 取前一个完整码点（扩展区汉字是代理对）
  const prev = Array.from(text.slice(Math.max(0, i - 2), i)).pop() ?? '';
  let j = end;
  while (j < text.length && LOOSE_PUNCT.test(text[j] ?? '')) j += 1;
  const next = j < text.length ? String.fromCodePoint(text.codePointAt(j) ?? 0) : '';
  return CJK_CHAR.test(prev) || CJK_CHAR.test(next);
}

export function countWords(text: string): number {
  let count = 0;
  for (const match of text.matchAll(TOKEN)) {
    const token = match[0];
    if (LOOSE_PUNCT.test(token) && token.length === 1) {
      const start = match.index;
      if (touchesCjk(text, start, start + token.length)) count += 1;
      continue;
    }
    count += 1;
  }
  return count;
}
