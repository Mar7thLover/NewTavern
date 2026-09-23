import type { Db } from '../db/client.js';
import { CharacterNotFoundError, updateCharacter } from './character-edit.js';
import {
  LorebookNotFoundError,
  loadLorebookDetail,
  saveLorebook,
  snapshotToSaveInput,
} from './lorebook-edit.js';
import { PresetNotFoundError, updatePreset } from './preset-edit.js';
import {
  PRESET_LAYOUT_POLICY_KEY,
  getVersion,
  recordCurrentVersion,
  type EntityType,
} from './versions.js';

/**
 * 版本恢复（M6 §2.2）：用该版 data 走一次对应实体的保存逻辑（author='user'），
 * 产生新版本，不删历史。与路由的 PUT 共用同一组服务函数。
 */

export class VersionNotFoundError extends Error {}

/** 返回恢复后的新版本号；实体或版本不存在抛 VersionNotFoundError，数据不合法抛各实体的输入错误 */
export function restoreVersion(db: Db, type: EntityType, id: string, version: number): number {
  const data = getVersion(db, type, id, version);
  if (data === undefined) throw new VersionNotFoundError('版本不存在');
  try {
    if (type === 'character') {
      updateCharacter(db, id, data, 'user');
    } else if (type === 'preset') {
      // 预设名只在 data 自带 name 时随版本恢复（与 syncDataName 的约定一致）；
      // 布局策略在保留键里，没有 = 当时为空
      const { [PRESET_LAYOUT_POLICY_KEY]: layoutPolicy, ...presetData } = (data ?? {}) as Record<
        string,
        unknown
      >;
      const name = presetData.name;
      updatePreset(
        db,
        id,
        { ...(typeof name === 'string' ? { name } : {}), data: presetData, layoutPolicy: layoutPolicy ?? null },
        'user',
      );
    } else {
      if (!loadLorebookDetail(db, id)) throw new LorebookNotFoundError();
      saveLorebook(db, id, snapshotToSaveInput(db, id, data));
    }
  } catch (e) {
    if (
      e instanceof CharacterNotFoundError ||
      e instanceof PresetNotFoundError ||
      e instanceof LorebookNotFoundError
    ) {
      throw new VersionNotFoundError('实体不存在');
    }
    throw e;
  }
  return recordCurrentVersion(db, type, id, 'user') ?? version;
}
