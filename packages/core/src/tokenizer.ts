/**
 * 分词抽象：精确实现由提供商侧提供（js-tiktoken / Anthropic count_tokens /
 * Gemini countTokens），此处为 UI 预估用的廉价估算。
 * 见 docs/PLAN.md §七-6：预算留余量。
 */

export interface TokenCounter {
  count(text: string): number;
}

/** 粗略估算：CJK 字符按 1 token、其余按约 4 字符 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    if (/[㐀-鿿豈-﫿]/u.test(ch)) cjk += 1;
  }
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export const heuristicTokenizer: TokenCounter = { count: estimateTokens };
