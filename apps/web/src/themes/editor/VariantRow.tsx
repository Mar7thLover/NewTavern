import { FileUp, Pencil, Plus } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useSaveThemeVariants, useThemeVariants } from './variants-api';
import { VariantEditor } from './VariantEditor';
import { useUiStore } from '../../app/store/ui';
import { Button } from '../../components/ui/button';
import { IconButton } from '../../components/ui/icon-button';
import { cn } from '../../lib/utils';
import { THEMES, type ThemeMeta } from '../registry';
import {
  VARIANT_FORMAT,
  newVariantId,
  parseVariant,
  variantFileName,
  type ThemeVariant,
  type VariantIssue,
} from '../variants';

/** 颜色点：变体里最能代表它的三个槽位（有就画） */
const DOT_SLOTS = ['--canvas', '--reading', '--accent', '--primary', '--ink'];

function download(variant: ThemeVariant) {
  const blob = new Blob([JSON.stringify(variant, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = variantFileName(variant);
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 外观页世界预览卡下方的「变体」一行（M4（二）§C.3）：原版 + 这个世界的变体小卡 + 派生 / 导入。
 * 编辑器在右侧抽屉里。
 */
export function VariantRow({ theme }: { theme: ThemeMeta }) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const variants = useThemeVariants();
  const save = useSaveThemeVariants();
  const variantId = useUiStore((s) => s.variantId);
  const setVariantId = useUiStore((s) => s.setVariantId);
  const [editing, setEditing] = useState<{ variant: ThemeVariant; saved: boolean } | null>(null);
  const [issues, setIssues] = useState<{ errors: VariantIssue[]; warnings: VariantIssue[] } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const all = variants.data ?? [];
  const mine = all.filter((variant) => variant.base === theme.id);
  const worldName = zh ? theme.name.zh : theme.name.en;

  const persist = (list: ThemeVariant[]) => save.mutateAsync(list);

  const derive = () =>
    setEditing({
      variant: {
        format: VARIANT_FORMAT,
        id: newVariantId(),
        name: t('themeVariants.newName', { world: worldName }),
        base: theme.id,
        slots: {},
        options: {},
      },
      saved: false,
    });

  const onSave = async (variant: ThemeVariant) => {
    const exists = all.some((item) => item.id === variant.id);
    await persist(exists ? all.map((item) => (item.id === variant.id ? variant : item)) : [...all, variant]);
    setVariantId(variant.id);
    setEditing(null);
  };

  const onDelete = async (variant: ThemeVariant) => {
    await persist(all.filter((item) => item.id !== variant.id));
    if (variantId === variant.id) setVariantId(null);
    setEditing(null);
  };

  const onImport = async (file: File) => {
    let json: unknown;
    try {
      json = JSON.parse(await file.text());
    } catch {
      setIssues({ errors: [{ code: 'not_object' }], warnings: [] });
      return;
    }
    const parsed = parseVariant(json, { themes: THEMES, takenIds: new Set(all.map((item) => item.id)) });
    setIssues({ errors: parsed.errors, warnings: parsed.warnings });
    if (!parsed.variant) return;
    await persist([...all, parsed.variant]);
    // 导入的是别的世界的变体：切过去住进它
    if (parsed.variant.base !== useUiStore.getState().themeId) {
      useUiStore.getState().setThemeId(parsed.variant.base);
    }
    setVariantId(parsed.variant.id);
  };

  const describe = (issue: VariantIssue) =>
    [
      t(`themeVariants.issues.${issue.code}`),
      issue.path ? `（${issue.path}）` : '',
      issue.detail && issue.code === 'slot_value' ? `：${t(`themeVariants.problems.${issue.detail}`)}` : '',
    ].join('');

  return (
    <div data-part="variant-row" className="space-y-2">
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void onImport(file);
        }}
      />
      <ul className="flex flex-wrap items-center gap-2">
        <li>
          <VariantChip
            label={t('themeVariants.original')}
            active={!mine.some((item) => item.id === variantId)}
            onSelect={() => setVariantId(null)}
          />
        </li>
        {mine.map((variant) => (
          <li key={variant.id} className="flex items-center">
            <VariantChip
              label={variant.name}
              active={variant.id === variantId}
              dots={DOT_SLOTS.map((slot) => variant.slots.light?.[slot] ?? variant.slots.dark?.[slot]).filter(
                (value): value is string => Boolean(value),
              ).slice(0, 3)}
              onSelect={() => setVariantId(variant.id)}
            />
            <IconButton
              size="xs"
              label={t('themeVariants.edit', { name: variant.name })}
              onClick={() => setEditing({ variant, saved: true })}
            >
              <Pencil aria-hidden />
            </IconButton>
          </li>
        ))}
        <li>
          <Button size="sm" variant="ghost" onClick={derive}>
            <Plus aria-hidden className="size-3.5" />
            {t('themeVariants.derive')}
          </Button>
        </li>
        <li>
          <Button size="sm" variant="ghost" onClick={() => fileInput.current?.click()}>
            <FileUp aria-hidden className="size-3.5" />
            {t('themeVariants.import')}
          </Button>
        </li>
      </ul>

      {issues && (issues.errors.length > 0 || issues.warnings.length > 0) && (
        <div data-part="variant-issues" role="status" className="space-y-1 text-xs">
          {issues.errors.length > 0 && <p className="text-danger">{t('themeVariants.importFailed')}</p>}
          <ul className="list-inside list-disc space-y-0.5">
            {issues.errors.map((issue, index) => (
              <li key={`e${index}`} className="text-danger">
                {describe(issue)}
              </li>
            ))}
            {issues.warnings.map((issue, index) => (
              <li key={`w${index}`} className="text-ink-2">
                {describe(issue)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {save.error && (
        <p role="alert" className="text-xs text-danger">
          {save.error instanceof Error ? save.error.message : String(save.error)}
        </p>
      )}

      {editing && (
        <VariantEditor
          open
          theme={theme}
          variant={editing.variant}
          saved={editing.saved}
          onClose={() => setEditing(null)}
          onSave={(variant) => void onSave(variant)}
          onDelete={() => void onDelete(editing.variant)}
          onExport={download}
          onDuplicate={(variant) =>
            setEditing({
              variant: {
                ...variant,
                id: newVariantId(),
                name: t('themeVariants.copyName', { name: variant.name }),
              },
              saved: false,
            })
          }
        />
      )}
    </div>
  );
}

function VariantChip({
  label,
  active,
  dots = [],
  onSelect,
}: {
  label: string;
  active: boolean;
  dots?: string[];
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-part="variant-chip"
      data-active={active}
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        'action-quiet focus-ring inline-flex h-8 max-w-48 cursor-pointer items-center gap-1.5 px-2.5 text-xs',
        active ? 'border-ink font-medium text-ink' : 'text-ink-2',
      )}
    >
      {dots.length > 0 && (
        <span aria-hidden className="flex -space-x-1">
          {dots.map((color, index) => (
            <span
              key={index}
              className="rounded-pill edge-rule size-3 border"
              style={{ backgroundColor: color }}
            />
          ))}
        </span>
      )}
      <span className="truncate">{label}</span>
    </button>
  );
}
