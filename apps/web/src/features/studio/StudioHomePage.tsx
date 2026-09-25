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
} from '../../lib/api';
import { studioPath, useCreateCharacter, type StudioKind } from '../../lib/api-studio';
import { EntityCard } from '../library/EntityCard';
import { EmptyState, LibraryHeader, QueryStatus, errorMessage } from '../library/shared';
import { AutoTextarea } from './character/fields';
import type { StudioLocationState } from './StudioWorkbenchPage';

/**
 * 工作台入口（M6 §4.1）。版式照对话页开始界面：已有的角色卡 / 预设 / 世界书都以卡面铺成网格，
 * 点哪张就在工作台里打开哪张（按最近修改排序，刚改过的在最前）；上方是新建与「一句话生成角色」。
 */

interface StudioItem {
  kind: StudioKind;
  id: string;
  name: string;
  avatarAssetId: string | null;
  updatedAt: string;
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

  const newCharacter = () =>
    createCharacter.mutate(
      { name: t('studio.home.newCharacterName') },
      { onSuccess: (row) => open('character', row.id) },
    );
  const newPreset = () => createPreset.mutate({}, { onSuccess: (row) => open('preset', row.id) });
  const newLorebook = () =>
    createLorebook.mutate({}, { onSuccess: (row) => open('lorebook', row.id) });

  const generate = () => {
    const text = idea.trim();
    if (!text || busy) return;
    createCharacter.mutate(
      { name: t('studio.home.newCharacterName') },
      { onSuccess: (row) => open('character', row.id, { generate: text }) },
    );
  };

  /* 三类混排，按最近修改排序：刚改过的就在最前（代替原来单列的「最近编辑」） */
  const items: StudioItem[] = [
    ...(characters.data ?? []).map((item): StudioItem => ({
      kind: 'character',
      id: item.id,
      name: item.name,
      avatarAssetId: item.avatarAssetId,
      updatedAt: item.updatedAt,
    })),
    ...(presets.data ?? []).map((item): StudioItem => ({
      kind: 'preset',
      id: item.id,
      name: item.name,
      avatarAssetId: null,
      updatedAt: item.updatedAt,
    })),
    ...(lorebooks.data ?? []).map((item): StudioItem => ({
      kind: 'lorebook',
      id: item.id,
      name: item.name,
      avatarAssetId: null,
      updatedAt: item.updatedAt,
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

  const ready =
    characters.data !== undefined && presets.data !== undefined && lorebooks.data !== undefined;
  const listError = characters.error ?? presets.error ?? lorebooks.error;

  const kicker = (kind: StudioKind) =>
    kind === 'character' ? undefined : t(`studio.kinds.${kind}`);

  const card = (item: StudioItem) => (
    <li key={`${item.kind}:${item.id}`}>
      <EntityCard
        name={item.name}
        kind={item.kind}
        avatarAssetId={item.avatarAssetId}
        {...(item.kind === 'character' ? {} : { kicker: kicker(item.kind) })}
        onClick={() => open(item.kind, item.id)}
      />
    </li>
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
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {list.map(card)}
            </ul>
          ))}
      </section>
    </div>
  );
}
