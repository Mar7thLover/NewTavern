import fs from 'node:fs';

import type { ModelInfo } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { createSecrets } from './services/secrets.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
} from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Summary {
  id: string;
  provider: string;
  label: string;
  baseUrl: string;
  keyCount: number;
  keyHints: string[];
}

describe('connections', () => {
  it('CRUD：Key 不回显、hints 正确、加解密往返', async () => {
    const { app, db } = makeTestApp(dataDir);
    const keys = ['sk-aaaaaaaaaaaa1234', 'sk-bbbbbbbbbbbb5678'];
    const created = await app.request(
      '/api/connections',
      json({ provider: 'anthropic', label: 'Claude', apiKeys: keys }),
    );
    expect(created.status).toBe(201);
    const body = (await created.json()) as Summary & Record<string, unknown>;
    expect(body).toMatchObject({ provider: 'anthropic', label: 'Claude', keyCount: 2 });
    expect(body.keyHints).toEqual(['1234', '5678']);
    // 默认 baseUrl
    expect(body.baseUrl).toBe('https://api.anthropic.com');
    // 对外永不返回明文 Key
    expect('apiKeys' in body).toBe(false);
    expect('keysEnc' in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain('sk-aaaa');

    // 加解密往返：库里存的是密文，用同一个主密钥能解回原文
    const row = db
      .select()
      .from(schema.connections)
      .where(eq(schema.connections.id, body.id))
      .get();
    expect(row?.keysEnc).toMatch(/^v1:[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(createSecrets(dataDir).decryptJson(row?.keysEnc ?? '')).toEqual(keys);

    const list = (await (await app.request('/api/connections')).json()) as Summary[];
    expect(list).toHaveLength(1);
    expect(list[0]?.keyCount).toBe(2);

    const detail = (await (await app.request(`/api/connections/${body.id}`)).json()) as Summary;
    expect(detail.id).toBe(body.id);

    // PUT 不传 apiKeys → 不变
    const renamed = (await (
      await app.request(`/api/connections/${body.id}`, {
        ...json({ label: '改个名' }),
        method: 'PUT',
      })
    ).json()) as Summary;
    expect(renamed).toMatchObject({ label: '改个名', keyCount: 2 });

    // PUT apiKeys: [] → 清空
    const cleared = (await (
      await app.request(`/api/connections/${body.id}`, {
        ...json({ apiKeys: [] }),
        method: 'PUT',
      })
    ).json()) as Summary;
    expect(cleared).toMatchObject({ keyCount: 0, keyHints: [] });

    expect((await app.request(`/api/connections/${body.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect((await app.request(`/api/connections/${body.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );
  });

  it('provider 非法与缺失返回 400', async () => {
    const { app } = makeTestApp(dataDir);
    expect((await app.request('/api/connections', json({ label: 'x' }))).status).toBe(400);
    const bad = await app.request('/api/connections', json({ provider: 'ollama', label: 'x' }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid');
  });

  it('/models 走 model_cache，refresh=1 强刷；/test 与 /capabilities 走适配器', async () => {
    const { app, db } = makeTestApp(dataDir);
    let calls = 0;
    registerFakeAdapter({
      id: 'fake-models',
      listModels: () => {
        calls += 1;
        return Promise.resolve([{ id: `model-${calls}` }] satisfies ModelInfo[]);
      },
    });
    const conn = insertConnection(db, dataDir, 'fake-models');

    const first = (await (await app.request(`/api/connections/${conn.id}/models`)).json()) as {
      models: ModelInfo[];
      source: string;
      fetchedAt: string | null;
    };
    expect(first.source).toBe('remote');
    expect(first.models[0]?.id).toBe('model-1');
    expect(first.fetchedAt).toBeTruthy();

    const cached = (await (await app.request(`/api/connections/${conn.id}/models`)).json()) as {
      models: ModelInfo[];
      source: string;
    };
    expect(cached.source).toBe('cache');
    expect(cached.models[0]?.id).toBe('model-1');
    expect(calls).toBe(1);

    const refreshed = (await (
      await app.request(`/api/connections/${conn.id}/models?refresh=1`)
    ).json()) as { models: ModelInfo[]; source: string };
    expect(refreshed.source).toBe('remote');
    expect(refreshed.models[0]?.id).toBe('model-2');

    const test = await app.request(`/api/connections/${conn.id}/test`, { method: 'POST' });
    expect(test.status).toBe(200);
    const testBody = (await test.json()) as { ok: boolean; modelCount: number; latencyMs: number };
    expect(testBody.ok).toBe(true);
    expect(testBody.modelCount).toBe(1);
    expect(typeof testBody.latencyMs).toBe('number');

    const caps = await app.request(`/api/connections/${conn.id}/capabilities?model=model-1`);
    expect(caps.status).toBe(200);
    expect((await caps.json()) as Record<string, unknown>).toMatchObject({ thinking: 'none' });
    expect((await app.request(`/api/connections/${conn.id}/capabilities`)).status).toBe(400);
  });

  it('适配器未注册时 /models 返回 502 provider_error，/test 返回 400', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'nope-adapter');
    const models = await app.request(`/api/connections/${conn.id}/models`);
    expect(models.status).toBe(502);
    expect((await models.json()) as { error: string }).toMatchObject({ error: 'provider_error' });
    const test = await app.request(`/api/connections/${conn.id}/test`, { method: 'POST' });
    expect(test.status).toBe(400);
    expect(((await test.json()) as { error: string }).error).toBe('provider_error');
    expect((await app.request('/api/connections/nope/models')).status).toBe(404);
  });

  it('GET /api/models/catalog 返回目录条目', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await app.request('/api/models/catalog');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models: unknown[]; version: number };
    expect(Array.isArray(body.models)).toBe(true);
    expect(typeof body.version).toBe('number');
  });
});
