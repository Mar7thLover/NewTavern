import fs from 'node:fs';

import type { Part, PromptIR } from '@newtavern/core';
import {
  openaiChatAdapter,
  registry,
  type BuildOptions,
  type GenEvent,
  type ProviderAdapter,
  type ProviderId,
  type ProviderRequest,
} from '@newtavern/providers';
import { eq } from 'drizzle-orm';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { schema, type Db } from './db/client.js';
import { createAssetsService } from './services/assets.js';
import { GC_MIN_AGE_MS } from './services/media-gc.js';
import { makePdf, PNG_2X3, pngVariant } from './services/media-fixtures.test-helper.js';
import { inlineDocumentParts } from './services/media-inline.js';
import { requestForStorage } from './services/provider-request.js';
import {
  insertConnection,
  makeTempDataDir,
  makeTestApp,
  parseSse,
  type TestApp,
} from './test-helpers.js';

/**
 * 多模态服务端（docs/M4-CONTRACT.md §3.3）：上传、附件入树、组装前内联、解析器与脱敏、生图落库、清理。
 */

const dataDir = makeTempDataDir();
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

const json = (method: string, body: unknown) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
const post = (body: unknown) => json('POST', body);

interface UploadBody {
  id: string;
  kind: string;
  mime: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  pages?: number;
  textLength?: number;
}
interface Node {
  id: string;
  role: string;
  parts: Part[];
  extra: Record<string, unknown> | null;
}

async function upload(app: TestApp['app'], bytes: Uint8Array, name: string) {
  const form = new FormData();
  form.append('file', new File([bytes], name));
  return app.request('/api/assets', { method: 'POST', body: form });
}
async function uploadOk(app: TestApp['app'], bytes: Uint8Array, name: string) {
  const res = await upload(app, bytes, name);
  expect(res.status).toBe(201);
  return (await res.json()) as UploadBody;
}

// ───────────────────────── 录制型适配器 ─────────────────────────
//
// buildRequest 委托给真实的 openai-chat 适配器（能力来自连接的 modelOverrides），
// 把 IR / 选项 / 请求体记下来；stream 回放 `nextEvents`。

interface Captured {
  ir: PromptIR;
  opts: BuildOptions | undefined;
  request: ProviderRequest;
}
const captured: Captured[] = [];
let nextEvents: GenEvent[] = [];

const recordingAdapter: ProviderAdapter = {
  id: 'mm-chat' as ProviderId,
  listModels: () => Promise.resolve([{ id: 'vision-1' }]),
  capabilities: (model, conn) =>
    openaiChatAdapter.capabilities(model, { ...conn, provider: 'openai-chat' }),
  buildRequest: (ir, conn, model, opts) => {
    const request = openaiChatAdapter.buildRequest(
      ir,
      { ...conn, provider: 'openai-chat' },
      model,
      opts,
    );
    captured.push({ ir, opts, request });
    return request;
  },
  stream: async function* replay() {
    for (const event of nextEvents) yield event;
  },
  normalizeError: (e) => ({ kind: 'network', message: String(e), retryable: false }),
};
registry.register(recordingAdapter);

const DONE_EVENTS: GenEvent[] = [
  { type: 'text.delta', text: '看到了。' },
  { type: 'stop', reason: 'end' },
];

beforeEach(() => {
  captured.length = 0;
  nextEvents = DONE_EVENTS;
});

/** 建连接（两个模型：vision-1 不收 PDF，vision-doc 收 PDF）+ 空白对话 */
async function setup(): Promise<TestApp & { chatId: string; connectionId: string }> {
  const t = makeTestApp(dataDir);
  const conn = insertConnection(t.db, dataDir, 'mm-chat');
  t.db
    .update(schema.connections)
    .set({
      modelOverrides: {
        'vision-1': { imageIn: true, documentIn: false, imageOut: false },
        'vision-doc': { imageIn: true, documentIn: true, imageOut: false },
        'painter-1': { imageIn: false, documentIn: false, imageOut: true },
      },
    })
    .where(eq(schema.connections.id, conn.id))
    .run();
  const chat = (await (await t.app.request('/api/chats', post({}))).json()) as { id: string };
  return { ...t, chatId: chat.id, connectionId: conn.id };
}

function lastUserSegment(ir: PromptIR) {
  const segment = [...ir.segments].reverse().find((s) => s.role === 'user');
  expect(segment).toBeDefined();
  return segment!;
}

function nodeRow(db: Db, id: string) {
  return db.select().from(schema.messageNodes).where(eq(schema.messageNodes.id, id)).get();
}

// ───────────────────────── 上传 ─────────────────────────

describe('POST /api/assets 上传', () => {
  it('图片：按魔数判定、读宽高；同内容去重返回同一 id，名字以本次为准', async () => {
    const { app, db } = await setup();
    const first = await uploadOk(app, PNG_2X3, 'moon.png');
    expect(first).toMatchObject({
      kind: 'upload',
      mime: 'image/png',
      name: 'moon.png',
      size: PNG_2X3.length,
      width: 2,
      height: 3,
    });
    expect(first.textLength).toBeUndefined();

    const again = await uploadOk(app, PNG_2X3, '改名.jpg');
    expect(again.id).toBe(first.id);
    expect(again.name).toBe('改名.jpg');
    // 不改库：meta.name 仍是第一次的
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, first.id)).get();
    expect(row?.meta?.name).toBe('moon.png');

    const file = await app.request(`/api/assets/${first.id}/file`);
    expect(file.headers.get('content-type')).toBe('image/png');
    expect(file.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('文本类：扩展名白名单 + UTF-8；textLength；取文件时一律按纯文本给', async () => {
    const { app } = await setup();
    const body = await uploadOk(app, new TextEncoder().encode('<b>你好</b>'), 'page.html');
    expect(body).toMatchObject({ mime: 'text/html', name: 'page.html', textLength: 9 });
    const file = await app.request(`/api/assets/${body.id}/file`);
    expect(file.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(file.headers.get('content-security-policy')).toContain('sandbox');
  });

  it('PDF：抽取文本存 meta.text，返回 pages / textLength', async () => {
    const { app, db } = await setup();
    const body = await uploadOk(app, makePdf(['Quarterly report']), 'report.pdf');
    expect(body).toMatchObject({ mime: 'application/pdf', pages: 1 });
    expect(body.textLength).toBeGreaterThan(0);
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, body.id)).get();
    expect(row?.meta?.text).toContain('Quarterly report');
  });

  it('损坏的 PDF 照收：抽取失败不报错，meta.text 为空', async () => {
    const { app, db } = await setup();
    const body = await uploadOk(app, new TextEncoder().encode('%PDF-1.4 not really'), 'bad.pdf');
    expect(body.textLength).toBe(0);
    const row = db.select().from(schema.assets).where(eq(schema.assets.id, body.id)).get();
    expect(row?.meta?.text).toBe('');
  });

  it('不支持的类型 415、超过 20 MB 413、缺文件 400', async () => {
    const { app } = await setup();
    const unsupported = await upload(app, new TextEncoder().encode('console.log(1)'), 'x.js');
    expect(unsupported.status).toBe(415);
    expect(((await unsupported.json()) as { error: string }).error).toBe('unsupported');
    // 二进制内容冒充 .txt
    expect((await upload(app, new Uint8Array([0xff, 0xfe, 0x00, 0x01]), 'x.txt')).status).toBe(415);

    const big = new Uint8Array(20 * 1024 * 1024 + 1);
    big.set(PNG_2X3);
    expect((await upload(app, big, 'huge.png')).status).toBe(413);

    const empty = await app.request('/api/assets', { method: 'POST', body: new FormData() });
    expect(empty.status).toBe(400);
  });
});

// ───────────────────────── 附件入树 ─────────────────────────

describe('附件入树', () => {
  it('POST messages：parts = [text, ...媒体]（带 name）；只发附件可以不写字；不存在的 id → 400', async () => {
    const { app, chatId } = await setup();
    const image = await uploadOk(app, PNG_2X3, 'moon.png');
    const doc = await uploadOk(app, new TextEncoder().encode('笔记'), 'notes.md');

    const res = await app.request(
      `/api/chats/${chatId}/messages`,
      post({ role: 'user', text: '看看这些', attachments: [image.id, doc.id] }),
    );
    expect(res.status).toBe(200);
    const { node } = (await res.json()) as { node: Node };
    expect(node.parts).toEqual([
      { type: 'text', text: '看看这些' },
      { type: 'image', assetId: image.id, mime: 'image/png', name: 'moon.png' },
      { type: 'document', assetId: doc.id, mime: 'text/markdown', name: 'notes.md' },
    ]);

    // 只有附件：不带空文本 part
    const onlyMedia = (await (
      await app.request(
        `/api/chats/${chatId}/messages`,
        post({ role: 'user', attachments: [{ id: image.id, name: '另一个名字.png' }] }),
      )
    ).json()) as { node: Node };
    expect(onlyMedia.node.parts).toEqual([
      { type: 'image', assetId: image.id, mime: 'image/png', name: '另一个名字.png' },
    ]);

    const missing = await app.request(
      `/api/chats/${chatId}/messages`,
      post({ role: 'user', text: 'x', attachments: ['nope'] }),
    );
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { message: string }).message).toContain('nope');
    // 没有文本也没有附件仍是 400
    expect(
      (await app.request(`/api/chats/${chatId}/messages`, post({ role: 'user' }))).status,
    ).toBe(400);
  });

  it('PATCH 节点 attachments：替换全部媒体、文本保留；[] 移除附件', async () => {
    const { app, chatId } = await setup();
    const a = await uploadOk(app, PNG_2X3, 'a.png');
    const b = await uploadOk(app, pngVariant(7), 'b.png');
    const { node } = (await (
      await app.request(
        `/api/chats/${chatId}/messages`,
        post({ role: 'user', text: '原文', attachments: [a.id] }),
      )
    ).json()) as { node: Node };

    const patch = (body: unknown) =>
      app.request(`/api/chats/${chatId}/nodes/${node.id}`, json('PATCH', body));
    const replaced = (await (await patch({ attachments: [b.id, a.id] })).json()) as Node;
    expect(replaced.parts).toEqual([
      { type: 'text', text: '原文' },
      { type: 'image', assetId: b.id, mime: 'image/png', name: 'b.png' },
      { type: 'image', assetId: a.id, mime: 'image/png', name: 'a.png' },
    ]);
    const both = (await (await patch({ text: '改过', attachments: [a.id] })).json()) as Node;
    expect(both.parts).toEqual([
      { type: 'text', text: '改过' },
      { type: 'image', assetId: a.id, mime: 'image/png', name: 'a.png' },
    ]);
    const cleared = (await (await patch({ attachments: [] })).json()) as Node;
    expect(cleared.parts).toEqual([{ type: 'text', text: '改过' }]);
    expect((await patch({ attachments: ['nope'] })).status).toBe(400);
    expect((await patch({ attachments: 'nope' })).status).toBe(400);
  });

  it('generate 的 userMessage.attachments 入树；不存在的 id 在开流前回 400', async () => {
    const { app, db, chatId, connectionId } = await setup();
    const image = await uploadOk(app, PNG_2X3, 'moon.png');

    const bad = await app.request(
      `/api/chats/${chatId}/generate`,
      post({ connectionId, model: 'vision-1', userMessage: { text: 'x', attachments: ['nope'] } }),
    );
    expect(bad.status).toBe(400);
    expect(db.select().from(schema.messageNodes).all()).toHaveLength(0);

    const res = await app.request(
      `/api/chats/${chatId}/generate`,
      post({ connectionId, model: 'vision-1', userMessage: { text: '', attachments: [image.id] } }),
    );
    const events = parseSse(await res.text());
    const userNode = (events[0]!.data as { node: Node }).node;
    expect(userNode.role).toBe('user');
    expect(userNode.parts).toEqual([
      { type: 'image', assetId: image.id, mime: 'image/png', name: 'moon.png' },
    ]);
    expect(events.at(-1)?.event).toBe('done');
  });

  it('PATCH overrides.imageOutput：boolean 保存、null 删键、其余 400；generate 传给 buildRequest', async () => {
    const { app, chatId, connectionId } = await setup();
    const patch = (overrides: unknown) =>
      app.request(`/api/chats/${chatId}`, json('PATCH', { overrides }));
    type WithOverrides = { overrides: Record<string, unknown> };
    const on = (await (await patch({ imageOutput: true })).json()) as WithOverrides;
    expect(on.overrides).toEqual({ imageOutput: true });

    await (
      await app.request(
        `/api/chats/${chatId}/generate`,
        post({ connectionId, model: 'painter-1', userMessage: { text: '画一轮月亮' } }),
      )
    ).text();
    expect(captured.at(-1)?.opts?.imageOutput).toBe(true);
    expect((captured.at(-1)?.request.body as { modalities?: string[] }).modalities).toEqual([
      'image',
      'text',
    ]);

    const off = (await (await patch({ imageOutput: null })).json()) as WithOverrides;
    expect(off.overrides).toEqual({});
    expect((await patch({ imageOutput: 'yes' })).status).toBe(400);
  });
});

// ───────────────────────── 组装前内联 ─────────────────────────

describe('组装前内联', () => {
  it('文本类文档按 ST appendFileContent 拼在正文前，part 去掉', async () => {
    const { app, chatId, connectionId } = await setup();
    const a = await uploadOk(app, new TextEncoder().encode('FILE-A'), 'a.md');
    const b = await uploadOk(app, new TextEncoder().encode('\uFEFFFILE-B'), 'b.txt');
    // 只有空白的文件不算空（ST `if (fileText)` 只跳过空串；空文件上传时就被拒）
    const blank = await uploadOk(app, new TextEncoder().encode(' '), 'blank.txt');
    const image = await uploadOk(app, PNG_2X3, 'moon.png');

    await (
      await app.request(
        `/api/chats/${chatId}/generate`,
        post({
          connectionId,
          model: 'vision-1',
          userMessage: { text: 'hello', attachments: [a.id, image.id, b.id, blank.id] },
        }),
      )
    ).text();
    const segment = lastUserSegment(captured.at(-1)!.ir);
    expect(segment.parts).toEqual([
      { type: 'text', text: 'FILE-A\n\nFILE-B\n\n \n\nhello' },
      { type: 'image', assetId: image.id, mime: 'image/png', name: 'moon.png' },
    ]);
  });

  it('PDF：documentIn 时保留 part；否则有抽取文本就按 [文件名] 内联，没有则保留 part', async () => {
    const { app, db, chatId, connectionId } = await setup();
    const pdf = await uploadOk(app, makePdf(['PDF-BODY']), 'paper.pdf');
    const scanned = await uploadOk(app, new TextEncoder().encode('%PDF-1.4 scanned'), 'scan.pdf');

    const send = async (model: string, text: string) => {
      const res = await app.request(
        `/api/chats/${chatId}/generate`,
        post({ connectionId, model, userMessage: { text, attachments: [pdf.id, scanned.id] } }),
      );
      return parseSse(await res.text());
    };

    await send('vision-1', 'q1');
    const inlined = lastUserSegment(captured.at(-1)!.ir);
    expect(inlined.parts).toEqual([
      { type: 'text', text: '[paper.pdf]\nPDF-BODY\n\nq1' },
      { type: 'document', assetId: scanned.id, mime: 'application/pdf', name: 'scan.pdf' },
    ]);
    // 没有抽取文本的 PDF 交给适配器按能力告警丢弃，告警进节点 extra.warnings
    const done1 = (await send('vision-1', 'q1b')).at(-1)!;
    expect(done1.event).toBe('done');
    expect((done1.data as { node: Node }).node.extra?.warnings).toContain(
      '模型不支持 PDF 输入，已丢弃 2 个 PDF',
    );

    await send('vision-doc', 'q2');
    const kept = lastUserSegment(captured.at(-1)!.ir);
    expect(kept.parts.filter((p) => p.type === 'document')).toHaveLength(2);
    // 请求体里是 file 块 + data URL
    const body = captured.at(-1)!.request.body as { messages: { content: unknown }[] };
    const content = body.messages.at(-1)?.content as {
      type: string;
      file?: { filename: string; file_data: string };
    }[];
    const files = content.filter((p) => p.type === 'file');
    expect(files.map((f) => f.file?.filename)).toEqual(['paper.pdf', 'scan.pdf']);
    expect(files[0]?.file?.file_data.startsWith('data:application/pdf;base64,JVBER')).toBe(true);

    // 库里的请求已脱敏
    const assistant = db
      .select()
      .from(schema.messageNodes)
      .all()
      .filter((row) => row.role === 'assistant')
      .at(-1)!;
    const stored = JSON.stringify(assistant.extra?.request);
    expect(stored).not.toContain('JVBER');
    expect(stored).toContain('data:application/pdf;base64,<省略');
  });

  it('inlineDocumentParts：读不到的资产保留 part；只有文档时新建文本 part', () => {
    const { db } = makeTestApp(dataDir);
    const assets = createAssetsService(db, dataDir);
    const doc = assets.save({
      bytes: new TextEncoder().encode('内容'),
      kind: 'upload',
      mime: 'text/plain',
    });
    const parts: Part[] = [
      { type: 'document', assetId: doc.id, mime: 'text/plain' },
      { type: 'document', assetId: 'missing', mime: 'text/plain' },
    ];
    expect(inlineDocumentParts(parts, { caps: { documentIn: false }, assets })).toEqual([
      { type: 'text', text: '内容\n\n' },
      { type: 'document', assetId: 'missing', mime: 'text/plain' },
    ]);
    // 没有文档时返回原数组
    const plain: Part[] = [{ type: 'text', text: 'x' }];
    expect(inlineDocumentParts(plain, { caps: { documentIn: false }, assets })).toBe(plain);
  });
});

// ───────────────────────── 解析器与脱敏 ─────────────────────────

describe('资产解析器与脱敏', () => {
  it('generate 传解析器：图片成 data URL；extra.request 里没有 base64；检查器不传解析器（占位）', async () => {
    const { app, db, chatId, connectionId } = await setup();
    const image = await uploadOk(app, PNG_2X3, 'moon.png');
    const base64 = Buffer.from(PNG_2X3).toString('base64');

    const events = parseSse(
      await (
        await app.request(
          `/api/chats/${chatId}/generate`,
          post({
            connectionId,
            model: 'vision-1',
            userMessage: { text: '看', attachments: [image.id] },
          }),
        )
      ).text(),
    );
    const { opts, request } = captured.at(-1)!;
    expect(typeof opts?.resolveAsset).toBe('function');
    // 只解析 IR 里出现过的资产
    expect(opts?.resolveAsset?.('not-in-ir')).toBeUndefined();
    expect(JSON.stringify(request.body)).toContain(`data:image/png;base64,${base64}`);

    const done = events.at(-1)!.data as { node: Node };
    const row = nodeRow(db, done.node.id);
    const stored = JSON.stringify(row?.extra?.request);
    expect(stored).not.toContain(base64);
    expect(stored).toContain(`data:image/png;base64,<省略 ${PNG_2X3.length} 字节>`);

    captured.length = 0;
    const inspect = await app.request(
      `/api/chats/${chatId}/inspect?connectionId=${connectionId}&model=vision-1&parentId=${
        (events[0]!.data as { node: Node }).node.id
      }`,
    );
    expect(inspect.status).toBe(200);
    expect(captured.at(-1)?.opts?.resolveAsset).toBeUndefined();
    expect(JSON.stringify(captured.at(-1)?.request.body)).toContain(`asset:${image.id}`);
  });

  it('requestForStorage：先脱敏再判体积，不改入参', () => {
    const longBase64 = 'A'.repeat(300 * 1024);
    const req: ProviderRequest = {
      method: 'POST',
      url: 'https://x.test',
      headers: { authorization: 'secret' },
      body: {
        contents: [{ parts: [{ inlineData: { mimeType: 'image/png', data: longBase64 } }] }],
      },
    };
    const stored = requestForStorage(req)!;
    expect(stored.truncated).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain('secret');
    expect(JSON.stringify(stored.body)).toContain('<base64 省略');
    expect(
      (req.body as { contents: { parts: { inlineData: { data: string } }[] }[] }).contents[0]!
        .parts[0]!.inlineData.data,
    ).toBe(longBase64);
  });
});

// ───────────────────────── 生图落库 ─────────────────────────

describe('模型输出图片', () => {
  const pngBase64 = Buffer.from(PNG_2X3).toString('base64');

  it('image 事件 → generated 资产 → SSE image；done 的 parts 按到达顺序交错', async () => {
    const { app, db, chatId, connectionId, dataDir: dir } = await setup();
    nextEvents = [
      { type: 'text.delta', text: '画好了' },
      { type: 'text.delta', text: '：' },
      { type: 'image', mime: 'image/png', data: pngBase64 },
      { type: 'warning', message: '流式告警示例' },
      { type: 'text.delta', text: '窗外的月亮。' },
      { type: 'image', mime: 'image/png', data: Buffer.from(pngVariant(3)).toString('base64') },
      { type: 'image', mime: 'image/svg+xml', data: Buffer.from('<svg/>').toString('base64') },
      { type: 'stop', reason: 'end' },
    ];
    const events = parseSse(
      await (
        await app.request(
          `/api/chats/${chatId}/generate`,
          post({ connectionId, model: 'painter-1', userMessage: { text: '画月亮' } }),
        )
      ).text(),
    );
    expect(events.map((e) => e.event)).toEqual([
      'node',
      'node',
      'text.delta',
      'text.delta',
      'image',
      'text.delta',
      'image',
      'done',
    ]);
    const assistantId = (events[1]!.data as { node: Node }).node.id;
    const imageEvent = events[4]!.data as {
      nodeId: string;
      part: Extract<Part, { type: 'image' }>;
    };
    expect(imageEvent.nodeId).toBe(assistantId);
    expect(imageEvent.part).toMatchObject({ type: 'image', mime: 'image/png' });

    const asset = db
      .select()
      .from(schema.assets)
      .where(eq(schema.assets.id, imageEvent.part.assetId))
      .get();
    expect(asset).toMatchObject({
      kind: 'generated',
      source: `generated:${assistantId}`,
      width: 2,
    });
    expect(fs.existsSync(createAssetsService(db, dir).resolvePath(asset!))).toBe(true);

    const done = events.at(-1)!.data as { node: Node };
    const second = (events[6]!.data as { part: { assetId: string } }).part.assetId;
    expect(done.node.parts).toEqual([
      { type: 'text', text: '画好了：' },
      { type: 'image', assetId: imageEvent.part.assetId, mime: 'image/png' },
      { type: 'text', text: '窗外的月亮。' },
      { type: 'image', assetId: second, mime: 'image/png' },
    ]);
    expect(done.node.extra?.warnings).toEqual(
      expect.arrayContaining(['流式告警示例', '模型输出的图片无法识别（image/svg+xml），已忽略']),
    );
    expect(nodeRow(db, assistantId)?.parts).toEqual(done.node.parts);
  });

  it('只有图片、随后出错：节点不删（无文本且无图片才删），error 带 nodeId', async () => {
    const { app, db, chatId, connectionId } = await setup();
    nextEvents = [
      { type: 'image', mime: 'image/png', data: pngBase64 },
      {
        type: 'error',
        error: { kind: 'network', message: '断了', retryable: true },
        retryable: true,
      },
    ];
    const events = parseSse(
      await (
        await app.request(
          `/api/chats/${chatId}/generate`,
          post({ connectionId, model: 'painter-1', userMessage: { text: '画' } }),
        )
      ).text(),
    );
    expect(events.map((e) => e.event)).toEqual(['node', 'node', 'image', 'error']);
    const assistantId = (events[1]!.data as { node: Node }).node.id;
    expect((events[3]!.data as { nodeId?: string }).nodeId).toBe(assistantId);
    expect(nodeRow(db, assistantId)?.parts).toEqual([
      { type: 'image', assetId: expect.any(String), mime: 'image/png' },
    ]);
  });

  it('无文本无图片的错误仍然删节点', async () => {
    const { app, db, chatId, connectionId } = await setup();
    nextEvents = [
      {
        type: 'error',
        error: { kind: 'network', message: '断了', retryable: true },
        retryable: true,
      },
    ];
    const events = parseSse(
      await (
        await app.request(
          `/api/chats/${chatId}/generate`,
          post({ connectionId, model: 'painter-1', userMessage: { text: '画' } }),
        )
      ).text(),
    );
    expect(events.map((e) => e.event)).toEqual(['node', 'node', 'error']);
    expect(
      db
        .select()
        .from(schema.messageNodes)
        .all()
        .map((row) => row.role),
    ).toEqual(['user']);
  });
});

// ───────────────────────── 清理 ─────────────────────────

describe('POST /api/assets/gc', () => {
  it('只删「超过 24 小时、未被引用」的 upload / generated / avatar；引用与 card_embedded 不动', async () => {
    const { app, db, chatId, dataDir: dir } = await setup();
    const assets = createAssetsService(db, dir);
    const save = (seed: number, kind: 'upload' | 'generated' | 'avatar' | 'card_embedded') =>
      assets.save({ bytes: pngVariant(1000 + seed), kind, mime: 'image/png' });

    const orphanUpload = save(1, 'upload');
    const orphanGenerated = save(2, 'generated');
    const orphanAvatar = save(3, 'avatar');
    const embedded = save(4, 'card_embedded');
    const charAvatar = save(5, 'avatar');
    const personaAvatar = save(6, 'avatar');
    const inNode = save(7, 'generated');
    const inCardData = save(8, 'upload');
    const young = save(9, 'upload');

    db.insert(schema.characters)
      .values({
        name: '艾拉',
        spec: 'v3',
        data: { name: '艾拉', extensions: { gallery: [`asset:${inCardData.id}`] } },
        avatarAssetId: charAvatar.id,
      })
      .run();
    db.insert(schema.personas).values({ name: '旅人', avatarAssetId: personaAvatar.id }).run();
    await app.request(
      `/api/chats/${chatId}/messages`,
      post({ role: 'assistant', text: '图', attachments: [inNode.id] }),
    );

    // 刚被上传端点返回过的老资产（去重命中）受进程内 24 小时保护
    const reuploaded = save(10, 'upload');
    const again = await uploadOk(app, pngVariant(1010), 'again.png');
    expect(again.id).toBe(reuploaded.id);

    const old = new Date(Date.now() - GC_MIN_AGE_MS - 60_000);
    db.update(schema.assets).set({ createdAt: old }).run();
    db.update(schema.assets)
      .set({ createdAt: new Date() })
      .where(eq(schema.assets.id, young.id))
      .run();

    const expectedFreed = [orphanUpload, orphanGenerated, orphanAvatar].reduce(
      (sum, row) => sum + fs.statSync(assets.resolvePath(row)).size,
      0,
    );
    const res = await app.request('/api/assets/gc', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 3, freedBytes: expectedFreed });

    const remaining = new Set(
      db
        .select()
        .from(schema.assets)
        .all()
        .map((row) => row.id),
    );
    for (const row of [orphanUpload, orphanGenerated, orphanAvatar]) {
      expect(remaining.has(row.id)).toBe(false);
      expect(fs.existsSync(assets.resolvePath(row))).toBe(false);
    }
    for (const row of [
      embedded,
      charAvatar,
      personaAvatar,
      inNode,
      inCardData,
      young,
      reuploaded,
    ]) {
      expect(remaining.has(row.id)).toBe(true);
      expect(fs.existsSync(assets.resolvePath(row))).toBe(true);
    }

    // 再跑一次没有可删的
    expect(await (await app.request('/api/assets/gc', { method: 'POST' })).json()).toEqual({
      removed: 0,
      freedBytes: 0,
    });
  });
});
