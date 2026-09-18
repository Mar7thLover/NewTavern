import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listWorldbookEntries, parseWorldbook, readCardFromPng } from '@newtavern/compat';
import { asc, eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { AssetsService } from './assets.js';
import { setOwnerRegexEnabled } from './embedded-regex.js';
import { ImportError, type Importer } from './importer.js';
import { DEFAULT_PERSONA_KEY } from './personas.js';
import {
  mergeWIUiSettings,
  readGlobalBookIds,
  readWIUiSettings,
  WI_GLOBAL_BOOKS_KEY,
  WI_SETTINGS_KEY,
  type WIUiSettings,
} from './wi-settings.js';

/**
 * SillyTavern 用户目录迁移：扫描清单 + 按勾选逐项导入。见 docs/M4-CONTRACT.md §2.3。
 * 只读 ST 目录，不写；不读 secrets.json。
 */

/** 路径不对、选择非法（用户输入问题），路由层转 400 */
export class MigrationError extends Error {}

export interface StUserChoice {
  name: string;
  path: string;
}

export interface StInventory {
  root: string;
  characters: {
    file: string;
    name: string;
    exists: boolean;
    chatCount: number;
    /** 读不出角色卡（不是卡 PNG / 损坏）时的原因；这类项不能迁移 */
    error?: string;
  }[];
  /** file 相对 chats/ */
  chats: { file: string; characterFile: string | null; title: string; exists: boolean }[];
  /** 暂不迁移，只报数 */
  groupChats: number;
  presets: { file: string; name: string; exists: boolean; error?: string }[];
  lorebooks: { file: string; name: string; entryCount: number; exists: boolean; error?: string }[];
  regex: { count: number; newCount: number };
  personas: { avatar: string; name: string; exists: boolean }[];
  defaultPersona: string | null;
  worldInfo: { globalBooks: string[]; hasSettings: boolean };
  skipped: {
    backgrounds: number;
    instruct: number;
    context: number;
    themes: number;
    quickReplies: number;
  };
}

export type StScanResult = { users: StUserChoice[] } | StInventory;

export interface MigrationSelect {
  characters: string[];
  chats: string[];
  presets: string[];
  lorebooks: string[];
  personas: string[];
  regex: boolean;
  worldInfo: boolean;
  defaultPersona: boolean;
}

export type MigrationCategory =
  'lorebooks' | 'characters' | 'personas' | 'presets' | 'regex' | 'settings' | 'chats';

export const MIGRATION_CATEGORIES: readonly MigrationCategory[] = [
  'lorebooks',
  'characters',
  'personas',
  'presets',
  'regex',
  'settings',
  'chats',
];

export interface MigrationItem {
  category: MigrationCategory;
  /** 文件名（聊天是相对 chats/ 的路径；正则是脚本名；设置是 worldInfo / defaultPersona） */
  file: string;
  status: 'imported' | 'skipped' | 'failed';
  id?: string;
  message?: string;
}

export interface MigrationStart {
  total: number;
}

export interface MigrationDone {
  counts: Record<MigrationCategory, { imported: number; skipped: number; failed: number }>;
  warnings: string[];
}

export interface MigrationContext {
  db: Db;
  assets: AssetsService;
  importer: Importer;
}

/* ------------------------------------------------------------------ */
/* 文件系统小工具                                                       */
/* ------------------------------------------------------------------ */

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** 目录下满足后缀的文件名（不递归，按名字排序）；目录不存在返回空 */
function listFiles(dir: string, ext: string): string[] {
  if (!isDir(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith(ext) && isFile(path.join(dir, name)))
    .sort((a, b) => a.localeCompare(b));
}

function countFiles(dir: string, ext?: string): number {
  if (!isDir(dir)) return 0;
  return fs
    .readdirSync(dir)
    .filter((name) => (!ext || name.toLowerCase().endsWith(ext)) && isFile(path.join(dir, name)))
    .length;
}

function readJsonFile(file: string): unknown {
  const text = fs.readFileSync(file, 'utf8');
  // 去掉开头的 BOM（0xFEFF）
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as unknown;
}

const baseName = (file: string) => file.replace(/\.[^.]+$/, '');

/** ST 的聊天目录名：头像文件名去掉第一个 `.png`（`src/endpoints/chats.js`） */
const chatDirOf = (characterFile: string) => characterFile.replace('.png', '');

/** `root/sub/file`，并确认没有跑出 `root/sub`（防 `..`） */
function childPath(root: string, sub: string, file: string): string {
  const base = path.resolve(root, sub);
  const abs = path.resolve(base, file);
  const rel = path.relative(base, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new MigrationError(`非法的文件名：${file}`);
  }
  return abs;
}

/* ------------------------------------------------------------------ */
/* 目录识别                                                             */
/* ------------------------------------------------------------------ */

function isUserDir(p: string): boolean {
  return isFile(path.join(p, 'settings.json')) || isDir(path.join(p, 'characters'));
}

/**
 * 接受 ST 根目录（有 data/）、data/、或用户目录（有 settings.json 或 characters/）。
 * 只有一个用户时直接返回它；多个用户返回候选让前端选。
 */
export function resolveStRoot(input: string): { root: string } | { users: StUserChoice[] } {
  const cleaned = input
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
  if (!cleaned) throw new MigrationError('请填写 SillyTavern 的文件夹路径');
  const target = path.resolve(cleaned);
  if (!isDir(target)) throw new MigrationError(`找不到这个文件夹：${target}`);
  if (isUserDir(target)) return { root: target };

  const dataDir = isDir(path.join(target, 'data')) ? path.join(target, 'data') : target;
  const users = fs
    .readdirSync(dataDir)
    .map((name) => ({ name, path: path.join(dataDir, name) }))
    .filter((user) => !user.name.startsWith('_') && isDir(user.path) && isUserDir(user.path))
    .sort((a, b) => a.name.localeCompare(b.name));
  if (users.length === 1) return { root: (users[0] as StUserChoice).path };
  if (users.length > 1) return { users };
  throw new MigrationError(
    '这里不像 SillyTavern 的文件夹：请选 SillyTavern 的安装目录、它的 data 文件夹，或 data 下的用户文件夹（如 default-user）',
  );
}

function readStSettings(root: string, warnings?: string[]): Record<string, unknown> | null {
  const file = path.join(root, 'settings.json');
  if (!isFile(file)) return null;
  try {
    const json = readJsonFile(file);
    return isRecord(json) ? json : null;
  } catch {
    warnings?.push('settings.json 读不出来（不是有效的 JSON），用户档案、正则与世界书设置无法迁移');
    return null;
  }
}

function powerUser(settings: Record<string, unknown> | null): Record<string, unknown> {
  return isRecord(settings?.['power_user']) ? settings['power_user'] : {};
}

/** ST 老版本把世界书设置平铺在 settings 顶层（`settings.world_info_settings ?? settings`） */
function wiSource(settings: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!settings) return null;
  if (isRecord(settings['world_info_settings'])) return settings['world_info_settings'];
  return 'world_info_depth' in settings ? settings : null;
}

function globalSelectOf(wi: Record<string, unknown> | null): string[] {
  const worldInfo = wi?.['world_info'];
  if (Array.isArray(worldInfo)) return worldInfo.filter((n): n is string => typeof n === 'string');
  if (typeof worldInfo === 'string') return [worldInfo];
  const select = isRecord(worldInfo) ? worldInfo['globalSelect'] : undefined;
  return Array.isArray(select) ? select.filter((n): n is string => typeof n === 'string') : [];
}

interface StRegexItem {
  raw: Record<string, unknown>;
  scriptName: string;
  findRegex: string;
}

function stRegexList(settings: Record<string, unknown> | null): StRegexItem[] {
  const ext = isRecord(settings?.['extension_settings']) ? settings['extension_settings'] : {};
  const list = Array.isArray(ext['regex']) ? ext['regex'] : [];
  return list
    .filter(
      (item): item is Record<string, unknown> =>
        isRecord(item) &&
        typeof item['scriptName'] === 'string' &&
        typeof item['findRegex'] === 'string',
    )
    .map((raw) => ({
      raw,
      scriptName: raw['scriptName'] as string,
      findRegex: raw['findRegex'] as string,
    }));
}

const regexKey = (scriptName: string, findRegex: string) => JSON.stringify([scriptName, findRegex]);

/* ------------------------------------------------------------------ */
/* 库里已有什么                                                         */
/* ------------------------------------------------------------------ */

function existingCharacterHashes(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  const rows = db
    .select({ id: schema.characters.id, hash: schema.characters.originalHash })
    .from(schema.characters)
    .orderBy(asc(schema.characters.createdAt))
    .all();
  for (const row of rows) {
    if (row.hash && !map.has(row.hash)) map.set(row.hash, row.id);
  }
  return map;
}

function existingChatHashes(db: Db): Set<string> {
  const set = new Set<string>();
  for (const row of db.select({ metadata: schema.chats.metadata }).from(schema.chats).all()) {
    const st = row.metadata?.['st'];
    if (isRecord(st) && typeof st['sourceHash'] === 'string') set.add(st['sourceHash']);
  }
  return set;
}

/** 书名 → id（非角色内嵌的书；同名取最早的） */
function existingBookIds(db: Db): Map<string, string> {
  const map = new Map<string, string>();
  const rows = db
    .select({ id: schema.lorebooks.id, name: schema.lorebooks.name, scope: schema.lorebooks.scope })
    .from(schema.lorebooks)
    .orderBy(asc(schema.lorebooks.createdAt))
    .all();
  for (const row of rows) {
    if (row.scope !== 'char' && !map.has(row.name)) map.set(row.name, row.id);
  }
  return map;
}

/** 用户档案：名字 → [{ id, 头像 sha256 | null }] */
function existingPersonas(db: Db): Map<string, { id: string; avatarHash: string | null }[]> {
  const map = new Map<string, { id: string; avatarHash: string | null }[]>();
  const rows = db
    .select({
      id: schema.personas.id,
      name: schema.personas.name,
      avatarHash: schema.assets.sha256,
    })
    .from(schema.personas)
    .leftJoin(schema.assets, eq(schema.personas.avatarAssetId, schema.assets.id))
    .all();
  for (const row of rows) {
    const list = map.get(row.name) ?? [];
    list.push({ id: row.id, avatarHash: row.avatarHash ?? null });
    map.set(row.name, list);
  }
  return map;
}

/**
 * ST 的「允许自带正则」名单：`character_allowed_regex`（按头像文件名）与
 * `preset_allowed_regex`（按 api → 预设名）。迁移时照搬——在 ST 里点过头的卡 / 预设，
 * 搬过来仍然是启用的，不用再问一次（M3 契约 §3.2 修正）。
 */
function stAllowedRegex(settings: Record<string, unknown> | null): {
  characters: Set<string>;
  presets: Set<string>;
} {
  const ext = isRecord(settings?.['extension_settings']) ? settings['extension_settings'] : {};
  const characters = new Set(
    (Array.isArray(ext['character_allowed_regex']) ? ext['character_allowed_regex'] : []).filter(
      (item): item is string => typeof item === 'string',
    ),
  );
  const presets = new Set<string>();
  const byApi = isRecord(ext['preset_allowed_regex']) ? ext['preset_allowed_regex'] : {};
  for (const list of Object.values(byApi)) {
    if (!Array.isArray(list)) continue;
    for (const name of list) if (typeof name === 'string') presets.add(name);
  }
  return { characters, presets };
}

function existingRegexKeys(db: Db): Set<string> {
  return new Set(
    db
      .select({ name: schema.regexScripts.scriptName, find: schema.regexScripts.findRegex })
      .from(schema.regexScripts)
      .all()
      .map((row) => regexKey(row.name, row.find)),
  );
}

function avatarHashOf(root: string, avatar: string): string | null {
  try {
    const file = childPath(root, 'User Avatars', avatar);
    return isFile(file) ? sha256(fs.readFileSync(file)) : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* 扫描                                                                 */
/* ------------------------------------------------------------------ */

export function scanStDirectory(db: Db, root: string): StInventory {
  const settings = readStSettings(root);
  const pu = powerUser(settings);

  // 角色卡
  const charHashes = existingCharacterHashes(db);
  const characterFiles = listFiles(path.join(root, 'characters'), '.png');
  const chatsDir = path.join(root, 'chats');
  const characters = characterFiles.map((file) => {
    const bytes = fs.readFileSync(path.join(root, 'characters', file));
    const chatCount = listFiles(path.join(chatsDir, chatDirOf(file)), '.jsonl').length;
    const exists = charHashes.has(sha256(bytes));
    try {
      const card = readCardFromPng(bytes);
      const name =
        typeof card.data.name === 'string' && card.data.name ? card.data.name : baseName(file);
      return { file, name, exists, chatCount };
    } catch (e) {
      return { file, name: baseName(file), exists, chatCount, error: (e as Error).message };
    }
  });

  // 聊天
  const chatHashes = existingChatHashes(db);
  const chats: StInventory['chats'] = [];
  if (isDir(chatsDir)) {
    const dirs = fs
      .readdirSync(chatsDir)
      .filter((name) => isDir(path.join(chatsDir, name)))
      .sort((a, b) => a.localeCompare(b));
    for (const dir of dirs) {
      const characterFile = characterFiles.find((file) => chatDirOf(file) === dir) ?? null;
      for (const file of listFiles(path.join(chatsDir, dir), '.jsonl')) {
        const bytes = fs.readFileSync(path.join(chatsDir, dir, file));
        chats.push({
          file: `${dir}/${file}`,
          characterFile,
          title: baseName(file),
          exists: chatHashes.has(sha256(bytes)),
        });
      }
    }
  }

  // 预设
  const presetNames = new Set(
    db
      .select({ name: schema.presets.name })
      .from(schema.presets)
      .all()
      .map((row) => row.name),
  );
  const presets = listFiles(path.join(root, 'OpenAI Settings'), '.json').map((file) => {
    const name = baseName(file);
    try {
      const json = readJsonFile(path.join(root, 'OpenAI Settings', file));
      const jsonName = isRecord(json) && typeof json['name'] === 'string' ? json['name'] : null;
      return {
        file,
        name,
        exists: presetNames.has(name) || (jsonName !== null && presetNames.has(jsonName)),
      };
    } catch {
      return { file, name, exists: presetNames.has(name), error: '不是有效的 JSON' };
    }
  });

  // 世界书
  const bookIds = existingBookIds(db);
  const lorebooks = listFiles(path.join(root, 'worlds'), '.json').map((file) => {
    const name = baseName(file);
    try {
      const book = parseWorldbook(readJsonFile(path.join(root, 'worlds', file)));
      return {
        file,
        name,
        entryCount: listWorldbookEntries(book).items.length,
        exists: bookIds.has(name),
      };
    } catch (e) {
      return { file, name, entryCount: 0, exists: bookIds.has(name), error: (e as Error).message };
    }
  });

  // 正则
  const regexKeys = existingRegexKeys(db);
  const regexList = stRegexList(settings);
  const regex = {
    count: regexList.length,
    newCount: regexList.filter((item) => !regexKeys.has(regexKey(item.scriptName, item.findRegex)))
      .length,
  };

  // 用户档案
  const personaRows = existingPersonas(db);
  const stPersonas = isRecord(pu['personas']) ? pu['personas'] : {};
  const personas = Object.entries(stPersonas)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([avatar, name]) => {
      const hash = avatarHashOf(root, avatar);
      const exists = (personaRows.get(name) ?? []).some((row) => row.avatarHash === hash);
      return { avatar, name, exists };
    });

  const wi = wiSource(settings);
  return {
    root,
    characters,
    chats,
    groupChats: countFiles(path.join(root, 'group chats'), '.jsonl'),
    presets,
    lorebooks,
    regex,
    personas,
    defaultPersona: typeof pu['default_persona'] === 'string' ? pu['default_persona'] : null,
    worldInfo: { globalBooks: globalSelectOf(wi), hasSettings: wi !== null },
    skipped: {
      backgrounds: countFiles(path.join(root, 'backgrounds')),
      instruct: countFiles(path.join(root, 'instruct'), '.json'),
      context: countFiles(path.join(root, 'context'), '.json'),
      themes: countFiles(path.join(root, 'themes'), '.json'),
      quickReplies: countFiles(path.join(root, 'QuickReplies'), '.json'),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 迁移                                                                 */
/* ------------------------------------------------------------------ */

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string'))] : [];

/** 请求体 → 选择；形状不对抛 MigrationError */
export function parseMigrationSelect(value: unknown): MigrationSelect {
  if (!isRecord(value)) throw new MigrationError('select 必须是对象');
  return {
    characters: stringList(value['characters']),
    chats: stringList(value['chats']),
    presets: stringList(value['presets']),
    lorebooks: stringList(value['lorebooks']),
    personas: stringList(value['personas']),
    regex: value['regex'] === true,
    worldInfo: value['worldInfo'] === true,
    defaultPersona: value['defaultPersona'] === true,
  };
}

/** 这次迁移会产生多少条 item 事件（正则按脚本数） */
export function countMigrationItems(root: string, select: MigrationSelect): number {
  const regexCount = select.regex ? stRegexList(readStSettings(root)).length : 0;
  return (
    select.characters.length +
    select.chats.length +
    select.presets.length +
    select.lorebooks.length +
    select.personas.length +
    regexCount +
    (select.worldInfo ? 1 : 0) +
    (select.defaultPersona ? 1 : 0)
  );
}

function writeSetting(db: Db, key: string, value: unknown): void {
  db.insert(schema.settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value, updatedAt: new Date() } })
    .run();
}

/** ST `persona_description_positions`：0 IN_PROMPT、1 AFTER_CHAR（已废弃，ST 读到时改成 IN_PROMPT）、2 TOP_AN、3 BOTTOM_AN、4 AT_DEPTH、9 NONE */
const PERSONA_POSITIONS: Record<
  number,
  (typeof schema.personas.$inferInsert)['descriptionPosition']
> = {
  0: 'in_prompt',
  1: 'in_prompt',
  2: 'top_an',
  3: 'bottom_an',
  4: 'at_depth',
  9: 'none',
};
const PERSONA_ROLES = ['system', 'user', 'assistant'] as const;

function sniffAvatarMime(bytes: Uint8Array): string | null {
  const starts = (sig: number[], offset = 0) => sig.every((b, i) => bytes[offset + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  if (starts([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  return null;
}

/** ST 世界书设置 → `worldInfo.settings`（以库里现有值为底，只覆盖 ST 里有的键） */
export function wiSettingsFromSt(st: Record<string, unknown>, base: WIUiSettings): WIUiSettings {
  const out: Record<string, unknown> = { ...base };
  const numbers: [keyof WIUiSettings, string][] = [
    ['scanDepth', 'world_info_depth'],
    ['budgetPercent', 'world_info_budget'],
    ['budgetCap', 'world_info_budget_cap'],
    ['maxRecursionSteps', 'world_info_max_recursion_steps'],
    ['minActivations', 'world_info_min_activations'],
    ['minActivationsDepthMax', 'world_info_min_activations_depth_max'],
  ];
  const booleans: [keyof WIUiSettings, string][] = [
    ['recursive', 'world_info_recursive'],
    ['caseSensitive', 'world_info_case_sensitive'],
    ['matchWholeWords', 'world_info_match_whole_words'],
    ['useGroupScoring', 'world_info_use_group_scoring'],
    ['includeNames', 'world_info_include_names'],
  ];
  // ST `setWorldInfoSettings`：Number(value) / Boolean(value)
  for (const [key, stKey] of numbers) {
    if (st[stKey] === undefined) continue;
    const value = Number(st[stKey]);
    if (Number.isFinite(value)) out[key] = value;
  }
  for (const [key, stKey] of booleans) {
    if (st[stKey] !== undefined) out[key] = Boolean(st[stKey]);
  }
  // ST 的旧设置迁移：预算超过 100% 视为旧的 token 数，改回 25
  if ((out['budgetPercent'] as number) > 100) out['budgetPercent'] = 25;
  return mergeWIUiSettings(out);
}

/**
 * 按勾选逐项迁移。顺序：世界书 → 角色 → 档案 → 预设 → 正则 → 世界书全局设置 / 默认档案 → 聊天。
 * 单项失败不中断；`isAborted()` 为真时在两项之间停下。
 */
export async function runStMigration(
  ctx: MigrationContext,
  root: string,
  select: MigrationSelect,
  emit: (item: MigrationItem) => Promise<void> | void,
  isAborted: () => boolean = () => false,
): Promise<MigrationDone> {
  const { db, assets, importer } = ctx;
  const warnings: string[] = [];
  const counts = Object.fromEntries(
    MIGRATION_CATEGORIES.map((category) => [category, { imported: 0, skipped: 0, failed: 0 }]),
  ) as MigrationDone['counts'];
  const settings = readStSettings(root, warnings);
  const pu = powerUser(settings);

  const report = async (item: MigrationItem) => {
    counts[item.category][item.status]++;
    await emit(item);
    // 让出事件循环：SSE 逐项推出去，而不是全部做完才一起到
    await new Promise((resolve) => setImmediate(resolve));
  };
  const attempt = async (
    category: MigrationCategory,
    file: string,
    run: () => { id?: string; message?: string; status?: MigrationItem['status'] },
  ) => {
    if (isAborted()) return false;
    try {
      const result = run();
      await report({ category, file, status: result.status ?? 'imported', ...result });
    } catch (e) {
      const message =
        e instanceof ImportError || e instanceof MigrationError
          ? e.message
          : `导入出错：${(e as Error).message}`;
      await report({ category, file, status: 'failed', message });
    }
    return !isAborted();
  };
  const allowedRegex = stAllowedRegex(settings);
  const readChild = (sub: string, file: string) => {
    const abs = childPath(root, sub, file);
    if (!isFile(abs)) throw new MigrationError('文件不存在');
    return new Uint8Array(fs.readFileSync(abs));
  };

  // 1. 世界书（ST 里书名就是文件名）
  const bookIds = existingBookIds(db);
  for (const file of select.lorebooks) {
    const ok = await attempt('lorebooks', file, () => {
      const name = baseName(file);
      const row = importer.importLorebook(file, readChild('worlds', file), { name });
      bookIds.set(name, row.id);
      return { id: row.id };
    });
    if (!ok) break;
  }

  // 2. 角色
  const characterIds = new Map<string, string>();
  for (const file of select.characters) {
    const ok = await attempt('characters', file, () => {
      const row = importer.importCharacter(file, readChild('characters', file));
      characterIds.set(file, row.id);
      // ST 里允许过这张卡的自带正则 → 搬过来也保持启用（文件名就是 ST 的 avatar）
      if (allowedRegex.characters.has(file)) {
        setOwnerRegexEnabled(db, 'character', row.id, true);
      }
      return { id: row.id };
    });
    if (!ok) break;
  }

  // 3. 用户档案
  const stPersonas = isRecord(pu['personas']) ? pu['personas'] : {};
  const descriptions = isRecord(pu['persona_descriptions']) ? pu['persona_descriptions'] : {};
  const personaIds = new Map<string, string>();
  let position =
    (db
      .select({ position: schema.personas.position })
      .from(schema.personas)
      .all()
      .reduce((max, row) => Math.max(max, row.position), -1) ?? -1) + 1;
  for (const avatar of select.personas) {
    const ok = await attempt('personas', avatar, () => {
      const name = stPersonas[avatar];
      if (typeof name !== 'string' || name.trim() === '') {
        throw new MigrationError('settings.json 里没有这个用户档案');
      }
      const desc = isRecord(descriptions[avatar]) ? descriptions[avatar] : {};
      let message: string | undefined;

      let avatarAssetId: string | null = null;
      const avatarFile = childPath(root, 'User Avatars', avatar);
      if (isFile(avatarFile)) {
        const bytes = new Uint8Array(fs.readFileSync(avatarFile));
        const mime = sniffAvatarMime(bytes);
        if (mime) {
          avatarAssetId = assets.save({
            bytes,
            mime,
            kind: 'avatar',
            source: `st-import:persona:${avatar}`,
          }).id;
        } else {
          message = '头像格式不支持，没有导入头像';
        }
      } else {
        message = '头像文件不存在，没有导入头像';
      }

      let lorebookId: string | null = null;
      if (typeof desc['lorebook'] === 'string' && desc['lorebook'] !== '') {
        lorebookId = bookIds.get(desc['lorebook']) ?? null;
        if (!lorebookId) message = `绑定的世界书「${desc['lorebook']}」不在库里，没有关联`;
      }
      const depth = desc['depth'];
      const role = desc['role'];
      const row = db
        .insert(schema.personas)
        .values({
          name: name.trim(),
          description: typeof desc['description'] === 'string' ? desc['description'] : '',
          title: typeof desc['title'] === 'string' ? desc['title'].trim() : '',
          avatarAssetId,
          position: position++,
          descriptionPosition:
            PERSONA_POSITIONS[typeof desc['position'] === 'number' ? desc['position'] : 0] ??
            'in_prompt',
          depth:
            typeof depth === 'number' && Number.isInteger(depth) && depth >= 0 && depth <= 10000
              ? depth
              : 2,
          role: typeof role === 'number' ? (PERSONA_ROLES[role] ?? 'system') : 'system',
          lorebookId,
        })
        .returning()
        .get();
      personaIds.set(avatar, row.id);
      return { id: row.id, ...(message ? { message } : {}) };
    });
    if (!ok) break;
  }

  // 4. 预设（ST 里预设名就是文件名）
  for (const file of select.presets) {
    const ok = await attempt('presets', file, () => {
      const row = importer.importPreset(file, readChild('OpenAI Settings', file), {
        name: baseName(file),
      });
      if (allowedRegex.presets.has(baseName(file))) {
        setOwnerRegexEnabled(db, 'preset', row.id, true);
      }
      return { id: row.id };
    });
    if (!ok) break;
  }

  // 5. 正则：库里已有同名同表达式的跳过
  if (select.regex) {
    const keys = existingRegexKeys(db);
    for (const item of stRegexList(settings)) {
      const ok = await attempt('regex', item.scriptName, () => {
        const key = regexKey(item.scriptName, item.findRegex);
        if (keys.has(key)) return { status: 'skipped', message: '库里已有同样的正则' };
        const [script] = importer.importRegexScripts(
          'settings.json',
          new TextEncoder().encode(JSON.stringify([item.raw])),
        );
        keys.add(key);
        return { id: script?.id };
      });
      if (!ok) break;
    }
  }

  // 6. 世界书全局设置 / 默认档案
  if (select.worldInfo && !isAborted()) {
    await attempt('settings', 'worldInfo', () => {
      const wi = wiSource(settings);
      if (!wi) return { status: 'skipped', message: 'settings.json 里没有世界书设置' };
      writeSetting(db, WI_SETTINGS_KEY, wiSettingsFromSt(wi, readWIUiSettings(db)));
      const names = globalSelectOf(wi);
      const resolved: string[] = [];
      const missing: string[] = [];
      for (const name of names) {
        const id = bookIds.get(name);
        if (id) resolved.push(id);
        else missing.push(name);
      }
      if (names.length > 0) {
        writeSetting(db, WI_GLOBAL_BOOKS_KEY, [
          ...new Set([...readGlobalBookIds(db), ...resolved]),
        ]);
      }
      if (missing.length > 0) {
        const message = `全局世界书「${missing.join('」「')}」不在库里，没有加入全局选择`;
        warnings.push(message);
        return { message };
      }
      return {};
    });
  }
  if (select.defaultPersona && !isAborted()) {
    await attempt('settings', 'defaultPersona', () => {
      const avatar = typeof pu['default_persona'] === 'string' ? pu['default_persona'] : null;
      if (!avatar) return { status: 'skipped', message: 'SillyTavern 里没有设默认用户档案' };
      let id = personaIds.get(avatar) ?? null;
      const name = stPersonas[avatar];
      if (!id && typeof name === 'string') {
        const hash = avatarHashOf(root, avatar);
        id =
          existingPersonas(db)
            .get(name.trim())
            ?.find((row) => row.avatarHash === hash)?.id ?? null;
      }
      if (!id) return { status: 'skipped', message: '默认用户档案没有迁移进库，没法设为默认' };
      writeSetting(db, DEFAULT_PERSONA_KEY, id);
      return { id };
    });
  }

  // 7. 聊天：角色按「这次导入的」→「库里同 hash 的」关联，都没有就按 header 里的角色名匹配
  const charHashes = existingCharacterHashes(db);
  const characterFiles = listFiles(path.join(root, 'characters'), '.png');
  const libraryCharacterId = (characterFile: string): string | undefined => {
    const cached = characterIds.get(characterFile);
    if (cached) return cached;
    try {
      const id = charHashes.get(sha256(readChild('characters', characterFile)));
      if (id) characterIds.set(characterFile, id);
      return id;
    } catch {
      return undefined;
    }
  };
  for (const file of select.chats) {
    const ok = await attempt('chats', file, () => {
      const bytes = readChild('chats', file);
      const dir = file.split(/[\\/]/)[0] ?? '';
      const characterFile = characterFiles.find((name) => chatDirOf(name) === dir);
      const characterId = characterFile ? libraryCharacterId(characterFile) : undefined;
      const result = importer.importChat({
        fileName: path.basename(file),
        bytes,
        characterId,
        mediaRoot: root,
      });
      if (result.warnings.length > 0) {
        warnings.push(
          ...result.warnings.map((warning) => `${baseName(path.basename(file))}：${warning}`),
        );
      }
      return {
        id: result.chat.id,
        ...(result.warnings.length > 0 ? { message: result.warnings.join('；') } : {}),
      };
    });
    if (!ok) break;
  }

  return { counts, warnings };
}
