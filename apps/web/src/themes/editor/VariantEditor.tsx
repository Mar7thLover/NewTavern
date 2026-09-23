import { RotateCcw } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../components/ui/button';
import { Drawer } from '../../components/ui/drawer';
import { FieldLabel, Input, Select } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Segmented } from '../../components/ui/segmented';
import { Switch, SwitchRow } from '../../components/ui/switch';
import { PanelSection } from '../../features/chat/SessionSettings';
import { setDraftVariantStyle } from '../apply';
import { ThemePreviewRoot } from '../preview';
import { resolveThemeOptions, type ThemeMeta, type ThemeMode } from '../registry';
import {
  FONT_CHOICES,
  LENGTH_MAX_PX,
  VARIANT_SLOTS,
  checkSlotValue,
  composite,
  contrastRatio,
  type RgbColor,
  type SlotGroup,
  type ThemeVariant,
} from '../variants';

/** 编辑器实时预览用的固定 id（与已保存的变体样式分开，互不覆盖） */
const DRAFT_ID = 'v-draftpreview';

const COLOR_GROUPS: SlotGroup[] = ['surface', 'ink', 'accent', 'semantic'];

type ShadowLevel = 'none' | 'soft' | 'medium' | 'deep';
const SHADOW_LEVELS: ShadowLevel[] = ['none', 'soft', 'medium', 'deep'];
/** 影的预设档位（中性的暗影；世界自己的光影形态由它的材质类决定，这里只换强度） */
const SHADOW_PRESETS: Record<ShadowLevel, Record<string, string>> = {
  none: { '--shadow-panel': 'none', '--shadow-raised': 'none', '--shadow-control': 'none' },
  soft: {
    '--shadow-panel': '0 2px 10px oklch(0 0 0 / 0.06)',
    '--shadow-raised': '0 8px 24px oklch(0 0 0 / 0.1)',
    '--shadow-control': '0 1px 2px oklch(0 0 0 / 0.06)',
  },
  medium: {
    '--shadow-panel': '0 4px 18px oklch(0 0 0 / 0.1)',
    '--shadow-raised': '0 14px 36px oklch(0 0 0 / 0.16)',
    '--shadow-control': '0 1px 3px oklch(0 0 0 / 0.1)',
  },
  deep: {
    '--shadow-panel': '0 8px 28px oklch(0 0 0 / 0.16)',
    '--shadow-raised': '0 20px 48px oklch(0 0 0 / 0.24)',
    '--shadow-control': '0 2px 5px oklch(0 0 0 / 0.14)',
  },
};

function shadowLevelOf(values: Record<string, string>): ShadowLevel | null {
  for (const level of SHADOW_LEVELS) {
    const preset = SHADOW_PRESETS[level];
    if (Object.entries(preset).every(([name, value]) => values[name] === value)) return level;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 颜色换算：交给浏览器（任何 CSS 颜色 → 1×1 画布 → sRGB）                 */
/* ------------------------------------------------------------------ */

let probeContext: CanvasRenderingContext2D | null = null;

function toRgb(color: string): RgbColor | null {
  if (!color.trim()) return null;
  if (!probeContext) {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    probeContext = canvas.getContext('2d', { willReadFrequently: true });
  }
  const ctx = probeContext;
  if (!ctx) return null;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  const [r = 0, g = 0, b = 0, a = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return { r, g, b, a: a / 255 };
}

function toHex(color: string): string {
  const rgb = toRgb(color);
  if (!rgb) return '#000000';
  const hex = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${hex(rgb.r)}${hex(rgb.g)}${hex(rgb.b)}`;
}

/** 预览根上的「正文 vs 阅读面」对比度（阅读面若半透明，叠在画布色上算） */
function bodyContrast(element: HTMLElement): number | null {
  const style = getComputedStyle(element);
  const canvas = toRgb(style.getPropertyValue('--canvas'));
  const reading = toRgb(style.getPropertyValue('--reading'));
  const ink = toRgb(style.getPropertyValue('--ink-story'));
  if (!canvas || !reading || !ink) return null;
  const white = { r: 255, g: 255, b: 255, a: 1 };
  const base = composite(canvas, white);
  const surface = composite(reading, base);
  return contrastRatio(composite(ink, surface), surface);
}

/* ------------------------------------------------------------------ */
/* 编辑器                                                               */
/* ------------------------------------------------------------------ */

export interface VariantEditorProps {
  open: boolean;
  theme: ThemeMeta;
  /** 正在编辑的变体（新派生的也已带好 id） */
  variant: ThemeVariant;
  /** 已保存过（显示删除） */
  saved: boolean;
  onSave: (variant: ThemeVariant) => void;
  onDelete: () => void;
  onDuplicate: (variant: ThemeVariant) => void;
  onExport: (variant: ThemeVariant) => void;
  onClose: () => void;
}

export function VariantEditor(props: VariantEditorProps) {
  const { t } = useTranslation();
  return (
    <Drawer
      open={props.open}
      side="right"
      title={t('themeVariants.editorTitle')}
      onClose={props.onClose}
      className="w-[94vw] max-w-md"
    >
      {props.open && <EditorBody key={props.variant.id} {...props} />}
    </Drawer>
  );
}

function EditorBody({
  theme,
  variant,
  saved,
  onSave,
  onDelete,
  onDuplicate,
  onExport,
  onClose,
}: VariantEditorProps) {
  const { t, i18n } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  const [name, setName] = useState(variant.name);
  const [mode, setMode] = useState<ThemeMode>(theme.defaultMode);
  /** 输入框里的原文（可能暂时不合法）；合法的才进草稿 */
  const [raw, setRaw] = useState<Record<ThemeMode, Record<string, string>>>({
    light: { ...variant.slots.light },
    dark: { ...variant.slots.dark },
  });
  const [options, setOptions] = useState(variant.options);
  const previewRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const [contrast, setContrast] = useState<number | null>(null);
  const [baseValues, setBaseValues] = useState<Record<string, string>>({});

  const draft: ThemeVariant = useMemo(() => {
    const slots: ThemeVariant['slots'] = {};
    for (const m of theme.modes) {
      const valid = Object.fromEntries(
        Object.entries(raw[m]).filter(([slot, value]) => value.trim() && checkSlotValue(slot, value) === null),
      );
      if (Object.keys(valid).length > 0) slots[m] = valid;
    }
    return { ...variant, name: name.trim() || variant.name, slots, options };
  }, [raw, name, options, theme.modes, variant]);

  // 实时预览：草稿写进单独一段样式；关掉编辑器时清掉
  useEffect(() => {
    setDraftVariantStyle({ ...draft, id: DRAFT_ID });
  }, [draft]);
  useEffect(() => () => setDraftVariantStyle(null), []);

  // 世界默认值（占位符）与对比度：样式生效后读计算值
  useLayoutEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      if (probeRef.current) {
        const style = getComputedStyle(probeRef.current);
        setBaseValues(
          Object.fromEntries(
            VARIANT_SLOTS.map((slot) => [slot.name, style.getPropertyValue(slot.name).trim()]),
          ),
        );
      }
      if (previewRef.current) {
        const root = previewRef.current.querySelector<HTMLElement>('[data-part="theme-preview"]');
        setContrast(root ? bodyContrast(root) : null);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [draft, mode]);

  const setSlot = (slot: string, value: string) =>
    setRaw((previous) => {
      const next = { ...previous[mode] };
      if (value === '') delete next[slot];
      else next[slot] = value;
      return { ...previous, [mode]: next };
    });

  const values = raw[mode];
  const shadowValues = Object.fromEntries(
    Object.entries(values).filter(([slot]) => slot.startsWith('--shadow-')),
  );
  const shadowOverride = Object.keys(shadowValues).length > 0;
  const shadowLevel = shadowLevelOf(shadowValues);
  const setShadow = (level: ShadowLevel | null) =>
    setRaw((previous) => {
      const next = Object.fromEntries(
        Object.entries(previous[mode]).filter(([slot]) => !slot.startsWith('--shadow-')),
      );
      return { ...previous, [mode]: level ? { ...next, ...SHADOW_PRESETS[level] } : next };
    });

  const invalidCount = theme.modes.reduce(
    (count, m) =>
      count +
      Object.entries(raw[m]).filter(([slot, value]) => value.trim() && checkSlotValue(slot, value) !== null)
        .length,
    0,
  );
  const previewOptions = resolveThemeOptions(theme, options);
  const label = zh ? theme.name.zh : theme.name.en;

  return (
    <div data-part="variant-editor" className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* 世界默认值的探针：同一世界同一模式、不带变体 */}
        <div ref={probeRef} data-theme={theme.id} data-mode={mode} hidden />

        <div ref={previewRef} data-part="variant-preview" className="rounded-panel edge-rule overflow-hidden border">
          <ThemePreviewRoot
            theme={theme}
            mode={mode}
            options={previewOptions}
            variantId={DRAFT_ID}
            label={label}
          />
        </div>
        {contrast !== null && contrast < 4.5 && (
          <p data-part="variant-contrast" role="status" className="text-xs text-danger">
            {t('themeVariants.contrastLow', { ratio: contrast.toFixed(2) })}
          </p>
        )}

        <div>
          <FieldLabel htmlFor="variant-name">{t('themeVariants.name')}</FieldLabel>
          <Input id="variant-name" size="sm" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </div>

        {theme.modes.length > 1 && (
          <div>
            <FieldLabel>{t('themeVariants.mode')}</FieldLabel>
            <Segmented
              value={mode}
              onChange={setMode}
              items={theme.modes.map((m) => ({ value: m, label: t(`appearance.modes.${m}`) }))}
            />
          </div>
        )}

        <div className="edge-rule border-t">
          {COLOR_GROUPS.map((group) => (
            <PanelSection
              key={group}
              title={t(`themeVariants.groups.${group}`)}
              summary={countOf(values, group)}
              defaultOpen={group === 'surface'}
            >
              {VARIANT_SLOTS.filter((slot) => slot.group === group).map((slot) => (
                <ColorRow
                  key={`${mode}${slot.name}`}
                  slot={slot.name}
                  value={values[slot.name] ?? ''}
                  base={baseValues[slot.name] ?? ''}
                  onChange={(value) => setSlot(slot.name, value)}
                />
              ))}
            </PanelSection>
          ))}

          <PanelSection title={t('themeVariants.groups.font')} summary={countOf(values, 'font')}>
            {VARIANT_SLOTS.filter((slot) => slot.group === 'font').map((slot) => (
              <div key={slot.name}>
                <FieldLabel>{t(`themeVariants.slotNames.${slot.name.slice(2)}`)}</FieldLabel>
                <Select
                  size="sm"
                  value={values[slot.name] ?? ''}
                  onChange={(event) => setSlot(slot.name, event.target.value)}
                >
                  <option value="">{t('themeVariants.worldDefault')}</option>
                  {FONT_CHOICES.map((choice) => (
                    <option key={choice.id} value={choice.stack}>
                      {zh ? choice.label.zh : choice.label.en}
                    </option>
                  ))}
                </Select>
              </div>
            ))}
          </PanelSection>

          <PanelSection title={t('themeVariants.groups.shape')} summary={countOf(values, 'shape')}>
            {VARIANT_SLOTS.filter((slot) => slot.group === 'shape').map((slot) => {
              const current = values[slot.name];
              const px = current ? Number.parseFloat(current) : Number.parseFloat(baseValues[slot.name] ?? '0');
              return (
                <div key={slot.name} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-ink-2">
                    {t(`themeVariants.slotNames.${slot.name.slice(2)}`)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={LENGTH_MAX_PX}
                    step={1}
                    value={Number.isFinite(px) ? Math.min(px, LENGTH_MAX_PX) : 0}
                    aria-label={t(`themeVariants.slotNames.${slot.name.slice(2)}`)}
                    onChange={(event) => setSlot(slot.name, `${event.target.value}px`)}
                    className="accent-primary min-w-0 flex-1"
                  />
                  <span className="w-12 text-right text-xs tabular-nums text-ink-2">
                    {current ?? t('themeVariants.defaultShort')}
                  </span>
                  <IconButton
                    size="xs"
                    label={t('themeVariants.reset')}
                    disabled={!current}
                    onClick={() => setSlot(slot.name, '')}
                  >
                    <RotateCcw aria-hidden />
                  </IconButton>
                </div>
              );
            })}
          </PanelSection>

          <PanelSection
            title={t('themeVariants.groups.shadow')}
            summary={shadowOverride ? t(`themeVariants.shadow.${shadowLevel ?? 'custom'}`) : undefined}
          >
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm">{t('themeVariants.shadowOverride')}</span>
              <Switch
                checked={shadowOverride}
                label={t('themeVariants.shadowOverride')}
                onChange={(checked) => setShadow(checked ? 'soft' : null)}
              />
            </div>
            {shadowOverride && (
              <Segmented
                stretch
                value={shadowLevel ?? 'soft'}
                onChange={(level) => setShadow(level)}
                items={SHADOW_LEVELS.map((level) => ({ value: level, label: t(`themeVariants.shadow.${level}`) }))}
              />
            )}
          </PanelSection>

          {(theme.options ?? []).length > 0 && (
            <PanelSection title={t('themeVariants.groups.options')}>
              {(theme.options ?? []).map((option) => (
                <SwitchRow
                  key={option.key}
                  title={zh ? option.label.zh : option.label.en}
                  checked={(options[option.key] ?? option.default) === 'on'}
                  onChange={(checked) => setOptions({ ...options, [option.key]: checked ? 'on' : 'off' })}
                />
              ))}
            </PanelSection>
          )}
        </div>

        {invalidCount > 0 && (
          <p className="text-xs text-danger">{t('themeVariants.invalidCount', { count: invalidCount })}</p>
        )}
      </div>

      <div data-part="variant-editor-footer" className="edge-rule flex flex-wrap items-center gap-2 border-t p-3">
        <Button size="sm" onClick={() => onSave(draft)} disabled={!name.trim()}>
          {t('common.save')}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <span className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => onExport(draft)}>
          {t('themeVariants.export')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => onDuplicate(draft)}>
          {t('themeVariants.duplicate')}
        </Button>
        {saved && (
          <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
            {t('themeVariants.delete')}
          </Button>
        )}
      </div>
    </div>
  );
}

function countOf(values: Record<string, string>, group: SlotGroup): string | undefined {
  const count = VARIANT_SLOTS.filter((slot) => slot.group === group && values[slot.name]).length;
  return count > 0 ? String(count) : undefined;
}

function ColorRow({
  slot,
  value,
  base,
  onChange,
}: {
  slot: string;
  value: string;
  base: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const problem = value.trim() ? checkSlotValue(slot, value) : null;
  const shown = value.trim() && !problem ? value : base;
  const label = t(`themeVariants.slotNames.${slot.slice(2)}`);
  return (
    <div data-part="variant-slot" className="flex items-center gap-2">
      <input
        type="color"
        aria-label={label}
        value={toHex(shown || '#000')}
        onChange={(event) => onChange(event.target.value)}
        className="rounded-control edge-rule size-7 shrink-0 cursor-pointer border bg-transparent p-0"
      />
      <div className="w-24 shrink-0">
        <div className="truncate text-xs">{label}</div>
        <div className="truncate font-mono text-[10px] text-ink-3">{slot}</div>
      </div>
      <Input
        size="sm"
        value={value}
        placeholder={base}
        aria-label={label}
        aria-invalid={problem !== null}
        title={problem ? t(`themeVariants.problems.${problem}`) : undefined}
        onChange={(event) => onChange(event.target.value)}
        className="min-w-0 flex-1 font-mono text-[11px]"
      />
      <IconButton size="xs" label={t('themeVariants.reset')} disabled={!value} onClick={() => onChange('')}>
        <RotateCcw aria-hidden />
      </IconButton>
    </div>
  );
}
