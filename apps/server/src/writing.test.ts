import fs from 'node:fs';

import type { GenEvent, ProviderRequest } from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import type {
  WritingDocumentDetail,
  WritingInspectResponse,
  WritingProjectDetail,
  WritingProjectSummary,
  WritingVersionDetail,
  WritingVersionSummary,
} from './routes/writing.js';
import { waitForSummary } from './services/writing-ai.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  registerFakeAdapter,
  waitFor,
} from './test-helpers.js';

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

type App = ReturnType<typeof makeTestApp>['app'];

async function call<T>(
  app: App,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; body: T }> {
  const res = await app.request(`/api/writing${path}`, init);
  const text = await res.text();
  return {
    status: res.status,
    body: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T,
  };
}

async function newProject(
  app: App,
  body: Record<string, unknown> = {},
): Promise<WritingProjectDetail> {
  const res = await call<WritingProjectDetail>(
    app,
    '/projects',
    json('POST', { title: '剑来北境', ...body }),
  );
  expect(res.status).toBe(201);
  return res.body;
}

async function newDoc(
  app: App,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<WritingDocumentDetail> {
  const res = await call<WritingDocumentDetail>(
    app,
    `/projects/${projectId}/documents`,
    json('POST', { kind: 'chapter', ...body }),
  );
  expect(res.status).toBe(201);
  return res.body;
}

const putDoc = (app: App, id: string, body: Record<string, unknown>) =>
  call<WritingDocumentDetail>(app, `/documents/${id}`, json('PUT', body));

function insertBible(db: Db): string {
  const book = db.insert(schema.lorebooks).values({ name: '剑来设定' }).returning().get();
  db.insert(schema.lorebookEntries)
    .values([
      {
        bookId: book.id,
        uid: 0,
        keys: [],
        content: '世界观：灵气复苏后的第十年。',
        constant: true,
        entryOrder: 10,
      },
      {
        bookId: book.id,
        uid: 1,
        keys: ['青岚宗'],
        content: '青岚宗：北境第一剑宗，宗主沈墨。',
        entryOrder: 50,
      },
      {
        bookId: book.id,
        uid: 2,
        keys: ['赤焰'],
        content: '赤焰：林澈的佩剑，遇水则暗。',
        entryOrder: 40,
      },
    ])
    .run();
  return book.id;
}

let adapterSeq = 0;
interface Capture {
  requests: ProviderRequest[];
}
function fakeWriter(
  events: GenEvent[],
  opts: { delayMs?: number; capture?: Capture } = {},
): string {
  adapterSeq += 1;
  const id = `fake-writing-${adapterSeq}`;
  registerFakeAdapter({
    id,
    renderMessages: true,
    capabilities: { caching: 'breakpoints', maxBreakpoints: 4, maxContext: 100_000 },
    stream: async function* (_conn, req) {
      opts.capture?.requests.push(req);
      if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
      for (const ev of events) yield ev;
    },
  });
  return id;
}

const OK_EVENTS: GenEvent[] = [
  { type: 'text.delta', text: '沈墨' },
  { type: 'text.delta', text: '推门而出。' },
  { type: 'usage', input: 1200, output: 10, cacheRead: 800, cacheWrite: 0, reasoning: 0 },
  { type: 'stop', reason: 'end' },
];

describe('写作：项目与文档', () => {
  it('项目增删改查；settings 浅合并', async () => {
    const { app } = makeTestApp(dataDir);
    const created = await newProject(app, { settings: { styleGuide: '冷峻' } });
    expect(created.settings).toMatchObject({ layoutMode: 'cache-aware', styleGuide: '冷峻' });

    const put = await call<WritingProjectDetail>(
      app,
      `/projects/${created.id}`,
      json('PUT', {
        outline: '大纲',
        settings: { model: 'm1', styleGuide: null },
        lorebookIds: ['a', 'a'],
      }),
    );
    expect(put.status).toBe(200);
    expect(put.body.outline).toBe('大纲');
    expect(put.body.lorebookIds).toEqual(['a']);
    expect(put.body.settings).toMatchObject({
      model: 'm1',
      styleGuide: '',
      layoutMode: 'cache-aware',
    });

    const bad = await call(
      app,
      `/projects/${created.id}`,
      json('PUT', { settings: { layoutMode: 'x' } }),
    );
    expect(bad.status).toBe(400);

    const list = await call<WritingProjectSummary[]>(app, '/projects');
    expect(list.body.map((p) => p.id)).toEqual([created.id]);

    const del = await call(app, `/projects/${created.id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await call(app, `/projects/${created.id}`)).status).toBe(404);
  });

  it('文档新建（afterId 插入）、排序、字数、删除', async () => {
    const { app, db } = makeTestApp(dataDir);
    const project = await newProject(app);
    const c1 = await newDoc(app, project.id, { title: '一' });
    const c3 = await newDoc(app, project.id, { title: '三' });
    const c2 = await newDoc(app, project.id, { title: '二', afterId: c1.id });
    const note = await newDoc(app, project.id, { kind: 'note', title: '人物表' });
    expect(note.order).toBe(0);

    let detail = (await call<WritingProjectDetail>(app, `/projects/${project.id}`)).body;
    expect(detail.documents.map((d) => d.title)).toEqual(['一', '二', '三', '人物表']);
    // 列表不含正文
    expect(detail.documents[0]).not.toHaveProperty('text');

    const reordered = await call<WritingProjectDetail>(
      app,
      `/projects/${project.id}/order`,
      json('PUT', { ids: [c3.id, c1.id, c2.id] }),
    );
    expect(reordered.body.documents.map((d) => d.title)).toEqual(['三', '一', '二', '人物表']);

    const other = await newProject(app, { title: '别的' });
    const foreign = await newDoc(app, other.id);
    expect(
      (await call(app, `/projects/${project.id}/order`, json('PUT', { ids: [foreign.id] }))).status,
    ).toBe(400);

    // 字数：中文按字、英文按词
    const zh = await putDoc(app, c1.id, { text: '林澈跪在殿前。', content: { type: 'doc' } });
    expect(zh.body.wordCount).toBe(7);
    expect(zh.body.content).toEqual({ type: 'doc' });
    const en = await putDoc(app, c2.id, { text: "He didn't look back." });
    expect(en.body.wordCount).toBe(4);
    detail = (await call<WritingProjectDetail>(app, `/projects/${project.id}`)).body;
    expect(detail.wordCount).toBe(11);
    const list = (await call<WritingProjectSummary[]>(app, '/projects')).body;
    expect(list.find((p) => p.id === project.id)).toMatchObject({
      chapterCount: 3,
      noteCount: 1,
      wordCount: 11,
    });

    expect((await call(app, `/documents/${c3.id}`, { method: 'DELETE' })).status).toBe(200);
    expect((await call(app, `/documents/${c3.id}`)).status).toBe(404);
    // 删项目级联删文档
    await call(app, `/projects/${project.id}`, { method: 'DELETE' });
    expect(
      db.select().from(schema.documents).where(eq(schema.documents.projectId, project.id)).all(),
    ).toEqual([]);
  });

  it('改正文后已有摘要标记过期；写摘要清除过期', async () => {
    const { app } = makeTestApp(dataDir);
    const project = await newProject(app);
    const doc = await newDoc(app, project.id);
    await putDoc(app, doc.id, { text: '第一稿' });
    const withSummary = await putDoc(app, doc.id, { summary: '摘要' });
    expect(withSummary.body.summaryStale).toBe(false);
    const same = await putDoc(app, doc.id, { text: '第一稿', title: '改标题' });
    expect(same.body.summaryStale).toBe(false);
    const changed = await putDoc(app, doc.id, { text: '第二稿' });
    expect(changed.body.summaryStale).toBe(true);
    const fixed = await putDoc(app, doc.id, { summary: '新摘要' });
    expect(fixed.body).toMatchObject({ summary: '新摘要', summaryStale: false });
  });

  it('导出 md / txt：按章节顺序、笔记不导出', async () => {
    const { app } = makeTestApp(dataDir);
    const project = await newProject(app);
    const a = await newDoc(app, project.id, { title: '雪夜' });
    const b = await newDoc(app, project.id, { title: '' });
    const n = await newDoc(app, project.id, { kind: 'note', title: '笔记' });
    await putDoc(app, a.id, { text: '雪落无声。\n\n林澈上山。' });
    await putDoc(app, b.id, { text: '试剑。' });
    await putDoc(app, n.id, { text: '不该出现' });

    const res = await app.request(`/api/writing/projects/${project.id}/export?format=md`);
    expect(res.headers.get('content-type')).toContain('text/markdown');
    expect(res.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(await res.text()).toBe(
      '# 剑来北境\n\n## 雪夜\n\n雪落无声。\n\n林澈上山。\n\n## 第2章\n\n试剑。\n',
    );

    const txt = await (
      await app.request(`/api/writing/projects/${project.id}/export?format=txt`)
    ).text();
    expect(txt).toBe('剑来北境\n\n\n雪夜\n\n雪落无声。\n\n林澈上山。\n\n\n第2章\n\n试剑。\n');
    expect(txt).not.toContain('不该出现');
    expect(
      (await app.request(`/api/writing/projects/${project.id}/export?format=pdf`)).status,
    ).toBe(400);
  });
});

describe('写作：版本', () => {
  it('手动存版；与上一版相同不写；恢复前先存当前稿', async () => {
    const { app } = makeTestApp(dataDir);
    const project = await newProject(app);
    const doc = await newDoc(app, project.id);
    await putDoc(app, doc.id, { text: '甲', content: { v: 1 } });
    const v1 = await call<{ version: number | null }>(
      app,
      `/documents/${doc.id}/versions`,
      json('POST', { label: '初稿' }),
    );
    expect(v1).toEqual({ status: 201, body: { version: 1 } });
    const dup = await call<{ version: number | null }>(
      app,
      `/documents/${doc.id}/versions`,
      json('POST', {}),
    );
    expect(dup.body.version).toBeNull();

    await putDoc(app, doc.id, { text: '乙乙', content: { v: 2 } });
    const v2 = await call<{ version: number }>(
      app,
      `/documents/${doc.id}/versions`,
      json('POST', { author: 'ai' }),
    );
    expect(v2.body.version).toBe(2);
    await putDoc(app, doc.id, { text: '丙丙丙', content: { v: 3 } });

    const restored = await call<{ document: WritingDocumentDetail; savedVersion: number | null }>(
      app,
      `/documents/${doc.id}/versions/1/restore`,
      { method: 'POST' },
    );
    expect(restored.body.savedVersion).toBe(3);
    expect(restored.body.document).toMatchObject({ text: '甲', content: { v: 1 }, wordCount: 1 });

    const list = (await call<WritingVersionSummary[]>(app, `/documents/${doc.id}/versions`)).body;
    expect(list.map((v) => [v.version, v.author, v.label])).toEqual([
      [3, 'user', 'before:restore'],
      [2, 'ai', null],
      [1, 'user', '初稿'],
    ]);
    expect(list[0]?.wordCount).toBe(3);
    const one = (await call<WritingVersionDetail>(app, `/documents/${doc.id}/versions/3`)).body;
    expect(one).toMatchObject({ text: '丙丙丙', content: { v: 3 } });
    expect((await call(app, `/documents/${doc.id}/versions/99`)).status).toBe(404);
  });

  it('只保留最近 100 版', async () => {
    const { app } = makeTestApp(dataDir);
    const project = await newProject(app);
    const doc = await newDoc(app, project.id);
    for (let i = 1; i <= 105; i += 1) {
      await putDoc(app, doc.id, { text: `稿${i}` });
      await call(app, `/documents/${doc.id}/versions`, json('POST', {}));
    }
    const list = (await call<WritingVersionSummary[]>(app, `/documents/${doc.id}/versions`)).body;
    expect(list).toHaveLength(100);
    expect(list[0]?.version).toBe(105);
    expect(list[99]?.version).toBe(6);
  });
});

/** 建一个带圣经、两章已完成摘要、当前第三章的项目 */
async function setupStory(app: App, db: Db, provider: string) {
  const conn = insertConnection(db, dataDir, provider);
  const bookId = insertBible(db);
  const project = await newProject(app, {
    outline: '第一卷：入宗。',
    lorebookIds: [bookId],
    settings: { connectionId: conn.id, model: 'fake-model-1', styleGuide: '冷峻克制。' },
  });
  const c1 = await newDoc(app, project.id, { title: '雪夜' });
  const c2 = await newDoc(app, project.id, { title: '试剑' });
  const c3 = await newDoc(app, project.id, { title: '拜师' });
  await putDoc(app, c1.id, { text: '雪夜上山。', summary: '林澈雪夜上山。', done: true });
  await putDoc(app, c2.id, { text: '试剑台上。', summary: '林澈通过试剑。', done: true });
  await putDoc(app, c3.id, { text: '林澈跪在殿前。殿门紧闭。' });
  return { project, c1, c2, c3, conn };
}

function messagesOf(req: ProviderRequest): { role: string; content: string }[] {
  return (req.body as { messages: { role: string; content: string }[] }).messages;
}

describe('写作：AI 动作', () => {
  it('SSE 事件、请求里各段顺序、圣经触发、选区进指令、前置存版、用量入库', async () => {
    const { app, db } = makeTestApp(dataDir);
    const capture: Capture = { requests: [] };
    const provider = fakeWriter(OK_EVENTS, { capture });
    const { c3 } = await setupStory(app, db, provider);

    const res = await app.request(
      `/api/writing/documents/${c3.id}/ai`,
      json('POST', {
        action: 'rewrite',
        instruction: '更有压迫感',
        textBefore: '林澈跪在殿前。',
        selectionText: '青岚宗的殿门紧闭。',
        textAfter: '他没有抬头。',
      }),
    );
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = parseSse(await res.text());
    expect(events.map((e) => e.event)).toEqual(['context', 'text', 'text', 'usage', 'done']);
    const done = events.at(-1)?.data as {
      text: string;
      beforeVersion: number | null;
      usage: { cacheRead: number };
    };
    expect(done.text).toBe('沈墨推门而出。');
    expect(done.usage.cacheRead).toBe(800);
    expect(done.beforeVersion).toBe(1);
    const report = (
      events[0]?.data as { report: { bible: { entryId: string; placement: string }[] } }
    ).report;
    expect(report.bible.map((b) => b.placement).sort()).toEqual(['static', 'turn']);

    // 请求：system 在前（系统提示词 → 风格 → 常驻设定 → 大纲 → 摘要），user 在后（正文 → 触发设定 → 指令）
    const messages = messagesOf(capture.requests[0] as ProviderRequest);
    expect(messages.map((m) => m.role)).toEqual(['system', 'user']);
    const system = messages[0]?.content ?? '';
    const markers = [
      '《剑来北境》',
      '冷峻克制。',
      '灵气复苏',
      '第一卷：入宗。',
      '林澈雪夜上山。',
      '林澈通过试剑。',
    ];
    const positions = markers.map((m) => system.indexOf(m));
    expect(positions.every((p) => p >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    const user = messages[1]?.content ?? '';
    const userMarkers = [
      '林澈跪在殿前。',
      '宗主沈墨',
      '青岚宗的殿门紧闭。',
      '他没有抬头。',
      '更有压迫感',
    ];
    const userPositions = userMarkers.map((m) => user.indexOf(m));
    expect(userPositions.every((p) => p >= 0)).toBe(true);
    expect([...userPositions].sort((a, b) => a - b)).toEqual(userPositions);
    // 未触发的条目不进上下文
    expect(`${system}${user}`).not.toContain('遇水则暗');

    // 动作前存了一版，文档本身没被改
    const versions = (await call<WritingVersionSummary[]>(app, `/documents/${c3.id}/versions`))
      .body;
    expect(versions.map((v) => v.label)).toEqual(['before:rewrite']);
    expect((await call<WritingDocumentDetail>(app, `/documents/${c3.id}`)).body.text).toBe(
      '林澈跪在殿前。殿门紧闭。',
    );
    // 用量写 generation_log，nodeId 为空
    const logs = db.select().from(schema.generationLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ nodeId: null, provider, layoutMode: 'cache-aware' });
    expect(logs[0]?.usage).toMatchObject({ cacheRead: 800 });
  });

  it('summarize 动作写回摘要并清除过期标记', async () => {
    const { app, db } = makeTestApp(dataDir);
    const provider = fakeWriter([
      { type: 'text.delta', text: '  林澈拜入青岚宗。 ' },
      { type: 'stop', reason: 'end' },
    ]);
    const { c2 } = await setupStory(app, db, provider);
    await putDoc(app, c2.id, { text: '试剑台上，改过。' });
    expect((await call<WritingDocumentDetail>(app, `/documents/${c2.id}`)).body.summaryStale).toBe(
      true,
    );

    const events = parseSse(
      await (
        await app.request(
          `/api/writing/documents/${c2.id}/ai`,
          json('POST', { action: 'summarize' }),
        )
      ).text(),
    );
    expect(events.at(-1)).toMatchObject({ event: 'done', data: { summary: '林澈拜入青岚宗。' } });
    const doc = (await call<WritingDocumentDetail>(app, `/documents/${c2.id}`)).body;
    expect(doc).toMatchObject({ summary: '林澈拜入青岚宗。', summaryStale: false });
  });

  it('提供商报错时发 error 事件', async () => {
    const { app, db } = makeTestApp(dataDir);
    const provider = fakeWriter([
      {
        type: 'error',
        error: { kind: 'overloaded', message: '上游炸了', retryable: false },
        retryable: false,
      },
    ]);
    const { c3 } = await setupStory(app, db, provider);
    const events = parseSse(
      await (
        await app.request(
          `/api/writing/documents/${c3.id}/ai`,
          json('POST', { action: 'continue' }),
        )
      ).text(),
    );
    expect(events.map((e) => e.event)).toEqual(['context', 'error']);
    expect(events[1]?.data).toMatchObject({ message: '上游炸了' });
  });

  it('没有连接时 AI 返回 400，inspect 仍可用', async () => {
    const { app } = makeTestApp(dataDir);
    const project = await newProject(app, { outline: '大纲' });
    const doc = await newDoc(app, project.id);
    const res = await call<{ error: string }>(
      app,
      `/documents/${doc.id}/ai`,
      json('POST', { action: 'continue' }),
    );
    expect(res).toMatchObject({ status: 400, body: { error: 'no_connection' } });
    const bad = await call(app, `/documents/${doc.id}/ai`, json('POST', { action: 'nope' }));
    expect(bad.status).toBe(400);

    const inspect = await call<WritingInspectResponse>(
      app,
      `/projects/${project.id}/inspect`,
      json('POST', { docId: doc.id, action: 'continue', cursor: 0 }),
    );
    expect(inspect.status).toBe(200);
    expect(inspect.body.connected).toBe(false);
    expect(inspect.body.segments.map((s) => s.id)).toEqual([
      'writing:system',
      'writing:outline',
      'writing:chapter',
      'writing:action',
    ]);
  });

  it('inspect 不调用模型，返回段落与 report（断点在 static / session 末尾）', async () => {
    const { app, db } = makeTestApp(dataDir);
    const capture: Capture = { requests: [] };
    const provider = fakeWriter(OK_EVENTS, { capture });
    const { project, c3 } = await setupStory(app, db, provider);
    const res = await call<WritingInspectResponse>(
      app,
      `/projects/${project.id}/inspect`,
      json('POST', { docId: c3.id, action: 'continue', cursor: 3, instruction: '写赤焰' }),
    );
    expect(capture.requests).toHaveLength(0);
    expect(res.body.connected).toBe(true);
    const ids = res.body.segments.map((s) => s.id);
    expect(ids).toEqual([
      'writing:system',
      'writing:style',
      'writing:bible-constant',
      'writing:outline',
      'writing:summaries',
      'writing:chapter',
      'writing:bible-triggered',
      'writing:action',
    ]);
    expect(res.body.cachePlan.breakpoints.map((i) => ids[i])).toEqual([
      'writing:outline',
      'writing:summaries',
    ]);
    expect(res.body.report.bible.find((b) => b.placement === 'turn')?.entryId).toContain(':2');
    // cursor=3：光标前只有「林澈跪」
    const chapter = res.body.segments.find((s) => s.id === 'writing:chapter');
    expect(JSON.stringify(chapter)).toContain('林澈跪');
    expect(JSON.stringify(chapter)).not.toContain('殿前');
    expect(db.select().from(schema.generationLog).all()).toHaveLength(0);
  });

  it('章节标记完成：后台生成摘要，不阻塞 PUT', async () => {
    const { app, db } = makeTestApp(dataDir);
    const capture: Capture = { requests: [] };
    const provider = fakeWriter(
      [
        { type: 'text.delta', text: '林澈跪求拜师。' },
        { type: 'stop', reason: 'end' },
      ],
      { delayMs: 80, capture },
    );
    const { c3 } = await setupStory(app, db, provider);
    const put = await putDoc(app, c3.id, { done: true });
    // PUT 立即返回，摘要还没写
    expect(put.body).toMatchObject({ done: true, summary: '', summaryPending: true });
    await waitFor(() => {
      const row = db.select().from(schema.documents).where(eq(schema.documents.id, c3.id)).get();
      return row?.summary === '林澈跪求拜师。';
    });
    await waitForSummary(c3.id);
    const doc = (await call<WritingDocumentDetail>(app, `/documents/${c3.id}`)).body;
    expect(doc).toMatchObject({ summaryPending: false, summaryStale: false });
    // 摘要请求：summarize 模板 + 整章正文
    const user = messagesOf(capture.requests[0] as ProviderRequest).at(-1)?.content ?? '';
    expect(user).toContain('林澈跪在殿前。殿门紧闭。');
    expect(user).toContain('200–400');

    // 已有未过期摘要时再标记完成不重复生成
    await putDoc(app, c3.id, { done: false });
    await putDoc(app, c3.id, { done: true });
    await waitForSummary(c3.id);
    expect(capture.requests).toHaveLength(1);
  });

  it('后台摘要失败不影响保存，摘要仍为空', async () => {
    const { app, db } = makeTestApp(dataDir);
    const provider = fakeWriter([
      {
        type: 'error',
        error: { kind: 'overloaded', message: 'boom', retryable: false },
        retryable: false,
      },
    ]);
    const { c3 } = await setupStory(app, db, provider);
    const put = await putDoc(app, c3.id, { done: true });
    expect(put.status).toBe(200);
    await waitForSummary(c3.id);
    const doc = (await call<WritingDocumentDetail>(app, `/documents/${c3.id}`)).body;
    expect(doc).toMatchObject({ done: true, summary: '', summaryPending: false });
  });
});
