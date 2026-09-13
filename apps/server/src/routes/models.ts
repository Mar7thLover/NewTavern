import catalog from '@newtavern/providers/catalog.json' with { type: 'json' };
import { Hono } from 'hono';

/**
 * 模型能力目录。见 docs/M2-CONTRACT.md §3.6 与 §1.3。
 * 只是把 `catalog.json` 的 `models[]` 透出给前端做候选提示；
 * P 升级 catalog 格式（version 2）后本路由无需改动。
 */

interface Catalog {
  version?: number;
  updated?: string;
  models?: unknown[];
}

export function createModelsRoutes() {
  const data = catalog as Catalog;
  return new Hono().get('/catalog', (c) =>
    c.json({
      version: data.version ?? 0,
      updated: data.updated ?? null,
      models: data.models ?? [],
    }),
  );
}
