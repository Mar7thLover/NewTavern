import fs from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Db } from './db/client.js';
import { createAssetsRoutes } from './routes/assets.js';
import { createCharactersRoutes } from './routes/characters.js';
import { createImportRoutes } from './routes/import.js';
import { createLorebooksRoutes } from './routes/lorebooks.js';
import { createPersonasRoutes } from './routes/personas.js';
import { createPresetsRoutes } from './routes/presets.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createAssetsService } from './services/assets.js';
import { createImporter } from './services/importer.js';

export interface AppOptions {
  db: Db;
  /** 数据目录（assets/ 等二进制落盘处） */
  dataDir: string;
  /** 前端构建产物目录；提供时静态托管并做 SPA 回退 */
  webDist?: string;
}

export function createApp({ db, dataDir, webDist }: AppOptions) {
  const app = new Hono();
  const assets = createAssetsService(db, dataDir);
  const importer = createImporter(db, assets, dataDir);

  app.use('/api/*', logger());
  app.use('/api/*', cors());

  const api = new Hono()
    .get('/health', (c) => c.json({ ok: true, name: 'newtavern', time: new Date().toISOString() }))
    .route('/settings', createSettingsRoutes(db))
    .route('/personas', createPersonasRoutes(db))
    .route('/characters', createCharactersRoutes(db, importer))
    .route('/presets', createPresetsRoutes(db, importer))
    .route('/lorebooks', createLorebooksRoutes(db, importer))
    .route('/import', createImportRoutes(importer))
    .route('/assets', createAssetsRoutes(assets));

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
