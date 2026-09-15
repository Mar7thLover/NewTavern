/**
 * 中文小写数字（回目与竹签用）：1 → 一，12 → 十二，105 → 一百零五。
 * 超过 999 的直接回落成阿拉伯数字（对话里的回目不会走到那么远）。
 */
const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

function digit(n: number): string {
  return DIGITS[n] ?? String(n);
}

export function hanzi(value: number): string {
  if (!Number.isFinite(value) || value < 0) return String(value);
  const n = Math.floor(value);
  if (n < 10) return digit(n);
  if (n < 100) {
    const tens = Math.floor(n / 10);
    const unit = n % 10;
    return `${tens === 1 ? '' : digit(tens)}十${unit === 0 ? '' : digit(unit)}`;
  }
  if (n < 1000) {
    const hundreds = Math.floor(n / 100);
    const rest = n % 100;
    if (rest === 0) return `${digit(hundreds)}百`;
    if (rest < 10) return `${digit(hundreds)}百零${digit(rest)}`;
    // 一百一十二：百位之后的「十」要带「一」
    return `${digit(hundreds)}百${rest < 20 ? '一' : ''}${hanzi(rest)}`;
  }
  return String(n);
}
