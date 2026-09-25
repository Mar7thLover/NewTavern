import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { Button } from '../../components/ui/button';
import { FieldLabel, Input } from '../../components/ui/field';
import { Segmented } from '../../components/ui/segmented';
import {
  useCharacters,
  useCreateLorebook,
  useCreatePreset,
  useLorebooks,
  usePresets,
  type StudioMarker,
} from '../../lib/api';
import { studioPath, useCreateCharacter, type StudioKind } from '../../lib/api-studio';
import { EntityCard } from '../library/EntityCard';
import { EmptyState, LibraryHeader, QueryStatus, errorMessage } from '../library/shared';
import { AutoTextarea } from './character/fields';
import type { StudioLocationState } from './StudioWorkbenchPage';

/**
 * 工作台入口（M6 §4.1）。版式照对话页开始界面：角色卡 / 预设 / 世界书以卡面铺成网格，
 * 上方是新建与「一句话生成角色」，筛选页签与搜索作用于下面两组：
 * - 「工作台里的」：`studio` 非 null（从库里复制来的副本、工作台里新建的），点击直接打开；
 * - 「从库里复制」：库里的原件，点击 = 复制一份到工作台再打开（复制在工作台页里做，原件不动）。
 * 两组都按最近修改排序，刚改过的在最前。
 */

interface StudioItem {
  kind: StudioKind;
  id: string;
  name: string;
  avatarAssetId: string | null;
  updatedAt: string;
  /** 工作台的（副本 / 工作台里新建的） */
  own: boolean;
  /** 从库里复制来的副本 */
  copy: boolean;
}

type Filter = 'all' | StudioKind;

export function StudioHomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const characters = useCharacters();
  const presets = usePresets();
  const lorebooks = useLorebooks();
  const createCharacter = useCreateCharacter();
  const createPreset = useCreatePreset();
  const createLorebook = useCreateLorebook();
  const [idea, setIdea] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');

  const busy = createCharacter.isPending || createPreset.isPending || createLorebook.isPending;
  const error = createCharacter.error ?? createPreset.error ?? createLorebook.error;

  const open = (kind: StudioKind, id: string, state?: StudioLocationState) =>
    void navigate(studioPath(kind, id), state ? { state } : undefined);

  // 工作台里新建的都带 studio: true：直接就是工作台的，打开时不会再复制
  const newCharacter = () =>
    createCharacter.mutate(
      { name: t('studio.home.newCharacterName'), studio: true },
      { onSuccess: (row) => open('character', row.id) },
    );
  const newPreset = () =>
    createPreset.mutate({ studio: true }, { onSuccess: (row) => open('preset', row.id) });
  const newLorebook = () =>
    createLorebook.mutate({ studio: true }, { onSuccess: (row) => open('lorebook', row.id) });

  const generate = () => {
    const text = idea.trim();
    if (!text || busy) return;
    createCharacter.mutate(
      { name: t('studio.home.newCharacterName'), studio: true },
      { onSuccess: (row) => open('character', row.id, { generate: text }) },
    );
  };

  /* 三类混排，按最近修改排序：刚改过的就在最前（代替原来单列的「最近编辑」） */
  const marks = (studio: StudioMarker | null) => ({
    own: studio != null,
    copy: studio != null && studio.sourceId !== null,
  });
  const items: StudioItem[] = [
    ...(characters.data ?? []).map((item): StudioItem => ({
      kind: 'character',
      id: item.id,
      name: item.name,
      avatarAssetId: item.avatarAssetId,
      updatedAt: item.updatedAt,
      ...marks(item.studio),
    })),
    ...(presets.data ?? []).map((item): StudioItem => ({
      kind: 'preset',
      id: item.id,
      name: item.name,
      avatarAssetId: null,
      updatedAt: item.updatedAt,
      ...marks(item.studio),
    })),
    ...(lorebooks.data ?? []).map((item): StudioItem => ({
      kind: 'lorebook',
      id: item.id,
      name: item.name,
      avatarAssetId: null,
      updatedAt: item.updatedAt,
      ...marks(item.studio),
    })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const counts = { character: 0, preset: 0, lorebook: 0 };
  for (const item of items) counts[item.kind] += 1;

  const needle = query.trim().toLowerCase();
  const list = items.filter(
    (item) =>
      (filter === 'all' || item.kind === filter) &&
      (needle === '' || item.name.toLowerCase().includes(needle)),
  );
  const ownList = list.filter((item) => item.own);
  const libraryList = list.filter((item) => !item.own);

  const ready =
    characters.data !== undefined && presets.data !== undefined && lorebooks.data !== undefined;
  const listError = characters.error ?? presets.error ?? lorebooks.error;

  /** 副本标「副本」（角色卡原本无 kicker）；预设 / 世界书是「预设 · 副本」 */
  const kicker = (item: StudioItem): string | undefined => {
    if (item.kind === 'character') return item.copy ? t('studio.home.copyKicker') : undefined;
    const kind = t(`studio.kinds.${item.kind}`);
    return item.copy ? t('studio.home.kindCopyKicker', { kind }) : kind;
  };

  const card = (item: StudioItem) => {
    const text = kicker(item);
    return (
      <li key={`${item.kind}:${item.id}`}>
        <EntityCard
          name={item.name}
          kind={item.kind}
          avatarAssetId={item.avatarAssetId}
          {...(text ? { kicker: text } : {})}
          // 原件：工作台页先复制一份再打开（见 StudioWorkbenchPage 的 ForkGate）
          onClick={() => open(item.kind, item.id)}
        />
      </li>
    );
  };

  const grid = (group: StudioItem[]) => (
    <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{group.map(card)}</ul>
  );

  return (
    <div data-part="studio-home" className="mx-auto max-w-4xl">
      <LibraryHeader
        title={t('nav.studio')}
        subtitle={t('studio.home.subtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={newCharacter}>
              {t('studio.home.newCharacter')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={newPreset}>
              {t('studio.home.newPreset')}
            </Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={newLorebook}>
              {t('studio.home.newLorebook')}
            </Button>
          </div>
        }
      />

      {error && (
        <p role="alert" className="-mt-4 mb-6 text-xs text-danger">
          {errorMessage(error)}
        </p>
      )}

      <section className="mb-10">
        <FieldLabel htmlFor="studio-idea">{t('studio.home.ideaLabel')}</FieldLabel>
        <AutoTextarea
          id="studio-idea"
          value={idea}
          onChange={setIdea}
          minRows={2}
          placeholder={t('studio.home.ideaPlaceholder')}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              generate();
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] leading-relaxed text-ink-3">{t('studio.home.ideaHint')}</p>
          <Button disabled={idea.trim() === '' || busy} onClick={generate}>
            {createCharacter.isPending ? t('studio.home.creating') : t('studio.home.generate')}
          </Button>
        </div>
      </section>

      <section>
        <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-x-4 gap-y-2">
          <Segmented
            className="min-w-0"
            label={t('studio.home.filterLabel')}
            value={filter}
            onChange={setFilter}
            items={[
              { value: 'all', label: t('studio.home.all'), note: String(items.length) },
              {
                value: 'character',
                label: t('studio.kinds.character'),
                note: String(counts.character),
              },
              { value: 'preset', label: t('studio.kinds.preset'), note: String(counts.preset) },
              {
                value: 'lorebook',
                label: t('studio.kinds.lorebook'),
                note: String(counts.lorebook),
              },
            ]}
          />
          <Input
            value={query}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full min-w-0 sm:w-56"
          />
        </div>

        <QueryStatus
          isPending={!ready && !listError}
          error={listError}
          onRetry={() => {
            void characters.refetch();
            void presets.refetch();
            void lorebooks.refetch();
          }}
        />

        {ready &&
          (items.length === 0 ? (
            <EmptyState
              kind="characters"
              title={t('studio.home.emptyTitle')}
              hint={t('studio.home.emptyHint')}
            />
          ) : list.length === 0 ? (
            <p className="py-8 text-center text-sm text-ink-3">{t('studio.home.noMatch')}</p>
          ) : (
            <div className="space-y-8">
              {ownList.length > 0 && (
                <section aria-labelledby="studio-own-title" data-part="studio-own">
                  <h2 id="studio-own-title" className="mb-3 text-sm font-medium text-ink">
                    {t('studio.home.ownTitle')}
                  </h2>
                  {grid(ownList)}
                </section>
              )}
              {libraryList.length > 0 && (
                <section aria-labelledby="studio-library-title" data-part="studio-library">
                  <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <h2 id="studio-library-title" className="text-sm font-medium text-ink">
                      {t('studio.home.libraryTitle')}
                    </h2>
                    <p className="text-[11px] text-ink-3">{t('studio.home.libraryHint')}</p>
                  </div>
                  {grid(libraryList)}
                </section>
              )}
            </div>
          ))}
      </section>
    </div>
  );
}
