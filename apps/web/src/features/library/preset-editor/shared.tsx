import { useCallback, useLayoutEffect, useRef, type ReactNode } from 'react';

import { Button } from '../../../components/ui/button';
import { cn } from '../../../lib/utils';

/*
 * 预设 / 世界书两个受控编辑器共用的小件。
 */

/**
 * 受控编辑器的「函数式更新」：`update(fn)` 以**最新**的 value 为底算出新值再交给 onChange。
 * 返回的函数引用稳定，memo 过的条目行因此不随父组件重渲染；同一事件里连续两次 update 也不会互相覆盖。
 */
export function useDraftUpdater<T>(value: T, onChange: (next: T) => void) {
  const latest = useRef(value);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => {
    latest.current = value;
    onChangeRef.current = onChange;
  });
  return useCallback((fn: (current: T) => T) => {
    const next = fn(latest.current);
    if (Object.is(next, latest.current)) return;
    latest.current = next;
    onChangeRef.current(next);
  }, []);
}

export interface EditorSaveBarProps {
  /** `preset-save-bar` / `lorebook-save-bar` */
  part: string;
  dirty: boolean;
  saving: boolean;
  canSave: boolean;
  embedded: boolean;
  /** 状态文字（出错时由调用方给出错信息，并置 error） */
  status: ReactNode;
  error: boolean;
  discardLabel: string;
  saveLabel: string;
  onDiscard: () => void;
  onSave: () => void;
}

/** 编辑器底部吸附的保存条（`surface-raised`）；嵌入窄栏时贴底、状态文字可换行 */
export function EditorSaveBar({
  part,
  dirty,
  saving,
  canSave,
  embedded,
  status,
  error,
  discardLabel,
  saveLabel,
  onDiscard,
  onSave,
}: EditorSaveBarProps) {
  return (
    <div
      data-part={part}
      data-dirty={dirty}
      className={cn(
        'surface-raised edge-rule rounded-card sticky z-10 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border',
        embedded ? 'bottom-2 mt-8 px-3 py-2.5' : 'bottom-3 mt-10 px-4 py-3 md:bottom-5',
      )}
    >
      <p
        role={error ? 'alert' : 'status'}
        className={cn('me-auto min-w-0 text-xs break-words', error ? 'text-danger' : 'text-ink-2')}
      >
        {status}
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={!dirty || saving}>
          {discardLabel}
        </Button>
        <Button size="sm" onClick={onSave} disabled={!dirty || !canSave || saving}>
          {saveLabel}
        </Button>
      </div>
    </div>
  );
}
