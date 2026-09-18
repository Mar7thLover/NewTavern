import { enrichRichText, RICH_BLOCK_KINDS, type RichBlockKind } from '@newtavern/core';
import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { useUiStore } from '../../app/store/ui';

/**
 * 正文美化（显示侧）。两个开关各管一件事，互不牵连：
 *
 * - **主题美化** `richBlocks`：把预设输出里的状态栏 / 思考 / 选项等认成语义块，
 *   由当前世界的 `themes/<id>/blocks.css` 决定长什么样。
 * - **卡自带前端** `cardHtml`：渲染角色卡 / 世界书 / 预设的正则吐出来的 HTML。
 *   关掉时原文一律转义，只剩我们自己生成的那点标记是活的。
 *
 * 两个都关 = 和以前一样：纯 Markdown，HTML 转义。
 * 存档、编辑框与提示词里始终是原文，这里只改渲染结果。
 */
export interface RichText {
  /** 显示侧正则之后、交给 Markdown 之前的最后一道 */
  transform: (text: string) => string;
  /** Markdown 是否要开原生 HTML 解析 */
  html: boolean;
}

export function useRichText(): RichText {
  const { t } = useTranslation();
  const richBlocks = useUiStore((s) => s.richBlocks);
  const cardHtml = useUiStore((s) => s.cardHtml);

  // 块标题跟着界面语言走；`<状态栏>` 这种自带中文名的标签用标签自己的名字
  const labels = useMemo(() => {
    const entries = RICH_BLOCK_KINDS.map(
      (kind) => [kind, t(`chat.blocks.${kind}`)] as [RichBlockKind, string],
    );
    return Object.fromEntries(entries) as Record<RichBlockKind, string>;
  }, [t]);

  const transform = useCallback(
    (text: string) => {
      if (!text || !richBlocks) return text;
      return enrichRichText(text, { labels, ...(cardHtml ? {} : { escapeSource: true }) });
    },
    [richBlocks, cardHtml, labels],
  );

  return { transform, html: richBlocks || cardHtml };
}
