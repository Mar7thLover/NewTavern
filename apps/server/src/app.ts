import fs from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Db } from './db/client.js';
import { createSettingsRoutes } from './routes/settings.js';

export interface AppOptions {
  db: Db;
  /** 前端构建产物目录；提供时静态托管并做 SPA 回退 */
  webDist?: string;
}

export function createApp({ db, webDist }: AppOptions) {
  const app = new Hono();

  app.use('/api/*', logger());
  app.use('/api/*', cors());

  const api = new Hono()
    .get('/health', (c) => c.json({ ok: true, name: 'newtavern', time: new Date().toISOString() }))
    .route('/settings', createSettingsRoutes(db));

  app.route('/api', api);

  if (webDist && fs.existsSync(webDist)) {
    app.use('/*', serveStatic({ root: webDist }));
  }

  app.notFound((c) => {
    if (c.req.path.startsWith('/api/')) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (webDist) {
      const indexHtml = path.join(webDist, 'index.html');
      if (fs.existsSync(indexHtml)) {
        return c.html(fs.readFileSync(indexHtml, 'utf8'));
      }
    }
    return c.text('Not Found', 404);
  });

  return app;
}

/** hc 类型化客户端用的路由类型（M2 起用于前端） */
export type AppType = ReturnType<typeof createApp>;
