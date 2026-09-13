import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ImportButton } from '../../components/ImportButton';
import { Modal } from '../../components/Modal';
import { Badge } from '../../components/ui/badge';
import { Button, buttonVariants } from '../../components/ui/button';
import {
  apiUrls,
  queryKeys,
  useCharacter,
  useCharacters,
  useDeleteCharacter,
  type CharacterCardData,
  type CharacterExportFormat,
  type CharacterSummary,
} from '../../lib/api';
import { Avatar, EmptyState, LibraryHeader, QueryStatus, errorMessage } from './shared';

const CHARACTER_ACCEPT = '.png,.charx,.json';

const DETAIL_FIELDS = [
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'creator_notes',
] as const;

const EXPORT_FORMATS: CharacterExportFormat[] = ['png', 'charx', 'json'];

const MAX_CARD_TAGS = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 兼容服务端直接给 data 或给整张卡（{ spec, data }）两种形态 */
function resolveCardData(raw: unknown): CharacterCardData {
  if (!isRecord(raw)) return {};
  if (typeof raw.spec === 'string' && isRecord(raw.data)) return raw.data as CharacterCardData;
  return raw as CharacterCardData;
}

/** creator_notes 优先取 CCv3 creator_notes_multilingual 中匹配 UI 语言的版本 */
function creatorNotes(data: CharacterCardData, language: string): string | undefined {
  const multilingual = data.creator_notes_multilingual;
  if (isRecord(multilingual)) {
    const base = language.split('-')[0] ?? language;
    const localized = multilingual[language] ?? multilingual[base];
    if (typeof localized === 'string' && localized.trim()) return localized;
  }
  return data.creator_notes;
}

export function CharactersPage() {
  const { t } = useTranslation();
  const characters = useCharacters();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const list = characters.data ?? [];
  const selected = list.find((c) => c.id === selectedId) ?? null;

  const importButton = (size: 'sm' | 'lg', align: 'end' | 'center') => (
    <ImportButton
      endpoint={apiUrls.importCharacter}
      accept={CHARACTER_ACCEPT}
      invalidateKey={queryKeys.characters}
      label={t('library.characters.import')}
      size={size}
      align={align}
    />
  );

  return (
    <div className="mx-auto max-w-6xl">
      <LibraryHeader
        title={t('nav.characters')}
        subtitle={characters.data ? t('library.characters.count', { total: list.length }) : null}
        actions={list.length > 0 ? importButton('sm', 'end') : null}
      />

      <QueryStatus
        isPending={characters.isPending}
        error={characters.error}
        onRetry={() => void characters.refetch()}
      />

      {characters.data &&
        (list.length === 0 ? (
          <EmptyState
            title={t('library.characters.emptyTitle')}
            hint={t('library.characters.emptyHint')}
            action={importButton('lg', 'center')}
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3 xl:grid-cols-4">
            {list.map((character) => (
              <li key={character.id}>
                <CharacterCard character={character} onOpen={() => setSelectedId(character.id)} />
              </li>
            ))}
          </ul>
        ))}

      {selectedId !== null && (
        <CharacterDetailModal
          id={selectedId}
          summary={selected}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

function CharacterCard({ character, onOpen }: { character: CharacterSummary; onOpen: () => void }) {
  const extraTags = character.tags.length - MAX_CARD_TAGS;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-3 overflow-hidden rounded-lg border border-border bg-card p-3 text-left text-card-foreground transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-col sm:items-stretch sm:gap-0 sm:p-0"
    >
      <Avatar
        name={character.name}
        assetId={character.avatarAssetId}
        className="h-16 w-16 rounded-md sm:aspect-[3/4] sm:h-auto sm:w-full sm:rounded-none"
        textClassName="text-2xl sm:text-5xl"
      />
      <div className="min-w-0 flex-1 sm:p-3">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium">{character.name}</span>
          <Badge variant="outline" className="uppercase">
            {character.spec}
          </Badge>
        </div>
        {character.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {character.tags.slice(0, MAX_CARD_TAGS).map((tag) => (
              <Badge key={tag} variant="muted" className="max-w-full truncate">
                {tag}
              </Badge>
            ))}
            {extraTags > 0 && <Badge variant="muted">+{extraTags}</Badge>}
          </div>
        )}
      </div>
    </button>
  );
}

function CharacterDetailModal({
  id,
  summary,
  onClose,
}: {
  id: string;
  summary: CharacterSummary | null;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const detail = useCharacter(id);
  const deleteCharacter = useDeleteCharacter();
  const [confirming, setConfirming] = useState(false);

  const name = detail.data?.name ?? summary?.name ?? '';
  const spec = detail.data?.spec ?? summary?.spec;
  const avatarAssetId = detail.data?.avatarAssetId ?? summary?.avatarAssetId ?? null;
  const tags = detail.data?.tags ?? summary?.tags ?? [];

  const data = resolveCardData(detail.data?.data);
  const fields = DETAIL_FIELDS.map((field) => {
    const value = field === 'creator_notes' ? creatorNotes(data, i18n.language) : data[field];
    return { field, value: typeof value === 'string' ? value : '' };
  }).filter(({ value }) => value.trim() !== '');

  return (
    <>
      <Modal
        open
        onClose={onClose}
        size="lg"
        title={
          <span className="flex items-center gap-3">
            <Avatar
              name={name}
              assetId={avatarAssetId}
              className="size-10 rounded-full"
              textClassName="text-base"
            />
            <span className="min-w-0 truncate">{name}</span>
            {spec && (
              <Badge variant="outline" className="uppercase">
                {spec}
              </Badge>
            )}
          </span>
        }
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              className="mr-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
              onClick={() => {
                deleteCharacter.reset();
                setConfirming(true);
              }}
            >
              {t('common.delete')}
            </Button>
            {EXPORT_FORMATS.map((format) => (
              <a
                key={format}
                href={apiUrls.exportCharacter(id, format)}
                download
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {t('library.characters.exportAs', { format: format.toUpperCase() })}
              </a>
            ))}
          </>
        }
      >
        {tags.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <Badge key={tag} variant="muted">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        <QueryStatus
          isPending={detail.isPending}
          error={detail.error}
          onRetry={() => void detail.refetch()}
        />

        {detail.data &&
          (fields.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('library.characters.noDetails')}
            </p>
          ) : (
            <div className="space-y-5">
              {fields.map(({ field, value }) => (
                <section key={field}>
                  <h3 className="mb-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                    {t(`library.characters.fields.${field}`)}
                  </h3>
                  <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{value}</p>
                </section>
              ))}
            </div>
          ))}
      </Modal>

      <ConfirmDialog
        open={confirming}
        destructive
        title={t('library.characters.deleteTitle')}
        description={t('library.characters.deleteMessage', { name })}
        confirmLabel={t('common.delete')}
        pending={deleteCharacter.isPending}
        error={errorMessage(deleteCharacter.error)}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          deleteCharacter.mutate(id, {
            onSuccess: () => {
              setConfirming(false);
              onClose();
            },
          })
        }
      />
    </>
  );
}
