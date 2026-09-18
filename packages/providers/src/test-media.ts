/**
 * 多模态测试共用的资产夹具（只给 *.test.ts 用，不从 index 导出）。
 */
import type { ResolvedAsset } from './types.js';

/** PNG 文件头 8 字节 */
export const PNG_B64 = 'iVBORw0KGgo=';
/** `%PDF-1.4` 8 字节 */
export const PDF_B64 = 'JVBERi0xLjQ=';
export const TXT_CONTENT = '附件里的设定：月亮是方的。';
export const TXT_B64 = Buffer.from(TXT_CONTENT, 'utf8').toString('base64');

export const ASSETS: Record<string, ResolvedAsset> = {
  img1: { mime: 'image/png', base64: PNG_B64, name: 'a.png' },
  img2: { mime: 'image/jpeg', base64: PNG_B64 },
  doc1: { mime: 'application/pdf', base64: PDF_B64, name: '设定集.pdf' },
  txt1: { mime: 'text/plain', base64: TXT_B64, name: 'notes.txt' },
};

/** 按 ASSETS 解析；不存在的 id 返回 undefined */
export function resolveAsset(assetId: string): ResolvedAsset | undefined {
  return ASSETS[assetId];
}

export const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;
/** img2：mime 是 JPEG（字节仍用 PNG 头，测试只看 data URL 的拼法） */
export const JPEG_DATA_URL = `data:image/jpeg;base64,${PNG_B64}`;
export const PDF_DATA_URL = `data:application/pdf;base64,${PDF_B64}`;
