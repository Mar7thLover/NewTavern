import { afterEach, describe, expect, it } from 'vitest';

import { createComfyBackend, DEFAULT_COMFY_WORKFLOW, fillComfyWorkflow } from './comfy.js';
import { getImageBackend, setImageBackendOverride } from './index.js';
import {
  makeZip,
  PNG_1X1,
  sendJson,
  startMock,
  type MockServer,
} from './mock-server.test-helper.js';
import { createNovelAiBackend, NOVELAI_MODELS } from './novelai.js';
import { createOpenAiImageBackend } from './openai.js';
import { createSdBackend } from './sd.js';
import { ImageBackendError, type ImageBackend, type ImageConnection } from './types.js';
import { extractFirstFromZip } from './util.js';

/**
 * 四个生图后端的集成测试：每组起一个 mock HTTP 服务（本机没有真实 SD / ComfyUI / NovelAI），
 * 覆盖参数映射、进度、错误归一化、ComfyUI 占位替换、NovelAI zip 解包。
 */

const PNG_B64 = PNG_1X1.toString('base64');
const servers: MockServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function mock(handler: Parameters<typeof startMock>[0]): Promise<MockServer> {
  const server = await startMock(handler);
  servers.push(server);
  return server;
}

function conn(
  provider: ImageConnection['provider'],
  baseUrl: string,
  extra: Partial<ImageConnection> = {},
): ImageConnection {
  return { id: 'c1', provider, baseUrl, ...extra };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectImageError(promise: Promise<unknown>): Promise<ImageBackendError> {
  try {
    await promise;
  } catch (e) {
    expect(e).toBeInstanceOf(ImageBackendError);
    return e as ImageBackendError;
  }
  throw new Error('应当抛出 ImageBackendError');
}

/* ------------------------------------------------------------------ */

describe('SD WebUI / Forge', () => {
  const sd = createSdBackend({ pollMs: 20 });

  it('参数映射、模型切换、种子、进度轮询、Basic 认证', async () => {
    let progressCalls = 0;
    const server = await mock(async (req, res) => {
      if (req.path.startsWith('/sdapi/v1/progress')) {
        progressCalls += 1;
        sendJson(res, 200, { progress: progressCalls === 1 ? 0.25 : 0.6 });
        return;
      }
      if (req.path === '/sdapi/v1/txt2img') {
        await delay(120);
        sendJson(res, 200, {
          images: [`data:image/png;base64,${PNG_B64}`],
          info: JSON.stringify({ seed: 4242 }),
        });
        return;
      }
      sendJson(res, 404, {});
    });
    const fractions: number[] = [];
    const result = await sd.generate(
      conn('image-sd', `${server.url}/`, { apiKey: 'alice:secret' }),
      {
        prompt: '1girl, rain',
        negative: 'lowres',
        width: 512,
        height: 768,
        steps: 24,
        cfg: 6.5,
        sampler: 'DPM++ 2M',
        model: 'anything-v5.safetensors [abcd]',
      },
      new AbortController().signal,
      (fraction) => fractions.push(fraction),
    );
    const call = server.requests.find((req) => req.path === '/sdapi/v1/txt2img');
    expect(call?.method).toBe('POST');
    expect(call?.headers.authorization).toBe(
      `Basic ${Buffer.from('alice:secret').toString('base64')}`,
    );
    expect(call?.json).toMatchObject({
      prompt: '1girl, rain',
      negative_prompt: 'lowres',
      width: 512,
      height: 768,
      steps: 24,
      cfg_scale: 6.5,
      sampler_name: 'DPM++ 2M',
      seed: -1,
      batch_size: 1,
      override_settings: { sd_model_checkpoint: 'anything-v5.safetensors [abcd]' },
      override_settings_restore_afterwards: true,
    });
    expect(result.seed).toBe(4242);
    expect(result.images).toEqual([{ mime: 'image/png', data: PNG_B64 }]);
    // 0 → 轮询到的递增值 → 1
    expect(fractions[0]).toBe(0);
    expect(fractions).toContain(0.25);
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(progressCalls).toBeGreaterThan(0);
  });

  it('listModels 用 title 作 id', async () => {
    const server = await mock((req, res) => {
      sendJson(res, 200, [
        { title: 'a.safetensors [1]', model_name: 'a' },
        { title: 'b.ckpt [2]', model_name: 'b' },
      ]);
    });
    const models = await sd.listModels(conn('image-sd', server.url));
    expect(server.requests[0]?.path).toBe('/sdapi/v1/sd-models');
    expect(models).toEqual([
      { id: 'a.safetensors [1]', name: 'a' },
      { id: 'b.ckpt [2]', name: 'b' },
    ]);
  });

  it('错误归一化：FastAPI 错误体、401、连不上', async () => {
    const server = await mock((req, res) => {
      if (req.path === '/sdapi/v1/sd-models') {
        sendJson(res, 401, { detail: 'Not authenticated' });
        return;
      }
      sendJson(res, 500, { error: 'OutOfMemoryError', detail: 'CUDA out of memory' });
    });
    const oom = await expectImageError(
      sd.generate(
        conn('image-sd', server.url),
        { prompt: 'x', width: 64, height: 64 },
        new AbortController().signal,
      ),
    );
    expect(oom.kind).toBe('overloaded');
    expect(oom.status).toBe(500);
    expect(oom.message).toContain('CUDA out of memory');
    expect(oom.message.startsWith('SD WebUI')).toBe(true);

    const auth = await expectImageError(sd.listModels(conn('image-sd', server.url)));
    expect(auth.kind).toBe('auth');
    expect(auth.message).toContain('Not authenticated');

    const closedPort = server.port;
    await server.close();
    servers.splice(servers.indexOf(server), 1);
    const refused = await expectImageError(
      sd.listModels(conn('image-sd', `http://127.0.0.1:${closedPort}`)),
    );
    expect(refused.kind).toBe('network');
    expect(refused.message).toContain('无法连接');
  });

  it('中止：原样抛 AbortError', async () => {
    const server = await mock(async (_req, res) => {
      await delay(500);
      sendJson(res, 200, { images: [PNG_B64] });
    });
    const controller = new AbortController();
    const pending = sd.generate(
      conn('image-sd', server.url),
      { prompt: 'x', width: 64, height: 64 },
      controller.signal,
    );
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/* ------------------------------------------------------------------ */

describe('ComfyUI', () => {
  it('占位替换：整值带类型、文本内替换、别名，且不改原工作流', () => {
    const workflow = {
      '1': { inputs: { seed: '%seed%', steps: '%steps%', cfg: '%scale%', text: 'best, %prompt%' } },
      '2': { inputs: { text: '%negative_prompt%', ckpt: '%model%', keep: '%unknown%' } },
      '3': { inputs: { size: ['%width%', '%height%'] } },
    };
    const snapshot = JSON.stringify(workflow);
    const filled = fillComfyWorkflow(workflow, {
      prompt: 'a cat',
      negative: 'blurry',
      negative_prompt: 'blurry',
      seed: 7,
      steps: 30,
      cfg: 5,
      scale: 5,
      width: 832,
      height: 1216,
      model: 'm.safetensors',
      sampler: 'euler',
    });
    expect(filled).toEqual({
      '1': { inputs: { seed: 7, steps: 30, cfg: 5, text: 'best, a cat' } },
      '2': { inputs: { text: 'blurry', ckpt: 'm.safetensors', keep: '%unknown%' } },
      '3': { inputs: { size: [832, 1216] } },
    });
    expect(JSON.stringify(workflow)).toBe(snapshot);
  });

  it('排队 → 轮询 history → 取图；WebSocket 进度；缺模型时取第一个 checkpoint', async () => {
    let historyCalls = 0;
    const server: MockServer = await mock((req, res) => {
      if (req.path === '/object_info/CheckpointLoaderSimple') {
        sendJson(res, 200, {
          CheckpointLoaderSimple: {
            input: { required: { ckpt_name: [['first.safetensors', 'second.safetensors'], {}] } },
          },
        });
        return;
      }
      if (req.path === '/prompt') {
        sendJson(res, 200, { prompt_id: 'p-1', number: 1, node_errors: {} });
        return;
      }
      if (req.path === '/history/p-1') {
        historyCalls += 1;
        if (historyCalls === 1) {
          server.wsSend(JSON.stringify({ type: 'status', data: {} }));
          server.wsSend(
            JSON.stringify({ type: 'progress', data: { value: 5, max: 20, prompt_id: 'p-1' } }),
          );
          sendJson(res, 200, {});
          return;
        }
        if (historyCalls === 2) {
          sendJson(res, 200, {});
          return;
        }
        sendJson(res, 200, {
          'p-1': {
            status: { status_str: 'success', completed: true, messages: [] },
            outputs: {
              '9': { images: [{ filename: 'NT_0001.png', subfolder: 'x', type: 'output' }] },
            },
          },
        });
        return;
      }
      if (req.path.startsWith('/view?')) {
        res.setHeader('content-type', 'image/png');
        res.end(PNG_1X1);
        return;
      }
      sendJson(res, 404, {});
    });
    const comfy = createComfyBackend({ pollMs: 40 });
    const fractions: number[] = [];
    const result = await comfy.generate(
      conn('image-comfy', server.url),
      { prompt: 'a fox', negative: 'bad', width: 640, height: 512, steps: 12, cfg: 4, seed: 99 },
      new AbortController().signal,
      (fraction) => fractions.push(fraction),
    );

    const queued = server.requests.find((req) => req.path === '/prompt')?.json as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
      client_id: string;
    };
    expect(queued.client_id).toMatch(/^newtavern-/);
    expect(queued.prompt['3']?.inputs).toMatchObject({ seed: 99, steps: 12, cfg: 4 });
    expect(queued.prompt['4']?.inputs).toEqual({ ckpt_name: 'first.safetensors' });
    expect(queued.prompt['5']?.inputs).toMatchObject({ width: 640, height: 512 });
    expect(queued.prompt['6']?.inputs.text).toBe('a fox');
    expect(queued.prompt['7']?.inputs.text).toBe('bad');
    // 默认工作流本身不被改动
    expect((DEFAULT_COMFY_WORKFLOW['6'] as { inputs: { text: string } }).inputs.text).toBe(
      '%prompt%',
    );

    const view = server.requests.find((req) => req.path.startsWith('/view?'));
    expect(view?.path).toContain('filename=NT_0001.png');
    expect(view?.path).toContain('subfolder=x');
    expect(view?.path).toContain('type=output');
    expect(result).toEqual({ images: [{ mime: 'image/png', data: PNG_B64 }], seed: 99 });
    expect(fractions[0]).toBe(0);
    expect(fractions).toContain(0.25);
    expect(fractions[fractions.length - 1]).toBe(1);
  });

  it('自定义工作流：用传入的 workflow；listModels 读 ckpt_name 枚举', async () => {
    const server = await mock((req, res) => {
      if (req.path === '/object_info/CheckpointLoaderSimple') {
        sendJson(res, 200, {
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [['x.safetensors'], {}] } } },
        });
        return;
      }
      if (req.path === '/prompt') {
        sendJson(res, 200, { prompt_id: 'p-2' });
        return;
      }
      if (req.path === '/history/p-2') {
        sendJson(res, 200, {
          'p-2': {
            status: { status_str: 'success', completed: true },
            outputs: { '5': { images: [{ filename: 'prev.png', type: 'temp' }] } },
          },
        });
        return;
      }
      res.setHeader('content-type', 'image/png');
      res.end(PNG_1X1);
    });
    const comfy = createComfyBackend({ pollMs: 10, websocket: false });
    expect(await comfy.listModels(conn('image-comfy', server.url))).toEqual([
      { id: 'x.safetensors' },
    ]);
    await comfy.generate(
      conn('image-comfy', server.url),
      {
        prompt: 'p',
        width: 64,
        height: 64,
        model: 'chosen.safetensors',
        workflow: {
          '1': { class_type: 'X', inputs: { t: '%prompt%', m: '%model%', s: '%seed%' } },
        },
      },
      new AbortController().signal,
    );
    const queued = server.requests.find((req) => req.path === '/prompt')?.json as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(queued.prompt['1']?.inputs.t).toBe('p');
    expect(queued.prompt['1']?.inputs.m).toBe('chosen.safetensors');
    expect(typeof queued.prompt['1']?.inputs.s).toBe('number');
    // 只有 temp 输出时也取
    expect(server.requests.some((req) => req.path.includes('type=temp'))).toBe(true);
  });

  it('错误归一化：node_errors 与执行失败', async () => {
    const server = await mock((req, res) => {
      if (
        req.path === '/prompt' &&
        (req.json as { prompt: Record<string, unknown> }).prompt['bad']
      ) {
        sendJson(res, 400, {
          error: {
            type: 'prompt_outputs_failed_validation',
            message: 'Prompt outputs failed validation',
          },
          node_errors: {
            '4': {
              errors: [{ message: 'Value not in list', details: 'ckpt_name: nope.safetensors' }],
            },
          },
        });
        return;
      }
      if (req.path === '/prompt') {
        sendJson(res, 200, { prompt_id: 'p-err' });
        return;
      }
      sendJson(res, 200, {
        'p-err': {
          status: {
            status_str: 'error',
            completed: false,
            messages: [
              ['execution_start', {}],
              ['execution_error', { node_type: 'KSampler', exception_message: 'CUDA OOM\n' }],
            ],
          },
          outputs: {},
        },
      });
    });
    const comfy = createComfyBackend({ pollMs: 10, websocket: false });
    const invalid = await expectImageError(
      comfy.generate(
        conn('image-comfy', server.url),
        { prompt: 'p', width: 64, height: 64, model: 'm', workflow: { bad: { inputs: {} } } },
        new AbortController().signal,
      ),
    );
    expect(invalid.kind).toBe('invalid');
    expect(invalid.message).toContain('Value not in list');
    expect(invalid.message).toContain('ckpt_name: nope.safetensors');

    const failed = await expectImageError(
      comfy.generate(
        conn('image-comfy', server.url),
        { prompt: 'p', width: 64, height: 64, model: 'm' },
        new AbortController().signal,
      ),
    );
    expect(failed.message).toBe('ComfyUI：KSampler：CUDA OOM');
  });
});

/* ------------------------------------------------------------------ */

describe('NovelAI', () => {
  const nai = createNovelAiBackend();

  it('参数映射（尺寸取 64 倍数、v4 字段）+ Bearer + zip 解包（deflate）', async () => {
    const zip = makeZip([
      { name: 'meta.txt', data: Buffer.from('hello') },
      { name: 'image_0.png', data: PNG_1X1 },
    ]);
    const server = await mock((req, res) => {
      res.setHeader('content-type', 'application/x-zip-compressed');
      res.end(zip);
    });
    const result = await nai.generate(
      conn('image-novelai', server.url, { apiKey: 'pst-abc' }),
      { prompt: '1girl', negative: 'bad hands', width: 830, height: 1210, seed: 5, cfg: 6 },
      new AbortController().signal,
    );
    const call = server.requests[0];
    expect(call?.path).toBe('/ai/generate-image');
    expect(call?.headers.authorization).toBe('Bearer pst-abc');
    expect(call?.json).toMatchObject({
      action: 'generate',
      input: '1girl',
      model: 'nai-diffusion-4-5-full',
      parameters: {
        width: 832,
        height: 1216,
        scale: 6,
        steps: 28,
        seed: 5,
        n_samples: 1,
        negative_prompt: 'bad hands',
        v4_prompt: { caption: { base_caption: '1girl' } },
        v4_negative_prompt: { caption: { base_caption: 'bad hands' } },
      },
    });
    expect(result).toEqual({ images: [{ mime: 'image/png', data: PNG_B64 }], seed: 5 });
  });

  it('zip：stored 条目也能读；没有图片时报错', async () => {
    const stored = makeZip([{ name: 'image_0.png', data: PNG_1X1, deflate: false }]);
    const entry = await extractFirstFromZip(new Uint8Array(stored), ['.png']);
    expect(Buffer.from(entry?.bytes ?? []).equals(PNG_1X1)).toBe(true);

    const noImage = makeZip([{ name: 'readme.txt', data: Buffer.from('x') }]);
    const server = await mock((_req, res) => {
      res.setHeader('content-type', 'application/zip');
      res.end(noImage);
    });
    const error = await expectImageError(
      nai.generate(
        conn('image-novelai', server.url, { apiKey: 'k' }),
        { prompt: 'x', width: 64, height: 64 },
        new AbortController().signal,
      ),
    );
    expect(error.message).toContain('没有图片');
  });

  it('错误归一化：401、429、没配 Token；listModels 是内置清单', async () => {
    const server = await mock((req, res) => {
      if (req.headers.authorization === 'Bearer busy') {
        sendJson(res, 429, { statusCode: 429, message: 'Concurrent generation is locked' });
        return;
      }
      sendJson(res, 401, { statusCode: 401, message: 'Invalid accessToken.' });
    });
    const auth = await expectImageError(
      nai.generate(
        conn('image-novelai', server.url, { apiKey: 'bad' }),
        { prompt: 'x', width: 64, height: 64 },
        new AbortController().signal,
      ),
    );
    expect(auth.kind).toBe('auth');
    expect(auth.message).toBe('NovelAI：Invalid accessToken.');

    const busy = await expectImageError(
      nai.generate(
        conn('image-novelai', server.url, { apiKey: 'busy' }),
        { prompt: 'x', width: 64, height: 64 },
        new AbortController().signal,
      ),
    );
    expect(busy.kind).toBe('rateLimit');
    expect(busy.retryable).toBe(true);

    const missing = await expectImageError(
      nai.generate(
        conn('image-novelai', server.url),
        { prompt: 'x', width: 64, height: 64 },
        new AbortController().signal,
      ),
    );
    expect(missing.kind).toBe('auth');
    expect(await nai.listModels(conn('image-novelai', server.url))).toEqual(NOVELAI_MODELS);
  });
});

/* ------------------------------------------------------------------ */

describe('OpenAI 兼容 images', () => {
  const openai = createOpenAiImageBackend();

  it('参数映射：带版本段直接拼 / 不带补 /v1；dall-e 要 b64_json，gpt-image 不带', async () => {
    const server = await mock((req, res) => {
      if (req.path.endsWith('/models')) {
        sendJson(res, 200, { data: [{ id: 'gpt-image-1' }, { id: 'dall-e-3' }] });
        return;
      }
      sendJson(res, 200, { created: 1, data: [{ b64_json: PNG_B64 }] });
    });
    const withVersion = conn('image-openai', `${server.url}/v1`, { apiKey: 'sk-1' });
    const bare = conn('image-openai', server.url, { apiKey: 'sk-1' });

    const r1 = await openai.generate(
      withVersion,
      {
        prompt: 'a lighthouse',
        negative: 'ignored',
        width: 1024,
        height: 1536,
        model: 'gpt-image-1',
      },
      new AbortController().signal,
    );
    await openai.generate(
      bare,
      { prompt: 'a lighthouse', width: 1024, height: 1024, model: 'dall-e-3' },
      new AbortController().signal,
    );
    const [first, second] = server.requests;
    expect(first?.path).toBe('/v1/images/generations');
    expect(first?.headers.authorization).toBe('Bearer sk-1');
    expect(first?.json).toEqual({
      model: 'gpt-image-1',
      prompt: 'a lighthouse',
      n: 1,
      size: '1024x1536',
    });
    expect(second?.path).toBe('/v1/images/generations');
    expect(second?.json).toMatchObject({ model: 'dall-e-3', response_format: 'b64_json' });
    expect(r1).toEqual({ images: [{ mime: 'image/png', data: PNG_B64 }] });

    expect(await openai.listModels(bare)).toEqual([{ id: 'gpt-image-1' }, { id: 'dall-e-3' }]);
    expect(server.requests[server.requests.length - 1]?.path).toBe('/v1/models');
  });

  it('只给 url 时服务端代取', async () => {
    const server: MockServer = await mock((req, res) => {
      if (req.path === '/files/out.png') {
        res.setHeader('content-type', 'image/png');
        res.end(PNG_1X1);
        return;
      }
      sendJson(res, 200, { data: [{ url: `${server.url}/files/out.png` }] });
    });
    const result = await openai.generate(
      conn('image-openai', `${server.url}/v1`),
      { prompt: 'x', width: 256, height: 256, model: 'some-model' },
      new AbortController().signal,
    );
    expect(result.images[0]).toEqual({ mime: 'image/png', data: PNG_B64 });
  });

  it('错误归一化：安全拦截 → filter；401 → auth', async () => {
    const server = await mock((req, res) => {
      if (req.headers.authorization === 'Bearer bad') {
        sendJson(res, 401, {
          error: {
            message: 'Incorrect API key provided',
            type: 'invalid_request_error',
            code: 'invalid_api_key',
          },
        });
        return;
      }
      sendJson(res, 400, {
        error: {
          message: 'Your request was rejected as a result of our safety system.',
          type: 'image_generation_user_error',
          code: 'content_policy_violation',
        },
      });
    });
    const filtered = await expectImageError(
      openai.generate(
        conn('image-openai', `${server.url}/v1`, { apiKey: 'ok' }),
        { prompt: 'x', width: 1024, height: 1024 },
        new AbortController().signal,
      ),
    );
    expect(filtered.kind).toBe('filter');
    expect(filtered.message).toContain('safety system');

    const auth = await expectImageError(
      openai.listModels(conn('image-openai', `${server.url}/v1`, { apiKey: 'bad' })),
    );
    expect(auth.kind).toBe('auth');
  });
});

describe('后端表', () => {
  it('按 id 取内置后端，可被测试替身覆盖', () => {
    expect(getImageBackend('image-sd').id).toBe('image-sd');
    const fake = { id: 'image-sd' } as ImageBackend;
    setImageBackendOverride('image-sd', fake);
    expect(getImageBackend('image-sd')).toBe(fake);
    setImageBackendOverride('image-sd', null);
    expect(getImageBackend('image-sd')).not.toBe(fake);
  });
});
