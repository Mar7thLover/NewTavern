import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../../lib/utils';

const MAX_HEIGHT_PX = 260;

/** 触屏设备上 Enter 换行（发送靠按钮），桌面 Enter 发送 */
function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches;
}

export interface ComposerProps {
  onSend: (text: string) => void;
  onStop: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  /** 换聊天时清空草稿 */
  resetKey?: string;
}

export function Composer({ onSend, onStop, isGenerating, disabled, resetKey }: ComposerProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [touch, setTouch] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => setTouch(isTouchPrimary()), []);
  useEffect(() => setValue(''), [resetKey]);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const send = () => {
    const text = value.trim();
    if (text === '' || disabled || isGenerating) return;
    setValue('');
    onSend(text);
  };

  const canSend = value.trim() !== '' && !disabled;

  return (
    <div className="shrink-0 bg-gradient-to-t from-background via-background to-transparent px-4 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6">
      <div className="mx-auto w-full max-w-3xl min-w-0">
        <div className="flex min-w-0 items-end gap-2 rounded-2xl border border-border bg-card p-2 transition-shadow focus-within:ring-2 focus-within:ring-ring">
          <textarea
            ref={ref}
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={t('chat.composer.placeholder')}
            aria-label={t('chat.composer.placeholder')}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' || event.shiftKey || touch) return;
              if (event.nativeEvent.isComposing) return; // 输入法候选中
              event.preventDefault();
              send();
            }}
            className="max-h-[260px] min-h-9 w-full min-w-0 flex-1 resize-none bg-transparent px-2 py-1.5 text-[15px] leading-[1.6] text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
          />
          <button
            type="button"
            aria-label={isGenerating ? t('chat.composer.stop') : t('chat.composer.send')}
            title={isGenerating ? t('chat.composer.stop') : t('chat.composer.send')}
            onClick={isGenerating ? onStop : send}
            disabled={!isGenerating && !canSend}
            className={cn(
              'inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40',
              isGenerating
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : 'bg-primary text-primary-foreground hover:bg-primary/90',
            )}
          >
            {isGenerating ? (
              <Square aria-hidden className="size-3.5 fill-current" />
            ) : (
              <ArrowUp aria-hidden className="size-4.5" />
            )}
          </button>
        </div>
        <p className="mt-1.5 h-4 text-center text-[11px] text-muted-foreground">
          {!touch && t('chat.composer.hint')}
        </p>
      </div>
    </div>
  );
}
