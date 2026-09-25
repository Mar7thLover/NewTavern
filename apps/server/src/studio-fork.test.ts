import fs from 'node:fs';

import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { createDatabase, schema, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/**
 * 工作台复制（`POST /api/studio/fork/:kind/:id`）与 `studio` 标记。
 * 从工作台打开库里的原件时先复制一份，编辑的是副本，原件不动。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type App = ReturnType<typeof makeTestApp>['app'];
type Json = Record<string, unknown>;

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function body<T = Json>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

const fork = (app: App, kind: string, id: string) =>
  app.request(`/api/studio/fork/${kind}/${id}`, { method: 'POST' });

function insertAsset(db: Db, sha: string): string {
  return db
    .insert(schema.assets)
    .values({ kind: 'emotion', mime: 'image/png', path: `assets/xx/${sha}`, sha256: sha })
    .returning()
    .get().id;
}

function insertRegex(
  db: Db,
  scope: 'character' | 'preset' | 'book',
  ownerId: string,
  name: string,
) {
  db.insert(schema.regexScripts)
    .values({
      scope,
      ownerId,
      scriptName: name,
      findRegex: '/a/g',
      replaceString: 'b',
      disabled: false,
      extra: { raw: { scriptName: name }, sourceDisabled: false },
    })
    .run();
}

function regexOf(db: Db, scope: 'character' | 'preset' | 'book', ownerId: string) {
  return db
    .select()
    .from(schema.regexScripts)
    .where(and(eq(schema.regexScripts.scope, scope), eq(schema.regexScripts.ownerId, ownerId)))
    .all();
}

function variablesOf(db: Db, scope: 'character' | 'preset' | 'script', ownerId: string) {
  return Object.fromEntries(
    db
      .select()
      .from(schema.variables)
      .where(and(eq(schema.variables.scope, scope), eq(schema.variables.ownerId, ownerId)))
      .all()
      .map((row) => [row.key, row.value]),
  );
}

const cardData = {
  name: '长夜月',
  description: '原件描述',
  tags: ['星铁'],
  extensions: { custom_ext: { keep: true } },
  character_book: {
    name: '长夜月的书',
    entries: [
      { keys: ['记忆'], content: '原件条目一', enabled: true, insertion_order: 100, id: 7 },
      { keys: ['三月七'], content: '原件条目二', enabled: true, insertion_order: 90, id: 9 },
    ],
  },
};

describe('迁移 0004', () => {
  it('空库上能跑，三张表都有 studio 列', () => {
    const db = createDatabase(':memory:');
    runMigrations(db);
    for (const table of ['characters', 'presets', 'lorebooks']) {
      const cols = db.all<{ name: string }>(
        // 表名来自常量列表
        `PRAGMA table_info(${table})` as never,
      );
      expect(cols.map((col) => col.name)).toContain('studio');
    }
  });
});

describe('POST /api/studio/fork', () => {
  const { app, db } = makeTestApp(dataDir);

  it('角色卡：复制卡、内嵌书（新书）、立绘、变量、自带正则；编辑副本不影响原件', async () => {
    const created = await body<Json>(
      await app.request('/api/characters', json('POST', { name: '长夜月', data: cardData })),
    );
    const sourceId = created.id as string;
    const sourceBookId = created.bookId as string;
    expect(created.studio).toBeNull();
    expect(sourceBookId).toBeTruthy();

    const assetId = insertAsset(db, 'sprite-sha-1');
    db.insert(schema.characterSprites)
      .values({ characterId: sourceId, label: 'joy', assetId })
      .run();
    db.insert(schema.variables)
      .values({ scope: 'character', ownerId: sourceId, key: '好感', value: 3 })
      .run();
    insertRegex(db, 'character', sourceId, '卡正则');
    insertRegex(db, 'book', sourceBookId, '书正则');

    const res = await fork(app, 'character', sourceId);
    expect(res.status).toBe(201);
    const result = await body<{ id: string; forked: boolean }>(res);
    expect(result.forked).toBe(true);
    expect(result.id).not.toBe(sourceId);

    const copy = await body<Json>(await app.request(`/api/characters/${result.id}`));
    expect(copy.name).toBe('长夜月');
    expect(copy.studio).toEqual({ sourceId });
    expect(copy.data).toEqual(created.data);
    expect(copy.originalHash).toBeNull();
    expect(copy.bookId).toBeTruthy();
    expect(copy.bookId).not.toBe(sourceBookId);

    // 新书：条目深拷贝（uid / extra 原样，id 全新），同样是工作台的
    const sourceBook = await body<{ entries: Json[] } & Json>(
      await app.request(`/api/lorebooks/${sourceBookId}`),
    );
    const copyBook = await body<{ entries: Json[] } & Json>(
      await app.request(`/api/lorebooks/${copy.bookId as string}`),
    );
    expect(copyBook.studio).toEqual({ sourceId: sourceBookId });
    expect(copyBook.scope).toBe('char');
    expect(copyBook.name).toBe(sourceBook.name);
    expect(copyBook.entries.map((e) => [e.uid, e.content, e.extra])).toEqual(
      sourceBook.entries.map((e) => [e.uid, e.content, e.extra]),
    );
    const sourceEntryIds = new Set(sourceBook.entries.map((e) => e.id));
    expect(copyBook.entries.every((e) => !sourceEntryIds.has(e.id))).toBe(true);

    // 立绘（同一资产）、变量、正则
    const sprites = db
      .select()
      .from(schema.characterSprites)
      .where(eq(schema.characterSprites.characterId, result.id))
      .all();
    expect(sprites.map((s) => [s.label, s.assetId])).toEqual([['joy', assetId]]);
    expect(variablesOf(db, 'character', result.id)).toEqual({ 好感: 3 });
    expect(regexOf(db, 'character', result.id).map((r) => r.scriptName)).toEqual(['卡正则']);
    expect(regexOf(db, 'book', copy.bookId as string).map((r) => r.scriptName)).toEqual(['书正则']);

    // 版本：副本与新书各一版
    const versions = await body<unknown[]>(
      await app.request(`/api/versions/character/${result.id}`),
    );
    expect(versions.length).toBe(1);

    // 没改过的副本导出与原件相同
    const exportJson = async (id: string) =>
      (await app.request(`/api/characters/${id}/export?format=json`)).text();
    expect(await exportJson(result.id)).toBe(await exportJson(sourceId));

    // 编辑副本（卡 + 书）→ 原件不变
    const edited = { ...(copy.data as Json), description: '副本描述' };
    expect(
      (await app.request(`/api/characters/${result.id}`, json('PUT', { data: edited }))).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/api/lorebooks/${copy.bookId as string}`,
          json('PUT', {
            entries: copyBook.entries.map((e) => ({
              id: e.id,
              content: `${String(e.content)}（改）`,
            })),
          }),
        )
      ).status,
    ).toBe(200);
    const sourceAfter = await body<Json>(await app.request(`/api/characters/${sourceId}`));
    expect((sourceAfter.data as Json).description).toBe('原件描述');
    const sourceBookAfter = await body<{ entries: Json[] }>(
      await app.request(`/api/lorebooks/${sourceBookId}`),
    );
    expect(sourceBookAfter.entries.map((e) => e.content)).toEqual(
      sourceBook.entries.map((e) => e.content),
    );

    // 已是工作台的：不再复制
    const again = await fork(app, 'character', result.id);
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({ id: result.id, forked: false });
    // 副本的内嵌书同样不再复制
    expect(await body(await fork(app, 'lorebook', copy.bookId as string))).toEqual({
      id: copy.bookId,
      forked: false,
    });

    // 列表带 studio
    const list = await body<Json[]>(await app.request('/api/characters'));
    expect(list.find((row) => row.id === sourceId)?.studio).toBeNull();
    expect(list.find((row) => row.id === result.id)?.studio).toEqual({ sourceId });
  });

  it('预设：复制行（「<原名> 副本」）、自带脚本（含 script 变量）、自带正则、预设变量', async () => {
    const preset = await body<Json>(
      await app.request('/api/presets', json('POST', { name: '夜航' })),
    );
    const sourceId = preset.id as string;
    const script = db
      .insert(schema.scripts)
      .values({
        scope: 'preset',
        ownerId: sourceId,
        name: '状态栏',
        content: 'console.log(1)',
        enabled: true,
        buttons: [{ name: '刷新', visible: true }],
        data: { id: 'orig', keep: 1 },
      })
      .returning()
      .get();
    db.insert(schema.variables)
      .values({ scope: 'script', ownerId: script.id, key: '次数', value: 2 })
      .run();
    db.insert(schema.variables)
      .values({ scope: 'preset', ownerId: sourceId, key: '风格', value: '冷' })
      .run();
    insertRegex(db, 'preset', sourceId, '藏思维链');

    const res = await fork(app, 'preset', sourceId);
    expect(res.status).toBe(201);
    const { id } = await body<{ id: string }>(res);
    const copy = await body<Json>(await app.request(`/api/presets/${id}`));
    expect(copy.name).toBe('夜航 副本');
    expect(copy.studio).toEqual({ sourceId });

    const scripts = db
      .select()
      .from(schema.scripts)
      .where(and(eq(schema.scripts.scope, 'preset'), eq(schema.scripts.ownerId, id)))
      .all();
    expect(scripts.map((s) => [s.name, s.content, s.enabled, s.buttons, s.data])).toEqual([
      [
        '状态栏',
        'console.log(1)',
        true,
        [{ name: '刷新', visible: true }],
        { id: 'orig', keep: 1 },
      ],
    ]);
    expect(scripts[0]!.id).not.toBe(script.id);
    expect(variablesOf(db, 'script', scripts[0]!.id)).toEqual({ 次数: 2 });
    expect(variablesOf(db, 'preset', id)).toEqual({ 风格: '冷' });
    expect(regexOf(db, 'preset', id).map((r) => r.scriptName)).toEqual(['藏思维链']);
    // 原件的脚本仍在原处
    expect(
      db.select().from(schema.scripts).where(eq(schema.scripts.ownerId, sourceId)).all().length,
    ).toBe(1);

    const list = await body<Json[]>(await app.request('/api/presets'));
    expect(list.find((row) => row.id === id)?.studio).toEqual({ sourceId });
    expect(list.find((row) => row.id === sourceId)?.studio).toBeNull();

    // 库里的「复制」仍是库里的（不带 studio）
    const dup = await body<Json>(
      await app.request(`/api/presets/${sourceId}/duplicate`, { method: 'POST' }),
    );
    expect(dup.studio).toBeNull();
  });

  it('世界书：行 + 条目深拷贝，「<原名> 副本」；卡内嵌书单独复制出来当独立的书', async () => {
    const book = await body<Json>(
      await app.request('/api/lorebooks', json('POST', { name: '设定集' })),
    );
    const bookId = book.id as string;
    await app.request(
      `/api/lorebooks/${bookId}`,
      json('PUT', { entries: [{ keys: ['龙'], content: '龙族' }] }),
    );
    const source = await body<{ entries: Json[] }>(await app.request(`/api/lorebooks/${bookId}`));
    expect(source.entries.length).toBe(1);

    const res = await fork(app, 'lorebook', bookId);
    expect(res.status).toBe(201);
    const { id } = await body<{ id: string }>(res);
    const copy = await body<{ entries: Json[] } & Json>(await app.request(`/api/lorebooks/${id}`));
    expect(copy.name).toBe('设定集 副本');
    expect(copy.scope).toBe('global');
    expect(copy.studio).toEqual({ sourceId: bookId });
    expect(copy.entries.map((e) => [e.keys, e.content])).toEqual([[['龙'], '龙族']]);

    await app.request(
      `/api/lorebooks/${id}`,
      json('PUT', { entries: [{ id: copy.entries[0]!.id, content: '改过' }] }),
    );
    const after = await body<{ entries: Json[] }>(await app.request(`/api/lorebooks/${bookId}`));
    expect(after.entries[0]!.content).toBe('龙族');

    // 卡内嵌书
    const character = await body<Json>(
      await app.request('/api/characters', json('POST', { name: '书主', data: cardData })),
    );
    const charBookRes = await fork(app, 'lorebook', character.bookId as string);
    const charBook = await body<Json>(
      await app.request(`/api/lorebooks/${(await body<{ id: string }>(charBookRes)).id}`),
    );
    expect(charBook.scope).toBe('global');

    const list = await body<Json[]>(await app.request('/api/lorebooks'));
    expect(list.find((row) => row.id === id)?.studio).toEqual({ sourceId: bookId });
  });

  it('不存在 404，未知类型 400', async () => {
    expect((await fork(app, 'character', 'nope')).status).toBe(404);
    expect((await fork(app, 'preset', 'nope')).status).toBe(404);
    expect((await fork(app, 'lorebook', 'nope')).status).toBe(404);
    expect((await fork(app, 'chat', 'x')).status).toBe(400);
  });

  it('新建带 studio: true：记为工作台的（sourceId null），fork 返回 forked:false', async () => {
    const character = await body<Json>(
      await app.request(
        '/api/characters',
        json('POST', { name: '新卡', data: cardData, studio: true }),
      ),
    );
    expect(character.studio).toEqual({ sourceId: null });
    const book = await body<Json>(
      await app.request(`/api/lorebooks/${character.bookId as string}`),
    );
    expect(book.studio).toEqual({ sourceId: null });
    expect(await body(await fork(app, 'character', character.id as string))).toEqual({
      id: character.id,
      forked: false,
    });

    const preset = await body<Json>(
      await app.request('/api/presets', json('POST', { studio: true })),
    );
    expect(preset.studio).toEqual({ sourceId: null });
    const lorebook = await body<Json>(
      await app.request('/api/lorebooks', json('POST', { studio: true })),
    );
    expect(lorebook.studio).toEqual({ sourceId: null });

    // 不带 studio 的新建仍是库里的
    const plain = await body<Json>(await app.request('/api/presets', json('POST', {})));
    expect(plain.studio).toBeNull();
  });
});
