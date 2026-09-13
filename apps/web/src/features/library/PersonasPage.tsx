import { useId, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../components/ConfirmDialog';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/ui/button';
import {
  useCreatePersona,
  useDeletePersona,
  usePersonas,
  useUpdatePersona,
  type Persona,
} from '../../lib/api';
import { Avatar, EmptyState, LibraryHeader, QueryStatus, errorMessage, formatDate } from './shared';

/** 表单目标：null 关闭，'new' 新建，否则编辑该档案 */
type FormTarget = null | 'new' | Persona;

const FIELD_CLASS =
  'w-full rounded-md border border-input bg-background px-3 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

export function PersonasPage() {
  const { t } = useTranslation();
  const personas = usePersonas();
  const deletePersona = useDeletePersona();
  const [formTarget, setFormTarget] = useState<FormTarget>(null);
  const [pendingDelete, setPendingDelete] = useState<Persona | null>(null);

  const list = personas.data ?? [];

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

      {personas.data &&
        (list.length === 0 ? (
          <EmptyState
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
            {list.map((persona) => (
              <li
                key={persona.id}
                className="flex flex-col rounded-lg border border-border bg-card p-4 text-card-foreground"
              >
                <div className="flex items-center gap-3">
                  <Avatar
                    name={persona.name}
                    assetId={persona.avatarAssetId}
                    className="size-11 rounded-full"
                    textClassName="text-lg"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{persona.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {t('common.updated')}: {formatDate(persona.updatedAt)}
                    </div>
                  </div>
                </div>
                <p
                  className={
                    persona.description.trim()
                      ? 'mt-3 line-clamp-4 flex-1 text-sm break-words whitespace-pre-line text-muted-foreground'
                      : 'mt-3 flex-1 text-sm text-muted-foreground/70 italic'
                  }
                >
                  {persona.description.trim() || t('library.personas.noDescription')}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <Button variant="outline" size="sm" onClick={() => setFormTarget(persona)}>
                    {t('common.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      deletePersona.reset();
                      setPendingDelete(persona);
                    }}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
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

function PersonaFormModal({ persona, onClose }: { persona: Persona | null; onClose: () => void }) {
  const { t } = useTranslation();
  const formId = useId();
  const createPersona = useCreatePersona();
  const updatePersona = useUpdatePersona();
  const [name, setName] = useState(persona?.name ?? '');
  const [description, setDescription] = useState(persona?.description ?? '');
  const [nameError, setNameError] = useState(false);

  const mutation = persona ? updatePersona : createPersona;
  const pending = mutation.isPending;
  const serverError = errorMessage(mutation.error);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(true);
      return;
    }
    const input = { name: trimmed, description };
    if (persona) {
      updatePersona.mutate({ id: persona.id, ...input }, { onSuccess: onClose });
    } else {
      createPersona.mutate(input, { onSuccess: onClose });
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      dismissible={!pending}
      title={persona ? t('library.personas.editTitle') : t('library.personas.createTitle')}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose} disabled={pending}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form={formId} size="sm" disabled={pending}>
            {pending ? t('common.processing') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={handleSubmit} className="space-y-4" noValidate>
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-name`} className="text-sm font-medium">
            {t('library.personas.name')}
          </label>
          <input
            id={`${formId}-name`}
            value={name}
            autoFocus
            maxLength={200}
            disabled={pending}
            placeholder={t('library.personas.namePlaceholder')}
            aria-invalid={nameError}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(false);
            }}
            className={`${FIELD_CLASS} h-9 ${nameError ? 'border-destructive' : ''}`}
          />
          {nameError && (
            <p className="text-xs text-destructive">{t('library.personas.nameRequired')}</p>
          )}
        </div>
        <div className="space-y-1.5">
          <label htmlFor={`${formId}-description`} className="text-sm font-medium">
            {t('library.personas.description')}
          </label>
          <textarea
            id={`${formId}-description`}
            value={description}
            rows={10}
            disabled={pending}
            placeholder={t('library.personas.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
            className={`${FIELD_CLASS} min-h-32 resize-y py-2 leading-relaxed`}
          />
        </div>
        {serverError && (
          <p role="alert" className="text-sm text-destructive">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
