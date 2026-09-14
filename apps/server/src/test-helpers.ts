import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  irToChatMessages,
  partsToText,
  registry,
  type Connection,
  type GenEvent,
  type ModelCapabilities,
  type ModelInfo,
  type ProviderAdapter,
  type ProviderError,
  type ProviderId,
  type ProviderRequest,
} from '@newtavern/providers';

import { createApp } from './app.js';
import { createDatabase, schema, type Db } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { createSecrets } from './services/secrets.js';

/** 测试脚手架：内存库 + 临时数据目录 + 假适配器。生产代码不引用本文件。 */

export function makeTempDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nt-m2-test-'));
}

export interface TestApp {
  app: ReturnType<typeof createApp>;
  db: Db;
  dataDir: string;
}

export function makeTestApp(dataDir: string): TestApp {
  const db = createDatabase(':memory:');
  runMigrations(db);
  return { app: createApp({ db, dataDir }), db, dataDir };
}

/** 直接插一条连接行（绕过路由的 provider 白名单，才能挂假适配器） */
export function insertConnection(
  db: Db,
  dataDir: string,
  provider: string,
  apiKeys: string[] = ['sk-test-0001'],
  label = '测试连接',
): typeof schema.connections.$inferSelect {
  const secrets = createSecrets(dataDir);
  return db
    .insert(schema.connections)
    .values({
      provider,
      label,
      baseUrl: 'https://example.test/v1',
      keysEnc: secrets.encryptJson(apiKeys),
    })
    .returning()
    .get();
}

const CAPABILITIES: ModelCapabilities = {
  thinking: 'none',
  caching: 'none',
  systemInMessages: false,
  reasoningRoundtrip: 'none',
  imageIn: false,
  imageOut: false,
  documentIn: false,
  tools: false,
  structuredOutput: false,
  prefill: false,
  maxContext: 32768,
  maxOutput: 4096,
};

export interface FakeAdapterOptions {
  id: string;
  /** 固定回放的事件序列 */
  events?: GenEvent[];
  /** 自定义 stream（abort 测试用） */
  stream?: ProviderAdapter['stream'];
  models?: ModelInfo[];
  listModels?: () => Promise<ModelInfo[]>;
  /** 覆盖能力（缓存模式、maxContext 等） */
  capabilities?: Partial<ModelCapabilities>;
  /** true：body 带真实的 `messages`（role/content/name），用于断言组装结果 */
  renderMessages?: boolean;
}

export function registerFakeAdapter(options: FakeAdapterOptions): ProviderAdapter {
  const events = options.events ?? [];
  const caps: ModelCapabilities = { ...CAPABILITIES, ...options.capabilities };
  const adapter: ProviderAdapter = {
    id: options.id as ProviderId,
    listModels:
      options.listModels ?? (() => Promise.resolve(options.models ?? [{ id: 'fake-model-1' }])),
    capabilities: () => caps,
    buildRequest: (ir, conn: Connection, model): ProviderRequest => ({
      method: 'POST',
      url: `${conn.baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${conn.apiKey ?? ''}` },
      body: {
        model,
        segments: ir.segments.length,
        apiKeyTail: (conn.apiKey ?? '').slice(-4),
        ...(options.renderMessages
          ? {
              messages: irToChatMessages(ir, { systemPlacement: 'inline' }).messages.map((m) => ({
                role: m.role,
                content: partsToText(m.parts, '\n'),
                ...(m.name === undefined ? {} : { name: m.name }),
              })),
            }
          : {}),
      },
    }),
    stream:
      options.stream ??
      async function* fakeStream() {
        for (const event of events) yield event;
      },
    normalizeError: (e): ProviderError => ({
      kind: 'network',
      message: e instanceof Error ? e.message : String(e),
      retryable: false,
    }),
  };
  registry.register(adapter);
  return adapter;
}

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** 把 SSE 全文切成事件列表（注释行/ping 自动忽略） */
export function parseSse(raw: string): SseEvent[] {
  const out: SseEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event: '));
    const dataLines = lines
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice(6));
    if (!eventLine || dataLines.length === 0) continue;
    out.push({
      event: eventLine.slice('event: '.length),
      data: JSON.parse(dataLines.join('\n')) as Record<string, unknown>,
    });
  }
  return out;
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('等待超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
