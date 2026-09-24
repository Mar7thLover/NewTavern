import fs from 'node:fs';
import path from 'node:path';

import { parseCardJson, writeCardToPng } from '@newtavern/compat';
import { afterAll, describe, expect, it } from 'vitest';

import { createAssetsService } from './services/assets.js';
import { stCustomBackgroundFile, stCustomBackgroundRef } from './services/backgrounds.js';
import { createImporter } from './services/importer.js';
import {
  resolveStRoot,
  runStMigration,
  scanStDirectory,
  type MigrationItem,
  type MigrationSelect,
} from './services/st-migration.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

/** ST 迁移：背景库与 characters/<名>/ 立绘（M4（二）§A.5 / §B.1） */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const write = (file: string, content: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

const png = (tag: string) =>
  new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    0,
    0,
    0,
    8,
    0,
    0,
    0,
    8,
    8,
    6,
    0,
    0,
    0,
    ...new TextEncoder().encode(tag),
  ]);
const jpeg = (tag: string) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new TextEncoder().encode(tag)]);

const card = (name: string) =>
  writeCardToPng(
    null,
    parseCardJson({
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name,
        description: '',
        personality: '',
        scenario: '',
        first_mes: '你好',
        mes_example: '',
      },
    }),
  );

const NONE: MigrationSelect = {
  characters: [],
  chats: [],
  presets: [],
  lorebooks: [],
  personas: [],
  regex: false,
  scripts: false,
  worldInfo: false,
  defaultPersona: false,
  backgrounds: false,
  defaultBackground: false,
};

function makeStUser(): string {
  const user = fs.mkdtempSync(path.join(dataDir, 'st-user-'));
  write(path.join(user, 'settings.json'), JSON.stringify({ power_user: {} }));
  write(path.join(user, 'characters', 'default_Seraphina.png'), card('Seraphina'));
  write(path.join(user, 'characters', 'Seraphina', 'joy.png'), png('joy'));
  write(path.join(user, 'characters', 'Seraphina', 'Neutral.png'), png('neutral'));
  write(path.join(user, 'characters', 'Seraphina', 'readme.txt'), 'hi');
  write(path.join(user, 'backgrounds', '黄金庭院.png'), png('garden'));
  write(path.join(user, 'backgrounds', 'bedroom clean.jpg'), jpeg('bedroom'));
  write(path.join(user, 'backgrounds', 'rain.mp4'), 'video');
  write(path.join(user, 'backgrounds', 'broken.png'), 'not really');
  const header = {
    user_name: '我',
    character_name: 'Seraphina',
    create_date: '2026-01-01@10h00m00s',
    chat_metadata: { custom_background: 'url("backgrounds/bedroom%20clean.jpg")' },
  };
  const message = {
    name: 'Seraphina',
    is_user: false,
    send_date: '2026-01-01T02:00:00.000Z',
    mes: '你好',
    extra: {},
  };
  write(
    path.join(user, 'chats', 'default_Seraphina', 'a.jsonl'),
    [header, message].map((line) => JSON.stringify(line)).join('\n'),
  );
  return user;
}

describe('ST 迁移：背景与立绘', () => {
  it('custom_background 解析', () => {
    expect(stCustomBackgroundFile('url("backgrounds/bedroom%20clean.jpg")')).toBe(
      'bedroom clean.jpg',
    );
    expect(stCustomBackgroundFile("url('backgrounds/a.png')")).toBe('a.png');
    expect(stCustomBackgroundFile('backgrounds/x.webp')).toBe('x.webp');
    expect(stCustomBackgroundFile('')).toBeNull();
    expect(stCustomBackgroundFile(3)).toBeNull();
  });

  it('扫描、导入背景库、同名角色立绘、聊天的 custom_background', async () => {
    const { app, db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const user = makeStUser();

    const inventory = scanStDirectory(db, user);
    expect(inventory.backgrounds).toEqual({ count: 3, newCount: 3, current: null });
    expect(inventory.characters[0]).toMatchObject({ file: 'default_Seraphina.png', sprites: 2 });

    const items: MigrationItem[] = [];
    const done = await runStMigration(
      { db, assets, importer },
      user,
      {
        ...NONE,
        backgrounds: true,
        characters: ['default_Seraphina.png'],
        chats: ['default_Seraphina/a.jsonl'],
      },
      (item) => {
        items.push(item);
      },
    );
    expect(items.map((item) => `${item.category}:${item.file}:${item.status}`)).toEqual([
      // 文件名按 localeCompare 排序（中文在前）
      'backgrounds:黄金庭院.png:imported',
      'backgrounds:bedroom clean.jpg:imported',
      'backgrounds:broken.png:failed',
      'characters:default_Seraphina.png:imported',
      'chats:default_Seraphina/a.jsonl:imported',
    ]);
    expect(done.counts['backgrounds']).toEqual({ imported: 2, skipped: 0, failed: 1 });
    expect(items[3]?.message).toBe('立绘 2 张');

    const backgrounds = (await (await app.request('/api/backgrounds')).json()) as {
      assetId: string;
      name: string;
    }[];
    expect(backgrounds.map((item) => item.name).sort()).toEqual(
      ['bedroom clean', '黄金庭院'].sort(),
    );
    const bedroom = backgrounds.find((item) => item.name === 'bedroom clean');

    const characterId = items[3]?.id as string;
    const sprites = (await (
      await app.request(`/api/characters/${characterId}/sprites`)
    ).json()) as {
      label: string;
    }[];
    expect(sprites.map((item) => item.label)).toEqual(['joy', 'neutral']);

    const chat = (await (await app.request(`/api/chats/${items[4]?.id as string}`)).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(chat.metadata['background']).toBe(bedroom?.assetId);

    // 再扫一次：都在库里了；再跑一次背景全是 skipped
    expect(scanStDirectory(db, user).backgrounds).toEqual({ count: 3, newCount: 1, current: null });
    const again: MigrationItem[] = [];
    await runStMigration({ db, assets, importer }, user, { ...NONE, backgrounds: true }, (item) => {
      again.push(item);
    });
    expect(again.map((item) => item.status)).toEqual(['skipped', 'skipped', 'failed']);
  });

  it('custom_background 路径：系统背景 / 聊天专属背景（user/images）/ 外部地址', () => {
    expect(stCustomBackgroundRef('url("backgrounds/bedroom%20clean.jpg")')).toBe(
      'backgrounds/bedroom clean.jpg',
    );
    // ST generateUrlParameter(bg, isCustom=true) 用 encodeURI
    expect(stCustomBackgroundRef('url("user/images/%E5%A5%B9/a%20b.png")')).toBe(
      'user/images/她/a b.png',
    );
    expect(stCustomBackgroundRef('x.webp')).toBe('backgrounds/x.webp');
    expect(stCustomBackgroundRef('url("https://example.com/a.png")')).toBeNull();
    expect(stCustomBackgroundRef('url("data:image/png;base64,AAAA")')).toBeNull();
    expect(stCustomBackgroundRef('')).toBeNull();
  });

  it('ST 当前全局背景 → 全局默认；聊天专属背景随聊天收进背景库；对不上的给告警', async () => {
    const { app, db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const user = makeStUser();
    write(
      path.join(user, 'settings.json'),
      JSON.stringify({
        power_user: {},
        background: { name: 'bedroom clean.jpg', url: 'url("backgrounds/bedroom%20clean.jpg")' },
      }),
    );
    write(path.join(user, 'user', 'images', 'Seraphina', '雨夜.png'), png('rainy'));
    const chatLine = (custom: string) =>
      [
        {
          user_name: 'unused',
          character_name: 'unused',
          chat_metadata: { custom_background: custom },
        },
        {
          name: 'Seraphina',
          is_user: false,
          send_date: '2026-01-01T02:00:00.000Z',
          mes: '你好',
          extra: {},
        },
      ]
        .map((line) => JSON.stringify(line))
        .join('\n');
    write(
      path.join(user, 'chats', 'default_Seraphina', 'own.jsonl'),
      chatLine('url("user/images/Seraphina/%E9%9B%A8%E5%A4%9C.png")'),
    );
    write(
      path.join(user, 'chats', 'default_Seraphina', 'missing.jsonl'),
      chatLine('url("backgrounds/gone.jpg")'),
    );

    const inventory = scanStDirectory(db, user);
    expect(inventory.backgrounds.current).toBe('bedroom clean.jpg');

    const items: MigrationItem[] = [];
    const done = await runStMigration(
      { db, assets, importer },
      user,
      {
        ...NONE,
        backgrounds: true,
        defaultBackground: true,
        chats: ['default_Seraphina/own.jsonl', 'default_Seraphina/missing.jsonl'],
      },
      (item) => {
        items.push(item);
      },
    );
    const settingItem = items.find((item) => item.file === 'defaultBackground');
    expect(settingItem).toMatchObject({
      category: 'settings',
      status: 'imported',
      message: 'bedroom clean',
    });
    const setting = (await (await app.request('/api/settings')).json()) as Record<string, unknown>;
    const library = (await (await app.request('/api/backgrounds')).json()) as {
      assetId: string;
      name: string;
    }[];
    expect(setting['defaultBackground']).toBe(
      library.find((item) => item.name === 'bedroom clean')?.assetId,
    );

    const own = items.find((item) => item.file === 'default_Seraphina/own.jsonl');
    const ownChat = (await (await app.request(`/api/chats/${own?.id as string}`)).json()) as {
      metadata: Record<string, unknown>;
    };
    const rainy = library.find((item) => item.name === '雨夜');
    expect(rainy).toBeDefined();
    expect(ownChat.metadata['background']).toBe(rainy?.assetId);

    const missing = items.find((item) => item.file === 'default_Seraphina/missing.jsonl');
    expect(missing?.status).toBe('imported');
    expect(missing?.message).toContain('backgrounds/gone.jpg');
    const missingChat = (await (
      await app.request(`/api/chats/${missing?.id as string}`)
    ).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(missingChat.metadata['background']).toBeUndefined();
    expect(done.warnings.some((warning) => warning.includes('gone.jpg'))).toBe(true);
  });

  it('没勾背景时：全局默认只认库里已有的同一张', async () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const user = makeStUser();
    write(
      path.join(user, 'settings.json'),
      JSON.stringify({
        power_user: {},
        background: { url: 'url("backgrounds/bedroom%20clean.jpg")' },
      }),
    );
    // 老版本只有 url：一样认得出
    expect(scanStDirectory(db, user).backgrounds.current).toBe('bedroom clean.jpg');
    const items: MigrationItem[] = [];
    await runStMigration(
      { db, assets, importer },
      user,
      { ...NONE, defaultBackground: true },
      (item) => {
        items.push(item);
      },
    );
    expect(items).toEqual([
      expect.objectContaining({ file: 'defaultBackground', status: 'skipped' }),
    ]);
  });
});

/**
 * 可选：本机真实 ST 数据（`NT_ST_DATA_DIR` 指向 data/<user>，只读）。
 * 背景全部导入无 failed；Seraphina 的立绘按文件名导入。
 */
const realDir = process.env.NT_ST_DATA_DIR;
describe.skipIf(!realDir || !fs.existsSync(realDir))('本机真实 ST 数据：背景与立绘', () => {
  it('backgrounds/ 全部导入；Seraphina 立绘', { timeout: 120_000 }, async () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const resolved = resolveStRoot(realDir as string);
    if ('users' in resolved) throw new Error('NT_ST_DATA_DIR 请指向单个用户目录');
    const inventory = scanStDirectory(db, resolved.root);
    const seraphina = inventory.characters.find((item) => item.name === 'Seraphina');
    const items: MigrationItem[] = [];
    await runStMigration(
      { db, assets, importer },
      resolved.root,
      { ...NONE, backgrounds: true, characters: seraphina ? [seraphina.file] : [] },
      (item) => {
        items.push(item);
      },
    );
    const bg = items.filter((item) => item.category === 'backgrounds');
    console.log(
      `[real-media] 背景 ${inventory.backgrounds.count} 张：导入 ${bg.filter((i) => i.status === 'imported').length}、` +
        `跳过 ${bg.filter((i) => i.status === 'skipped').length}、失败 ${bg.filter((i) => i.status === 'failed').length}；` +
        `Seraphina 立绘 ${seraphina?.sprites ?? 0} 张 → ${items.find((i) => i.category === 'characters')?.message ?? '无'}`,
    );
    expect(bg.filter((item) => item.status === 'failed')).toEqual([]);
    expect(bg.length).toBe(inventory.backgrounds.count);
    if (seraphina?.sprites) {
      expect(items.find((item) => item.category === 'characters')?.message).toBe(
        `立绘 ${seraphina.sprites} 张`,
      );
    }
  });
});
