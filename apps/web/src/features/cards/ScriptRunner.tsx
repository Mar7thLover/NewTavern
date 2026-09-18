import {
  buildSrcdoc,
  createFrameChannel,
  createNonce,
  guestBootstrapSource,
  sandboxAttribute,
  type FrameChannel,
  type SandboxFrameInfo,
} from '@newtavern/sandbox-sdk';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { emitCompat, subscribeBus } from './bus';
import { buildChatMirror, createCardHandlers, type CardHostContext } from './host-bridge';
import { EXTERNAL_SCRIPTS, EXTERNAL_STYLES, selectSandboxLibs } from './libs';
import { useCardSettings, useChatVariables, useMvuSettings, trustFor } from '../../lib/api-cards';
import { queryKeys, useChat, useCharacter, type CharacterDetail } from '../../lib/api';

/**
 * 脚本库：角色卡自带的脚本与全局脚本，在**隐藏 iframe** 里跑。
 * 见 docs/M5-CONTRACT.md §4.7。
 *
 * 和前端卡同一套沙箱与 RPC，区别只有三点：
 * 1. 帧不可见（`hidden`），没有高度回报；
 * 2. 帧身份是 `kind:'script'`，`getScriptId()` / `getScriptButtons()` 才有意义；
 * 3. 脚本正文是 **ES 模块**（社区脚本几乎都是 `import '...cdn.../bundle.js'`），
 *    所以包一层 `<script type="module">`。跨源模块要 CORS，jsdelivr 给了 `*`。
 *
 * 来源与酒馆助手互通：角色卡 `extensions.tavern_helper.scripts`（新）或
 * `extensions.TavernHelper_scripts`（旧）。导入 ST 角色卡时这两个字段本来就原样保留了。
 */

export interface CardScript {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  buttons: { name: string; visible: boolean }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从角色卡的 extensions 里读出脚本列表（两种字段名都认） */
export function readCharacterScripts(character: CharacterDetail | undefined): CardScript[] {
  const extensions = isRecord(character?.data?.extensions) ? character.data.extensions : undefined;
  if (!extensions) return [];
  const modern = isRecord(extensions.tavern_helper) ? extensions.tavern_helper.scripts : undefined;
  const legacy = extensions.TavernHelper_scripts;
  const raw = Array.isArray(modern) ? modern : Array.isArray(legacy) ? legacy : [];
  return raw.filter(isRecord).map((item, index) => {
    const button = isRecord(item.button) ? item.button : undefined;
    const buttons = Array.isArray(button?.buttons) ? button.buttons : [];
    return {
      id: typeof item.id === 'string' ? item.id : `script-${index}`,
      name: typeof item.name === 'string' ? item.name : `脚本 ${index + 1}`,
      content: typeof item.content === 'string' ? item.content : '',
      enabled: item.enabled !== false,
      buttons: buttons.filter(isRecord).map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        visible: entry.visible !== false,
      })),
    };
  });
}

/**
 * 原版 MVU 框架脚本：新酒馆自带变量引擎（服务端跑，见 M5 契约 §2），
 * 再让这张卡把 MagVarUpdate 拉起来只会两套引擎打架 —— 内置引擎开着时跳过它。
 * 用户想用原版：设置 → 前端卡里关掉「自动解析变量更新」，脚本就会照常运行。
 */
export function isMvuFrameworkScript(script: CardScript): boolean {
  return /magvarupdate/i.test(script.content);
}

export interface ScriptRunnerProps {
  chatId: string;
}

/**
 * 跑当前会话的脚本，并把脚本按钮显示成一排。
 * 放在对话页（`ChatView`）里：脚本的生命周期跟着会话，切走就卸载。
 */
export function ScriptRunner({ chatId }: ScriptRunnerProps) {
  const { t } = useTranslation();
  const chat = useChat(chatId);
  const characterId = chat.data?.characterIds[0] ?? null;
  const character = useCharacter(characterId);
  const settings = useCardSettings();
  const variables = useChatVariables(chatId, null);

  const mvu = useMvuSettings();
  const builtinMvu = mvu.data?.enabled !== false;
  const scripts = useMemo(
    () =>
      readCharacterScripts(character.data)
        .filter((script) => script.enabled && script.content.trim() !== '')
        .filter((script) => {
          if (!builtinMvu || !isMvuFrameworkScript(script)) return true;
          console.info(`[脚本 ${script.name}] 跳过：新酒馆自带 MVU 变量引擎（设置 → 前端卡里可切换）`);
          return false;
        }),
    [character.data, builtinMvu],
  );

  const [buttons, setButtons] = useState<Record<string, { name: string; visible: boolean }[]>>({});

  const enabled = settings.data?.scripts !== false;
  // 同前端卡：脚本也会在启动时同步读一次变量，等取回来再跑
  const ready = variables.isSuccess || variables.isError;
  if (!enabled || !ready || scripts.length === 0) return null;

  const visibleButtons = scripts.flatMap((script) =>
    (buttons[script.id] ?? script.buttons)
      .filter((button) => button.visible && button.name !== '')
      .map((button) => ({ scriptId: script.id, name: button.name })),
  );

  return (
    <>
      {scripts.map((script) => (
        <ScriptFrame
          key={script.id}
          chatId={chatId}
          characterId={characterId}
          script={script}
          variables={variables.data}
          onButtons={(list) => setButtons((current) => ({ ...current, [script.id]: list }))}
        />
      ))}

      {visibleButtons.length > 0 && (
        <div
          data-part="script-buttons"
          className="flex flex-wrap items-center gap-1.5 px-3 pb-1"
          aria-label={t('cards.scriptButtons')}
        >
          {visibleButtons.map((button) => (
            <button
              key={`${button.scriptId}:${button.name}`}
              type="button"
              className="rounded-control edge-rule cursor-pointer border px-2 py-1 text-xs text-ink-2 hover:text-ink"
              onClick={() => emitCompat(`script_button:${button.scriptId}:${button.name}`)}
            >
              {button.name}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function ScriptFrame({
  chatId,
  characterId,
  script,
  variables,
  onButtons,
}: {
  chatId: string;
  characterId: string | null;
  script: CardScript;
  variables: ReturnType<typeof useChatVariables>['data'];
  onButtons: (buttons: { name: string; visible: boolean }[]) => void;
}) {
  const queryClient = useQueryClient();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const channelRef = useRef<FrameChannel | null>(null);
  const chat = useChat(chatId);
  const character = useCharacter(characterId);
  const settings = useCardSettings();
  const trust = trustFor(settings.data, characterId);

  const frameInfo: SandboxFrameInfo = useMemo(
    () => ({
      frameId: `script:${script.id}`,
      kind: 'script',
      nodeId: null,
      messageId: null,
      scriptId: script.id,
      scriptName: script.name,
      trust,
      index: 0,
    }),
    [script.id, script.name, trust],
  );

  const context = useMemo<CardHostContext>(
    () => ({
      chatId,
      // 脚本帧不绑定楼层：变量默认落在 head 上
      nodeId: chat.data?.headNodeId ?? null,
      detail: chat.data,
      charData: character.data?.data ?? null,
      variables: {
        message: variables?.message ?? {},
        chat: variables?.chat ?? {},
        character: variables?.character ?? {},
        global: variables?.global ?? {},
        script: {},
      },
      macros: {
        char: chat.data?.character?.name ?? '',
        user: '',
        description: '',
        personality: '',
        scenario: '',
        lastMessageId: (chat.data?.messageCount ?? 1) - 1,
        variables: variables?.message ?? {},
      },
      scriptButtons: script.buttons,
    }),
    [chatId, chat.data, character.data, variables, script.buttons],
  );
  const contextRef = useRef(context);
  contextRef.current = context;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
  }, [queryClient, chatId]);

  const handlers = useMemo(
    () =>
      createCardHandlers(() => contextRef.current, {
        notify: (level, message) => console.info(`[脚本 ${script.name}] ${level}: ${message}`),
        emit: (event, args) => emitCompat(event, ...args),
        invalidate,
        onGenerationEvent: (event, args) => channelRef.current?.emitEvent(event, args),
        setScriptButtons: onButtons,
      }),
    [invalidate, onButtons, script.name],
  );

  const srcdoc = useMemo(() => {
    const nonce = createNonce();
    const current = contextRef.current;
    const externals = settings.data?.externalLibs !== false;
    // 社区脚本是 ESM：`import '...'` 必须在 module 里
    const html = `<script type="module">${script.content}</script>`;
    return {
      nonce,
      doc: buildSrcdoc({
        html,
        nonce,
        frame: frameInfo,
        trust,
        appOrigin: window.location.origin,
        // 脚本的真身在 CDN 上，按字面猜不出要哪些库：全给
        libs: selectSandboxLibs(script.content, { all: true }),
        ...(externals ? { externalScripts: EXTERNAL_SCRIPTS, externalStyles: EXTERNAL_STYLES } : {}),
        bootstrap: guestBootstrapSource(),
        mirrors: {
          chatMessages: buildChatMirror(current),
          variables: current.variables,
          charData: current.charData,
          macroContext: current.macros,
          scriptButtons: script.buttons,
        },
      }),
    };
  }, [script.content, script.buttons, frameInfo, trust, settings.data?.externalLibs]);

  useEffect(() => {
    const element = frameRef.current;
    if (!element) return;
    const channel = createFrameChannel({
      frame: element,
      nonce: srcdoc.nonce,
      frameId: frameInfo.frameId,
      handlers,
      onError: (error) => console.warn(`[脚本 ${script.name}] ${error.message}`),
      onLog: (level, args) => console[level === 'error' ? 'error' : 'warn'](`[脚本 ${script.name}]`, ...args),
    });
    channelRef.current = channel;
    return () => {
      channelRef.current = null;
      channel.dispose();
    };
  }, [srcdoc, frameInfo.frameId, handlers, script.name]);

  useEffect(() => {
    const channel = channelRef.current;
    if (!channel) return;
    channel.pushMirror('variables', context.variables);
    channel.pushMirror('chatMessages', buildChatMirror(context));
    channel.pushMirror('charData', context.charData);
    channel.pushMirror('macroContext', context.macros);
  }, [context]);

  useEffect(() =>
    subscribeBus((event, args) => {
      channelRef.current?.emitEvent(event, args);
    }),
  );

  return (
    <iframe
      ref={frameRef}
      title={script.name}
      srcDoc={srcdoc.doc}
      sandbox={sandboxAttribute(trust)}
      referrerPolicy="no-referrer"
      hidden
      // hidden 的 iframe 仍然会执行脚本；尺寸给 0 免得影响布局
      style={{ width: 0, height: 0, border: 'none', position: 'absolute' }}
    />
  );
}
