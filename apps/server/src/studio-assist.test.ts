import fs from 'node:fs';

import type { PromptIR } from '@newtavern/core';
import type { GenEvent, ModelCapabilities } from '@newtavern/providers';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { MAX_ASSIST_STEPS, RETRY_DELAYS_MS } from './services/studio-assist.js';
import type { StudioPatchOp } from './services/studio-assist-tools.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
  waitFor,
  type SseEvent,
} from './test-helpers.js';

/** M6 §3：AI 协作者 `POST /api/studio/assist`（fake adapter 预录工具调用序列） */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

type App = ReturnType<typeof makeTestApp>['app'];
type Json = Record<string, unknown>;

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function body<T = Json>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

/* ------------------------------------------------------------------ */
/* 脚本化假适配器                                                        */
/* ------------------------------------------------------------------ */

type Call = [name: string, args: unknown];

/** 一次模型调用：发起若干工具调用（stop=tool） */
function callsRound(...calls: Call[]): GenEvent[] {
  return [
    ...calls.map(([name, args], i): GenEvent => ({
      type: 'tool.call',
      id: `call_${name}_${i}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      argsDelta: typeof args === 'string' ? args : JSON.stringify(args),
    })),
    { type: 'usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { type: 'stop', reason: 'tool' },
  ];
}

function textRound(text: string): GenEvent[] {
  return [
    { type: 'text.delta', text },
    { type: 'usage', input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    { type: 'stop', reason: 'end' },
  ];
}

let seq = 0;

/**
 * 每次调用按顺序回放一轮；`testReply` 给出时，没有 tools 的请求（run_test_turn 的试跑）回它而不消耗脚本。
 * 记录每次请求的 IR。
 */
function scripted(
  db: Db,
  rounds: GenEvent[][] | ((round: number) => GenEvent[]),
  options: { caps?: Partial<ModelCapabilities>; testReply?: string } = {},
) {
  const id = `fake-assist-${(seq += 1)}`;
  const irs: PromptIR[] = [];
  let round = 0;
  const adapter = registerFakeAdapter({
    id,
    capabilities: { tools: true, ...options.caps },
    stream: async function* stream() {
      const ir = irs[irs.length - 1];
      if (ir && !ir.tools && options.testReply !== undefined) {
        yield* textRound(options.testReply);
        return;
      }
      const index = round;
      round += 1;
      const events =
        typeof rounds === 'function'
          ? rounds(index)
          : (rounds[index] ?? textRound('（脚本已结束）'));
      for (const event of events) yield event;
    },
  });
  const original = adapter.buildRequest.bind(adapter);
  adapter.buildRequest = (ir, conn, model, opts) => {
    irs.push(ir);
    return original(ir, conn, model, opts);
  };
  const conn = insertConnection(db, dataDir, id);
  return { connectionId: conn.id, irs, rounds: () => round };
}

async function assist(app: App, payload: Json): Promise<SseEvent[]> {
  const res = await app.request('/api/studio/assist', json('POST', payload));
  expect(res.status).toBe(200);
  return parseSse(await res.text());
}

const eventsOf = (events: SseEvent[], name: string) => events.filter((e) => e.event === name);
const patchOf = (events: SseEvent[]) => {
  const patches = eventsOf(events, 'patch');
  expect(patches).toHaveLength(1);
  return (patches[0]!.data as { ops: StudioPatchOp[] }).ops;
};

function textOfIr(ir: PromptIR): string {
  return ir.segments
    .flatMap((s) =>
      s.parts.map((p) => (p.type === 'text' ? p.text : p.type === 'tool_result' ? p.content : '')),
    )
    .join('\n');
}

function toolResultParts(ir: PromptIR) {
  return ir.segments.flatMap((s) => s.parts.filter((p) => p.type === 'tool_result'));
}

async function createCard(app: App, data: Json = {}) {
  return body<{ id: string; data: Json; editedAt: string | null }>(
    await app.request(
      '/api/characters',
      json('POST', {
        name: '艾拉',
        data: {
          description: '酒馆老板娘，红发。',
          personality: '热情',
          scenario: '雨夜的酒馆',
          first_mes: '欢迎光临。',
          ...data,
        },
      }),
    ),
  );
}

/* ------------------------------------------------------------------ */
/* 角色卡                                                               */
/* ------------------------------------------------------------------ */

describe('AI 协作者：角色卡', () => {
  it('edit：改两个字段 → patch 正确（含 before）、写回原值不出 op、草稿与库都不变', async () => {
    const { app, db } = makeTestApp(dataDir);
    const card = await createCard(app);
    const draft = structuredClone(card.data);
    const snapshot = JSON.stringify(draft);
    const { connectionId, irs } = scripted(db, [
      callsRound(['get_field', { path: '/description' }]),
      callsRound(
        ['set_field', { path: '/description', value: '酒馆老板娘，红发，左眼有疤。' }],
        ['set_field', { path: 'personality', value: '热情、爱管闲事' }],
        ['set_field', { path: '/scenario', value: '雨夜的酒馆' }],
      ),
      textRound('改好了：补了外貌细节，性格更具体。'),
    ]);

    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character', id: card.id },
      draft,
      conversation: [
        { role: 'user', content: '帮我看看这张卡' },
        { role: 'assistant', content: '好的。' },
      ],
      instruction: '描述里加上外貌细节，性格写具体点',
      mode: 'edit',
      lang: 'zh-CN',
    });

    // 事件序列：tool / tool_result 成对，文本流式，最后 patch → usage → done
    expect(eventsOf(events, 'tool').map((e) => e.data.name)).toEqual([
      'get_field',
      'set_field',
      'set_field',
      'set_field',
    ]);
    expect(eventsOf(events, 'tool_result').every((e) => e.data.ok === true)).toBe(true);
    expect(
      eventsOf(events, 'text')
        .map((e) => e.data.delta)
        .join(''),
    ).toContain('改好了');
    expect(events.slice(-3).map((e) => e.event)).toEqual(['patch', 'usage', 'done']);
    expect(eventsOf(events, 'done')[0]!.data).toEqual({ steps: 3, stopReason: 'end' });
    expect(eventsOf(events, 'usage')[0]!.data).toMatchObject({ input: 30, output: 15 });

    expect(patchOf(events)).toEqual([
      {
        op: 'set',
        path: '/description',
        value: '酒馆老板娘，红发，左眼有疤。',
        before: '酒馆老板娘，红发。',
      },
      { op: 'set', path: '/personality', value: '热情、爱管闲事', before: '热情' },
    ]);

    // get_field 的结果以 tool_result 回传给了模型；历史里有 tool_call
    const second = irs[1]!;
    const results = toolResultParts(second);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'get_field' });
    expect((results[0] as { content: string }).content).toContain('酒馆老板娘，红发。');
    expect(second.segments.some((s) => s.parts.some((p) => p.type === 'tool_call'))).toBe(true);

    // 系统提示词：通用段 + 角色卡段；不是 generate 模式；工具全集含试跑
    const first = irs[0]!;
    const system = textOfIr({
      ...first,
      segments: first.segments.filter((s) => s.role === 'system'),
    });
    expect(system).toContain('先读后写');
    expect(system).toContain('字段速查');
    expect(system).not.toContain('从一句话生成整张角色卡');
    expect(system).toContain(`id ${card.id}`);
    expect(first.tools?.map((t) => t.name)).toEqual([
      'get_field',
      'set_field',
      'list_entries',
      'run_test_turn',
      'inspect_prompt',
      'search_reference',
    ]);
    // 之前几轮协作对话按原角色进了 IR，本轮指令在最后
    expect(first.segments.at(-1)).toMatchObject({ role: 'user' });
    expect(first.segments.some((s) => s.role === 'assistant')).toBe(true);

    // 请求里的草稿没被改；库里的卡没变
    expect(JSON.stringify(draft)).toBe(snapshot);
    const saved = await body<{ data: Json; editedAt: string | null }>(
      await app.request(`/api/characters/${card.id}`),
    );
    expect(saved.data.description).toBe('酒馆老板娘，红发。');
    expect(saved.editedAt).toBe(card.editedAt);
  });

  it('generate：从空卡（无 id）生成整卡含 /character_book → patch 可直接保存为新卡', async () => {
    const { app, db } = makeTestApp(dataDir);
    const book = {
      name: '港口',
      entries: [
        { keys: '灯塔, 北灯塔', content: '灯塔在港口北侧。', comment: '灯塔' },
        { keys: ['雾港'], content: '雾港终年有雾。', insertion_order: 50, enabled: true },
      ],
    };
    const { connectionId, irs } = scripted(db, [
      callsRound(
        ['set_field', { path: '/name', value: '雾港的守灯人' }],
        ['set_field', { path: '/description', value: '{{char}} 是雾港灯塔的守灯人。' }],
        ['set_field', { path: '/personality', value: '沉默寡言' }],
        ['set_field', { path: '/scenario', value: '{{user}} 在雾夜里敲响灯塔的门。' }],
      ),
      callsRound(
        ['set_field', { path: '/first_mes', value: '门开了一条缝。“谁？”' }],
        [
          'set_field',
          { path: '/alternate_greetings', value: '["灯塔顶上，{{char}} 正在擦镜片。"]' },
        ],
        ['set_field', { path: '/mes_example', value: '<START>\n{{user}}: 你好\n{{char}}: ……嗯。' }],
        ['set_field', { path: '/tags', value: ['原创', '奇幻'] }],
        ['set_field', { path: '/character_book', value: book }],
      ),
      textRound('生成好了。'),
    ]);

    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: {},
      conversation: [],
      instruction: '一个住在雾港灯塔里的沉默守灯人',
      mode: 'generate',
      lang: 'zh-CN',
    });

    expect(eventsOf(events, 'tool_result').every((e) => e.data.ok === true)).toBe(true);
    const ops = patchOf(events);
    expect(ops.map((op) => (op as { path: string }).path)).toEqual([
      '/name',
      '/description',
      '/personality',
      '/scenario',
      '/first_mes',
      '/alternate_greetings',
      '/mes_example',
      '/tags',
      '/character_book',
    ]);
    // 空草稿：全部是新字段，没有 before 键
    expect(ops.every((op) => !('before' in op))).toBe(true);
    const altOp = ops.find((op) => op.op === 'set' && op.path === '/alternate_greetings');
    expect(altOp).toMatchObject({ value: ['灯塔顶上，{{char}} 正在擦镜片。'] });
    const bookOp = ops.find((op) => op.op === 'set' && op.path === '/character_book') as {
      value: { entries: Json[] };
    };
    // 内嵌书条目补齐了 CCv3 必填字段，关键词字符串切成了数组
    expect(bookOp.value.entries[0]).toMatchObject({
      keys: ['灯塔', '北灯塔'],
      enabled: true,
      insertion_order: 100,
      extensions: {},
    });
    expect(bookOp.value.entries[1]).toMatchObject({ insertion_order: 50 });

    // 无 id：没有试跑类工具；系统提示词带 generate 步骤
    const tools = irs[0]!.tools?.map((t) => t.name);
    expect(tools).not.toContain('run_test_turn');
    expect(tools).not.toContain('inspect_prompt');
    expect(textOfIr(irs[0]!)).toContain('从一句话生成整张角色卡');

    // 前端把 patch 应用到空草稿后直接新建 → 成功，内嵌书抽进 lorebooks 表
    const data: Json = {};
    for (const op of ops) if (op.op === 'set') data[op.path.slice(1)] = op.value;
    const created = await app.request('/api/characters', json('POST', { name: data.name, data }));
    expect(created.status).toBe(201);
    const card = await body<{ id: string; bookId: string | null }>(created);
    expect(card.bookId).not.toBeNull();
    const entries = db
      .select()
      .from(schema.lorebookEntries)
      .all()
      .filter((e) => e.bookId === card.bookId);
    expect(entries.map((e) => e.content).sort()).toEqual(['灯塔在港口北侧。', '雾港终年有雾。']);

    // 保存后能直接开测试会话生成
    const chat = await body<{ id: string }>(
      await app.request(`/api/studio/test-chat/character/${card.id}`),
    );
    const gen = await app.request(
      `/api/chats/${chat.id}/generate`,
      json('POST', { connectionId, model: 'fake-model-1', userMessage: { text: '有人吗' } }),
    );
    expect(parseSse(await gen.text()).some((e) => e.event === 'done')).toBe(true);
  });

  it('run_test_turn / inspect_prompt 用内存草稿组装，不写入测试会话', async () => {
    const { app, db } = makeTestApp(dataDir);
    const card = await createCard(app);
    const { connectionId, irs } = scripted(
      db,
      [
        callsRound(['set_field', { path: '/description', value: 'DRAFT-DESC-XYZ' }]),
        callsRound(['run_test_turn', { user_message: '你好呀' }], ['inspect_prompt', {}]),
        textRound('试过了。'),
      ],
      { testReply: 'TEST-REPLY：欢迎。' },
    );
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character', id: card.id },
      draft: card.data,
      instruction: '改描述然后试一下',
      lang: 'zh-CN',
    });
    const results = eventsOf(events, 'tool_result');
    expect(results.map((e) => e.data.ok)).toEqual([true, true, true]);
    expect(String(results[1]!.data.content)).toContain('TEST-REPLY');
    const inspect = JSON.parse(String(results[2]!.data.content)) as {
      segments: { origin: string; role: string; tokens: number; preview: string }[];
    };
    expect(inspect.segments.some((s) => s.preview.includes('DRAFT-DESC-XYZ'))).toBe(true);
    expect(inspect.segments.every((s) => typeof s.tokens === 'number')).toBe(true);

    // 试跑请求：没有 tools，用的是改过的草稿 + 这条用户消息
    const testIr = irs.find((ir) => !ir.tools)!;
    const sent = textOfIr(testIr);
    expect(sent).toContain('DRAFT-DESC-XYZ');
    expect(sent).toContain('你好呀');
    expect(sent).not.toContain('酒馆老板娘，红发。');

    // 测试会话建了（与 GET /test-chat 同一条），但没有写入试跑的消息
    const chats = db.select().from(schema.chats).all();
    expect(chats).toHaveLength(1);
    expect(chats[0]!.metadata).toMatchObject({ studio: { kind: 'character', entityId: card.id } });
    const nodes = db.select().from(schema.messageNodes).all();
    expect(nodes.every((n) => n.role === 'assistant' && n.provider === null)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 世界书                                                               */
/* ------------------------------------------------------------------ */

describe('AI 协作者：世界书', () => {
  it('add / update / delete_entry：按 uid 归并出补丁，工具报错回传模型；补丁可直接 PUT', async () => {
    const { app, db } = makeTestApp(dataDir);
    const created = await body<{ id: string }>(
      await app.request('/api/lorebooks', json('POST', { name: '港口' })),
    );
    await app.request(
      `/api/lorebooks/${created.id}`,
      json('PUT', {
        entries: [
          { keys: ['灯塔'], content: '灯塔在北方。', comment: '灯塔' },
          { keys: ['酒馆'], content: '酒馆在码头。', comment: '酒馆' },
          { keys: [], content: '港口终年有雾。', comment: '常驻', constant: true },
        ],
      }),
    );
    const detail = await body<{ name: string; entries: (Json & { uid: number; id: string })[] }>(
      await app.request(`/api/lorebooks/${created.id}`),
    );
    const [lighthouse, tavern] = detail.entries;
    // 编辑器草稿：带界面字段的条目
    const draft = {
      name: detail.name,
      entries: detail.entries.map((e) => ({ ...e, key: e.id })),
    };
    const newUid = Math.max(...detail.entries.map((e) => e.uid)) + 1;

    const { connectionId, irs } = scripted(db, [
      callsRound(['list_entries', { query: '灯塔' }]),
      callsRound(
        ['add_entry', { entry: { key: ['渔市'], content: '渔市清晨开张。', comment: '渔市' } }],
        ['update_entry', { uid: lighthouse!.uid, patch: { content: '灯塔在北方礁石上。' } }],
        ['delete_entry', { uid: tavern!.uid }],
        ['update_entry', { uid: 999, patch: { content: 'x' } }],
        ['update_entry', { uid: lighthouse!.uid, patch: { position: 42 } }],
      ),
      callsRound(['update_entry', { uid: newUid, patch: { content: '渔市天不亮就开张。' } }]),
      textRound('完成。'),
    ]);

    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'lorebook', id: created.id },
      draft,
      instruction: '整理一下港口的条目',
      lang: 'zh-CN',
    });

    const results = eventsOf(events, 'tool_result');
    expect(results.map((e) => e.data.ok)).toEqual([true, true, true, true, false, false, true]);
    expect(String(results[0]!.data.content)).toContain('灯塔在北方。');
    expect(String(results[4]!.data.summary)).toContain('999');
    // 报错以 isError 的 tool_result 回传给模型
    const errors = toolResultParts(irs[2]!).filter((p) => (p as { isError?: boolean }).isError);
    expect(errors).toHaveLength(2);
    expect((errors[1] as { content: string }).content).toContain('position');

    const ops = patchOf(events);
    expect(ops).toEqual([
      {
        op: 'add_entry',
        uid: newUid,
        entry: { keys: ['渔市'], content: '渔市天不亮就开张。', comment: '渔市', uid: newUid },
      },
      {
        op: 'update_entry',
        uid: lighthouse!.uid,
        patch: { content: '灯塔在北方礁石上。' },
        before: { content: '灯塔在北方。' },
      },
      { op: 'delete_entry', uid: tavern!.uid, before: draft.entries[1] },
    ]);
    // 草稿不变、库不变
    expect(draft.entries).toHaveLength(3);
    expect(db.select().from(schema.lorebookEntries).all()).toHaveLength(3);

    // 前端应用补丁后 PUT：新条目沿用补丁里的 uid
    const applied = draft.entries
      .filter((e) => e.uid !== tavern!.uid)
      .map((e) => ({
        id: e.id,
        ...(e.uid === lighthouse!.uid ? { content: '灯塔在北方礁石上。' } : {}),
      }));
    const addOp = ops[0] as Extract<StudioPatchOp, { op: 'add_entry' }>;
    const put = await app.request(
      `/api/lorebooks/${created.id}`,
      json('PUT', { entries: [...applied, addOp.entry], author: 'ai' }),
    );
    expect(put.status).toBe(200);
    const after = await body<{ entries: Json[] }>(put);
    expect(after.entries.find((e) => e.comment === '渔市')).toMatchObject({ uid: newUid });
  });

  it('list_entries 过滤、set_field 只允许 /name', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { connectionId } = scripted(db, [
      callsRound(
        ['set_field', { path: '/name', value: '新港' }],
        ['set_field', { path: '/entries/0/content', value: 'x' }],
        ['add_entry', { entry: { keys: 'a,b', content: 'A' } }],
      ),
      textRound('ok'),
    ]);
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'lorebook' },
      draft: { name: '港', entries: [] },
      instruction: '起个名字',
      mode: 'generate',
      lang: 'en',
    });
    expect(eventsOf(events, 'tool_result').map((e) => e.data.ok)).toEqual([true, false, true]);
    expect(String(eventsOf(events, 'tool_result')[1]!.data.summary)).toContain('/name');
    expect(patchOf(events)).toEqual([
      { op: 'set', path: '/name', value: '新港', before: '港' },
      { op: 'add_entry', uid: 0, entry: { keys: ['a', 'b'], content: 'A', uid: 0 } },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 预设                                                                 */
/* ------------------------------------------------------------------ */

describe('AI 协作者：预设', () => {
  it('set_prompt：改已有条目 / 新建自定义条目并进顺序表；采样参数；不允许的字段报错', async () => {
    const { app, db } = makeTestApp(dataDir);
    const preset = await body<{
      id: string;
      data: Json & { prompts: Json[]; prompt_order: Json[] };
    }>(await app.request('/api/presets', json('POST', { name: '测试预设' })));
    const draft = preset.data;
    const mainIndex = draft.prompts.findIndex((p) => p.identifier === 'main');
    const mainBefore = draft.prompts[mainIndex]!;
    const orderIndex = draft.prompt_order.findIndex((l) => l.character_id === 100001);
    const { connectionId } = scripted(db, [
      callsRound(
        ['set_prompt', { identifier: 'main', content: 'NEW MAIN' }],
        [
          'set_prompt',
          { identifier: 'style', name: '文风', content: '多用短句。', role: 'system' },
        ],
        ['set_prompt', { identifier: 'charDescription', content: 'x' }],
        ['set_field', { path: '/temperature', value: 0.7 }],
        ['set_field', { path: '/chat_completion_source', value: 'claude' }],
      ),
      callsRound(['set_prompt', { identifier: 'style', enabled: false }]),
      textRound('ok'),
    ]);
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'preset', id: preset.id },
      draft,
      instruction: '调一下',
      lang: 'zh-CN',
    });
    expect(eventsOf(events, 'tool_result').map((e) => e.data.ok)).toEqual([
      true,
      true,
      false,
      true,
      false,
      true,
    ]);
    const ops = patchOf(events);
    expect(ops).toEqual([
      {
        op: 'set',
        path: `/prompts/${mainIndex}`,
        value: { ...mainBefore, content: 'NEW MAIN' },
        before: mainBefore,
      },
      {
        op: 'set',
        path: `/prompts/${draft.prompts.length}`,
        value: {
          identifier: 'style',
          name: '文风',
          system_prompt: false,
          marker: false,
          role: 'system',
          content: '多用短句。',
          injection_position: 0,
          injection_depth: 4,
          injection_order: 100,
          forbid_overrides: false,
        },
      },
      {
        op: 'set',
        path: `/prompt_order/${orderIndex}/order`,
        value: [
          ...(draft.prompt_order[orderIndex]!.order as Json[]),
          { identifier: 'style', enabled: false },
        ],
        before: draft.prompt_order[orderIndex]!.order,
      },
      { op: 'set', path: '/temperature', value: 0.7, before: draft.temperature },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* 循环控制                                                             */
/* ------------------------------------------------------------------ */

describe('AI 协作者：循环控制', () => {
  it(`步数上限：最多调 ${MAX_ASSIST_STEPS} 次模型，最后一次强制 toolChoice=none 并提示总结`, async () => {
    const { app, db } = makeTestApp(dataDir);
    const { connectionId, irs, rounds } = scripted(db, () =>
      callsRound(['get_field', { path: '/name' }]),
    );
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: { name: '甲' },
      instruction: '一直读',
      lang: 'zh-CN',
    });
    expect(rounds()).toBe(MAX_ASSIST_STEPS);
    expect(eventsOf(events, 'tool')).toHaveLength(MAX_ASSIST_STEPS - 1);
    expect(irs.at(-1)!.toolChoice).toBe('none');
    expect(irs.at(-2)!.toolChoice).toBe('auto');
    expect(textOfIr(irs.at(-1)!)).toContain('步数上限');
    expect(patchOf(events)).toEqual([]);
    expect(eventsOf(events, 'done')[0]!.data).toEqual({
      steps: MAX_ASSIST_STEPS,
      stopReason: 'max_steps',
    });
  });

  it('参数坏掉 / 未知工具 / 父级不存在：以错误结果回传，循环继续', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { connectionId, irs } = scripted(db, [
      callsRound(
        ['set_field', '{"path": "/description", '],
        ['fly_away', {}],
        ['set_field', { path: '/extensions/depth_prompt/prompt', value: '要点' }],
        ['add_entry', { entry: { content: 'x' } }],
        ['run_test_turn', { user_message: 'hi' }],
      ),
      textRound('知道了'),
    ]);
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: { name: '乙' },
      instruction: '试试',
      lang: 'zh-CN',
    });
    const results = eventsOf(events, 'tool_result');
    expect(results.map((e) => e.data.ok)).toEqual([false, false, false, false, false]);
    expect(String(results[0]!.data.summary)).toContain('JSON');
    expect(String(results[1]!.data.summary)).toContain('fly_away');
    expect(String(results[2]!.data.summary)).toContain('/extensions');
    expect(String(results[4]!.data.summary)).toContain('保存');
    const parts = toolResultParts(irs[1]!);
    expect(parts).toHaveLength(5);
    expect(parts.every((p) => (p as { isError?: boolean }).isError === true)).toBe(true);
    expect(eventsOf(events, 'done')[0]!.data).toEqual({ steps: 2, stopReason: 'end' });
  });

  it('上游错误：先发 patch（已做的改动），再发 error，不发 done', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { connectionId } = scripted(db, [
      callsRound(['set_field', { path: '/description', value: 'D' }]),
      [
        {
          type: 'error',
          error: { kind: 'invalid', message: '上游炸了', retryable: false },
          retryable: false,
        },
      ],
    ]);
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: { name: '丙' },
      instruction: '改',
      lang: 'zh-CN',
    });
    expect(events.slice(-3).map((e) => e.event)).toEqual(['patch', 'usage', 'error']);
    expect(patchOf(events)).toEqual([{ op: 'set', path: '/description', value: 'D' }]);
    expect(eventsOf(events, 'error')[0]!.data).toEqual({ message: '上游炸了', kind: 'invalid' });
    expect(eventsOf(events, 'done')).toHaveLength(0);
  });

  it('限流 / 过载且还没有输出：退避重试同一次调用，最多重试两次', async () => {
    const saved = [...RETRY_DELAYS_MS];
    RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 1, 1);
    try {
      const { app, db } = makeTestApp(dataDir);
      const overloaded: GenEvent[] = [
        {
          type: 'error',
          error: { kind: 'overloaded', message: '过载', status: 429, retryable: true },
          retryable: true,
        },
      ];
      const { connectionId, rounds } = scripted(db, [
        overloaded,
        callsRound(['set_field', { path: '/description', value: 'R' }]),
        overloaded,
        overloaded,
        overloaded,
      ]);
      const events = await assist(app, {
        connectionId,
        model: 'fake-model-1',
        target: { kind: 'character' },
        draft: { name: '己' },
        instruction: '改',
        lang: 'zh-CN',
      });
      // 第 1 次调用：失败 1 次后成功；第 2 次调用：失败 3 次（1 + 2 次重试）后放弃
      expect(rounds()).toBe(5);
      expect(patchOf(events)).toEqual([{ op: 'set', path: '/description', value: 'R' }]);
      expect(eventsOf(events, 'error')[0]!.data).toEqual({ message: '过载', kind: 'overloaded' });
    } finally {
      RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, ...saved);
    }
  });

  it('模型不支持工具：走文本协议降级，正文里不出现协议代码块', async () => {
    const { app, db } = makeTestApp(dataDir);
    const call = JSON.stringify({
      name: 'set_field',
      arguments: { path: '/description', value: 'FB' },
    });
    const { connectionId, irs } = scripted(
      db,
      [textRound(`我来改。\n\`\`\`tool_call\n${call}\n\`\`\``), textRound('好了。')],
      { caps: { tools: false } },
    );
    const events = await assist(app, {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: { name: '丁', description: '旧' },
      instruction: '改描述',
      lang: 'zh-CN',
    });
    const text = eventsOf(events, 'text')
      .map((e) => e.data.delta)
      .join('');
    expect(text).toContain('我来改。');
    expect(text).toContain('好了。');
    expect(text).not.toContain('tool_call');
    expect(patchOf(events)).toEqual([
      { op: 'set', path: '/description', value: 'FB', before: '旧' },
    ]);
    // 第二次请求：工具定义被换成协议说明，历史里的调用 / 结果渲染成文本
    expect(irs[1]!.tools).toBeUndefined();
    expect(textOfIr(irs[1]!)).toContain('```tool_result set_field');
    expect(eventsOf(events, 'tool_result')[0]!.data.ok).toBe(true);
  });

  it('客户端断开：中止上游，不再发起新的模型调用', async () => {
    const { app, db } = makeTestApp(dataDir);
    let aborted = false;
    let calls = 0;
    const id = `fake-assist-slow-${(seq += 1)}`;
    registerFakeAdapter({
      id,
      capabilities: { tools: true },
      stream: async function* slow(_conn, _req, signal) {
        calls += 1;
        if (calls === 1) {
          yield* callsRound(['get_field', { path: '/name' }]);
          return;
        }
        yield { type: 'text.delta', text: '思考中……' };
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        aborted = true;
        yield { type: 'stop', reason: 'abort' };
      },
    });
    const conn = insertConnection(db, dataDir, id);
    const res = await app.request(
      '/api/studio/assist',
      json('POST', {
        connectionId: conn.id,
        model: 'm',
        target: { kind: 'character' },
        draft: { name: '戊' },
        instruction: '慢慢来',
        lang: 'zh-CN',
      }),
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let acc = '';
    while (!acc.includes('思考中')) {
      const { value, done } = await reader.read();
      if (done) break;
      acc += decoder.decode(value, { stream: true });
    }
    expect(acc).toContain('event: tool_result');
    await reader.cancel();
    await waitFor(() => aborted);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(calls).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 请求校验                                                             */
/* ------------------------------------------------------------------ */

describe('AI 协作者：请求校验', () => {
  it('400 / 404 在开流之前返回', async () => {
    const { app, db } = makeTestApp(dataDir);
    const { connectionId } = scripted(db, [textRound('x')]);
    const base = {
      connectionId,
      model: 'fake-model-1',
      target: { kind: 'character' },
      draft: {},
      instruction: '做点什么',
    };
    const post = (payload: unknown) => app.request('/api/studio/assist', json('POST', payload));
    expect((await post({ ...base, target: { kind: 'widget' } })).status).toBe(400);
    expect((await post({ ...base, instruction: ' ' })).status).toBe(400);
    expect((await post({ ...base, draft: [] })).status).toBe(400);
    expect((await post({ ...base, mode: 'rewrite' })).status).toBe(400);
    expect((await post({ ...base, conversation: [{ role: 'system', content: 'x' }] })).status).toBe(
      400,
    );
    expect((await post({ ...base, target: { kind: 'preset', id: 'nope' } })).status).toBe(404);
    const noConn = await post({ ...base, connectionId: undefined, model: undefined });
    expect(noConn.status).toBe(400);
    expect((await body(noConn)).error).toBe('no_connection');
    expect((await post({ ...base, connectionId: 'missing' })).status).toBe(400);
  });
});

/* ------------------------------------------------------------------ */
/* 预设布局策略                                                         */
/* ------------------------------------------------------------------ */

describe('预设布局策略（§6 修正）', () => {
  it('PUT /api/presets/:id/layout-policy：只写布局策略，写版本；校验；null 清空', async () => {
    const { app } = makeTestApp(dataDir);
    const preset = await body<{ id: string; data: Json }>(
      await app.request('/api/presets', json('POST', { name: '布局' })),
    );
    const url = `/api/presets/${preset.id}/layout-policy`;
    const policy = { mode: 'cache-aware', lockedIdentifiers: ['main', 'jailbreak'] };
    const res = await app.request(url, json('PUT', { layoutPolicy: policy, author: 'ai' }));
    expect(res.status).toBe(200);
    const row = await body<{ layoutPolicy: Json | null; data: Json }>(res);
    expect(row.layoutPolicy).toEqual(policy);
    expect(row.data).toEqual(preset.data);

    const versions = await body<{ version: number; author: string }[]>(
      await app.request(`/api/versions/preset/${preset.id}`),
    );
    expect(versions[0]).toMatchObject({ version: 2, author: 'ai' });
    const v2 = await body<Json>(await app.request(`/api/versions/preset/${preset.id}/2`));
    expect(JSON.stringify(v2)).toContain('cache-aware');

    expect((await app.request(url, json('PUT', { layoutPolicy: { mode: 'loose' } }))).status).toBe(
      400,
    );
    expect(
      (await app.request(url, json('PUT', { layoutPolicy: { lockedIdentifiers: 'main' } }))).status,
    ).toBe(400);
    expect((await app.request(url, json('PUT', {}))).status).toBe(400);
    expect(
      (await app.request('/api/presets/nope/layout-policy', json('PUT', { layoutPolicy: null })))
        .status,
    ).toBe(404);

    const cleared = await app.request(url, json('PUT', { layoutPolicy: null }));
    expect((await body<{ layoutPolicy: unknown }>(cleared)).layoutPolicy).toBeNull();

    // 整份 PUT 也能顺带写布局策略（缺省 = 不动）
    const put = await app.request(
      `/api/presets/${preset.id}`,
      json('PUT', { data: preset.data, layoutPolicy: { mode: 'strict' } }),
    );
    expect((await body<{ layoutPolicy: unknown }>(put)).layoutPolicy).toEqual({ mode: 'strict' });
    const keep = await app.request(`/api/presets/${preset.id}`, json('PUT', { data: preset.data }));
    expect((await body<{ layoutPolicy: unknown }>(keep)).layoutPolicy).toEqual({ mode: 'strict' });
  });
});
