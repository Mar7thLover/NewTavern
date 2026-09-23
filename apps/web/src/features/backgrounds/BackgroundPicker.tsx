import { Check, ImagePlus, Pencil, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  BACKGROUND_NONE,
  backgroundUrl,
  resolveBackground,
  useBackdropStore,
  useBackgroundByCharacter,
  useBackgrounds,
  useDefaultBackground,
  useDeleteBackground,
  useRenameBackground,
  useSetBackgroundByCharacter,
  useSetDefaultBackground,
  useUploadBackground,
  type BackgroundItem,
} from './api';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { usePatchChat, type ChatDetail } from '../../lib/api';
import { cn } from '../../lib/utils';
import { PanelSection } from '../chat/SessionSettings';

/* ------------------------------------------------------------------ */
/* 应用外壳用：把会话实际生效的背景交给 BackdropLayer                      */
/* ------------------------------------------------------------------ */

/** 在对话页里调用：解析会话 > 角色 > 全局，写进 backdrop store；离开会话时清空 */
export function useChatBackdrop(chat: ChatDetail | null): void {
  const library = useBackgrounds();
  const byCharacter = useBackgroundByCharacter();
  const globalId = useDefaultBackground();
  const setAssetId = useBackdropStore((state) => state.setAssetId);
  const resolved = resolveBackground(chat, byCharacter.data, globalId.data, library.data);

  useEffect(() => {
    setAssetId(resolved.assetId);
  }, [resolved.assetId, setAssetId]);

  useEffect(() => () => setAssetId(null), [setAssetId]);
}

/* ------------------------------------------------------------------ */
/* 缩略图格子                                                           */
/* ------------------------------------------------------------------ */

function Tile({
  active,
  label,
  onClick,
  children,
  kind,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  children?: ReactNode;
  kind: 'image' | 'inherit' | 'none';
}) {
  return (
    <button
      type="button"
      data-part="background-tile"
      data-kind={kind}
      data-active={active}
      aria-pressed={active}
      title={label}
      onClick={onClick}
      className={cn(
        'focus-ring rounded-control relative block aspect-[16/10] w-full cursor-pointer overflow-hidden border',
        active ? 'border-accent' : 'edge-rule hover:edge-rule-strong',
      )}
    >
      {children}
      <span
        className={cn(
          'absolute inset-x-0 bottom-0 truncate px-1.5 py-0.5 text-left text-[11px]',
          kind === 'image' ? 'surface-raised text-ink-2' : 'text-ink-2',
        )}
      >
        {label}
      </span>
      {active && (
        <span className="rounded-pill surface-raised absolute top-1 right-1 flex size-4 items-center justify-center text-accent">
          <Check aria-hidden className="size-3" />
        </span>
      )}
    </button>
  );
}

function Thumb({ item }: { item: BackgroundItem }) {
  return (
    <img
      src={backgroundUrl(item.assetId)}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      className="absolute inset-0 size-full object-cover"
    />
  );
}

function UploadButton({ onUploaded }: { onUploaded?: (item: BackgroundItem) => void }) {
  const { t } = useTranslation();
  const upload = useUploadBackground();
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) upload.mutate(file, { onSuccess: (item) => onUploaded?.(item) });
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={upload.isPending}
        onClick={() => input.current?.click()}
      >
        <ImagePlus aria-hidden className="size-3.5" />
        {upload.isPending ? t('backgrounds.uploading') : t('backgrounds.upload')}
      </Button>
      {upload.error && (
        <p role="alert" className="w-full text-[11px] text-danger">
          {upload.error instanceof Error ? upload.error.message : String(upload.error)}
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 会话面板「背景」                                                      */
/* ------------------------------------------------------------------ */

/**
 * 会话面板的背景小节（M4（二）§A.4）：第一格「继承」、第二格「无」，其余是背景库；
 * 点选即切。下方「上传」「设为此角色默认」「设为全局默认」。
 */
export function ChatBackgroundSection({ chat }: { chat: ChatDetail }) {
  const { t } = useTranslation();
  const patchChat = usePatchChat();
  const library = useBackgrounds();
  const byCharacter = useBackgroundByCharacter();
  const globalId = useDefaultBackground();
  const setByCharacter = useSetBackgroundByCharacter();
  const setGlobal = useSetDefaultBackground();
  const focusNonce = useBackdropStore((state) => state.focusNonce);
  const anchor = useRef<HTMLDivElement>(null);

  // 命令面板「切换背景」：展开并滚到眼前（PanelSection 的开合是内部状态，用 key 重建成展开）
  const [openKey, setOpenKey] = useState(0);
  useEffect(() => {
    if (focusNonce === 0) return;
    setOpenKey((key) => key + 1);
    useBackdropStore.getState().clearFocus();
  }, [focusNonce]);
  useEffect(() => {
    if (openKey === 0) return;
    const timer = window.setTimeout(
      () => anchor.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
      60,
    );
    return () => window.clearTimeout(timer);
  }, [openKey]);

  const items = library.data ?? [];
  const own = chat.metadata?.['background'];
  const ownId = typeof own === 'string' && own !== BACKGROUND_NONE ? own : null;
  const ownValid = ownId !== null && items.some((item) => item.assetId === ownId);
  const selection: 'inherit' | 'none' | string =
    own === BACKGROUND_NONE ? 'none' : ownValid ? (ownId as string) : 'inherit';
  const inherited = resolveBackground(
    { metadata: null, characterIds: chat.characterIds },
    byCharacter.data,
    globalId.data,
    library.data,
  );
  const effective = resolveBackground(chat, byCharacter.data, globalId.data, library.data);
  const inheritedItem = items.find((item) => item.assetId === inherited.assetId);
  const effectiveItem = items.find((item) => item.assetId === effective.assetId);
  const characterId = chat.characterIds[0] ?? null;

  const choose = (value: string) =>
    patchChat.mutate({ id: chat.id, metadata: { background: value === 'inherit' ? null : value } });

  const summary = effectiveItem
    ? effectiveItem.name
    : t('backgrounds.none');

  return (
    <div ref={anchor} data-part="background-section">
      <PanelSection
        key={openKey}
        title={t('backgrounds.title')}
        summary={summary}
        defaultOpen={openKey > 0}
      >
        <div data-part="background-grid" className="grid grid-cols-3 gap-2">
          <Tile
            kind="inherit"
            active={selection === 'inherit'}
            label={t('backgrounds.inherit')}
            onClick={() => choose('inherit')}
          >
            {inheritedItem && (
              <span className="absolute inset-0 opacity-50">
                <Thumb item={inheritedItem} />
              </span>
            )}
          </Tile>
          <Tile
            kind="none"
            active={selection === 'none'}
            label={t('backgrounds.noneTile')}
            onClick={() => choose(BACKGROUND_NONE)}
          />
          {items.map((item) => (
            <Tile
              key={item.assetId}
              kind="image"
              active={selection === item.assetId}
              label={item.name}
              onClick={() => choose(item.assetId)}
            >
              <Thumb item={item} />
            </Tile>
          ))}
        </div>
        <p className="text-[11px] leading-relaxed text-ink-2">
          {selection === 'inherit'
            ? t(`backgrounds.inheritFrom.${inherited.source}`, {
                name: inheritedItem?.name ?? '',
              })
            : t('backgrounds.ownHint')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <UploadButton onUploaded={(item) => choose(item.assetId)} />
          {characterId && effective.assetId && (
            <Button
              size="sm"
              variant="ghost"
              disabled={byCharacter.data?.[characterId] === effective.assetId}
              onClick={() =>
                setByCharacter.mutate({
                  ...(byCharacter.data ?? {}),
                  [characterId]: effective.assetId as string,
                })
              }
            >
              {t('backgrounds.setForCharacter')}
            </Button>
          )}
          {effective.assetId && (
            <Button
              size="sm"
              variant="ghost"
              disabled={globalId.data === effective.assetId}
              onClick={() => setGlobal.mutate(effective.assetId)}
            >
              {t('backgrounds.setGlobal')}
            </Button>
          )}
        </div>
      </PanelSection>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 设置 → 外观：全局默认 + 背景库管理                                     */
/* ------------------------------------------------------------------ */

export function BackgroundLibrary() {
  const { t } = useTranslation();
  const library = useBackgrounds();
  const globalId = useDefaultBackground();
  const setGlobal = useSetDefaultBackground();
  const rename = useRenameBackground();
  const remove = useDeleteBackground();
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const items = library.data ?? [];
  const current = globalId.data ?? null;
  const valid = current !== null && items.some((item) => item.assetId === current);

  const commit = (item: BackgroundItem) => {
    const name = draft.trim();
    setEditing(null);
    if (name && name !== item.name) rename.mutate({ assetId: item.assetId, name });
  };

  return (
    <div data-part="background-library" className="space-y-3">
      <div data-part="background-grid" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <div>
          <Tile
            kind="none"
            active={!valid}
            label={t('backgrounds.noneTile')}
            onClick={() => setGlobal.mutate(null)}
          />
          <p className="mt-1 truncate text-[11px] text-ink-3">{t('backgrounds.noGlobal')}</p>
        </div>
        {items.map((item) => (
          <div key={item.assetId} data-part="background-library-item" className="min-w-0">
            <Tile
              kind="image"
              active={valid && current === item.assetId}
              label={t('backgrounds.globalTile')}
              onClick={() => setGlobal.mutate(item.assetId)}
            >
              <Thumb item={item} />
            </Tile>
            <div className="mt-1 flex min-w-0 items-center gap-0.5">
              {editing === item.assetId ? (
                <Input
                  size="sm"
                  autoFocus
                  value={draft}
                  aria-label={t('backgrounds.rename')}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => commit(item)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') commit(item);
                    else if (event.key === 'Escape') setEditing(null);
                  }}
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs" title={item.name}>
                    {item.name}
                  </span>
                  <IconButton
                    size="xs"
                    label={t('backgrounds.rename')}
                    onClick={() => {
                      setDraft(item.name);
                      setEditing(item.assetId);
                    }}
                  >
                    <Pencil aria-hidden />
                  </IconButton>
                  <IconButton
                    size="xs"
                    variant="destructive"
                    label={t('backgrounds.delete')}
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(t('backgrounds.deleteConfirm', { name: item.name }))) {
                        remove.mutate(item.assetId);
                      }
                    }}
                  >
                    <Trash2 aria-hidden />
                  </IconButton>
                </>
              )}
            </div>
          </div>
        ))}
      </div>
      {items.length === 0 && !library.isPending && (
        <p className="text-xs text-ink-2">{t('backgrounds.empty')}</p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <UploadButton />
      </div>
    </div>
  );
}
