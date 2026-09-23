import fs from 'node:fs';

import type { GenEvent, ProviderRequest } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
} from './test-helpers.js';

/**
 * M5（三）服务端：preset 作用域变量、会话级注入（injectPrompts / `/inject`）与 once 语义、
 * 前端卡 generate 的 injects / overrides / tools / json_schema / preset_name、
 * registerVariableSchema 的存储与 MVU 校验、MVU 额外模型解析、旧快照清理。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body: unknown) => json('POST', body);
const put = (body: unknown) => json('PUT', body);

type App = ReturnType<typeof makeTestApp>['app'];

interface Detail {
  id: string;
  headNodeId: string | null;
  presetId: string | null;
  nodes: { id: string; role: string; parentId: string | null }[];
}

function events(text: string): GenEvent[] {
  return [
    { type: 'text.delta', text },
    { type: 'usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { type: 'stop', reason: 'end' },
  ];
}

/** 假适配器：记下每次请求的 messages（role + 文本），便于断言组装结果 */
function capturingAdapter(
  id: string,
  reply: GenEvent[],
  capabilities: Record<string, unknown> = {},
): { requests: { messages: { role: string; content: string }[]; body: Record<string, unknown> }[] } {
  const record: {
    requests: { messages: { role: string; content: string }[]; body: Record<string, unknown> }[];
  } = { requests: [] };
  registerFakeAdapter({
    id,
    renderMessages: true,
    capabilities,
    stream: async function* (_conn, req: ProviderRequest) {
      const body = req.body as Record<string, unknown>;
      record.requests.push({
        messages: (body.messages ?? []) as { role: string; content: string }[],
        body,
      });
      for (const event of reply) yield event;
    },
  });
  return record;
}

async function setupChat(app: App, db: Db, adapterId: string) {
  const conn = insertConnection(db, dataDir, adapterId);
  await app.request(
    '/api/settings/generation.default',
    put({ connectionId: conn.id, model: 'fake-model-1' }),
  );
  const chat = (await (await app.request('/api/chats', post({}))).json()) as Detail;
  return { conn, chat };
}

async function sandbox(app: App, chatId: string, body: Record<string, unknown>) {
  const raw = await (
    await app.request(`/api/chats/${chatId}/sandbox/generate`, post({ shouldStream: false, ...body }))
  ).text();
  return parseSse(raw);
}

function insertPreset(db: Db, name: string, main: string): string {
  return db
    .insert(schema.presets)
    .values({
      name,
      format: 'st-openai',
      data: {
        prompts: [
          { identifier: 'main', system_prompt: true, role: 'system', content: main },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: [
              { identifier: 'main', enabled: true },
              { identifier: 'chatHistory', enabled: true },
            ],
          },
        ],
      },
    })
    .returning()
    .get().id;
}

describe('preset 作用域变量', () => {
  it('读写走当前会话的预设；组装时 {{get_preset_variable::}} 读得到', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter('extras-preset-vars', events('好。'));
    const { chat } = await setupChat(app, db, 'extras-preset-vars');
    const presetId = insertPreset(db, '带变量的预设', '模式：{{get_preset_variable::模式}}');
    await app.request(`/api/chats/${chat.id}`, json('PATCH', { presetId }));

    const written = await app.request(
      `/api/chats/${chat.id}/variables`,
      put({ scope: 'preset', variables: { 模式: '严肃' } }),
    );
    expect(written.status).toBe(200);
    expect(((await written.json()) as { ownerId: string }).ownerId).toBe(presetId);

    const table = (await (await app.request(`/api/variables/preset?ownerId=${presetId}`)).json()) as {
      variables: Record<string, unknown>;
    };
    expect(table.variables).toEqual({ 模式: '严肃' });

    const read = (await (await app.request(`/api/chats/${chat.id}/variables`)).json()) as {
      preset: Record<string, unknown>;
      presetId: string;
    };
    expect(read.preset).toEqual({ 模式: '严肃' });
    expect(read.presetId).toBe(presetId);

    await sandbox(app, chat.id, { userInput: '你好' });
    expect(record.requests[0]?.messages[0]?.content).toBe('模式：严肃');
  });

  it('会话没选预设时写 preset 作用域报 400', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-preset-none', events('好。'));
    const { chat } = await setupChat(app, db, 'extras-preset-none');
    await app.request(`/api/chats/${chat.id}`, json('PATCH', { presetId: null }));
    const res = await app.request(
      `/api/chats/${chat.id}/variables`,
      put({ scope: 'preset', variables: { a: 1 } }),
    );
    expect(res.status).toBe(400);
  });
});

describe('会话级注入（injectPrompts / /inject）', () => {
  it('存进会话、组装时进提示词；once 的在下一次生成成功后删除', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter('extras-inject', events('嗯。'));
    const { chat } = await setupChat(app, db, 'extras-inject');

    await app.request(
      `/api/chats/${chat.id}/injects`,
      post({
        prompts: [{ id: 'keep', content: '常驻注入', role: 'system', position: 'in_chat', depth: 0 }],
      }),
    );
    await app.request(
      `/api/chats/${chat.id}/injects`,
      post({
        prompts: [{ id: 'one', content: '一次性注入', role: 'user', position: 'in_chat', depth: 0 }],
        once: true,
      }),
    );
    const listed = (await (await app.request(`/api/chats/${chat.id}/injects`)).json()) as {
      injects: { id: string; once?: boolean }[];
    };
    expect(listed.injects.map((item) => [item.id, item.once === true])).toEqual([
      ['keep', false],
      ['one', true],
    ]);

    const first = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '在吗' } }))
    ).text();
    expect(parseSse(first).some((event) => event.event === 'done')).toBe(true);
    const firstText = JSON.stringify(record.requests[0]?.messages);
    expect(firstText).toContain('常驻注入');
    expect(firstText).toContain('一次性注入');

    const after = (await (await app.request(`/api/chats/${chat.id}/injects`)).json()) as {
      injects: { id: string }[];
    };
    expect(after.injects.map((item) => item.id)).toEqual(['keep']);

    await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '再来' } }))
    ).text();
    const secondText = JSON.stringify(record.requests[1]?.messages);
    expect(secondText).toContain('常驻注入');
    expect(secondText).not.toContain('一次性注入');

    // uninjectPrompts 与 /flushinjects
    await app.request(`/api/chats/${chat.id}/injects`, json('DELETE', { ids: ['keep'] }));
    const cleared = (await (await app.request(`/api/chats/${chat.id}/injects`)).json()) as {
      injects: unknown[];
    };
    expect(cleared.injects).toEqual([]);
  });

  it('生成失败不消耗 once 注入', async () => {
    const { app, db } = makeTestApp(dataDir);
    registerFakeAdapter({
      id: 'extras-inject-fail',
      events: [
        {
          type: 'error',
          error: { kind: 'invalid', message: '炸了', retryable: false },
          retryable: false,
        } as GenEvent,
      ],
    });
    const { chat } = await setupChat(app, db, 'extras-inject-fail');
    await app.request(
      `/api/chats/${chat.id}/injects`,
      post({ prompts: [{ id: 'one', content: 'X', role: 'system', position: 'in_chat', depth: 0 }], once: true }),
    );
    await (await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: 'hi' } }))).text();
    const listed = (await (await app.request(`/api/chats/${chat.id}/injects`)).json()) as {
      injects: unknown[];
    };
    expect(listed.injects).toHaveLength(1);
  });
});

describe('前端卡 generate 的补全字段', () => {
  it('injects 与 overrides 落到组装结果上', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter('extras-sandbox', events('收到'));
    const { chat } = await setupChat(app, db, 'extras-sandbox');
    await app.request(`/api/chats/${chat.id}/messages`, post({ role: 'user', text: '旧历史' }));

    const sse = await sandbox(app, chat.id, {
      userInput: '新问题',
      injects: [{ role: 'system', content: '思维链提示', position: 'in_chat', depth: 0 }],
      overrides: {
        chat_history: { prompts: [{ role: 'user', content: '替换后的历史' }] },
        not_a_field: 'x',
      },
    });
    const done = sse.find((event) => event.event === 'done');
    expect(done?.data.text).toBe('收到');
    const warnings = sse.filter((event) => event.event === 'warning').flatMap((event) => event.data.warnings as string[]);
    expect(warnings.some((warning) => warning.includes('overrides.not_a_field'))).toBe(true);

    const messages = record.requests[0]?.messages ?? [];
    const text = JSON.stringify(messages);
    expect(text).toContain('思维链提示');
    expect(text).toContain('替换后的历史');
    expect(text).not.toContain('旧历史');
    expect(messages[messages.length - 1]?.content).toBe('新问题');
  });

  it('preset_name 按名字换预设；找不到报 400', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter('extras-preset-name', events('ok'));
    const { chat } = await setupChat(app, db, 'extras-preset-name');
    insertPreset(db, '另一个预设', '来自另一个预设');

    await sandbox(app, chat.id, { presetName: '另一个预设', userInput: 'hi' });
    expect(record.requests[0]?.messages[0]?.content).toBe('来自另一个预设');

    const res = await app.request(
      `/api/chats/${chat.id}/sandbox/generate`,
      post({ presetName: '不存在的预设' }),
    );
    expect(res.status).toBe(400);
  });

  it('tools：原生工具调用按酒馆助手的形状回给卡', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter(
      'extras-tools',
      [
        { type: 'tool.call', id: 'call_1', name: 'get_weather', argsDelta: '{"city":' },
        { type: 'tool.call', id: 'call_1', name: 'get_weather', argsDelta: '"北京"}' },
        { type: 'stop', reason: 'tool' },
      ],
      { tools: true, structuredOutput: true },
    );
    const { chat } = await setupChat(app, db, 'extras-tools');
    const sse = await sandbox(app, chat.id, {
      userInput: '北京天气？',
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: '查天气',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
          },
        },
      ],
      toolChoice: 'auto',
    });
    const done = sse.find((event) => event.event === 'done');
    expect(done?.data.toolCalls).toEqual([
      { id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"北京"}' } },
    ]);
    expect(done?.data.stopReason).toBe('tool');
    expect(record.requests).toHaveLength(1);
  });

  it('tools：模型不支持工具时走文本协议并解析回复里的 tool_call 块', async () => {
    const { app, db } = makeTestApp(dataDir);
    const record = capturingAdapter(
      'extras-tools-text',
      events('我查一下。\n```tool_call\n{"name":"get_weather","arguments":{"city":"上海"}}\n```'),
      { tools: false },
    );
    const { chat } = await setupChat(app, db, 'extras-tools-text');
    const sse = await sandbox(app, chat.id, {
      userInput: '上海天气？',
      tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } }],
    });
    const done = sse.find((event) => event.event === 'done');
    expect(done?.data.text).toBe('我查一下。');
    const calls = done?.data.toolCalls as { function: { name: string; arguments: string } }[];
    expect(calls[0]?.function.name).toBe('get_weather');
    expect(JSON.parse(calls[0]?.function.arguments ?? '{}')).toEqual({ city: '上海' });
    // 协议说明进了提示词
    expect(JSON.stringify(record.requests[0]?.messages)).toContain('get_weather');
  });

  it('json_schema：不支持结构化输出时附 schema 并抽出 JSON', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-json', events('好的：\n```json\n{"mood":"happy"}\n```'), {
      structuredOutput: false,
    });
    const { chat } = await setupChat(app, db, 'extras-json');
    const sse = await sandbox(app, chat.id, {
      userInput: '心情？',
      jsonSchema: { name: 'mood', value: { type: 'object', properties: { mood: { type: 'string' } } } },
    });
    expect(sse.find((event) => event.event === 'done')?.data.text).toBe('{"mood":"happy"}');
  });

  it('sandbox 的一次成功生成同样消耗 once 注入', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-sandbox-once', events('ok'));
    const { chat } = await setupChat(app, db, 'extras-sandbox-once');
    await app.request(
      `/api/chats/${chat.id}/injects`,
      post({ prompts: [{ id: 'x', content: 'X', role: 'system', position: 'in_chat', depth: 0 }], once: true }),
    );
    await sandbox(app, chat.id, { userInput: 'hi' });
    const listed = (await (await app.request(`/api/chats/${chat.id}/injects`)).json()) as {
      injects: unknown[];
    };
    expect(listed.injects).toEqual([]);
  });
});

/** 带 `[InitVar]` 的世界书（与 mvu.test 同款） */
function insertMvuBook(db: Db, name: string, extraEntries: { comment: string; content: string }[] = []) {
  const book = db.insert(schema.lorebooks).values({ name, scope: 'global' }).returning().get();
  db.insert(schema.lorebookEntries)
    .values({
      bookId: book.id,
      comment: '[InitVar]',
      content: '好感度: 30\n',
      disabled: true,
      constant: true,
      position: 4,
    })
    .run();
  for (const entry of extraEntries) {
    db.insert(schema.lorebookEntries)
      .values({ bookId: book.id, comment: entry.comment, content: entry.content, disabled: true, keys: [] })
      .run();
  }
  return book.id;
}

describe('MVU 补全', () => {
  it('registerVariableSchema：存进会话；MVU 结果不符合时记 warning 不回滚', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-schema', events("<UpdateVariable>\n_.set('好感度', 30, 150);\n</UpdateVariable>"));
    const { chat } = await setupChat(app, db, 'extras-schema');
    const bookId = insertMvuBook(db, 'schema 书');
    await app.request('/api/settings/worldInfo.globalBookIds', put([bookId]));

    const saved = await app.request(
      `/api/chats/${chat.id}/variable-schemas`,
      put({
        type: 'message',
        schema: {
          type: 'object',
          properties: {
            stat_data: {
              type: 'object',
              properties: { 好感度: { type: 'number', maximum: 100 } },
            },
          },
        },
      }),
    );
    expect(saved.status).toBe(200);
    const read = (await (await app.request(`/api/chats/${chat.id}/variables`)).json()) as {
      schemas: Record<string, unknown>;
    };
    expect(Object.keys(read.schemas)).toEqual(['message']);

    const raw = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '嗨' } }))
    ).text();
    const update = parseSse(raw)
      .filter((event) => event.event === 'variables')
      .pop()?.data as { nodeId: string; warnings?: string[]; variables: { stat_data: { 好感度: number } } };
    expect(update.variables.stat_data.好感度).toBe(150);
    expect(update.warnings?.[0]).toContain('stat_data.好感度');
    const node = db.select().from(schema.messageNodes).all().find((row) => row.id === update.nodeId);
    expect((node?.extra as { mvuWarnings?: string[] }).mvuWarnings?.length).toBe(1);
  });

  it('额外模型解析：正文没有更新命令时请求额外模型并应用它的输出', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-mvu-main', events('她笑了笑，没有说话。'));
    const extra = capturingAdapter(
      'extras-mvu-extra',
      events("<UpdateVariable>\n_.set('好感度', 30, 42);//笑了\n</UpdateVariable>"),
    );
    const { chat } = await setupChat(app, db, 'extras-mvu-main');
    const extraConn = insertConnection(db, dataDir, 'extras-mvu-extra', ['sk-extra'], '额外模型');
    const bookId = insertMvuBook(db, '额外模型书', [
      { comment: '[mvu_update] 规则', content: '好感度随亲近行为上升。' },
    ]);
    await app.request('/api/settings/worldInfo.globalBookIds', put([bookId]));
    await app.request(
      '/api/settings/mvu',
      put({ enabled: true, extraModel: { connectionId: extraConn.id, model: 'fake-model-1', when: 'missing' } }),
    );

    const raw = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '早' } }))
    ).text();
    const update = parseSse(raw)
      .filter((event) => event.event === 'variables')
      .pop()?.data as { nodeId: string; source?: string; variables: { stat_data: { 好感度: number } } };
    expect(update.variables.stat_data.好感度).toBe(42);
    expect(update.source).toBe('extra-model');
    const node = db.select().from(schema.messageNodes).all().find((row) => row.id === update.nodeId);
    expect((node?.extra as { mvuSource?: string }).mvuSource).toBe('extra-model');
    // 额外模型收到了当前变量、本轮正文与更新规则
    const prompt = JSON.stringify(extra.requests[0]?.messages);
    expect(prompt).toContain('好感度随亲近行为上升');
    expect(prompt).toContain('她笑了笑');
    expect(prompt).toContain('30');
  });

  it('额外模型：正文里已有命令且 when=missing 时不调用', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-mvu-main2', events("<UpdateVariable>\n_.add('好感度', 1);\n</UpdateVariable>"));
    const extra = capturingAdapter('extras-mvu-extra2', events('<UpdateVariable></UpdateVariable>'));
    const { chat } = await setupChat(app, db, 'extras-mvu-main2');
    const extraConn = insertConnection(db, dataDir, 'extras-mvu-extra2');
    const bookId = insertMvuBook(db, '额外模型书2');
    await app.request('/api/settings/worldInfo.globalBookIds', put([bookId]));
    await app.request(
      '/api/settings/mvu',
      put({ enabled: true, extraModel: { connectionId: extraConn.id, model: 'fake-model-1', when: 'missing' } }),
    );
    const raw = await (
      await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: '早' } }))
    ).text();
    const update = parseSse(raw)
      .filter((event) => event.event === 'variables')
      .pop()?.data as { source?: string; variables: { stat_data: { 好感度: number } } };
    expect(update.variables.stat_data.好感度).toBe(31);
    expect(update.source).toBe('message');
    expect(extra.requests).toHaveLength(0);
  });

  it('旧快照清理：距 head 超过 N 层的快照换成 $pruned，下一轮仍从最近的完整快照起算', async () => {
    const { app, db } = makeTestApp(dataDir);
    capturingAdapter('extras-prune', events("<UpdateVariable>\n_.add('好感度', 1);\n</UpdateVariable>"));
    const { chat } = await setupChat(app, db, 'extras-prune');
    const bookId = insertMvuBook(db, '清理书');
    await app.request('/api/settings/worldInfo.globalBookIds', put([bookId]));
    await app.request('/api/settings/mvu', put({ enabled: true, keepSnapshots: 2 }));

    let last = 0;
    for (let i = 0; i < 4; i += 1) {
      const raw = await (
        await app.request(`/api/chats/${chat.id}/generate`, post({ userMessage: { text: `第${i}轮` } }))
      ).text();
      const update = parseSse(raw)
        .filter((event) => event.event === 'variables')
        .pop()?.data as { variables: { stat_data: { 好感度: number } } };
      last = update.variables.stat_data.好感度;
    }
    // 30 → 31 → 32 → 33 → 34：清理不影响累积
    expect(last).toBe(34);
    const assistants = db
      .select()
      .from(schema.messageNodes)
      .all()
      .filter((row) => row.chatId === chat.id && row.role === 'assistant')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const pruned = assistants.map((row) => (row.variables as { $pruned?: boolean } | null)?.$pruned === true);
    // 路径：u a u a u a u a（下标 0–7，head = 7）；距 head 超过 2 层（下标 < 5）的快照被清理
    expect(pruned).toEqual([true, true, false, false]);

    // 重放遇到被清理的起点：提示并从 InitVar 起算
    const replay = (await (
      await app.request(`/api/chats/${chat.id}/mvu/replay`, post({ nodeId: assistants[2]?.id }))
    ).json()) as { results: { warnings?: string[] }[] };
    expect(replay.results[0]?.warnings?.[0]).toContain('清理');
  });
});
