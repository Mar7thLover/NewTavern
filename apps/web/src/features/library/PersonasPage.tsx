import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import {
  useDefaultPersonaId,
  useDeletePersona,
  usePersonas,
  useSetDefaultPersonaId,
  type Persona,
} from '../../lib/api';
import { PersonaFormModal } from './PersonaFormModal';
import { Avatar, EmptyState, LibraryHeader, QueryStatus, errorMessage, formatDate } from './shared';

/** 表单目标：null 关闭，'new' 新建，否则编辑该档案 */
type FormTarget = null | 'new' | Persona;

export function PersonasPage() {
  const { t } = useTranslation();
  const personas = usePersonas();
  const defaultPersonaId = useDefaultPersonaId();
  const setDefaultPersonaId = useSetDefaultPersonaId();
  const deletePersona = useDeletePersona();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<Persona | null>(null);

  const list = personas.data ?? [];
  const defaultId = defaultPersonaId.data ?? null;

  return (
    <div className="mx-auto max-w-5xl">
      <LibraryHeader
        title={t('nav.personas')}
        subtitle={personas.data ? t('library.personas.count', { total: list.length }) : null}
        actions={
          list.length > 0 ? (
            <Button size="sm" onClick={() => setFormTarget('new')}>
              {t('library.personas.create')}
            </Button>
          ) : null
        }
      />

      <QueryStatus
        isPending={personas.isPending}
        error={personas.error}
        onRetry={() => void personas.refetch()}
      />

      {setDefaultPersonaId.error && (
        <p role="alert" className="mb-3 text-sm text-danger">
          {errorMessage(setDefaultPersonaId.error)}
        </p>
      )}

      {personas.data &&
        (list.length === 0 ? (
          <EmptyState
            kind="personas"
            title={t('library.personas.emptyTitle')}
            hint={t('library.personas.emptyHint', { macro: '{{user}}' })}
            action={
              <Button size="lg" onClick={() => setFormTarget('new')}>
                {t('library.personas.create')}
              </Button>
            }
          />
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((persona) => {
              const isDefault = persona.id === defaultId;
              return (
                <li
                  key={persona.id}
                  data-part="library-item"
                  data-kind="persona"
                  data-default={isDefault ? 'true' : 'false'}
                  className="rounded-card edge-rule flex min-w-0 flex-col border p-4 text-ink"
                >
                  <div className="flex items-center gap-3">
                    <Avatar
                      name={persona.name}
                      assetId={persona.avatarAssetId}
                      role="user"
                      className="size-11 shrink-0"
                      textClassName="text-lg"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate font-medium">{persona.name}</span>
                        {isDefault && (
                          <Badge title={t('library.personas.defaultHint')}>
                            {t('library.personas.defaultBadge')}
                          </Badge>
                        )}
                      </div>
                      {persona.title ? (
                        <div className="truncate text-xs text-ink-2">{persona.title}</div>
                      ) : (
                        <div className="truncate text-xs text-ink-3">
                          {t('common.updated')}: {formatDate(persona.updatedAt)}
                        </div>
                      )}
                    </div>
                  </div>
                  <p
                    className={
                      persona.description.trim()
                        ? 'mt-3 line-clamp-4 flex-1 text-sm break-words whitespace-pre-line text-ink-2'
                        : 'mt-3 flex-1 text-sm text-ink-3 italic'
                    }
                  >
                    {persona.description.trim() || t('library.personas.noDescription')}
                  </p>
                  {persona.descriptionPosition !== 'in_prompt' && (
                    <div className="mt-3">
                      <Badge variant="muted">
                        {t(`library.personas.positions.${persona.descriptionPosition}`)}
                        {persona.descriptionPosition === 'at_depth' ? ` · ${persona.depth}` : ''}
                      </Badge>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mr-auto"
                      disabled={setDefaultPersonaId.isPending || defaultPersonaId.isPending}
                      onClick={() => setDefaultPersonaId.mutate(isDefault ? null : persona.id)}
                    >
                      {isDefault
                        ? t('library.personas.unsetDefault')
                        : t('library.personas.setDefault')}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setFormTarget(persona)}>
                      {t('common.edit')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-danger hover:bg-danger-soft hover:text-danger"
                      onClick={() => {
                        deletePersona.reset();
                        setPendingDelete(persona);
                      }}
                    >
                      {t('common.delete')}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        ))}

      {formTarget !== null && (
        <PersonaFormModal
          key={formTarget === 'new' ? 'new' : formTarget.id}
          persona={formTarget === 'new' ? null : formTarget}
          onClose={() => setFormTarget(null)}
        />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        destructive
        title={t('library.personas.deleteTitle')}
        description={t('library.personas.deleteMessage', { name: pendingDelete?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={deletePersona.isPending}
        error={errorMessage(deletePersona.error)}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          if (!pendingDelete) return;
          deletePersona.mutate(pendingDelete.id, { onSuccess: () => setPendingDelete(null) });
        }}
      />
    </div>
  );
}
