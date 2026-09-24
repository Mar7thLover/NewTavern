import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { FieldLabel } from '../../components/ui/field';
import { useCreateLorebook, useCreatePreset } from '../../lib/api';
import {
  studioPath,
  useCreateCharacter,
  useRecentEntities,
  type StudioKind,
} from '../../lib/api-studio';
import { LibraryHeader, QueryStatus, errorMessage, formatDate } from '../library/shared';
import { AutoTextarea } from './character/fields';
import type { StudioLocationState } from './StudioWorkbenchPage';

/**
 * 工作台入口（M6 §4.1）：一句话生成角色、新建三种实体、最近编辑。
 */
export function StudioHomePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const recent = useRecentEntities(16);
  const createCharacter = useCreateCharacter();
  const createPreset = useCreatePreset();
  const createLorebook = useCreateLorebook();
  const [idea, setIdea] = useState('');

  const busy = createCharacter.isPending || createPreset.isPending || createLorebook.isPending;
  const error = createCharacter.error ?? createPreset.error ?? createLorebook.error;

  const open = (kind: StudioKind, id: string, state?: StudioLocationState) =>
    void navigate(studioPath(kind, id), state ? { state } : undefined);

  const generate = () => {
    const text = idea.trim();
    if (!text || busy) return;
    createCharacter.mutate(
      { name: t('studio.home.newCharacterName') },
      { onSuccess: (row) => open('character', row.id, { generate: text }) },
    );
  };

  return (
    <div className="mx-auto max-w-4xl">
      <LibraryHeader title={t('nav.studio')} subtitle={t('studio.home.subtitle')} />

      <section className="mb-10">
        <FieldLabel htmlFor="studio-idea">{t('studio.home.ideaLabel')}</FieldLabel>
        <AutoTextarea
          id="studio-idea"
          value={idea}
          onChange={setIdea}
          minRows={3}
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

      <section className="mb-10">
        <h2 className="font-display mb-3 text-sm font-medium">{t('studio.home.createTitle')}</h2>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              createCharacter.mutate(
                { name: t('studio.home.newCharacterName') },
                { onSuccess: (row) => open('character', row.id) },
              )
            }
          >
            {t('studio.home.newCharacter')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => createPreset.mutate({}, { onSuccess: (row) => open('preset', row.id) })}
          >
            {t('studio.home.newPreset')}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              createLorebook.mutate({}, { onSuccess: (row) => open('lorebook', row.id) })
            }
          >
            {t('studio.home.newLorebook')}
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          {t('studio.home.openHint')}{' '}
          <Link to="/characters" className="text-ink-link underline underline-offset-2">
            {t('nav.characters')}
          </Link>{' '}
          ·{' '}
          <Link to="/presets" className="text-ink-link underline underline-offset-2">
            {t('nav.presets')}
          </Link>{' '}
          ·{' '}
          <Link to="/lorebooks" className="text-ink-link underline underline-offset-2">
            {t('nav.lorebooks')}
          </Link>
        </p>
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {errorMessage(error)}
          </p>
        )}
      </section>

      <section>
        <h2 className="font-display mb-3 text-sm font-medium">{t('studio.home.recentTitle')}</h2>
        <QueryStatus
          isPending={recent.isPending}
          error={recent.error}
          onRetry={() => void recent.refetch()}
        />
        {recent.data && recent.data.length === 0 && (
          <p className="text-sm text-ink-3">{t('studio.home.recentEmpty')}</p>
        )}
        {(recent.data ?? []).length > 0 && (
          <ul className="edge-rule divide-y divide-edge border-y">
            {(recent.data ?? []).map((item) => (
              <li key={`${item.type}:${item.id}`}>
                <Link
                  to={studioPath(item.type, item.id)}
                  className="focus-ring-inset flex items-center gap-3 px-1 py-2.5 text-sm hover:text-accent"
                >
                  <Badge variant="outline" className="w-14 justify-center">
                    {t(`studio.kinds.${item.type}`)}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="hidden shrink-0 text-[11px] text-ink-3 sm:inline">
                    v{item.version} · {t(`studio.versions.author.${item.author}`)}
                  </span>
                  <span className="shrink-0 text-[11px] text-ink-3 tabular-nums">
                    {formatDate(item.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
