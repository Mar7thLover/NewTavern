import fs from 'node:fs';

import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { repairGenerationDefault } from './services/generation-context.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
} from './test-helpers.js';

/*
 * 全局默认连接 / 模型（settings `generation.default`）记住「上次使用的」：
 * 生成成功发起、会话里选定连接 + 模型时写入；默认连接被删时改用最近对话用过的。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

registerFakeAdapter({
  id: 'fake-default',
  events: [
    { type: 'text.delta', text: '好' },
    { type: 'stop', reason: 'end' },
  ],
});

const send = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

function readDefault(db: Db): unknown {
  return (
    db.select().from(schema.settings).where(eq(schema.settings.key, 'generation.default')).get()
      ?.value ?? null
  );
}

describe('generation.default 记住上次使用的连接与模型', () => {
  it('会话覆盖了连接 + 模型并生成后，成为新的全局默认', async () => {
    const { app, db } = makeTestApp(dataDir);
    const a = insertConnection(db, dataDir, 'fake-default', undefined, 'A');
    const b = insertConnection(db, dataDir, 'fake-default', undefined, 'B');
    await app.request(
      '/api/settings/generation.default',
      send('PUT', { connectionId: a.id, model: 'model-a' }),
    );
    const chat = (await (await app.request('/api/chats', send('POST', {}))).json()) as {
      id: string;
    };
    db.update(schema.chats)
      .set({ overrides: { connectionId: b.id, model: 'model-b' } })
      .where(eq(schema.chats.id, chat.id))
      .run();

    const res = await app.request(
      `/api/chats/${chat.id}/generate`,
      send('POST', { userMessage: { text: '你好' } }),
    );
    expect(res.status).toBe(200);
    await res.text();
    expect(readDefault(db)).toEqual({ connectionId: b.id, model: 'model-b' });
  });

  it('在会话里选定连接 + 模型（PATCH overrides）即记住；只选连接不写', async () => {
    const { app, db } = makeTestApp(dataDir);
    const a = insertConnection(db, dataDir, 'fake-default');
    const chat = (await (await app.request('/api/chats', send('POST', {}))).json()) as {
      id: string;
    };

    await app.request(
      `/api/chats/${chat.id}`,
      send('PATCH', { overrides: { connectionId: a.id, model: null } }),
    );
    expect(readDefault(db)).toBeNull();

    await app.request(
      `/api/chats/${chat.id}`,
      send('PATCH', { overrides: { connectionId: a.id, model: 'picked' } }),
    );
    expect(readDefault(db)).toEqual({ connectionId: a.id, model: 'picked' });
  });

  it('删除默认连接：改用最近对话用过的连接与模型；没有就清掉', async () => {
    const { app, db } = makeTestApp(dataDir);
    const gone = insertConnection(db, dataDir, 'fake-default', undefined, '要删的');
    const kept = insertConnection(db, dataDir, 'fake-default', undefined, '留下的');
    const chat = (await (await app.request('/api/chats', send('POST', {}))).json()) as {
      id: string;
    };
    await app.request(
      `/api/chats/${chat.id}`,
      send('PATCH', { overrides: { connectionId: kept.id, model: 'kept-model' } }),
    );
    await app.request(
      '/api/settings/generation.default',
      send('PUT', { connectionId: gone.id, model: 'gone-model' }),
    );

    expect((await app.request(`/api/connections/${gone.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(readDefault(db)).toEqual({ connectionId: kept.id, model: 'kept-model' });

    // 最近对话也没有可用的连接 → 默认被清掉，不再显示已删除连接的模型
    expect((await app.request(`/api/connections/${kept.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );
    expect(readDefault(db)).toBeNull();
    const setting = await app.request('/api/settings/generation.default');
    expect(setting.status).toBe(404);
  });

  it('启动修复：老库里默认指向不存在的连接（幂等）', () => {
    const { db } = makeTestApp(dataDir);
    const live = insertConnection(db, dataDir, 'fake-default');
    db.insert(schema.settings)
      .values({
        key: 'generation.default',
        value: { connectionId: 'deleted-long-ago', model: 'stale.gguf' },
        updatedAt: new Date(),
      })
      .run();
    db.insert(schema.chats)
      .values({ title: '旧对话', overrides: { connectionId: live.id, model: 'live-model' } })
      .run();

    repairGenerationDefault(db);
    expect(readDefault(db)).toEqual({ connectionId: live.id, model: 'live-model' });
    repairGenerationDefault(db);
    expect(readDefault(db)).toEqual({ connectionId: live.id, model: 'live-model' });
  });
});
