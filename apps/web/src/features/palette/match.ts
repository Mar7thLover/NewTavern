/**
 * 命令面板的匹配（M4 §4）：中文按子串匹配，拉丁字母不区分大小写。
 *
 * - 先做 NFKC：输入法打出来的全角字母 / 数字（ＡＢＣ、１２）与半角等同；
 * - 查询按空白切成多个词，每个词都要命中（「设置 外观」）；
 * - 命中名字开头 > 命中名字中间 > 只命中别名（英文名、路径、分类词）。
 */

export function normalizeText(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase();
}

/** 查询 → 词（空查询得到空数组） */
export function queryTokens(query: string): string[] {
  return normalizeText(query)
    .split(/\s+/)
    .filter((token) => token !== '');
}

/**
 * 0 = 不匹配；分数越高越靠前。空查询一律返回 1（保持原顺序）。
 * `keywords` 是不显示出来但也能搜到的别名。
 */
export function matchScore(
  tokens: readonly string[],
  label: string,
  keywords: readonly string[] = [],
): number {
  if (tokens.length === 0) return 1;
  const name = normalizeText(label);
  const aliases = keywords.map(normalizeText);
  let score = 0;
  for (const token of tokens) {
    if (name.startsWith(token)) score += 3;
    else if (name.includes(token)) score += 2;
    else if (aliases.some((alias) => alias.includes(token))) score += 1;
    else return 0;
  }
  return score;
}

export interface Rankable {
  label: string;
  keywords?: readonly string[];
}

/** 过滤并按分数排序（同分保持原顺序），最多取 `limit` 个 */
export function rankItems<T extends Rankable>(
  items: readonly T[],
  tokens: readonly string[],
  limit = Number.POSITIVE_INFINITY,
): T[] {
  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const score = matchScore(tokens, item.label, item.keywords);
    if (score > 0) scored.push({ item, score, order });
  });
  scored.sort((a, b) => b.score - a.score || a.order - b.order);
  return scored.slice(0, limit).map((entry) => entry.item);
}
