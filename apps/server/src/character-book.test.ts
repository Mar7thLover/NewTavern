import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { backfillCharacterBooks } from './services/backfill.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/** 卡内嵌世界书抽表 / 回填 / 导出重建。见 docs/M3-CONTRACT.md §3.1、§3.7。 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const characterBook = {
  name: '酒馆秘闻',
  scan_depth: 3,
  entries: [
    { keys: ['麦酒'], content: '招牌麦酒。', enabled: true, insertion_order: 100 },
    {
      keys: ['地窖'],
      secondary_keys: ['老鼠'],
      content: '地窖里有老鼠。',
      enabled: false,
      insertion_order: 50,
      name: '地窖',
    },
  ],
};

const cardWithBook = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾拉',
    description: '酒馆老板娘',
    personality: '热情',
    scenario: '',
    first_mes: '欢迎。',
    mes_example: '',
    character_book: characterBook,
  },
};

interface Book {
  id: string;
  name: string;
  scope: string;
  entryCount: number;
}

function upload(app: ReturnType<typeof makeTestApp>['app'], bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([bytes.slice()], '艾拉.json'));
  return app.request('/api/import/character', { method: 'POST', body: form });
}

const encodeJson = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

/** 模拟「书被编辑过」：updated_at 晚于 created_at */
function touchBook(db: Db, bookId: string) {
  const book = db.select().from(schema.lorebooks).where(eq(schema.lorebooks.id, bookId)).get();
  db.update(schema.lorebooks)
    .set({ updatedAt: new Date((book?.createdAt.getTime() ?? Date.now()) + 1000) })
    .where(eq(schema.lorebooks.id, bookId))
    .run();
}

describe('卡内嵌世界书抽表', () => {
  it('导入时抽表、回填 book_id，data.character_book 原样保留，导出仍是原件', async () => {
    const { app, db } = makeTestApp(dataDir);
    const res = await upload(app, encodeJson(cardWithBook));
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const detail = (await (await app.request(`/api/characters/${id}`)).json()) as {
      bookId: string | null;
      data: { character_book: unknown };
    };
    expect(detail.bookId).toBeTruthy();
    // 卡内原始字段不动
    expect(detail.data.character_book).toEqual(characterBook);

    const books = (await (await app.request('/api/lorebooks')).json()) as Book[];
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ name: '酒馆秘闻', scope: 'char', entryCount: 2 });
    expect(books[0]?.id).toBe(detail.bookId);

    const entries = (
      (await (await app.request(`/api/lorebooks/${detail.bookId}`)).json()) as {
        entries: { keys: string[]; content: string; disabled: boolean; entryOrder: number }[];
      }
    ).entries;
    expect(entries.map((e) => e.keys)).toEqual([['麦酒'], ['地窖']]);
    expect(entries[1]).toMatchObject({ disabled: true, entryOrder: 50, comment: '地窖' });

    // 未编辑过的卡：导出仍是原始字节
    const exported = await app.request(`/api/characters/${id}/export?format=json`);
    expect(await exported.json()).toEqual(cardWithBook);

    // 抽表幂等：再回填一次什么都不做
    expect(backfillCharacterBooks(db)).toEqual({ characters: 0 });
    expect(((await (await app.request('/api/lorebooks')).json()) as Book[]).length).toBe(1);
  });

  it('启动回填：M1 遗留的 book_id IS NULL 角色被抽表，且幂等', async () => {
    const { app, db } = makeTestApp(dataDir);
    // 模拟 M1 导入的行：没有 book_id
    const legacy = db
      .insert(schema.characters)
      .values({ name: '艾拉', spec: 'v2', data: cardWithBook.data })
      .returning()
      .get();
    expect(legacy.bookId).toBeNull();

    expect(backfillCharacterBooks(db)).toEqual({ characters: 1 });
    expect(backfillCharacterBooks(db)).toEqual({ characters: 0 });

    const books = (await (await app.request('/api/lorebooks')).json()) as Book[];
    expect(books).toHaveLength(1);
    expect(books[0]?.entryCount).toBe(2);
    const row = db
      .select()
      .from(schema.characters)
      .where(eq(schema.characters.id, legacy.id))
      .get();
    expect(row?.bookId).toBe(books[0]?.id);

    // 没有内嵌世界书的角色不会被抽表
    db.insert(schema.characters)
      .values({ name: '无书', spec: 'v2', data: { name: '无书' } })
      .run();
    expect(backfillCharacterBooks(db)).toEqual({ characters: 0 });
  });

  it('书被编辑过：导出由表重建 character_book，未改动列时 deep-equal 原始条目', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { id } = (await (await upload(app, encodeJson(cardWithBook))).json()) as { id: string };
    const bookId = db.select().from(schema.characters).where(eq(schema.characters.id, id)).get()
      ?.bookId as string;

    touchBook(db, bookId);
    const rebuilt = (await (
      await app.request(`/api/characters/${id}/export?format=json`)
    ).json()) as {
      data: { character_book: typeof characterBook };
    };
    // 以 extra.raw 为底叠加列值：没改过列 → 与原始条目逐字段一致
    expect(rebuilt.data.character_book).toEqual(characterBook);

    // 改一条条目的列 → 重建结果带上改动，其余字段不动
    const entry = db
      .select()
      .from(schema.lorebookEntries)
      .where(eq(schema.lorebookEntries.bookId, bookId))
      .all()[0];
    db.update(schema.lorebookEntries)
      .set({ content: '招牌麦酒（改）', keys: ['麦酒', '啤酒'] })
      .where(eq(schema.lorebookEntries.id, entry!.id))
      .run();

    const edited = (await (
      await app.request(`/api/characters/${id}/export?format=json`)
    ).json()) as {
      data: { character_book: typeof characterBook };
    };
    expect(edited.data.character_book.entries[0]).toEqual({
      ...characterBook.entries[0],
      keys: ['麦酒', '啤酒'],
      content: '招牌麦酒（改）',
    });
    expect(edited.data.character_book.entries[1]).toEqual(characterBook.entries[1]);
    expect(edited.data.character_book.name).toBe('酒馆秘闻');
    expect(edited.data.character_book.scan_depth).toBe(3);
  });
});
