import fs from 'node:fs';

import {
  parseCardJson,
  readCardFromPng,
  readCharx,
  readPngTextChunks,
  utf8FromBase64,
  writeCardToPng,
  writeCharx,
} from '@newtavern/compat';
import type { GenEvent } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { MAX_VERSIONS, recordVersion } from './services/versions.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
} from './test-helpers.js';

/**
 * M6 §2 工作台服务端基础：角色卡编辑与导出、版本历史、提示库、草稿测试、测试会话、触发模拟。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type App = ReturnType<typeof makeTestApp>['app'];

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function upload(app: App, url: string, fileName: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([bytes.slice()], fileName));
  return app.request(url, { method: 'POST', body: form });
}

async function body<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/** 带未知字段（顶层与 data 里、extensions 里）的 V2 卡 */
const v2Card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  top_level_extra: '保留',
  data: {
    name: '艾拉',
    description: '酒馆老板娘',
    personality: '热情',
    scenario: '',
    first_mes: '欢迎。',
    mes_example: '',
    tags: ['奇幻'],
    unknown_data_field: { nested: [1, 2, 3] },
    extensions: {
      world: '王国',
      custom_ext: { keep: true },
      depth_prompt: { prompt: '保持神秘。', depth: 2, role: 'system' },
    },
    character_book: {
      entries: [{ keys: ['麦酒'], content: '招牌麦酒', enabled: true, insertion_order: 100 }],
    },
  },
};

const stPreset = {
  chat_completion_source: 'openai',
  temperature: 0.9,
  openai_max_context: 32000,
  openai_max_tokens: 300,
  prompts: [
    { identifier: 'main', name: 'Main', role: 'system', content: 'MAIN-SAVED' },
    { identifier: 'worldInfoBefore', name: 'WI before', marker: true },
    { identifier: 'charDescription', name: 'Char', marker: true },
    { identifier: 'worldInfoAfter', name: 'WI after', marker: true },
    { identifier: 'chatHistory', name: 'History', marker: true },
  ],
  prompt_order: [
    {
      character_id: 100001,
      order: ['main', 'worldInfoBefore', 'charDescription', 'worldInfoAfter', 'chatHistory'].map(
        (identifier) => ({ identifier, enabled: true }),
      ),
    },
  ],
  unknown_preset_field: 'keep',
};

const stWorldbook = {
  entries: {
    '0': {
      uid: 0,
      key: ['灯塔'],
      keysecondary: [],
      comment: '灯塔',
      content: '灯塔立在礁石上。',
      constant: false,
      selective: true,
      order: 100,
      position: 0,
      disable: false,
      custom_unknown: 'raw-keep',
    },
    '1': {
      uid: 1,
      key: [],
      keysecondary: [],
      comment: '常驻',
      content: '港口终年有雾。',
      constant: true,
      selective: true,
      order: 50,
      position: 0,
      disable: false,
    },
  },
};

async function importCard(app: App, bytes: Uint8Array, fileName = 'ella.png') {
  const res = await upload(app, '/api/import/character', fileName, bytes);
  expect(res.status).toBe(201);
  const { id } = await body<{ id: string }>(res);
  return body<{ id: string; bookId: string | null; avatarAssetId: string | null }>(
    await app.request(`/api/characters/${id}`),
  );
}

async function importPreset(app: App) {
  const res = await upload(app, '/api/import/preset', '预设.json', encodeJson(stPreset));
  expect(res.status).toBe(201);
  const { id } = await body<{ id: string }>(res);
  return body<{ id: string; data: typeof stPreset }>(await app.request(`/api/presets/${id}`));
}

interface CharacterDetail {
  id: string;
  name: string;
  spec: string;
  tags: string[];
  data: Record<string, unknown>;
  editedAt: string | null;
  bookId: string | null;
  avatarAssetId: string | null;
}

interface VersionSummary {
  version: number;
  author: 'user' | 'ai';
  size: number;
}

/* ------------------------------------------------------------------ */

describe('角色卡编辑（§2.1）', () => {
  it('POST 新建 V3 空卡：默认字段补齐，写第 1 版', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await app.request(
      '/api/characters',
      json('POST', { name: ' 新角色 ', data: { description: '描述', tags: ['a'] } }),
    );
    expect(res.status).toBe(201);
    const card = await body<CharacterDetail>(res);
    expect(card).toMatchObject({ name: '新角色', spec: 'v3', tags: ['a'] });
    expect(card.data).toMatchObject({
      name: '新角色',
      description: '描述',
      personality: '',
      first_mes: '',
      alternate_greetings: [],
      group_only_greetings: [],
      extensions: { depth_prompt: { prompt: '', depth: 4, role: 'system' } },
    });
    const versions = await body<VersionSummary[]>(
      await app.request(`/api/versions/character/${card.id}`),
    );
    expect(versions.map((v) => v.version)).toEqual([1]);

    // 能导出成 ST 读得回的 PNG
    const png = new Uint8Array(
      await (await app.request(`/api/characters/${card.id}/export?format=png`)).arrayBuffer(),
    );
    expect(readCardFromPng(png).data.name).toBe('新角色');

    expect((await app.request('/api/characters', json('POST', { name: '' }))).status).toBe(400);
    expect(
      (await app.request('/api/characters', json('POST', { name: 'x', data: 1 }))).status,
    ).toBe(400);
  });

  it('PUT 整份替换：未知字段保留、同步 name/tags、写 editedAt 与版本；相同内容不重复写', async () => {
    const { app, db } = makeTestApp(dataDir);
    const png = writeCardToPng(null, parseCardJson(v2Card));
    const { id } = await importCard(app, png);
    const before = await body<CharacterDetail>(await app.request(`/api/characters/${id}`));
    expect(before.editedAt).toBeNull();

    const data = {
      ...before.data,
      name: '艾拉·改',
      description: '新的描述',
      tags: ['奇幻', '工作台'],
      extensions: {
        ...(before.data.extensions as Record<string, unknown>),
        tavern_helper: { scripts: [{ name: '脚本', content: 'console.log(1)' }] },
      },
      // character_book 不从这里改：已有内嵌书时被忽略
      character_book: { entries: [] },
    };
    const res = await app.request(`/api/characters/${id}`, json('PUT', { data, author: 'ai' }));
    expect(res.status).toBe(200);
    const after = await body<CharacterDetail>(res);
    expect(after.name).toBe('艾拉·改');
    expect(after.tags).toEqual(['奇幻', '工作台']);
    expect(after.editedAt).not.toBeNull();
    expect(after.data.unknown_data_field).toEqual({ nested: [1, 2, 3] });
    expect((after.data.extensions as Record<string, unknown>).custom_ext).toEqual({ keep: true });
    expect((after.data.extensions as Record<string, unknown>).tavern_helper).toEqual({
      scripts: [{ name: '脚本', content: 'console.log(1)' }],
    });
    expect(after.data.character_book).toEqual(v2Card.data.character_book);

    let versions = await body<VersionSummary[]>(await app.request(`/api/versions/character/${id}`));
    expect(versions.map((v) => [v.version, v.author])).toEqual([
      [2, 'ai'],
      [1, 'user'],
    ]);
    expect(versions[0]!.size).toBeGreaterThan(0);

    // 同样的 data 再存一次：不写新版本
    await app.request(`/api/characters/${id}`, json('PUT', { data: after.data }));
    versions = await body<VersionSummary[]>(await app.request(`/api/versions/character/${id}`));
    expect(versions).toHaveLength(2);

    // 校验
    const bad = await app.request(`/api/characters/${id}`, json('PUT', { data: { name: '' } }));
    expect(bad.status).toBe(400);
    const badType = await app.request(
      `/api/characters/${id}`,
      json('PUT', { data: { ...after.data, alternate_greetings: 'x' } }),
    );
    expect(badType.status).toBe(400);
    expect((await app.request('/api/characters/nope', json('PUT', { data }))).status).toBe(404);

    // 已删的卡清掉版本
    await app.request(`/api/characters/${id}`, { method: 'DELETE' });
    expect(db.select().from(schema.entityVersions).all()).toHaveLength(
      // 内嵌书的那一版还在（书不随卡删除）
      1,
    );
  });

  it('没有内嵌书时 PUT 带 character_book → 抽进 lorebooks 表', async () => {
    const { app } = makeTestApp(dataDir);
    const card = await body<CharacterDetail>(
      await app.request('/api/characters', json('POST', { name: '生成的卡' })),
    );
    expect(card.bookId).toBeNull();
    const data = {
      ...card.data,
      character_book: {
        name: '生成的书',
        entries: [
          { keys: ['钟楼'], content: '钟楼每到午夜会响。', enabled: true, insertion_order: 10 },
        ],
      },
    };
    const after = await body<CharacterDetail>(
      await app.request(`/api/characters/${card.id}`, json('PUT', { data })),
    );
    expect(after.bookId).toBeTruthy();
    const book = await body<{ name: string; entries: { content: string }[] }>(
      await app.request(`/api/lorebooks/${after.bookId}`),
    );
    expect(book.name).toBe('生成的书');
    expect(book.entries.map((e) => e.content)).toEqual(['钟楼每到午夜会响。']);
  });

  it('头像上传 / 清除', async () => {
    const { app } = makeTestApp(dataDir);
    const card = await body<CharacterDetail>(
      await app.request('/api/characters', json('POST', { name: '头像' })),
    );
    const avatar = writeCardToPng(null, parseCardJson(v2Card)); // 任意合法 PNG
    const res = await upload(app, `/api/characters/${card.id}/avatar`, 'a.png', avatar);
    expect(res.status).toBe(200);
    const withAvatar = await body<CharacterDetail>(res);
    expect(withAvatar.avatarAssetId).toBeTruthy();

    const notImage = await upload(
      app,
      `/api/characters/${card.id}/avatar`,
      'a.txt',
      new TextEncoder().encode('hello'),
    );
    expect(notImage.status).toBe(400);
    expect((await upload(app, '/api/characters/nope/avatar', 'a.png', avatar)).status).toBe(404);

    const cleared = await body<CharacterDetail>(
      await app.request(`/api/characters/${card.id}/avatar`, { method: 'DELETE' }),
    );
    expect(cleared.avatarAssetId).toBeNull();
  });
});

describe('角色卡导出（§2.1）', () => {
  it('未编辑过的卡导出与原件字节完全相同', async () => {
    const { app } = makeTestApp(dataDir);
    const png = writeCardToPng(null, parseCardJson(v2Card));
    const { id } = await importCard(app, png);
    const exported = new Uint8Array(
      await (await app.request(`/api/characters/${id}/export?format=png`)).arrayBuffer(),
    );
    expect(exported).toEqual(png);
  });

  it('编辑过的卡：PNG 同时有 ccv3 与 chara，读回字段一致、未知字段不丢', async () => {
    const { app } = makeTestApp(dataDir);
    const original = writeCardToPng(
      null,
      parseCardJson(v2Card),
      new Map([['assets/extra.bin', new Uint8Array([1, 2, 3])]]),
    );
    const { id } = await importCard(app, original);
    const current = await body<CharacterDetail>(await app.request(`/api/characters/${id}`));
    const data = {
      ...current.data,
      description: '编辑后的描述',
      alternate_greetings: ['又见面了。'],
    };
    await app.request(`/api/characters/${id}`, json('PUT', { data }));

    const exported = new Uint8Array(
      await (await app.request(`/api/characters/${id}/export?format=png`)).arrayBuffer(),
    );
    expect(exported).not.toEqual(original);
    const chunks = readPngTextChunks(exported);
    expect(chunks.has('ccv3')).toBe(true);
    expect(chunks.has('chara')).toBe(true);
    // 原件的内嵌资源 chunk 照样带上
    expect(chunks.has('chara-ext-asset_:assets/extra.bin')).toBe(true);

    const back = readCardFromPng(exported);
    expect(back.spec).toBe('v3');
    expect(back.data).toMatchObject({
      name: '艾拉',
      description: '编辑后的描述',
      alternate_greetings: ['又见面了。'],
      unknown_data_field: { nested: [1, 2, 3] },
      extensions: { world: '王国', custom_ext: { keep: true } },
    });
    expect(back.data.character_book?.entries[0]?.content).toBe('招牌麦酒');
    // 顶层未知字段在 upgrade 时保留
    expect((back.card as Record<string, unknown>).top_level_extra).toBe('保留');

    // chara（V2 降级）读回同样的字段
    const chara = JSON.parse(utf8FromBase64(chunks.get('chara') as string)) as {
      spec: string;
      data: Record<string, unknown>;
    };
    expect(chara.spec).toBe('chara_card_v2');
    expect(chara.data).toMatchObject({
      name: '艾拉',
      description: '编辑后的描述',
      alternate_greetings: ['又见面了。'],
      extensions: { custom_ext: { keep: true } },
    });
  });

  it('编辑过的 CHARX 卡：导出 CHARX 带回原包里的资源文件', async () => {
    const { app } = makeTestApp(dataDir);
    const icon = writeCardToPng(null, parseCardJson(v2Card));
    const v3 = {
      spec: 'chara_card_v3' as const,
      spec_version: '3.0' as const,
      data: {
        ...v2Card.data,
        assets: [
          { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
          { type: 'other', uri: 'embeded://assets/other/readme.txt', name: 'readme', ext: 'txt' },
        ],
      },
    };
    const charx = writeCharx(
      v3,
      new Map([
        ['assets/icon/images/main.png', icon],
        ['assets/other/readme.txt', new TextEncoder().encode('说明')],
      ]),
    );
    const { id } = await importCard(app, charx, 'ella.charx');
    const current = await body<CharacterDetail>(await app.request(`/api/characters/${id}`));
    await app.request(
      `/api/characters/${id}`,
      json('PUT', { data: { ...current.data, scenario: '新场景' } }),
    );
    const exported = new Uint8Array(
      await (await app.request(`/api/characters/${id}/export?format=charx`)).arrayBuffer(),
    );
    const { card, files } = readCharx(exported);
    expect(card.data.scenario).toBe('新场景');
    expect(files.has('assets/other/readme.txt')).toBe(true);
    expect(files.has('assets/icon/images/main.png')).toBe(true);
    expect(card.data.assets?.filter((a) => a.type === 'icon')).toHaveLength(1);
  });
});

describe('版本历史（§2.2）', () => {
  it('导入写第 1 版：角色卡、内嵌书、预设、世界书', async () => {
    const { app } = makeTestApp(dataDir);
    const card = await importCard(app, writeCardToPng(null, parseCardJson(v2Card)));
    const preset = await importPreset(app);
    const book = await body<{ id: string }>(
      await upload(app, '/api/import/lorebook', '港口.json', encodeJson(stWorldbook)),
    );
    for (const [type, id] of [
      ['character', card.id],
      ['lorebook', card.bookId as string],
      ['preset', preset.id],
      ['lorebook', book.id],
    ] as const) {
      const list = await body<VersionSummary[]>(await app.request(`/api/versions/${type}/${id}`));
      expect(list.map((v) => v.version)).toEqual([1]);
    }
    const recent = await body<{ type: string; id: string; name: string }[]>(
      await app.request('/api/versions/recent?limit=10'),
    );
    expect(recent.map((r) => r.id).sort()).toEqual(
      [card.id, card.bookId as string, preset.id, book.id].sort(),
    );
    expect((await app.request('/api/versions/recent?type=bogus')).status).toBe(400);
  });

  it('角色卡：取某版 / 恢复（产生新版本，不删历史）', async () => {
    const { app } = makeTestApp(dataDir);
    const { id } = await importCard(app, writeCardToPng(null, parseCardJson(v2Card)));
    const v1 = await body<CharacterDetail>(await app.request(`/api/characters/${id}`));
    await app.request(
      `/api/characters/${id}`,
      json('PUT', { data: { ...v1.data, description: '第二版' } }),
    );

    const got = await body<{ version: number; data: Record<string, unknown> }>(
      await app.request(`/api/versions/character/${id}/1`),
    );
    expect(got.data.description).toBe('酒馆老板娘');
    expect((await app.request(`/api/versions/character/${id}/99`)).status).toBe(404);
    expect((await app.request(`/api/versions/character/${id}/abc`)).status).toBe(400);
    expect((await app.request(`/api/versions/widget/${id}`)).status).toBe(400);

    const restored = await app.request(`/api/versions/character/${id}/1/restore`, {
      method: 'POST',
    });
    expect(restored.status).toBe(200);
    expect(await body(restored)).toEqual({ version: 3 });
    const now = await body<CharacterDetail>(await app.request(`/api/characters/${id}`));
    expect(now.data.description).toBe('酒馆老板娘');
    const list = await body<VersionSummary[]>(await app.request(`/api/versions/character/${id}`));
    expect(list.map((v) => [v.version, v.author])).toEqual([
      [3, 'user'],
      [2, 'user'],
      [1, 'user'],
    ]);
    expect(
      (await app.request(`/api/versions/character/nope/1/restore`, { method: 'POST' })).status,
    ).toBe(404);
  });

  it('预设：PUT 写版本（author=ai），恢复走同一套保存逻辑', async () => {
    const { app } = makeTestApp(dataDir);
    const preset = await importPreset(app);
    const edited = {
      ...preset.data,
      temperature: 0.3,
      prompts: preset.data.prompts.map((p) =>
        p.identifier === 'main' ? { ...p, content: 'MAIN-EDITED' } : p,
      ),
    };
    const put = await app.request(
      `/api/presets/${preset.id}`,
      json('PUT', { data: edited, author: 'ai' }),
    );
    expect(put.status).toBe(200);
    expect((await body<{ sampling: Record<string, unknown> }>(put)).sampling.temperature).toBe(0.3);

    await app.request(`/api/versions/preset/${preset.id}/1/restore`, { method: 'POST' });
    const now = await body<{ data: typeof stPreset; sampling: Record<string, unknown> }>(
      await app.request(`/api/presets/${preset.id}`),
    );
    expect(now.data.prompts[0]!.content).toBe('MAIN-SAVED');
    expect(now.data.unknown_preset_field).toBe('keep');
    expect(now.sampling.temperature).toBe(0.9);
    const list = await body<VersionSummary[]>(
      await app.request(`/api/versions/preset/${preset.id}`),
    );
    expect(list.map((v) => [v.version, v.author])).toEqual([
      [3, 'user'],
      [2, 'ai'],
      [1, 'user'],
    ]);
  });

  it('世界书：PUT 写版本；恢复能找回被删掉的条目（含原始未知字段）', async () => {
    const { app } = makeTestApp(dataDir);
    const book = await body<{ id: string }>(
      await upload(app, '/api/import/lorebook', '港口.json', encodeJson(stWorldbook)),
    );
    const detail = await body<{ entries: { id: string; comment: string; content: string }[] }>(
      await app.request(`/api/lorebooks/${book.id}`),
    );
    const keep = detail.entries.find((e) => e.comment === '常驻')!;
    // 删掉「灯塔」、改「常驻」的内容
    await app.request(
      `/api/lorebooks/${book.id}`,
      json('PUT', { entries: [{ id: keep.id, content: '雾散了。' }] }),
    );
    let list = await body<VersionSummary[]>(await app.request(`/api/versions/lorebook/${book.id}`));
    expect(list.map((v) => v.version)).toEqual([2, 1]);

    // 版本数据与草稿同形：{ name, entries }
    const v1 = await body<{ data: { name: string; entries: Record<string, unknown>[] } }>(
      await app.request(`/api/versions/lorebook/${book.id}/1`),
    );
    expect(v1.data.name).toBe('港口');
    expect(v1.data.entries.map((e) => e.content).sort()).toEqual(
      ['港口终年有雾。', '灯塔立在礁石上。'].sort(),
    );

    await app.request(`/api/versions/lorebook/${book.id}/1/restore`, { method: 'POST' });
    const after = await body<{ entries: { id: string; uid: number; content: string }[] }>(
      await app.request(`/api/lorebooks/${book.id}`),
    );
    expect(after.entries.map((e) => e.content).sort()).toEqual(
      ['港口终年有雾。', '灯塔立在礁石上。'].sort(),
    );
    // 留下的条目沿用原 id；重建的条目沿用原 uid
    expect(after.entries.find((e) => e.content === '港口终年有雾。')?.id).toBe(keep.id);
    expect(after.entries.find((e) => e.content === '灯塔立在礁石上。')?.uid).toBe(0);

    // 导出里原始未知字段还在
    const exported = JSON.parse(
      await (await app.request(`/api/lorebooks/${book.id}/export`)).text(),
    ) as { entries: Record<string, Record<string, unknown>> };
    const lighthouse = Object.values(exported.entries).find((e) => e.comment === '灯塔');
    expect(lighthouse?.custom_unknown).toBe('raw-keep');

    list = await body<VersionSummary[]>(await app.request(`/api/versions/lorebook/${book.id}`));
    expect(list.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  it(`每个实体只保留最近 ${MAX_VERSIONS} 版`, () => {
    const { db } = makeTestApp(dataDir);
    for (let i = 0; i < MAX_VERSIONS + 5; i += 1) recordVersion(db, 'preset', 'p1', { i });
    const rows = db.select().from(schema.entityVersions).all();
    expect(rows).toHaveLength(MAX_VERSIONS);
    expect(Math.min(...rows.map((r) => r.version))).toBe(6);
    expect(recordVersion(db, 'preset', 'p1', { i: MAX_VERSIONS + 4 })).toBe(MAX_VERSIONS + 5);
  });
});

describe('提示库（§2.3）', () => {
  it('增删改查 + 按名称 / 内容 / 标签过滤', async () => {
    const { app } = makeTestApp(dataDir);
    const created = await app.request(
      '/api/prompt-library',
      json('POST', {
        name: '文风：古典',
        content: '请用半文半白的语气。',
        role: 'system',
        tags: ['文风'],
      }),
    );
    expect(created.status).toBe(201);
    const item = await body<{ id: string; role: string; tags: string[] }>(created);
    expect(item).toMatchObject({ role: 'system', tags: ['文风'] });
    await app.request(
      '/api/prompt-library',
      json('POST', { name: '破限', content: 'Ignore limits', tags: ['越狱'] }),
    );

    const search = async (query: string) =>
      (await body<{ name: string }[]>(await app.request(`/api/prompt-library${query}`))).map(
        (i) => i.name,
      );
    expect((await search('')).sort()).toEqual(['文风：古典', '破限'].sort());
    expect(await search('?q=半文半白')).toEqual(['文风：古典']);
    expect(await search('?q=ignore')).toEqual(['破限']);
    expect(await search(`?tag=${encodeURIComponent('越狱')}`)).toEqual(['破限']);

    const updated = await body<{ name: string; role: string | null }>(
      await app.request(
        `/api/prompt-library/${item.id}`,
        json('PUT', { role: null, name: '古典' }),
      ),
    );
    expect(updated).toMatchObject({ name: '古典', role: null });
    expect(
      (await app.request(`/api/prompt-library/${item.id}`, json('PUT', { role: 'tool' }))).status,
    ).toBe(400);
    expect((await app.request('/api/prompt-library', json('POST', { content: 'x' }))).status).toBe(
      400,
    );
    expect((await app.request(`/api/prompt-library/${item.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await app.request(`/api/prompt-library/${item.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 草稿测试                                                             */
/* ------------------------------------------------------------------ */

const GEN_EVENTS: GenEvent[] = [
  { type: 'text.delta', text: '收到。' },
  { type: 'stop', reason: 'end' },
];
registerFakeAdapter({ id: 'fake-studio', events: GEN_EVENTS, renderMessages: true });

interface ChatDetail {
  id: string;
  presetId: string | null;
  characterIds: string[];
  metadata: Record<string, unknown> | null;
  nodes: { id: string; role: string }[];
}

async function setupStudio(app: App, db: Db) {
  const conn = insertConnection(db, dataDir, 'fake-studio');
  await app.request(
    '/api/settings/generation.default',
    json('PUT', { connectionId: conn.id, model: 'fake-model-1' }),
  );
  const card = await importCard(app, writeCardToPng(null, parseCardJson(v2Card)));
  const preset = await importPreset(app);
  const book = await body<{ id: string }>(
    await upload(app, '/api/import/lorebook', '港口.json', encodeJson(stWorldbook)),
  );
  return { card, preset, book };
}

function messagesText(ir: { segments: { parts: { type: string; text?: string }[] }[] }): string {
  return ir.segments.flatMap((segment) => segment.parts.map((part) => part.text ?? '')).join('\n');
}

describe('测试会话（§2.4）', () => {
  it('按实体复用最近一条；普通列表默认排除，?includeStudio=1 才返回', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { card, preset, book } = await setupStudio(app, db);
    // 一条普通对话：preset 测试会话要借它的卡
    await app.request('/api/chats', json('POST', { characterIds: [card.id] }));

    const first = await app.request(`/api/studio/test-chat/character/${card.id}`);
    expect(first.status).toBe(201);
    const chat = await body<ChatDetail>(first);
    expect(chat.characterIds).toEqual([card.id]);
    expect(chat.metadata?.studio).toEqual({ kind: 'character', entityId: card.id });
    // 开场白照常落成根节点
    expect(chat.nodes.some((n) => n.role === 'assistant')).toBe(true);

    const again = await app.request(`/api/studio/test-chat/character/${card.id}`);
    expect(again.status).toBe(200);
    expect((await body<ChatDetail>(again)).id).toBe(chat.id);

    const presetChat = await body<ChatDetail>(
      await app.request(`/api/studio/test-chat/preset/${preset.id}`),
    );
    expect(presetChat.presetId).toBe(preset.id);
    expect(presetChat.characterIds).toEqual([card.id]);

    const bookChat = await body<ChatDetail>(
      await app.request(`/api/studio/test-chat/lorebook/${book.id}`),
    );
    expect(bookChat.characterIds).toEqual([]);
    const bound = db.select().from(schema.chatLorebooks).all();
    expect(bound.some((row) => row.chatId === bookChat.id && row.bookId === book.id)).toBe(true);

    const list = await body<{ id: string }[]>(await app.request('/api/chats'));
    expect(list).toHaveLength(1);
    const all = await body<{ id: string }[]>(await app.request('/api/chats?includeStudio=1'));
    expect(all).toHaveLength(4);

    expect((await app.request(`/api/studio/test-chat/widget/${card.id}`)).status).toBe(400);
    expect((await app.request('/api/studio/test-chat/character/nope')).status).toBe(404);

    // POST /api/chats 直接带 metadata.studio 也算测试会话
    const direct = await body<ChatDetail>(
      await app.request(
        '/api/chats',
        json('POST', { metadata: { studio: { kind: 'preset', entityId: preset.id } } }),
      ),
    );
    expect(direct.metadata?.studio).toEqual({ kind: 'preset', entityId: preset.id });
    expect(await body<unknown[]>(await app.request('/api/chats'))).toHaveLength(1);
  });
});

describe('草稿组装（§2.4）', () => {
  it('POST inspect 带 draft：卡 / 预设 / 世界书都用草稿，库里不变；GET 行为不变', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { card, preset, book } = await setupStudio(app, db);
    const chat = await body<ChatDetail>(
      await app.request(
        '/api/chats',
        json('POST', { characterIds: [card.id], presetId: preset.id }),
      ),
    );
    await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [book.id] }));
    const cardRow = await body<CharacterDetail>(await app.request(`/api/characters/${card.id}`));
    const bookDetail = await body<{ entries: { id: string; comment: string }[] }>(
      await app.request(`/api/lorebooks/${book.id}`),
    );
    const constant = bookDetail.entries.find((e) => e.comment === '常驻')!;

    const draft = {
      character: {
        id: card.id,
        data: {
          ...cardRow.data,
          description: 'DRAFT-DESCRIPTION',
          extensions: {
            ...(cardRow.data.extensions as Record<string, unknown>),
            depth_prompt: { prompt: 'DRAFT-DEPTH', depth: 0, role: 'system' },
          },
        },
      },
      preset: {
        id: preset.id,
        data: {
          ...preset.data,
          prompts: preset.data.prompts.map((p) =>
            p.identifier === 'main' ? { ...p, content: 'MAIN-DRAFT' } : p,
          ),
        },
      },
      lorebook: {
        id: book.id,
        entries: [
          { id: constant.id, content: 'DRAFT-CONSTANT' },
          { keys: [], constant: true, content: 'DRAFT-NEW-ENTRY', comment: '新' },
        ],
      },
    };

    const res = await app.request(`/api/chats/${chat.id}/inspect`, json('POST', { draft }));
    expect(res.status).toBe(200);
    const text = messagesText((await body<{ ir: Parameters<typeof messagesText>[0] }>(res)).ir);
    for (const needle of [
      'DRAFT-DESCRIPTION',
      'DRAFT-DEPTH',
      'MAIN-DRAFT',
      'DRAFT-CONSTANT',
      'DRAFT-NEW-ENTRY',
    ]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toContain('MAIN-SAVED');
    expect(text).not.toContain('灯塔立在礁石上');

    // GET 不带草稿：还是库里的内容
    const saved = messagesText(
      (
        await body<{ ir: Parameters<typeof messagesText>[0] }>(
          await app.request(`/api/chats/${chat.id}/inspect`),
        )
      ).ir,
    );
    expect(saved).toContain('MAIN-SAVED');
    expect(saved).toContain('港口终年有雾。');
    expect(saved).not.toContain('DRAFT');

    // 草稿不落库
    const presetNow = await body<{ data: typeof stPreset }>(
      await app.request(`/api/presets/${preset.id}`),
    );
    expect(presetNow.data.prompts[0]!.content).toBe('MAIN-SAVED');
    expect(
      db
        .select()
        .from(schema.lorebookEntries)
        .all()
        .some((e) => e.content.startsWith('DRAFT')),
    ).toBe(false);

    // 草稿不合法 → 400
    const bad = await app.request(
      `/api/chats/${chat.id}/inspect`,
      json('POST', { draft: { lorebook: { id: book.id, entries: [{ bogus: 1 }] } } }),
    );
    expect(bad.status).toBe(400);
  });

  it('generate 带 draft：发给提供商的请求用的是草稿内容', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { card, preset } = await setupStudio(app, db);
    const chat = await body<ChatDetail>(
      await app.request(`/api/studio/test-chat/character/${card.id}`),
    );
    await app.request(`/api/chats/${chat.id}`, json('PATCH', { presetId: preset.id }));
    const cardRow = await body<CharacterDetail>(await app.request(`/api/characters/${card.id}`));

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      json('POST', {
        userMessage: { text: '你好' },
        draft: {
          character: { id: card.id, data: { ...cardRow.data, description: 'GEN-DRAFT-DESC' } },
          preset: {
            id: preset.id,
            data: {
              ...preset.data,
              prompts: preset.data.prompts.map((p) =>
                p.identifier === 'main' ? { ...p, content: 'GEN-DRAFT-MAIN' } : p,
              ),
            },
          },
        },
      }),
    );
    expect(res.status).toBe(200);
    const events = parseSse(await res.text());
    expect(events.some((e) => e.event === 'done')).toBe(true);

    const log = db
      .select()
      .from(schema.messageNodes)
      .all()
      .find((n) => n.role === 'assistant' && n.provider);
    const request = (log?.extra as { request?: { body?: { messages?: { content: string }[] } } })
      ?.request;
    const sent = (request?.body?.messages ?? []).map((m) => m.content).join('\n');
    expect(sent).toContain('GEN-DRAFT-DESC');
    expect(sent).toContain('GEN-DRAFT-MAIN');
    expect(sent).not.toContain('MAIN-SAVED');
    expect(sent).not.toContain('酒馆老板娘');

    // 库里的卡没变
    const after = await body<CharacterDetail>(await app.request(`/api/characters/${card.id}`));
    expect(after.data.description).toBe('酒馆老板娘');
    expect(after.editedAt).toBeNull();

    const bad = await app.request(
      `/api/chats/${chat.id}/generate`,
      json('POST', { draft: { character: { id: card.id, data: { name: '' } } } }),
    );
    expect(bad.status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* 触发模拟                                                             */
/* ------------------------------------------------------------------ */

describe('世界书触发模拟（§2.5）', () => {
  const simBook = {
    entries: {
      '0': { uid: 0, key: [], content: '常驻', constant: true, comment: 'C', order: 10 },
      '1': { uid: 1, key: ['灯塔'], content: '灯塔在北方。', comment: 'K', order: 20 },
      '2': {
        uid: 2,
        key: ['港口'],
        keysecondary: ['雾', '雨'],
        selective: true,
        selectiveLogic: 0,
        content: '港口的雾。',
        comment: 'S',
        order: 30,
      },
      '3': { uid: 3, key: [], content: '@@activate\n装饰器强制。', comment: 'D', order: 40 },
      '4': { uid: 4, key: ['北方'], content: '北方有冰原。', comment: 'R', order: 50 },
      '5': { uid: 5, key: ['城堡'], content: '城堡。', comment: 'N', order: 60 },
      '6': { uid: 6, key: ['灯塔'], content: '禁用的。', comment: 'X', disable: true, order: 70 },
    },
  };

  it('返回激活原因、命中的键与跳过原因；不落库、不推进时间态', async () => {
    const { app, db } = makeTestApp(dataDir);
    await app.request(
      '/api/settings/worldInfo.settings',
      json('PUT', { recursive: true, matchWholeWords: false }),
    );
    const book = await body<{ id: string }>(
      await upload(app, '/api/import/lorebook', '模拟.json', encodeJson(simBook)),
    );
    const res = await app.request(
      `/api/lorebooks/${book.id}/simulate`,
      json('POST', { text: '看见灯塔了，港口起了雾。' }),
    );
    expect(res.status).toBe(200);
    const result = await body<{
      activated: { comment: string; reason: string; matchedKeys: string[]; uid: number }[];
      skipped: { uid: number; reason: string }[];
    }>(res);
    const byComment = new Map(result.activated.map((a) => [a.comment, a]));
    expect(byComment.get('C')?.reason).toBe('constant');
    expect(byComment.get('K')).toMatchObject({ reason: 'key', matchedKeys: ['灯塔'] });
    expect(byComment.get('S')).toMatchObject({ reason: 'secondary', matchedKeys: ['港口', '雾'] });
    expect(byComment.get('D')?.reason).toBe('decorator');
    // 「灯塔在北方。」递归触发「北方」
    expect(byComment.get('R')).toMatchObject({ reason: 'recursion', matchedKeys: ['北方'] });
    expect(byComment.has('N')).toBe(false);
    expect(result.skipped).toContainEqual({
      id: expect.any(String),
      index: 6,
      uid: 6,
      reason: 'disabled',
    });
    expect(result.skipped).toContainEqual(expect.objectContaining({ uid: 5, reason: 'no-match' }));
    expect(db.select().from(schema.entityVersions).all()).toHaveLength(1);
  });

  it('entries 草稿：用未保存的条目模拟；scanDepth 校验', async () => {
    const { app } = makeTestApp(dataDir);
    const book = await body<{ id: string }>(
      await upload(app, '/api/import/lorebook', '模拟.json', encodeJson(simBook)),
    );
    const res = await app.request(
      `/api/lorebooks/${book.id}/simulate`,
      json('POST', {
        text: '城堡',
        entries: [{ keys: ['城堡'], content: '草稿条目', comment: '草稿' }],
      }),
    );
    const result = await body<{
      activated: { id: string | null; index: number; comment: string }[];
    }>(res);
    expect(result.activated).toEqual([
      expect.objectContaining({ id: null, index: 0, comment: '草稿' }),
    ]);

    expect(
      (
        await app.request(
          `/api/lorebooks/${book.id}/simulate`,
          json('POST', { text: 'x', scanDepth: -1 }),
        )
      ).status,
    ).toBe(400);
    expect(
      (await app.request(`/api/lorebooks/${book.id}/simulate`, json('POST', { text: 1 }))).status,
    ).toBe(400);
    expect(
      (await app.request('/api/lorebooks/nope/simulate', json('POST', { text: 'x' }))).status,
    ).toBe(404);
  });
});
