import {
  buildSrcdoc,
  createFrameChannel,
  createNonce,
  guestBootstrapSource,
  sandboxAttribute,
  type FrameChannel,
  type SandboxFrameInfo,
} from '@newtavern/sandbox-sdk';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { emitCompat, subscribeBus } from './bus';
import { buildChatMirror, createCardHandlers, type CardHostContext } from './host-bridge';
import { EXTERNAL_SCRIPTS, EXTERNAL_STYLES, selectSandboxLibs } from './libs';
import { useCardMirrors } from './mirrors';
import { createSlashHost } from './slash-host';
import { useGeneration } from '../chat/useGeneration';
import { toast, toneOfLevel } from '../../components/ui/toast';
import {
  cardQueryKeys,
  trustFor,
  useCardSettings,
  useChatVariables,
  useMvuSettings,
} from '../../lib/api-cards';
import { fetchJson, queryKeys, useChat, useCharacter, type CharacterDetail } from '../../lib/api';
import { useScripts, type ScriptRow } from '../scripts/api';

/**
 * 脚本库：全局脚本、当前预设自带的脚本、角色卡自带的脚本，在**隐藏 iframe** 里跑。
 * 见 docs/M5-CONTRACT.md §4.7 与第二部分 §2.2。
 *
 * 运行顺序 = 按钮顺序：**全局 → 当前会话的预设 → 当前角色卡**（与酒馆助手一致）。
 * 全局与预设脚本存在 `scripts` 表（设置 · 脚本库），角色卡脚本仍在卡的 extensions 里
 * （`extensions.tavern_helper.scripts`（新）或 `extensions.TavernHelper_scripts`（旧），
 * 导入 ST 角色卡时这两个字段本来就原样保留）。设置 · 前端卡里的「脚本库」总开关关掉时三类都不跑。
 *
 * 和前端卡同一套沙箱与 RPC，区别只有三点：
 * 1. 帧不可见（`hidden`），没有高度回报；
 * 2. 帧身份是 `kind:'script'`，`getScriptId()` / `getScriptButtons()` 才有意义；
 * 3. 脚本正文是 **ES 模块**（社区脚本几乎都是 `import '...cdn.../bundle.js'`），
 *    所以包一层 `<script type="module">`。跨源模块要 CORS，jsdelivr 给了 `*`。
 */

export type ScriptSource = 'global' | 'preset' | 'character';

export interface CardScript {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  buttons: { name: string; visible: boolean }[];
  /** 酒馆助手 `button.enabled`：false 时按钮整体不显示 */
  buttonsEnabled: boolean;
  source: ScriptSource;
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
    // 旧格式（酒馆助手 3.x）的按钮在顶层 `buttons`
    const buttons = Array.isArray(button?.buttons)
      ? button.buttons
      : Array.isArray(item.buttons)
        ? item.buttons
        : [];
    return {
      id: typeof item.id === 'string' ? item.id : `script-${index}`,
      name: typeof item.name === 'string' ? item.name : `脚本 ${index + 1}`,
      content: typeof item.content === 'string' ? item.content : '',
      enabled: item.enabled !== false,
      buttons: buttons.filter(isRecord).map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        visible: entry.visible !== false,
      })),
      buttonsEnabled: button?.enabled !== false,
      source: 'character' as const,
    };
  });
}

/** 脚本库的一行 → 运行用的形状 */
export function fromScriptRow(row: ScriptRow): CardScript {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    enabled: row.enabled,
    buttons: row.buttons,
    buttonsEnabled: row.buttonsEnabled,
    source: row.scope,
  };
}

/**
 * 原版 MVU 框架脚本：新酒馆自带变量引擎（服务端跑，见 M5 契约 §2），
 * 再让这张卡把 MagVarUpdate 拉起来只会两套引擎打架 —— 内置引擎开着时跳过它。
 * 用户想用原版：设置 → 前端卡里关掉「自动解析变量更新」，脚本就会照常运行。
 */
export function isMvuFrameworkScript(script: Pick<CardScript, 'content'>): boolean {
  return /magvarupdate/i.test(script.content);
}

/**
 * 三类脚本按运行顺序（全局 → 预设 → 角色卡）合并，并筛掉不该跑的：
 * 关着的、空的、内置 MVU 开着时的原版 MVU 框架脚本（三类一视同仁）。纯函数，单测直接测它。
 */
export function collectRunnableScripts(
  sources: {
    global: readonly CardScript[];
    preset: readonly CardScript[];
    character: readonly CardScript[];
  },
  options: { builtinMvu: boolean; onSkip?: (script: CardScript) => void },
): CardScript[] {
  return [...sources.global, ...sources.preset, ...sources.character]
    .filter((script) => script.enabled && script.content.trim() !== '')
    .filter((script) => {
      if (!options.builtinMvu || !isMvuFrameworkScript(script)) return true;
      options.onSkip?.(script);
      return false;
    });
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
  const presetId = chat.data?.presetId ?? null;
  const globalRows = useScripts('global', null);
  const presetRows = useScripts('preset', presetId);

  const mvu = useMvuSettings();
  const builtinMvu = mvu.data?.enabled !== false;
  const scripts = useMemo(
    () =>
      collectRunnableScripts(
        {
          global: (globalRows.data ?? []).map(fromScriptRow),
          preset: presetId ? (presetRows.data ?? []).map(fromScriptRow) : [],
          character: readCharacterScripts(character.data),
        },
        {
          builtinMvu,
          onSkip: (script) =>
            console.info(
              `[脚本 ${script.name}] 跳过：新酒馆自带 MVU 变量引擎（设置 → 前端卡里可切换）`,
            ),
        },
      ),
    [globalRows.data, presetRows.data, presetId, character.data, builtinMvu],
  );

  const [buttons, setButtons] = useState<Record<string, { name: string; visible: boolean }[]>>({});

  const enabled = settings.data?.scripts !== false;
  // 同前端卡：脚本也会在启动时同步读一次变量，等取回来再跑
  const ready = variables.isSuccess || variables.isError;
  if (!enabled || !ready || scripts.length === 0) return null;

  const frameKey = (script: CardScript) => `${script.source}:${script.id}`;
  const visibleButtons = scripts.flatMap((script) =>
    (script.buttonsEnabled ? (buttons[frameKey(script)] ?? script.buttons) : [])
      .filter((button) => button.visible && button.name !== '')
      .map((button) => ({ key: frameKey(script), scriptId: script.id, name: button.name })),
  );

  return (
    <>
      {scripts.map((script) => (
        <ScriptFrame
          key={frameKey(script)}
          chatId={chatId}
          characterId={characterId}
          script={script}
          variables={variables.data}
          onButtons={(list) => setButtons((current) => ({ ...current, [frameKey(script)]: list }))}
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
              key={`${button.key}:${button.name}`}
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
  const mirrors = useCardMirrors(chat.data);
  const mirrorsRef = useRef(mirrors);
  mirrorsRef.current = mirrors;
  const generation = useGeneration(chatId);
  const generateRef = useRef(generation.generate);
  generateRef.current = generation.generate;
  /** 脚本自己的变量表（酒馆助手 `getVariables({type:'script'})`），按脚本 id 存 */
  const scriptVariables = useQuery({
    queryKey: cardQueryKeys.variableTable('script', script.id),
    queryFn: () =>
      fetchJson<{ variables: Record<string, unknown> }>(
        `/api/variables/script?ownerId=${encodeURIComponent(script.id)}`,
      ),
  });

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
        script: scriptVariables.data?.variables ?? {},
        preset: variables?.preset ?? {},
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
      scriptId: script.id,
    }),
    [chatId, chat.data, character.data, variables, scriptVariables.data, script.buttons, script.id],
  );
  const contextRef = useRef(context);
  contextRef.current = context;

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
    void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
    void queryClient.invalidateQueries({
      queryKey: cardQueryKeys.variableTable('script', script.id),
    });
  }, [queryClient, chatId, script.id]);

  const handlers = useMemo(
    () =>
      createCardHandlers(() => contextRef.current, {
        // 脚本的 toastr → 应用级提示条；标题缺省用脚本名（得知道是谁在说话）
        notify: (level, message, title) =>
          toast({
            title: title || script.name,
            ...(message ? { description: message } : {}),
            tone: toneOfLevel(level),
          }),
        emit: (event, args) => emitCompat(event, ...args),
        invalidate,
        onGenerationEvent: (event, args) => channelRef.current?.emitEvent(event, args),
        setScriptButtons: onButtons,
        // 脚本的 triggerSlash：变量快照挂在 head 上（与脚本帧的 message 作用域一致）
        slashHost: () =>
          createSlashHost({
            chatId,
            getDetail: () => contextRef.current.detail,
            getNodeId: () => contextRef.current.nodeId,
            queryClient,
            generate: (body) => generateRef.current(body),
          }),
      }),
    [invalidate, onButtons, script.name, chatId, queryClient],
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
        ...(externals
          ? { externalScripts: EXTERNAL_SCRIPTS, externalStyles: EXTERNAL_STYLES }
          : {}),
        bootstrap: guestBootstrapSource(),
        mirrors: {
          chatMessages: buildChatMirror(current),
          variables: current.variables,
          charData: current.charData,
          macroContext: current.macros,
          scriptButtons: script.buttons,
          presets: mirrorsRef.current.presets,
          regex: mirrorsRef.current.regex,
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
      onLog: (level, args) =>
        console[level === 'error' ? 'error' : 'warn'](`[脚本 ${script.name}]`, ...args),
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

  useEffect(() => {
    channelRef.current?.pushMirror('presets', mirrors.presets);
  }, [mirrors.presets]);
  useEffect(() => {
    channelRef.current?.pushMirror('regex', mirrors.regex);
  }, [mirrors.regex]);

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
