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
  waitFor,
} from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Node {
  id: string;
  parentId: string | null;
  siblingSeq: number;
  role: string;
  parts: { type: string; text?: string }[];
  reasoning: { text?: string; opaque?: unknown[] } | null;
  usage: Record<string, number> | null;
  extra: Record<string, unknown> | null;
}
interface Detail {
  id: string;
  title: string;
  rootNodeId: string | null;
  headNodeId: string | null;
  messageCount: number;
  preview: string | null;
  character: { name: string } | null;
  nodes: Node[];
}

function insertCharacter(db: Db): string {
  return db
    .insert(schema.characters)
    .values({
      name: '艾拉',
      spec: 'v2',
      data: {
        name: '艾拉',
        description: '{{char}} 是酒馆老板娘，招待 {{user}}。',
        first_mes: '欢迎来到酒馆，{{user}}。',
        alternate_greetings: ['今天想喝点什么？', '又是你啊。'],
      },
    })
    .returning()
    .get().id;
}

describe('chats 树操作', () => {
  it('创建聊天：first_mes + 2 个 alternate_greetings → 3 个根级兄弟，head 指第一个', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const persona = (await (
      await app.request('/api/personas', post({ name: '旅人', description: '一个冒险者。' }))
    ).json()) as { id: string };

    const res = await app.request(
      '/api/chats',
      post({ characterIds: [characterId], personaId: persona.id }),
    );
    expect(res.status).toBe(201);
    const chat = (await res.json()) as Detail;
    expect(chat.title).toBe('艾拉');
    expect(chat.character?.name).toBe('艾拉');
    expect(chat.nodes).toHaveLength(3);
    expect(chat.nodes.every((node) => node.parentId === null)).toBe(true);
    expect(chat.nodes.map((node) => node.siblingSeq)).toEqual([0, 1, 2]);
    expect(chat.rootNodeId).toBe(chat.nodes[0]?.id);
    expect(chat.headNodeId).toBe(chat.nodes[0]?.id);
    // 宏替换只需 {{char}}/{{user}}
    expect(chat.nodes[0]?.parts[0]?.text).toBe('欢迎来到酒馆，旅人。');
    expect(chat.nodes[1]?.parts[0]?.text).toBe('今天想喝点什么？');
    expect(chat.preview).toBe('欢迎来到酒馆，旅人。');
    expect(chat.messageCount).toBe(3);

    const list = (await (await app.request('/api/chats')).json()) as Detail[];
    expect(list).toHaveLength(1);
    expect(list[0]?.messageCount).toBe(3);
  });

  it('无 first_mes 的空白对话：root/head 为 null', async () => {
    const { app } = makeTestApp(dataDir);
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    expect(chat.rootNodeId).toBeNull();
    expect(chat.headNodeId).toBeNull();
    expect(chat.nodes).toHaveLength(0);
  });

  it('POST messages 移动 head；PATCH 文本清除自身与后代的 opaque；DELETE 子树与 head 回退', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    const root = chat.nodes[0]!;

    const first = (await (
      await app.request(`/api/chats/${chat.id}/messages`, post({ role: 'user', text: '你好。' }))
    ).json()) as { node: Node; chat: { headNodeId: string } };
    expect(first.node.parentId).toBe(root.id);
    expect(first.node.siblingSeq).toBe(0);
    expect(first.chat.headNodeId).toBe(first.node.id);

    const second = (await (
      await app.request(
        `/api/chats/${chat.id}/messages`,
        post({ role: 'assistant', text: '欢迎。' }),
      )
    ).json()) as { node: Node; chat: { headNodeId: string; preview: string } };
    expect(second.node.parentId).toBe(first.node.id);
    expect(second.chat.headNodeId).toBe(second.node.id);
    expect(second.chat.preview).toBe('欢迎。');

    // 同父再插一个兄弟：siblingSeq = 最大 + 1
    const sibling = (await (
      await app.request(
        `/api/chats/${chat.id}/messages`,
        post({ role: 'assistant', text: '另一种回答。', parentId: first.node.id }),
      )
    ).json()) as { node: Node };
    expect(sibling.node.siblingSeq).toBe(1);

    // 给三层节点都塞上 opaque，PATCH 最上层的文本后应全部被清除
    for (const id of [root.id, first.node.id, second.node.id]) {
      db.update(schema.messageNodes)
        .set({ reasoning: { text: '思考过', opaque: [{ provider: 'p', model: 'm', payload: 1 }] } })
        .where(eq(schema.messageNodes.id, id))
        .run();
    }
    const patched = (await (
      await app.request(`/api/chats/${chat.id}/nodes/${first.node.id}`, {
        ...post({ text: '你好呀。' }),
        method: 'PATCH',
      })
    ).json()) as Node;
    expect(patched.parts[0]?.text).toBe('你好呀。');
    expect(patched.reasoning?.opaque).toBeUndefined();
    expect(patched.reasoning?.text).toBe('思考过');

    const after = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    const byId = new Map(after.nodes.map((node) => [node.id, node]));
    // 自身与后代的 opaque 被清；祖先（root）保留
    expect(byId.get(second.node.id)?.reasoning?.opaque).toBeUndefined();
    expect(byId.get(root.id)?.reasoning?.opaque).toHaveLength(1);

    // 删除 first 的子树（含 second 与 sibling），head 回退到 first
    await app.request(`/api/chats/${chat.id}/nodes/${second.node.id}`, { method: 'DELETE' });
    const afterDelete = (await (
      await app.request(`/api/chats/${chat.id}/nodes/${sibling.node.id}`, { method: 'DELETE' })
    ).json()) as { chat: { headNodeId: string } };
    expect(afterDelete.chat.headNodeId).toBe(first.node.id);

    // 删除整个 first 子树 → head 回到 root
    const deletedFirst = (await (
      await app.request(`/api/chats/${chat.id}/nodes/${first.node.id}`, { method: 'DELETE' })
    ).json()) as { chat: { headNodeId: string; rootNodeId: string } };
    expect(deletedFirst.chat.headNodeId).toBe(root.id);

    // 删除根节点 → root/head 落到剩余的根级兄弟
    const deletedRoot = (await (
      await app.request(`/api/chats/${chat.id}/nodes/${root.id}`, { method: 'DELETE' })
    ).json()) as { chat: { headNodeId: string | null; rootNodeId: string | null } };
    expect(deletedRoot.chat.rootNodeId).toBe(chat.nodes[1]?.id);
    expect(deletedRoot.chat.headNodeId).toBe(chat.nodes[1]?.id);

    expect((await app.request(`/api/chats/${chat.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/chats/${chat.id}`)).status).toBe(404);
  });

  it('PATCH /chats 改 headNodeId、overrides；非法 head 返回 400', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    const swipe = chat.nodes[1]!;
    const patched = (await (
      await app.request(`/api/chats/${chat.id}`, {
        ...post({ headNodeId: swipe.id, overrides: { model: 'x', layoutMode: 'cache-aware' } }),
        method: 'PATCH',
      })
    ).json()) as Detail & { overrides: Record<string, unknown> };
    expect(patched.headNodeId).toBe(swipe.id);
    expect(patched.overrides).toEqual({ model: 'x', layoutMode: 'cache-aware' });

    const bad = await app.request(`/api/chats/${chat.id}`, {
      ...post({ headNodeId: 'nope' }),
      method: 'PATCH',
    });
    expect(bad.status).toBe(400);
  });

  it('PATCH overrides.thinking：形状校验，null 表示跟随预设（删掉该键）', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    const patch = (overrides: unknown) =>
      app.request(`/api/chats/${chat.id}`, { ...post({ overrides }), method: 'PATCH' });
    type WithOverrides = Detail & { overrides: Record<string, unknown> };

    const off = (await (
      await patch({ model: 'x', thinking: { enabled: false } })
    ).json()) as WithOverrides;
    expect(off.overrides).toEqual({ model: 'x', thinking: { enabled: false } });
    const cleared = (await (await patch({ model: 'x', thinking: null })).json()) as WithOverrides;
    expect(cleared.overrides).toEqual({ model: 'x' });

    expect((await patch({ thinking: { effort: 3 } })).status).toBe(400);
    expect((await patch({ thinking: { budgetTokens: -1 } })).status).toBe(400);
    expect((await patch({ thinking: { level: 'high' } })).status).toBe(400);
    expect((await patch({ thinking: 'high' })).status).toBe(400);
  });
});

const FAKE_EVENTS: GenEvent[] = [
  { type: 'text.delta', text: '你' },
  { type: 'text.delta', text: '好' },
  { type: 'text.delta', text: '呀' },
  { type: 'reasoning.delta', text: '先想一下' },
  { type: 'reasoning.opaque', provider: 'fake', model: 'fake-model-1', payload: { sig: 'abc' } },
  { type: 'usage', input: 100, output: 3, cacheRead: 10, cacheWrite: 0, reasoning: 7 },
  { type: 'stop', reason: 'end' },
];

registerFakeAdapter({ id: 'fake', events: FAKE_EVENTS });
registerFakeAdapter({
  id: 'fake-error',
  events: [
    {
      type: 'error',
      error: { kind: 'rateLimit', message: '限流了', status: 429, retryable: true },
      retryable: true,
    },
  ],
});
registerFakeAdapter({
  id: 'fake-slow',
  stream: async function* slowStream(_conn, _req, signal) {
    yield { type: 'text.delta', text: '开始写……' };
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    yield { type: 'stop', reason: 'abort' };
  },
});

describe('chats 生成 SSE', () => {
  it('缺少连接/模型返回 400 no_connection', async () => {
    const { app } = makeTestApp(dataDir);
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    const res = await app.request(`/api/chats/${chat.id}/generate`, post({}));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('no_connection');
  });

  it('完整生成：事件顺序、两次 node、done 里文本正确、usage 与 generation_log 落库', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const conn = insertConnection(db, dataDir, 'fake');
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    // 连接与模型走 settings generation.default
    await app.request('/api/settings/generation.default', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId: conn.id, model: 'fake-model-1' }),
    });

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      post({ userMessage: { text: '你好，艾拉。' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    const raw = await res.text();
    // 首包 2KB 注释填充
    expect(raw.startsWith(':-')).toBe(true);
    expect(raw.indexOf('\n\n')).toBeGreaterThan(2048);

    const events = parseSse(raw);
    expect(events.map((e) => e.event)).toEqual([
      'node',
      'node',
      'text.delta',
      'text.delta',
      'text.delta',
      'reasoning.delta',
      'usage',
      'done',
    ]);

    const userNode = (events[0]!.data as { node: Node }).node;
    const assistantNode = (events[1]!.data as { node: Node }).node;
    expect(userNode.role).toBe('user');
    expect(assistantNode.role).toBe('assistant');
    expect(assistantNode.parentId).toBe(userNode.id);
    expect(assistantNode.parts).toEqual([]);

    const done = events[7]!.data as { node: Node; stopReason: string; latencyMs: number };
    expect(done.stopReason).toBe('end');
    expect(done.node.parts).toEqual([{ type: 'text', text: '你好呀' }]);
    expect(done.node.reasoning?.text).toBe('先想一下');
    expect(done.node.reasoning?.opaque).toEqual([
      { provider: 'fake', model: 'fake-model-1', payload: { sig: 'abc' } },
    ]);
    expect(done.node.usage).toEqual({
      input: 100,
      output: 3,
      cacheRead: 10,
      cacheWrite: 0,
      reasoning: 7,
    });
    expect(typeof done.latencyMs).toBe('number');

    // extra.request 去掉 headers，保留 method/url/body；只落库，不随节点下发（M4 §4 载荷瘦身）
    expect(done.node.extra && 'request' in done.node.extra).toBe(false);
    const storedRow = db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.id, done.node.id))
      .get();
    const request = (storedRow?.extra?.request ?? {}) as Record<string, unknown>;
    expect(request.url).toBe('https://example.test/v1/chat/completions');
    expect('headers' in request).toBe(false);
    expect(done.node.extra?.stopReason).toBe('end');
    // extra.capabilities：只留 M3 前端展示要用的四个字段
    expect(done.node.extra?.capabilities).toEqual({
      maxContext: 32768,
      maxOutput: 4096,
      thinking: 'none',
      caching: 'none',
    });

    // 落库
    const detail = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    expect(detail.headNodeId).toBe(assistantNode.id);
    const stored = detail.nodes.find((node) => node.id === assistantNode.id);
    expect(stored?.usage?.input).toBe(100);
    const logs = db.select().from(schema.generationLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      nodeId: assistantNode.id,
      provider: 'fake',
      model: 'fake-model-1',
      layoutMode: 'strict',
    });
    expect((logs[0]?.usage as { input: number }).input).toBe(100);
  });

  it('首事件即 error：节点被删、head 回退、SSE 里有 error', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = insertCharacter(db);
    const conn = insertConnection(db, dataDir, 'fake-error');
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [characterId] }))
    ).json()) as Detail;
    const root = chat.nodes[0]!;

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      post({ connectionId: conn.id, model: 'boom' }),
    );
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['node', 'error']);
    const error = events[1]!.data as {
      nodeId?: string;
      error: { kind: string; message: string; status: number };
      retryable: boolean;
    };
    expect(error.nodeId).toBeUndefined();
    expect(error.error).toMatchObject({ kind: 'rateLimit', status: 429 });
    expect(error.retryable).toBe(true);

    const detail = (await (await app.request(`/api/chats/${chat.id}`)).json()) as Detail;
    // 刚创建的 assistant 节点被删除，只剩三个问候节点；head 回退到 root
    expect(detail.nodes).toHaveLength(3);
    expect(detail.headNodeId).toBe(root.id);
    expect(db.select().from(schema.generationLog).all()).toHaveLength(0);
  });

  it('客户端断开：中止上游、已累积文本照常持久化且 extra.stopReason=abort', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'fake-slow');
    const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      post({ connectionId: conn.id, model: 'slow-model', userMessage: { text: '写点东西' } }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (!acc.includes('text.delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    expect(acc).toContain('开始写');
    await reader.cancel();

    await waitFor(() => {
      const rows = db.select().from(schema.messageNodes).all();
      const assistant = rows.find((row) => row.role === 'assistant');
      return (assistant?.extra as { stopReason?: string } | null)?.stopReason === 'abort';
    });
    const assistant = db
      .select()
      .from(schema.messageNodes)
      .all()
      .find((row) => row.role === 'assistant');
    expect(assistant?.parts).toEqual([{ type: 'text', text: '开始写……' }]);
  });
});
