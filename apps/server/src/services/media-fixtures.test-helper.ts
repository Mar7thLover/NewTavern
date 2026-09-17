/**
 * 多模态测试用的合成文件（只给测试引用）：最小 PNG / JPEG / WebP / GIF 文件头、带文本的单页 PDF。
 */

/** 2×3 的 PNG 文件头（IHDR 宽高在 16..24 字节；够识别与读尺寸，不是可解码的完整图片） */
export const PNG_2X3 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x08, 0x02, 0x00, 0x00, 0x00, 0x12, 0xf1, 0x59,
  0x3a,
]);

/** 与 PNG_2X3 内容不同的另一张（去重测试用） */
export function pngVariant(seed: number): Uint8Array {
  const bytes = new Uint8Array([...PNG_2X3, seed & 0xff, (seed >> 8) & 0xff]);
  return bytes;
}

/** JPEG：SOI + APP0(JFIF) + SOF0（高 5 宽 7） */
export const JPEG_7X5 = new Uint8Array([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  0x00, 0x01, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x07, 0x03, 0x01, 0x22,
  0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9,
]);

/** GIF89a 9×4 */
export const GIF_9X4 = new Uint8Array([
  0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x09, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x3b,
]);

/** WebP（VP8X 扩展头）画布 640×480 */
export const WEBP_640X480 = (() => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([22, 0, 0, 0], 4);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  bytes.set([10, 0, 0, 0], 16);
  const w = 640 - 1;
  const h = 480 - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
})();

/** 单页、未压缩内容流的 PDF，每个字符串一行（只用 ASCII，Helvetica 无需嵌字体） */
export function makePdf(lines: string[]): Uint8Array {
  const escape = (s: string) => s.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const content = [
    'BT',
    '/F1 18 Tf',
    '72 720 Td',
    ...lines.flatMap((line, i) => [...(i > 0 ? ['0 -24 Td'] : []), `(${escape(line)}) Tj`]),
    'ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}
