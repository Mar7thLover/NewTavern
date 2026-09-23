import { ChevronDown, ChevronUp } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import {
  nodeExpression,
  pickSprite,
  spriteUrl,
  useChooseExpression,
  useSpriteSettings,
  useSprites,
  type SpriteItem,
} from './api';
import './sprites.css';
import { IconButton } from '../../components/ui/icon-button';
import type { ChatDetail, MessageNode } from '../../lib/api';
import { cn } from '../../lib/utils';
import { useSignature, type SpriteLayout } from '../../themes/signature';

/** 对话列至少这么宽才把立绘放在消息区右侧（窄了消息列会被挤得没法读） */
export const SPRITE_STAGE_MIN_WIDTH = 860;

/** 盯住一个元素的宽度（ResizeObserver）；不用容器查询：它会让对话列变成 fixed 子元素的包含块 */
export function useElementWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    setWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

export interface SpriteState {
  sprites: SpriteItem[];
  /** 当前显示的立绘；null = 这个角色没有立绘 / 立绘关闭 */
  current: SpriteItem | null;
  label: string | null;
  /** 最新助手节点（手动改表情写到它上面） */
  nodeId: string | null;
  choose: (label: string) => void;
}

/**
 * 当前角色的立绘与表情（M4（二）§B.2）：
 * 取路径上最新的助手节点——有 `extra.expression` 就用；没有且不在生成中，就请求一次分类；
 * 生成中保持上一张，不在流式期间分类。swipe 切换后同理（读已有的，没有再分类）。
 */
export function useSpriteState(
  chat: ChatDetail,
  path: readonly MessageNode[],
  isGenerating: boolean,
): SpriteState {
  const characterId = chat.characterIds[0] ?? null;
  const sprites = useSprites(characterId);
  const settings = useSpriteSettings();
  const choose = useChooseExpression(chat.id);
  const requested = useRef(new Set<string>());

  const list = sprites.data ?? [];
  const mode = settings.data?.mode ?? 'classify';
  const fallback = settings.data?.fallback ?? 'neutral';
  // 生图消息（M4（二）§D）不是角色在说话，不参与表情
  const latest =
    [...path]
      .reverse()
      .find((node) => node.role === 'assistant' && node.extra?.['generatedBy'] !== 'image') ?? null;
  const stored = latest ? nodeExpression(latest.extra) : null;

  const shouldRequest =
    latest !== null &&
    stored === null &&
    !isGenerating &&
    list.length > 0 &&
    mode === 'classify' &&
    settings.data !== undefined;
  const { mutate } = choose;
  useEffect(() => {
    if (!shouldRequest || !latest || requested.current.has(latest.id)) return;
    requested.current.add(latest.id);
    mutate({ nodeId: latest.id });
  }, [shouldRequest, latest, mutate]);

  // 生成中 / 分类还没回来：沿用路径上更早那条已有表情的助手消息（没有就用 fallback），不闪回默认
  const earlier =
    stored ??
    [...path]
      .reverse()
      .filter((node) => node.role === 'assistant')
      .map((node) => nodeExpression(node.extra))
      .find((value): value is string => value !== null) ??
    null;
  const current = mode === 'off' || list.length === 0 ? null : pickSprite(list, earlier, fallback);

  return {
    sprites: list,
    current,
    label: current?.label ?? null,
    nodeId: latest?.id ?? null,
    choose: (next) => {
      if (latest) mutate({ nodeId: latest.id, label: next });
    },
  };
}

/** 叠放的两张图：新图淡入盖住旧图（时长读 `--sprite-fade`，各世界自己定；书斋 0） */
function SpriteImage({ sprite, alt, fit }: { sprite: SpriteItem; alt: string; fit: 'contain' | 'face' }) {
  const [layers, setLayers] = useState<SpriteItem[]>([sprite]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLayers((previous) => {
      const top = previous[previous.length - 1];
      if (top?.assetId === sprite.assetId) return previous;
      return [...(top ? [top] : []), sprite];
    });
  }, [sprite]);

  useEffect(() => {
    if (layers.length < 2) return;
    const raw = ref.current ? getComputedStyle(ref.current).getPropertyValue('--sprite-fade') : '';
    const value = Number.parseFloat(raw);
    const ms = Number.isFinite(value) ? (raw.trim().endsWith('ms') ? value : value * 1000) : 200;
    const timer = window.setTimeout(() => setLayers((previous) => previous.slice(-1)), ms + 60);
    return () => window.clearTimeout(timer);
  }, [layers]);

  return (
    <div ref={ref} data-part="sprite-image" data-fit={fit} className="absolute inset-0">
      {layers.map((item, index) => (
        <img
          key={item.assetId}
          src={spriteUrl(item.assetId)}
          alt={index === layers.length - 1 ? alt : ''}
          aria-hidden={index === layers.length - 1 ? undefined : true}
          draggable={false}
          data-entering={index === layers.length - 1 && layers.length > 1 ? '' : undefined}
          className={cn(
            'absolute inset-0 size-full select-none',
            fit === 'face' ? 'object-cover object-top' : 'object-contain object-bottom',
          )}
        />
      ))}
    </div>
  );
}

function ExpressionSelect({
  state,
  className,
}: {
  state: SpriteState;
  className?: string;
}) {
  const { t } = useTranslation();
  if (!state.nodeId || state.sprites.length < 2) return null;
  return (
    <select
      data-part="sprite-expression"
      aria-label={t('sprites.expression')}
      title={t('sprites.expression')}
      value={state.label ?? ''}
      onChange={(event) => state.choose(event.target.value)}
      className={cn(
        'focus-ring max-w-full min-w-0 cursor-pointer truncate bg-transparent text-xs text-ink-3 hover:text-ink',
        className,
      )}
    >
      {state.sprites.map((sprite) => (
        <option key={sprite.label} value={sprite.label}>
          {sprite.label}
        </option>
      ))}
    </select>
  );
}

/**
 * 立绘区（M4（二）§B.3）。`stage`：对话列右侧、底部对齐；`strip`：输入框上方一条可折叠的小窗
 * （默认折叠成头像大小）。框由当前世界的 `SpriteFrame` 画；没有立绘时不渲染。
 */
export function SpriteStage({
  state,
  layout,
  name,
}: {
  state: SpriteState;
  layout: SpriteLayout;
  name: string;
}) {
  const { t } = useTranslation();
  const { SpriteFrame } = useSignature();
  const [open, setOpen] = useState(false);
  if (!state.current) return null;
  const alt = t('sprites.alt', { name, label: state.current.label });

  if (layout === 'stage') {
    return (
      <aside
        data-part="sprite-stage"
        data-layout="stage"
        aria-label={t('sprites.region')}
        className="relative flex w-[clamp(200px,26%,320px)] shrink-0 flex-col justify-end self-stretch pe-4 pb-3"
      >
        <div data-part="sprite-well" className="relative h-[min(72%,600px)] min-h-56">
          <SpriteFrame layout="stage" collapsed={false}>
            <SpriteImage sprite={state.current} alt={alt} fit="contain" />
          </SpriteFrame>
        </div>
        <div data-part="sprite-caption" className="mt-2 flex justify-center">
          <ExpressionSelect state={state} />
        </div>
      </aside>
    );
  }

  return (
    <section
      data-part="sprite-stage"
      data-layout="strip"
      data-open={open}
      aria-label={t('sprites.region')}
      className="mx-auto w-full max-w-3xl min-w-0 shrink-0 px-4 pt-1 sm:px-6"
    >
      {open && (
        <div data-part="sprite-well" className="relative mx-auto h-[min(34dvh,260px)] w-full max-w-xs">
          <SpriteFrame layout="strip" collapsed={false}>
            <SpriteImage sprite={state.current} alt={alt} fit="contain" />
          </SpriteFrame>
        </div>
      )}
      <div data-part="sprite-bar" className="flex min-w-0 items-center gap-2 py-1">
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={t('sprites.expand')}
            title={t('sprites.expand')}
            className="focus-ring relative size-10 shrink-0 cursor-pointer"
          >
            <SpriteFrame layout="strip" collapsed>
              <SpriteImage sprite={state.current} alt={alt} fit="face" />
            </SpriteFrame>
          </button>
        )}
        <span className="min-w-0 truncate text-xs text-ink-2">{name}</span>
        <ExpressionSelect state={state} className="ms-auto" />
        <IconButton
          label={open ? t('sprites.collapse') : t('sprites.expand')}
          onClick={() => setOpen((value) => !value)}
          className={cn(!(state.sprites.length >= 2 && state.nodeId) && 'ms-auto')}
        >
          {open ? <ChevronDown aria-hidden /> : <ChevronUp aria-hidden />}
        </IconButton>
      </div>
    </section>
  );
}
