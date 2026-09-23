import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';

/**
 * 后台任务（`jobs` 表）。见 docs/M4-CONTRACT.md 第二部分 §D.2。
 *
 * 状态流转 pending → running → done / failed。进度（0–1）变化很频繁，只放进程内存，
 * 不逐次写库；`GET /api/jobs/:id` 读的时候合并进去。
 * 进程重启后仍是 pending / running、但内存里没有登记的任务，读取时当作「已中断」。
 */

export type JobKind = 'image_gen' | 'summary' | 'import';
export type JobStatus = 'pending' | 'running' | 'done' | 'failed';
export type JobRow = typeof schema.jobs.$inferSelect;

export interface JobView {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** 进度 0–1（只有进行中的任务有） */
  progress: number | null;
  payload: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

/** 本进程里正在跑的任务 → 最新进度 */
const live = new Map<string, number>();

export function createJob(db: Db, kind: JobKind, payload: Record<string, unknown>): JobRow {
  const row = db.insert(schema.jobs).values({ kind, status: 'pending', payload }).returning().get();
  live.set(row.id, 0);
  return row;
}

export function getJob(db: Db, id: string): JobRow | undefined {
  return db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).get();
}

/** 改状态 / 合并 result（浅合并）；进入 done / failed 时从内存登记里摘掉 */
export function updateJob(
  db: Db,
  id: string,
  patch: {
    status?: JobStatus;
    result?: Record<string, unknown>;
    payload?: Record<string, unknown>;
  },
): JobRow | undefined {
  const current = getJob(db, id);
  if (!current) return undefined;
  const values: Partial<typeof schema.jobs.$inferInsert> = { updatedAt: new Date() };
  if (patch.status) values.status = patch.status;
  if (patch.result) values.result = { ...(current.result ?? {}), ...patch.result };
  if (patch.payload) values.payload = { ...(current.payload ?? {}), ...patch.payload };
  if (patch.status === 'done' || patch.status === 'failed') live.delete(id);
  return db.update(schema.jobs).set(values).where(eq(schema.jobs.id, id)).returning().get();
}

export function setJobProgress(id: string, fraction: number): void {
  if (!live.has(id)) return;
  live.set(id, Math.max(0, Math.min(1, fraction)));
}

export function toJobView(row: JobRow): JobView {
  const active = row.status === 'pending' || row.status === 'running';
  const interrupted = active && !live.has(row.id);
  return {
    id: row.id,
    kind: row.kind,
    status: interrupted ? 'failed' : row.status,
    progress: active && !interrupted ? (live.get(row.id) ?? 0) : null,
    payload: row.payload ?? null,
    result: interrupted
      ? { ...(row.result ?? {}), error: { kind: 'network', message: '服务端重启，任务已中断' } }
      : (row.result ?? null),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
