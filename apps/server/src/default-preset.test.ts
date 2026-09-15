import fs from 'node:fs';

import type { ModelCapabilities } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { assemblePrompt, DEFAULT_PRESET } from './services/assemble.js';
import { buildAssembleInput } from './services/assemble-input.js';
import {
  BUILTIN_PRESET_KEY,
  BUILTIN_PRESET_SEEDED_KEY,
  DEFAULT_PRESET_KEY,
  seedBuiltinPreset,
} from './services/presets.js';
import { makeTempDataDir, makeTestApp, type TestApp } from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body?: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

interface PresetJson {
  id: string;
  name: string;
  format: string;
  apiFamily: string | null;
  data: Record<string, unknown>;
  sampling: Record<string, unknown> | null;
}

function settingOf(db: Db, key: string): unknown {
  return db.select().from(schema.settings).where(eq(schema.settings.key, key)).get()?.value;
}

function presetCount(db: Db): number {
  return db.select().from(schema.presets).all().length;
}

async function createChat({ app }: TestApp, body: Record<string, unknown>) {
  const res = await app.request('/api/chats', json('POST', body));
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string; presetId: string | null };
}

describe('默认预设种子', () => {
  it('首次启动插入「默认预设」并设为默认；重复执行不重复插入', async () => {
    const t = makeTestApp(dataDir);
    const row = seedBuiltinPreset(t.db);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('默认预设');
    expect(row!.format).toBe(DEFAULT_PRESET.format);
    expect(row!.data).toEqual(DEFAULT_PRESET.data);
    expect(row!.data).not.toBe(DEFAULT_PRESET.data);
    expect(row!.sampling).toEqual({
      temperature: 1,
      openai_max_tokens: 4096,
      openai_max_context: 128000,
    });
    expect(settingOf(t.db, BUILTIN_PRESET_KEY)).toBe(row!.id);
    expect(settingOf(t.db, DEFAULT_PRESET_KEY)).toBe(row!.id);
    expect(settingOf(t.db, BUILTIN_PRESET_SEEDED_KEY)).toBe(true);

    expect(seedBuiltinPreset(t.db)).toBeNull();
    expect(seedBuiltinPreset(t.db)).toBeNull();
    expect(presetCount(t.db)).toBe(1);

    // 编辑器能用：GET 详情 + 原样 PUT 回去通过 parsePreset
    const detail = (await (await t.app.request(`/api/presets/${row!.id}`)).json()) as PresetJson;
    const put = await t.app.request(
      `/api/presets/${row!.id}`,
      json('PUT', { name: detail.name, data: detail.data }),
    );
    expect(put.status).toBe(200);
    expect(((await put.json()) as PresetJson).data).toEqual(DEFAULT_PRESET.data);
  });

  it('已有默认预设时不覆盖 defaultPresetId', async () => {
    const t = makeTestApp(dataDir);
    const mine = (await (
      await t.app.request('/api/presets', json('POST', { name: '我的' }))
    ).json()) as PresetJson;
    await t.app.request(`/api/settings/${DEFAULT_PRESET_KEY}`, json('PUT', mine.id));
    const row = seedBuiltinPreset(t.db);
    expect(row).not.toBeNull();
    expect(settingOf(t.db, DEFAULT_PRESET_KEY)).toBe(mine.id);
  });

  it('用户删掉默认预设后不再种回，相关设置被清掉', async () => {
    const t = makeTestApp(dataDir);
    const row = seedBuiltinPreset(t.db)!;
    const res = await t.app.request(`/api/presets/${row.id}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(settingOf(t.db, DEFAULT_PRESET_KEY)).toBeUndefined();
    expect(settingOf(t.db, BUILTIN_PRESET_KEY)).toBeUndefined();
    expect(settingOf(t.db, BUILTIN_PRESET_SEEDED_KEY)).toBe(true);

    expect(seedBuiltinPreset(t.db)).toBeNull();
    expect(presetCount(t.db)).toBe(0);
  });

  it('种子在同一事务里把 presetId 为空的会话改绑到默认预设，已选预设的会话不动', async () => {
    const t = makeTestApp(dataDir);
    const other = (await (
      await t.app.request('/api/presets', json('POST', {}))
    ).json()) as PresetJson;
    const empty = await createChat(t, { presetId: null });
    const bound = await createChat(t, { presetId: other.id });
    const before = t.db.select().from(schema.chats).where(eq(schema.chats.id, empty.id)).get()!;

    const row = seedBuiltinPreset(t.db)!;
    const chatOf = (id: string) =>
      t.db.select().from(schema.chats).where(eq(schema.chats.id, id)).get()!;
    expect(chatOf(empty.id).presetId).toBe(row.id);
    expect(chatOf(bound.id).presetId).toBe(other.id);
    // 迁移不刷新 updatedAt（会话列表顺序不变）
    expect(chatOf(empty.id).updatedAt.getTime()).toBe(before.updatedAt.getTime());

    // 之后显式选「无」的会话不会被再次改绑
    const later = await createChat(t, { presetId: null });
    seedBuiltinPreset(t.db);
    expect(chatOf(later.id).presetId).toBeNull();
  });
});

describe('默认预设设置', () => {
  it('POST /api/chats 缺省 presetId 时套用默认；显式 null 不用；删除默认预设清掉设置', async () => {
    const t = makeTestApp(dataDir);
    // 没有默认：null
    expect((await createChat(t, {})).presetId).toBeNull();

    const row = seedBuiltinPreset(t.db)!;
    expect((await createChat(t, {})).presetId).toBe(row.id);
    expect((await createChat(t, { presetId: null })).presetId).toBeNull();

    const other = (await (
      await t.app.request('/api/presets', json('POST', {}))
    ).json()) as PresetJson;
    expect((await createChat(t, { presetId: other.id })).presetId).toBe(other.id);

    // 删除非默认预设不影响设置
    await t.app.request(`/api/presets/${other.id}`, { method: 'DELETE' });
    expect(settingOf(t.db, DEFAULT_PRESET_KEY)).toBe(row.id);

    // 设置指向已不存在的行 → 当作没有
    await t.app.request(`/api/settings/${DEFAULT_PRESET_KEY}`, json('PUT', 'gone'));
    expect((await createChat(t, {})).presetId).toBeNull();
    await t.app.request(`/api/settings/${DEFAULT_PRESET_KEY}`, json('PUT', row.id));

    await t.app.request(`/api/presets/${row.id}`, { method: 'DELETE' });
    expect(settingOf(t.db, DEFAULT_PRESET_KEY)).toBeUndefined();
    expect((await createChat(t, {})).presetId).toBeNull();
  });
});

describe('新建 / 复制 / 恢复内置内容', () => {
  it('POST /api/presets：内置内容的深拷贝，名称缺省「新预设」', async () => {
    const t = makeTestApp(dataDir);
    const res = await t.app.request('/api/presets', json('POST', {}));
    expect(res.status).toBe(201);
    const row = (await res.json()) as PresetJson;
    expect(row.name).toBe('新预设');
    expect(row.format).toBe(DEFAULT_PRESET.format);
    expect(row.data).toEqual(DEFAULT_PRESET.data);

    const named = (await (
      await t.app.request('/api/presets', json('POST', { name: '  写作用 ', from: 'default' }))
    ).json()) as PresetJson;
    expect(named.name).toBe('写作用');

    // 无请求体也可以
    expect((await t.app.request('/api/presets', { method: 'POST' })).status).toBe(201);
    expect((await t.app.request('/api/presets', json('POST', { from: 'somewhere' }))).status).toBe(
      400,
    );
    expect((await t.app.request('/api/presets', json('POST', { name: 3 }))).status).toBe(400);
  });

  it('POST /:id/duplicate：复制 data / sampling / format / apiFamily，名称「<原名> 副本」', async () => {
    const t = makeTestApp(dataDir);
    const form = new FormData();
    const stPreset = {
      name: '夜雨',
      chat_completion_source: 'claude',
      temperature: 0.7,
      prompts: [{ identifier: 'main', name: 'Main', content: '你好' }],
    };
    form.append('file', new File([JSON.stringify(stPreset)], '夜雨.json'));
    const imported = (await (
      await t.app.request('/api/import/preset', { method: 'POST', body: form })
    ).json()) as { id: string };
    const source = (await (
      await t.app.request(`/api/presets/${imported.id}`)
    ).json()) as PresetJson;

    const res = await t.app.request(`/api/presets/${imported.id}/duplicate`, { method: 'POST' });
    expect(res.status).toBe(201);
    const copy = (await res.json()) as PresetJson;
    expect(copy.id).not.toBe(source.id);
    expect(copy.name).toBe('夜雨 副本');
    expect(copy.format).toBe(source.format);
    expect(copy.apiFamily).toBe('anthropic');
    expect(copy.sampling).toEqual(source.sampling);
    // data 自带 name 时与列一致，其余一样
    expect(copy.data).toEqual({ ...source.data, name: '夜雨 副本' });

    // 改副本不影响原件
    await t.app.request(
      `/api/presets/${copy.id}`,
      json('PUT', { data: { ...copy.data, temperature: 0.1 } }),
    );
    const again = (await (await t.app.request(`/api/presets/${source.id}`)).json()) as PresetJson;
    expect(again.data.temperature).toBe(0.7);

    expect((await t.app.request('/api/presets/nope/duplicate', { method: 'POST' })).status).toBe(
      404,
    );
  });

  it('POST /:id/reset-builtin：只对种子预设，data 恢复、名称不变；其它 id 返回 400', async () => {
    const t = makeTestApp(dataDir);
    const row = seedBuiltinPreset(t.db)!;
    const edited = structuredClone(row.data) as Record<string, unknown>;
    edited.temperature = 0.3;
    (edited.prompts as Record<string, unknown>[])[0]!.content = '改掉了';
    await t.app.request(`/api/presets/${row.id}`, json('PUT', { name: '我的默认', data: edited }));

    const res = await t.app.request(`/api/presets/${row.id}/reset-builtin`, { method: 'POST' });
    expect(res.status).toBe(200);
    const reset = (await res.json()) as PresetJson;
    expect(reset.name).toBe('我的默认');
    expect(reset.data).toEqual(DEFAULT_PRESET.data);
    expect(reset.sampling).toMatchObject({ temperature: 1 });

    const other = (await (
      await t.app.request('/api/presets', json('POST', {}))
    ).json()) as PresetJson;
    expect(
      (await t.app.request(`/api/presets/${other.id}/reset-builtin`, { method: 'POST' })).status,
    ).toBe(400);
    expect(
      (await t.app.request('/api/presets/nope/reset-builtin', { method: 'POST' })).status,
    ).toBe(404);
  });
});

describe('「无」预设的组装', () => {
  const caps = {
    maxContext: 8000,
    caching: 'none',
    systemInMessages: true,
    prefill: true,
  } as ModelCapabilities;

  it('presetId 为 null 或指向已删除的预设：没有主提示词，角色卡 / 用户描述 / 示例对话 / 历史照常', async () => {
    const t = makeTestApp(dataDir);
    const character = t.db
      .insert(schema.characters)
      .values({
        name: '艾拉',
        spec: 'v2',
        data: {
          name: '艾拉',
          description: '一位图书管理员。',
          scenario: '雨夜的图书馆。',
          mes_example: '<START>\n{{char}}: 请安静。',
        },
      })
      .returning()
      .get();
    const persona = (await (
      await t.app.request('/api/personas', json('POST', { name: '旅人', description: '冒险者。' }))
    ).json()) as { id: string };

    const assembleChat = (chatId: string) => {
      const chat = t.db.select().from(schema.chats).where(eq(schema.chats.id, chatId)).get()!;
      const input = buildAssembleInput(t.db, {
        chat,
        overrides: {},
        nodes: [],
        parentId: null,
        provider: 'openai-chat',
        model: 'm',
        layoutMode: 'strict',
        caps,
      });
      return { input, ir: assemblePrompt(input).ir };
    };
    const idsOf = (ir: { segments: { id: string }[] }) => ir.segments.map((s) => s.id);

    const none = await createChat(t, {
      characterIds: [character.id],
      personaId: persona.id,
      presetId: null,
    });
    const { input, ir } = assembleChat(none.id);
    expect(input.preset?.id).toBe('builtin:none');
    expect(ir.meta.presetId).toBe('builtin:none');
    expect(idsOf(ir)).not.toContain('preset:main');
    expect(idsOf(ir)).toEqual(
      expect.arrayContaining(['character:description', 'character:scenario', 'persona']),
    );
    expect(idsOf(ir).some((id) => id.startsWith('character:mes_example'))).toBe(true);
    expect(ir.sampling).toEqual({ temperature: 1 });

    // 对照：选了默认预设就有主提示词，其余段一致
    const row = seedBuiltinPreset(t.db)!;
    const withPreset = await createChat(t, {
      characterIds: [character.id],
      personaId: persona.id,
      presetId: row.id,
    });
    const withIds = idsOf(assembleChat(withPreset.id).ir);
    expect(withIds[0]).toBe('preset:main');
    expect(idsOf(ir)).toEqual(withIds.filter((id) => id !== 'preset:main'));

    // 预设被删除 → 同样按「无」
    await t.app.request(`/api/presets/${row.id}`, { method: 'DELETE' });
    expect(idsOf(assembleChat(withPreset.id).ir)).toEqual(idsOf(ir));
  });
});
