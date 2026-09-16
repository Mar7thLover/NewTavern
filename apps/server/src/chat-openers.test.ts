import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/** 世界书自带的开场白：`@@is_greeting` 与 role=assistant 的 prefill 进新建对话的 swipe */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Detail {
  id: string;
  title: string;
  rootNodeId: string | null;
  headNodeId: string | null;
  nodes: {
    id: string;
    siblingSeq: number;
    role: string;
    name: string | null;
    parts: { text?: string }[];
  }[];
}

function insertBook(db: Db, name: string, entries: Record<string, unknown>[]): string {
  const bookId = db.insert(schema.lorebooks).values({ name }).returning().get().id;
  for (const entry of entries) {
    db.insert(schema.lorebookEntries)
      .values({ bookId, keys: [], secondaryKeys: [], content: '', ...entry })
      .run();
  }
  return bookId;
}

const textsOf = (chat: Detail) => chat.nodes.map((node) => node.parts[0]?.text);

describe('世界书开场白', () => {
  it('只挑一本书开场：@@is_greeting 按序号铺成 swipe，标题取书名', async () => {
    const { app, db } = makeTestApp(dataDir);
    const bookId = insertBook(db, '雾港', [
      { comment: '第二幕', content: '@@is_greeting 1\n又见面了。' },
      { comment: '序章', content: '@@is_greeting 0\n欢迎来到雾港。' },
    ]);

    const res = await app.request('/api/chats', post({ lorebookIds: [bookId] }));
    expect(res.status).toBe(201);
    const chat = (await res.json()) as Detail;

    expect(chat.title).toBe('雾港');
    expect(textsOf(chat)).toEqual(['欢迎来到雾港。', '又见面了。']);
    expect(chat.nodes.map((node) => node.siblingSeq)).toEqual([0, 1]);
    expect(chat.rootNodeId).toBe(chat.nodes[0]?.id);
    expect(chat.headNodeId).toBe(chat.nodes[0]?.id);
    // 无角色卡时说话人回落到书名
    expect(chat.nodes[0]?.name).toBe('雾港');

    // 挑中的书同时成为聊天书
    const linked = db.select().from(schema.chatLorebooks).all();
    expect(linked.map((row) => row.bookId)).toEqual([bookId]);
  });

  it('角色卡 + 世界书：卡的开场白在前，书的接在后，宏用角色名替换', async () => {
    const { app, db } = makeTestApp(dataDir);
    const characterId = db
      .insert(schema.characters)
      .values({
        name: '艾拉',
        spec: 'v2',
        data: {
          name: '艾拉',
          first_mes: '欢迎来到酒馆，{{user}}。',
          alternate_greetings: ['今天想喝点什么？'],
        },
      })
      .returning()
      .get().id;
    const bookId = insertBook(db, '雾港', [
      { content: '@@is_greeting 0\n{{char}}擦了擦杯子。' },
      // role=assistant 的条目是真 prefill，同时也当开场白候选，排在 greeting 之后
      { content: '（门被推开。）', role: 'assistant', position: 4, depth: 0 },
    ]);
    const persona = (await (
      await app.request('/api/personas', post({ name: '旅人', description: '一个冒险者。' }))
    ).json()) as { id: string };

    const chat = (await (
      await app.request(
        '/api/chats',
        post({ characterIds: [characterId], lorebookIds: [bookId], personaId: persona.id }),
      )
    ).json()) as Detail;

    expect(chat.title).toBe('艾拉');
    expect(textsOf(chat)).toEqual([
      '欢迎来到酒馆，旅人。',
      '今天想喝点什么？',
      '艾拉擦了擦杯子。',
      '（门被推开。）',
    ]);
    expect(chat.nodes.every((node) => node.name === '艾拉')).toBe(true);
  });

  it('书里没有开场白：仍挂上聊天书，但不建根节点', async () => {
    const { app, db } = makeTestApp(dataDir);
    const bookId = insertBook(db, '设定集', [{ content: '这是普通世界书内容。', keys: ['雾港'] }]);

    const chat = (await (
      await app.request('/api/chats', post({ lorebookIds: [bookId] }))
    ).json()) as Detail;

    expect(chat.nodes).toHaveLength(0);
    expect(chat.rootNodeId).toBeNull();
    expect(chat.title).toBe('设定集');
    expect(db.select().from(schema.chatLorebooks).all()).toHaveLength(1);
  });

  it('世界书不存在 → 404', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await app.request('/api/chats', post({ lorebookIds: ['nope'] }));
    expect(res.status).toBe(404);
  });

  it('列表接口按来源分别报开场白条数', async () => {
    const { app, db } = makeTestApp(dataDir);
    insertBook(db, '雾港', [
      { content: '@@is_greeting 0\nA' },
      { content: '@@is_greeting 1\nB' },
      { content: 'C', role: 'assistant' },
      { content: '普通内容' },
    ]);

    const list = (await (await app.request('/api/lorebooks')).json()) as {
      name: string;
      entryCount: number;
      openerCounts: { greeting: number; prefill: number };
    }[];
    const book = list.find((item) => item.name === '雾港');
    expect(book?.entryCount).toBe(4);
    expect(book?.openerCounts).toEqual({ greeting: 2, prefill: 1 });
  });
});
