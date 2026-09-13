import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（apps/server/src -> 上三级） */
export const repoRoot = path.resolve(here, '..', '..', '..');

/** 数据目录：data/<user>/，首期仅 default，目录结构预留多用户 */
export const dataDir = path.resolve(
  process.env.NT_DATA_DIR ?? path.join(repoRoot, 'data', 'default'),
);

export const dbPath = path.join(dataDir, 'tavern.sqlite');

export const webDist = path.resolve(
  process.env.NT_WEB_DIST ?? path.join(repoRoot, 'apps', 'web', 'dist'),
);

export const host = process.env.NT_HOST ?? '0.0.0.0';
export const port = Number(process.env.NT_PORT ?? process.env.PORT ?? 8787);
