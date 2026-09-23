import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import type { MigrationSelect, StInventory } from '../../lib/api-migration';
import { cn } from '../../lib/utils';

type ListCategory = 'characters' | 'chats' | 'presets' | 'lorebooks' | 'personas';

interface ReviewItem {
  key: string;
  label: string;
  meta?: ReactNode;
  exists: boolean;
  error?: string;
}

/** 新项默认勾选；已在库中与读不出来的默认不勾 */
function initialSelection(inventory: StInventory): Record<ListCategory, Set<string>> {
  const fresh = <T extends { exists: boolean; error?: string }>(
    items: T[],
    key: (item: T) => string,
  ) => new Set(items.filter((item) => !item.exists && !item.error).map(key));
  return {
    characters: fresh(inventory.characters, (item) => item.file),
    chats: fresh(inventory.chats, (item) => item.file),
    presets: fresh(inventory.presets, (item) => item.file),
    lorebooks: fresh(inventory.lorebooks, (item) => item.file),
    personas: fresh(inventory.personas, (item) => item.avatar),
  };
}

export function MigrationReview({
  inventory,
  onBack,
  onStart,
}: {
  inventory: StInventory;
  onBack: () => void;
  onStart: (select: MigrationSelect) => void;
}) {
  const { t } = useTranslation();
  const [selection, setSelection] = useState(() => initialSelection(inventory));
  const [regex, setRegex] = useState(inventory.regex.newCount > 0);
  const helperScripts = inventory.scripts ?? { count: 0, newCount: 0, globalEnabled: true };
  const [scripts, setScripts] = useState(helperScripts.newCount > 0);
  const backgroundInventory = inventory.backgrounds ?? { count: 0, newCount: 0 };
  const [backgrounds, setBackgrounds] = useState(backgroundInventory.newCount > 0);
  const [worldInfo, setWorldInfo] = useState(inventory.worldInfo.hasSettings);
  const [defaultPersona, setDefaultPersona] = useState(inventory.defaultPersona !== null);

  const characterName = (file: string | null) =>
    file ? inventory.characters.find((item) => item.file === file)?.name : undefined;

  const lists: Record<ListCategory, ReviewItem[]> = {
    characters: inventory.characters.map((item) => ({
      key: item.file,
      label: item.name,
      meta:
        item.chatCount > 0
          ? `${item.file} · ${t('migration.review.chatCount', { count: item.chatCount })}`
          : item.file,
      exists: item.exists,
      ...(item.error ? { error: item.error } : {}),
    })),
    chats: inventory.chats.map((item) => ({
      key: item.file,
      label: item.title,
      meta: characterName(item.characterFile) ?? t('migration.review.noCharacter'),
      exists: item.exists,
    })),
    presets: inventory.presets.map((item) => ({
      key: item.file,
      label: item.name,
      exists: item.exists,
      ...(item.error ? { error: item.error } : {}),
    })),
    lorebooks: inventory.lorebooks.map((item) => ({
      key: item.file,
      label: item.name,
      meta: t('migration.review.entryCount', { count: item.entryCount }),
      exists: item.exists,
      ...(item.error ? { error: item.error } : {}),
    })),
    personas: inventory.personas.map((item) => ({
      key: item.avatar,
      label: item.name,
      meta: item.avatar,
      exists: item.exists,
    })),
  };

  const toggle = (category: ListCategory, key: string, checked: boolean) =>
    setSelection((prev) => {
      const next = new Set(prev[category]);
      if (checked) next.add(key);
      else next.delete(key);
      return { ...prev, [category]: next };
    });

  const toggleAll = (category: ListCategory, checked: boolean) =>
    setSelection((prev) => ({
      ...prev,
      [category]: new Set(
        checked ? lists[category].filter((item) => !item.error).map((item) => item.key) : [],
      ),
    }));

  const defaultPersonaName =
    inventory.personas.find((item) => item.avatar === inventory.defaultPersona)?.name ??
    inventory.defaultPersona ??
    '';

  const count =
    selection.characters.size +
    selection.chats.size +
    selection.presets.size +
    selection.lorebooks.size +
    selection.personas.size +
    (regex ? inventory.regex.newCount : 0) +
    (scripts ? helperScripts.newCount : 0) +
    (worldInfo ? 1 : 0) +
    (defaultPersona ? 1 : 0) +
    (backgrounds ? backgroundInventory.count : 0);

  const submit = () =>
    onStart({
      characters: [...selection.characters],
      chats: [...selection.chats],
      presets: [...selection.presets],
      lorebooks: [...selection.lorebooks],
      personas: [...selection.personas],
      regex,
      scripts,
      worldInfo,
      defaultPersona,
      backgrounds,
    });

  const settingsTotal =
    (inventory.regex.count > 0 ? 1 : 0) +
    (helperScripts.count > 0 ? 1 : 0) +
    (inventory.worldInfo.hasSettings ? 1 : 0) +
    (inventory.defaultPersona !== null ? 1 : 0) +
    (backgroundInventory.count > 0 ? 1 : 0);
  const settingsSelected =
    (regex ? 1 : 0) + (scripts ? 1 : 0) + (worldInfo ? 1 : 0) + (defaultPersona ? 1 : 0) + (backgrounds ? 1 : 0);

  return (
    <div data-part="migration-review" className="space-y-10">
      <p className="text-xs break-all text-ink-3">
        {t('migration.review.from', { path: inventory.root })}
      </p>

      {(['characters', 'chats', 'lorebooks', 'presets', 'personas'] as const).map((category) => (
        <CategoryList
          key={category}
          category={category}
          items={lists[category]}
          selected={selection[category]}
          onToggle={(key, checked) => toggle(category, key, checked)}
          onToggleAll={(checked) => toggleAll(category, checked)}
        />
      ))}

      <section data-part="migration-category" data-category="settings" className="space-y-1">
        <CategoryHeader
          title={t('migration.review.categories.settings')}
          selected={settingsSelected}
          total={settingsTotal}
        />
        <ul className="divide-y divide-edge">
          <CheckRow
            checked={regex && inventory.regex.newCount > 0}
            disabled={inventory.regex.newCount === 0}
            onChange={setRegex}
            label={t('migration.review.regex')}
            meta={
              inventory.regex.count > 0
                ? t('migration.review.regexHint', inventory.regex)
                : t('migration.review.none')
            }
          />
          <CheckRow
            checked={scripts && helperScripts.newCount > 0}
            disabled={helperScripts.newCount === 0}
            onChange={setScripts}
            label={t('scripts.migration.label')}
            meta={
              helperScripts.count > 0
                ? t('scripts.migration.hint', helperScripts) +
                  (helperScripts.globalEnabled ? '' : t('scripts.migration.globalOff'))
                : t('migration.review.none')
            }
          />
          <CheckRow
            checked={backgrounds && backgroundInventory.newCount > 0}
            disabled={backgroundInventory.newCount === 0}
            onChange={setBackgrounds}
            label={t('backgrounds.migration.label')}
            meta={
              backgroundInventory.count > 0
                ? t('backgrounds.migration.hint', backgroundInventory)
                : t('migration.review.none')
            }
          />
          <CheckRow
            checked={worldInfo && inventory.worldInfo.hasSettings}
            disabled={!inventory.worldInfo.hasSettings}
            onChange={setWorldInfo}
            label={t('migration.review.worldInfo')}
            meta={
              !inventory.worldInfo.hasSettings
                ? t('migration.review.none')
                : inventory.worldInfo.globalBooks.length > 0
                  ? t('migration.review.worldInfoHint', {
                      books: inventory.worldInfo.globalBooks.join('、'),
                    })
                  : t('migration.review.worldInfoNoBooks')
            }
          />
          <CheckRow
            checked={defaultPersona && inventory.defaultPersona !== null}
            disabled={inventory.defaultPersona === null}
            onChange={setDefaultPersona}
            label={t('migration.review.defaultPersona')}
            meta={
              inventory.defaultPersona === null
                ? t('migration.review.none')
                : t('migration.review.defaultPersonaHint', { name: defaultPersonaName })
            }
          />
        </ul>
      </section>

      <p data-part="migration-skipped" className="text-xs leading-relaxed text-ink-3">
        {t('migration.review.skipped', {
          instruct: inventory.skipped.instruct,
          contextTemplates: inventory.skipped.context,
          themes: inventory.skipped.themes,
          quickReplies: inventory.skipped.quickReplies,
          groupChats: inventory.groupChats,
        })}
      </p>

      <div
        data-part="migration-start-bar"
        className="surface-raised edge-rule rounded-card sticky bottom-3 z-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border px-4 py-3 md:bottom-5"
      >
        <p role="status" className="me-auto min-w-0 text-xs text-ink-2">
          {count === 0 ? t('migration.review.nothing') : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={onBack}>
            {t('migration.review.back')}
          </Button>
          <Button size="sm" disabled={count === 0} onClick={submit}>
            {t('migration.review.start', { count })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function CategoryHeader({
  title,
  selected,
  total,
  allChecked,
  onToggleAll,
}: {
  title: string;
  selected: number;
  total: number;
  allChecked?: boolean | 'mixed';
  onToggleAll?: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = allChecked === 'mixed';
  }, [allChecked]);
  return (
    <div className="edge-rule flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b pb-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="flex items-center gap-4 text-xs text-ink-2">
        <span className="tabular-nums">{t('migration.review.selected', { selected, total })}</span>
        {onToggleAll && total > 0 && (
          <label className="flex cursor-pointer items-center gap-1.5 hover:text-ink">
            <input
              ref={ref}
              type="checkbox"
              className="size-3.5 shrink-0 accent-primary"
              checked={allChecked === true}
              onChange={(event) => onToggleAll(event.target.checked)}
            />
            {t('migration.review.selectAll')}
          </label>
        )}
      </div>
    </div>
  );
}

function CategoryList({
  category,
  items,
  selected,
  onToggle,
  onToggleAll,
}: {
  category: ListCategory;
  items: ReviewItem[];
  selected: Set<string>;
  onToggle: (key: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  const selectable = items.filter((item) => !item.error).length;
  const allChecked =
    selected.size === 0 ? false : selected.size >= selectable ? true : ('mixed' as const);
  return (
    <section data-part="migration-category" data-category={category} className="space-y-1">
      <CategoryHeader
        title={t(`migration.review.categories.${category}`)}
        selected={selected.size}
        total={items.length}
        allChecked={allChecked}
        onToggleAll={onToggleAll}
      />
      {items.length === 0 ? (
        <p className="py-2 text-xs text-ink-3">{t('migration.review.none')}</p>
      ) : (
        <ul className="max-h-96 divide-y divide-edge overflow-y-auto">
          {items.map((item) => (
            <CheckRow
              key={item.key}
              checked={selected.has(item.key)}
              disabled={Boolean(item.error)}
              onChange={(checked) => onToggle(item.key, checked)}
              label={item.label}
              meta={item.meta}
              exists={item.exists}
              error={item.error}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function CheckRow({
  checked,
  disabled,
  onChange,
  label,
  meta,
  exists,
  error,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  meta?: ReactNode;
  exists?: boolean;
  error?: string | undefined;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-part="migration-item"
      data-exists={exists ? 'true' : 'false'}
      data-error={error ? 'true' : 'false'}
    >
      <label
        className={cn(
          'flex items-start gap-2.5 px-1 py-2 text-sm',
          disabled ? 'cursor-default' : 'cursor-pointer hover:text-accent',
        )}
      >
        <input
          type="checkbox"
          className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-40"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className={cn('min-w-0 flex-1', disabled && 'text-ink-3')}>
          <span className="block break-words">{label}</span>
          {meta && <span className="mt-0.5 block text-xs break-all text-ink-3">{meta}</span>}
        </span>
        {exists && (
          <Badge variant="outline" className="mt-0.5">
            {t('migration.review.exists')}
          </Badge>
        )}
        {error && (
          <span className="mt-0.5 shrink-0 text-xs text-danger" title={error}>
            {t('migration.review.unreadable')}
          </span>
        )}
      </label>
    </li>
  );
}
