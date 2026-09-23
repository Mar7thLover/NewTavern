import { Hono } from 'hono';

import type { Db } from '../db/client.js';
import { CharacterInputError } from '../services/character-edit.js';
import { LorebookInputError } from '../services/lorebook-edit.js';
import { PresetInputError } from '../services/preset-edit.js';
import { VersionNotFoundError, restoreVersion } from '../services/version-restore.js';
import {
  getVersion,
  isEntityType,
  listRecentEntities,
  listVersions,
  type EntityType,
  type RecentEntity,
  type VersionAuthor,
  type VersionSummary,
} from '../services/versions.js';

/** 前端复用的类型（M6 §2.2） */
export type { EntityType, RecentEntity, VersionAuthor, VersionSummary };

/** `GET /api/versions/:type/:id/:version` */
export interface VersionDetail {
  type: EntityType;
  id: string;
  version: number;
  /** 与工作台草稿同形：character = CCv3 data；preset = ST 预设 data；lorebook = { name, entries } */
  data: unknown;
}

/** `POST /api/versions/:type/:id/:version/restore` */
export interface VersionRestoreResponse {
  /** 恢复后当前的版本号（内容与最新一版相同则不新增） */
  version: number;
}

function parseVersion(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * 版本历史（M6 §2.2）：列表 / 取某版 / 恢复。另有 `GET /recent`（工作台入口页「最近编辑」）。
 */
export function createVersionsRoutes(db: Db) {
  return (
    new Hono()
      /** 最近编辑过的实体：`?limit=`（默认 20，最多 100）、`?type=` */
      .get('/recent', (c) => {
        const limit = Math.min(Math.max(Number(c.req.query('limit')) || 20, 1), 100);
        const type = c.req.query('type');
        if (type !== undefined && !isEntityType(type)) {
          return c.json({ error: 'invalid', message: `未知实体类型：${type}` }, 400);
        }
        return c.json(listRecentEntities(db, limit, type));
      })
      .get('/:type/:id', (c) => {
        const type = c.req.param('type');
        if (!isEntityType(type)) {
          return c.json({ error: 'invalid', message: `未知实体类型：${type}` }, 400);
        }
        return c.json(listVersions(db, type, c.req.param('id')));
      })
      .get('/:type/:id/:version', (c) => {
        const type = c.req.param('type');
        if (!isEntityType(type)) {
          return c.json({ error: 'invalid', message: `未知实体类型：${type}` }, 400);
        }
        const version = parseVersion(c.req.param('version'));
        if (version === undefined) return c.json({ error: 'invalid', message: '版本号非法' }, 400);
        const id = c.req.param('id');
        const data = getVersion(db, type, id, version);
        if (data === undefined) return c.json({ error: 'not_found' }, 404);
        const detail: VersionDetail = { type, id, version, data };
        return c.json(detail);
      })
      /** 用该版 data 走一次对应的保存（author='user'），产生新版本，不删历史 */
      .post('/:type/:id/:version/restore', (c) => {
        const type = c.req.param('type');
        if (!isEntityType(type)) {
          return c.json({ error: 'invalid', message: `未知实体类型：${type}` }, 400);
        }
        const version = parseVersion(c.req.param('version'));
        if (version === undefined) return c.json({ error: 'invalid', message: '版本号非法' }, 400);
        try {
          const result: VersionRestoreResponse = {
            version: restoreVersion(db, type, c.req.param('id'), version),
          };
          return c.json(result);
        } catch (e) {
          if (e instanceof VersionNotFoundError) {
            return c.json({ error: 'not_found', message: e.message }, 404);
          }
          if (
            e instanceof CharacterInputError ||
            e instanceof PresetInputError ||
            e instanceof LorebookInputError
          ) {
            return c.json({ error: 'invalid', message: e.message }, 400);
          }
          throw e;
        }
      })
  );
}
