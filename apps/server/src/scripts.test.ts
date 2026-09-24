import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { backfillPresetScripts, type ScriptRow } from './services/scripts.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/**
 * 酒馆助手脚本库（M5（三）§2）：CRUD、排序、导入（新 / 旧格式、数组、树）、导出往返、
 * 预设自带脚本的抽取 / 回填 / 一键启用。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** 新格式（4.9.3 `Script`） */
const MODERN = {
  type: 'script',
  enabled: true,
  name: '悬浮球',
  id: 'orig-1',
  content: "import 'https://cdn.example/ball.js';",
  info: '作者：某人',
  button: { enabled: true, buttons: [{ name: '打开面板', visible: true }] },
  data: { color: 'red' },
  export_with: { data: true, button: true },
  somethingUnknown: 42,
};

/** 旧格式（3.x `ScriptData`） */
const LEGACY = {
  enabled: true,
  name: '旧脚本',
  id: 'legacy-1',
  content: 'console.log(1)',
  info: '',
  buttons: [{ name: '旧按钮', visible: false }],
  data: {},
};

/** 预设夹具（照「双人成行」那种结构：extensions.tavern_helper.scripts + variables） */
const PRESET = {
  temperature: 1,
  prompts: [],
  prompt_order: [],
  extensions: {
    tavern_helper: {
      scripts: [
        {
          type: 'script',
          enabled: true,
          name: '预设对比助手',
          id: 'p-a',
          content: 'a()',
          info: '',
          button: { enabled: true, buttons: [] },
          data: {},
        },
        {
          type: 'script',
          enabled: false,
          name: '悬浮窗',
          id: 'p-b',
          content: 'b()',
          info: '',
          button: { enabled: true, buttons: [{ name: '开关', visible: true }] },
          data: {},
        },
      ],
      variables: { st_tagfixer_preset: {} },
    },
  },
};

async function importJson(app: ReturnType<typeof makeTestApp>['app'], payload: unknown) {
  const form = new FormData();
  form.append(
    'file',
    new File([JSON.stringify(payload)], 'script.json', { type: 'application/json' }),
  );
  return app.request('/api/scripts/import', { method: 'POST', body: form });
}

describe('脚本库 CRUD 与排序', () => {
  it('新建 / 改 / 删 / 排序', async () => {
    const { app } = makeTestApp(dataDir);
    const created: ScriptRow[] = [];
    for (const name of ['一', '二', '三']) {
      const res = await app.request(
        '/api/scripts',
        json('POST', { scope: 'global', name, content: `${name}()` }),
      );
      expect(res.status).toBe(201);
      created.push((await res.json()) as ScriptRow);
    }
    expect(created.map((row) => row.displayOrder)).toEqual([0, 1, 2]);
    expect(created[0]).toMatchObject({
      scope: 'global',
      ownerId: null,
      enabled: false,
      buttons: [],
      info: '',
    });

    const bad = await app.request('/api/scripts', json('POST', { scope: 'global', name: '' }));
    expect(bad.status).toBe(400);
    const badScope = await app.request(
      '/api/scripts',
      json('POST', { scope: 'preset', name: 'x' }),
    );
    expect(badScope.status).toBe(400);

    const updated = (await (
      await app.request(
        `/api/scripts/${created[1]?.id}`,
        json('PUT', { enabled: true, info: '说明', buttons: [{ name: '按钮', visible: true }] }),
      )
    ).json()) as ScriptRow;
    expect(updated).toMatchObject({
      enabled: true,
      info: '说明',
      buttons: [{ name: '按钮', visible: true }],
    });
    expect(updated.data.info).toBe('说明');

    const order = await app.request(
      '/api/scripts/order',
      json('PUT', { ids: [created[2]?.id, created[0]?.id, created[1]?.id] }),
    );
    expect(order.status).toBe(200);
    const listed = (await (await app.request('/api/scripts?scope=global')).json()) as ScriptRow[];
    expect(listed.map((row) => row.name)).toEqual(['三', '一', '二']);

    expect((await app.request(`/api/scripts/${created[0]?.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await app.request(`/api/scripts/${created[0]?.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
    expect(((await (await app.request('/api/scripts')).json()) as ScriptRow[]).length).toBe(2);
  });
});

describe('导入与导出', () => {
  it('单个新格式：原件整份存 data，默认关闭；导出往返保留未知字段', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await importJson(app, MODERN);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { count: number; scripts: ScriptRow[] };
    expect(body.count).toBe(1);
    const row = body.scripts[0] as ScriptRow;
    expect(row).toMatchObject({
      name: '悬浮球',
      enabled: false,
      info: '作者：某人',
      buttons: [{ name: '打开面板', visible: true }],
      buttonsEnabled: true,
      folder: null,
    });
    expect(row.data.somethingUnknown).toBe(42);

    const exported = await app.request(`/api/scripts/${row.id}/export`);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('content-disposition')).toContain('attachment');
    const back = (await exported.json()) as Record<string, unknown>;
    // 开关以列为准（导入默认关），其余与原件一致；簿记键不外泄
    expect(back).toEqual({ ...MODERN, enabled: false });
    expect(back).not.toHaveProperty('sourceEnabled');
    expect(back).not.toHaveProperty('folder');
  });

  it('旧格式单个、数组、带文件夹的树（新旧两种文件夹）', async () => {
    const { app } = makeTestApp(dataDir);
    const legacy = (await (await importJson(app, LEGACY)).json()) as { scripts: ScriptRow[] };
    expect(legacy.scripts[0]).toMatchObject({
      name: '旧脚本',
      buttons: [{ name: '旧按钮', visible: false }],
    });
    // 旧格式转成新格式存：button 对象，不留 buttons 顶层键
    expect(legacy.scripts[0]?.data.button).toEqual({
      enabled: true,
      buttons: [{ name: '旧按钮', visible: false }],
    });
    expect(legacy.scripts[0]?.data).not.toHaveProperty('buttons');

    const array = (await (await importJson(app, [MODERN, LEGACY])).json()) as { count: number };
    expect(array.count).toBe(2);

    const tree = [
      {
        type: 'folder',
        name: '美化',
        enabled: true,
        id: 'f',
        icon: '',
        color: '',
        scripts: [MODERN],
      },
      // 旧格式：ScriptItem 与 { type:'folder', value } 文件夹
      { type: 'script', value: LEGACY },
      { type: 'folder', name: '旧夹', id: 'f2', value: [{ ...LEGACY, name: '夹中旧脚本' }] },
    ];
    const res = (await (await importJson(app, tree)).json()) as { scripts: ScriptRow[] };
    expect(res.scripts.map((row) => [row.name, row.folder])).toEqual([
      ['悬浮球', '美化'],
      ['旧脚本', null],
      ['夹中旧脚本', '旧夹'],
    ]);

    // JSON body 形式（带 scope / ownerId 包装）也认
    const viaJson = await app.request('/api/scripts/import', json('POST', { scripts: [LEGACY] }));
    expect(viaJson.status).toBe(201);

    const empty = await importJson(app, { hello: 1 });
    expect(empty.status).toBe(400);
  });
});

describe('预设自带脚本', () => {
  it('导入预设时抽成 preset 行（默认关闭，原件不动），一键启用按原件开关恢复，删预设带走', async () => {
    const { app, db } = makeTestApp(dataDir);
    const form = new FormData();
    form.append(
      'file',
      new File([JSON.stringify(PRESET)], '双人成行.json', { type: 'application/json' }),
    );
    const res = await app.request('/api/import/preset', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const preset = (await res.json()) as {
      id: string;
      embeddedScripts?: { scope: string; ownerId: string; ownerName: string; count: number };
    };
    expect(preset.embeddedScripts).toEqual({
      scope: 'preset',
      ownerId: preset.id,
      ownerName: '双人成行',
      count: 2,
    });

    const rows = (await (
      await app.request(`/api/scripts?scope=preset&ownerId=${preset.id}`)
    ).json()) as ScriptRow[];
    expect(rows.map((row) => [row.name, row.enabled])).toEqual([
      ['预设对比助手', false],
      ['悬浮窗', false],
    ]);
    // 原件不动
    const stored = db.select().from(schema.presets).where(eq(schema.presets.id, preset.id)).get();
    expect((stored?.data as typeof PRESET).extensions.tavern_helper.scripts).toHaveLength(2);

    const enable = await app.request(
      '/api/scripts/owner-enabled',
      json('POST', { scope: 'preset', ownerId: preset.id, enabled: true }),
    );
    const enabled = (await enable.json()) as { changed: number; scripts: ScriptRow[] };
    expect(enabled.changed).toBe(1);
    expect(enabled.scripts.map((row) => row.enabled)).toEqual([true, false]);

    // 回填幂等：已经抽过的不再抽
    expect(backfillPresetScripts(db)).toBe(0);

    // 预设自带的 tavern_helper.variables → preset 作用域变量（酒馆助手 getVariables({type:'preset'}) 读的那份）
    const vars = (await (
      await app.request(`/api/variables/preset?ownerId=${preset.id}`)
    ).json()) as { variables: Record<string, unknown> };
    expect(vars.variables).toEqual({ st_tagfixer_preset: {} });
    // 脚本自己的变量表
    const [firstScript] = enabled.scripts;
    await app.request(
      '/api/variables/script',
      json('PUT', { ownerId: firstScript?.id, variables: { 开关: true } }),
    );

    const del = await app.request(`/api/presets/${preset.id}`, { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect(
      db.select().from(schema.scripts).where(eq(schema.scripts.ownerId, preset.id)).all(),
    ).toEqual([]);
    // 预设变量与它的脚本的变量表一起带走
    expect(
      db
        .select()
        .from(schema.variables)
        .all()
        .filter((row) => row.scope !== 'global'),
    ).toEqual([]);
  });

  it('回填：老库里没抽过的预设补抽（关闭），重复回填不重复', () => {
    const { db } = makeTestApp(dataDir);
    db.insert(schema.presets).values({ name: '老预设', format: 'st-openai', data: PRESET }).run();
    expect(backfillPresetScripts(db)).toBe(2);
    expect(backfillPresetScripts(db)).toBe(0);
    const rows = db.select().from(schema.scripts).all();
    expect(rows.every((row) => row.scope === 'preset' && !row.enabled)).toBe(true);
  });
});
