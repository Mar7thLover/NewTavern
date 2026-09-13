import { asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { schema, type Db } from '../db/client.js';

interface PersonaBody {
  name?: unknown;
  description?: unknown;
  position?: unknown;
}

function parseBody(body: PersonaBody) {
  const patch: Record<string, unknown> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || body.name.trim() === '') throw new Error('name 非法');
    patch.name = body.name.trim();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== 'string') throw new Error('description 非法');
    patch.description = body.description;
  }
  if (body.position !== undefined) {
    if (typeof body.position !== 'number') throw new Error('position 非法');
    patch.position = body.position;
  }
  return patch;
}

export function createPersonasRoutes(db: Db) {
  return new Hono()
    .get('/', (c) => {
      const rows = db.select().from(schema.personas).orderBy(asc(schema.personas.position)).all();
      return c.json(rows);
    })
    .post('/', async (c) => {
      let patch: Record<string, unknown>;
      try {
        patch = parseBody(await c.req.json());
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      if (!patch.name) return c.json({ error: 'invalid', message: '缺少 name' }, 400);
      const row = db
        .insert(schema.personas)
        .values(patch as typeof schema.personas.$inferInsert)
        .returning()
        .get();
      return c.json(row, 201);
    })
    .put('/:id', async (c) => {
      let patch: Record<string, unknown>;
      try {
        patch = parseBody(await c.req.json());
      } catch (e) {
        return c.json({ error: 'invalid', message: (e as Error).message }, 400);
      }
      const row = db
        .update(schema.personas)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.personas.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.json(row);
    })
    .delete('/:id', (c) => {
      const row = db
        .delete(schema.personas)
        .where(eq(schema.personas.id, c.req.param('id')))
        .returning()
        .get();
      if (!row) return c.json({ error: 'not_found' }, 404);
      return c.body(null, 204);
    });
}
