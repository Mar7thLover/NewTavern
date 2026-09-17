import type { Part } from '@newtavern/core';
import { classifyDocumentMime, type ModelCapabilities } from '@newtavern/providers';

import type { AssetsService } from './assets.js';
import { decodeUtf8Text } from './media.js';

/**
 * 组装前把文档附件内联成文本（docs/M4-CONTRACT.md §3.3「组装前内联」）。
 *
 * - 文本类文档（text/*、application/json）：照 ST `appendFileContent`（public/scripts/chats.js）
 *   `fileTexts.join('\n\n') + '\n\n' + 原文本`，文档 part 本身去掉；空文件不计入（ST `if (fileText)`）。
 * - PDF：模型 `documentIn` 时保留 part；否则 `meta.text` 非空就按文本内联（前缀一行 `[<文件名>]`），
 *   为空则保留 part，交给适配器按能力告警丢弃。
 * - 图片原样保留（适配器按 `imageIn` 处理）。
 * - 读不到的资产（行被删、文件丢失、不是 UTF-8）保留 part：发请求时解析器返回 undefined，
 *   适配器丢弃并告警「找不到资产」/「无法按 UTF-8 文本解码」，用户能在检查器里看到原因。
 *
 * 文件文本拼在第一个文本 part 前面；消息没有文本 part（只发了附件）时新建一个放在最前。
 * 与 ST 的已知差异：ST 先对消息跑提示词正则、再拼文件文本；这里拼好后整段交给组装器，
 * 文件文本也会经过提示词正则与宏替换（见 §9 MSS 修正）。
 */
export function inlineDocumentParts(
  parts: readonly Part[],
  opts: { caps: Pick<ModelCapabilities, 'documentIn'>; assets: AssetsService },
): Part[] {
  if (!parts.some((part) => part.type === 'document')) return parts as Part[];

  const { caps, assets } = opts;
  const fileTexts: string[] = [];
  const kept: Part[] = [];
  let inlined = false;

  for (const part of parts) {
    if (part.type !== 'document') {
      kept.push(part);
      continue;
    }
    const cls = classifyDocumentMime(part.mime);
    if (cls === 'text') {
      const row = assets.getById(part.assetId);
      const bytes = row ? assets.readBytes(row) : undefined;
      const text = bytes ? decodeUtf8Text(bytes) : undefined;
      if (text === undefined) {
        kept.push(part);
        continue;
      }
      inlined = true;
      if (text) fileTexts.push(text);
      continue;
    }
    if (cls === 'pdf' && !caps.documentIn) {
      const row = assets.getById(part.assetId);
      const text = row?.meta?.['text'];
      if (typeof text === 'string' && text !== '') {
        const metaName = row?.meta?.['name'];
        const name = part.name ?? (typeof metaName === 'string' ? metaName : `${part.assetId}.pdf`);
        inlined = true;
        fileTexts.push(`[${name}]\n${text}`);
        continue;
      }
    }
    kept.push(part);
  }

  if (!inlined) return parts as Part[];
  if (fileTexts.length === 0) return kept;

  const merged = `${fileTexts.join('\n\n')}\n\n`;
  const textIndex = kept.findIndex((part) => part.type === 'text');
  const target = kept[textIndex];
  if (target?.type === 'text') {
    kept[textIndex] = { type: 'text', text: merged + target.text };
  } else {
    kept.unshift({ type: 'text', text: merged });
  }
  return kept;
}
