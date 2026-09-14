import fs from 'node:fs';

import type { GenEvent } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
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
 * 服务端接入组装 v2（SB）：generate 的快照/变量落库、inspect 完整响应、
 * `POST /api/inspect/compare`。见 docs/M3-CONTRACT.md §6。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const EVENTS: GenEvent[] = [
  { type: 'text.delta', text: '雾还没散。' },
  { type: 'usage', input: 120, output: 5, cacheRead: 40, cacheWrite: 0, reasoning: 0 },
  { type: 'stop', reason: 'end' },
];

registerFakeAdapter({ id: 'fake-sb', events: EVENTS, renderMessages: true });

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body: unknown) => json('POST', body);

interface Node {
  id: string;
  role: string;
  extra: Record<string, unknown> | null;
}
interface Detail {
  id: string;
  headNodeId: string | null;
  metadata: Record<string, unknown> | null;
  nodes: Node[];
}

/** 预设：`main` 里带变量宏（AS-6：只有 main/nsfw/jailbreak 等标记 prompt 会被采用） */
function insertPreset(db: Db): string {
  return db
    .insert(schema.presets)
    .values({
      name: 'SB 测试预设',
      format: 'native',
      data: {
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            role: 'system',
            content: '你是 {{char}}。{{setvar::hp::7}}{{setglobalvar::mood::calm}}',
          },
          { identifier: 'worldInfoBefore', name: 'WI before', marker: true },
          { identifier: 'charDescription', name: 'Char', marker: true },
          { identifier: 'worldInfoAfter', name: 'WI after', marker: true },
          { identifier: 'chatHistory', name: 'History', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              'main',
              'worldInfoBefore',
              'charDescription',
              'worldInfoAfter',
              'chatHistory',
            ].map((identifier) => ({ identifier, enabled: true })),
          },
        ],
        openai_max_context: 32000,
        openai_max_tokens: 500,
        temperature: 0.7,
      },
    })
    .returning()
    .get().id;
}

function insertCharacter(db: Db): string {
  return db
    .insert(schema.characters)
    .values({
      name: '艾拉',
      spec: 'v2',
      data: {
        name: '艾拉',
        description: '{{char}} 是酒馆老板娘。',
        first_mes: '欢迎。',
        extensions: { depth_prompt: { prompt: '保持神秘。', depth: 2, role: 0 } },
      },
    })
    .returning()
    .get().id;
}

/** 一本含「常驻条目 + 关键词条目」的世界书 */
function insertBook(db: Db, name = '港口设定'): string {
  const bookId = db.insert(schema.lorebooks).values({ name, scope: 'global' }).returning().get().id;
  db.insert(schema.lorebookEntries)
    .values({
      bookId,
      uid: 0,
      keys: [],
      secondaryKeys: [],
      content: 'CONST · 港口终年有雾。',
      constant: true,
      position: 0,
      entryOrder: 10,
    })
    .run();
  db.insert(schema.lorebookEntries)
    .values({
      bookId,
      uid: 1,
      keys: ['灯塔'],
      secondaryKeys: [],
      content: 'KEYED · 灯塔立在礁石上。',
      constant: false,
      position: 0,
      entryOrder: 20,
    })
    .run();
  return bookId;
}

/** 一本只有单条常驻条目的书，用于去重/优先级用例 */
function insertSimpleBook(db: Db, name: string, content: string): string {
  const bookId = db.insert(schema.lorebooks).values({ name, scope: 'global' }).returning().get().id;
  db.insert(schema.lorebookEntries)
    .values({ bookId, uid: 0, keys: [], content, constant: true, position: 0, entryOrder: 100 })
    .run();
  return bookId;
}

async function setupChat(app: ReturnType<typeof makeTestApp>['app'], db: Db, dir: string) {
  const conn = insertConnection(db, dir, 'fake-sb');
  const characterId = insertCharacter(db);
  const presetId = insertPreset(db);
  const chat = (await (
    await app.request('/api/chats', post({ characterIds: [characterId], presetId }))
  ).json()) as Detail;
  await app.request('/api/settings/generation.default', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ connectionId: conn.id, model: 'fake-model-1' }),
  });
  return { chat, conn, characterId, presetId };
}

describe('generate 接入组装 v2', () => {
  it('新节点落 wi_state / variables，全局变量入表，extra 带 layout / activations / warnings', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    const bookId = insertBook(db);
    await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [bookId] }));

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      post({ userMessage: { text: '灯塔还亮着吗？' } }),
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    const done = events.find((e) => e.event === 'done')?.data as { node: Node } | undefined;
    expect(done).toBeDefined();
    const node = done!.node;

    // extra：布局报告 + WI 激活摘要 + 告警
    const extra = node.extra ?? {};
    expect((extra.layout as { mode: string }).mode).toBe('strict');
    expect(Array.isArray((extra.layout as { breakpoints: unknown[] }).breakpoints)).toBe(true);
    const activations = extra.activations as { entryId: string }[];
    // 常驻 + 命中关键词各一条
    expect(activations).toHaveLength(2);
    expect(activations.every((item) => item.entryId.startsWith(bookId))).toBe(true);
    expect(Array.isArray(extra.warnings)).toBe(true);

    // 请求体里出现了两条条目的内容
    const body = (extra.request as { body: { messages: { content: string }[] } }).body;
    const all = body.messages.map((m) => m.content).join('\n');
    expect(all).toContain('CONST · 港口终年有雾。');
    expect(all).toContain('KEYED · 灯塔立在礁石上。');

    // 节点快照：wi_state / variables 落库
    const row = db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.id, node.id))
      .get();
    expect(row?.wiState).toMatchObject({ sticky: {}, cooldown: {} });
    // ST 语义：变量值是字符串（RX-6）
    expect(row?.variables).toEqual({ hp: '7' });

    // 全局变量表 + 事件
    const globals = db.select().from(schema.variables).all();
    expect(globals.map((v) => [v.scope, v.key, v.value])).toEqual([['global', 'mood', 'calm']]);
    const varEvents = db.select().from(schema.variableEvents).all();
    expect(varEvents).toHaveLength(1);
    expect(varEvents[0]).toMatchObject({ op: 'set', path: 'mood', nodeId: node.id });
  });

  it('下一轮从父节点恢复 chat 变量快照', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    // SSE 的 body 必须读完，流处理器才会跑到底
    await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '第一轮' } }))
    ).text();
    // 手动改父节点快照，验证下一轮确实读它
    const head = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    db.update(schema.messageNodes)
      .set({ variables: { hp: 99, extra: 'kept' } })
      .where(eq(schema.messageNodes.id, head.headNodeId as string))
      .run();

    await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '第二轮' } }))
    ).text();
    const after = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    const row = db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.id, after.headNodeId as string))
      .get();
    // main 里的 setvar 覆盖 hp，其余键沿用父快照
    expect(row?.variables).toEqual({ hp: '7', extra: 'kept' });
  });

  it('首事件即 error 的回退路径不写全局变量、不留快照', async () => {
    const { app, db } = makeTestApp(dataDir);
    registerFakeAdapter({
      id: 'fake-sb-error',
      events: [
        {
          type: 'error',
          error: { kind: 'invalid', message: '炸了', retryable: false },
          retryable: false,
        },
      ],
    });
    const conn = insertConnection(db, dataDir, 'fake-sb-error');
    const presetId = insertPreset(db);
    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId], presetId }))
    ).json()) as Detail;

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      post({ userMessage: { text: '你好' }, connectionId: conn.id, model: 'fake-model-1' }),
    );
    const events = parseSse(await res.text());
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(db.select().from(schema.variables).all()).toHaveLength(0);
    const assistants = db
      .select()
      .from(schema.messageNodes)
      .all()
      .filter((row) => row.role === 'assistant' && row.parentId !== null);
    expect(assistants).toHaveLength(0);
  });
});

describe('世界书来源与去重（AS-13 / WI-11 / SB-8）', () => {
  it('全局 + 聊天 + 角色三个来源都进组装；同名书只保留优先级最高的一本', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat, characterId } = await setupChat(app, db, dataDir);

    const globalBook = insertSimpleBook(db, '全局书', 'G · 全局条目。');
    const chatBook = insertSimpleBook(db, '聊天书', 'C · 聊天条目。');
    const charBook = insertSimpleBook(db, '角色书', 'R · 角色条目。');
    // 与全局书同名的聊天书：应被去重丢弃
    const duplicate = insertSimpleBook(db, '全局书', 'DUP · 不该出现。');
    db.update(schema.characters)
      .set({ bookId: charBook })
      .where(eq(schema.characters.id, characterId))
      .run();
    await app.request('/api/settings/worldInfo.globalBookIds', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([globalBook]),
    });
    await app.request(
      `/api/chats/${chat.id}/lorebooks`,
      json('PUT', { bookIds: [chatBook, duplicate] }),
    );

    const data = (await (await app.request(`/api/chats/${chat.id}/inspect`)).json()) as {
      wi: { activations: { entry: { source: { bookName: string; scope: string } } }[] };
      request: { body: { messages: { content: string }[] } };
    };
    const sources = data.wi.activations
      .map((item) => [item.entry.source.bookName, item.entry.source.scope])
      .sort();
    expect(sources).toEqual(
      [
        ['全局书', 'global'],
        ['聊天书', 'chat'],
        ['角色书', 'char'],
      ].sort(),
    );
    const joined = data.request.body.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('G · 全局条目。');
    expect(joined).toContain('C · 聊天条目。');
    expect(joined).toContain('R · 角色条目。');
    expect(joined).not.toContain('DUP');
  });
});

describe('GET /api/chats/:id/inspect', () => {
  it('strict：完整响应形状，request 去 headers，strictIr / diff 为 null', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    const bookId = insertBook(db, '检查器书');
    await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [bookId] }));

    const res = await app.request(`/api/chats/${chat.id}/inspect`);
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(
      [
        'diff',
        'ir',
        'lastUsage',
        'layout',
        'layoutMode',
        'request',
        'strictIr',
        'tokenEstimate',
        'warnings',
        'wi',
      ].sort(),
    );
    expect(data.layoutMode).toBe('strict');
    expect(data.strictIr).toBeNull();
    expect(data.diff).toBeNull();
    expect('headers' in (data.request as Record<string, unknown>)).toBe(false);
    expect((data.request as { body: unknown }).body).toBeTruthy();
    expect(typeof data.tokenEstimate).toBe('number');
    expect(data.lastUsage).toBeNull();
    const wi = data.wi as { activations: unknown[]; rejected: unknown[]; budgetUsed: number };
    // 没有用户消息时只有常驻条目激活
    expect(wi.activations).toHaveLength(1);
    expect(wi.budgetUsed).toBeGreaterThan(0);
    const layout = data.layout as { mode: string; newFrozenVolatile: Record<string, string> };
    expect(layout.mode).toBe('strict');
    expect(layout.newFrozenVolatile).toEqual({});
  });

  it('cache-aware：strictIr 与 diff 都有；lastUsage 取路径上最近一条 assistant', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '你好' } }))
    ).text();

    const data = (await (
      await app.request(`/api/chats/${chat.id}/inspect?layoutMode=cache-aware`)
    ).json()) as {
      layoutMode: string;
      strictIr: { segments: unknown[] } | null;
      diff: { moved: string[]; clamped: string[]; unchanged: number } | null;
      lastUsage: { cacheRead: number } | null;
    };
    expect(data.layoutMode).toBe('cache-aware');
    expect(data.strictIr?.segments.length).toBeGreaterThan(0);
    expect(data.diff).not.toBeNull();
    expect(typeof data.diff?.unchanged).toBe('number');
    expect(data.lastUsage?.cacheRead).toBe(40);
  });

  it('inspect 是 dryRun：不写节点、不动全局变量', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    const before = db.select().from(schema.messageNodes).all().length;
    expect((await app.request(`/api/chats/${chat.id}/inspect`)).status).toBe(200);
    expect(db.select().from(schema.messageNodes).all().length).toBe(before);
    expect(db.select().from(schema.variables).all()).toHaveLength(0);
  });
});

describe('POST /api/inspect/compare', () => {
  it('同一请求 → same:true；改一条 → same:false 且给出首个差异下标', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    await app.request(
      `/api/chats/${chat.id}/messages`,
      post({ role: 'user', text: '灯塔还亮着吗？' }),
    );

    const inspect = (await (await app.request(`/api/chats/${chat.id}/inspect`)).json()) as {
      request: { body: { messages: { role: string; content: string }[] } };
    };
    const messages = inspect.request.body.messages;
    expect(messages.length).toBeGreaterThan(1);

    const same = (await (
      await app.request('/api/inspect/compare', post({ chatId: chat.id, stRequest: { messages } }))
    ).json()) as { same: boolean; firstDiffIndex: number; ours: unknown[]; hints: string[] };
    expect(same.same).toBe(true);
    expect(same.firstDiffIndex).toBe(-1);
    expect(same.ours).toHaveLength(messages.length);
    expect(same.hints).toEqual(['逐条一致']);

    const tampered = messages.map((m, i) => (i === 0 ? { ...m, content: '别的内容' } : m));
    const diff = (await (
      await app.request(
        '/api/inspect/compare',
        post({ chatId: chat.id, stRequest: { messages: tampered } }),
      )
    ).json()) as { same: boolean; firstDiffIndex: number; theirs: unknown[]; hints: string[] };
    expect(diff.same).toBe(false);
    expect(diff.firstDiffIndex).toBe(0);
    expect(diff.theirs).toHaveLength(messages.length);
    expect(diff.hints.join(' ')).toContain('第 0 条正文不同');

    // 直接贴 messages 数组也认
    const bare = (await (
      await app.request('/api/inspect/compare', post({ chatId: chat.id, stRequest: messages }))
    ).json()) as { same: boolean };
    expect(bare.same).toBe(true);
  });

  it('参数校验：缺 chatId / 缺 stRequest / 聊天不存在 / 没有 messages', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);
    expect((await app.request('/api/inspect/compare', post({ stRequest: {} }))).status).toBe(400);
    expect((await app.request('/api/inspect/compare', post({ chatId: chat.id }))).status).toBe(400);
    const missing = await app.request(
      '/api/inspect/compare',
      post({ chatId: 'nope', stRequest: { messages: [] } }),
    );
    expect(missing.status).toBe(404);

    const noMessages = (await (
      await app.request('/api/inspect/compare', post({ chatId: chat.id, stRequest: { foo: 1 } }))
    ).json()) as { same: boolean; hints: string[] };
    expect(noMessages.same).toBe(false);
    expect(noMessages.hints.join(' ')).toContain('没有 messages 数组');
  });
});

describe('PATCH /api/chats/:id metadata.frozenVolatile', () => {
  it('写入后可用 null 清空，其余 metadata 保留', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { chat } = await setupChat(app, db, dataDir);

    const withFrozen = (await (
      await app.request(
        `/api/chats/${chat.id}`,
        json('PATCH', {
          metadata: {
            frozenVolatile: { 'preset:main': '冻结文本' },
            authorsNote: { text: '保持紧张感。' },
          },
        }),
      )
    ).json()) as Detail;
    expect(withFrozen.metadata?.frozenVolatile).toEqual({ 'preset:main': '冻结文本' });

    const cleared = (await (
      await app.request(
        `/api/chats/${chat.id}`,
        json('PATCH', { metadata: { frozenVolatile: null } }),
      )
    ).json()) as Detail;
    expect(cleared.metadata?.frozenVolatile).toBeUndefined();
    // 作者注释没被顺带清掉（浅合并）
    expect((cleared.metadata?.authorsNote as { text: string }).text).toBe('保持紧张感。');
  });
});
