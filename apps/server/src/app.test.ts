import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseCardJson,
  readCardFromPng,
  readCharx,
  readPngTextChunks,
  writeCardToPng,
} from '@newtavern/compat';
import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

const tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-app-test-'));
afterAll(() => fs.rmSync(tmpDataDir, { recursive: true, force: true }));

type App = ReturnType<typeof createApp>;

function makeApp() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return createApp({ db, dataDir: tmpDataDir });
}

const encodeText = (text: string) => new TextEncoder().encode(text);
const encodeJson = (value: unknown) => encodeText(JSON.stringify(value));

function upload(app: App, url: string, fileName: string, bytes: Uint8Array) {
  const form = new FormData();
  form.append('file', new File([bytes.slice()], fileName));
  return app.request(url, { method: 'POST', body: form });
}

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
    extensions: { world: '王国' },
    character_book: {
      entries: [{ keys: ['麦酒'], content: '招牌麦酒', enabled: true, insertion_order: 100 }],
    },
  },
};

const stPreset = {
  chat_completion_source: 'openai',
  temperature: 0.9,
  openai_max_context: 128000,
  unknown_setting: [1, 2],
  prompts: [
    { identifier: 'main', name: 'Main Prompt', role: 'system', content: '扮演 {{char}}。' },
  ],
  prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
};

const stWorldbook = {
  entries: {
    '0': {
      uid: 0,
      key: ['城堡'],
      keysecondary: [],
      comment: '王城',
      content: '城堡坐落在山顶。',
      constant: true,
      selective: true,
      order: 100,
      position: 0,
      disable: false,
      probability: 100,
      useProbability: true,
      depth: 4,
      scanDepth: null,
      role: null,
      displayIndex: 0,
    },
    '5': {
      uid: 5,
      key: ['国王', '陛下'],
      keysecondary: ['王座'],
      comment: '',
      content: '国王年迈。',
      constant: false,
      order: 50,
      position: 4,
      disable: true,
      depth: 2,
      role: 2,
      sticky: 3,
      displayIndex: 1,
      characterFilter: { isExclude: false, names: [], tags: [] },
    },
  },
};

describe('api', () => {
  it('GET /api/health 返回 ok', async () => {
    const app = makeApp();
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; name: string };
    expect(body.ok).toBe(true);
    expect(body.name).toBe('newtavern');
  });

  it('settings 读写删往返', async () => {
    const app = makeApp();
    const put = await app.request('/api/settings/theme', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'dark' }),
    });
    expect(put.status).toBe(200);

    const got = await app.request('/api/settings/theme');
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ key: 'theme', value: { mode: 'dark' } });

    const list = await app.request('/api/settings');
    expect(await list.json()).toEqual({ theme: { mode: 'dark' } });

    const del = await app.request('/api/settings/theme', { method: 'DELETE' });
    expect(del.status).toBe(204);
    expect((await app.request('/api/settings/theme')).status).toBe(404);
  });

  it('personas CRUD', async () => {
    const app = makeApp();
    const created = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '测试用户', description: '一个冒险者。' }),
    });
    expect(created.status).toBe(201);
    const persona = (await created.json()) as { id: string; name: string };

    const bad = await app.request('/api/personas', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '缺名字' }),
    });
    expect(bad.status).toBe(400);

    const updated = await app.request(`/api/personas/${persona.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '一个吟游诗人。' }),
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { description: string }).description).toBe('一个吟游诗人。');

    const list = await app.request('/api/personas');
    expect(((await list.json()) as unknown[]).length).toBe(1);

    expect((await app.request(`/api/personas/${persona.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await app.request(`/api/personas/${persona.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('JSON 角色卡导入 → 列表 → 导出原件与重建 PNG', async () => {
    const app = makeApp();
    const res = await upload(app, '/api/import/character', '艾拉.json', encodeJson(v2Card));
    expect(res.status).toBe(201);
    const summary = (await res.json()) as {
      id: string;
      name: string;
      spec: string;
      tags: string[];
    };
    expect(summary).toMatchObject({ name: '艾拉', spec: 'v2', tags: ['奇幻'] });
    expect('data' in summary).toBe(false);

    const list = (await (await app.request('/api/characters')).json()) as unknown[];
    expect(list).toHaveLength(1);
    const detail = (await (await app.request(`/api/characters/${summary.id}`)).json()) as {
      data: { name: string; group_only_greetings: string[] };
    };
    expect(detail.data.name).toBe('艾拉');
    expect(detail.data.group_only_greetings).toEqual([]);

    const json = await app.request(`/api/characters/${summary.id}/export?format=json`);
    expect(json.status).toBe(200);
    expect(await json.json()).toEqual(v2Card);

    const png = await app.request(`/api/characters/${summary.id}/export?format=png`);
    expect(png.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('艾拉.png')}`,
    );
    const back = readCardFromPng(new Uint8Array(await png.arrayBuffer()));
    expect(back.spec).toBe('v3');
    expect(back.data.name).toBe('艾拉');

    const bad = await app.request(`/api/characters/${summary.id}/export?format=gif`);
    expect(bad.status).toBe(400);
  });

  it('PNG 角色卡导入：头像入资产，PNG 导出原件，CHARX 带图标', async () => {
    const app = makeApp();
    const png = writeCardToPng(null, parseCardJson(v2Card));
    const res = await upload(app, '/api/import/character', 'ella.png', png);
    expect(res.status).toBe(201);
    const { id, avatarAssetId } = (await res.json()) as { id: string; avatarAssetId: string };
    expect(avatarAssetId).toBeTruthy();

    const avatar = await app.request(`/api/assets/${avatarAssetId}/file`);
    expect(avatar.headers.get('content-type')).toBe('image/png');
    expect(readPngTextChunks(new Uint8Array(await avatar.arrayBuffer())).has('ccv3')).toBe(false);

    const exported = await app.request(`/api/characters/${id}/export?format=png`);
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(png);

    const charx = await app.request(`/api/characters/${id}/export?format=charx`);
    const { card, files } = readCharx(new Uint8Array(await charx.arrayBuffer()));
    expect(card.data.name).toBe('艾拉');
    expect(card.data.assets).toContainEqual({
      type: 'icon',
      uri: 'embeded://assets/icon/images/main.png',
      name: 'main',
      ext: 'png',
    });
    expect(files.has('assets/icon/images/main.png')).toBe(true);
  });

  it('预设导入 → 导出 deep-equal', async () => {
    const app = makeApp();
    const res = await upload(app, '/api/import/preset', '我的预设.json', encodeJson(stPreset));
    expect(res.status).toBe(201);
    const summary = (await res.json()) as Record<string, unknown>;
    expect(summary).toMatchObject({
      name: '我的预设',
      format: 'st-openai',
      apiFamily: 'openai-chat',
    });
    expect('data' in summary).toBe(false);

    const exported = await app.request(`/api/presets/${summary.id as string}/export`);
    expect(await exported.json()).toEqual(stPreset);
  });

  it('世界书导入 → 条目 → 导出 deep-equal', async () => {
    const app = makeApp();
    const res = await upload(app, '/api/import/lorebook', '王国.json', encodeJson(stWorldbook));
    expect(res.status).toBe(201);
    const book = (await res.json()) as { id: string; name: string; entryCount: number };
    expect(book).toMatchObject({ name: '王国', entryCount: 2 });

    const list = (await (await app.request('/api/lorebooks')).json()) as { entryCount: number }[];
    expect(list[0]?.entryCount).toBe(2);
    const detail = (await (await app.request(`/api/lorebooks/${book.id}`)).json()) as {
      entries: { keys: string[]; disabled: boolean; role: string | null }[];
    };
    expect(detail.entries.map((e) => e.keys)).toEqual([['城堡'], ['国王', '陛下']]);
    expect(detail.entries[1]).toMatchObject({ disabled: true, role: 'assistant' });

    const exported = await app.request(`/api/lorebooks/${book.id}/export`);
    expect(await exported.json()).toEqual(stWorldbook);
  });

  it('导入非法文件返回 400 与中文 message', async () => {
    const app = makeApp();
    const notJson = await upload(app, '/api/import/character', 'x.json', encodeText('not json'));
    expect(notJson.status).toBe(400);
    expect(((await notJson.json()) as { message: string }).message).toMatch(/JSON/);

    const noName = await upload(app, '/api/import/character', 'x.json', encodeJson({ foo: 1 }));
    expect(((await noName.json()) as { message: string }).message).toMatch(/缺少 name/);

    const noFile = await app.request('/api/import/preset', {
      method: 'POST',
      body: new FormData(),
    });
    expect(noFile.status).toBe(400);

    expect((await app.request('/api/presets/nope/export')).status).toBe(404);
  });

  it('未知 /api 路径返回 404 json', async () => {
    const app = makeApp();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
