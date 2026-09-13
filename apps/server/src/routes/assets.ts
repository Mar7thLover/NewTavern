import fs from 'node:fs';

import { Hono } from 'hono';

import type { AssetsService } from '../services/assets.js';

export function createAssetsRoutes(assets: AssetsService) {
  return new Hono().get('/:id/file', (c) => {
    const asset = assets.getById(c.req.param('id'));
    if (!asset) return c.json({ error: 'not_found' }, 404);
    const absPath = assets.resolvePath(asset);
    if (!fs.existsSync(absPath)) return c.json({ error: 'file_missing' }, 404);
    return c.body(fs.readFileSync(absPath), 200, {
      'content-type': asset.mime,
      'cache-control': 'immutable, max-age=31536000',
    });
  });
}
