import fs from 'node:fs';

import type { GenEvent } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
} from './test-helpers.js';

/**
 * MVU 的服务端链路（M5 契约 §2）：`[InitVar]` 初始化 → 提示词里的
 * `{{get_message_variable::stat_data}}` → 解析模型输出的 `<UpdateVariable>` →
 * 写回节点快照 → SSE `variables` → swipe 从父快照重算 → 重放。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Node {
  id: string;
  role: string;
  parentId: string | null;
  hasVariables: boolean;
  parts: { type: string; text?: string }[];
}
interface Detail {
  id: string;
  headNodeId: string | null;
  nodes: Node[];
}
interface VariablesResponse {
  nodeId: string | null;
  message: Record<string, unknown>;
  chat: Record<string, unknown>;
  global: Record<string, unknown>;
  character: Record<string, unknown>;
}

/** 一本带 `[InitVar]`（禁用，社区惯例）与一条常量提示词条目的世界书 */
function insertMvuBook(db: Db, name = '测试书'): string {
  const book = db.insert(schema.lorebooks).values({ name, scope: 'global' }).returning().get();
  db.insert(schema.lorebookEntries)
    .values({
      bookId: book.id,
      comment: '[InitVar]请勿打开',
      content: '好感度: 30\n时间: 08:00\n昔涟:\n  位置: 客厅\n',
      // 禁用条目也要被 MVU 读到
      disabled: true,
      constant: true,
      position: 4,
    })
    .run();
  db.insert(schema.lorebookEntries)
    .values({
      bookId: book.id,
      comment: '变量输出格式',
      content: '<status>\n{{get_message_variable::stat_data}}\n</status>',
      constant: true,
      position: 0,
      keys: [],
    })
    .run();
  return book.id;
}

function insertCharacter(db: Db): string {
  return db
    .insert(schema.characters)
    .values({
      name: '昔涟',
      spec: 'v2',
      data: { name: '昔涟', description: '黄金庭院的住客。', first_mes: '你来了。' },
    })
    .returning()
    .get().id;
}

async function enableGlobalBook(app: ReturnType<typeof makeTestApp>['app'], bookId: string) {
  await app.request('/api/settings/worldInfo.globalBookIds', put([bookId]));
}

/** 助手输出：正文 + 一段变量更新 */
function events(text: string): GenEvent[] {
  return [
    { type: 'text.delta', text },
    { type: 'usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { type: 'stop', reason: 'end' },
  ];
}

describe('MVU：初始化与更新', () => {
  it('第一轮：InitVar 进提示词、更新命令写回节点快照、SSE 推 variables', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'mvu-fake-1');
    registerFakeAdapter({
      id: 'mvu-fake-1',
      renderMessages: true,
      events: events(
        '她抬起头。\n<UpdateVariable>\n_.set(\'好感度\', 30, 35);//并肩作战\n_.set(\'昔涟.位置\', \'屋顶花园\');\n</UpdateVariable>',
      ),
    });
    const bookId = insertMvuBook(db, '第一轮书');
    await enableGlobalBook(app, bookId);
    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );

    const raw = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '早上好。' } }))
    ).text();
    const sse = parseSse(raw);
    const names = sse.map((event) => event.event);
    // 初始化事件在组装之后立刻推，更新事件在 done 之前
    expect(names).toContain('variables');

    // 提示词里 {{get_message_variable::stat_data}} 已展开成初始值
    // （落库的 `extra.request` 是脱敏后的同一份请求体，只在服务端可见）
    const requestBody = JSON.stringify(
      db
        .select()
        .from(schema.messageNodes)
        .all()
        .map((node) => (node.extra as { request?: unknown } | null)?.request ?? null),
    );
    expect(requestBody).toContain('好感度');
    expect(requestBody).not.toContain('get_message_variable');

    const variableEvents = sse.filter((event) => event.event === 'variables');
    expect(variableEvents[0]?.data.initialized).toEqual(['第一轮书']);
    const last = variableEvents[variableEvents.length - 1]?.data as {
      nodeId: string;
      variables: { stat_data: Record<string, unknown>; delta_data?: Record<string, unknown> };
      updates: { path: string; display: string }[];
    };
    expect(last.variables.stat_data.好感度).toBe(35);
    expect((last.variables.stat_data.昔涟 as Record<string, unknown>).位置).toBe('屋顶花园');
    expect(last.updates.map((update) => update.path)).toEqual(['好感度', '昔涟.位置']);
    expect(last.updates[0]?.display).toBe('30->35 (并肩作战)');

    // 节点快照落库，且 ChatDetail 只给布尔标记不给内容
    const detail = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    const assistant = detail.nodes.find((node) => node.id === last.nodeId);
    expect(assistant?.hasVariables).toBe(true);
    expect(JSON.stringify(detail)).not.toContain('stat_data');

    const variables = (await (
      await app.request(`/api/chats/${chat.id}/variables?nodeId=${last.nodeId}`)
    ).json()) as VariablesResponse;
    expect((variables.message.stat_data as Record<string, unknown>).好感度).toBe(35);
    // chat 与 message 是同一份表
    expect(variables.chat).toEqual(variables.message);
  });

  it('第二轮从父快照继续；重生（同一位置再生成）不会二次推进', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'mvu-fake-2');
    registerFakeAdapter({
      id: 'mvu-fake-2',
      events: events("<UpdateVariable>\n_.add('好感度', 5);\n</UpdateVariable>"),
    });
    const bookId = insertMvuBook(db, '第二轮书');
    await enableGlobalBook(app, bookId);
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );

    const runOnce = async (parentId?: string | null) => {
      const raw = await (
        await app.request(
          `/api/chats/${chat.id}/generate`,
          post({ userMessage: { text: '继续。' }, ...(parentId === undefined ? {} : { parentId }) }),
        )
      ).text();
      const variableEvents = parseSse(raw).filter((event) => event.event === 'variables');
      return variableEvents[variableEvents.length - 1]?.data as {
        nodeId: string;
        variables: { stat_data: Record<string, number> };
      };
    };

    const first = await runOnce();
    expect(first.variables.stat_data.好感度).toBe(35);
    const second = await runOnce();
    expect(second.variables.stat_data.好感度).toBe(40);

    // 在第二轮的父节点上重新生成（= swipe）：仍从 35 起算，不会变 45
    const nodes = db.select().from(schema.messageNodes).all();
    const secondNode = nodes.find((node) => node.id === second.nodeId);
    const again = await runOnce(secondNode?.parentId ?? null);
    expect(again.variables.stat_data.好感度).toBe(40);
  });

  it('set 不存在的路径只报错，不把变量表写坏', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'mvu-fake-3');
    registerFakeAdapter({
      id: 'mvu-fake-3',
      events: events("<UpdateVariable>\n_.set('凭空.字段', 1);\n</UpdateVariable>"),
    });
    const bookId = insertMvuBook(db, '报错书');
    await enableGlobalBook(app, bookId);
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );
    const raw = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: 'hi' } }))
    ).text();
    const variableEvents = parseSse(raw).filter((event) => event.event === 'variables');
    const last = variableEvents[variableEvents.length - 1]?.data as {
      errors: { message: string }[];
      variables: { stat_data: Record<string, unknown> };
    };
    expect(last.errors[0]?.message).toContain('路径不存在');
    expect(last.variables.stat_data.好感度).toBe(30);
  });
});

describe('MVU：变量接口与重放', () => {
  it('PUT 变量（message / global）、mvu/parse 不落库、mvu/replay 沿路径重算', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'mvu-fake-4');
    registerFakeAdapter({
      id: 'mvu-fake-4',
      events: events("<UpdateVariable>\n_.add('好感度', 1);\n</UpdateVariable>"),
    });
    const bookId = insertMvuBook(db, '重放书');
    await enableGlobalBook(app, bookId);
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );

    for (let i = 0; i < 2; i += 1) {
      await (await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: 'x' } }))).text();
    }
    const detail = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    const assistants = detail.nodes.filter((node) => node.role === 'assistant');
    expect(assistants).toHaveLength(2);

    const head = (await (
      await app.request(`/api/chats/${chat.id}/variables`)
    ).json()) as VariablesResponse;
    expect((head.message.stat_data as Record<string, number>).好感度).toBe(32);

    // 手改第一条的快照，再重放 → 第二条跟着变
    const firstId = assistants[0]!.id;
    await app.request(
      `/api/chats/${chat.id}/variables`,
      put({
        scope: 'message',
        nodeId: firstId,
        variables: { initialized_lorebooks: { 重放书: [] }, stat_data: { 好感度: 100, 时间: '08:00', 昔涟: { 位置: '客厅' } } },
      }),
    );
    const replay = (await (
      await app.request(`/api/chats/${chat.id}/mvu/replay`, post({ nodeId: assistants[1]!.id }))
    ).json()) as { results: { nodeId: string; variables: { stat_data: Record<string, number> } }[] };
    expect(replay.results).toHaveLength(1);
    expect(replay.results[0]?.variables.stat_data.好感度).toBe(101);

    // parse 只算不写
    const parsed = (await (
      await app.request(
        `/api/chats/${chat.id}/mvu/parse`,
        post({ message: "_.add('好感度', 10);", nodeId: assistants[1]!.id }),
      )
    ).json()) as { changed: boolean; variables: { stat_data: Record<string, number> } };
    expect(parsed.changed).toBe(true);
    expect(parsed.variables.stat_data.好感度).toBe(111);
    const after = (await (
      await app.request(`/api/chats/${chat.id}/variables?nodeId=${assistants[1]!.id}`)
    ).json()) as VariablesResponse;
    expect((after.message.stat_data as Record<string, number>).好感度).toBe(101);

    // 全局变量表照旧可读写
    await app.request('/api/variables/global', put({ variables: { 计数: 7 } }));
    const globals = (await (await app.request('/api/variables/global')).json()) as {
      variables: Record<string, unknown>;
    };
    expect(globals.variables.计数).toBe(7);
  });

  it('关掉 MVU 之后不再解析更新命令', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'mvu-fake-5');
    registerFakeAdapter({
      id: 'mvu-fake-5',
      events: events("<UpdateVariable>\n_.add('好感度', 5);\n</UpdateVariable>"),
    });
    const bookId = insertMvuBook(db, '关掉书');
    await enableGlobalBook(app, bookId);
    await app.request('/api/settings/mvu', put({ enabled: false }));
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );
    await (await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: 'x' } }))).text();
    const head = (await (
      await app.request(`/api/chats/${chat.id}/variables`)
    ).json()) as VariablesResponse;
    // 初始化照旧（变量表要能用），但更新命令没被应用
    expect((head.message.stat_data as Record<string, number>).好感度).toBe(30);
  });
});
