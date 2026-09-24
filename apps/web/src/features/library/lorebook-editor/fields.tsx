import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { FieldLabel, Input, Select, fieldVariants } from '../../../components/ui/field';
import { cn } from '../../../lib/utils';

/* 世界书条目表单里的小控件 */

type T = ReturnType<typeof useTranslation>['t'];

/** ST world_info_position 在条目编辑器下拉里的顺序 */
export const POSITION_OPTIONS = [0, 1, 5, 6, 2, 3, 4, 7];
export const DEFAULT_DEPTH = 4;

/** 位置的短标签（↑角色、@D4 …）；未知位置显示原值 */
export function positionShort(t: T, position: number, depth: number | null): string {
  if (!POSITION_OPTIONS.includes(position)) {
    return t('library.lorebooks.unknownPosition', { value: position });
  }
  return t(`library.lorebooks.positionShort.${position}`, { depth: depth ?? DEFAULT_DEPTH });
}

export function FormField({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-ink-3">{hint}</p>}
    </div>
  );
}

/**
 * 整数输入：本地保留原始文本，合法时才写回草稿；nullable 时清空 = null。
 * 外部改了值（放弃修改、AI 协作接受改动、恢复版本）时文本跟着同步。
 */
export function NumberField({
  id,
  value,
  nullable = false,
  min,
  max,
  placeholder,
  disabled,
  onChange,
}: {
  id: string;
  value: number | null;
  nullable?: boolean;
  min: number;
  max: number;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const [text, setText] = useState(value === null ? '' : String(value));
  const [synced, setSynced] = useState(value);
  const parse = (input: string): { ok: boolean; value: number | null } => {
    if (input.trim() === '') return { ok: nullable, value: null };
    const number = Number(input);
    return Number.isInteger(number) && number >= min && number <= max
      ? { ok: true, value: number }
      : { ok: false, value: null };
  };
  if (value !== synced) {
    setSynced(value);
    const current = parse(text);
    if (!current.ok || current.value !== value) setText(value === null ? '' : String(value));
  }
  return (
    <Input
      id={id}
      type="number"
      inputMode="numeric"
      size="sm"
      step={1}
      min={min}
      max={max}
      value={text}
      placeholder={placeholder}
      disabled={disabled}
      aria-invalid={!parse(text).ok}
      className="min-w-0 tabular-nums"
      onChange={(event) => {
        setText(event.target.value);
        const result = parse(event.target.value);
        if (result.ok) {
          setSynced(result.value);
          onChange(result.value);
        }
      }}
    />
  );
}

/** 可空布尔：使用全局 / 是 / 否 */
export function TriSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
}) {
  const { t } = useTranslation();
  return (
    <Select
      id={id}
      size="sm"
      value={value === null ? 'null' : String(value)}
      onChange={(event) =>
        onChange(event.target.value === 'null' ? null : event.target.value === 'true')
      }
    >
      <option value="null">{t('library.lorebooks.tri.global')}</option>
      <option value="true">{t('library.lorebooks.tri.yes')}</option>
      <option value="false">{t('library.lorebooks.tri.no')}</option>
    </Select>
  );
}

const SEPARATORS = /[,，\n]/;

/** 关键词标签输入：逗号或回车成词，退格删最后一个；以 `/` 开头的正则不按逗号拆 */
export function KeywordInput({
  id,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  value: string[];
  placeholder: string;
  onChange: (value: string[]) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const isRegex = (input: string) => input.trimStart().startsWith('/');

  const add = (parts: string[]) => {
    const words: string[] = [];
    for (const part of parts) {
      const word = part.trim();
      if (word && !value.includes(word) && !words.includes(word)) words.push(word);
    }
    if (words.length > 0) onChange([...value, ...words]);
  };

  const commit = () => {
    if (text.trim()) add(isRegex(text) ? [text] : text.split(SEPARATORS));
    setText('');
  };

  return (
    <div
      className={cn(
        fieldVariants({ size: 'sm' }),
        'flex h-auto min-h-8 min-w-0 flex-wrap items-center gap-1 py-1',
      )}
    >
      {value.map((word, index) => (
        <span
          key={`${index}:${word}`}
          className="chip inline-flex max-w-full min-w-0 items-center gap-0.5 py-0.5 ps-2 pe-0.5 text-xs"
        >
          <span className="min-w-0 truncate">{word}</span>
          <button
            type="button"
            aria-label={t('library.lorebooks.entry.removeKey', { key: word })}
            title={t('library.lorebooks.entry.removeKey', { key: word })}
            onClick={() => onChange(value.filter((_, i) => i !== index))}
            className="focus-ring rounded-control inline-flex size-4 shrink-0 cursor-pointer items-center justify-center text-ink-3 hover:text-ink"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
      <input
        id={id}
        value={text}
        placeholder={value.length === 0 ? placeholder : undefined}
        className="min-w-16 flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-ink-3"
        onChange={(event) => {
          const next = event.target.value;
          if (!isRegex(next) && SEPARATORS.test(next)) {
            const parts = next.split(SEPARATORS);
            const rest = parts.pop() ?? '';
            add(parts);
            setText(rest);
          } else {
            setText(next);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          } else if (event.key === 'Backspace' && text === '' && value.length > 0) {
            onChange(value.slice(0, -1));
          }
        }}
        onBlur={commit}
      />
    </div>
  );
}
