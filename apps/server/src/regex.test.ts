import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import type { RegexScript } from './services/regex-map.js';
import { backfillEmbeddedRegex } from './services/backfill.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/** 正则脚本 CRUD / 排序 / ST 导入 / 卡内嵌脚本。见 docs/M3-CONTRACT.md §3.2、§3.7。 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const stScripts = [
  {
    id: 'st-uuid-1',
    scriptName: '去除星号',
    findRegex: '/\\*(.+?)\\*/g',
    replaceString: '$1',
    trimStrings: ['  '],
    placement: [2],
    disabled: false,
    markdownOnly: true,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: 2,
  },
  {
    scriptName: '提示词侧替换',
    findRegex: '{{user}}',
    replaceString: '旅人',
    placement: [1, 2],
    promptOnly: true,
    substituteRegex: true,
  },
];

describe('正则脚本', () => {
  it('CRUD：promptOnly/markdownOnly ↔ direction 双向映射，默认值齐备', async () => {
    const { app, db } = makeTestApp(dataDir);
    expect(await (await app.request('/api/regex')).json()).toEqual([]);

    const created = await app.request(
      '/api/regex',
      json('POST', { name: '脚本一', findRegex: '/a/g', replaceString: 'b', promptOnly: true }),
    );
    expect(created.status).toBe(201);
    const script = (await created.json()) as RegexScript;
    expect(script).toMatchObject({
      name: '脚本一',
      findRegex: '/a/g',
      replaceString: 'b',
      trimStrings: [],
      placement: [],
      disabled: false,
      promptOnly: true,
      markdownOnly: false,
      runOnEdit: false,
      substituteRegex: 0,
      minDepth: null,
      maxDepth: null,
      scope: 'global',
    });
    // DB 侧只有 direction 一列
    expect(db.select().from(schema.regexScripts).all()[0]).toMatchObject({
      direction: 'prompt',
      scriptName: '脚本一',
      displayOrder: 0,
    });

    const updated = (await (
      await app.request(
        `/api/regex/${script.id}`,
        json('PUT', { promptOnly: false, markdownOnly: true, placement: [2], maxDepth: 3 }),
      )
    ).json()) as RegexScript;
    expect(updated).toMatchObject({
      promptOnly: false,
      markdownOnly: true,
      placement: [2],
      maxDepth: 3,
      name: '脚本一',
    });

    // 两者都关 → both
    const both = (await (
      await app.request(`/api/regex/${script.id}`, json('PUT', { markdownOnly: false }))
    ).json()) as RegexScript;
    expect(both).toMatchObject({ promptOnly: false, markdownOnly: false });

    expect((await app.request(`/api/regex/${script.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/regex/${script.id}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request(`/api/regex/${script.id}`, json('PUT', { name: 'x' }))).status).toBe(
      404,
    );
  });

  it('校验非法字段返回 400 中文 message', async () => {
    const { app } = makeTestApp(dataDir);
    for (const body of [
      { findRegex: '/a/' },
      { name: '', findRegex: '/a/' },
      { name: 'x' },
      { name: 'x', findRegex: '/a/', placement: ['1'] },
      { name: 'x', findRegex: '/a/', substituteRegex: 3 },
      { name: 'x', findRegex: '/a/', disabled: 'yes' },
      { name: 'x', findRegex: '/a/', minDepth: 'deep' },
    ]) {
      const res = await app.request('/api/regex', json('POST', body));
      expect(res.status).toBe(400);
      expect(typeof ((await res.json()) as { message: string }).message).toBe('string');
    }
    expect((await app.request('/api/regex/order', json('PUT', { ids: 'nope' }))).status).toBe(400);
  });

  it('PUT /api/regex/order 按 ids 重排 display_order', async () => {
    const { app } = makeTestApp(dataDir);
    const names = ['一', '二', '三'];
    const ids: string[] = [];
    for (const name of names) {
      const row = (await (
        await app.request('/api/regex', json('POST', { name, findRegex: '/x/' }))
      ).json()) as RegexScript;
      ids.push(row.id);
    }
    expect(
      ((await (await app.request('/api/regex')).json()) as RegexScript[]).map((s) => s.name),
    ).toEqual(names);

    const reordered = (await (
      await app.request('/api/regex/order', json('PUT', { ids: [ids[2], ids[0], ids[1]] }))
    ).json()) as RegexScript[];
    expect(reordered.map((s) => s.name)).toEqual(['三', '一', '二']);
    expect(
      ((await (await app.request('/api/regex')).json()) as RegexScript[]).map((s) => s.name),
    ).toEqual(['三', '一', '二']);
  });

  it('POST /api/import/regex：ST 数组与单条 JSON 都能导入', async () => {
    const { app } = makeTestApp(dataDir);
    const form = new FormData();
    form.append('file', new File([JSON.stringify(stScripts)], 'scripts.json'));
    const res = await app.request('/api/import/regex', { method: 'POST', body: form });
    expect(res.status).toBe(201);
    const created = (await res.json()) as RegexScript[];
    expect(created).toHaveLength(2);
    expect(created[0]).toMatchObject({
      name: '去除星号',
      findRegex: '/\\*(.+?)\\*/g',
      replaceString: '$1',
      trimStrings: ['  '],
      placement: [2],
      markdownOnly: true,
      promptOnly: false,
      runOnEdit: true,
      maxDepth: 2,
      minDepth: null,
      scope: 'global',
    });
    // substituteRegex 旧版布尔 true → 1
    expect(created[1]).toMatchObject({ promptOnly: true, markdownOnly: false, substituteRegex: 1 });

    const single = new FormData();
    single.append(
      'file',
      new File([JSON.stringify({ scriptName: '单条', findRegex: '/z/' })], 'one.json'),
    );
    const one = await app.request('/api/import/regex', { method: 'POST', body: single });
    expect(one.status).toBe(201);
    expect((await one.json()) as RegexScript[]).toHaveLength(1);

    // display_order 接着排
    const list = (await (await app.request('/api/regex')).json()) as RegexScript[];
    expect(list.map((s) => s.name)).toEqual(['去除星号', '提示词侧替换', '单条']);

    const bad = new FormData();
    bad.append('file', new File(['not json'], 'bad.json'));
    const badRes = await app.request('/api/import/regex', { method: 'POST', body: bad });
    expect(badRes.status).toBe(400);
    expect(((await badRes.json()) as { message: string }).message).toMatch(/JSON/);
  });

  it('GET /api/characters/:id/regex：卡自带的正则（抽表之后）', async () => {
    const { app, db } = makeTestApp(dataDir);
    const character = db
      .insert(schema.characters)
      .values({
        name: '艾拉',
        spec: 'v2',
        data: {
          name: '艾拉',
          extensions: {
            regex_scripts: [stScripts[0], { scriptName: '缺少 findRegex' }, stScripts[1]],
          },
        },
      })
      .returning()
      .get();

    // 自带正则在**导入时**抽表；这里是直接插的行，先补一次回填（§3.2 修正）
    expect(
      ((await (await app.request(`/api/characters/${character.id}/regex`)).json()) as RegexScript[])
        .length,
    ).toBe(0);
    backfillEmbeddedRegex(db);

    const scripts = (await (
      await app.request(`/api/characters/${character.id}/regex`)
    ).json()) as RegexScript[];
    // 非法项被跳过
    expect(scripts).toHaveLength(2);
    expect(scripts[0]).toMatchObject({ name: '去除星号', scope: 'character', markdownOnly: true });
    expect(scripts[1]?.name).toBe('提示词侧替换');
    // 现在落表了，但不会混进「我自己的脚本」（GET /api/regex 只给 global）
    expect(db.select().from(schema.regexScripts).all()).toHaveLength(2);
    expect((await (await app.request('/api/regex')).json()) as RegexScript[]).toHaveLength(0);

    expect((await app.request('/api/characters/nope/regex')).status).toBe(404);
  });
});
