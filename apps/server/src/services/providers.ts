import {
  registry,
  type Connection,
  type ModelCapabilities,
  type ProviderAdapter,
  type ProviderErrorKind,
  type ProviderId,
} from '@newtavern/providers';
import { eq } from 'drizzle-orm';

import { schema, type Db } from '../db/client.js';
import type { Secrets } from './secrets.js';

/**
 * 连接解析与适配器查找。见 docs/M2-CONTRACT.md §3.2。
 * 对外永不返回明文 Key：只有本模块解密，解密结果仅进 `Connection.apiKey`。
 */

export const PROVIDER_IDS = [
  'openai-chat',
  'openai-responses',
  'anthropic',
  'google',
] as const satisfies readonly ProviderId[];

/** 各 provider 的默认 baseUrl（契约 §3.2 ConnectionInput） */
export const DEFAULT_BASE_URLS: Record<ProviderId, string> = {
  'openai-chat': 'https://api.openai.com/v1',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
  google: 'https://generativelanguage.googleapis.com',
};

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * 服务端侧的连接：比 `Connection` 多出契约 §1.1 要求 P 增加的可选字段。
 * P 把字段加进 `packages/providers/src/types.ts` 后，这个接口可以直接删掉。
 */
export interface ServerConnection extends Connection {
  label?: string;
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}

export type ConnectionRow = typeof schema.connections.$inferSelect;

export interface ResolvedConnection {
  row: ConnectionRow;
  conn: ServerConnection;
  adapter: ProviderAdapter;
  /** 该连接配置的 Key 数量（0 表示未配置 Key） */
  keyCount: number;
}

export type ServiceErrorCode = 'not_found' | 'provider_error';

export class ProviderServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly kind: ProviderErrorKind = 'invalid',
  ) {
    super(message);
    this.name = 'ProviderServiceError';
  }
}

let builtinsPromise: Promise<void> | null = null;

/**
 * 启动时注册内置适配器。P（packages/providers）完成前 `registerBuiltinAdapters`
 * 还不存在，这里容错调用；P 完成后自然生效，无需改本文件。
 */
export function ensureBuiltinAdapters(): Promise<void> {
  builtinsPromise ??= (async () => {
    try {
      const mod = (await import('@newtavern/providers')) as unknown as {
        registerBuiltinAdapters?: () => void;
      };
      mod.registerBuiltinAdapters?.();
    } catch {
      // 适配器尚未实现；测试与开发期由调用方自行 registry.register()
    }
  })();
  return builtinsPromise;
}

export interface ProviderService {
  /** 解析连接：解密 Key、按轮换计数器取一个、查出适配器 */
  resolveConnection(id: string): Promise<ResolvedConnection>;
  /** 按轮换计数器取下一个 Key（无 Key 返回 undefined） */
  nextApiKey(row: ConnectionRow): string | undefined;
  /** 解密出的 Key 列表（仅本进程内使用） */
  readKeys(row: ConnectionRow): string[];
  /** 401/429 时换下一个 Key 重试一次 */
  withKeyRotation<T>(id: string, fn: (resolved: ResolvedConnection) => Promise<T>): Promise<T>;
}

export function createProviderService(db: Db, secrets: Secrets): ProviderService {
  /** 连接 id → 轮换计数器（进程内，不落库） */
  const counters = new Map<string, number>();

  const readKeys = (row: ConnectionRow): string[] => {
    if (!row.keysEnc) return [];
    try {
      const value = secrets.decryptJson(row.keysEnc);
      if (!Array.isArray(value)) return [];
      return value.filter((k): k is string => typeof k === 'string' && k !== '');
    } catch {
      // 主密钥更换或密文损坏：当作没有 Key，由上游报鉴权错误
      return [];
    }
  };

  const nextApiKey = (row: ConnectionRow): string | undefined => {
    const keys = readKeys(row);
    if (keys.length === 0) return undefined;
    const n = counters.get(row.id) ?? 0;
    counters.set(row.id, n + 1);
    return keys[n % keys.length];
  };

  const resolveConnection = async (id: string): Promise<ResolvedConnection> => {
    const row = db.select().from(schema.connections).where(eq(schema.connections.id, id)).get();
    if (!row) throw new ProviderServiceError('not_found', `连接不存在：${id}`);
    await ensureBuiltinAdapters();
    // 以 registry 为准（而不是硬编码的 4 个 id），测试与将来新增的适配器都能用
    const provider = row.provider as ProviderId;
    if (!registry.has(provider)) {
      throw new ProviderServiceError('provider_error', `提供商适配器未注册：${row.provider}`);
    }
    const keys = readKeys(row);
    const conn: ServerConnection = {
      id: row.id,
      provider,
      baseUrl: row.baseUrl || (DEFAULT_BASE_URLS[provider] ?? ''),
      apiKey: nextApiKey(row),
      headers: row.headers ?? undefined,
      proxy: row.proxy ?? undefined,
      quirks: row.quirks ?? undefined,
      label: row.label || undefined,
      modelOverrides: (row.modelOverrides ?? undefined) as
        Record<string, Partial<ModelCapabilities>> | undefined,
    };
    return { row, conn, adapter: registry.get(provider), keyCount: keys.length };
  };

  const withKeyRotation = async <T>(
    id: string,
    fn: (resolved: ResolvedConnection) => Promise<T>,
  ): Promise<T> => {
    const first = await resolveConnection(id);
    try {
      return await fn(first);
    } catch (e) {
      if (first.keyCount < 2) throw e;
      const kind = first.adapter.normalizeError(e).kind;
      if (kind !== 'auth' && kind !== 'rateLimit') throw e;
      return await fn(await resolveConnection(id));
    }
  };

  return { resolveConnection, nextApiKey, readKeys, withKeyRotation };
}
