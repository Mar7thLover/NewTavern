import fs from 'node:fs';
import { deflateRawSync } from 'node:zlib';

import { writeCardToPng, writeCharx, type V3Card } from '@newtavern/compat';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import {
  expressionSourceText,
  parseExpressionReply,
} from './services/expression.js';
import { labelFromFileName, normalizeSpriteLabel } from './services/sprites.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
  type TestApp,
} from './test-helpers.js';

/** 背景库、立绘、表情选择（M4（二）契约 §A §B） */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type App = TestApp['app'];

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** 一张「PNG」：真签名 + IHDR（宽高）+ 一段区分内容的尾巴（内容寻址去重，每张要不同） */
function png(tag: string, width = 4, height = 6): Uint8Array {
  const head = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
    0, 0, 0, width, 0, 0, 0, height, 8, 6, 0, 0, 0,
  ];
  return new Uint8Array([...head, ...new TextEncoder().encode(tag)]);
}

function upload(app: App, url: string, fileName: string, bytes: Uint8Array, method = 'POST') {
  const form = new FormData();
  form.append('file', new File([bytes.slice()], fileName));
  return app.request(url, { method, body: form });
}

/** 最小 zip 写入（测试用）：deflate 条目 + 中央目录 */
function makeZip(entries: [string, Uint8Array][]): Uint8Array {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14); // CRC 不校验
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, centralBuf, eocd]));
}

function insertCharacter(db: TestApp['db'], name = '塞拉菲娜'): string {
  return db
    .insert(schema.characters)
    .values({
      name,
      spec: 'v3',
      data: { name, description: '', personality: '', scenario: '', first_mes: '你好。', mes_example: '' },
      tags: [],
    })
    .returning()
    .get().id;
}

interface BackgroundJson {
  assetId: string;
  name: string;
  width: number | null;
  height: number | null;
  createdAt: string;
}

describe('背景库', () => {
  it('上传 / 列表 / 重命名 / 删除，删除时清掉 settings 引用；会话绑定走 chats PATCH', async () => {
    const { app, db } = makeTestApp(dataDir);

    const first = await upload(app, '/api/backgrounds', '黄金庭院.png', png('garden', 16, 9));
    expect(first.status).toBe(201);
    const garden = (await first.json()) as BackgroundJson;
    expect(garden).toMatchObject({ name: '黄金庭院', width: 16, height: 9 });

    const second = (await (
      await upload(app, '/api/backgrounds', 'dir/bedroom clean.jpg', png('bedroom'))
    ).json()) as BackgroundJson;
    expect(second.name).toBe('bedroom clean');

    // 不是图片 / 缺文件
    expect((await upload(app, '/api/backgrounds', 'x.png', new TextEncoder().encode('nope'))).status).toBe(400);
    expect((await app.request('/api/backgrounds', { method: 'POST' })).status).toBe(400);

    const list = (await (await app.request('/api/backgrounds')).json()) as BackgroundJson[];
    expect(list.map((item) => item.assetId).sort()).toEqual([garden.assetId, second.assetId].sort());

    const renamed = await app.request(`/api/backgrounds/${garden.assetId}`, json('PATCH', { name: ' 庭院 ' }));
    expect(((await renamed.json()) as BackgroundJson).name).toBe('庭院');
    expect((await app.request(`/api/backgrounds/${garden.assetId}`, json('PATCH', { name: '' }))).status).toBe(400);
    expect((await app.request('/api/backgrounds/missing', json('PATCH', { name: 'x' }))).status).toBe(404);

    // 已经以别的身份入库的同一张图（聊天附件）：只打背景标记，删除时文件还在
    const attachmentBytes = png('attachment');
    const form = new FormData();
    form.append('file', new File([attachmentBytes.slice()], 'a.png', { type: 'image/png' }));
    const attached = await app.request('/api/assets', { method: 'POST', body: form });
    const attachedId = attached.ok ? ((await attached.json()) as { id: string }).id : null;
    const dup = (await (
      await upload(app, '/api/backgrounds', '附件.png', attachmentBytes)
    ).json()) as BackgroundJson;
    if (attachedId) expect(dup.assetId).toBe(attachedId);

    // 全局 / 角色默认 → 删除时清掉
    const characterId = insertCharacter(db);
    await app.request('/api/settings/defaultBackground', json('PUT', garden.assetId));
    await app.request(
      '/api/settings/backgroundByCharacter',
      json('PUT', { [characterId]: garden.assetId, other: second.assetId }),
    );

    // 会话绑定：PATCH metadata.background，读取原样返回；'none' 也可以
    const chat = (await (
      await app.request('/api/chats', json('POST', { characterIds: [characterId] }))
    ).json()) as { id: string };
    const patched = (await (
      await app.request(`/api/chats/${chat.id}`, json('PATCH', { metadata: { background: garden.assetId } }))
    ).json()) as { metadata: Record<string, unknown> };
    expect(patched.metadata['background']).toBe(garden.assetId);
    const read = (await (await app.request(`/api/chats/${chat.id}`)).json()) as {
      metadata: Record<string, unknown>;
    };
    expect(read.metadata['background']).toBe(garden.assetId);
    await app.request(`/api/chats/${chat.id}`, json('PATCH', { metadata: { background: 'none' } }));
    expect(
      ((await (await app.request(`/api/chats/${chat.id}`)).json()) as { metadata: Record<string, unknown> })
        .metadata['background'],
    ).toBe('none');

    expect((await app.request(`/api/backgrounds/${garden.assetId}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/backgrounds/${garden.assetId}`, { method: 'DELETE' })).status).toBe(404);
    expect((await app.request('/api/settings/defaultBackground')).status).toBe(404);
    const byCharacter = (await (await app.request('/api/settings/backgroundByCharacter')).json()) as {
      value: Record<string, string>;
    };
    expect(byCharacter.value).toEqual({ other: second.assetId });

    await app.request(`/api/backgrounds/${dup.assetId}`, { method: 'DELETE' });
    const after = (await (await app.request('/api/backgrounds')).json()) as BackgroundJson[];
    expect(after.map((item) => item.assetId)).toEqual([second.assetId]);
    if (attachedId) {
      // 附件那一行还在，只是不再算背景
      expect(db.select().from(schema.assets).where(eq(schema.assets.id, attachedId)).get()).toBeTruthy();
    }
  });
});

describe('立绘', () => {
  it('标签规则', () => {
    expect(normalizeSpriteLabel(' Joy ')).toBe('joy');
    expect(normalizeSpriteLabel('happy_2')).toBe('happy_2');
    expect(normalizeSpriteLabel('开心')).toBe('开心');
    expect(normalizeSpriteLabel('a/b')).toBeNull();
    expect(normalizeSpriteLabel('x'.repeat(33))).toBeNull();
    expect(normalizeSpriteLabel('<script>')).toBeNull();
    expect(labelFromFileName('sprites/Anger.PNG')).toBe('anger');
    expect(labelFromFileName('readme.txt')).toBeNull();
  });

  it('上传 / 覆盖 / 删除 / zip 导入', async () => {
    const { app, db } = makeTestApp(dataDir);
    const id = insertCharacter(db);

    expect((await app.request('/api/characters/missing/sprites')).status).toBe(404);
    const put = await upload(app, `/api/characters/${id}/sprites/Joy`, 'x.png', png('joy-1'), 'PUT');
    expect(put.status).toBe(200);
    const first = (await put.json()) as { label: string; assetId: string };
    expect(first.label).toBe('joy');
    // 同标签覆盖
    const again = (await (
      await upload(app, `/api/characters/${id}/sprites/joy`, 'x.png', png('joy-2'), 'PUT')
    ).json()) as { assetId: string };
    expect(again.assetId).not.toBe(first.assetId);
    expect(
      (await upload(app, `/api/characters/${id}/sprites/${encodeURIComponent('a b/c')}`, 'x.png', png('bad'), 'PUT')).status,
    ).toBe(400);
    expect(
      (await upload(app, `/api/characters/${id}/sprites/sad`, 'x.png', new TextEncoder().encode('not image'), 'PUT')).status,
    ).toBe(400);

    const zip = makeZip([
      ['Seraphina/neutral.png', png('neutral')],
      ['Seraphina/joy.png', png('joy-zip')],
      ['Seraphina/开心.webp', new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 1, 2])],
      ['Seraphina/notes.txt', new TextEncoder().encode('hi')],
      ['__MACOSX/Seraphina/._joy.png', png('junk')],
    ]);
    const imported = await upload(app, `/api/characters/${id}/sprites/import`, 'pack.zip', zip);
    expect(imported.status).toBe(200);
    const result = (await imported.json()) as {
      imported: string[];
      skipped: { file: string }[];
      sprites: { label: string }[];
    };
    expect(result.imported.sort()).toEqual(['joy', 'neutral', '开心'].sort());
    expect(result.skipped.map((item) => item.file)).toEqual(['Seraphina/notes.txt']);
    expect(result.sprites.map((item) => item.label)).toEqual(['joy', 'neutral', '开心']);

    expect(
      (await upload(app, `/api/characters/${id}/sprites/import`, 'x.zip', new TextEncoder().encode('zip?'))).status,
    ).toBe(400);

    expect((await app.request(`/api/characters/${id}/sprites/joy`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/characters/${id}/sprites/joy`, { method: 'DELETE' })).status).toBe(404);
    const list = (await (await app.request(`/api/characters/${id}/sprites`)).json()) as { label: string }[];
    expect(list.map((item) => item.label)).toEqual(['neutral', '开心']);
  });

  it('导入 CHARX / PNG 卡时，type:emotion 的资源写进立绘表', async () => {
    const { app } = makeTestApp(dataDir);
    const card: V3Card = {
      spec: 'chara_card_v3',
      spec_version: '3.0',
      data: {
        name: '立绘卡',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '嗨',
        mes_example: '',
        assets: [
          { type: 'icon', uri: 'embeded://assets/icon/images/main.png', name: 'main', ext: 'png' },
          { type: 'emotion', uri: 'embeded://assets/emotion/images/joy.png', name: 'joy', ext: 'png' },
          { type: 'emotion', uri: 'embeded://assets/emotion/images/sad.png', name: 'Sadness', ext: 'png' },
          { type: 'emotion', uri: 'embeded://assets/emotion/images/missing.png', name: 'fear', ext: 'png' },
          { type: 'other', uri: 'embeded://assets/other/x.png', name: 'x', ext: 'png' },
        ],
      },
    };
    const charx = writeCharx(
      card,
      new Map([
        ['assets/icon/images/main.png', png('icon')],
        ['assets/emotion/images/joy.png', png('charx-joy')],
        ['assets/emotion/images/sad.png', png('charx-sad')],
        ['assets/other/x.png', png('other')],
      ]),
    );
    const res = await upload(app, '/api/import/character', '立绘卡.charx', charx);
    expect(res.status).toBeLessThan(300);
    const created = (await res.json()) as { id: string };
    const sprites = (await (await app.request(`/api/characters/${created.id}/sprites`)).json()) as {
      label: string;
    }[];
    expect(sprites.map((item) => item.label)).toEqual(['joy', 'sadness']);

    // PNG：RisuAI / ST 的写法——uri `__asset:<key>`，字节在 chara-ext-asset_:<key>
    const pngCard: V3Card = {
      ...card,
      data: {
        ...card.data,
        name: 'PNG 立绘卡',
        assets: [
          { type: 'emotion', uri: '__asset:0', name: 'anger', ext: 'png' },
          { type: 'emotion', uri: '__asset:1', name: '害羞', ext: 'png' },
        ],
      },
    };
    const pngBytes = writeCardToPng(
      null,
      pngCard,
      new Map([
        ['0', png('png-anger')],
        ['1', png('png-shy')],
      ]),
    );
    const pngRes = await upload(app, '/api/import/character', 'png-card.png', pngBytes);
    expect(pngRes.status).toBeLessThan(300);
    const pngCreated = (await pngRes.json()) as { id: string };
    const pngSprites = (await (await app.request(`/api/characters/${pngCreated.id}/sprites`)).json()) as {
      label: string;
    }[];
    expect(pngSprites.map((item) => item.label)).toEqual(['anger', '害羞']);
  });
});

describe('表情选择', () => {
  it('正文清洗与回复解析', () => {
    const text = expressionSourceText([
      { type: 'text', text: '她笑了。\n```js\nconsole.log(1)\n```\n<div class="x">状态栏</div>' },
      { type: 'image', assetId: 'a' },
    ]);
    expect(text).toBe('她笑了。\n\n状态栏');
    expect(expressionSourceText([{ type: 'text', text: '字'.repeat(2000) }])).toHaveLength(1500);
    const labels = ['joy', 'sadness', '开心'];
    expect(parseExpressionReply('{"label":"Joy"}', labels)).toBe('joy');
    expect(parseExpressionReply('sadness.', labels)).toBe('sadness');
    expect(parseExpressionReply('I think it is joy here', labels)).toBe('joy');
    expect(parseExpressionReply('{"label":"开心"}', labels)).toBe('开心');
    expect(parseExpressionReply('anger', labels)).toBeNull();
  });

  it('手动 / 分类（fake adapter）/ 回落', async () => {
    const { app, db } = makeTestApp(dataDir);
    const seen: unknown[] = [];
    registerFakeAdapter({
      id: 'fake-expression',
      stream: async function* (_conn, req) {
        seen.push(req.body);
        yield { type: 'text.delta', text: '{"label": "sadness"}' };
        yield { type: 'stop', reason: 'end' };
      },
    });
    registerFakeAdapter({
      id: 'fake-expression-broken',
      events: [{ type: 'text.delta', text: 'no idea' }],
    });
    const conn = insertConnection(db, dataDir, 'fake-expression');
    await app.request('/api/settings/generation.default', json('PUT', { connectionId: conn.id, model: 'fake-model-1' }));

    const characterId = insertCharacter(db);
    const chat = (await (
      await app.request('/api/chats', json('POST', { characterIds: [characterId] }))
    ).json()) as { id: string; nodes: { id: string; role: string }[] };
    const message = (await (
      await app.request(
        `/api/chats/${chat.id}/messages`,
        json('POST', { role: 'assistant', text: '她低下头，眼泪落在信纸上。' }),
      )
    ).json()) as { node: { id: string } };
    const nodeId = message.node.id;
    const url = `/api/chats/${chat.id}/nodes/${nodeId}/expression`;
    const readExtra = () =>
      db.select().from(schema.messageNodes).where(eq(schema.messageNodes.id, nodeId)).get()?.extra;

    // 角色没有立绘：回落
    const none = (await (await app.request(url, { method: 'POST' })).json()) as { label: string };
    expect(none.label).toBe('neutral');
    expect(seen).toHaveLength(0);

    for (const label of ['neutral', 'sadness', 'joy']) {
      await upload(app, `/api/characters/${characterId}/sprites/${label}`, 'x.png', png(`s-${label}`), 'PUT');
    }

    // 分类：一次短调用，结果写进 extra.expression
    const classified = await app.request(url, json('POST', {}));
    expect(classified.status).toBe(200);
    expect(await classified.json()).toMatchObject({ label: 'sadness', source: 'classify' });
    expect(readExtra()).toMatchObject({ expression: 'sadness' });
    expect(seen).toHaveLength(1);

    // 手动
    const manual = await app.request(url, json('POST', { label: 'Joy' }));
    expect(await manual.json()).toMatchObject({ label: 'joy', source: 'manual' });
    expect(readExtra()).toMatchObject({ expression: 'joy' });
    expect((await app.request(url, json('POST', { label: 'a/b' }))).status).toBe(400);

    // 模型答非所问：回落到 settings.sprites.fallback
    const broken = insertConnection(db, dataDir, 'fake-expression-broken');
    await app.request(
      '/api/settings/sprites',
      json('PUT', { mode: 'classify', connectionId: broken.id, model: 'm', fallback: 'joy' }),
    );
    expect(await (await app.request(url, { method: 'POST' })).json()).toMatchObject({
      label: 'joy',
      source: 'fallback',
    });

    expect((await app.request(`/api/chats/${chat.id}/nodes/missing/expression`, { method: 'POST' })).status).toBe(404);
    expect((await app.request(`/api/chats/missing/nodes/${nodeId}/expression`, { method: 'POST' })).status).toBe(404);
  });
});
