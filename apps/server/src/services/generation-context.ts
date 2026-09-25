import { desc, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import {
  loadChat,
  loadNodes,
  type ChatOverrides,
  type ChatRow,
  type NodeRow,
} from './chat-tree.js';
import {
  ProviderServiceError,
  type ProviderService,
  type ResolvedConnection,
} from './providers.js';

/**
 * generate 与 inspect 共用的前置解析：聊天 → 连接/模型 → 父节点 → 布局模式。
 * 见 docs/M3-CONTRACT.md §3.6。错误一律抛 `GenerationContextError`，路由层直接转 JSON。
 */

export type LayoutMode = 'strict' | 'cache-aware';

export interface GenerationContextInput {
  chatId: string;
  /** 缺省（undefined）= 取 head；显式 null = 从根开始 */
  parentId?: string | null;
  connectionId?: string | null;
  model?: string | null;
  layoutMode?: string | null;
}

export interface GenerationContext {
  chat: ChatRow;
  overrides: ChatOverrides;
  /** 该聊天的全部节点（按时间序），复用避免重复查询 */
  nodes: NodeRow[];
  parentId: string | null;
  connectionId: string;
  model: string;
  resolved: ResolvedConnection;
  layoutMode: LayoutMode;
}

export class GenerationContextError extends Error {
  constructor(
    readonly status: 400 | 404,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.message === 'string' ? body.message : String(body.error));
  }
}

const GENERATION_DEFAULT_KEY = 'generation.default';

type GenerationDefault = { connectionId: string | null; model: string | null };

function connectionExists(db: Db, id: string): boolean {
  return (
    db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(eq(schema.connections.id, id))
      .get() !== undefined
  );
}

function readStoredDefault(db: Db): GenerationDefault | null {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, GENERATION_DEFAULT_KEY))
    .get();
  if (!row) return null;
  const value = (row.value ?? null) as { connectionId?: unknown; model?: unknown } | null;
  return {
    connectionId: typeof value?.connectionId === 'string' ? value.connectionId : null,
    model: typeof value?.model === 'string' ? value.model : null,
  };
}

/**
 * 设置 KV `generation.default`（没有单独选过连接 / 模型的地方都用它）。
 * 指向已删除的连接时视为没有默认（连同模型一起作废），不把请求发给不存在的连接。
 */
export function readGenerationDefault(db: Db): GenerationDefault {
  const stored = readStoredDefault(db);
  if (!stored?.connectionId || !connectionExists(db, stored.connectionId)) {
    return { connectionId: null, model: null };
  }
  return stored;
}

/**
 * 记住「上次使用的」连接与模型：成功发起一次生成（对话 / 测试对话 / AI 协作 / 写作）或在会话里
 * 选定连接 + 模型时调用，之后新建的对话、工作台、写作都默认用它。两者缺一不写。
 */
export function rememberGenerationDefault(
  db: Db,
  connectionId: string | null | undefined,
  model: string | null | undefined,
): void {
  if (!connectionId || !model) return;
  const stored = readStoredDefault(db);
  if (stored?.connectionId === connectionId && stored.model === model) return;
  const value = { connectionId, model };
  db.insert(schema.settings)
    .values({ key: GENERATION_DEFAULT_KEY, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

/**
 * 默认指向的连接不存在了（被删除）：改用最近一次对话实际用过、且连接仍在的连接 + 模型；
 * 找不到就删掉这条设置。启动时与删除连接后调用（幂等）。
 */
export function repairGenerationDefault(db: Db): void {
  const stored = readStoredDefault(db);
  if (!stored || (stored.connectionId && connectionExists(db, stored.connectionId))) return;
  const recent = db
    .select({ overrides: schema.chats.overrides })
    .from(schema.chats)
    .orderBy(desc(schema.chats.updatedAt))
    .all();
  for (const chat of recent) {
    const overrides = (chat.overrides as ChatOverrides | null) ?? {};
    if (overrides.connectionId && overrides.model && connectionExists(db, overrides.connectionId)) {
      rememberGenerationDefault(db, overrides.connectionId, overrides.model);
      return;
    }
  }
  db.delete(schema.settings).where(eq(schema.settings.key, GENERATION_DEFAULT_KEY)).run();
}

export async function resolveGenerationContext(
  db: Db,
  providers: ProviderService,
  input: GenerationContextInput,
): Promise<GenerationContext> {
  const chat = loadChat(db, input.chatId);
  if (!chat) throw new GenerationContextError(404, { error: 'not_found' });

  const overrides = (chat.overrides as ChatOverrides | null) ?? {};
  const fallback = readGenerationDefault(db);
  const connectionId = input.connectionId ?? overrides.connectionId ?? fallback.connectionId;
  const model = input.model ?? overrides.model ?? fallback.model;
  if (!connectionId || !model) {
    throw new GenerationContextError(400, { error: 'no_connection', message: '未指定连接或模型' });
  }

  let resolved: ResolvedConnection;
  try {
    resolved = await providers.resolveConnection(connectionId);
  } catch (e) {
    if (e instanceof ProviderServiceError) {
      throw new GenerationContextError(
        400,
        e.code === 'not_found'
          ? { error: 'no_connection', message: e.message }
          : { error: e.code, kind: e.kind, message: e.message },
      );
    }
    throw e;
  }

  const nodes = loadNodes(db, chat.id);
  const parentId = input.parentId !== undefined ? (input.parentId ?? null) : chat.headNodeId;
  if (parentId !== null && !nodes.some((node) => node.id === parentId)) {
    throw new GenerationContextError(400, {
      error: 'invalid',
      message: `父节点不存在：${parentId}`,
    });
  }

  const requested = input.layoutMode ?? overrides.layoutMode ?? 'strict';
  if (requested !== 'strict' && requested !== 'cache-aware') {
    throw new GenerationContextError(400, { error: 'invalid', message: 'layoutMode 非法' });
  }

  return {
    chat,
    overrides,
    nodes,
    parentId,
    connectionId,
    model,
    resolved,
    layoutMode: requested,
  };
}
