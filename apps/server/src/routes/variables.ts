import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';
import { loadChat, loadNodes, textOfParts, type ChatRow, type NodeRow } from '../services/chat-tree.js';
import {
  ensureMvuInitialized,
  isPrunedSnapshot,
  parseMvuMessage,
  replayMvuFrom,
  runMvuForNode,
  writeNodeVariables,
} from '../services/mvu.js';
import {
  readVariableTable,
  replaceVariableTable,
  type VariableTableScope,
} from '../services/variables.js';
import {
  isSchemaScope,
  readChatInjects,
  readVariableSchemas,
  removeChatInjects,
  upsertChatInjects,
  writeVariableSchema,
} from '../services/chat-injects.js';
import type { Part } from '@newtavern/core';

/**
 * 变量读写与 MVU 重放。见 docs/M5-CONTRACT.md §3.4。
 *
 * 五种作用域对应酒馆助手 `getVariables({type})`：
 * `message`（节点快照，MVU 在这）/ `chat`（= 同一份节点快照，与 `{{getvar}}` 一致）/
 * `character` / `global` / `script`。
 *
 * 为什么变量不随 ChatDetail 一起下发：快照里有 `stat_data` + `display_data`，
 * 一条几 KB，长对话会把列表接口撑爆（M4 §4）。要内容就按需取这里。
 */

/** 前端卡能写的五种作用域；`message` 与 `chat` 落到节点快照，其余落到 `variables` 表 */
type Scope = 'message' | 'chat' | VariableTableScope;

const SCOPES: readonly Scope[] = ['message', 'chat', 'character', 'global', 'script', 'preset'];

/** 与会话无关的表（`/api/variables/:scope`） */
const TABLE_SCOPES: readonly VariableTableScope[] = ['global', 'character', 'script', 'chat', 'preset'];

function isTableScope(value: unknown): value is VariableTableScope {
  return typeof value === 'string' && (TABLE_SCOPES as readonly string[]).includes(value);
}

function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 目标节点：显式 nodeId → head → 无 */
function resolveNode(db: Db, chat: ChatRow, nodeId: string | undefined): NodeRow | undefined {
  const nodes = loadNodes(db, chat.id);
  if (nodeId) return nodes.find((node) => node.id === nodeId);
  if (chat.headNodeId) return nodes.find((node) => node.id === chat.headNodeId);
  return undefined;
}

/**
 * 该节点自己的快照；没有就沿路径往上找最近的一份（user 节点没有快照）。
 *
 * 一路找不到时**回落到 `[InitVar]` 的初始形态**而不是空表：开场白那条消息上
 * 就挂着前端卡，而它还没经历过任何一轮生成。空表会让卡一直卡在
 * 「等 stat_data 出现」上（社区卡普遍这么等），给初始值它就能先画出来。
 * 注意这里只算不写：真正落库还是等某一轮生成。
 */
function snapshotFor(db: Db, chat: ChatRow, node: NodeRow | undefined): Record<string, unknown> {
  if (node) {
    if (node.variables && !isPrunedSnapshot(node.variables)) return node.variables;
    const nodes = loadNodes(db, chat.id);
    const byId = new Map(nodes.map((row) => [row.id, row]));
    let cursor: NodeRow | undefined = node.parentId ? byId.get(node.parentId) : undefined;
    while (cursor) {
      if (cursor.variables && !isPrunedSnapshot(cursor.variables)) return cursor.variables;
      cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
    }
  }
  return ensureMvuInitialized(db, chat, {}).variables;
}

export function createChatVariablesRoutes(db: Db) {
  return new Hono()
    .get('/:id/variables', (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      const node = resolveNode(db, chat, c.req.query('nodeId'));
      const message = snapshotFor(db, chat, node);
      const characterId = chat.characterIds[0];
      return c.json({
        nodeId: node?.id ?? null,
        message,
        // chat 与 message 是同一份表：新酒馆的聊天变量本来就按节点存（M3 §3.5）
        chat: message,
        global: readVariableTable(db, 'global'),
        character: characterId ? readVariableTable(db, 'character', characterId) : {},
        // 当前会话预设的变量表（M5（三）§1）；没选预设时是空表
        preset: chat.presetId ? readVariableTable(db, 'preset', chat.presetId) : {},
        presetId: chat.presetId ?? null,
        // registerVariableSchema 交上来的 JSON Schema（变量管理器据此标错）
        schemas: readVariableSchemas(chat),
      });
    })
    .put('/:id/variables', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown>;
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
      }
      const scope = body.scope;
      if (!isScope(scope)) {
        return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
      }
      if (!isRecord(body.variables)) {
        return c.json({ error: 'invalid', message: 'variables 必须是对象' }, 400);
      }
      const variables = body.variables;

      if (scope === 'message' || scope === 'chat') {
        const nodeId = typeof body.nodeId === 'string' ? body.nodeId : undefined;
        const node = resolveNode(db, chat, nodeId);
        if (!node) return c.json({ error: 'invalid', message: '找不到目标消息节点' }, 400);
        return c.json({
          scope,
          nodeId: node.id,
          variables: writeNodeVariables(db, node.id, variables),
        });
      }
      const ownerId =
        scope === 'character'
          ? (chat.characterIds[0] ?? '')
          : scope === 'preset'
            ? typeof body.ownerId === 'string' && body.ownerId !== ''
              ? body.ownerId
              : (chat.presetId ?? '')
            : typeof body.ownerId === 'string'
              ? body.ownerId
              : '';
      if (scope === 'character' && ownerId === '') {
        return c.json({ error: 'invalid', message: '这个会话没有绑定角色卡' }, 400);
      }
      if (scope === 'preset' && ownerId === '') {
        return c.json({ error: 'invalid', message: '这个会话没有选预设' }, 400);
      }
      return c.json({
        scope,
        ownerId,
        variables: replaceVariableTable(db, scope, ownerId, variables, chat.headNodeId ?? null),
      });
    })
    /**
     * 会话级临时注入（酒馆助手 `injectPrompts` / `uninjectPrompts`、slash `/inject`，M5（三）§3.2）。
     * 存 `chats.metadata.injects`，组装时并进 extraInjections。
     */
    .get('/:id/injects', (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      return c.json({ injects: readChatInjects(chat) });
    })
    .post('/:id/injects', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
      }
      if (!Array.isArray(body.prompts)) {
        return c.json({ error: 'invalid', message: 'prompts 必须是数组' }, 400);
      }
      return c.json({
        injects: upsertChatInjects(db, chat.id, body.prompts, { once: body.once === true }),
      });
    })
    /** body `{ ids?: string[] }`；不给 ids = 全部清空 */
    .delete('/:id/injects', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const ids = Array.isArray(body.ids)
        ? body.ids.filter((id): id is string => typeof id === 'string')
        : undefined;
      return c.json({ injects: removeChatInjects(db, chat.id, ids) });
    })
    /** registerVariableSchema：`{ type, schema }`（schema 为 null = 删除），按会话存 */
    .put('/:id/variable-schemas', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
      }
      if (!isSchemaScope(body.type)) return c.json({ error: 'invalid', message: 'type 非法' }, 400);
      if (body.schema !== null && !isRecord(body.schema)) {
        return c.json({ error: 'invalid', message: 'schema 必须是对象或 null' }, 400);
      }
      return c.json({
        schemas: writeVariableSchema(
          db,
          chat.id,
          body.type,
          body.schema === null ? null : (body.schema as Record<string, unknown>),
        ),
      });
    })
    /** MVU：重放（从某个节点起沿当前 head 路径重算），不传 nodeId = 整条路径 */
    .post('/:id/mvu/replay', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const nodeId = typeof body.nodeId === 'string' ? body.nodeId : null;
      return c.json({ results: replayMvuFrom(db, chat, nodeId) });
    })
    /**
     * MVU：只解析不落库（前端卡的 `Mvu.parseMessage`）。
     * `message` 缺省取该节点的正文，`data` 缺省取该节点的快照。
     */
    .post('/:id/mvu/parse', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const node = resolveNode(db, chat, typeof body.nodeId === 'string' ? body.nodeId : undefined);
      const message =
        typeof body.message === 'string'
          ? body.message
          : textOfParts(((node?.parts ?? []) as Part[] | null) ?? []);
      const base = isRecord(body.data) ? body.data : snapshotFor(db, chat, node);
      const result = parseMvuMessage(db, chat, base, message);
      return c.json({
        changed: result.changed,
        variables: result.data,
        updates: result.updates,
        errors: result.errors,
      });
    })
    /** MVU：重新解析某个节点的正文并写回它自己的快照（对应「重新处理变量」按钮） */
    .post('/:id/mvu/run', async (c) => {
      const chat = loadChat(db, c.req.param('id'));
      if (!chat) return c.json({ error: 'not_found' }, 404);
      let body: Record<string, unknown> = {};
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const node = resolveNode(db, chat, typeof body.nodeId === 'string' ? body.nodeId : undefined);
      if (!node) return c.json({ error: 'invalid', message: '找不到目标消息节点' }, 400);
      const result = runMvuForNode(
        db,
        chat,
        node,
        textOfParts(((node.parts ?? []) as Part[] | null) ?? []),
      );
      return c.json(
        result ?? {
          nodeId: node.id,
          changed: false,
          variables: node.variables ?? {},
          updates: [],
          errors: [],
        },
      );
    });
}

/** 与会话无关的变量表（全局 / 角色 / 脚本） */
export function createVariablesRoutes(db: Db) {
  return new Hono()
    .get('/:scope', (c) => {
      const scope = c.req.param('scope');
      if (!isTableScope(scope)) {
        return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
      }
      const ownerId = c.req.query('ownerId') ?? '';
      return c.json({ scope, ownerId, variables: readVariableTable(db, scope, ownerId) });
    })
    .put('/:scope', async (c) => {
      const scope = c.req.param('scope');
      if (!isTableScope(scope)) {
        return c.json({ error: 'invalid', message: 'scope 非法' }, 400);
      }
      let body: Record<string, unknown>;
      try {
        body = ((await c.req.json()) ?? {}) as Record<string, unknown>;
      } catch {
        return c.json({ error: 'invalid', message: '请求体不是合法 JSON' }, 400);
      }
      if (!isRecord(body.variables)) {
        return c.json({ error: 'invalid', message: 'variables 必须是对象' }, 400);
      }
      const ownerId = typeof body.ownerId === 'string' ? body.ownerId : '';
      return c.json({
        scope,
        ownerId,
        variables: replaceVariableTable(db, scope, ownerId, body.variables, null),
      });
    })
    /** 变量事件日志（变量面板的「最近变化」） */
    .get('/:scope/events', (c) => {
      const scope = c.req.param('scope');
      const rows = db.select().from(schema.variableEvents).all();
      return c.json(
        rows
          .filter((row) => row.scope === scope)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, 100),
      );
    });
}
