import {
  substituteMacros,
  type SlashHost,
  type SlashInject,
  type SlashMessage,
  type SlashVarScope,
} from '@newtavern/core';
import type { QueryClient } from '@tanstack/react-query';

import { requestComposerInput } from './composer-bridge';
import { branchPath } from './host-bridge';
import { startImagine } from '../imagine/store';
import {
  deleteChatInjects,
  fetchChatInjects,
  fetchChatVariables,
  postChatInjects,
  replaceChatVariables,
  sandboxGenerate,
} from '../../lib/api-cards';
import {
  fetchJson,
  mutate,
  nodeText,
  queryKeys,
  type ChatDetail,
  type GenerateBody,
  type MessageNode,
} from '../../lib/api';
import { toast } from '../../components/ui/toast';

/**
 * slash 执行器的宿主实现（M5（三）契约 §3.1）。core 的 `runSlash` 只管解析与流程，
 * 所有「碰到应用状态」的动作都在这里翻译成 API 调用：
 *
 * - 变量：`local` = 会话的节点快照（与前端卡的 message/chat 同一份），`global` = 全局表；
 * - 消息：楼层号 = 当前分支 root→head 的下标（与前端卡同一套映射，见 host-bridge）；
 * - 生成：`/gen` `/genraw` 走沙箱 generate（不入树）；`/trigger` `/regenerate` 走正式生成；
 * - 注入：存会话 `metadata.injects`（与 `injectPrompts` 同一份）；
 * - 其他模块：`/bg`（M4（二）§A）、`/emote`（§B）、`/imagine`（§D）。
 *
 * Composer 与前端卡（`triggerSlash`）共用这一份，区别只在「变量快照挂在哪个节点」。
 */

export interface SlashHostOptions {
  chatId: string;
  /** 最新的会话详情（每次调用都重新取，命令之间消息树会变） */
  getDetail: () => ChatDetail | undefined;
  /** local 变量读写的节点：卡帧 = 帧所在节点；Composer / 脚本 = head */
  getNodeId: () => string | null;
  queryClient: QueryClient;
  /** 正式生成（useGeneration 的 generate）；不给时 `/trigger` 等命令报错 */
  generate?: (body: GenerateBody) => void;
}

function invalidateChat(queryClient: QueryClient, chatId: string): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.chat(chatId) });
  void queryClient.invalidateQueries({ queryKey: ['chats', chatId, 'variables'] });
}

const SEVERITY_TONE = {
  info: 'info',
  success: 'success',
  warning: 'warning',
  error: 'danger',
} as const;

interface BackgroundItem {
  assetId: string;
  name: string;
}

export function createSlashHost(options: SlashHostOptions): SlashHost {
  const { chatId, queryClient } = options;
  const chatUrl = `/api/chats/${encodeURIComponent(chatId)}`;

  /** 最新消息树：先读缓存，没有再取（命令里 /send 之后紧接着 /messages 要看得到新消息） */
  const loadDetail = async (): Promise<ChatDetail | undefined> => {
    const fresh = await queryClient
      .fetchQuery({
        queryKey: queryKeys.chat(chatId),
        queryFn: () => fetchJson<ChatDetail>(chatUrl),
        staleTime: 0,
      })
      .catch(() => undefined);
    return fresh ?? options.getDetail();
  };

  const require = <T>(value: T | undefined, message: string): T => {
    if (value === undefined) throw new Error(message);
    return value;
  };

  return {
    /** 执行器自己的宏（{{pipe}} {{getvar::}} …）展开完之后剩下的：{{char}} {{user}} 这类 */
    substitute(text: string) {
      const detail = options.getDetail();
      return substituteMacros(text, { char: detail?.character?.name ?? '', user: '' });
    },

    async readVariables(scope: SlashVarScope) {
      const table = await fetchChatVariables(chatId, options.getNodeId());
      return structuredClone(scope === 'global' ? table.global : table.message);
    },

    async writeVariables(scope: SlashVarScope, table: Record<string, unknown>) {
      if (scope === 'global') {
        await replaceChatVariables(chatId, { scope: 'global', variables: table });
      } else {
        await replaceChatVariables(chatId, {
          scope: 'message',
          nodeId: options.getNodeId(),
          variables: table,
        });
      }
      invalidateChat(queryClient, chatId);
    },

    echo(text, echoOptions) {
      toast({ title: text, tone: SEVERITY_TONE[echoOptions?.severity ?? 'info'] });
    },

    async sendMessage(input) {
      const result = await mutate<{ node: MessageNode }>(`${chatUrl}/messages`, 'POST', {
        role: input.role,
        text: input.text,
        ...(input.name ? { name: input.name } : {}),
      });
      // /comment：只给人看的系统消息，不进提示词（ST 的注释消息也不发给模型）
      if (input.comment && result?.node?.id) {
        await mutate(`${chatUrl}/nodes/${encodeURIComponent(result.node.id)}`, 'PATCH', {
          isHidden: true,
        });
      }
      invalidateChat(queryClient, chatId);
    },

    async getMessages(): Promise<SlashMessage[]> {
      const detail = await loadDetail();
      const characterName = detail?.character?.name ?? '';
      return branchPath(detail).map((node, index) => ({
        index,
        name: node.name ?? (node.role === 'user' ? 'User' : node.role === 'assistant' ? characterName : 'System'),
        role: node.role,
        text: nodeText(node),
        hidden: node.isHidden,
      }));
    },

    async setHidden(from, to, hidden) {
      const path = branchPath(await loadDetail());
      const low = Math.max(0, Math.min(from, to));
      const high = Math.min(path.length - 1, Math.max(from, to));
      for (let index = low; index <= high; index += 1) {
        const node = path[index];
        if (!node || node.isHidden === hidden) continue;
        await mutate(`${chatUrl}/nodes/${encodeURIComponent(node.id)}`, 'PATCH', { isHidden: hidden });
      }
      invalidateChat(queryClient, chatId);
    },

    async deleteMessages(indices) {
      const path = branchPath(await loadDetail());
      // 从大到小删：树上删节点连带后代，先删后面的楼层号才不会错位
      const targets = [...new Set(indices)]
        .sort((a, b) => b - a)
        .map((index) => path[index])
        .filter((node): node is MessageNode => node !== undefined);
      for (const node of targets) {
        await mutate(`${chatUrl}/nodes/${encodeURIComponent(node.id)}`, 'DELETE');
      }
      invalidateChat(queryClient, chatId);
    },

    setInput(text) {
      requestComposerInput(chatId, text);
    },

    async generate(prompt, generateOptions) {
      const result = await sandboxGenerate(chatId, {
        mode: generateOptions.raw ? 'raw' : 'generate',
        userInput: prompt,
        shouldStream: false,
        ...(generateOptions.raw ? { orderedPrompts: ['user_input'] } : {}),
      });
      return result.text;
    },

    async trigger() {
      const generate = require(options.generate, '这里不能触发生成（没有接到对话页）');
      generate({});
    },

    async continueGeneration() {
      // 新酒馆的生成还没有「接着上一条往下写」的模式：head 是用户消息时等同 /trigger，否则明确报错
      const generate = require(options.generate, '这里不能触发生成（没有接到对话页）');
      const detail = await loadDetail();
      const head = branchPath(detail).at(-1);
      if (head && head.role === 'assistant') {
        throw new Error('新酒馆还不支持续写（/continue）：请用 /trigger 让角色再说一段');
      }
      generate({});
    },

    async regenerate() {
      const generate = require(options.generate, '这里不能触发生成（没有接到对话页）');
      const head = branchPath(await loadDetail()).at(-1);
      if (head && head.role === 'assistant') generate({ parentId: head.parentId });
      else generate({});
    },

    async inject(prompt: SlashInject) {
      await postChatInjects(chatId, [prompt]);
    },

    async listInjects(): Promise<SlashInject[]> {
      const { injects } = await fetchChatInjects(chatId);
      return injects.map((item) => ({
        id: item.id,
        content: item.content,
        position: item.position,
        depth: item.depth,
        role: item.role,
        scan: item.scan === true,
      }));
    },

    async flushInjects() {
      await deleteChatInjects(chatId);
    },

    async setBackground(nameOrAssetId) {
      const key = nameOrAssetId.trim();
      let value: string | null;
      if (key === '' || key === 'none') value = key === 'none' ? 'none' : null;
      else {
        const list = await fetchJson<BackgroundItem[]>('/api/backgrounds');
        const found =
          list.find((item) => item.assetId === key) ??
          list.find((item) => item.name === key) ??
          list.find((item) => item.name.toLowerCase().includes(key.toLowerCase()));
        value = require(found, `找不到背景：${key}`).assetId;
      }
      // metadata 浅合并；null = 删掉该键（回到继承）
      await mutate(chatUrl, 'PATCH', { metadata: { background: value } });
      invalidateChat(queryClient, chatId);
    },

    async emote(label) {
      const path = branchPath(await loadDetail());
      const node = require(
        [...path].reverse().find((item) => item.role === 'assistant'),
        '当前分支上还没有角色的消息',
      );
      await mutate(`${chatUrl}/nodes/${encodeURIComponent(node.id)}/expression`, 'POST', { label });
      invalidateChat(queryClient, chatId);
    },

    async imagine(prompt) {
      const started = startImagine(queryClient, chatId, { mode: 'free', prompt });
      if (!started) throw new Error('这个会话正在生图，等它结束再试');
    },
  };
}
