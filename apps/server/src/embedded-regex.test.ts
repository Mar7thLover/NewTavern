import fs from 'node:fs';

import type { GenEvent } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { backfillEmbeddedRegex } from './services/backfill.js';
import { schema, type Db } from './db/client.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  registerFakeAdapter,
} from './test-helpers.js';

/**
 * 角色卡 / 预设自带的正则：导入时抽进正则库、默认不启用、用户点头才生效。
 * 见 docs/M3-CONTRACT.md §3.2 的修正（2026-09-18）。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const post = (body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const put = (body: unknown) => ({
  method: 'PUT',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Script {
  id: string;
  name: string;
  scope: string;
  disabled: boolean;
  ownerId?: string | null;
  ownerName?: string | null;
}

/** 一条提示词侧正则：把历史里的「原话」换成「改写」，好在请求体里看出它跑没跑 */
function stScript(name: string, disabled = false) {
  return {
    id: name,
    scriptName: name,
    findRegex: '原话',
    replaceString: '改写',
    trimStrings: [],
    placement: [1, 2],
    disabled,
    markdownOnly: false,
    promptOnly: true,
    runOnEdit: false,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

function uploadCharacter(app: ReturnType<typeof makeTestApp>['app'], card: unknown) {
  const form = new FormData();
  form.append('file', new File([JSON.stringify(card)], '卡.json', { type: 'application/json' }));
  return app.request('/api/import/character', { method: 'POST', body: form });
}

function uploadPreset(app: ReturnType<typeof makeTestApp>['app'], preset: unknown) {
  const form = new FormData();
  form.append('file', new File([JSON.stringify(preset)], '预设.json', { type: 'application/json' }));
  return app.request('/api/import/preset', { method: 'POST', body: form });
}

const CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '带正则的卡',
    description: '描述',
    personality: '',
    scenario: '',
    mes_example: '',
    first_mes: '你好。',
    extensions: {
      regex_scripts: [stScript('卡-启用的'), stScript('卡-作者关掉的', true)],
    },
  },
};

/** ST 预设：prompts + prompt_order 最小可用，外加自带正则 */
const PRESET = {
  name: '带正则的预设',
  prompts: [
    { identifier: 'main', name: '主提示词', role: 'system', content: '主提示词正文' },
    // ST 预设里占位符也是 prompts 的一员（marker:true），少了它历史不会展开
    { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
  ],
  prompt_order: [
    {
      character_id: 100001,
      // chatHistory 必须在：否则历史根本不进提示词，也就看不出正则跑没跑
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ],
    },
  ],
  extensions: { regex_scripts: [stScript('预设-思维链美化')] },
};

describe('自带正则：导入即入库、默认不启用', () => {
  it('角色卡自带的正则抽进正则库，导入接口回报条数', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await uploadCharacter(app, CARD);
    expect(res.status).toBe(201);
    const imported = (await res.json()) as {
      id: string;
      embeddedRegex?: { scope: string; ownerId: string; count: number };
    };
    expect(imported.embeddedRegex).toMatchObject({ scope: 'character', count: 2 });

    // 默认只列全局：自带的不会混进「我自己的脚本」里
    const globals = (await (await app.request('/api/regex')).json()) as Script[];
    expect(globals).toHaveLength(0);

    const all = (await (await app.request('/api/regex?scope=all')).json()) as Script[];
    expect(all.map((script) => script.name)).toEqual(['卡-启用的', '卡-作者关掉的']);
    expect(all.every((script) => script.scope === 'character')).toBe(true);
    expect(all.every((script) => script.disabled)).toBe(true);
    expect(all[0]?.ownerName).toBe('带正则的卡');
  });

  it('预设自带的正则同样入库（ST 里这类最多：思维链美化 / 不发送思维链）', async () => {
    const { app } = makeTestApp(dataDir);
    const res = await uploadPreset(app, PRESET);
    const imported = (await res.json()) as { embeddedRegex?: { scope: string; count: number } };
    expect(imported.embeddedRegex).toMatchObject({ scope: 'preset', count: 1 });
    const all = (await (await app.request('/api/regex?scope=all')).json()) as Script[];
    expect(all[0]).toMatchObject({ scope: 'preset', disabled: true, ownerName: '带正则的预设' });
  });
});

describe('自带正则：启用之后才进提示词', () => {
  /** 跑一轮生成，返回发给提供商的消息文本 */
  async function promptText(
    app: ReturnType<typeof makeTestApp>['app'],
    db: Db,
    chatId: string,
  ): Promise<string> {
    await (
      await app.request(`/api/chats/${chatId}/generate`, post({ userMessage: { text: '原话' } }))
    ).text();
    const nodes = db
      .select()
      .from(schema.messageNodes)
      .all()
      .filter((node) => node.chatId === chatId);
    return JSON.stringify(nodes.map((node) => (node.extra as { request?: unknown } | null)?.request));
  }

  it('卡自带的正则：启用前不跑，启用后跑；作者关掉的那条仍然不跑', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'regex-fake-1');
    registerFakeAdapter({
      id: 'regex-fake-1',
      renderMessages: true,
      events: [{ type: 'text.delta', text: '好。' }, { type: 'stop', reason: 'end' }] as GenEvent[],
    });
    const character = (await (await uploadCharacter(app, CARD)).json()) as {
      id: string;
      embeddedRegex: { ownerId: string };
    };
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );
    const chat = (await (
      await app.request('/api/chats', post({ characterIds: [character.id] }))
    ).json()) as { id: string };

    expect(await promptText(app, db, chat.id)).toContain('原话');

    const enabled = (await (
      await app.request(
        '/api/regex/owner',
        post({ scope: 'character', ownerId: character.id, enabled: true }),
      )
    ).json()) as { changed: number; scripts: Script[] };
    // 只有作者启用着的那条被打开
    expect(enabled.changed).toBe(1);
    expect(enabled.scripts.find((s) => s.name === '卡-启用的')?.disabled).toBe(false);
    expect(enabled.scripts.find((s) => s.name === '卡-作者关掉的')?.disabled).toBe(true);

    const after = await promptText(app, db, chat.id);
    expect(after).toContain('改写');
  });

  it('预设自带的正则：绑定了这份预设的会话才跑', async () => {
    const { app, db } = makeTestApp(dataDir);
    const conn = insertConnection(db, dataDir, 'regex-fake-2');
    registerFakeAdapter({
      id: 'regex-fake-2',
      renderMessages: true,
      events: [{ type: 'text.delta', text: '好。' }, { type: 'stop', reason: 'end' }] as GenEvent[],
    });
    const preset = (await (await uploadPreset(app, PRESET)).json()) as { id: string };
    await app.request(
      '/api/regex/owner',
      post({ scope: 'preset', ownerId: preset.id, enabled: true }),
    );
    await app.request(
      '/api/settings/generation.default',
      put({ connectionId: conn.id, model: 'fake-model-1' }),
    );

    const withPreset = (await (
      await app.request('/api/chats', post({ presetId: preset.id }))
    ).json()) as { id: string };
    expect(await promptText(app, db, withPreset.id)).toContain('改写');

    const withoutPreset = (await (
      await app.request('/api/chats', post({ presetId: null }))
    ).json()) as { id: string };
    const text = await promptText(app, db, withoutPreset.id);
    // 这条会话没绑这份预设 → 预设自带的正则不参与
    expect(text.split('改写').length - 1).toBe(0);
  });
});

describe('回填与幂等', () => {
  it('老库里的卡按原状态回填、预设回填成关闭；重复回填不会翻倍', async () => {
    const { app, db } = makeTestApp(dataDir);
    // 模拟「改动之前导入的」数据：直接插行，不走导入
    const character = db
      .insert(schema.characters)
      .values({ name: '老卡', spec: 'v2', data: CARD.data })
      .returning()
      .get();
    db.insert(schema.presets)
      .values({ name: '老预设', format: 'st-openai', data: PRESET })
      .returning()
      .get();

    const first = backfillEmbeddedRegex(db);
    expect(first).toMatchObject({ character: 2, preset: 1 });
    const second = backfillEmbeddedRegex(db);
    expect(second).toMatchObject({ character: 0, preset: 0, book: 0 });

    const all = (await (await app.request('/api/regex?scope=all')).json()) as Script[];
    const cardScripts = all.filter((script) => script.ownerId === character.id);
    // 卡自带的正则在这次改动前本来就生效，回填保持原状态
    expect(cardScripts.find((s) => s.name === '卡-启用的')?.disabled).toBe(false);
    expect(cardScripts.find((s) => s.name === '卡-作者关掉的')?.disabled).toBe(true);
    // 预设自带的以前从没生效过，回填成关闭
    expect(all.find((s) => s.scope === 'preset')?.disabled).toBe(true);
  });
});
