import { FilePlus2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, buttonVariants } from '../../components/ui/button';
import { Input } from '../../components/ui/field';
import { useCharacters, useCreateChat, type CharacterSummary } from '../../lib/api';
import { cn } from '../../lib/utils';
import { Avatar, EmptyState, QueryStatus, errorMessage } from '../library/shared';

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
    <div className="h-full overflow-x-hidden overflow-y-auto">
      <div className="mx-auto w-full max-w-4xl min-w-0 px-4 py-10 sm:px-6">
        <h1 className="text-2xl font-bold">{t('chat.start.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('chat.start.hint')}</p>

        <div className="mt-5 flex min-w-0 flex-wrap items-center gap-2">
          <Input
            value={query}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            onChange={(event) => setQuery(event.target.value)}
            className="h-9 w-full max-w-full min-w-0 sm:w-64"
          />
          <Button variant="outline" onClick={() => start(null)} disabled={createChat.isPending}>
            <FilePlus2 aria-hidden className="size-4" />
            {t('chat.start.blank')}
          </Button>
        </div>

        {createChat.error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
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
                    <button
                      type="button"
                      disabled={createChat.isPending}
                      onClick={() => start(character)}
                      className={cn(
                        'flex w-full cursor-pointer flex-col overflow-hidden rounded-xl border border-border bg-card text-left transition-colors hover:border-primary/60 hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                      )}
                    >
                      <Avatar
                        name={character.name}
                        assetId={character.avatarAssetId}
                        className="aspect-[3/4] w-full"
                        textClassName="text-4xl"
                      />
                      <span className="truncate p-2.5 text-sm font-medium">{character.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ))}
        </div>
      </div>
    </div>
  );
}
