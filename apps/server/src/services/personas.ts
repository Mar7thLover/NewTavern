import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/** 设置 KV 里默认用户档案的键：值为档案 id 字符串；没有默认时不存在该行 */
export const DEFAULT_PERSONA_KEY = 'defaultPersonaId';

/** 默认档案 id；设置里的 id 已不存在（脏数据）时当作没有 */
export function readDefaultPersonaId(db: Db): string | null {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_PERSONA_KEY))
    .get();
  if (typeof row?.value !== 'string') return null;
  const persona = db
    .select({ id: schema.personas.id })
    .from(schema.personas)
    .where(eq(schema.personas.id, row.value))
    .get();
  return persona?.id ?? null;
}

/** 删除档案时：它若是默认档案，清掉设置 */
export function clearDefaultPersonaIf(db: Db, personaId: string): void {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, DEFAULT_PERSONA_KEY))
    .get();
  if (row?.value === personaId) {
    db.delete(schema.settings).where(eq(schema.settings.key, DEFAULT_PERSONA_KEY)).run();
  }
}
