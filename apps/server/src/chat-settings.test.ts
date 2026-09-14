import fs from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { readAuthorsNote } from './services/authors-note.js';
import {
  DEFAULT_GLOBAL_SYSTEM_PROMPT,
  readGlobalSystemPromptSetting,
  resolveGlobalSystemPrompt,
} from './services/global-system-prompt.js';
import { applyGlobalChanges, readGlobalVariables } from './services/variables.js';
import {
  DEFAULT_WI_UI_SETTINGS,
  readGlobalBookIds,
  readWISettings,
  readWIUiSettings,
  toWISettings,
} from './services/wi-settings.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
} from './test-helpers.js';

/**
 * 聊天世界书绑定、WI 设置、作者注释、全局系统提示词、变量、inspect 骨架。
 * 见 docs/M3-CONTRACT.md §3.3–§3.7。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

registerFakeAdapter({ id: 'fake-inspect' });

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface ChatDetail {
  id: string;
  lorebookIds: string[];
  metadata: Record<string, unknown> | null;
  overrides: Record<string, unknown> | null;
  headNodeId: string | null;
}

function insertBook(db: Db, name: string): string {
  return db.insert(schema.lorebooks).values({ name }).returning().get().id;
}

function putSetting(app: ReturnType<typeof makeTestApp>['app'], key: string, value: unknown) {
  return app.request(`/api/settings/${key}`, json('PUT', value));
}

describe('聊天世界书绑定', () => {
  it('PUT /api/chats/:id/lorebooks 全量替换，ChatSummary/Detail 带 lorebookIds', async () => {
    const { app, db } = makeTestApp(dataDir);
    const first = insertBook(db, '王国');
    const second = insertBook(db, '秘闻');
    const chat = (await (await app.request('/api/chats', json('POST', {}))).json()) as ChatDetail;
    expect(chat.lorebookIds).toEqual([]);

    const bound = (await (
      await app.request(
        `/api/chats/${chat.id}/lorebooks`,
        json('PUT', { bookIds: [second, first] }),
      )
    ).json()) as ChatDetail;
    expect(bound.lorebookIds).toEqual([second, first]);

    const list = (await (await app.request('/api/chats')).json()) as ChatDetail[];
    expect(list[0]?.lorebookIds).toEqual([second, first]);

    // 全量替换 + 去重
    const replaced = (await (
      await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [first, first] }))
    ).json()) as ChatDetail;
    expect(replaced.lorebookIds).toEqual([first]);

    // 清空
    const cleared = (await (
      await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [] }))
    ).json()) as ChatDetail;
    expect(cleared.lorebookIds).toEqual([]);

    // 删书级联
    await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [first] }));
    await app.request(`/api/lorebooks/${first}`, { method: 'DELETE' });
    const afterDelete = (await (await app.request(`/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(afterDelete.lorebookIds).toEqual([]);
  });

  it('非法 bookIds / 不存在的书 / 不存在的聊天', async () => {
    const { app } = makeTestApp(dataDir);
    const chat = (await (await app.request('/api/chats', json('POST', {}))).json()) as ChatDetail;
    expect(
      (await app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: 'x' }))).status,
    ).toBe(400);
    const missing = await app.request(
      `/api/chats/${chat.id}/lorebooks`,
      json('PUT', { bookIds: ['nope'] }),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { message: string }).message).toMatch(/世界书不存在/);
    expect(
      (await app.request('/api/chats/nope/lorebooks', json('PUT', { bookIds: [] }))).status,
    ).toBe(404);
  });
});

describe('WI 设置与全局书', () => {
  it('默认值合并、budgetTokens 换算、globalBookIds 读取', async () => {
    const { app, db } = makeTestApp(dataDir);
    // 未设置 → 全默认
    expect(readWIUiSettings(db)).toEqual(DEFAULT_WI_UI_SETTINGS);
    expect(readGlobalBookIds(db)).toEqual([]);
    // 默认值照 ST 1.18 发行版 default/content/settings.json：recursive true、matchWholeWords true、includeNames true
    expect(DEFAULT_WI_UI_SETTINGS).toMatchObject({
      recursive: true,
      matchWholeWords: true,
      includeNames: true,
    });
    // 预算按 AS-7：round(pct × (maxContext − maxResponse) / 100) || 1
    expect(toWISettings(DEFAULT_WI_UI_SETTINGS, { maxContext: 32768, maxResponse: 768 })).toEqual({
      scanDepth: 2,
      budgetTokens: 8000,
      budgetCap: 0,
      recursive: true,
      caseSensitive: false,
      matchWholeWords: true,
      useGroupScoring: false,
      maxRecursionSteps: 0,
      minActivations: 0,
      minActivationsDepthMax: 0,
      includeNames: true,
      overflowAlert: false,
      characterStrategy: 1,
    });
    // 结果 0 时保底 1（ST 的 `|| 1`）
    expect(
      toWISettings(
        { ...DEFAULT_WI_UI_SETTINGS, budgetPercent: 0 },
        { maxContext: 32768, maxResponse: 0 },
      ).budgetTokens,
    ).toBe(1);
    expect(
      'budgetPercent' in toWISettings(DEFAULT_WI_UI_SETTINGS, { maxContext: 100, maxResponse: 0 }),
    ).toBe(false);

    // 部分设置 + 脏字段 → 只覆盖合法项
    await putSetting(app, 'worldInfo.settings', {
      scanDepth: 5,
      budgetPercent: 10,
      includeNames: true,
      recursive: 'yes',
      unknown: 1,
    });
    expect(readWIUiSettings(db)).toEqual({
      ...DEFAULT_WI_UI_SETTINGS,
      scanDepth: 5,
      budgetPercent: 10,
      includeNames: true,
    });
    expect(readWISettings(db, { maxContext: 20000, maxResponse: 0 }).budgetTokens).toBe(2000);

    await putSetting(app, 'worldInfo.globalBookIds', ['a', 2, 'b']);
    expect(readGlobalBookIds(db)).toEqual(['a', 'b']);
  });
});

describe('作者注释与全局系统提示词', () => {
  it('PATCH metadata.authorsNote：补默认值、校验形状、null 清除、其余 metadata 保留', async () => {
    const { app, db } = makeTestApp(dataDir);
    const chat = (await (await app.request('/api/chats', json('POST', {}))).json()) as ChatDetail;

    const withNote = (await (
      await app.request(
        `/api/chats/${chat.id}`,
        json('PATCH', { metadata: { authorsNote: { text: '保持紧张感。', position: 1 } } }),
      )
    ).json()) as ChatDetail;
    expect(withNote.metadata?.authorsNote).toEqual({
      text: '保持紧张感。',
      position: 1,
      depth: 4,
      role: 0,
      interval: 1,
    });

    for (const authorsNote of [
      { position: 1 },
      { text: '×', position: 9 },
      { text: '×', role: 'system' },
      { text: '×', depth: 'deep' },
      { text: '×', interval: -1 },
      '不是对象',
    ]) {
      const res = await app.request(
        `/api/chats/${chat.id}`,
        json('PATCH', { metadata: { authorsNote } }),
      );
      expect(res.status).toBe(400);
    }
    expect(
      (await app.request(`/api/chats/${chat.id}`, json('PATCH', { metadata: 1 }))).status,
    ).toBe(400);

    // 其它 metadata 键浅合并保留
    await app.request(
      `/api/chats/${chat.id}`,
      json('PATCH', { metadata: { frozenVolatile: { a: '1' } } }),
    );
    const merged = (await (await app.request(`/api/chats/${chat.id}`)).json()) as ChatDetail;
    expect(merged.metadata?.frozenVolatile).toEqual({ a: '1' });
    expect((merged.metadata?.authorsNote as { text: string }).text).toBe('保持紧张感。');
    const row = db.select().from(schema.chats).all()[0]!;
    expect(readAuthorsNote(row)?.depth).toBe(4);

    // null 清除单键
    const cleared = (await (
      await app.request(`/api/chats/${chat.id}`, json('PATCH', { metadata: { authorsNote: null } }))
    ).json()) as ChatDetail;
    expect(cleared.metadata?.authorsNote).toBeUndefined();
    expect(cleared.metadata?.frozenVolatile).toEqual({ a: '1' });
    expect(readAuthorsNote(db.select().from(schema.chats).all()[0]!)).toBeNull();
  });

  it('全局系统提示词：设置默认值 + 会话覆盖合并，enabled=false → null', async () => {
    const { app, db } = makeTestApp(dataDir);
    expect(readGlobalSystemPromptSetting(db)).toEqual(DEFAULT_GLOBAL_SYSTEM_PROMPT);
    expect(resolveGlobalSystemPrompt(db, null)).toBeNull();

    await putSetting(app, 'globalSystemPrompt', {
      enabled: true,
      text: '你是叙事者。',
      position: 'after_main',
    });
    expect(resolveGlobalSystemPrompt(db, null)).toEqual({
      text: '你是叙事者。',
      position: 'after_main',
    });
    // 会话覆盖逐字段生效
    expect(resolveGlobalSystemPrompt(db, { globalSystemPrompt: { text: '换一段。' } })).toEqual({
      text: '换一段。',
      position: 'after_main',
    });
    expect(resolveGlobalSystemPrompt(db, { globalSystemPrompt: { enabled: false } })).toBeNull();
    // 文本为空视为不注入
    expect(resolveGlobalSystemPrompt(db, { globalSystemPrompt: { text: '  ' } })).toBeNull();

    const chat = (await (await app.request('/api/chats', json('POST', {}))).json()) as ChatDetail;
    const patched = (await (
      await app.request(
        `/api/chats/${chat.id}`,
        json('PATCH', { overrides: { globalSystemPrompt: { enabled: false } } }),
      )
    ).json()) as ChatDetail;
    expect(patched.overrides?.globalSystemPrompt).toEqual({ enabled: false });
    expect(
      (
        await app.request(
          `/api/chats/${chat.id}`,
          json('PATCH', { overrides: { globalSystemPrompt: { position: 'nowhere' } } }),
        )
      ).status,
    ).toBe(400);
  });
});

describe('全局变量', () => {
  it('applyGlobalChanges：upsert / 删除 / 每键一条事件', () => {
    const { db } = makeTestApp(dataDir);
    expect(readGlobalVariables(db)).toEqual({});

    applyGlobalChanges(db, { hp: 10, name: '艾拉' }, 'node-1');
    expect(readGlobalVariables(db)).toEqual({ hp: 10, name: '艾拉' });

    applyGlobalChanges(db, { hp: 8, name: null }, 'node-2');
    expect(readGlobalVariables(db)).toEqual({ hp: 8 });

    // 空变更不写事件
    applyGlobalChanges(db, {}, 'node-3');
    const events = db.select().from(schema.variableEvents).all();
    expect(events).toHaveLength(4);
    expect(events.map((e) => [e.op, e.path, e.nodeId])).toEqual([
      ['set', 'hp', 'node-1'],
      ['set', 'name', 'node-1'],
      ['set', 'hp', 'node-2'],
      ['delete', 'name', 'node-2'],
    ]);
    expect(events[2]).toMatchObject({ oldValue: 10, newValue: 8, scope: 'global', ownerId: '' });
    expect(events[3]).toMatchObject({ oldValue: '艾拉', newValue: null });

    // 删除不存在的键：不留事件
    applyGlobalChanges(db, { missing: undefined }, null);
    expect(db.select().from(schema.variableEvents).all()).toHaveLength(4);
  });
});

describe('inspect 参数解析', () => {
  it('404 / no_connection / 非法 parentId 与 layoutMode；缺省 parentId = head', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'fake-inspect');
    const chat = (await (await app.request('/api/chats', json('POST', {}))).json()) as ChatDetail;

    expect((await app.request('/api/chats/nope/inspect')).status).toBe(404);
    const noConn = await app.request(`/api/chats/${chat.id}/inspect`);
    expect(noConn.status).toBe(400);
    expect(((await noConn.json()) as { error: string }).error).toBe('no_connection');

    await putSetting(app, 'generation.default', { connectionId: conn.id, model: 'fake-model-1' });
    const ok = await app.request(`/api/chats/${chat.id}/inspect`);
    expect(ok.status).toBe(200);
    // 完整响应形状见 inspect.test.ts；这里只看参数解析
    expect((await ok.json()) as { layoutMode: string }).toMatchObject({ layoutMode: 'strict' });

    const withQuery = (await (
      await app.request(`/api/chats/${chat.id}/inspect?model=other-model&layoutMode=cache-aware`)
    ).json()) as { layoutMode: string };
    expect(withQuery.layoutMode).toBe('cache-aware');

    expect((await app.request(`/api/chats/${chat.id}/inspect?parentId=nope`)).status).toBe(400);
    expect((await app.request(`/api/chats/${chat.id}/inspect?layoutMode=weird`)).status).toBe(400);

    // head 有节点时缺省 parentId = head（消息进了 IR）；显式空串 = 从根开始（没有历史）
    await app.request(
      `/api/chats/${chat.id}/messages`,
      json('POST', { role: 'user', text: '你好检查器' }),
    );
    const atHead = (await (await app.request(`/api/chats/${chat.id}/inspect`)).json()) as {
      ir: { segments: unknown[] };
    };
    expect(JSON.stringify(atHead.ir.segments)).toContain('你好检查器');
    const atRoot = (await (
      await app.request(`/api/chats/${chat.id}/inspect?parentId=`)
    ).json()) as { ir: { segments: unknown[] } };
    expect(JSON.stringify(atRoot.ir.segments)).not.toContain('你好检查器');
  });
});
