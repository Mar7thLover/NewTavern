import fs from 'node:fs';

import type { ModelCapabilities } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema } from './db/client.js';
import { buildAssembleInput } from './services/assemble-input.js';
import { makeTempDataDir, makeTestApp } from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface PersonaJson {
  id: string;
  name: string;
  title: string;
  descriptionPosition: string;
  depth: number;
  role: string;
  lorebookId: string | null;
  avatarAssetId: string | null;
}

/** 最小 PNG 文件头（8 字节签名 + IHDR），足够通过类型识别 */
const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 4,
  0, 0, 0, 4, 8, 6, 0, 0, 0,
]);

describe('用户档案字段', () => {
  it('新字段默认值与 ST 一致，PUT 校验', async () => {
    const { app } = makeTestApp(dataDir);
    const created = (await (
      await app.request('/api/personas', json('POST', { name: '旅人' }))
    ).json()) as PersonaJson;
    expect(created).toMatchObject({
      title: '',
      descriptionPosition: 'in_prompt',
      depth: 2,
      role: 'system',
      lorebookId: null,
      avatarAssetId: null,
    });

    const updated = await app.request(
      `/api/personas/${created.id}`,
      json('PUT', { title: ' 过路人 ', descriptionPosition: 'at_depth', depth: 4, role: 'user' }),
    );
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      title: '过路人',
      descriptionPosition: 'at_depth',
      depth: 4,
      role: 'user',
    });

    for (const bad of [
      { descriptionPosition: 'after_char' },
      { depth: -1 },
      { depth: 1.5 },
      { role: 'narrator' },
      { lorebookId: 'nope' },
      { title: 3 },
    ]) {
      const res = await app.request(`/api/personas/${created.id}`, json('PUT', bad));
      expect(res.status).toBe(400);
    }

    const detail = await app.request(`/api/personas/${created.id}`);
    expect(detail.status).toBe(200);
    expect((await app.request('/api/personas/missing')).status).toBe(404);
  });

  it('绑定世界书；删除世界书后置空', async () => {
    const { app, db } = makeTestApp(dataDir);
    const book = db.insert(schema.lorebooks).values({ name: '旅人手记' }).returning().get();
    const persona = (await (
      await app.request('/api/personas', json('POST', { name: '旅人', lorebookId: book.id }))
    ).json()) as PersonaJson;
    expect(persona.lorebookId).toBe(book.id);

    expect((await app.request(`/api/lorebooks/${book.id}`, { method: 'DELETE' })).status).toBe(204);
    const after = (await (await app.request(`/api/personas/${persona.id}`)).json()) as PersonaJson;
    expect(after.lorebookId).toBeNull();
  });

  it('头像：原始字节 / multipart 上传，类型与大小校验，移除', async () => {
    const { app } = makeTestApp(dataDir);
    const persona = (await (
      await app.request('/api/personas', json('POST', { name: '旅人' }))
    ).json()) as PersonaJson;
    const url = `/api/personas/${persona.id}/avatar`;

    const raw = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: PNG,
    });
    expect(raw.status).toBe(200);
    const withAvatar = (await raw.json()) as PersonaJson;
    expect(withAvatar.avatarAssetId).toBeTruthy();
    const file = await app.request(`/api/assets/${withAvatar.avatarAssetId}/file`);
    expect(file.status).toBe(200);
    expect(file.headers.get('content-type')).toBe('image/png');

    const form = new FormData();
    form.append('file', new File([PNG], 'a.png', { type: 'image/png' }));
    expect((await app.request(url, { method: 'POST', body: form })).status).toBe(200);

    const text = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'image/png' },
      body: new TextEncoder().encode('not an image'),
    });
    expect(text.status).toBe(400);

    const huge = new Uint8Array(5 * 1024 * 1024 + 1);
    huge.set(PNG);
    const tooLarge = await app.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: huge,
    });
    expect(tooLarge.status).toBe(413);

    const removed = await app.request(url, { method: 'DELETE' });
    expect(removed.status).toBe(200);
    expect(((await removed.json()) as PersonaJson).avatarAssetId).toBeNull();
    expect((await app.request('/api/personas/missing/avatar', { method: 'DELETE' })).status).toBe(
      404,
    );
  });
});

describe('默认用户档案', () => {
  it('新建对话缺省 personaId 时用默认档案；显式 null 不用；删除默认档案清掉设置', async () => {
    const { app } = makeTestApp(dataDir);
    const persona = (await (
      await app.request('/api/personas', json('POST', { name: '旅人' }))
    ).json()) as PersonaJson;
    const other = (await (
      await app.request('/api/personas', json('POST', { name: '另一个' }))
    ).json()) as PersonaJson;

    // 没有默认：保持显式，不自动套用
    const noDefault = (await (await app.request('/api/chats', json('POST', {}))).json()) as {
      personaId: string | null;
    };
    expect(noDefault.personaId).toBeNull();

    await app.request('/api/settings/defaultPersonaId', json('PUT', persona.id));
    const implicit = (await (await app.request('/api/chats', json('POST', {}))).json()) as {
      personaId: string | null;
    };
    expect(implicit.personaId).toBe(persona.id);

    const explicitNull = (await (
      await app.request('/api/chats', json('POST', { personaId: null }))
    ).json()) as { personaId: string | null };
    expect(explicitNull.personaId).toBeNull();

    const explicitOther = (await (
      await app.request('/api/chats', json('POST', { personaId: other.id }))
    ).json()) as { personaId: string | null };
    expect(explicitOther.personaId).toBe(other.id);

    // 删除非默认档案不影响设置
    await app.request(`/api/personas/${other.id}`, { method: 'DELETE' });
    expect((await app.request('/api/settings/defaultPersonaId')).status).toBe(200);

    await app.request(`/api/personas/${persona.id}`, { method: 'DELETE' });
    expect((await app.request('/api/settings/defaultPersonaId')).status).toBe(404);
    const afterDelete = (await (await app.request('/api/chats', json('POST', {}))).json()) as {
      personaId: string | null;
    };
    expect(afterDelete.personaId).toBeNull();
  });
});

describe('组装输入里的用户档案', () => {
  it('位置 / 深度 / 角色传给组装器，绑定的世界书以 persona 作用域并入', async () => {
    const { app, db } = makeTestApp(dataDir);
    const personaBook = db.insert(schema.lorebooks).values({ name: '旅人手记' }).returning().get();
    const charBook = db.insert(schema.lorebooks).values({ name: '旅人手记' }).returning().get();
    const persona = (await (
      await app.request(
        '/api/personas',
        json('POST', {
          name: '旅人',
          description: '一个冒险者。',
          descriptionPosition: 'at_depth',
          depth: 3,
          role: 'assistant',
          lorebookId: personaBook.id,
        }),
      )
    ).json()) as PersonaJson;
    const character = db
      .insert(schema.characters)
      .values({ name: '艾拉', spec: 'v2', data: { name: '艾拉' }, bookId: charBook.id })
      .returning()
      .get();
    const chatJson = (await (
      await app.request(
        '/api/chats',
        json('POST', { characterIds: [character.id], personaId: persona.id }),
      )
    ).json()) as { id: string };
    const chat = db.select().from(schema.chats).where(eq(schema.chats.id, chatJson.id)).get()!;

    const input = buildAssembleInput(db, {
      chat,
      overrides: {},
      nodes: [],
      parentId: null,
      provider: 'openai-chat',
      model: 'm',
      layoutMode: 'strict',
      caps: {
        maxContext: 8000,
        caching: 'none',
        systemInMessages: true,
        prefill: true,
      } as ModelCapabilities,
    });
    expect(input.persona).toEqual({
      id: persona.id,
      name: '旅人',
      description: '一个冒险者。',
      position: 'at_depth',
      depth: 3,
      role: 2,
    });
    // 同名书：persona 优先于角色（ST getCharacterLore 跳过与 persona 书同名的书）
    expect(input.lorebooks.map((book) => [book.id, book.scope])).toEqual([
      [personaBook.id, 'persona'],
    ]);
  });
});
