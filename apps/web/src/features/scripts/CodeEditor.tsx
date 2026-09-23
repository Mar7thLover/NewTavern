import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState } from '@codemirror/state';
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as placeholderExtension,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { useEffect, useRef } from 'react';

/**
 * CodeMirror 6 的薄封装（懒加载：只在打开脚本编辑器时才下载，见 `ScriptEditor.tsx`）。
 *
 * 颜色**只用槽位变量**：编辑器底是 `--reading`、字是 `--ink`、行号 `--ink-3`、选区 `--accent-soft`；
 * 语法高亮也映射到语义槽位（关键字 = `--accent`、字符串 = `--ink-link`、注释 = `--ink-3`……），
 * 所以六个世界、明暗两种模式都自动贴合，不单独写配色。
 */

const theme = EditorView.theme({
  '&': {
    color: 'var(--ink)',
    backgroundColor: 'var(--reading)',
    fontSize: '12.5px',
    height: '100%',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { caretColor: 'var(--ink)', padding: '8px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ink)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--accent-soft)',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--reading)',
    color: 'var(--ink-3)',
    borderRight: '1px solid var(--edge)',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--accent-soft) 45%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--ink-2)' },
  '.cm-matchingBracket, .cm-nonmatchingBracket': {
    backgroundColor: 'var(--accent-soft)',
    outline: '1px solid var(--edge-strong)',
  },
  '.cm-searchMatch': { backgroundColor: 'var(--warning-soft)', outline: '1px solid var(--edge)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-soft)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--accent-soft)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--control)',
    border: '1px solid var(--edge)',
    color: 'var(--ink-2)',
  },
  '.cm-panels': {
    backgroundColor: 'var(--raised)',
    color: 'var(--ink)',
  },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--edge)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--edge)' },
  '.cm-panel.cm-search': { padding: '6px 8px', fontFamily: 'var(--font-ui)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    fontSize: '12px',
    color: 'var(--ink)',
    backgroundColor: 'var(--control)',
    border: '1px solid var(--edge)',
    borderRadius: 'var(--r-control)',
    backgroundImage: 'none',
  },
  '.cm-panel.cm-search label': { fontSize: '12px', color: 'var(--ink-2)' },
  '.cm-tooltip': {
    backgroundColor: 'var(--raised)',
    color: 'var(--ink)',
    border: '1px solid var(--edge)',
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: 'var(--accent-soft)',
    color: 'var(--ink)',
  },
  '.cm-placeholder': { color: 'var(--ink-3)' },
});

const highlight = HighlightStyle.define([
  {
    tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword],
    color: 'var(--accent)',
  },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--ink-link)' },
  {
    tag: [tags.comment, tags.lineComment, tags.blockComment],
    color: 'var(--ink-3)',
    fontStyle: 'italic',
  },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--ink-action)' },
  {
    tag: [tags.function(tags.variableName), tags.function(tags.propertyName)],
    color: 'var(--ink-quote)',
  },
  {
    tag: [tags.definition(tags.variableName), tags.className, tags.typeName],
    color: 'var(--ink)',
    fontWeight: '600',
  },
  { tag: [tags.propertyName], color: 'var(--ink-2)' },
  { tag: [tags.invalid], color: 'var(--danger)' },
]);

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** 无障碍名称 */
  label: string;
  placeholder?: string;
  className?: string;
}

/**
 * 受控的代码编辑器。外部 `value` 变化（比如切到另一个脚本）时整体替换文档；
 * 自己打字引起的变化不会回灌（避免光标跳动）。
 */
export default function CodeEditor({
  value,
  onChange,
  label,
  placeholder,
  className,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          autocompletion(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          javascript(),
          syntaxHighlighting(highlight),
          theme,
          EditorState.tabSize.of(2),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...searchKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          ...(placeholder ? [placeholderExtension(placeholder)] : []),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // 只在挂载时建一次；value 的外部变化走下面的同步
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  return <div ref={hostRef} data-part="code-editor" className={className} />;
}
