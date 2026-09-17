import { and, inArray, lt, sql } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';

/**
 * 资产清理（docs/M4-CONTRACT.md §3.3「清理」）：`POST /api/assets/gc`。
 *
 * 删除同时满足下列条件的资产（行 + 文件）：
 * - kind 是 `upload` / `generated` / `avatar`（`card_embedded`、背景、立绘不动）；
 * - 创建超过 24 小时，且进程内最近 24 小时没被上传端点返回过（去重命中的老资产，用户可能正要发送）；
 * - 没有被引用：角色 / 档案头像、任何节点的 image / document part、`characters.data` 里出现的 id。
 *   另外保守地把 `chats.metadata` 与 `settings` 里出现的 id 也算引用（背景等以后会放在那里）。
 */

export const GC_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const GC_KINDS = ['upload', 'generated', 'avatar'] as const;

export interface GcResult {
  removed: number;
  freedBytes: number;
}

/** 所有节点 parts 里的 assetId（SQLite JSON1；解析失败时退回逐行 JSON.parse） */
function referencedByNodes(db: Db): Set<string> {
  const ids = new Set<string>();
  try {
    const rows = db.all<{ id: string | null }>(sql`
      SELECT DISTINCT json_extract(part.value, '$.assetId') AS id
      FROM ${schema.messageNodes} AS node, json_each(node.parts) AS part
      WHERE json_type(node.parts) = 'array'
        AND json_extract(part.value, '$.type') IN ('image', 'document')
    `);
    for (const row of rows) if (typeof row.id === 'string') ids.add(row.id);
    return ids;
  } catch {
    const rows = db.select({ parts: schema.messageNodes.parts }).from(schema.messageNodes).all();
    for (const row of rows) {
      if (!Array.isArray(row.parts)) continue;
      for (const part of row.parts as { type?: unknown; assetId?: unknown }[]) {
        if (
          (part?.type === 'image' || part?.type === 'document') &&
          typeof part.assetId === 'string'
        ) {
          ids.add(part.assetId);
        }
      }
    }
    return ids;
  }
}

/** 候选 id 里在一段 JSON 文本中出现过的（资产 id 是 UUID，子串匹配足够可靠） */
function markMentioned(texts: Iterable<unknown>, candidates: Set<string>, into: Set<string>) {
  for (const value of texts) {
    if (value === null || value === undefined) continue;
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    for (const id of candidates) {
      if (!into.has(id) && text.includes(id)) into.add(id);
    }
  }
}

export function collectGarbage(db: Db, assets: AssetsService, now: number = Date.now()): GcResult {
  const cutoff = new Date(now - GC_MIN_AGE_MS);
  const candidates = db
    .select()
    .from(schema.assets)
    .where(and(inArray(schema.assets.kind, [...GC_KINDS]), lt(schema.assets.createdAt, cutoff)))
    .all()
    .filter((row) => {
      const usedAt = assets.recentlyUsedAt(row.id);
      return usedAt === undefined || now - usedAt >= GC_MIN_AGE_MS;
    });
  if (candidates.length === 0) return { removed: 0, freedBytes: 0 };

  const candidateIds = new Set(candidates.map((row) => row.id));
  const referenced = new Set<string>();

  for (const row of db
    .select({ id: schema.characters.avatarAssetId })
    .from(schema.characters)
    .all()) {
    if (row.id) referenced.add(row.id);
  }
  for (const row of db.select({ id: schema.personas.avatarAssetId }).from(schema.personas).all()) {
    if (row.id) referenced.add(row.id);
  }
  for (const id of referencedByNodes(db)) referenced.add(id);

  const unresolved = new Set([...candidateIds].filter((id) => !referenced.has(id)));
  if (unresolved.size > 0) {
    markMentioned(
      db
        .select({ data: schema.characters.data })
        .from(schema.characters)
        .all()
        .map((r) => r.data),
      unresolved,
      referenced,
    );
    markMentioned(
      db
        .select({ metadata: schema.chats.metadata })
        .from(schema.chats)
        .all()
        .map((r) => r.metadata),
      unresolved,
      referenced,
    );
    markMentioned(
      db
        .select({ value: schema.settings.value })
        .from(schema.settings)
        .all()
        .map((r) => r.value),
      unresolved,
      referenced,
    );
  }

  let removed = 0;
  let freedBytes = 0;
  for (const row of candidates) {
    if (referenced.has(row.id)) continue;
    freedBytes += assets.remove(row);
    removed += 1;
  }
  return { removed, freedBytes };
}
