/**
 * slash 执行器与宿主之间的接口。见 docs/M5-CONTRACT.md 第二部分 §3.1。
 *
 * core 只管解析与语义；一切副作用（读写变量、发消息、生成、注入、换背景……）都经这里交给宿主，
 * web 端的实现在 `apps/web/src/features/cards/slash-host.ts`。
 */

export type SlashVarScope = 'local' | 'global';

export interface SlashMessage {
  /** 楼层号（当前分支 root→head 的下标） */
  index: number;
  name: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  hidden: boolean;
}

export interface SlashInject {
  id: string;
  content: string;
  position: 'in_chat' | 'none';
  depth: number;
  role: 'system' | 'user' | 'assistant';
  scan: boolean;
}

export interface SlashHost {
  /** 读一张变量表（local = 当前会话节点快照，即 ST 的 chat 变量；global = 全局表）。返回的对象执行器可以就地改后再 write */
  readVariables(scope: SlashVarScope): Promise<Record<string, unknown>>;
  /** 整表写回 */
  writeVariables(scope: SlashVarScope, table: Record<string, unknown>): Promise<void>;
  /** /echo：给用户一个提示（toast） */
  echo(text: string, options?: { severity?: 'info' | 'success' | 'warning' | 'error' }): void;
  /** /send /sendas /sys /narrate /comment：追加一条消息到当前分支末尾 */
  sendMessage(input: {
    role: 'user' | 'assistant' | 'system';
    text: string;
    name?: string;
    comment?: boolean;
  }): Promise<void>;
  /** 当前分支 root→head 的消息（楼层号 = 下标） */
  getMessages(): Promise<SlashMessage[]>;
  /** /hide /unhide：按楼层号区间（含两端） */
  setHidden(from: number, to: number, hidden: boolean): Promise<void>;
  /** /cut：删掉这些楼层（宿主负责「删节点连带后代」的语义与从大到小删） */
  deleteMessages(indices: number[]): Promise<void>;
  /** /setinput */
  setInput(text: string): void;
  /** /gen /genraw：一次不入树的生成（raw=true 不用预设，只发 prompt）；lock 忽略即可 */
  generate(prompt: string, options: { raw: boolean }): Promise<string>;
  /** /trigger /continue /regenerate */
  trigger(): Promise<void>;
  continueGeneration(): Promise<void>;
  regenerate(): Promise<void>;
  /** /inject /listinjects /flushinjects：会话级注入（存 chats.metadata.injects） */
  inject(prompt: SlashInject): Promise<void>;
  listInjects(): Promise<SlashInject[]>;
  flushInjects(): Promise<void>;
  /** 其他模块（M4（二） §A/§B/§D） */
  setBackground(nameOrAssetId: string): Promise<void>;
  emote(label: string): Promise<void>;
  imagine(prompt: string): Promise<void>;
  /**
   * 可选：展开执行器不认识的宏（`{{char}}` `{{user}}` …）。执行器先展开自己的
   * `{{pipe}}` `{{var::}}` `{{getvar::}}` `{{getglobalvar::}}` `{{timesIndex}}`，余下的交给它。
   */
  substitute?(text: string): string;
}
