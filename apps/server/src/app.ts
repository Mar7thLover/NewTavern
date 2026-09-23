import fs from 'node:fs';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import type { Db } from './db/client.js';
import { createAssetsRoutes } from './routes/assets.js';
import { createBackgroundsRoutes } from './routes/backgrounds.js';
import { createCharactersRoutes } from './routes/characters.js';
import { createChatTransferRoutes } from './routes/chat-transfer.js';
import { createChatsRoutes } from './routes/chats.js';
import { createConnectionsRoutes } from './routes/connections.js';
import { createImagineRoutes, createJobsRoutes } from './routes/imagine.js';
import { createImportRoutes } from './routes/import.js';
import { createInspectRoutes } from './routes/inspect.js';
import { createLorebooksRoutes } from './routes/lorebooks.js';
import { createMigrationRoutes } from './routes/migration.js';
import { createModelsRoutes } from './routes/models.js';
import { createPersonasRoutes } from './routes/personas.js';
import { createPresetsRoutes } from './routes/presets.js';
import { createPromptLibraryRoutes } from './routes/prompt-library.js';
import { createRegexRoutes } from './routes/regex.js';
import { createSandboxRoutes } from './routes/sandbox.js';
import { createScriptsRoutes } from './routes/scripts.js';
import { createSettingsRoutes } from './routes/settings.js';
import { createExpressionRoutes, createSpritesRoutes } from './routes/sprites.js';
import { createStudioRoutes } from './routes/studio.js';
import { createChatVariablesRoutes, createVariablesRoutes } from './routes/variables.js';
import { createVersionsRoutes } from './routes/versions.js';
import { createWritingRoutes } from './routes/writing.js';
import { createAssetsService } from './services/assets.js';
import { createImporter } from './services/importer.js';
import { configureMvuExtra } from './services/mvu-extra.js';
import { createProviderService, ensureBuiltinAdapters } from './services/providers.js';
import { createSecrets } from './services/secrets.js';

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
  const secrets = createSecrets(dataDir);
  const providers = createProviderService(db, secrets);
  // 内置适配器由 packages/providers 注册；未就绪时静默跳过（契约 §5 [S→P]）
  void ensureBuiltinAdapters();
  // MVU 额外模型解析在 chats 路由里触发，那里拿不到 dataDir（M5（三）§3.5）
  configureMvuExtra({ dataDir, providers });

  app.use('/api/*', logger());
  app.use('/api/*', cors());

  const api = new Hono()
    .get('/health', (c) => c.json({ ok: true, name: 'newtavern', time: new Date().toISOString() }))
    .route('/settings', createSettingsRoutes(db))
    .route('/personas', createPersonasRoutes(db, assets))
    .route('/characters', createCharactersRoutes(db, importer, assets))
    // 立绘（M4（二）§B）：独立文件，第二次挂到 /characters
    .route('/characters', createSpritesRoutes(db, assets))
    .route('/backgrounds', createBackgroundsRoutes(db, assets))
    .route('/presets', createPresetsRoutes(db, importer))
    .route('/lorebooks', createLorebooksRoutes(db, importer))
    .route('/regex', createRegexRoutes(db))
    // 酒馆助手脚本库（M5（三）§2）
    .route('/scripts', createScriptsRoutes(db))
    .route('/import', createImportRoutes(importer))
    .route('/assets', createAssetsRoutes(db, assets))
    .route('/connections', createConnectionsRoutes(db, secrets, providers))
    .route('/chats', createChatsRoutes(db, providers, assets))
    // 聊天导出为 ST jsonl（M4 §2.2）：独立文件，第二次挂到 /chats
    .route('/chats', createChatTransferRoutes(db))
    // 变量与 MVU（M5 §3.4）、前端卡的 generate（M5 §4.6）：同样挂在 /chats 下
    .route('/chats', createChatVariablesRoutes(db))
    .route('/chats', createSandboxRoutes(db, providers, assets))
    // 立绘表情选择（M4（二）§B.2）
    .route('/chats', createExpressionRoutes(db, dataDir, providers))
    // 外接生图（M4（二）§D）：`POST /chats/:id/imagine` 与 `GET /jobs/:id`
    .route('/chats', createImagineRoutes(db, dataDir, providers, assets))
    .route('/jobs', createJobsRoutes(db))
    .route('/variables', createVariablesRoutes(db))
    .route('/migration', createMigrationRoutes(db, assets, importer))
    .route('/inspect', createInspectRoutes(db, providers))
    // 长篇写作（M7 §3）
    .route('/writing', createWritingRoutes(db, dataDir))
    // 创作工作台（M6 §2）：版本历史、提示库、测试会话
    .route('/versions', createVersionsRoutes(db))
    .route('/prompt-library', createPromptLibraryRoutes(db))
    .route('/studio', createStudioRoutes(db))
    .route('/models', createModelsRoutes());

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
