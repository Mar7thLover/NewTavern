/**
 * 真机冒烟：对一个真实端点跑 listModels + 一次流式生成，断言事件序列以 stop/error 收尾。
 *
 * 用法（Key 只从环境变量读，绝不写进仓库）：
 *   NT_SMOKE_PROVIDER=anthropic \
 *   NT_SMOKE_BASE_URL=https://api.example.com \
 *   NT_SMOKE_MODEL=some-model \
 *   NT_SMOKE_KEY=xxx \
 *   pnpm --filter @newtavern/providers exec tsx scripts/smoke.ts
 *
 * 可选：NT_SMOKE_BUDGET（budget_tokens）、NT_SMOKE_EFFORT、NT_SMOKE_MAX_TOKENS。
 */
import type { PromptIR, Role, Segment } from '@newtavern/core';

import { registerBuiltinAdapters } from '../src/adapters/index.js';
import { lookupCapabilities } from '../src/catalog.js';
import { registry } from '../src/registry.js';
import type { BuildOptions, Connection, GenEvent, ProviderId } from '../src/types.js';

const env = (k: string): string | undefined => {
  const v = process.env[k];
  return v === undefined || v === '' ? undefined : v;
};

const provider = env('NT_SMOKE_PROVIDER');
const baseUrl = env('NT_SMOKE_BASE_URL');
const model = env('NT_SMOKE_MODEL');
const key = env('NT_SMOKE_KEY');

if (!provider || !baseUrl || !model || !key) {
  console.error(
    '缺少环境变量：NT_SMOKE_PROVIDER / NT_SMOKE_BASE_URL / NT_SMOKE_MODEL / NT_SMOKE_KEY',
  );
  process.exit(2);
}

registerBuiltinAdapters();

const conn: Connection = {
  id: 'smoke',
  provider: provider as ProviderId,
  label: 'smoke',
  baseUrl,
  apiKey: key,
};

function seg(id: string, role: Role, text: string, slot: 'system' | 'history', order = 0): Segment {
  return {
    id,
    role,
    parts: [{ type: 'text', text }],
    origin: { kind: slot === 'system' ? 'preset' : 'history' },
    anchor: { slot, order },
    stability: slot === 'system' ? 'static' : 'history',
  };
}

const maxTokens = Number(env('NT_SMOKE_MAX_TOKENS') ?? '512');
const ir: PromptIR = {
  model,
  sampling: { temperature: 0.8, maxTokens },
  segments: [
    seg('preset:main', 'system', 'You are a concise assistant. Reply in English.', 'system', 0),
    seg(
      'history:1',
      'user',
      'Name three primary colors, comma separated. Then stop.',
      'history',
      0,
    ),
  ],
  cachePlan: { breakpoints: [0] },
  meta: {
    chatId: 'smoke-chat',
    presetId: 'smoke-preset',
    layoutMode: 'cache-aware',
    activations: [],
    warnings: [],
    tokenEstimate: 0,
  },
};

const opts: BuildOptions = {};
const budget = env('NT_SMOKE_BUDGET');
const effort = env('NT_SMOKE_EFFORT');
if (budget) opts.thinking = { ...opts.thinking, budgetTokens: Number(budget) };
if (effort) opts.thinking = { ...opts.thinking, effort };

async function main(): Promise<void> {
  const adapter = registry.get(conn.provider);
  console.log(`# provider=${conn.provider} baseUrl=${baseUrl} model=${model}`);
  console.log('# capabilities:', JSON.stringify(lookupCapabilities(conn.provider, model)));

  // 1. listModels
  const t0 = Date.now();
  const models = await adapter.listModels(conn);
  console.log(`# listModels: ${models.length} 个模型，${Date.now() - t0}ms`);
  console.log(
    '#   前 10 个:',
    models
      .slice(0, 10)
      .map((m) => m.id)
      .join(', '),
  );
  console.log(`#   包含 ${model}: ${models.some((m) => m.id === model)}`);

  // 2. buildRequest
  const req = adapter.buildRequest(ir, conn, model, opts);
  const redacted = { ...req.headers };
  for (const k of Object.keys(redacted)) {
    if (/authorization|api-key/i.test(k)) redacted[k] = '<redacted>';
  }
  console.log('# request url:', req.url);
  console.log('# request headers:', JSON.stringify(redacted));
  console.log('# request body:', JSON.stringify(req.body));
  if (req.warnings) console.log('# warnings:', JSON.stringify(req.warnings));

  // 3. stream
  const ctrl = new AbortController();
  const seq: string[] = [];
  let textLen = 0;
  let reasoningLen = 0;
  let usage: Extract<GenEvent, { type: 'usage' }> | undefined;
  let last: GenEvent | undefined;
  const t1 = Date.now();

  for await (const ev of adapter.stream(conn, req, ctrl.signal)) {
    last = ev;
    switch (ev.type) {
      case 'text.delta':
        textLen += ev.text.length;
        if (seq[seq.length - 1] !== 'text.delta*') seq.push('text.delta*');
        break;
      case 'reasoning.delta':
        reasoningLen += ev.text.length;
        if (seq[seq.length - 1] !== 'reasoning.delta*') seq.push('reasoning.delta*');
        break;
      case 'reasoning.opaque':
        seq.push(`reasoning.opaque(${JSON.stringify(ev.payload).slice(0, 80)})`);
        break;
      case 'usage':
        usage = ev;
        seq.push('usage');
        break;
      case 'stop':
        seq.push(`stop:${ev.reason}${ev.detail ? `(${ev.detail})` : ''}`);
        break;
      case 'error':
        seq.push(`error:${ev.error.kind}(${ev.error.message})`);
        break;
      default:
        seq.push(ev.type);
        break;
    }
  }

  console.log(`# stream: ${Date.now() - t1}ms`);
  console.log('# 事件序列:', seq.join(' → '));
  console.log(`# text 字符数=${textLen} reasoning 字符数=${reasoningLen}`);
  if (usage) {
    console.log(
      `# usage: input=${usage.input} output=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite} reasoning=${usage.reasoning}；总输入=${usage.input + usage.cacheRead + usage.cacheWrite}`,
    );
  } else {
    console.log('# usage: 未收到');
  }

  const ok = last?.type === 'stop' || last?.type === 'error';
  console.log(`# 断言 最后一个事件是 stop/error: ${ok ? 'PASS' : 'FAIL'}`);
  console.log(`# 断言 usage 有数: ${usage && usage.output > 0 ? 'PASS' : 'FAIL'}`);
  console.log(`# 断言 出现 reasoning 事件: ${reasoningLen > 0 ? 'YES' : 'NO'}`);
  if (!ok || last.type === 'error') process.exit(1);
}

main().catch((e: unknown) => {
  console.error('冒烟失败：', e);
  process.exit(1);
});
