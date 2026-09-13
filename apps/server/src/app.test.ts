import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';

function makeApp() {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return createApp({ db });
}

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

  it('未知 /api 路径返回 404 json', async () => {
    const app = makeApp();
    const res = await app.request('/api/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
