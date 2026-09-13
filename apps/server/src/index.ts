import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { dataDir, dbPath, host, port, webDist } from './env.js';

const db = createDatabase(dbPath);
runMigrations(db);

const app = createApp({ db, dataDir, webDist });

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(
    `[newtavern] 服务端已启动：http://localhost:${info.port}（绑定 ${host}，局域网可访问）`,
  );
  console.log(`[newtavern] 数据目录：${dbPath}`);
});
