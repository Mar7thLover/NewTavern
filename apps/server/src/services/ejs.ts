import { createEjsRenderer, ejsEngineLoadMs, type EjsEnv } from '@newtavern/compat/ejs';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssembleInputV2 } from './assemble.js';

/**
 * EJS 提示词模板的服务端接线（M5（三）契约 §4.2）。
 *
 * - 开关：settings KV `ejs: { enabled: boolean }`，**缺省开**（设置 → 前端卡）。
 * - 每次组装一个渲染器：host 闭包里是本次组装可见的世界书（`getwi` 的查找范围，含禁用条目）
 *   与模板能读的上下文值；变量工作副本由组装器在每次渲染时传入（`ctx.vars`）。
 * - 渲染器的 QuickJS 沙箱在这一轮同步组装结束后自动释放（见 compat `renderer.ts`），
 *   所以 generate / inspect / 前端卡 generate 各调用点不需要额外 dispose。
 * - 引擎（WASM）在 `@newtavern/compat/ejs` 加载时准备好；加载耗时见 `ejsEngineLoadMs`。
 */

export const EJS_SETTINGS_KEY = 'ejs';

export interface EjsSettings {
  enabled: boolean;
}

export function readEjsSettings(db: Db): EjsSettings {
  const value = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, EJS_SETTINGS_KEY))
    .get()?.value;
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return { enabled: typeof record.enabled === 'boolean' ? record.enabled : true };
}

function lastIndexOf<T>(items: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item !== undefined && predicate(item)) return i;
  }
  return -1;
}

/** 模板里可直接读的上下文（ST-PT `prepareContext` 的同名字段，取组装输入能给的那些） */
export function ejsEnvFor(input: AssembleInputV2): EjsEnv {
  const visible = input.history.filter((node) => node.isHidden !== true);
  const textOf = (index: number): string => {
    const node = visible[index];
    if (!node) return '';
    return node.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  };
  const lastUser = lastIndexOf(visible, (node) => node.role === 'user');
  const lastChar = lastIndexOf(visible, (node) => node.role === 'assistant');
  const charName = input.character?.name ?? '';
  return {
    userName: input.persona?.name ?? '',
    charName,
    assistantName: charName,
    chatId: input.chatId,
    ...(input.character ? { characterId: input.character.id } : {}),
    model: input.model,
    lastUserMessageId: lastUser,
    lastUserMessage: textOf(lastUser),
    lastCharMessageId: lastChar,
    lastCharMessage: textOf(lastChar),
    lastMessageId: visible.length - 1,
    runType: 'generate',
  };
}

/** 按设置给组装输入挂上 EJS 渲染器；关闭时原样返回（与黄金测试同一路径） */
export function withTemplateRenderer(db: Db, input: AssembleInputV2): AssembleInputV2 {
  if (!readEjsSettings(db).enabled) return input;
  const renderer = createEjsRenderer({ lorebooks: input.lorebooks, env: ejsEnvFor(input) });
  return { ...input, templateRenderer: renderer.render };
}

export { ejsEngineLoadMs };
