import type { Editor } from '@tiptap/core';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  appendPending,
  BLOCK_SEPARATOR,
  clearTarget,
  cursorContext,
  docText,
  finishPending,
  getAiState,
  insertionPos,
  keepPending,
  leafText,
  replaceTarget,
  setTarget,
  startPending,
  undoPending,
} from './editor/pending';
import { queryKeys } from '../../lib/api';
import {
  createWritingVersion,
  streamWritingAi,
  WritingAiError,
  writingKeys,
  type WritingAction,
  type WritingAiRequest,
  type WritingUsage,
} from '../../lib/api-writing';

/** 当前打开的那个文档（编辑器 + 它的自动保存） */
export interface DocSession {
  docId: string;
  editor: Editor;
  /** 立即保存（AI 动作前先让服务端看到最新稿） */
  flush: () => Promise<void>;
  /** 刚存过一版：自动存版重新计时 */
  noteVersioned: () => void;
  /** 换成服务端的一份稿（恢复版本后），不触发保存 */
  load: (content: Record<string, unknown> | null, text: string) => void;
}

export type AiPhase = 'idle' | 'streaming' | 'decide' | 'compare';

export interface CompareState {
  action: WritingAction;
  instruction: string;
  original: string;
  text: string;
  streaming: boolean;
  error: string | null;
}

export interface AiRunOptions {
  instruction?: string;
}

export type AiNotice =
  | { kind: 'needConnection' }
  | { kind: 'needSelection' }
  | { kind: 'needInstruction' }
  | { kind: 'failed'; message: string }
  | { kind: 'summaryDone' };

export interface WritingAiController {
  phase: AiPhase;
  action: WritingAction | null;
  compare: CompareState | null;
  usage: WritingUsage | null;
  reasoning: boolean;
  error: string | null;
  /** 正在后台生成摘要的文档 */
  summarizing: string | null;
  run: (action: WritingAction, options?: AiRunOptions) => Promise<void>;
  summarize: (docId: string, text?: string) => Promise<void>;
  stop: () => void;
  keep: () => Promise<void>;
  undo: () => void;
  retry: () => Promise<void>;
  replace: () => Promise<void>;
  discard: () => void;
}

export const COMPARE_ACTIONS: readonly WritingAction[] = ['rewrite', 'expand', 'condense'];

interface UseWritingAiOptions {
  sessionRef: { readonly current: DocSession | null };
  /** 连接 / 模型都解析得到 */
  ready: boolean;
  targetLength: number | undefined;
  onNotice: (notice: AiNotice) => void;
}

/**
 * 写作页的 AI 动作（M7 §5.3）：
 * - 续写（以及没有选区的自定义）：流式写进光标处的待定区，结束后保留 / 撤销 / 重来；可以中途停止；
 * - 重写 / 扩写 / 压缩（以及有选区的自定义）：结果进对照视图，「替换」才写进正文；
 * - 摘要：后台跑，服务端写回章节摘要。
 */
export function useWritingAi({
  sessionRef,
  ready,
  targetLength,
  onNotice,
}: UseWritingAiOptions): WritingAiController {
  const queryClient = useQueryClient();
  const [phase, setPhaseState] = useState<AiPhase>('idle');
  const [action, setAction] = useState<WritingAction | null>(null);
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [usage, setUsage] = useState<WritingUsage | null>(null);
  const [reasoning, setReasoning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summarizing, setSummarizing] = useState<string | null>(null);

  const phaseRef = useRef<AiPhase>('idle');
  const abortRef = useRef<AbortController | null>(null);
  const lastRef = useRef<{ action: WritingAction; options: AiRunOptions } | null>(null);
  const noticeRef = useRef(onNotice);
  useEffect(() => {
    noticeRef.current = onNotice;
  });

  const setPhase = useCallback((next: AiPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  // 卸载时停掉进行中的请求
  useEffect(() => () => abortRef.current?.abort(), []);

  /** 跑一次 SSE，把文本增量交给 onText；返回是否出错 */
  const consume = useCallback(
    async (
      docId: string,
      body: WritingAiRequest,
      onText: (delta: string) => void,
      /** 前台动作（可停止）；后台摘要不占停止键 */
      foreground = true,
    ): Promise<{ error: string | null; summary?: string }> => {
      const controller = new AbortController();
      if (foreground) {
        abortRef.current = controller;
        setReasoning(false);
        setError(null);
      }
      let failure: string | null = null;
      let summary: string | undefined;
      try {
        for await (const event of streamWritingAi(docId, body, controller.signal)) {
          switch (event.type) {
            case 'text':
              if (foreground) setReasoning(false);
              onText(event.data.delta);
              break;
            case 'reasoning':
              if (foreground) setReasoning(true);
              break;
            case 'usage':
              if (foreground) setUsage(event.data);
              break;
            case 'done':
              if (foreground && event.data.usage) setUsage(event.data.usage);
              summary = event.data.summary;
              break;
            case 'error':
              failure = event.data.message;
              break;
            default:
              break;
          }
        }
      } catch (caught) {
        if (caught instanceof WritingAiError && caught.code === 'no_connection') {
          noticeRef.current({ kind: 'needConnection' });
          failure = caught.message;
        } else {
          failure = caught instanceof Error ? caught.message : String(caught);
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (foreground) setReasoning(false);
        // 这次用的连接与模型已被服务端记成全局默认
        void queryClient.invalidateQueries({ queryKey: queryKeys.generationDefault });
      }
      if (failure && foreground) setError(failure);
      return { error: failure, ...(summary === undefined ? {} : { summary }) };
    },
    [queryClient],
  );

  const aiBody = useCallback(
    (
      nextAction: WritingAction,
      parts: { textBefore: string; selectionText?: string; textAfter: string },
      options: AiRunOptions,
    ): WritingAiRequest => {
      const cursor = parts.textBefore.length;
      const selection = parts.selectionText ?? '';
      return {
        action: nextAction,
        ...(options.instruction?.trim() ? { instruction: options.instruction.trim() } : {}),
        cursor,
        ...(selection ? { selection: { from: cursor, to: cursor + selection.length } } : {}),
        textBefore: parts.textBefore,
        ...(selection ? { selectionText: selection } : {}),
        textAfter: parts.textAfter,
        ...(targetLength ? { targetLength } : {}),
      };
    },
    [targetLength],
  );

  const streamCompare = useCallback(
    async (session: DocSession, current: CompareState) => {
      const { editor } = session;
      const target = getAiState(editor.state).target;
      if (!target) return;
      const doc = editor.state.doc;
      const parts = {
        textBefore: doc.textBetween(0, target.from, BLOCK_SEPARATOR, leafText),
        selectionText: doc.textBetween(target.from, target.to, BLOCK_SEPARATOR, leafText),
        textAfter: doc.textBetween(target.to, doc.content.size, BLOCK_SEPARATOR, leafText),
      };
      setCompare({
        ...current,
        original: parts.selectionText,
        text: '',
        streaming: true,
        error: null,
      });
      const result = await consume(
        session.docId,
        aiBody(current.action, parts, { instruction: current.instruction }),
        (delta) => setCompare((state) => (state ? { ...state, text: state.text + delta } : state)),
      );
      setCompare((state) => (state ? { ...state, streaming: false, error: result.error } : state));
    },
    [aiBody, consume],
  );

  const summarize = useCallback(
    async (docId: string, text?: string) => {
      if (!ready) {
        noticeRef.current({ kind: 'needConnection' });
        return;
      }
      const session = sessionRef.current;
      if (session?.docId === docId) {
        try {
          await session.flush();
        } catch {
          // 保存失败也照样按编辑器里的稿子生成
        }
      }
      const fullText =
        text ?? (session?.docId === docId ? docText(session.editor.state.doc) : undefined);
      setSummarizing(docId);
      const result = await consume(
        docId,
        { action: 'summarize', ...(fullText === undefined ? {} : { textBefore: fullText }) },
        () => undefined,
        false,
      );
      setSummarizing(null);
      void queryClient.invalidateQueries({ queryKey: writingKeys.document(docId) });
      void queryClient.invalidateQueries({ queryKey: ['writing', 'project'] });
      if (result.error) noticeRef.current({ kind: 'failed', message: result.error });
      else if (result.summary !== undefined) noticeRef.current({ kind: 'summaryDone' });
    },
    [consume, queryClient, ready, sessionRef],
  );

  const run = useCallback(
    async (nextAction: WritingAction, options: AiRunOptions = {}) => {
      if (nextAction === 'summarize') {
        const session = sessionRef.current;
        if (session) await summarize(session.docId);
        return;
      }
      const session = sessionRef.current;
      if (!session || phaseRef.current !== 'idle') return;
      if (!ready) {
        noticeRef.current({ kind: 'needConnection' });
        return;
      }
      const instruction = options.instruction ?? '';
      if (nextAction === 'custom' && instruction.trim() === '') {
        noticeRef.current({ kind: 'needInstruction' });
        return;
      }
      const { editor } = session;
      const before = cursorContext(editor.state);
      const hasSelection = before.to > before.from && before.selectionText.trim() !== '';
      const compareMode =
        COMPARE_ACTIONS.includes(nextAction) || (nextAction === 'custom' && hasSelection);
      if (compareMode && !hasSelection) {
        noticeRef.current({ kind: 'needSelection' });
        return;
      }

      lastRef.current = { action: nextAction, options };
      setAction(nextAction);
      setUsage(null);
      setError(null);

      if (compareMode) {
        setPhase('compare');
        editor.view.dispatch(setTarget(editor.state, before.from, before.to));
        try {
          await session.flush();
        } catch {
          // 保存失败不挡 AI：请求里带的是编辑器里的文本
        }
        await streamCompare(session, {
          action: nextAction,
          instruction,
          original: before.selectionText,
          text: '',
          streaming: true,
          error: null,
        });
        return;
      }

      // 续写：先占住状态再保存，免得保存期间又被触发一次
      setPhase('streaming');
      try {
        await session.flush();
      } catch {
        // 同上
      }
      if (editor.isDestroyed) {
        setPhase('idle');
        return;
      }
      const pos = insertionPos(editor.state);
      if (pos < 0) {
        setPhase('idle');
        return;
      }
      const doc = editor.state.doc;
      const parts = {
        textBefore: doc.textBetween(0, pos, BLOCK_SEPARATOR, leafText),
        textAfter: doc.textBetween(pos, doc.content.size, BLOCK_SEPARATOR, leafText),
      };
      editor.setEditable(false, false);
      editor.view.dispatch(startPending(editor.state, pos));
      const result = await consume(
        session.docId,
        aiBody(nextAction, parts, { instruction }),
        (delta) => {
          if (editor.isDestroyed) return;
          const tr = appendPending(editor.state, delta);
          if (tr) editor.view.dispatch(tr.scrollIntoView());
        },
      );
      if (editor.isDestroyed) {
        setPhase('idle');
        return;
      }
      editor.setEditable(true, false);
      editor.view.dispatch(finishPending(editor.state));
      const pending = getAiState(editor.state).pending;
      setPhase(pending ? 'decide' : 'idle');
      if (result.error) noticeRef.current({ kind: 'failed', message: result.error });
    },
    [aiBody, consume, ready, sessionRef, setPhase, streamCompare, summarize],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /** 接受 AI 的结果之后：保存并存一版（author=ai） */
  const commitVersion = useCallback(
    async (session: DocSession, label: string) => {
      try {
        await session.flush();
        await createWritingVersion(queryClient, session.docId, { author: 'ai', label });
        session.noteVersioned();
      } catch (caught) {
        noticeRef.current({
          kind: 'failed',
          message: caught instanceof Error ? caught.message : String(caught),
        });
      }
    },
    [queryClient],
  );

  const keep = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== 'decide') return;
    session.editor.view.dispatch(keepPending(session.editor.state));
    setPhase('idle');
    session.editor.commands.focus();
    await commitVersion(session, `ai:${lastRef.current?.action ?? 'continue'}`);
  }, [commitVersion, sessionRef, setPhase]);

  const undo = useCallback(() => {
    const session = sessionRef.current;
    if (!session || phaseRef.current !== 'decide') return;
    session.editor.view.dispatch(undoPending(session.editor.state));
    setPhase('idle');
    session.editor.commands.focus();
  }, [sessionRef, setPhase]);

  const discard = useCallback(() => {
    abortRef.current?.abort();
    const session = sessionRef.current;
    if (session && !session.editor.isDestroyed) {
      session.editor.view.dispatch(clearTarget(session.editor.state));
    }
    setCompare(null);
    setPhase('idle');
  }, [sessionRef, setPhase]);

  const replace = useCallback(async () => {
    const session = sessionRef.current;
    if (!session || !compare || compare.streaming) return;
    const tr = replaceTarget(session.editor.state, compare.text.trim());
    if (tr) session.editor.view.dispatch(tr.scrollIntoView());
    setCompare(null);
    setPhase('idle');
    session.editor.commands.focus();
    await commitVersion(session, `ai:${compare.action}`);
  }, [commitVersion, compare, sessionRef, setPhase]);

  const retry = useCallback(async () => {
    const session = sessionRef.current;
    const last = lastRef.current;
    if (!session || !last) return;
    if (phaseRef.current === 'decide') {
      session.editor.view.dispatch(undoPending(session.editor.state));
      setPhase('idle');
      await run(last.action, last.options);
      return;
    }
    if (phaseRef.current === 'compare' && compare && !compare.streaming) {
      await streamCompare(session, compare);
    }
  }, [compare, run, sessionRef, setPhase, streamCompare]);

  return {
    phase,
    action,
    compare,
    usage,
    reasoning,
    error,
    summarizing,
    run,
    summarize,
    stop,
    keep,
    undo,
    retry,
    replace,
    discard,
  };
}
