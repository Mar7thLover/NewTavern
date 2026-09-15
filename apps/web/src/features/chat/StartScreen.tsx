import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/field';
import { assetUrl, useCharacters, useCreateChat, type CharacterSummary } from '../../lib/api';
import { EmptyState, QueryStatus, errorMessage } from '../library/shared';

export interface StartScreenProps {
  onCreated: (chatId: string) => void;
}

/** 「选择角色开始」：角色网格 + 空白对话 */
export function StartScreen({ onCreated }: StartScreenProps) {
  const { t } = useTranslation();
  const characters = useCharacters();
  const createChat = useCreateChat();
  const [query, setQuery] = useState('');

  const needle = query.trim().toLowerCase();
  const list = (characters.data ?? []).filter(
    (character) => needle === '' || character.name.toLowerCase().includes(needle),
  );

  const start = (character: CharacterSummary | null) => {
    if (createChat.isPending) return;
    createChat.mutate(character ? { characterIds: [character.id] } : {}, {
      onSuccess: (chat) => onCreated(chat.id),
    });
  };

  return (
    <div
      data-part="start-screen"
      className="surface-reading h-full overflow-x-hidden overflow-y-auto"
    >
      <div className="mx-auto w-full max-w-4xl min-w-0 px-4 py-12 sm:px-6">
        <div data-part="page-header">
          <h1 className="font-display text-[28px] leading-tight font-light tracking-tight">
            {t('chat.start.title')}
          </h1>
          <p className="mt-1.5 text-sm text-ink-2">{t('chat.start.hint')}</p>
        </div>

        <div className="mt-7 flex min-w-0 flex-wrap items-center gap-2">
          <Input
            value={query}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full max-w-full min-w-0 sm:w-64"
          />
          <Button variant="outline" onClick={() => start(null)} disabled={createChat.isPending}>
            {t('chat.start.blank')}
          </Button>
        </div>

        {createChat.error && (
          <p role="alert" className="mt-3 text-sm text-danger">
            {errorMessage(createChat.error)}
          </p>
        )}

        <div className="mt-6">
          <QueryStatus
            isPending={characters.isPending}
            error={characters.error}
            onRetry={() => void characters.refetch()}
          />

          {characters.data &&
            (characters.data.length === 0 ? (
              <EmptyState
                kind="characters"
                title={t('chat.start.noCharactersTitle')}
                hint={t('chat.start.noCharactersHint')}
                action={
                  <Link to="/characters" className={buttonVariants({ size: 'lg' })}>
                    {t('nav.characters')}
                  </Link>
                }
              />
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((character) => (
                  <li key={character.id}>
                    <CharacterCard
                      character={character}
                      disabled={createChat.isPending}
                      onStart={() => start(character)}
                    />
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * 角色卡：1px 线的 3:4 卡片，中间是 28/300 的姓名首字，下方是名字；悬停时线变墨色。
 * 有头像图时图片铺满上部，名字仍在卡片下方。
 */
function CharacterCard({
  character,
  disabled,
  onStart,
}: {
  character: CharacterSummary;
  disabled: boolean;
  onStart: () => void;
}) {
  const initial = Array.from(character.name.trim())[0]?.toUpperCase() ?? '?';
  return (
    <button
      type="button"
      data-part="character-card"
      disabled={disabled}
      onClick={onStart}
      className="rounded-card edge-rule surface-reading focus-ring flex aspect-[3/4] w-full cursor-pointer flex-col overflow-hidden border text-left transition-colors hover:border-ink disabled:opacity-50"
    >
      <span className="flex min-h-0 flex-1 items-center justify-center">
        {character.avatarAssetId ? (
          <img
            src={assetUrl(character.avatarAssetId)}
            alt=""
            loading="lazy"
            className="size-full object-cover"
          />
        ) : (
          <span
            aria-hidden
            data-part="character-card-initial"
            className="font-display text-[28px] leading-none font-light text-ink-story select-none"
          >
            {initial}
          </span>
        )}
      </span>
      <span
        data-part="character-card-name"
        className="truncate px-3 pb-3 text-sm font-medium text-ink"
      >
        {character.name}
      </span>
    </button>
  );
}
