import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useGenerationDefault } from '../../../lib/api';
import type { StudioKind } from '../../../lib/api-studio';
import type { StudioPatchOp } from '../types';
import { AssistHttpError, streamAssist, type AssistMode } from './api';
import {
  applyAssistEvent,
  decideOps,
  finishTurn,
  newTurn,
  pendingIndexes,
  toConversation,
  type AssistTurn,
} from './turns';

/* ------------------------------------------------------------------ */
/* 连接与模型：默认跟随设置里的默认连接；改过就记在本机                  */
/* ------------------------------------------------------------------ */

const STORAGE_KEY = 'nt.studio.assist.connection';

interface StoredChoice {
  connectionId: string | null;
  model: string | null;
}

function readStored(): StoredChoice | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredChoice>;
    return {
      connectionId: typeof value.connectionId === 'string' ? value.connectionId : null,
      model: typeof value.model === 'string' ? value.model : null,
    };
  } catch {
    return null;
  }
}

function writeStored(choice: StoredChoice | null): void {
  try {
    if (choice) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(choice));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 隐私模式等：只是记不住
  }
}

export function useAssistConnection() {
  const generationDefault = useGenerationDefault();
  const [stored, setStored] = useState<StoredChoice | null>(() => readStored());
  const connectionId = stored?.connectionId ?? generationDefault.data?.connectionId ?? null;
  const model = stored ? stored.model : (generationDefault.data?.model ?? null);
  const set = useCallback((next: StoredChoice | null) => {
    setStored(next);
    writeStored(next);
  }, []);
  return {
    connectionId,
    model,
    /** 跟随默认（没改过） */
    following: stored === null,
    setConnection: (id: string | null) => set({ connectionId: id, model: null }),
    setModel: (value: string | null) => set({ connectionId, model: value }),
    reset: () => set(null),
  };
}

/* ------------------------------------------------------------------ */
/* 协作对话                                                             */
/* ------------------------------------------------------------------ */

export interface UseAssistOptions {
  kind: StudioKind;
  id: string;
  /** 发请求时现取当前草稿 */
  getDraft: () => Record<string, unknown> | undefined;
  /** 接受改动：合进工作台草稿 */
  applyOps: (ops: readonly StudioPatchOp[]) => void;
  testChatId: string | null;
  connectionId: string | null;
  model: string | null;
}

export function useAssist({
  kind,
  id,
  getDraft,
  applyOps,
  testChatId,
  connectionId,
  model,
}: UseAssistOptions) {
  const { t, i18n } = useTranslation();
  const [turns, setTurns] = useState<AssistTurn[]>([]);
  const turnsRef = useRef(turns);
  useEffect(() => {
    turnsRef.current = turns;
  });
  const controllerRef = useRef<AbortController | null>(null);

  // 离开工作台：停掉进行中的一轮
  useEffect(() => () => controllerRef.current?.abort(), []);

  const updateTurn = useCallback((turnId: string, fn: (turn: AssistTurn) => AssistTurn) => {
    setTurns((list) => list.map((turn) => (turn.id === turnId ? fn(turn) : turn)));
  }, []);

  const running = turns.some((turn) => turn.status === 'running');

  const send = useCallback(
    async (instruction: string, mode: AssistMode) => {
      const text = instruction.trim();
      if (!text || controllerRef.current) return;
      const draft = getDraft();
      if (!draft) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      const turnId = crypto.randomUUID();
      const conversation = toConversation(turnsRef.current, (accepted, rejected, pending) =>
        t('studio.assist.decisionNote', { accepted, rejected, pending }),
      );
      setTurns((list) => [...list, newTurn(turnId, text, mode)]);
      try {
        const stream = streamAssist(
          {
            ...(connectionId ? { connectionId } : {}),
            ...(connectionId && model ? { model } : {}),
            target: { kind, id },
            draft,
            conversation,
            instruction: text,
            mode,
            ...(testChatId ? { testChatId } : {}),
            lang: i18n.language.startsWith('zh') ? 'zh-CN' : 'en',
          },
          controller.signal,
        );
        for await (const event of stream) {
          updateTurn(turnId, (turn) => applyAssistEvent(turn, event));
        }
        updateTurn(turnId, (turn) => finishTurn(turn, t('studio.assist.interrupted')));
      } catch (error) {
        if (controller.signal.aborted) {
          updateTurn(turnId, (turn) =>
            turn.status === 'running' ? { ...turn, status: 'aborted' } : turn,
          );
        } else {
          const message =
            error instanceof AssistHttpError && error.code === 'no_connection'
              ? t('errors.no_connection')
              : error instanceof Error
                ? error.message
                : String(error);
          updateTurn(turnId, (turn) => ({ ...turn, status: 'error', error: message }));
        }
      } finally {
        if (controllerRef.current === controller) controllerRef.current = null;
      }
    },
    [getDraft, t, i18n.language, connectionId, model, kind, id, testChatId, updateTurn],
  );

  const stop = useCallback(() => controllerRef.current?.abort(), []);

  const accept = useCallback(
    (turnId: string, indexes?: readonly number[]) => {
      const turn = turnsRef.current.find((item) => item.id === turnId);
      if (!turn?.patch) return;
      const chosen = (indexes ?? pendingIndexes(turn)).filter(
        (index) => turn.patch?.decisions[index] === 'pending',
      );
      if (chosen.length === 0) return;
      applyOps(chosen.map((index) => turn.patch!.ops[index]!));
      updateTurn(turnId, (current) => decideOps(current, chosen, 'accepted'));
    },
    [applyOps, updateTurn],
  );

  const reject = useCallback(
    (turnId: string, indexes?: readonly number[]) => {
      updateTurn(turnId, (turn) => decideOps(turn, indexes ?? pendingIndexes(turn), 'rejected'));
    },
    [updateTurn],
  );

  const clear = useCallback(() => {
    if (!controllerRef.current) setTurns([]);
  }, []);

  return { turns, running, send, stop, accept, reject, clear };
}

export type AssistController = ReturnType<typeof useAssist>;
