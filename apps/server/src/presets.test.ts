import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { makeTempDataDir, makeTestApp, type TestApp } from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const stPreset = {
  name: '原名',
  chat_completion_source: 'openai',
  temperature: 0.9,
  top_p: 1,
  openai_max_tokens: 800,
  unknown_top_level: { keep: [1, 2, 3] },
  prompts: [
    {
      identifier: 'main',
      name: 'Main Prompt',
      system_prompt: true,
      role: 'system',
      content: '扮演 {{char}}。',
      unknown_prompt_field: 'keep-me',
    },
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  ],
  prompt_order: [
    { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
    {
      character_id: 100001,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
  ],
};

type PresetRow = {
  id: string;
  name: string;
  apiFamily: string | null;
  data: Record<string, unknown>;
  sampling: Record<string, unknown> | null;
  updatedAt: string;
};

async function importPreset({ app }: TestApp, preset: unknown = stPreset): Promise<string> {
  const form = new FormData();
  form.append('file', new File([JSON.stringify(preset)], '测试预设.json'));
  const res = await app.request('/api/import/preset', { method: 'POST', body: form });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

function put({ app }: TestApp, id: string, body: unknown) {
  return app.request(`/api/presets/${id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

describe('PUT /api/presets/:id', () => {
  it('编辑往返：GET 详情与导出一致，未知字段保留，sampling 与 apiFamily 重算', async () => {
    const t = makeTestApp(dataDir);
    const id = await importPreset(t);
    const before = (await (await t.app.request(`/api/presets/${id}`)).json()) as PresetRow;

    const edited = structuredClone(stPreset) as typeof stPreset & Record<string, unknown>;
    edited.temperature = 0.4;
    edited.chat_completion_source = 'claude';
    edited.prompts[0]!.content = '改过的正文';
    const order = edited.prompt_order[1]!.order;
    order.reverse();
    order[0]!.enabled = false;

    const res = await put(t, id, { name: '  新名字 ', data: edited });
    expect(res.status).toBe(200);
    const row = (await res.json()) as PresetRow;
    expect(row.name).toBe('新名字');
    expect(row.apiFamily).toBe('anthropic');
    expect(row.sampling).toEqual({ temperature: 0.4, top_p: 1, openai_max_tokens: 800 });
    expect(new Date(row.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.updatedAt).getTime(),
    );

    const expected = { ...edited, name: '新名字' };
    const detail = (await (await t.app.request(`/api/presets/${id}`)).json()) as PresetRow;
    expect(detail.data).toEqual(expected);
    expect(detail.sampling).toEqual(row.sampling);
    expect(detail.data.unknown_top_level).toEqual({ keep: [1, 2, 3] });
    expect((detail.data.prompts as Record<string, unknown>[])[0]?.unknown_prompt_field).toBe(
      'keep-me',
    );

    const exported = await t.app.request(`/api/presets/${id}/export`);
    expect(await exported.json()).toEqual(expected);

    const list = (await (await t.app.request('/api/presets')).json()) as PresetRow[];
    expect(list[0]).toMatchObject({ id, name: '新名字', apiFamily: 'anthropic' });
  });

  it('data 里没有 name 字段时只改列，不凭空添加', async () => {
    const t = makeTestApp(dataDir);
    const { name: _omit, ...withoutName } = stPreset;
    const id = await importPreset(t, withoutName);
    const res = await put(t, id, { name: '只改列', data: withoutName });
    const row = (await res.json()) as PresetRow;
    expect(row.name).toBe('只改列');
    expect('name' in row.data).toBe(false);
  });

  it('删掉采样键后 sampling 同步去掉', async () => {
    const t = makeTestApp(dataDir);
    const id = await importPreset(t);
    const { top_p: _omit, ...data } = stPreset;
    const row = (await (await put(t, id, { data })).json()) as PresetRow;
    expect(row.name).toBe('原名');
    expect(row.sampling).toEqual({ temperature: 0.9, openai_max_tokens: 800 });
  });

  it('非法请求返回 400 与可读 message，库里数据不变', async () => {
    const t = makeTestApp(dataDir);
    const id = await importPreset(t);

    const badType = await put(t, id, { data: { ...stPreset, temperature: 'hot' } });
    expect(badType.status).toBe(400);
    expect(((await badType.json()) as { message: string }).message).toMatch(/temperature/);

    const badPrompt = await put(t, id, { data: { ...stPreset, prompts: [{ name: '无 id' }] } });
    expect(badPrompt.status).toBe(400);
    expect(((await badPrompt.json()) as { message: string }).message).toMatch(/identifier/);

    expect((await put(t, id, { data: [1, 2] })).status).toBe(400);
    expect((await put(t, id, { name: 'x' })).status).toBe(400);
    expect((await put(t, id, { name: '  ', data: stPreset })).status).toBe(400);
    expect((await put(t, id, 'not json')).status).toBe(400);
    expect((await put(t, 'nope', { data: stPreset })).status).toBe(404);

    const exported = await t.app.request(`/api/presets/${id}/export`);
    expect(await exported.json()).toEqual(stPreset);
  });
});
