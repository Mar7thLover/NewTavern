import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';

export function createSettingsRoutes(db: Db) {
  return new Hono()
    .get('/', (c) => {
      const rows = db.select().from(schema.settings).all();
      return c.json(Object.fromEntries(rows.map((row) => [row.key, row.value])));
    })
    .get('/:key', (c) => {
      const row = db
        .select()
        .from(schema.settings)
        .where(eq(schema.settings.key, c.req.param('key')))
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json({ key: row.key, value: row.value });
    })
    .put('/:key', async (c) => {
      let value: unknown;
      try {
        value = (await c.req.json()) as unknown;
      } catch {
        return c.json({ error: 'invalid_json' }, 400);
      }
      const key = c.req.param('key');
      db.insert(schema.settings)
        .values({ key, value, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.settings.key,
          set: { value, updatedAt: new Date() },
        })
        .run();
      return c.json({ key, value });
    })
    .delete('/:key', (c) => {
      db.delete(schema.settings)
        .where(eq(schema.settings.key, c.req.param('key')))
        .run();
      return c.body(null, 204);
    });
}
