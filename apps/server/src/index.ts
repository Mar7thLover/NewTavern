import { serve } from '@hono/node-server';

import { createApp } from './app.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { dataDir, dbPath, host, port, webDist } from './env.js';
import {
  backfillCharacterBooks,
  backfillEmbeddedRegex,
  backfillPresetScriptRows,
} from './services/backfill.js';
import { repairGenerationDefault } from './services/generation-context.js';
import { seedBuiltinPreset } from './services/presets.js';

const db = createDatabase(dbPath);
runMigrations(db);
// 迁移之后、建 app 之前做一次性回填（幂等）
backfillCharacterBooks(db);
// 老库里的卡 / 预设自带的正则补抽进正则库（§3.2 修正）
backfillEmbeddedRegex(db);
// 老库里的预设自带的酒馆助手脚本补抽进脚本库（M5（三）§2.1，回填成关闭）
backfillPresetScriptRows(db);
// 内置默认预设写进预设库（幂等；用户删掉后不再种回），并把没选预设的旧会话改绑过去
seedBuiltinPreset(db);
// 默认连接指向已删除的连接（老库遗留）：改用最近对话用过的连接与模型
repairGenerationDefault(db);

const app = createApp({ db, dataDir, webDist });

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(
    `[newtavern] 服务端已启动：http://localhost:${info.port}（绑定 ${host}，局域网可访问）`,
  );
  console.log(`[newtavern] 数据目录：${dbPath}`);
});
