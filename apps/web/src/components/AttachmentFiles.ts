/* ------------------------------------------------------------------ */
/* 能收的文件（M4 契约 §3.3，与服务端判定保持一致）                      */
/* ------------------------------------------------------------------ */

export type AttachmentKind = 'image' | 'pdf' | 'text';

const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'csv',
  'log',
  'yaml',
  'yml',
  'xml',
  'html',
]);

/** 单个附件上限（服务端 413 的界限） */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/** 文件选择框的 accept：扩展名 + mime 都写上，手机相册也能直接选图 */
export const ATTACHMENT_ACCEPT = [
  ...IMAGE_MIMES,
  'application/pdf',
  ...[...IMAGE_EXTS, 'pdf', ...TEXT_EXTS].map((ext) => `.${ext}`),
].join(',');

export function fileExtension(name: string | undefined): string {
  if (!name) return '';
  const dot = name.lastIndexOf('.');
  return dot <= 0 || dot === name.length - 1 ? '' : name.slice(dot + 1).toLowerCase();
}

/** 按 mime / 扩展名判定类别；不收的返回 null（服务端还会按魔数再判一次） */
export function classifyFile(file: Pick<File, 'name' | 'type'>): AttachmentKind | null {
  const ext = fileExtension(file.name);
  const mime = file.type.toLowerCase();
  if (IMAGE_MIMES.has(mime) || IMAGE_EXTS.has(ext)) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (TEXT_EXTS.has(ext)) return 'text';
  return null;
}

/** 资产 mime → 小片上的类别（消息里的 document part 只有 mime 与可选的 name） */
export function kindOfMime(mime: string): AttachmentKind {
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  return 'text';
}

/** 「1.2 MB」「340 KB」 */
export function formatBytes(bytes: number, language: string): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return `${value.toLocaleString(language, { maximumFractionDigits: digits })} ${units[unit]}`;
}

/** 小片上显示的类型字：扩展名优先（MD / CSV），没有就按类别 */
export function extensionLabel(name: string | undefined, kind: AttachmentKind): string {
  const ext = fileExtension(name);
  if (ext && ext.length <= 4) return ext.toUpperCase();
  return kind === 'pdf' ? 'PDF' : kind === 'image' ? 'IMG' : 'TXT';
}
