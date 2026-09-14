import { eq } from 'drizzle-orm';

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

/** 设置 KV `generation.default` */
export function readGenerationDefault(db: Db): {
  connectionId: string | null;
  model: string | null;
} {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, 'generation.default'))
    .get();
  const value = (row?.value ?? null) as { connectionId?: unknown; model?: unknown } | null;
  return {
    connectionId: typeof value?.connectionId === 'string' ? value.connectionId : null,
    model: typeof value?.model === 'string' ? value.model : null,
  };
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
