import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { newStEntryTemplate, planDisplayIndexes } from './services/lorebook-edit.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
  type TestApp,
} from './test-helpers.js';

/** 世界书编辑：`POST /api/lorebooks`、`PUT /api/lorebooks/:id` 与导出往返 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

registerFakeAdapter({
  id: 'fake-le',
  events: [
    { type: 'text.delta', text: '好。' },
    { type: 'stop', reason: 'end' },
  ],
  renderMessages: true,
});

type Json = Record<string, unknown>;

/** 按 ST 1.18 真实导出形态造的条目（字段齐全，外加 extensions 与未知字段） */
function stEntry(uid: number, patch: Json = {}): Json {
  return {
    key: [`关键词${uid}`],
    keysecondary: [],
    comment: `条目${uid}`,
    content: `正文 ${uid}`,
    constant: false,
    vectorized: false,
    selective: true,
    selectiveLogic: 0,
    addMemo: true,
    order: 100 + uid,
    position: 0,
    disable: false,
    ignoreBudget: false,
    excludeRecursion: false,
    preventRecursion: false,
    matchPersonaDescription: false,
    matchCharacterDescription: false,
    matchCharacterPersonality: false,
    matchCharacterDepthPrompt: false,
    matchScenario: false,
    matchCreatorNotes: false,
    delayUntilRecursion: false,
    probability: 100,
    useProbability: true,
    depth: 4,
    outletName: '',
    group: '',
    groupOverride: false,
    groupWeight: 100,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    useGroupScoring: false,
    automationId: '',
    role: null,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    triggers: [],
    uid,
    displayIndex: uid,
    extensions: { position: 0, display_index: uid, unknown_ext: { keep: true } },
    unknown_entry_field: `keep-${uid}`,
    ...patch,
  };
}

const stBook: Json = {
  entries: Object.fromEntries(
    [0, 1, 2, 3, 4].map((uid) => [String(uid), stEntry(uid, uid === 0 ? { constant: true } : {})]),
  ),
  originalData: { name: '原始卡书', entries: [{ id: 0 }] },
};

interface EntryRow extends Json {
  id: string;
  uid: number | null;
  keys: string[];
  displayIndex: number | null;
}
interface Detail {
  id: string;
  name: string;
  updatedAt: string;
  entries: EntryRow[];
}

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

async function importBook({ app }: TestApp, book: Json = stBook, file = '雾港.json') {
  const form = new FormData();
  form.append('file', new File([JSON.stringify(book)], file));
  const res = await app.request('/api/import/lorebook', { method: 'POST', body: form });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const detail = async ({ app }: TestApp, id: string) =>
  (await (await app.request(`/api/lorebooks/${id}`)).json()) as Detail;
const put = ({ app }: TestApp, id: string, body: unknown) =>
  app.request(`/api/lorebooks/${id}`, json('PUT', body));
const exported = async ({ app }: TestApp, id: string) =>
  (await (await app.request(`/api/lorebooks/${id}/export`)).json()) as Json;

/** 深比较，返回有差异的路径（`a.b.c`） */
function deepDiff(a: unknown, b: unknown, path = ''): string[] {
  if (JSON.stringify(a) === JSON.stringify(b)) return [];
  const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null;
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return [path];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].flatMap((key) =>
    deepDiff((a as Json)[key], (b as Json)[key], path ? `${path}.${key}` : key),
  );
}

describe('PUT /api/lorebooks/:id', () => {
  it('编辑往返：导出与原文件只差这些改动，未知字段保留，新条目是 ST 模板形态', async () => {
    const t = makeTestApp(dataDir);
    const id = await importBook(t);
    const before = await detail(t, id);
    const byUid = (uid: number) => before.entries.find((entry) => entry.uid === uid)!;

    // 新增一条插到最前；删 uid0；改 uid1 关键词与正文；关 uid2；uid3 改到 @深度；对调 uid3 / uid4
    const res = await put(t, id, {
      name: '  雾港设定 ',
      entries: [
        { keys: ['灯塔', '雾'], content: '新条目正文', comment: '新条目' },
        { id: byUid(1).id, keys: ['钟楼'], content: '改过的正文' },
        { id: byUid(2).id, disabled: true },
        { id: byUid(4).id },
        { id: byUid(3).id, position: 4, depth: 2, role: 'user' },
      ],
    });
    expect(res.status).toBe(200);
    const saved = (await res.json()) as Detail;
    expect(saved.name).toBe('雾港设定');
    expect(saved.entries.map((entry) => entry.uid)).toEqual([5, 1, 2, 4, 3]);
    expect(new Date(saved.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );
    expect(await detail(t, id)).toEqual(saved);

    const out = await exported(t, id);
    const diff = deepDiff(stBook, out).sort();
    expect(diff).toEqual(
      [
        'entries.0',
        'entries.1.content',
        'entries.1.key.0',
        'entries.2.disable',
        'entries.3.depth',
        'entries.3.displayIndex',
        'entries.3.position',
        'entries.3.role',
        'entries.5',
      ].sort(),
    );
    const entries = out.entries as Record<string, Json>;
    expect(entries['1']!.key).toEqual(['钟楼']);
    expect(entries['3']).toMatchObject({ position: 4, depth: 2, role: 1 });
    expect(entries['4']!.displayIndex).toBe(4);
    expect(entries['1']!.unknown_entry_field).toBe('keep-1');
    expect(out.originalData).toEqual(stBook.originalData);

    // 新条目：ST createWorldInfoEntry 的字段集合（模板 + uid），外加顺序用的 displayIndex
    const created = entries['5']!;
    expect(Object.keys(created)).toEqual([...Object.keys(newStEntryTemplate(5)), 'displayIndex']);
    expect(created).toEqual({
      ...newStEntryTemplate(5),
      key: ['灯塔', '雾'],
      content: '新条目正文',
      comment: '新条目',
      displayIndex: 0,
    });
  });

  it('什么都不改地保存：导出与原文件完全一致（含重复 / 缺失的 displayIndex）', async () => {
    const t = makeTestApp(dataDir);
    const odd: Json = {
      entries: {
        '0': stEntry(0, { displayIndex: 3 }),
        '1': stEntry(1, { displayIndex: 3 }),
        '2': stEntry(2, { displayIndex: undefined }),
        '7': stEntry(9),
      },
    };
    const original = JSON.parse(JSON.stringify(odd)) as Json;
    const id = await importBook(t, original);
    const before = await detail(t, id);
    const res = await put(t, id, { entries: before.entries.map((entry) => ({ id: entry.id })) });
    expect(res.status).toBe(200);
    expect(await exported(t, id)).toEqual(original);

    // 新条目 uid 不与 uid / 对象 key 冲突
    const add = await put(t, id, {
      entries: [...before.entries.map((entry) => ({ id: entry.id })), { content: '追加' }],
    });
    const rows = ((await add.json()) as Detail).entries;
    expect(rows.map((row) => row.uid).sort((a, b) => a! - b!)).toEqual([0, 1, 2, 9, 10]);
    expect(Object.keys((await exported(t, id)).entries as Json).sort()).toEqual(
      ['0', '1', '10', '2', '7'].sort(),
    );
  });

  it('无独立列的字段：概率开关、向量化、锚点名、递归等级写进 raw', async () => {
    const t = makeTestApp(dataDir);
    const id = await importBook(t);
    const rows = (await detail(t, id)).entries;
    const res = await put(t, id, {
      entries: rows.map((row, index) =>
        index === 0
          ? { id: row.id, useProbability: false, probability: 30, outletName: '侧栏' }
          : index === 1
            ? { id: row.id, delayUntilRecursion: 2, secondaryKeys: ['夜'], selective: false }
            : { id: row.id },
      ),
    });
    expect(res.status).toBe(200);
    const entries = (await exported(t, id)).entries as Record<string, Json>;
    expect(entries['0']).toMatchObject({
      useProbability: false,
      probability: 30,
      outletName: '侧栏',
    });
    expect(entries['1']).toMatchObject({ delayUntilRecursion: 2, keysecondary: ['夜'] });
    // 显式传了 selective: false 时尊重请求
    expect(entries['1']!.selective).toBe(false);
  });

  it('非法请求返回 400，不存在返回 404，库里数据不变', async () => {
    const t = makeTestApp(dataDir);
    const id = await importBook(t);
    const other = await importBook(t, stBook, '别的书.json');
    const rows = (await detail(t, id)).entries;
    const otherRow = (await detail(t, other)).entries[0]!;
    const keep = rows.map((row) => ({ id: row.id }));

    const cases: [unknown, RegExp][] = [
      [{ name: 'x' }, /entries/],
      [{ entries: [{ id: rows[0]!.id, position: 9 }] }, /position/],
      [{ entries: [{ id: rows[0]!.id, keys: '灯塔' }] }, /keys/],
      [{ entries: [{ id: rows[0]!.id, probability: 101 }] }, /probability/],
      [{ entries: [{ id: rows[0]!.id, scanDepth: 1.5 }] }, /scanDepth/],
      [{ entries: [{ id: rows[0]!.id, role: 'narrator' }] }, /role/],
      [{ entries: [{ id: rows[0]!.id, uid: 99 }] }, /uid/],
      [{ entries: [{ id: rows[0]!.id }, { id: rows[0]!.id }] }, /重复/],
      [{ entries: [...keep, { id: otherRow.id }] }, /不属于/],
      [{ name: '  ', entries: keep }, /name/],
      [[1, 2], /JSON/],
    ];
    for (const [body, message] of cases) {
      const res = await put(t, id, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { message: string }).message).toMatch(message);
    }
    expect((await put(t, id, 'not json')).status).toBe(400);
    expect((await put(t, 'nope', { entries: [] })).status).toBe(404);
    expect(await exported(t, id)).toEqual(stBook);
  });

  it('删除条目后：绑定关系保留，检查器组装用上新条目、跳过关闭的条目', async () => {
    const t = makeTestApp(dataDir);
    const { app, db } = t;
    const id = await importBook(t);
    const chatId = await setupChat(t);
    await app.request(`/api/chats/${chatId}/lorebooks`, json('PUT', { bookIds: [id] }));

    const rows = (await detail(t, id)).entries;
    const res = await put(t, id, {
      entries: [
        // uid0 常驻 → 关闭；uid1 关键词改成开场白里的「雾港」；删掉 uid2..4
        { id: rows[0]!.id, disabled: true },
        { id: rows[1]!.id, keys: ['雾港'], content: 'EDITED · 雾港的钟声。' },
      ],
    });
    expect(res.status).toBe(200);
    expect(
      db.select().from(schema.chatLorebooks).where(eq(schema.chatLorebooks.chatId, chatId)).all(),
    ).toHaveLength(1);

    const inspect = await app.request(`/api/chats/${chatId}/inspect`);
    expect(inspect.status).toBe(200);
    const data = (await inspect.json()) as {
      wi: { activations: { entry: { uid: number } }[] };
      request: { body: { messages: { content: string }[] } };
    };
    expect(data.wi.activations.map((item) => item.entry.uid)).toEqual([1]);
    const joined = data.request.body.messages.map((m) => m.content).join('\n');
    expect(joined).toContain('EDITED · 雾港的钟声。');
    expect(joined).not.toContain('正文 0');

    // 删光条目也不出错
    expect((await put(t, id, { entries: [] })).status).toBe(200);
    expect((await app.request(`/api/chats/${chatId}/inspect`)).status).toBe(200);
  });
});

describe('POST /api/lorebooks', () => {
  it('新建空书：默认名、ST 空文件形态，可继续加条目', async () => {
    const t = makeTestApp(dataDir);
    const res = await t.app.request('/api/lorebooks', { method: 'POST' });
    expect(res.status).toBe(201);
    const book = (await res.json()) as Detail;
    expect(book).toMatchObject({ name: '新世界书', entries: [] });
    expect(await exported(t, book.id)).toEqual({ entries: {} });

    const named = await t.app.request('/api/lorebooks', json('POST', { name: ' 港口 ' }));
    expect(((await named.json()) as Detail).name).toBe('港口');
    expect((await t.app.request('/api/lorebooks', json('POST', { name: 3 }))).status).toBe(400);

    await put(t, book.id, { name: '改名', entries: [{ keys: ['a'] }] });
    const out = await exported(t, book.id);
    expect(out).toEqual({
      entries: { '0': { ...newStEntryTemplate(0), key: ['a'], displayIndex: 0 } },
    });
    const list = (await (await t.app.request('/api/lorebooks')).json()) as Json[];
    expect(list.find((item) => item.id === book.id)).toMatchObject({ name: '改名', entryCount: 1 });
  });
});

describe('planDisplayIndexes', () => {
  it('尽量保留原值', () => {
    expect(planDisplayIndexes([0, 1, 2, 3])).toEqual([null, null, null, null]);
    // 连续编号里对调相邻两条：没有空隙，只能改这两条
    expect(planDisplayIndexes([0, 2, 1, 3]).filter((v) => v !== null)).toHaveLength(2);
    // 有空隙（删过条目）时只改一条
    expect(planDisplayIndexes([1, 2, 4, 3]).filter((v) => v !== null)).toHaveLength(1);
    // 插到最前：新条目取负数，其余不动
    expect(planDisplayIndexes([null, 0, 1, 2])).toEqual([-1, null, null, null]);
    expect(planDisplayIndexes([null, null])).toEqual([0, 1]);
    // 结果必须严格递增
    const values = [5, 3, 3, null, 9, 1, 2];
    const plan = planDisplayIndexes(values);
    const final = plan.map((v, i) => v ?? values[i]!);
    for (let i = 1; i < final.length; i++) expect(final[i]!).toBeGreaterThan(final[i - 1]!);
  });
});

/* ------------------------------------------------------------------ */

async function setupChat({ app, db, dataDir: dir }: TestApp): Promise<string> {
  const conn = insertConnection(db, dir, 'fake-le');
  const characterId = insertCharacter(db);
  const presetId = insertPreset(db);
  await app.request(
    '/api/settings/generation.default',
    json('PUT', { connectionId: conn.id, model: 'm' }),
  );
  const res = await app.request(
    '/api/chats',
    json('POST', { characterIds: [characterId], presetId }),
  );
  return ((await res.json()) as { id: string }).id;
}

function insertCharacter(db: Db): string {
  return db
    .insert(schema.characters)
    .values({
      name: '艾拉',
      spec: 'v2',
      data: { name: '艾拉', description: '酒馆老板娘。', first_mes: '欢迎来到雾港。' },
    })
    .returning()
    .get().id;
}

function insertPreset(db: Db): string {
  return db
    .insert(schema.presets)
    .values({
      name: 'LE 测试预设',
      format: 'native',
      data: {
        prompts: [
          { identifier: 'main', name: 'Main', role: 'system', content: '你是 {{char}}。' },
          { identifier: 'worldInfoBefore', name: 'WI before', marker: true },
          { identifier: 'worldInfoAfter', name: 'WI after', marker: true },
          { identifier: 'chatHistory', name: 'History', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: ['main', 'worldInfoBefore', 'worldInfoAfter', 'chatHistory'].map(
              (identifier) => ({ identifier, enabled: true }),
            ),
          },
        ],
        openai_max_context: 32000,
        openai_max_tokens: 500,
      },
    })
    .returning()
    .get().id;
}
