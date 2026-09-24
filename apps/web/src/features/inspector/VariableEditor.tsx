import { ChevronRight, Plus, Trash2, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import {
  addChild,
  convertValue,
  countChanges,
  deleteAt,
  isBookkeepingKey,
  isRecord,
  isValueWithDescription,
  issuesByPath,
  kindOf,
  pathKey,
  renameAt,
  setAt,
  type LeafKind,
  type Path,
  type VariableTable,
} from './variable-tree';
import { Button } from '../../components/ui/button';
import { Input, Select } from '../../components/ui/field';
import { IconButton } from '../../components/ui/icon-button';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/utils';

/**
 * 变量管理器（M5（三）契约 §1）：可编辑的变量树。
 *
 * - 对象 / 数组可展开；叶子按字符串、数字、布尔、null、JSON 文本五种形态编辑，可切类型；
 *   增加键、删除键、重命名键（重名不覆盖）。
 * - MVU 的 `[值, "说明"]` 当一个叶子：只改值，说明灰显只读。`$` 开头的簿记键默认折叠。
 * - 保存 = 整表交给 `onSave`（调用方 PUT）；保存前显示改动处数，可撤销到打开时的状态。
 * - 有 schema（`registerVariableSchema`）时就地标错；有错也能保存，只是按钮上会先列出错误数。
 *
 * 纯逻辑都在 `variable-tree.ts`，这里只管显示与交互。
 */

export interface VariableEditorProps {
  /** 服务端当前的表；变化时若本地没有未保存的改动就跟着刷新 */
  table: VariableTable;
  schema?: unknown;
  saving?: boolean;
  /** 保存；reject 时保持草稿 */
  onSave: (next: VariableTable) => Promise<unknown>;
  /** 表上方的提示（message 作用域的「不会自动重算」） */
  note?: ReactNode;
  /** 默认折叠的顶层键（`display_data` / `delta_data` 这类派生数据） */
  collapsedKeys?: readonly string[];
  disabled?: boolean;
}

const LEAF_KINDS: LeafKind[] = ['string', 'number', 'boolean', 'null', 'json'];

export function VariableEditor({
  table,
  schema,
  saving = false,
  onSave,
  note,
  collapsedKeys = [],
  disabled = false,
}: VariableEditorProps) {
  const { t } = useTranslation();
  const [original, setOriginal] = useState<VariableTable>(table);
  const [draft, setDraft] = useState<VariableTable>(table);
  const [error, setError] = useState<string | null>(null);
  const changes = useMemo(() => countChanges(original, draft), [original, draft]);
  const dirty = changes > 0;
  const issues = useMemo(() => issuesByPath(draft, schema), [draft, schema]);
  const issueCount = useMemo(
    () => [...issues.values()].reduce((sum, list) => sum + list.length, 0),
    [issues],
  );

  // 服务端的表变了（生成结束、别处保存）：没有未保存的改动就跟上
  const tableKey = JSON.stringify(table);
  const lastKey = useRef(tableKey);
  useEffect(() => {
    if (lastKey.current === tableKey) return;
    lastKey.current = tableKey;
    if (!dirty) {
      setOriginal(table);
      setDraft(table);
    }
  }, [tableKey, table, dirty]);

  const save = () => {
    setError(null);
    onSave(draft).then(
      () => {
        setOriginal(draft);
        lastKey.current = JSON.stringify(draft);
      },
      (reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
  };

  const ctx: TreeContext = {
    draft,
    setDraft,
    issues,
    collapsedKeys,
    disabled: disabled || saving,
  };

  const entries = Object.entries(draft);

  return (
    <div data-part="variable-editor" className="space-y-2">
      {note && <p className="text-[11px] leading-relaxed text-ink-2">{note}</p>}

      <div
        data-part="variable-tree"
        role="tree"
        aria-label={t('variableEditor.tree')}
        className="rounded-card edge-rule border py-1"
      >
        {entries.length === 0 && (
          <p className="px-2.5 py-3 text-center text-xs text-ink-3">{t('variableEditor.empty')}</p>
        )}
        {entries.map(([key, value]) => (
          <TreeNode key={key} ctx={ctx} path={[key]} name={key} value={value} depth={0} />
        ))}
        <AddChild ctx={ctx} path={[]} depth={0} />
      </div>

      {issueCount > 0 && (
        <p role="status" className="text-xs text-danger">
          {t('variableEditor.schemaIssues', { count: issueCount })}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger break-words">
          {t('variableEditor.saveFailed', { message: error })}
        </p>
      )}

      <div data-part="variable-editor-bar" className="flex flex-wrap items-center gap-2">
        <span className="me-auto text-xs text-ink-2 tabular-nums">
          {dirty ? t('variableEditor.changes', { count: changes }) : t('variableEditor.clean')}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!dirty || saving}
          onClick={() => {
            setDraft(original);
            setError(null);
          }}
        >
          <Undo2 aria-hidden className="size-3.5" />
          {t('variableEditor.revert')}
        </Button>
        <Button size="sm" disabled={!dirty || saving || disabled} onClick={save}>
          {saving
            ? t('variableEditor.saving')
            : issueCount > 0
              ? t('variableEditor.saveWithIssues', { count: issueCount })
              : t('variableEditor.save')}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 树                                                                  */
/* ------------------------------------------------------------------ */

interface TreeContext {
  draft: VariableTable;
  setDraft: (next: VariableTable | ((prev: VariableTable) => VariableTable)) => void;
  issues: Map<string, string[]>;
  collapsedKeys: readonly string[];
  disabled: boolean;
}

function indent(depth: number) {
  return { paddingInlineStart: `${0.5 + depth * 0.875}rem` };
}

function TreeNode({
  ctx,
  path,
  name,
  value,
  depth,
}: {
  ctx: TreeContext;
  path: Path;
  name: string | number;
  value: unknown;
  depth: number;
}) {
  const branch = (isRecord(value) || Array.isArray(value)) && !isValueWithDescription(value);
  if (!branch) return <LeafRow ctx={ctx} path={path} name={name} value={value} depth={depth} />;
  return <BranchRow ctx={ctx} path={path} name={name} value={value} depth={depth} />;
}

function BranchRow({
  ctx,
  path,
  name,
  value,
  depth,
}: {
  ctx: TreeContext;
  path: Path;
  name: string | number;
  value: Record<string, unknown> | unknown[];
  depth: number;
}) {
  const { t } = useTranslation();
  const defaultOpen =
    !isBookkeepingKey(name) && !(depth === 0 && ctx.collapsedKeys.includes(String(name)));
  const [open, setOpen] = useState(defaultOpen);
  const children: [string | number, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [index, item])
    : Object.entries(value);
  const issues = ctx.issues.get(pathKey(path));

  return (
    <div role="treeitem" aria-expanded={open} data-part="variable-node" data-kind="branch">
      <div className="group flex min-h-8 items-center gap-1 pe-1.5" style={indent(depth)}>
        <button
          type="button"
          className="focus-ring rounded-control flex size-5 shrink-0 cursor-pointer items-center justify-center text-ink-3 hover:text-ink"
          aria-label={open ? t('common.collapse') : t('common.expand')}
          onClick={() => setOpen((prev) => !prev)}
        >
          <ChevronRight
            aria-hidden
            className={cn('motion-transform size-3.5', open && 'rotate-90')}
          />
        </button>
        <KeyName ctx={ctx} path={path} name={name} />
        <span className="text-[11px] text-ink-3 tabular-nums">
          {Array.isArray(value)
            ? t('variableEditor.items', { count: value.length })
            : t('variableEditor.keys', { count: children.length })}
        </span>
        <span className="flex-1" />
        <DeleteButton ctx={ctx} path={path} name={name} />
      </div>
      {issues && <IssueList issues={issues} depth={depth} />}
      {open && (
        <div role="group">
          {children.map(([key, item]) => (
            <TreeNode
              key={String(key)}
              ctx={ctx}
              path={[...path, key]}
              name={key}
              value={item}
              depth={depth + 1}
            />
          ))}
          <AddChild ctx={ctx} path={path} depth={depth + 1} isArray={Array.isArray(value)} />
        </div>
      )}
    </div>
  );
}

function LeafRow({
  ctx,
  path,
  name,
  value,
  depth,
}: {
  ctx: TreeContext;
  path: Path;
  name: string | number;
  value: unknown;
  depth: number;
}) {
  const { t } = useTranslation();
  const described = isValueWithDescription(value);
  const leafPath: Path = described ? [...path, 0] : path;
  const leaf = described ? value[0] : value;
  const kind = kindOf(leaf);
  const issues = ctx.issues.get(pathKey(path)) ?? ctx.issues.get(pathKey(leafPath));
  const setLeaf = (next: unknown) => ctx.setDraft((prev) => setAt(prev, leafPath, next));

  return (
    <div role="treeitem" data-part="variable-node" data-kind="leaf">
      <div
        className="group flex min-h-8 flex-wrap items-center gap-x-1.5 gap-y-1 py-0.5 pe-1.5"
        style={indent(depth)}
      >
        <span className="size-5 shrink-0" aria-hidden />
        <KeyName ctx={ctx} path={path} name={name} />
        <div className="flex min-w-[10rem] flex-1 items-center gap-1.5">
          <LeafInput
            kind={kind}
            value={leaf}
            label={String(name)}
            disabled={ctx.disabled}
            invalid={Boolean(issues)}
            onChange={setLeaf}
          />
          <Select
            size="sm"
            className="w-[5.5rem] shrink-0"
            aria-label={t('variableEditor.type')}
            value={kind}
            disabled={ctx.disabled}
            onChange={(event) => setLeaf(convertValue(leaf, event.target.value as LeafKind))}
          >
            {LEAF_KINDS.map((item) => (
              <option key={item} value={item}>
                {t(`variableEditor.kinds.${item}`)}
              </option>
            ))}
          </Select>
          <DeleteButton ctx={ctx} path={path} name={name} />
        </div>
      </div>
      {described && (
        <p
          className="pe-2 pb-1 text-[11px] leading-snug break-words text-ink-3"
          style={{ paddingInlineStart: `${2 + depth * 0.875}rem` }}
          title={t('variableEditor.descriptionHint')}
        >
          {value[1]}
        </p>
      )}
      {issues && <IssueList issues={issues} depth={depth} />}
    </div>
  );
}

function LeafInput({
  kind,
  value,
  label,
  disabled,
  invalid,
  onChange,
}: {
  kind: LeafKind;
  value: unknown;
  label: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  if (kind === 'boolean') {
    return (
      <span className="flex flex-1 items-center">
        <Switch checked={value === true} onChange={onChange} label={label} disabled={disabled} />
      </span>
    );
  }
  if (kind === 'null') {
    return <span className="flex-1 font-mono text-xs text-ink-3">null</span>;
  }
  if (kind === 'number') {
    return (
      <NumberInput
        value={value as number}
        label={label}
        disabled={disabled}
        invalid={invalid}
        onChange={onChange}
      />
    );
  }
  if (kind === 'json') {
    // 叶子里的 JSON 只会是空对象 / 空数组之外的奇形怪状值（正常对象走分支行）；给一个文本框改
    return (
      <JsonInput
        value={value}
        label={label}
        disabled={disabled}
        onChange={onChange}
        placeholder={t('variableEditor.jsonPlaceholder')}
      />
    );
  }
  return (
    <Input
      size="sm"
      className="min-w-0 flex-1"
      aria-label={label}
      aria-invalid={invalid}
      value={String(value ?? '')}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** 数字：输入中允许半截文本（`-`、`1.`），失焦或合法时才写回 */
function NumberInput({
  value,
  label,
  disabled,
  invalid,
  onChange,
}: {
  value: number;
  label: string;
  disabled: boolean;
  invalid: boolean;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const parsed = Number(text);
  const bad = text.trim() === '' || !Number.isFinite(parsed);
  return (
    <Input
      size="sm"
      inputMode="decimal"
      className="min-w-0 flex-1 tabular-nums"
      aria-label={label}
      aria-invalid={invalid || bad}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        const next = Number(event.target.value);
        if (event.target.value.trim() !== '' && Number.isFinite(next)) onChange(next);
      }}
      onBlur={() => setText(String(value))}
    />
  );
}

function JsonInput({
  value,
  label,
  disabled,
  placeholder,
  onChange,
}: {
  value: unknown;
  label: string;
  disabled: boolean;
  placeholder: string;
  onChange: (value: unknown) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(value));
  const [bad, setBad] = useState(false);
  return (
    <Input
      size="sm"
      className="min-w-0 flex-1 font-mono"
      aria-label={label}
      aria-invalid={bad}
      placeholder={placeholder}
      value={text}
      disabled={disabled}
      onChange={(event) => {
        setText(event.target.value);
        try {
          onChange(JSON.parse(event.target.value) as unknown);
          setBad(false);
        } catch {
          setBad(true);
        }
      }}
    />
  );
}

/** 键名：对象的键可以点开改名（重名不覆盖，给提示）；数组下标只读 */
function KeyName({ ctx, path, name }: { ctx: TreeContext; path: Path; name: string | number }) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(String(name));
  const [clash, setClash] = useState(false);
  if (typeof name === 'number') {
    return <span className="font-mono text-[12px] text-ink-3 tabular-nums">[{name}]</span>;
  }
  if (editing) {
    const commit = () => {
      const next = text.trim();
      if (next === '' || next === name) {
        setEditing(false);
        setClash(false);
        return;
      }
      const renamed = renameAt(ctx.draft, path, next);
      if (!renamed) {
        setClash(true);
        return;
      }
      ctx.setDraft(renamed);
      setEditing(false);
      setClash(false);
    };
    return (
      <Input
        size="sm"
        autoFocus
        className="w-36 shrink-0 font-mono"
        aria-label={t('variableEditor.rename')}
        aria-invalid={clash}
        title={clash ? t('variableEditor.keyExists') : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setClash(false);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') commit();
          else if (event.key === 'Escape') {
            setEditing(false);
            setClash(false);
            setText(name);
          }
        }}
      />
    );
  }
  return (
    <button
      type="button"
      className={cn(
        'focus-ring rounded-control max-w-[45%] shrink-0 cursor-text truncate px-0.5 text-left font-mono text-[12px]',
        isBookkeepingKey(name) ? 'text-ink-3' : 'text-ink-2 hover:text-ink',
      )}
      title={t('variableEditor.renameHint', { name })}
      disabled={ctx.disabled}
      onClick={() => {
        setText(name);
        setEditing(true);
      }}
    >
      {name}
    </button>
  );
}

function DeleteButton({
  ctx,
  path,
  name,
}: {
  ctx: TreeContext;
  path: Path;
  name: string | number;
}) {
  const { t } = useTranslation();
  return (
    <IconButton
      size="xs"
      variant="destructive"
      label={t('variableEditor.delete', { name: String(name) })}
      disabled={ctx.disabled}
      className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
      onClick={() => ctx.setDraft((prev) => deleteAt(prev, path))}
    >
      <Trash2 aria-hidden />
    </IconButton>
  );
}

/** 「加一个键」：对象要先写键名；数组直接追加一个空串 */
function AddChild({
  ctx,
  path,
  depth,
  isArray = false,
}: {
  ctx: TreeContext;
  path: Path;
  depth: number;
  isArray?: boolean;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [key, setKey] = useState('');
  const [clash, setClash] = useState(false);
  if (isArray) {
    return (
      <div className="flex min-h-7 items-center" style={indent(depth)}>
        <span className="size-5 shrink-0" aria-hidden />
        <Button
          size="sm"
          variant="ghost"
          disabled={ctx.disabled}
          onClick={() => ctx.setDraft((prev) => addChild(prev, path, '', '') ?? prev)}
        >
          <Plus aria-hidden className="size-3.5" />
          {t('variableEditor.addItem')}
        </Button>
      </div>
    );
  }
  const commit = () => {
    const name = key.trim();
    if (name === '') {
      setAdding(false);
      return;
    }
    const next = addChild(ctx.draft, path, name, '');
    if (!next) {
      setClash(true);
      return;
    }
    ctx.setDraft(next);
    setKey('');
    setAdding(false);
    setClash(false);
  };
  return (
    <div className="flex min-h-7 items-center gap-1.5 pe-1.5" style={indent(depth)}>
      <span className="size-5 shrink-0" aria-hidden />
      {adding ? (
        <>
          <Input
            size="sm"
            autoFocus
            className="w-40 font-mono"
            aria-label={t('variableEditor.newKey')}
            placeholder={t('variableEditor.newKey')}
            aria-invalid={clash}
            value={key}
            onChange={(event) => {
              setKey(event.target.value);
              setClash(false);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commit();
              else if (event.key === 'Escape') setAdding(false);
            }}
          />
          <Button size="sm" variant="outline" onClick={commit}>
            {t('variableEditor.add')}
          </Button>
          {clash && (
            <span className="text-[11px] text-danger">{t('variableEditor.keyExists')}</span>
          )}
        </>
      ) : (
        <Button size="sm" variant="ghost" disabled={ctx.disabled} onClick={() => setAdding(true)}>
          <Plus aria-hidden className="size-3.5" />
          {t('variableEditor.addKey')}
        </Button>
      )}
    </div>
  );
}

function IssueList({ issues, depth }: { issues: string[]; depth: number }) {
  return (
    <ul
      data-part="variable-issues"
      className="pe-2 pb-1 text-[11px] leading-snug text-danger"
      style={{ paddingInlineStart: `${2 + depth * 0.875}rem` }}
    >
      {issues.map((message, index) => (
        <li key={index} className="break-words">
          {message}
        </li>
      ))}
    </ul>
  );
}
