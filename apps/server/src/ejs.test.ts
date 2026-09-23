/**
 * EJS 提示词模板接入（M5（三）契约 §4.2 / §4.3）。
 *
 * 真样本用例需要本机 ST 数据目录（只读），没有时跳过：
 *   NT_ST_DATA_DIR=/path/to/SillyTavern/data/default-user pnpm --filter @newtavern/server test -- ejs
 * 样本：`characters/黄金庭院.png`（内嵌世界书）+ `worlds/黄金庭院.json`；
 * 「昔涟_分阶段人设」按 `getvar('stat_data.昔涟.好感度[0]')` 用 `await getwi(null, …)` 切换阶段 01–04。
 */
import fs from 'node:fs';
import path from 'node:path';

import { setPath } from '@newtavern/core';
import type { GenEvent } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { ejsEngineLoadMs } from './services/ejs.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
  type TestApp,
} from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

registerFakeAdapter({
  id: 'fake-ejs',
  events: [
    { type: 'text.delta', text: '好。' },
    { type: 'stop', reason: 'end' },
  ] satisfies GenEvent[],
  renderMessages: true,
});

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

interface Segment {
  id: string;
  parts: { type: string; text?: string }[];
}
interface InspectData {
  ir: { segments: Segment[]; meta: { templated?: string[]; warnings: string[] } };
  warnings: string[];
}
interface Detail {
  id: string;
  headNodeId: string | null;
}

const textOf = (segment: Segment | undefined): string =>
  (segment?.parts ?? []).map((part) => part.text ?? '').join('');

async function useConnection({ app, db }: TestApp) {
  const conn = insertConnection(db, dataDir, 'fake-ejs');
  await app.request(
    '/api/settings/generation.default',
    json('PUT', { connectionId: conn.id, model: 'fake-model' }),
  );
}

function insertPreset(db: Db): string {
  return db
    .insert(schema.presets)
    .values({
      name: 'EJS 预设',
      format: 'native',
      data: {
        prompts: [
          {
            identifier: 'main',
            name: 'Main',
            role: 'system',
            content:
              "主提示 {{char}}<% setvar('seen', getvar('seen', { defaults: 0 }) + 1) %>：<%= getvar('hp') %>",
          },
          { identifier: 'charDescription', name: 'Char', marker: true },
          { identifier: 'chatHistory', name: 'History', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: ['main', 'charDescription', 'chatHistory'].map((identifier) => ({
              identifier,
              enabled: true,
            })),
          },
        ],
        openai_max_context: 32000,
        openai_max_tokens: 500,
      },
    })
    .returning()
    .get().id;
}

describe('EJS 接入组装（服务端）', () => {
  it('检查器：预设 / 卡字段渲染、templated 标注；dryRun 不落变量', async () => {
    const t = makeTestApp(dataDir);
    await useConnection(t);
    const characterId = t.db
      .insert(schema.characters)
      .values({
        name: '艾拉',
        spec: 'v2',
        data: {
          name: '艾拉',
          first_mes: '欢迎。',
          description: '<%_ if (getvar("hp") > 5) { _%>健康<%_ } else { _%>虚弱<%_ } _%>',
        },
      })
      .returning()
      .get().id;
    const presetId = insertPreset(t.db);
    const chat = (await (
      await t.app.request('/api/chats', json('POST', { characterIds: [characterId], presetId }))
    ).json()) as Detail;
    await t.app.request(
      `/api/chats/${chat.id}/variables`,
      json('PUT', { scope: 'chat', variables: { hp: 7 } }),
    );

    const data = (await (
      await t.app.request(`/api/chats/${chat.id}/inspect`)
    ).json()) as InspectData;
    const main = data.ir.segments.find((segment) => segment.id === 'preset:main');
    expect(textOf(main)).toBe('主提示 艾拉：7');
    const description = data.ir.segments.find((segment) => segment.id === 'character:description');
    expect(textOf(description)).toBe('健康');
    expect(data.ir.meta.templated?.sort()).toEqual(['character:description', 'preset:main']);
  });

  it('generate：模板里的 setvar 随本轮变量落到新节点', async () => {
    const t = makeTestApp(dataDir);
    await useConnection(t);
    const presetId = insertPreset(t.db);
    const chat = (await (
      await t.app.request('/api/chats', json('POST', { presetId }))
    ).json()) as Detail;
    const res = await t.app.request(
      `/api/chats/${chat.id}/generate`,
      json('POST', { userMessage: { text: '你好' } }),
    );
    const events = parseSse(await res.text());
    const done = events.find((event) => event.event === 'done')?.data as { node: { id: string } };
    const row = t.db
      .select()
      .from(schema.messageNodes)
      .where(eq(schema.messageNodes.id, done.node.id))
      .get();
    expect(row?.variables).toMatchObject({ seen: 1 });
  });

  it('设置里关掉：原样保留模板文本', async () => {
    const t = makeTestApp(dataDir);
    await useConnection(t);
    const presetId = insertPreset(t.db);
    await t.app.request('/api/settings/ejs', json('PUT', { enabled: false }));
    const chat = (await (
      await t.app.request('/api/chats', json('POST', { presetId }))
    ).json()) as Detail;
    const data = (await (
      await t.app.request(`/api/chats/${chat.id}/inspect`)
    ).json()) as InspectData;
    const main = data.ir.segments.find((segment) => segment.id === 'preset:main');
    expect(textOf(main)).toContain("<%= getvar('hp') %>");
    expect(data.ir.meta.templated).toBeUndefined();
  });
});

// ───────────────────────── 真样本：黄金庭院 ─────────────────────────

const stDataDir = process.env.NT_ST_DATA_DIR;
const cardPath = stDataDir ? path.join(stDataDir, 'characters', '黄金庭院.png') : '';
const worldPath = stDataDir ? path.join(stDataDir, 'worlds', '黄金庭院.json') : '';
const sampleAvailable =
  stDataDir !== undefined && fs.existsSync(cardPath) && fs.existsSync(worldPath);

describe.skipIf(!sampleAvailable)('真样本：黄金庭院（昔涟分阶段人设）', () => {
  it('好感度 20 / 50 / 70 / 95 → 阶段 01 / 02 / 03 / 04', async () => {
    const t = makeTestApp(dataDir);
    await useConnection(t);

    const cardForm = new FormData();
    cardForm.append('file', new File([fs.readFileSync(cardPath)], '黄金庭院.png'));
    const cardRes = await t.app.request('/api/import/character', {
      method: 'POST',
      body: cardForm,
    });
    expect(cardRes.status).toBe(201);
    const card = (await cardRes.json()) as { id: string };

    const bookForm = new FormData();
    bookForm.append('file', new File([fs.readFileSync(worldPath)], '黄金庭院.json'));
    const bookRes = await t.app.request('/api/import/lorebook', { method: 'POST', body: bookForm });
    expect(bookRes.status).toBe(201);
    const book = (await bookRes.json()) as { id: string };

    const chat = (await (
      await t.app.request('/api/chats', json('POST', { characterIds: [card.id] }))
    ).json()) as Detail;
    await t.app.request(`/api/chats/${chat.id}/lorebooks`, json('PUT', { bookIds: [book.id] }));

    const world = JSON.parse(fs.readFileSync(worldPath, 'utf8')) as {
      entries: Record<string, { comment: string; content: string }>;
    };
    const stages = ['01', '02', '03', '04'].map((stage) => {
      const entry = Object.values(world.entries).find((item) =>
        item.comment.startsWith(`昔涟_阶段${stage}`),
      );
      if (!entry) throw new Error(`样本里没有昔涟阶段 ${stage}`);
      // 条目正文头一行足以区分阶段（宏展开不影响开头）
      return entry.content.trim().split('\n').slice(0, 3).join('\n');
    });

    const timings: number[] = [];
    for (const [index, affection] of [20, 50, 70, 95].entries()) {
      const head = t.db
        .select()
        .from(schema.messageNodes)
        .where(eq(schema.messageNodes.chatId, chat.id))
        .all()
        .find((node) => node.id === chat.headNodeId);
      const variables = structuredClone(head?.variables ?? {}) as Record<string, unknown>;
      setPath(variables, 'stat_data.昔涟.好感度', [affection, '[0,100]对user的好感度']);
      await t.app.request(
        `/api/chats/${chat.id}/variables`,
        json('PUT', { scope: 'chat', variables }),
      );

      const started = performance.now();
      const data = (await (
        await t.app.request(`/api/chats/${chat.id}/inspect`)
      ).json()) as InspectData;
      timings.push(performance.now() - started);
      const before = textOf(data.ir.segments.find((segment) => segment.id === 'worldinfo:before'));
      expect(data.ir.meta.templated).toContain('worldinfo:before');
      stages.forEach((stage, stageIndex) => {
        if (stageIndex === index) expect(before).toContain(stage);
        else expect(before).not.toContain(stage);
      });
      expect(before).not.toContain('<%');
      expect(data.warnings.filter((warning) => warning.includes('EJS'))).toEqual([]);
    }
    // 对照：关掉 EJS 的同一次检查器组装
    await t.app.request('/api/settings/ejs', json('PUT', { enabled: false }));
    const plainStarted = performance.now();
    await (await t.app.request(`/api/chats/${chat.id}/inspect`)).json();
    const plainMs = performance.now() - plainStarted;
    console.info(
      `[ejs] 黄金庭院 inspect 耗时（ms）：${timings.map((ms) => ms.toFixed(1)).join(' / ')}；` +
        `关 EJS ${plainMs.toFixed(1)}；WASM 加载 ${ejsEngineLoadMs.toFixed(1)}ms`,
    );
  });
});
