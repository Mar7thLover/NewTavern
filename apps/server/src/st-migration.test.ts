import fs from 'node:fs';
import path from 'node:path';

import { parseCardJson, parseChatJsonl, writeCardToPng } from '@newtavern/compat';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { exportStChat } from './services/chat-transfer.js';
import { createImporter } from './services/importer.js';
import { createAssetsService } from './services/assets.js';
import {
  resolveStRoot,
  runStMigration,
  scanStDirectory,
  type MigrationItem,
  type MigrationSelect,
  type StInventory,
} from './services/st-migration.js';
import { readVariableTable } from './services/variables.js';
import { makeTempDataDir, makeTestApp, parseSse, type TestApp } from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const LOCAL = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
const LAN = { incoming: { socket: { remoteAddress: '192.168.1.20' } } };

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const write = (file: string, content: string | Uint8Array) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

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

/** 迷你 ST 目录：data/default-user（完整）+ data/other-user（只有 characters/） */
function makeStTree(): { stRoot: string; user: string } {
  const stRoot = fs.mkdtempSync(path.join(dataDir, 'st-'));
  const user = path.join(stRoot, 'data', 'default-user');
  fs.mkdirSync(path.join(stRoot, 'data', 'other-user', 'characters'), { recursive: true });
  fs.mkdirSync(path.join(stRoot, 'data', '_storage'), { recursive: true });

  write(path.join(user, 'characters', 'Alice.png'), card('爱丽丝'));
  write(path.join(user, 'characters', 'Broken.png'), new Uint8Array([1, 2, 3]));
  const header = {
    user_name: '我',
    character_name: '爱丽丝',
    create_date: '2026-01-01@10h00m00s',
    chat_metadata: { world_info: '城市' },
  };
  const chat = [
    header,
    {
      name: '爱丽丝',
      is_user: false,
      send_date: '2026-01-01T02:00:00.000Z',
      mes: '你好',
      extra: {},
      swipe_id: 0,
      swipes: ['你好'],
      swipe_info: [{ send_date: '2026-01-01T02:00:00.000Z', extra: {} }],
    },
    {
      name: '我',
      is_user: true,
      send_date: '2026-01-01T02:01:00.000Z',
      mes: '看这个',
      extra: { image: '/user/images/爱丽丝/pic.png' },
    },
  ];
  write(
    path.join(user, 'chats', 'Alice', 'Alice - 1.jsonl'),
    chat.map((line) => JSON.stringify(line)).join('\n'),
  );
  write(
    path.join(user, 'chats', 'Ghost', 'orphan.jsonl'),
    JSON.stringify({ ...header, character_name: '幽灵' }),
  );
  write(path.join(user, 'user', 'images', '爱丽丝', 'pic.png'), card('pic'));
  write(path.join(user, 'group chats', 'g.jsonl'), '{}');

  write(
    path.join(user, 'OpenAI Settings', 'Fancy.json'),
    JSON.stringify({ name: 'Fancy_v1', temperature: 0.7, prompts: [] }),
  );
  write(path.join(user, 'OpenAI Settings', 'Bad.json'), '{not json');
  write(
    path.join(user, 'worlds', '城市.json'),
    JSON.stringify({ entries: { '0': { uid: 0, key: ['钟楼'], content: '城市中心' } } }),
  );
  write(path.join(user, 'User Avatars', 'me.png'), card('me'));

  write(
    path.join(user, 'settings.json'),
    JSON.stringify({
      power_user: {
        personas: { 'me.png': '我', 'ghost.png': '无头像' },
        persona_descriptions: {
          'me.png': {
            description: '一名旅人',
            title: '过路人',
            position: 4,
            depth: 3,
            role: 1,
            lorebook: '城市',
          },
          'ghost.png': { description: '', position: 1 },
        },
        default_persona: 'me.png',
      },
      extension_settings: {
        regex: [
          { id: 'a', scriptName: '去星号', findRegex: '/\\*/g', replaceString: '', placement: [2] },
          { id: 'b', scriptName: '去井号', findRegex: '/#/g', replaceString: '' },
          { nope: true },
        ],
      },
      world_info_settings: {
        world_info: { globalSelect: ['城市', '不存在的书'] },
        world_info_depth: 5,
        world_info_budget: 40,
        world_info_recursive: false,
        world_info_include_names: false,
        world_info_match_whole_words: false,
      },
    }),
  );
  write(path.join(user, 'backgrounds', 'a.jpg'), 'x');
  write(path.join(user, 'backgrounds', 'b.png'), 'x');
  write(path.join(user, 'themes', 'Dark.json'), '{}');
  write(path.join(user, 'context', 'ChatML.json'), '{}');
  write(path.join(user, 'QuickReplies', 'Default.json'), '{}');
  // 真正的 ST 目录里也有 secrets.json：迁移不该碰它
  write(path.join(user, 'secrets.json'), '{"api_key_openai":"sk-should-not-be-read"}');
  return { stRoot, user };
}

const selectAll = (inventory: StInventory): MigrationSelect => ({
  characters: inventory.characters.filter((item) => !item.error).map((item) => item.file),
  chats: inventory.chats.map((item) => item.file),
  presets: inventory.presets.filter((item) => !item.error).map((item) => item.file),
  lorebooks: inventory.lorebooks.filter((item) => !item.error).map((item) => item.file),
  personas: inventory.personas.map((item) => item.avatar),
  regex: true,
  scripts: true,
  worldInfo: true,
  defaultPersona: true,
  // 背景库另有 st-migration-media.test.ts 覆盖
  backgrounds: false,
  defaultBackground: false,
});

describe('ST 目录识别', () => {
  it('根目录 / data / 用户目录；多个用户时返回候选；不像 ST 的报错', () => {
    const { stRoot, user } = makeStTree();
    expect(resolveStRoot(user)).toEqual({ root: user });
    expect(resolveStRoot(`"${user}"`)).toEqual({ root: user });
    const multi = resolveStRoot(stRoot);
    expect('users' in multi && multi.users.map((u) => u.name)).toEqual([
      'default-user',
      'other-user',
    ]);
    expect('users' in resolveStRoot(path.join(stRoot, 'data'))).toBe(true);
    fs.rmSync(path.join(stRoot, 'data', 'other-user'), { recursive: true });
    expect(resolveStRoot(stRoot)).toEqual({ root: user });
    expect(() => resolveStRoot(path.join(stRoot, 'nope'))).toThrow(/找不到/);
    expect(() => resolveStRoot(path.join(user, 'worlds'))).toThrow(/不像 SillyTavern/);
    expect(() => resolveStRoot('  ')).toThrow(/请填写/);
  });
});

describe('迁移接口只允许本机', () => {
  it('非回环对端、局域网 Origin / Referer、转发头都 403', async () => {
    const { app } = makeTestApp(dataDir);
    const forbidden = await app.request('/api/migration/access', {}, LAN);
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({
      error: 'forbidden',
      message: '迁移会读取这台电脑上的文件夹，只能在运行服务端的电脑上打开本页操作',
    });
    expect((await app.request('/api/migration/access')).status).toBe(403);
    expect((await app.request('/api/migration/access', {}, LOCAL)).status).toBe(200);
    expect(
      (
        await app.request(
          '/api/migration/access',
          { headers: { referer: 'http://localhost:5173/migration' } },
          LOCAL,
        )
      ).status,
    ).toBe(200);
    const lanHeaders: Record<string, string>[] = [
      { origin: 'http://192.168.1.20:5173' },
      { referer: 'http://192.168.1.20:5173/migration' },
      { 'x-forwarded-for': '192.168.1.20' },
      { origin: 'https://evil.example' },
    ];
    for (const headers of lanHeaders) {
      const res = await app.request('/api/migration/st/scan', post({ path: '.' }, headers), LOCAL);
      expect(res.status).toBe(403);
    }
    const v6 = { incoming: { socket: { remoteAddress: '::ffff:127.0.0.1' } } };
    expect((await app.request('/api/migration/access', {}, v6)).status).toBe(200);
  });
});

describe('扫描与迁移', () => {
  it('清单 → 全选迁移 → 再扫描全部「已在库中」', async () => {
    const testApp: TestApp = makeTestApp(dataDir);
    const { app, db } = testApp;
    const { stRoot, user } = makeStTree();

    const multi = await app.request('/api/migration/st/scan', post({ path: stRoot }), LOCAL);
    expect(((await multi.json()) as { users: unknown[] }).users).toHaveLength(2);

    const scanRes = await app.request('/api/migration/st/scan', post({ path: user }), LOCAL);
    expect(scanRes.status).toBe(200);
    const inventory = (await scanRes.json()) as StInventory;
    expect(inventory.root).toBe(user);
    expect(inventory.characters).toEqual([
      { file: 'Alice.png', name: '爱丽丝', exists: false, chatCount: 1 },
      expect.objectContaining({ file: 'Broken.png', name: 'Broken', exists: false, chatCount: 0 }),
    ]);
    expect(inventory.characters[1]?.error).toBeTruthy();
    expect(inventory.chats).toEqual([
      {
        file: 'Alice/Alice - 1.jsonl',
        characterFile: 'Alice.png',
        title: 'Alice - 1',
        exists: false,
      },
      { file: 'Ghost/orphan.jsonl', characterFile: null, title: 'orphan', exists: false },
    ]);
    expect(inventory.groupChats).toBe(1);
    expect(inventory.presets).toEqual([
      expect.objectContaining({
        file: 'Bad.json',
        name: 'Bad',
        exists: false,
        error: '不是有效的 JSON',
      }),
      { file: 'Fancy.json', name: 'Fancy', exists: false },
    ]);
    expect(inventory.lorebooks).toEqual([
      { file: '城市.json', name: '城市', entryCount: 1, exists: false },
    ]);
    expect(inventory.regex).toEqual({ count: 2, newCount: 2 });
    expect(inventory.personas).toEqual([
      { avatar: 'me.png', name: '我', exists: false },
      { avatar: 'ghost.png', name: '无头像', exists: false },
    ]);
    expect(inventory.defaultPersona).toBe('me.png');
    expect(inventory.worldInfo).toEqual({ globalBooks: ['城市', '不存在的书'], hasSettings: true });
    // 背景从 M4（二）起迁移（§A.5）：两个假文件都算进清单，内容不是图片，迁移时会 failed
    expect(inventory.backgrounds).toEqual({ count: 2, newCount: 2, current: null });
    expect(inventory.skipped).toEqual({
      instruct: 0,
      context: 1,
      themes: 1,
      quickReplies: 1,
    });

    const bad = await app.request(
      '/api/migration/st/run',
      post({ path: stRoot, select: {} }),
      LOCAL,
    );
    expect(bad.status).toBe(400);

    const select = {
      ...selectAll(inventory),
      presets: ['Fancy.json', 'Bad.json', '../secrets.json'],
    };
    const runRes = await app.request('/api/migration/st/run', post({ path: user, select }), LOCAL);
    expect(runRes.status).toBe(200);
    const events = parseSse(await runRes.text());
    expect(events[0]).toEqual({ event: 'start', data: { total: 13 } });
    const items = events
      .filter((e) => e.event === 'item')
      .map((e) => e.data as unknown as MigrationItem);
    const done = events.find((e) => e.event === 'done')?.data as {
      counts: Record<string, { imported: number; skipped: number; failed: number }>;
      warnings: string[];
    };
    expect(items.map((item) => `${item.category}:${item.file}:${item.status}`)).toEqual([
      'lorebooks:城市.json:imported',
      'characters:Alice.png:imported',
      'personas:me.png:imported',
      'personas:ghost.png:imported',
      'presets:Fancy.json:imported',
      'presets:Bad.json:failed',
      'presets:../secrets.json:failed',
      'regex:去星号:imported',
      'regex:去井号:imported',
      'settings:worldInfo:imported',
      'settings:defaultPersona:imported',
      'chats:Alice/Alice - 1.jsonl:imported',
      'chats:Ghost/orphan.jsonl:imported',
    ]);
    expect(items.find((item) => item.file === '../secrets.json')?.message).toContain(
      '非法的文件名',
    );
    expect(done.counts['presets']).toEqual({ imported: 1, skipped: 0, failed: 2 });
    expect(done.warnings.join('\n')).toContain('不存在的书');
    expect(done.warnings.join('\n')).toContain('orphan：库里没有名为「幽灵」的角色');

    // 角色、书、档案、设置
    const book = db.select().from(schema.lorebooks).where(eq(schema.lorebooks.name, '城市')).get();
    const persona = db.select().from(schema.personas).where(eq(schema.personas.name, '我')).get();
    expect(persona).toMatchObject({
      description: '一名旅人',
      title: '过路人',
      descriptionPosition: 'at_depth',
      depth: 3,
      role: 'user',
      lorebookId: book?.id,
    });
    expect(persona?.avatarAssetId).toBeTruthy();
    expect(
      db.select().from(schema.personas).where(eq(schema.personas.name, '无头像')).get(),
    ).toMatchObject({
      avatarAssetId: null,
      descriptionPosition: 'in_prompt',
    });
    expect(items.find((item) => item.file === 'ghost.png')?.message).toContain('头像文件不存在');
    const preset = db.select().from(schema.presets).get();
    expect(preset?.name).toBe('Fancy');

    const settings = (await (await app.request('/api/settings')).json()) as Record<string, unknown>;
    expect(settings['defaultPersonaId']).toBe(persona?.id);
    expect(settings['worldInfo.globalBookIds']).toEqual([book?.id]);
    expect(settings['worldInfo.settings']).toMatchObject({
      scanDepth: 5,
      budgetPercent: 40,
      recursive: false,
      includeNames: false,
      matchWholeWords: false,
    });
    expect(
      db
        .select()
        .from(schema.regexScripts)
        .all()
        .map((row) => row.scriptName),
    ).toEqual(['去星号', '去井号']);

    // 聊天：绑定这次导入的角色与世界书；图片从 user/images 读进来
    const chatId = items.find((item) => item.file === 'Alice/Alice - 1.jsonl')?.id as string;
    const chat = (await (await app.request(`/api/chats/${chatId}`)).json()) as {
      character: { name: string } | null;
      lorebookIds: string[];
      nodes: { role: string; parts: { type: string }[] }[];
    };
    expect(chat.character?.name).toBe('爱丽丝');
    expect(chat.lorebookIds).toEqual([book?.id]);
    expect(chat.nodes.find((node) => node.role === 'user')?.parts.map((part) => part.type)).toEqual(
      ['text', 'image'],
    );

    // 再扫一遍：全部已在库中，正则无新增
    const again = (await (
      await app.request('/api/migration/st/scan', post({ path: user }), LOCAL)
    ).json()) as StInventory;
    expect(again.characters[0]?.exists).toBe(true);
    expect(again.chats.every((item) => item.exists)).toBe(true);
    expect(again.presets.find((item) => item.file === 'Fancy.json')?.exists).toBe(true);
    expect(again.lorebooks[0]?.exists).toBe(true);
    expect(again.personas).toEqual([
      { avatar: 'me.png', name: '我', exists: true },
      { avatar: 'ghost.png', name: '无头像', exists: true },
    ]);
    expect(again.regex).toEqual({ count: 2, newCount: 0 });

    // 已有的正则再跑一次是 skipped；未勾选角色但库里同 hash 的角色照样关联
    const second = await app.request(
      '/api/migration/st/run',
      post({
        path: user,
        select: { characters: [], chats: ['Alice/Alice - 1.jsonl'], regex: true },
      }),
      LOCAL,
    );
    const secondItems = parseSse(await second.text())
      .filter((e) => e.event === 'item')
      .map((e) => e.data as unknown as MigrationItem);
    expect(secondItems.map((item) => item.status)).toEqual(['skipped', 'skipped', 'imported']);
    const secondChat = (await (
      await app.request(`/api/chats/${secondItems[2]?.id as string}`)
    ).json()) as { character: { name: string } | null };
    expect(secondChat.character?.name).toBe('爱丽丝');
  });
});

/**
 * 可选：本机真实 ST 数据（`NT_ST_DATA_DIR` 指向 data/<user>）。
 * 扫描 + 全选迁移到临时库无 failed；每份聊天导入后导出与原文件 deep-equal。
 * 不打印任何内容文本，只打数量。
 */
const realDir = process.env.NT_ST_DATA_DIR;
describe.skipIf(!realDir || !fs.existsSync(realDir))('本机真实 ST 数据', () => {
  it('scan + run 全选无 failed；聊天导入导出 deep-equal', { timeout: 300_000 }, async () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const resolved = resolveStRoot(realDir as string);
    if ('users' in resolved) throw new Error('NT_ST_DATA_DIR 请指向单个用户目录');
    const inventory = scanStDirectory(db, resolved.root);
    const select = selectAll(inventory);
    const items: MigrationItem[] = [];
    const done = await runStMigration({ db, assets, importer }, resolved.root, select, (item) => {
      items.push(item);
    });
    const failed = items.filter((item) => item.status === 'failed');
    console.log(
      `[real-migration] 角色 ${select.characters.length}、聊天 ${select.chats.length}、预设 ${select.presets.length}、` +
        `世界书 ${select.lorebooks.length}、档案 ${select.personas.length}、正则 ${inventory.regex.count}；` +
        `导入 ${items.filter((i) => i.status === 'imported').length}、跳过 ${items.filter((i) => i.status === 'skipped').length}、` +
        `失败 ${failed.length}；告警 ${done.warnings.length}`,
    );
    expect(failed.map((item) => `${item.category}:${item.file}:${item.message ?? ''}`)).toEqual([]);

    let compared = 0;
    for (const item of items) {
      if (item.category !== 'chats' || !item.id) continue;
      const original = fs.readFileSync(path.join(resolved.root, 'chats', item.file), 'utf8');
      const exported = exportStChat(db, item.id);
      expect(exported?.droppedBranches).toBe(0);
      const back = parseChatJsonl(new TextDecoder().decode(exported?.bytes));
      expect(back).toEqual(parseChatJsonl(original));
      compared++;
    }
    console.log(`[real-migration] 聊天导入→导出 deep-equal：${compared} 份`);
    expect(compared).toBe(select.chats.length);
  });
});

/** 酒馆助手的全局脚本（M5（三）§2.1）：新格式脚本树与旧格式 scriptsRepository 都认 */
describe('酒馆助手脚本迁移', () => {
  const helperTree = (root: string, extension: Record<string, unknown>) => {
    const user = path.join(root, 'data', 'default-user');
    write(path.join(user, 'characters', '.keep'), '');
    write(
      path.join(user, 'OpenAI Settings', '带脚本.json'),
      JSON.stringify({
        temperature: 1,
        prompts: [],
        extensions: {
          tavern_helper: {
            scripts: [
              {
                type: 'script',
                id: 'p1',
                name: '悬浮球',
                enabled: true,
                content: 'console.log(1)',
              },
              { type: 'script', id: 'p2', name: '关着的', enabled: false, content: 'x' },
            ],
            variables: { 计数: 3, 名单: ['甲'] },
          },
        },
      }),
    );
    write(path.join(user, 'settings.json'), JSON.stringify({ extension_settings: extension }));
    return user;
  };

  it('新格式：保持启用状态、文件夹展平、预设允许名单照搬、重跑跳过', async () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const user = helperTree(fs.mkdtempSync(path.join(dataDir, 'st-helper-')), {
      tavern_helper: {
        script: {
          enabled: { global: true, presets: ['带脚本'], characters: [] },
          scripts: [
            { type: 'script', id: 's1', name: '开着的', enabled: true, content: 'a()' },
            {
              type: 'folder',
              id: 'f1',
              name: '工具',
              enabled: false,
              scripts: [
                { type: 'script', id: 's2', name: '夹里的', enabled: true, content: 'b()' },
              ],
            },
          ],
        },
      },
    });
    const inventory = scanStDirectory(db, user);
    expect(inventory.scripts).toEqual({ count: 2, newCount: 2, globalEnabled: true });
    // 预设自带脚本在清单里报数；在酒馆助手的启用名单里
    expect(inventory.presets.find((item) => item.file === '带脚本.json')).toMatchObject({
      scripts: 2,
      scriptsEnabled: true,
    });

    const select: MigrationSelect = {
      ...selectAll(inventory),
      chats: [],
      presets: ['带脚本.json'],
      regex: false,
      worldInfo: false,
      defaultPersona: false,
    };
    const items: MigrationItem[] = [];
    const done = await runStMigration({ db, assets, importer }, user, select, (item) => {
      items.push(item);
    });
    expect(items.filter((item) => item.category === 'scripts').map((item) => item.status)).toEqual([
      'imported',
      'imported',
    ]);
    expect(done.counts.scripts).toEqual({ imported: 2, skipped: 0, failed: 0 });

    const globals = db
      .select()
      .from(schema.scripts)
      .where(eq(schema.scripts.scope, 'global'))
      .all();
    const byName = new Map(globals.map((row) => [row.name, row]));
    expect(byName.get('开着的')?.enabled).toBe(true);
    // 文件夹关着 → 里面的脚本也关着；文件夹名进 data.folder
    expect(byName.get('夹里的')?.enabled).toBe(false);
    expect((byName.get('夹里的')?.data as { folder?: string }).folder).toBe('工具');

    // 预设在 script.enabled.presets 里：自带脚本按原件开关启用
    const presetRows = db
      .select()
      .from(schema.scripts)
      .where(eq(schema.scripts.scope, 'preset'))
      .all();
    expect(Object.fromEntries(presetRows.map((row) => [row.name, row.enabled]))).toEqual({
      悬浮球: true,
      关着的: false,
    });

    // 预设自带的 tavern_helper.variables 作 preset 作用域的初值
    const presetRow = db.select().from(schema.presets).get();
    expect(readVariableTable(db, 'preset', presetRow?.id as string)).toEqual({
      计数: 3,
      名单: ['甲'],
    });

    expect(scanStDirectory(db, user).scripts.newCount).toBe(0);
    const again: MigrationItem[] = [];
    await runStMigration({ db, assets, importer }, user, { ...select, presets: [] }, (item) => {
      again.push(item);
    });
    expect(again.map((item) => item.status)).toEqual(['skipped', 'skipped']);
  });

  it('旧格式 TavernHelper_settings；总开关关着时全部导成关闭并给告警', async () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const importer = createImporter(db, assets, dataDir);
    const user = helperTree(fs.mkdtempSync(path.join(dataDir, 'st-helper-old-')), {
      TavernHelper_settings: {
        script: {
          global_script_enabled: false,
          scriptsRepository: [
            {
              type: 'script',
              value: {
                id: 'old1',
                name: '旧脚本',
                enabled: true,
                content: 'c()',
                buttons: [{ name: '按钮', visible: true }],
              },
            },
          ],
        },
      },
    });
    const inventory = scanStDirectory(db, user);
    expect(inventory.scripts).toEqual({ count: 1, newCount: 1, globalEnabled: false });
    const done = await runStMigration(
      { db, assets, importer },
      user,
      {
        ...selectAll(inventory),
        chats: [],
        presets: [],
        regex: false,
        worldInfo: false,
        defaultPersona: false,
      },
      () => undefined,
    );
    expect(done.warnings.join('\n')).toContain('总开关');
    const row = db.select().from(schema.scripts).get();
    expect(row).toMatchObject({ name: '旧脚本', enabled: false, scope: 'global' });
    expect(row?.buttons).toEqual([{ name: '按钮', visible: true }]);
  });
});
