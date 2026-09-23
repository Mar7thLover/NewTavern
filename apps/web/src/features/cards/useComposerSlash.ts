import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { composerSlashKind, runSlashCommand } from './slash';
import { createSlashHost } from './slash-host';
import { useGeneration } from '../chat/useGeneration';
import { toast } from '../../components/ui/toast';
import { queryKeys, type ChatDetail } from '../../lib/api';

export type ComposerSlashOutcome = 'run' | 'blocked' | 'pass';

/**
 * Composer 里以 `/` 开头的输入（M5（三）§3.1）：
 *
 * - 第一个词是已知命令 → 执行而不发送（`run`：清空输入框）；结果非空时用提示条显示；
 * - 看起来是命令但不认识 → 提示条报错、不发送、保留输入（`blocked`）；
 * - 其余 → 照常发送（`pass`）。
 *
 * 变量快照挂在 head 上（与脚本帧一致）；`/trigger` `/regenerate` 走对话页的正式生成。
 */
export function useComposerSlash(chatId: string | undefined): (text: string) => ComposerSlashOutcome {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const generation = useGeneration(chatId ?? null);
  const generateRef = useRef(generation.generate);
  generateRef.current = generation.generate;

  return useCallback(
    (text: string) => {
      if (!chatId) return 'pass';
      const kind = composerSlashKind(text);
      if (kind === 'text') return 'pass';
      if (kind === 'unknown') {
        const name = /^\s*\/([\w-]+)/.exec(text)?.[1] ?? '';
        toast({
          title: t('cards.slash.unknownTitle', { name }),
          description: t('cards.slash.unknownBody'),
          tone: 'warning',
        });
        return 'blocked';
      }
      const getDetail = () => queryClient.getQueryData<ChatDetail>(queryKeys.chat(chatId));
      const host = createSlashHost({
        chatId,
        getDetail,
        getNodeId: () => getDetail()?.headNodeId ?? null,
        queryClient,
        generate: (body) => generateRef.current(body),
      });
      void runSlashCommand(text, host)
        .then((result) => {
          // /echo 自己会弹提示；这里只把「有返回值但没人显示」的结果亮出来（/getvar、/len …）
          const echoed = /(^|\|)\s*\/echo\b/.test(text);
          if (result.trim() !== '' && !echoed) {
            toast({ title: t('cards.slash.resultTitle'), description: result, tone: 'info' });
          }
        })
        .catch((error: unknown) => {
          toast({
            title: t('cards.slash.failedTitle'),
            description: error instanceof Error ? error.message : String(error),
            tone: 'danger',
          });
        });
      return 'run';
    },
    [chatId, queryClient, t],
  );
}
