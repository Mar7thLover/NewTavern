import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cardGenerateImage, ImagineError, IMAGE_GEN_KEY, runImagine } from './api';
import {
  IMAGINE_MENU_ITEMS,
  ImagineMenu,
  ImagineProgressView,
  isImageGenNode,
} from './ImagineMenu';
import { cancelImagine, getImagineState, startImagine } from './store';
import { queryKeys, type ChatDetail, type MessageNode } from '../../lib/api';

/**
 * 生图菜单与前端数据层：菜单项、未配置后端时的指引、进度条三种状态、
 * SSE 客户端（事件顺序、错误、取消）、store 把节点并进缓存并移动 head、前端卡 generateImage。
 * 没有 jsdom：组件用 renderToStaticMarkup，网络用 stub 的 fetch。
 */

function sse(events: [string, unknown][], options: { hang?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`:${'-'.repeat(16)}\n\n`));
      for (const [event, data] of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      if (!options.hang) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function node(
  id: string,
  parentId: string | null,
  extra: Record<string, unknown> | null = null,
): MessageNode {
  return {
    id,
    chatId: 'c1',
    parentId,
    siblingSeq: 0,
    role: 'assistant',
    name: '塞拉菲娜',
    parts: [{ type: 'image', assetId: 'a1', mime: 'image/png' }],
    reasoning: null,
    usage: null,
    provider: 'image-sd',
    model: null,
    isHidden: false,
    extra,
    hasVariables: false,
    createdAt: '2026-09-22T00:00:00.000Z',
  };
}

function detail(nodes: MessageNode[], headNodeId: string | null): ChatDetail {
  return {
    id: 'c1',
    title: '测试',
    mode: 'roleplay',
    characterIds: [],
    personaId: null,
    presetId: null,
    overrides: null,
    rootNodeId: nodes[0]?.id ?? null,
    headNodeId,
    metadata: null,
    createdAt: '2026-09-22T00:00:00.000Z',
    updatedAt: '2026-09-22T00:00:00.000Z',
    character: null,
    lorebookIds: [],
    messageCount: nodes.length,
    lastMessageAt: null,
    preview: null,
    nodes,
  };
}

function renderMenu(settings: unknown) {
  const client = new QueryClient();
  client.setQueryData(queryKeys.setting(IMAGE_GEN_KEY), settings);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImagineMenu chatId="c1" defaultOpen />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const waitUntil = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('生图菜单', () => {
  it('三项按顺序：画最后一条消息 / 画角色 / 自由描述', () => {
    const html = renderMenu({ connectionId: 'img-1', defaults: {} });
    expect(html).toContain('role="menu"');
    const modes = [...html.matchAll(/data-mode="([a-z_]+)"/g)].map((m) => m[1]);
    expect(modes).toEqual(['last_message', 'character', 'free']);
    expect(IMAGINE_MENU_ITEMS.map((item) => item.labelKey)).toEqual([
      'imageGen.menu.lastMessage',
      'imageGen.menu.character',
      'imageGen.menu.free',
    ]);
    expect(html).toContain('aria-expanded="true"');
  });

  it('没选生图后端：不给菜单项，给去连接页的链接', () => {
    const html = renderMenu({ connectionId: null, defaults: {} });
    expect(html).not.toContain('role="menuitem"');
    expect(html).toContain('href="/connections"');
  });

  it('进度条：写提示词 / 作画百分比 / 失败可重试', () => {
    const client = new QueryClient();
    const render = (state: Parameters<typeof ImagineProgressView>[0]['state']) =>
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ImagineProgressView chatId="c1" state={state} />
        </QueryClientProvider>,
      );
    const writing = render({
      phase: 'writing',
      fraction: null,
      prompt: null,
      error: null,
      body: {},
    });
    expect(writing).toContain('data-phase="writing"');
    expect(writing).toContain('imageGen.progress.writing');
    const drawing = render({
      phase: 'drawing',
      fraction: 0.42,
      prompt: '1girl',
      error: null,
      body: {},
    });
    expect(drawing).toContain('aria-valuenow="42"');
    expect(drawing).toContain('width:42%');
    expect(drawing).toContain('1girl');
    expect(drawing).toContain('imageGen.progress.cancel');
    const failed = render({
      phase: 'error',
      fraction: null,
      prompt: null,
      error: { message: 'CUDA OOM', kind: 'overloaded' },
      body: { mode: 'free', prompt: 'x' },
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('imageGen.progress.retry');
    expect(failed).not.toContain('progressbar');
  });

  it('isImageGenNode 认 extra.generatedBy', () => {
    expect(isImageGenNode(node('n', null, { generatedBy: 'image' }))).toBe(true);
    expect(isImageGenNode(node('n', null, null))).toBe(false);
  });
});

describe('runImagine（SSE 客户端）', () => {
  it('按事件回调：job → prompt → progress → node，返回结果', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sse([
          ['job', { id: 'j1', status: 'pending' }],
          ['job', { id: 'j1', status: 'running' }],
          ['prompt', { text: 'a cat' }],
          ['progress', { fraction: 0.5 }],
          ['node', { node: node('n2', 'n1'), chat: { id: 'c1' } }],
          ['job', { id: 'j1', status: 'done' }],
          ['done', { jobId: 'j1' }],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const seen: string[] = [];
    const result = await runImagine(
      'c1',
      { mode: 'free', prompt: 'a cat' },
      {
        onJob: (job) => seen.push(`job:${job.status}`),
        onPrompt: (text) => seen.push(`prompt:${text}`),
        onProgress: (fraction) => seen.push(`progress:${fraction}`),
        onNode: (n) => seen.push(`node:${n.id}`),
      },
    );
    expect(seen).toEqual([
      'job:pending',
      'job:running',
      'prompt:a cat',
      'progress:0.5',
      'node:n2',
      'job:done',
    ]);
    expect(result.jobId).toBe('j1');
    expect(result.node?.id).toBe('n2');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/chats/c1/imagine');
    expect(JSON.parse(String(init.body))).toEqual({ mode: 'free', prompt: 'a cat' });
  });

  it('SSE error → ImagineError（带 kind）；开流前的 4xx 同样', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(sse([['error', { message: 'CUDA OOM', kind: 'overloaded' }]])),
    );
    await expect(runImagine('c1', { mode: 'free', prompt: 'x' })).rejects.toMatchObject({
      name: 'ImagineError',
      message: 'CUDA OOM',
      kind: 'overloaded',
    });
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'no_image_backend', message: '还没有选择生图后端' }), {
          status: 400,
        }),
      ),
    );
    const error = await runImagine('c1', { mode: 'character' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImagineError);
    expect((error as ImagineError).kind).toBe('no_image_backend');
  });
});

describe('store：进行中状态与缓存', () => {
  it('成功：节点并进 ChatDetail、head 移过去，状态清空', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        sse([
          ['job', { id: 'j1', status: 'running' }],
          ['prompt', { text: 'rain' }],
          [
            'node',
            {
              node: node('n2', 'n1', { generatedBy: 'image' }),
              chat: { id: 'c1', headNodeId: 'n2' },
            },
          ],
          ['done', { jobId: 'j1' }],
        ]),
      ),
    );
    const client = new QueryClient();
    client.setQueryData(queryKeys.chat('c1'), detail([node('n1', null)], 'n1'));
    expect(startImagine(client, 'c1', { mode: 'last_message' })).toBe(true);
    expect(getImagineState('c1')?.phase).toBe('writing');
    // 同一会话进行中时不重复发起
    expect(startImagine(client, 'c1', { mode: 'free', prompt: 'x' })).toBe(false);
    await waitUntil(() => getImagineState('c1') === null);
    const cached = client.getQueryData<ChatDetail>(queryKeys.chat('c1'));
    expect(cached?.headNodeId).toBe('n2');
    expect(cached?.nodes.map((n) => n.id)).toEqual(['n1', 'n2']);
  });

  it('失败：留在 error 状态（带请求体，可重试）；取消：状态直接清空', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(sse([['error', { message: '炸了', kind: 'invalid' }]])),
    );
    const client = new QueryClient();
    startImagine(client, 'c2', { mode: 'free', prompt: 'x' });
    await waitUntil(() => getImagineState('c2')?.phase === 'error');
    expect(getImagineState('c2')?.error).toEqual({ message: '炸了', kind: 'invalid' });
    expect(getImagineState('c2')?.body).toEqual({ mode: 'free', prompt: 'x' });

    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      return new Promise<Response>((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        void resolve;
      });
    });
    startImagine(client, 'c3', { mode: 'free', prompt: 'x' });
    expect(getImagineState('c3')?.phase).toBe('drawing');
    cancelImagine('c3');
    await waitUntil(() => getImagineState('c3') === null);
  });
});

describe('前端卡 newtavern.generateImage', () => {
  it('attach=false，返回绝对 assetUrl；空 prompt 拒绝', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        sse([
          ['asset', { assetId: 'as-1', mime: 'image/png', url: '/api/assets/as-1/file' }],
          ['done', { jobId: 'j', assetIds: ['as-1'], prompt: 'a fox' }],
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const result = await cardGenerateImage('c1', {
      prompt: ' a fox ',
      width: 640.4,
      negative: 'bad',
    });
    expect(result.assetUrl).toMatch(/^https?:\/\/[^/]+\/api\/assets\/as-1\/file$/);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(JSON.parse(String(init.body))).toEqual({
      mode: 'free',
      prompt: 'a fox',
      attach: false,
      negative: 'bad',
      width: 640,
    });
    await expect(cardGenerateImage('c1', { prompt: '  ' })).rejects.toThrow('prompt');
  });
});
