import { Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { Badge } from '../../../components/ui/badge';
import { Button } from '../../../components/ui/button';
import { FieldLabel, Input, Select, Textarea } from '../../../components/ui/field';
import { IconButton } from '../../../components/ui/icon-button';
import {
  useDeletePromptLibraryItem,
  usePromptLibrary,
  useSavePromptLibraryItem,
  type PromptLibraryItem,
  type PromptRole,
} from '../../../lib/api-studio';
import { cn } from '../../../lib/utils';
import { QueryStatus, errorMessage } from '../../library/shared';
import { insertAtCursor, useInsertTarget } from '../insert-target';

const ROLES: PromptRole[] = ['system', 'user', 'assistant'];

interface FormState {
  id: string | null;
  name: string;
  content: string;
  role: PromptRole | '';
  tags: string;
}

const EMPTY_FORM: FormState = { id: null, name: '', content: '', role: '', tags: '' };

/**
 * 提示库页签（M6 §4.4）：搜索、标签过滤、新建 / 编辑 / 删除；「插入」——
 * 插到编辑器栏里最近聚焦的文本框光标处；预设另有「作为新条目」。
 */
export function PromptLibraryTab({
  onInsertAsEntry,
}: {
  /** 预设：把片段插为新的提示词条目 */
  onInsertAsEntry?: (item: PromptLibraryItem) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState('');
  const list = usePromptLibrary(query.trim(), tag);
  const all = usePromptLibrary('', '');
  const save = useSavePromptLibraryItem();
  const remove = useDeletePromptLibraryItem();
  const target = useInsertTarget();
  const [form, setForm] = useState<FormState | null>(null);
  const [deleting, setDeleting] = useState<PromptLibraryItem | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const tags = useMemo(
    () => [...new Set((all.data ?? []).flatMap((item) => item.tags))].sort(),
    [all.data],
  );

  const submit = () => {
    if (!form || form.name.trim() === '') return;
    save.mutate(
      {
        id: form.id,
        input: {
          name: form.name.trim(),
          content: form.content,
          role: form.role === '' ? null : form.role,
          tags: form.tags
            .split(/[,，]/)
            .map((item) => item.trim())
            .filter(Boolean),
        },
      },
      { onSuccess: () => setForm(null) },
    );
  };

  const insert = (item: PromptLibraryItem) => {
    if (insertAtCursor(item.content)) setFlash(item.id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="edge-rule shrink-0 space-y-2 border-b px-3 py-2.5">
        <div className="flex gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-3"
            />
            <Input
              size="sm"
              className="ps-7"
              value={query}
              placeholder={t('studio.library.search')}
              aria-label={t('studio.library.search')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              save.reset();
              setForm(EMPTY_FORM);
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('studio.library.new')}
          </Button>
        </div>
        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {['', ...tags].map((item) => (
              <button
                key={item || '__all'}
                type="button"
                aria-pressed={tag === item}
                onClick={() => setTag(item)}
                className={cn(
                  'focus-ring cursor-pointer px-2 py-0.5 text-[11px]',
                  tag === item ? 'chip-accent' : 'chip-outline',
                )}
              >
                {item || t('studio.library.allTags')}
              </button>
            ))}
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-ink-3">
          {target
            ? t('studio.library.insertTarget', { name: target.label || t('studio.library.field') })
            : t('studio.library.insertHint')}
        </p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {form && (
          <PromptForm
            form={form}
            onChange={setForm}
            onCancel={() => setForm(null)}
            onSubmit={submit}
            saving={save.isPending}
            error={errorMessage(save.error)}
          />
        )}
        <div className="p-3">
          <QueryStatus
            isPending={list.isPending}
            error={list.error}
            onRetry={() => void list.refetch()}
          />
        </div>
        {list.data && list.data.length === 0 && !form && (
          <p className="px-3 text-sm text-ink-3">
            {query || tag ? t('studio.library.noMatch') : t('studio.library.empty')}
          </p>
        )}
        <ul className="divide-y divide-edge">
          {(list.data ?? []).map((item) => (
            <li key={item.id} className="space-y-1.5 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.name}</span>
                {item.role && <Badge variant="outline">{t(`studio.roles.${item.role}`)}</Badge>}
                <IconButton
                  label={t('common.edit')}
                  size="xs"
                  onClick={() => {
                    save.reset();
                    setForm({
                      id: item.id,
                      name: item.name,
                      content: item.content,
                      role: item.role ?? '',
                      tags: item.tags.join(', '),
                    });
                  }}
                >
                  <Pencil aria-hidden />
                </IconButton>
                <IconButton
                  label={t('common.delete')}
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    remove.reset();
                    setDeleting(item);
                  }}
                >
                  <Trash2 aria-hidden />
                </IconButton>
              </div>
              <p className="line-clamp-3 text-xs leading-relaxed break-words whitespace-pre-wrap text-ink-2">
                {item.content || '—'}
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {item.tags.map((name) => (
                  <Badge key={name} variant="muted">
                    {name}
                  </Badge>
                ))}
                <span className="ms-auto flex gap-1.5">
                  {onInsertAsEntry && (
                    <Button variant="ghost" size="sm" onClick={() => onInsertAsEntry(item)}>
                      {t('studio.library.asEntry')}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!target}
                    // 按下时不抢焦点：光标留在编辑器的文本框里
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insert(item)}
                  >
                    {flash === item.id ? t('studio.library.inserted') : t('studio.library.insert')}
                  </Button>
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        destructive
        title={t('studio.library.deleteTitle')}
        description={t('studio.library.deleteMessage', { name: deleting?.name ?? '' })}
        confirmLabel={t('common.delete')}
        pending={remove.isPending}
        error={errorMessage(remove.error)}
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) remove.mutate(deleting.id, { onSuccess: () => setDeleting(null) });
        }}
      />
    </div>
  );
}

function PromptForm({
  form,
  onChange,
  onCancel,
  onSubmit,
  saving,
  error,
}: {
  form: FormState;
  onChange: (form: FormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const id = useId();
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    onChange({ ...form, [key]: value });
  return (
    <form
      className="edge-rule space-y-3 border-b px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div className="min-w-0">
          <FieldLabel htmlFor={`${id}-name`}>{t('studio.library.name')}</FieldLabel>
          <Input
            id={`${id}-name`}
            size="sm"
            value={form.name}
            aria-invalid={form.name.trim() === ''}
            onChange={(event) => set('name', event.target.value)}
          />
        </div>
        <div className="w-28">
          <FieldLabel htmlFor={`${id}-role`}>{t('studio.library.role')}</FieldLabel>
          <Select
            id={`${id}-role`}
            size="sm"
            value={form.role}
            onChange={(event) => set('role', event.target.value as PromptRole | '')}
          >
            <option value="">{t('studio.library.roleNone')}</option>
            {ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`studio.roles.${role}`)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div>
        <FieldLabel htmlFor={`${id}-content`}>{t('studio.library.content')}</FieldLabel>
        <Textarea
          id={`${id}-content`}
          rows={5}
          value={form.content}
          onChange={(event) => set('content', event.target.value)}
        />
      </div>
      <div>
        <FieldLabel htmlFor={`${id}-tags`}>{t('studio.library.tags')}</FieldLabel>
        <Input
          id={`${id}-tags`}
          size="sm"
          value={form.tags}
          placeholder={t('studio.library.tagsPlaceholder')}
          onChange={(event) => set('tags', event.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={saving || form.name.trim() === ''}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}
