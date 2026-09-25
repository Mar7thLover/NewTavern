import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Button, buttonVariants } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/field';
import {
  lorebookOpenerTotal,
  useCharacters,
  useCreateChat,
  useDefaultPersonaId,
  useLorebooks,
  usePersonas,
  type CharacterSummary,
  type CreateChatInput,
  type LorebookSummary,
} from '../../lib/api';
import { EntityCard } from '../library/EntityCard';
import { EmptyState, QueryStatus, errorMessage } from '../library/shared';

export interface StartScreenProps {
  onCreated: (chatId: string) => void;
}

/**
 * 一张卡 = 一个开场。角色卡与世界书同在一个网格里，点哪张就用哪张开一段新对话：
 * 有开场白的书把开场白铺成 swipe，没有的就挂上这本书从空白开始。
 */
type StartItem =
  | { kind: 'character'; id: string; name: string; character: CharacterSummary }
  | { kind: 'lorebook'; id: string; name: string; book: LorebookSummary };

/** 「选择角色开始」：角色卡与世界书同格 + 空白对话 */
export function StartScreen({ onCreated }: StartScreenProps) {
  const { t } = useTranslation();
  const characters = useCharacters();
  const lorebooks = useLorebooks();
  const createChat = useCreateChat();
  const [query, setQuery] = useState('');
  const personas = usePersonas();
  const defaultPersona = useDefaultPersonaId();
  /** null = 跟随默认档案；'' = 不使用档案 */
  const [personaChoice, setPersonaChoice] = useState<string | null>(null);

  const personaList = personas.data ?? [];
  const personaReady = personas.data !== undefined && defaultPersona.data !== undefined;
  const defaultPersonaId =
    defaultPersona.data && personaList.some((persona) => persona.id === defaultPersona.data)
      ? defaultPersona.data
      : '';
  const selectedPersonaId = personaChoice ?? defaultPersonaId;

  /** 角色卡在前、世界书在后；每本书都能开场，不要求自带开场白 */
  const items: StartItem[] = [
    ...(characters.data ?? []).map((character): StartItem => ({
      kind: 'character',
      id: character.id,
      name: character.name,
      character,
    })),
    ...(lorebooks.data ?? []).map((book): StartItem => ({
      kind: 'lorebook',
      id: book.id,
      name: book.name,
      book,
    })),
  ];
  const needle = query.trim().toLowerCase();
  const list = items.filter((item) => needle === '' || item.name.toLowerCase().includes(needle));

  /** item 为 null = 空白对话 */
  const start = (item: StartItem | null) => {
    if (createChat.isPending) return;
    const input: CreateChatInput =
      item === null
        ? {}
        : item.kind === 'character'
          ? { characterIds: [item.id] }
          : { lorebookIds: [item.id] };
    // 档案列表与默认设置都到了才显式传；否则不带字段，由服务端套用默认档案
    if (personaReady) input.personaId = selectedPersonaId || null;
    createChat.mutate(input, {
      onSuccess: (chat) => onCreated(chat.id),
    });
  };

  const ready = characters.data !== undefined && lorebooks.data !== undefined;

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
          {personaList.length > 0 && (
            <div data-part="start-persona" className="w-full min-w-0 sm:w-auto sm:max-w-72">
              <Select
                aria-label={t('chat.start.personaLabel')}
                value={selectedPersonaId}
                disabled={createChat.isPending || !personaReady}
                onChange={(event) => setPersonaChoice(event.target.value)}
              >
                <option value="">{t('chat.start.personaNone')}</option>
                {personaList.map((persona) => (
                  <option key={persona.id} value={persona.id}>
                    {t('chat.start.personaOption', { name: persona.name })}
                  </option>
                ))}
              </Select>
            </div>
          )}
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

          {ready &&
            (items.length === 0 ? (
              // 没有角色卡不等于开不了场：世界书同样能开，所以两条路都给出来
              <EmptyState
                kind="characters"
                title={t('chat.start.emptyTitle')}
                hint={t('chat.start.emptyHint')}
                action={
                  <div className="flex flex-wrap items-center justify-center gap-2">
                    <Link to="/characters" className={buttonVariants({ size: 'lg' })}>
                      {t('nav.characters')}
                    </Link>
                    <Link
                      to="/lorebooks"
                      className={buttonVariants({ size: 'lg', variant: 'outline' })}
                    >
                      {t('nav.lorebooks')}
                    </Link>
                  </div>
                }
              />
            ) : (
              <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <StartCard
                      item={item}
                      disabled={createChat.isPending}
                      onStart={() => start(item)}
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

/** 开场卡：卡面见 `EntityCard`；世界书没有画像，用一行小字标出它是书（带开场白数） */
function StartCard({
  item,
  disabled,
  onStart,
}: {
  item: StartItem;
  disabled: boolean;
  onStart: () => void;
}) {
  const { t } = useTranslation();
  const openerCount = item.kind === 'lorebook' ? lorebookOpenerTotal(item.book) : 0;
  return (
    <EntityCard
      name={item.name}
      kind={item.kind}
      avatarAssetId={item.kind === 'character' ? item.character.avatarAssetId : null}
      {...(item.kind === 'lorebook'
        ? {
            kicker:
              openerCount > 0
                ? t('chat.start.lorebookKicker', { count: openerCount })
                : t('chat.start.lorebookKickerPlain'),
          }
        : {})}
      disabled={disabled}
      onClick={onStart}
    />
  );
}
