import fs from 'node:fs';
import path from 'node:path';

import { parseCardJson, writeCardToPng } from '@newtavern/compat';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { createAssetsService } from './services/assets.js';
import { exportStChat, importStChat } from './services/chat-transfer.js';
import { makeTempDataDir, makeTestApp, type TestApp } from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type App = TestApp['app'];

interface ImportJson {
  chat: {
    id: string;
    title: string;
    characterIds: string[];
    character: { name: string } | null;
    personaId: string | null;
    rootNodeId: string | null;
    headNodeId: string | null;
    lorebookIds: string[];
    metadata: Record<string, unknown>;
  };
  messageCount: number;
  nodeCount: number;
  warnings: string[];
}

interface DetailJson {
  headNodeId: string;
  nodes: {
    id: string;
    parentId: string | null;
    siblingSeq: number;
    role: string;
    name: string | null;
    isHidden: boolean;
    parts: { type: string; text?: string; assetId?: string; mime?: string; name?: string }[];
    reasoning: { text?: string } | null;
  }[];
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function uploadChat(app: App, fileName: string, text: string, characterId?: string) {
  const form = new FormData();
  form.append('file', new File([new TextEncoder().encode(text)], fileName));
  if (characterId !== undefined) form.append('characterId', characterId);
  return app.request('/api/import/chat', { method: 'POST', body: form });
}

const header = {
  user_name: '旅行者',
  character_name: '艾拉',
  create_date: '2026-09-12@22h10m05s123ms',
  chat_metadata: {
    integrity: 'abc',
    note_prompt: '保持简洁',
    note_interval: 2,
    note_position: 1,
    note_depth: 3,
    note_role: 0,
    world_info: '王国志',
    variables: { hp: 10 },
    tainted: true,
  },
};

const messages = [
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: '2026-09-12T14:10:00.000Z',
    mes: '欢迎。',
    extra: {},
    swipe_id: 0,
    swipes: ['欢迎。', '又一位客人。'],
    swipe_info: [
      { send_date: '2026-09-12T14:10:00.000Z', extra: {} },
      { send_date: '2026-09-12T14:10:01.000Z', extra: {} },
    ],
  },
  {
    name: '旅行者',
    is_user: true,
    is_system: true,
    send_date: '2026-09-12T14:11:00.000Z',
    mes: '来一杯麦酒。',
    force_avatar: 'User Avatars/user.png',
    extra: { isSmallSys: false },
  },
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: '2026-09-12T14:12:00.000Z',
    mes: '好的。',
    gen_started: '2026-09-12T14:11:30.000Z',
    gen_finished: '2026-09-12T14:12:00.000Z',
    extra: { api: 'claude', model: 'claude-opus-5', reasoning: '她想要麦酒' },
    swipe_id: 0,
    swipes: ['好的。'],
    swipe_info: [
      {
        send_date: '2026-09-12T14:12:00.000Z',
        gen_started: '2026-09-12T14:11:30.000Z',
        gen_finished: '2026-09-12T14:12:00.000Z',
        extra: { api: 'claude', model: 'claude-opus-5', reasoning: '她想要麦酒' },
      },
    ],
  },
];

const jsonl = [header, ...messages].map((line) => JSON.stringify(line)).join('\n');
const lines = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);

function seedLibrary({ db }: TestApp) {
  const character = db
    .insert(schema.characters)
    .values({ name: '艾拉', spec: 'v2', data: { name: '艾拉' } })
    .returning()
    .get();
  const book = db.insert(schema.lorebooks).values({ name: '王国志' }).returning().get();
  const persona = db.insert(schema.personas).values({ name: '旅行者' }).returning().get();
  return { character, book, persona };
}

describe('导入 SillyTavern 聊天记录', () => {
  it('建树、绑定角色 / 档案 / 世界书、作者注释与变量；导出 deep-equal', async () => {
    const testApp = makeTestApp(dataDir);
    const { app, db } = testApp;
    const { character, book, persona } = seedLibrary(testApp);

    const res = await uploadChat(app, '艾拉 - 2026-09-12@22h10m05s.jsonl', jsonl);
    expect(res.status).toBe(201);
    const result = (await res.json()) as ImportJson;
    expect(result.messageCount).toBe(3);
    expect(result.nodeCount).toBe(4);
    expect(result.warnings).toEqual([]);
    expect(result.chat).toMatchObject({
      title: '艾拉 - 2026-09-12@22h10m05s',
      characterIds: [character.id],
      personaId: persona.id,
      lorebookIds: [book.id],
    });
    expect(result.chat.metadata['authorsNote']).toEqual({
      text: '保持简洁',
      position: 1,
      depth: 3,
      role: 0,
      interval: 2,
    });
    // metadata.st 只存在库里（摘要不下发），导出与迁移判重直接读行
    expect(result.chat.metadata['st']).toBeUndefined();
    const chatRow = db.select().from(schema.chats).where(eq(schema.chats.id, result.chat.id)).get();
    expect(
      ((chatRow?.metadata as Record<string, unknown>)['st'] as { sourceHash: string }).sourceHash,
    ).toMatch(/^[0-9a-f]{64}$/);

    const detail = (await (await app.request(`/api/chats/${result.chat.id}`)).json()) as DetailJson;
    expect(detail.nodes).toHaveLength(4);
    const roots = detail.nodes.filter((node) => node.parentId === null);
    expect(roots.map((node) => node.siblingSeq)).toEqual([0, 1]);
    expect(result.chat.rootNodeId).toBe(roots[0]?.id);
    const user = detail.nodes.find((node) => node.role === 'user');
    expect(user).toMatchObject({ parentId: roots[0]?.id, isHidden: true, name: '旅行者' });
    const head = detail.nodes.find((node) => node.id === detail.headNodeId);
    expect(head?.parts).toEqual([{ type: 'text', text: '好的。' }]);
    expect(head?.reasoning).toEqual({ text: '她想要麦酒' });

    const rows = db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.chatId, result.chat.id))
      .all();
    const withVariables = rows.filter((row) => row.variables);
    expect(withVariables.map((row) => row.id).sort()).toEqual(
      [roots[0]?.id, detail.headNodeId].sort(),
    );

    const exported = await app.request(`/api/chats/${result.chat.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('X-NT-Dropped-Branches')).toBe('0');
    expect(exported.headers.get('X-NT-Skipped-Attachments')).toBe('0');
    expect(exported.headers.get('content-disposition')).toContain(
      encodeURIComponent('艾拉 - 2026-09-12@22h10m05s.jsonl'),
    );
    expect(lines(await exported.text())).toEqual(lines(jsonl));
  });

  it('characterId：空串 = 不绑定；不存在 → 400；名字匹配不上时告警', async () => {
    const testApp = makeTestApp(dataDir);
    const { app } = testApp;

    const unmatched = (await (await uploadChat(app, 'a.jsonl', jsonl)).json()) as ImportJson;
    expect(unmatched.chat.characterIds).toEqual([]);
    expect(unmatched.warnings.join('\n')).toContain('没有名为「艾拉」的角色');
    expect(unmatched.warnings.join('\n')).toContain('世界书「王国志」不在库里');

    const { character } = seedLibrary(testApp);
    const unbound = (await (await uploadChat(app, 'b.jsonl', jsonl, '')).json()) as ImportJson;
    expect(unbound.chat.characterIds).toEqual([]);
    const explicit = (await (
      await uploadChat(app, 'c.jsonl', jsonl, character.id)
    ).json()) as ImportJson;
    expect(explicit.chat.characterIds).toEqual([character.id]);

    const missing = await uploadChat(app, 'd.jsonl', jsonl, 'nope');
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { message: string }).message).toContain('角色不存在');
  });

  it("ST 新版 header 的名字是 'unused'：按消息里的名字匹配角色与档案", async () => {
    const testApp = makeTestApp(dataDir);
    const { app } = testApp;
    const { character, persona } = seedLibrary(testApp);
    const modern = [
      { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
      ...messages,
    ]
      .map((line) => JSON.stringify(line))
      .join('\n');
    const result = (await (await uploadChat(app, 'm.jsonl', modern)).json()) as ImportJson;
    expect(result.warnings).toEqual([]);
    expect(result.chat.characterIds).toEqual([character.id]);
    expect(result.chat.personaId).toBe(persona.id);
    const exported = await app.request(`/api/chats/${result.chat.id}/export`);
    expect(lines(await exported.text())).toEqual(lines(modern));
  });

  it('坏文件与传错类型报 400', async () => {
    const { app } = makeTestApp(dataDir);
    const bad = await uploadChat(app, 'bad.jsonl', `${JSON.stringify(header)}\n{oops`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain('第 2 行');

    const card = await uploadChat(
      app,
      'card.json',
      JSON.stringify({ spec: 'chara_card_v2', data: { name: 'x' } }),
    );
    expect(card.status).toBe(400);
    expect(((await card.json()) as { message: string }).message).toContain('角色卡');

    const form = new FormData();
    expect((await app.request('/api/import/chat', { method: 'POST', body: form })).status).toBe(
      400,
    );

    // 角色卡页面收到聊天记录：提示去对话列表
    const wrongPage = new FormData();
    wrongPage.append('file', new File([new TextEncoder().encode(jsonl)], 'x.jsonl'));
    const hint = await app.request('/api/import/character', { method: 'POST', body: wrongPage });
    expect(((await hint.json()) as { message: string }).message).toBe(
      '这是 SillyTavern 聊天记录，请在对话列表里导入。',
    );
  });
});

describe('导出为 SillyTavern 聊天记录', () => {
  it('分支计数、作者注释改动写回 header、新加的消息', async () => {
    const testApp = makeTestApp(dataDir);
    const { app } = testApp;
    seedLibrary(testApp);
    const { chat } = (await (await uploadChat(app, 'x.jsonl', jsonl)).json()) as ImportJson;
    const detail = (await (await app.request(`/api/chats/${chat.id}`)).json()) as DetailJson;
    const userNode = detail.nodes.find((node) => node.role === 'user');

    // 在用户消息下另开一个分支（有后代），再回到原 head
    const branch = (await (
      await app.request(
        `/api/chats/${chat.id}/messages`,
        json('POST', { role: 'user', text: '换个问法', parentId: detail.nodes[0]?.id }),
      )
    ).json()) as { node: { id: string } };
    await app.request(
      `/api/chats/${chat.id}/messages`,
      json('POST', { role: 'assistant', text: '好', parentId: branch.node.id }),
    );
    await app.request(
      `/api/chats/${chat.id}/messages`,
      json('POST', { role: 'user', text: '再来一杯。', parentId: detail.headNodeId }),
    );
    await app.request(
      `/api/chats/${chat.id}`,
      json('PATCH', {
        metadata: {
          authorsNote: { text: '改过的注释', position: 0, depth: 4, role: 1, interval: 1 },
        },
      }),
    );

    const res = await app.request(`/api/chats/${chat.id}/export`);
    expect(res.headers.get('X-NT-Dropped-Branches')).toBe('1');
    const out = lines(await res.text()) as Record<string, unknown>[];
    expect(out).toHaveLength(5);
    expect(out[0]?.['chat_metadata']).toMatchObject({
      note_prompt: '改过的注释',
      note_position: 0,
      note_role: 1,
      integrity: 'abc',
    });
    expect(out[2]).toEqual(lines(jsonl)[2]);
    expect(out[4]).toMatchObject({
      name: '旅行者',
      is_user: true,
      is_system: false,
      mes: '再来一杯。',
      extra: {},
    });
    expect(userNode?.id).toBeTruthy();
  });

  it('在新酒馆里新建的对话：合成 header', async () => {
    const testApp = makeTestApp(dataDir);
    const { app, db } = testApp;
    const persona = db.insert(schema.personas).values({ name: '我' }).returning().get();
    const created = (await (
      await app.request('/api/chats', json('POST', { title: '新对话', personaId: persona.id }))
    ).json()) as { id: string };
    await app.request(
      `/api/chats/${created.id}/messages`,
      json('POST', { role: 'user', text: '你好' }),
    );
    await app.request(
      `/api/chats/${created.id}/messages`,
      json('POST', { role: 'assistant', text: '你好呀', name: '她' }),
    );
    const res = await app.request(`/api/chats/${created.id}/export`);
    const out = lines(await res.text()) as Record<string, unknown>[];
    expect(out[0]).toMatchObject({ user_name: '我', character_name: '新对话', chat_metadata: {} });
    expect(out[1]).toMatchObject({ name: '我', is_user: true, mes: '你好', extra: {} });
    expect(out[2]).toMatchObject({ name: '她', is_user: false, mes: '你好呀' });
    expect((await app.request('/api/chats/nope/export')).status).toBe(404);
  });
});

describe('聊天里的图片与文件', () => {
  const pixel = writeCardToPng(null, parseCardJson({ name: 'pixel' }));

  const withMedia = [
    header,
    {
      name: '旅行者',
      is_user: true,
      send_date: '2026-09-12T14:11:00.000Z',
      mes: '看图',
      extra: {
        image: '/user/images/艾拉/pic.png',
        file: { url: '/user/files/note.txt', name: 'note.txt', size: 5 },
        video: '/user/images/v.mp4',
      },
    },
    {
      name: '旅行者',
      is_user: true,
      send_date: '2026-09-12T14:12:00.000Z',
      mes: '丢了',
      extra: { media: [{ type: 'image', url: '/user/images/missing.png' }] },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');

  it('有 ST 目录：读成资产并追加 image / document part；没有：只留引用并告警', () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const stRoot = fs.mkdtempSync(path.join(dataDir, 'st-user-'));
    fs.mkdirSync(path.join(stRoot, 'user', 'images', '艾拉'), { recursive: true });
    fs.mkdirSync(path.join(stRoot, 'user', 'files'), { recursive: true });
    fs.writeFileSync(path.join(stRoot, 'user', 'images', '艾拉', 'pic.png'), pixel);
    fs.writeFileSync(path.join(stRoot, 'user', 'files', 'note.txt'), '笔记内容');

    const bytes = new TextEncoder().encode(withMedia);
    const result = importStChat(db, assets, { fileName: 'm.jsonl', bytes, mediaRoot: stRoot });
    const nodes = db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.chatId, result.chat.id))
      .all()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const parts = nodes[0]?.parts as { type: string; mime?: string; name?: string }[];
    expect(parts.map((part) => [part.type, part.mime, part.name])).toEqual([
      ['text', undefined, undefined],
      ['image', 'image/png', 'pic.png'],
      ['document', 'text/plain', 'note.txt'],
    ]);
    expect(result.warnings.join('\n')).toContain('1 个附件文件找不到');
    expect(result.warnings.join('\n')).toContain('视频、音频');

    const exported = exportStChat(db, result.chat.id);
    expect(exported?.skippedAttachments).toBe(0);
    expect(lines(new TextDecoder().decode(exported?.bytes))).toEqual(lines(withMedia));

    const plain = importStChat(db, assets, { fileName: 'p.jsonl', bytes });
    expect(plain.warnings.join('\n')).toContain('单独导入聊天记录时读不到');
  });

  it('批量插入：长对话一次事务', () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const many = [
      JSON.stringify(header),
      ...Array.from({ length: 1500 }, (_, i) =>
        JSON.stringify({
          name: i % 2 ? '艾拉' : '旅行者',
          is_user: i % 2 === 0,
          send_date: 1789275135211 + i * 1000,
          mes: `第 ${i} 条`,
          extra: {},
        }),
      ),
    ].join('\n');
    const started = Date.now();
    const result = importStChat(db, assets, {
      fileName: 'long.jsonl',
      bytes: new TextEncoder().encode(many),
    });
    expect(result.nodeCount).toBe(1500);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(lines(new TextDecoder().decode(exportStChat(db, result.chat.id)?.bytes))).toEqual(
      lines(many),
    );
  });
});
