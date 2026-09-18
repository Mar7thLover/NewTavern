import type { TFunction } from 'i18next';
import { Paperclip } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { AttachmentTray as TrayState } from './useAttachmentTray';
import { ATTACHMENT_ACCEPT } from '../../components/AttachmentFiles';
import { AttachmentTray } from '../../components/AttachmentTray';
import { IconButton } from '../../components/ui/icon-button';
import type { ModelCapabilities } from '../../lib/api';
import { useSignature } from '../../themes/signature';

const MAX_HEIGHT_PX = 260;

/** 触屏设备上 Enter 换行（发送靠按钮），桌面 Enter 发送 */
function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}

export interface ComposerProps {
  /** attachments：已上传的资产（按托盘顺序，带这次的文件名）；没有附件时为空数组 */
  onSend: (text: string, attachments: { id: string; name: string }[]) => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  /** 换聊天时清空草稿 */
  resetKey?: string;
  /** 附件托盘（状态放在 ChatView：拖放区域也要往里加文件） */
  tray: TrayState;
  /** 当前模型的能力；拿不到时为 undefined，不做能力提示 */
  capabilities: ModelCapabilities | undefined;
}

export function Composer({
  onSend,
  onStop,
  isGenerating,
  disabled,
  resetKey,
  tray,
  capabilities,
}: ComposerProps) {
  const { t } = useTranslation();
  const { SendButton } = useSignature();
  const [value, setValue] = useState('');
  const [touch, setTouch] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setTouch(isTouchPrimary()), []);
  useEffect(() => setValue(''), [resetKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const hasAttachments = tray.assetIds.length > 0;
  // 上传中 / 有失败项时不能发：宁可停下来，也不悄悄丢掉用户以为带上了的文件
  const attachmentsBlocked = tray.uploading || tray.failed;
  const canSend = (value.trim() !== '' || hasAttachments) && !attachmentsBlocked && !disabled;

  const send = () => {
    if (!canSend || isGenerating) return;
    const text = value.trim();
    const attachments = tray.attachments;
    setValue('');
    tray.clear();
    onSend(text, attachments);
  };

  /** 粘贴图片 / 文件：剪贴板里有文字时照常粘文字（从 Word、表格复制时也会带一张位图） */
  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const data = event.clipboardData;
    const files = Array.from(data.files);
    if (files.length === 0) return;
    if (data.getData('text/plain').trim() !== '') return;
    event.preventDefault();
    tray.add(files);
  };

  const hints = trayHints(tray, capabilities, t);

  return (
    <div
      data-part="composer-dock"
      className="surface-reading shrink-0 px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6"
    >
      <div className="mx-auto w-full max-w-3xl min-w-0">
        <AttachmentTray tray={tray} />
        {hints.length > 0 && (
          <div
            data-part="composer-tray-hint"
            className="-mt-0.5 mb-2 space-y-0.5"
            aria-live="polite"
          >
            {hints.map((hint) => (
              <p
                key={hint.key}
                className={
                  hint.tone === 'danger'
                    ? 'text-[12px] leading-snug text-danger'
                    : 'text-[12px] leading-snug text-ink-2'
                }
              >
                {hint.text}
              </p>
            ))}
          </div>
        )}
        <div data-part="composer" className="field rounded-panel flex min-w-0 items-end gap-1 p-2">
          <IconButton
            label={t('chat.attach.add')}
            size="md"
            data-part="composer-attach"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
            className="shrink-0"
          >
            <Paperclip aria-hidden />
          </IconButton>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ATTACHMENT_ACCEPT}
            tabIndex={-1}
            aria-hidden
            className="hidden"
            onChange={(event) => {
              const files = event.target.files;
              if (files && files.length > 0) tray.add(Array.from(files));
              // 允许再次选择同一个文件
              event.target.value = '';
              ref.current?.focus();
            }}
          />
          <textarea
            ref={ref}
            data-part="composer-input"
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={t('chat.composer.placeholder')}
            aria-label={t('chat.composer.placeholder')}
            onChange={(event) => setValue(event.target.value)}
            onPaste={onPaste}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || touch) return;
              if (event.nativeEvent.isComposing) return; // 输入法候选中
              event.preventDefault();
              send();
            }}
            className="max-h-[260px] min-h-9 w-full min-w-0 flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-[1.6] text-ink placeholder:text-ink-3 focus:outline-none disabled:opacity-50"
          />
          {/* 记忆物件：发送键的形态由主题决定（素 = 黑色圆点） */}
          <SendButton
            state={isGenerating ? 'generating' : canSend ? 'ready' : 'idle'}
            disabled={!isGenerating && !canSend}
            label={isGenerating ? t('chat.composer.stop') : t('chat.composer.send')}
            onClick={isGenerating ? onStop : send}
          />
        </div>
        <p data-part="composer-hint" className="mt-1.5 h-4 text-center text-[11px] text-ink-3">
          {!touch && t('chat.composer.hint')}
        </p>
      </div>
    </div>
  );
}

interface TrayHint {
  key: string;
  text: string;
  tone: 'muted' | 'danger';
}

/**
 * 托盘下方的轻提示：失败项挡住发送时说一句；PDF 会被换成抽取的文本时说一句。
 * 图片与 PDF 一律照发（能力目录不决定丢不丢，见 providers/media.ts），所以没有「会被丢弃」这类提示。
 */
function trayHints(tray: TrayState, caps: ModelCapabilities | undefined, t: TFunction): TrayHint[] {
  const hints: TrayHint[] = [];
  const failed = tray.items.filter((item) => item.status === 'error');
  const only = failed.length === 1 ? failed[0] : undefined;
  if (only) {
    hints.push({
      key: 'failed',
      text: only.retryable
        ? t('chat.attach.blockedRetry', { name: only.name })
        : t('chat.attach.blockedRemove', {
            name: only.name,
            reason:
              only.error?.message ?? t(`chat.attach.errors.${only.error?.reason ?? 'failed'}`),
          }),
      tone: 'danger',
    });
  } else if (failed.length > 1) {
    hints.push({
      key: 'failed',
      text: t('chat.attach.blockedMany', { total: failed.length }),
      tone: 'danger',
    });
  }
  if (!caps) return hints;

  // documentIn 为 false 时服务端会把抽出的文本内联进正文（media-inline.ts），提示一句免得意外
  const pdfs = tray.items.filter((item) => item.status === 'done' && item.kind === 'pdf');
  if (caps.documentIn === false && pdfs.length > 0) {
    if (pdfs.every((item) => (item.asset?.textLength ?? 0) > 0)) {
      hints.push({ key: 'pdf', text: t('chat.attach.pdfAsText'), tone: 'muted' });
    }
  }
  return hints;
}
