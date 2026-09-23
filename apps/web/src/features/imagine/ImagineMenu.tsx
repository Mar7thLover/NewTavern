import { useQueryClient } from '@tanstack/react-query';
import { Paintbrush, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { useImageGenSettings, type ImagineBody, type ImagineMode } from './api';
import {
  cancelImagine,
  dismissImagineError,
  startImagine,
  useImagineState,
  type ImagineState,
} from './store';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import { FieldLabel, Input, Textarea } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import type { MessageNode } from '../../lib/api';
import { cn } from '../../lib/utils';

/**
 * Composer 旁的「生图」菜单与进行中的进度条（docs/M4-CONTRACT.md 第二部分 §D.3）。
 * 生成的图作为一条助手消息入树（服务端写好节点，这里只把它并进缓存）。
 */

/** 生图节点：服务端写的 `extra.generatedBy === 'image'` */
export function isImageGenNode(node: Pick<MessageNode, 'extra'>): boolean {
  return node.extra?.generatedBy === 'image';
}

function promptLanguage(language: string | undefined): 'zh-CN' | 'en' {
  return (language ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh-CN';
}

/** 菜单项（顺序即显示顺序；free 会先弹输入框） */
export const IMAGINE_MENU_ITEMS: { mode: ImagineMode; labelKey: string }[] = [
  { mode: 'last_message', labelKey: 'imageGen.menu.lastMessage' },
  { mode: 'character', labelKey: 'imageGen.menu.character' },
  { mode: 'free', labelKey: 'imageGen.menu.free' },
];

/** 「重画」：同参数新种子，作为该生图节点的兄弟（swipe） */
export function useImagineActions(chatId: string) {
  const queryClient = useQueryClient();
  const { i18n } = useTranslation();
  const lang = promptLanguage(i18n.language);
  return {
    start: (body: ImagineBody) => startImagine(queryClient, chatId, { lang, ...body }),
    redraw: (node: Pick<MessageNode, 'id'>) =>
      startImagine(queryClient, chatId, { redrawOf: node.id, lang }),
  };
}

export interface ImagineMenuProps {
  chatId: string;
  disabled?: boolean;
  /** 测试 / 预览：初始就展开 */
  defaultOpen?: boolean;
}

export function ImagineMenu({ chatId, disabled, defaultOpen = false }: ImagineMenuProps) {
  const { t } = useTranslation();
  const settings = useImageGenSettings();
  const state = useImagineState(chatId);
  const { start } = useImagineActions(chatId);
  const [open, setOpen] = useState(defaultOpen);
  const [freeOpen, setFreeOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const busy = state !== null && state.phase !== 'error';
  const configured = Boolean(settings.data?.connectionId);

  // 点外面 / Esc 收起
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (mode: ImagineMode) => {
    setOpen(false);
    if (mode === 'free') {
      setFreeOpen(true);
      return;
    }
    start({ mode });
  };

  return (
    <div ref={rootRef} className="relative shrink-0" data-part="imagine">
      <IconButton
        label={t('imageGen.menu.trigger')}
        size="md"
        data-part="imagine-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        disabled={disabled || busy}
        onClick={() => setOpen((value) => !value)}
      >
        <Paintbrush aria-hidden />
      </IconButton>
      {open && (
        <div
          id={menuId}
          role="menu"
          data-part="imagine-menu"
          className="surface-raised edge-rule rounded-card absolute bottom-full left-0 z-30 mb-2 w-56 border py-1"
        >
          {configured ? (
            IMAGINE_MENU_ITEMS.map((item) => (
              <button
                key={item.mode}
                type="button"
                role="menuitem"
                data-mode={item.mode}
                onClick={() => choose(item.mode)}
                className="action-ghost flex w-full cursor-pointer items-center px-3 py-2 text-left text-sm"
              >
                {t(item.labelKey)}
              </button>
            ))
          ) : (
            <p className="px-3 py-2 text-[13px] leading-snug text-ink-2">
              {t('imageGen.noBackend')}{' '}
              <Link
                to="/connections"
                className="text-ink-link underline-offset-2 hover:underline"
                onClick={() => setOpen(false)}
              >
                {t('imageGen.goConnections')}
              </Link>
            </p>
          )}
        </div>
      )}
      {freeOpen && (
        <FreeDialog
          defaults={{
            width: settings.data?.defaults.width ?? 512,
            height: settings.data?.defaults.height ?? 768,
            negative: settings.data?.defaults.negative ?? '',
          }}
          onClose={() => setFreeOpen(false)}
          onSubmit={(body) => {
            setFreeOpen(false);
            start(body);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function FreeDialog({
  defaults,
  onClose,
  onSubmit,
}: {
  defaults: { width: number; height: number; negative: string };
  onClose: () => void;
  onSubmit: (body: ImagineBody) => void;
}) {
  const { t } = useTranslation();
  const formId = useId();
  const [prompt, setPrompt] = useState('');
  const [negative, setNegative] = useState(defaults.negative);
  const [width, setWidth] = useState(String(defaults.width));
  const [height, setHeight] = useState(String(defaults.height));

  const size = (value: string, fallback: number) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 64 && n <= 4096 ? n : fallback;
  };
  const canSubmit = prompt.trim() !== '';

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onSubmit({
      mode: 'free',
      prompt: prompt.trim(),
      negative,
      width: size(width, defaults.width),
      height: size(height, defaults.height),
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title={t('imageGen.free.title')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={!canSubmit}>
            {t('imageGen.free.submit')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="space-y-4" data-part="imagine-free">
        <div>
          <FieldLabel htmlFor={`${formId}-prompt`}>{t('imageGen.free.prompt')}</FieldLabel>
          <Textarea
            id={`${formId}-prompt`}
            value={prompt}
            rows={4}
            autoFocus
            placeholder={t('imageGen.free.promptPlaceholder')}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit(event);
            }}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel htmlFor={`${formId}-w`}>{t('imageGen.free.width')}</FieldLabel>
            <Input
              id={`${formId}-w`}
              inputMode="numeric"
              value={width}
              onChange={(event) => setWidth(event.target.value.replace(/[^\d]/g, ''))}
              className="tabular-nums"
            />
          </div>
          <div>
            <FieldLabel htmlFor={`${formId}-h`}>{t('imageGen.free.height')}</FieldLabel>
            <Input
              id={`${formId}-h`}
              inputMode="numeric"
              value={height}
              onChange={(event) => setHeight(event.target.value.replace(/[^\d]/g, ''))}
              className="tabular-nums"
            />
          </div>
        </div>
        <div>
          <FieldLabel htmlFor={`${formId}-neg`}>{t('imageGen.free.negative')}</FieldLabel>
          <Textarea
            id={`${formId}-neg`}
            value={negative}
            rows={2}
            spellCheck={false}
            onChange={(event) => setNegative(event.target.value)}
            className="font-mono text-xs"
          />
        </div>
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

/** 进行中 / 失败时在输入框上方的一条：阶段 + 进度条 + 取消；失败时给原因、重试、关闭 */
export function ImagineProgress({ chatId }: { chatId: string }) {
  const state = useImagineState(chatId);
  if (!state) return null;
  return <ImagineProgressView chatId={chatId} state={state} />;
}

export function ImagineProgressView({ chatId, state }: { chatId: string; state: ImagineState }) {
  const { t } = useTranslation();
  const { start } = useImagineActions(chatId);
  const failed = state.phase === 'error';
  const percent = state.fraction === null ? null : Math.round(state.fraction * 100);

  const label = failed
    ? t('imageGen.progress.failed', { message: state.error?.message ?? '' })
    : state.phase === 'writing'
      ? t('imageGen.progress.writing')
      : percent === null || percent === 0
        ? t('imageGen.progress.drawingStart')
        : t('imageGen.progress.drawing', { percent });

  return (
    <div
      data-part="imagine-progress"
      data-phase={state.phase}
      role={failed ? 'alert' : 'status'}
      aria-live="polite"
      className="mb-2 flex min-w-0 items-center gap-2"
    >
      <div className="min-w-0 flex-1">
        <p
          className={cn('truncate text-[12px] leading-snug', failed ? 'text-danger' : 'text-ink-2')}
          title={state.prompt ?? undefined}
        >
          {label}
          {!failed && state.prompt && (
            <span className="ms-2 font-mono text-[11px] text-ink-3">{state.prompt}</span>
          )}
        </p>
        {!failed && (
          <div
            className="mt-1 h-0.5 w-full overflow-hidden rounded-pill bg-[var(--edge)]"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent ?? undefined}
            aria-label={label}
          >
            <div
              data-part="imagine-progress-bar"
              className={cn(
                'h-full rounded-pill bg-accent transition-[width] duration-300',
                state.phase === 'writing' && 'pulse-live w-1/4',
              )}
              style={
                state.phase === 'writing' ? undefined : { width: `${Math.max(3, percent ?? 0)}%` }
              }
            />
          </div>
        )}
      </div>
      {failed ? (
        <>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              dismissImagineError(chatId);
              start(state.body);
            }}
          >
            {t('imageGen.progress.retry')}
          </Button>
          <IconButton
            label={t('imageGen.progress.dismiss')}
            onClick={() => dismissImagineError(chatId)}
          >
            <X aria-hidden />
          </IconButton>
        </>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => cancelImagine(chatId)}>
          {t('imageGen.progress.cancel')}
        </Button>
      )}
    </div>
  );
}
