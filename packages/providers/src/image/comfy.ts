import { HttpError } from '../http.js';
import type { ImageBackend, ImageConnection, ImageGenParams } from './types.js';
import {
  abortErrorOf,
  baseOf,
  bearer,
  bytesToBase64,
  imageError,
  imageFetch,
  imageGetJson,
  randomSeed,
  sleep,
  sniffImageMime,
  toImageError,
} from './util.js';

/**
 * ComfyUI：
 * - 生成：`POST /prompt { prompt: 工作流, client_id }` → `prompt_id`；
 *   轮询 `GET /history/{prompt_id}` 直到出现 outputs；逐张 `GET /view?filename=…&type=output`；
 * - 模型：`GET /object_info/CheckpointLoaderSimple` 里 `ckpt_name` 的枚举；
 * - 进度：有全局 WebSocket 时连 `/ws?clientId=`，收 `progress {value,max}`；连不上就只报 0 与 1。
 *
 * 工作流占位（API 格式 JSON 里的字符串）：
 * - 整个字符串恰好是 `%name%` → 替换成**带类型**的值（数字就是数字，ST 同款语义）；
 * - 字符串里夹着 `%prompt%` / `%negative%` → 文本内替换（便于写「masterpiece, %prompt%」）。
 * 支持的名字：prompt negative seed width height steps cfg model sampler，
 * 以及 ST 工作流里的别名 negative_prompt / scale。
 */

export interface ComfyBackendOptions {
  /** 轮询 /history 的间隔（毫秒） */
  pollMs?: number;
  /** 最长等待（毫秒）；超时报 network 错误 */
  timeoutMs?: number;
  /** 关掉 WebSocket 进度（测试 / 没有 WebSocket 的环境） */
  websocket?: boolean;
}

const LABEL = 'ComfyUI';

/** 内置的最小 txt2img 工作流（没导入工作流时用；与 ST 的 Default_Comfy_Workflow 同构） */
export const DEFAULT_COMFY_WORKFLOW: Record<string, unknown> = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      cfg: '%cfg%',
      denoise: 1,
      latent_image: ['5', 0],
      model: ['4', 0],
      negative: ['7', 0],
      positive: ['6', 0],
      sampler_name: '%sampler%',
      scheduler: 'normal',
      seed: '%seed%',
      steps: '%steps%',
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: '%model%' } },
  '5': {
    class_type: 'EmptyLatentImage',
    inputs: { batch_size: 1, height: '%height%', width: '%width%' },
  },
  '6': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: '%prompt%' } },
  '7': { class_type: 'CLIPTextEncode', inputs: { clip: ['4', 1], text: '%negative%' } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'NewTavern', images: ['8', 0] } },
};

type Placeholders = Record<string, string | number>;

/** 占位表：缺省的数值占位给 ComfyUI 常见默认值，免得整条工作流因为一个空值被拒 */
export function comfyPlaceholders(p: ImageGenParams, seed: number): Placeholders {
  const values: Placeholders = {
    prompt: p.prompt,
    negative: p.negative ?? '',
    seed,
    width: p.width,
    height: p.height,
    steps: p.steps ?? 20,
    cfg: p.cfg ?? 7,
    sampler: p.sampler || 'euler',
    model: p.model ?? '',
  };
  values.negative_prompt = values.negative as string;
  values.scale = values.cfg as number;
  return values;
}

const WHOLE = /^%([a-z_]+)%$/;
const INLINE_TEXT = /%(prompt|negative|negative_prompt)%/g;

/** 深拷贝工作流并替换占位（不改传入对象） */
export function fillComfyWorkflow(workflow: unknown, values: Placeholders): unknown {
  if (typeof workflow === 'string') {
    const whole = WHOLE.exec(workflow);
    if (whole?.[1] && whole[1] in values) return values[whole[1]];
    return workflow.replace(INLINE_TEXT, (_, name: string) => String(values[name] ?? ''));
  }
  if (Array.isArray(workflow)) return workflow.map((item) => fillComfyWorkflow(item, values));
  if (workflow && typeof workflow === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(workflow))
      out[key] = fillComfyWorkflow(value, values);
    return out;
  }
  return workflow;
}

/** 工作流里是否用到了某个整值占位 */
function usesPlaceholder(workflow: unknown, name: string): boolean {
  return JSON.stringify(workflow).includes(`"%${name}%"`);
}

interface HistoryImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
  outputs?: Record<string, { images?: HistoryImage[] }>;
}

/** history 里执行失败时的说明（`execution_error` 消息的 exception_message） */
function executionError(entry: HistoryEntry): string | null {
  if (entry.status?.status_str !== 'error') return null;
  for (const message of entry.status.messages ?? []) {
    if (!Array.isArray(message) || message[0] !== 'execution_error') continue;
    const data = message[1] as { exception_message?: unknown; node_type?: unknown } | undefined;
    if (typeof data?.exception_message === 'string') {
      return typeof data.node_type === 'string'
        ? `${data.node_type}：${data.exception_message.trim()}`
        : data.exception_message.trim();
    }
  }
  return '工作流执行失败';
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** `/prompt` 400 时的 node_errors 摘要 */
function describeNodeErrors(body: unknown): string | null {
  const record = body as { error?: { message?: unknown }; node_errors?: unknown } | null;
  const parts: string[] = [];
  if (typeof record?.error?.message === 'string') parts.push(record.error.message);
  const nodeErrors = record?.node_errors;
  if (nodeErrors && typeof nodeErrors === 'object') {
    for (const [nodeId, info] of Object.entries(nodeErrors as Record<string, unknown>)) {
      const errors = (info as { errors?: { message?: unknown; details?: unknown }[] }).errors ?? [];
      for (const error of errors) {
        const detail =
          typeof error.details === 'string' && error.details ? `（${error.details}）` : '';
        if (typeof error.message === 'string') parts.push(`#${nodeId} ${error.message}${detail}`);
      }
    }
  }
  return parts.length > 0 ? parts.join('；') : null;
}

function wsUrlOf(conn: ImageConnection, clientId: string): string {
  const url = new URL(`${baseOf(conn)}/ws`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('clientId', clientId);
  return url.toString();
}

/** 连 WebSocket 收进度；失败静默。返回关闭函数 */
function watchProgress(
  conn: ImageConnection,
  clientId: string,
  promptId: () => string | null,
  onProgress: (fraction: number) => void,
): () => void {
  const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WS) return () => undefined;
  let socket: WebSocket | null = null;
  try {
    socket = new WS(wsUrlOf(conn, clientId));
  } catch {
    return () => undefined;
  }
  socket.addEventListener('message', (event: MessageEvent) => {
    if (typeof event.data !== 'string') return; // 二进制是预览图
    try {
      const message = JSON.parse(event.data) as {
        type?: string;
        data?: { value?: number; max?: number; prompt_id?: string };
      };
      if (message.type !== 'progress') return;
      const { value, max, prompt_id: id } = message.data ?? {};
      const current = promptId();
      if (id && current && id !== current) return;
      if (typeof value === 'number' && typeof max === 'number' && max > 0) {
        onProgress(Math.min(0.99, Math.max(0, value / max)));
      }
    } catch {
      // 不是 JSON：忽略
    }
  });
  socket.addEventListener('error', () => undefined);
  return () => {
    try {
      socket?.close();
    } catch {
      // 已关闭
    }
  };
}

export function createComfyBackend(options: ComfyBackendOptions = {}): ImageBackend {
  const pollMs = options.pollMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const useWebSocket = options.websocket ?? true;

  const listModels = async (conn: ImageConnection) => {
    try {
      const json = (await imageGetJson(
        conn,
        `${baseOf(conn)}/object_info/CheckpointLoaderSimple`,
        bearer(conn),
      )) as {
        CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown } } };
      };
      const spec = json.CheckpointLoaderSimple?.input?.required?.ckpt_name;
      const names = Array.isArray(spec) && Array.isArray(spec[0]) ? (spec[0] as unknown[]) : [];
      return names.filter((name): name is string => typeof name === 'string').map((id) => ({ id }));
    } catch (e) {
      throw toImageError(e, LABEL);
    }
  };

  return {
    id: 'image-comfy',
    listModels,

    async generate(conn, p, signal, onProgress) {
      const base = baseOf(conn);
      const headers = bearer(conn);
      const seed = p.seed ?? randomSeed();
      const source = p.workflow ?? DEFAULT_COMFY_WORKFLOW;
      let stopWatching: () => void = () => undefined;
      try {
        // 工作流要模型但没选：取第一个 checkpoint，省得用户第一次就撞上「ckpt_name 为空」
        let model = p.model;
        if (!model && usesPlaceholder(source, 'model')) {
          model = (await listModels(conn))[0]?.id;
          if (!model)
            throw imageError('invalid', `${LABEL}：没有可用的 checkpoint，也没有选择模型`);
        }
        const workflow = fillComfyWorkflow(source, comfyPlaceholders({ ...p, model }, seed));
        const clientId = `newtavern-${Math.random().toString(36).slice(2, 10)}`;
        let promptId: string | null = null;
        onProgress?.(0);
        if (onProgress && useWebSocket) {
          stopWatching = watchProgress(conn, clientId, () => promptId, onProgress);
        }

        let queued: { prompt_id?: unknown };
        try {
          const res = await imageFetch(
            conn,
            `${base}/prompt`,
            { method: 'POST', headers, body: { prompt: workflow, client_id: clientId } },
            signal,
          );
          queued = (await res.json()) as { prompt_id?: unknown };
        } catch (e) {
          // 400 = 工作流校验失败：把 node_errors 讲清楚
          const described = e instanceof HttpError ? describeNodeErrors(parseJson(e.body)) : null;
          if (described) throw imageError('invalid', `${LABEL}：${described}`, e);
          throw e;
        }
        if (typeof queued.prompt_id !== 'string') {
          throw imageError('invalid', `${LABEL}：/prompt 没有返回 prompt_id`, queued);
        }
        promptId = queued.prompt_id;

        const deadline = Date.now() + timeoutMs;
        let entry: HistoryEntry | undefined;
        for (;;) {
          if (signal.aborted) throw abortErrorOf(signal);
          const history = (await imageGetJson(
            conn,
            `${base}/history/${encodeURIComponent(promptId)}`,
            headers,
            signal,
          )) as Record<string, HistoryEntry>;
          entry = history[promptId];
          const failure = entry ? executionError(entry) : null;
          if (failure) throw imageError('invalid', `${LABEL}：${failure}`, entry);
          const hasImages = Object.values(entry?.outputs ?? {}).some(
            (output) => (output.images ?? []).length > 0,
          );
          if (entry && (hasImages || entry.status?.completed)) break;
          if (Date.now() > deadline) throw imageError('network', `${LABEL}：等待生成超时`);
          await sleep(pollMs, signal);
        }

        const files = Object.values(entry.outputs ?? {})
          .flatMap((output) => output.images ?? [])
          // SaveImage 的是 output；PreviewImage 是 temp，也收（有的工作流只接预览）
          .filter((image) => typeof image.filename === 'string');
        if (files.length === 0) throw imageError('invalid', `${LABEL}：工作流没有输出图片`);
        const outputs = files.some((file) => file.type === 'output')
          ? files.filter((file) => file.type === 'output')
          : files;

        const images: { mime: string; data: string }[] = [];
        for (const file of outputs) {
          const query = new URLSearchParams({
            filename: file.filename,
            subfolder: file.subfolder ?? '',
            type: file.type ?? 'output',
          });
          const res = await imageFetch(
            conn,
            `${base}/view?${query.toString()}`,
            { headers },
            signal,
          );
          const bytes = new Uint8Array(await res.arrayBuffer());
          const declared = res.headers.get('content-type')?.split(';')[0]?.trim();
          images.push({
            mime: sniffImageMime(bytes, declared || 'image/png'),
            data: bytesToBase64(bytes),
          });
        }
        onProgress?.(1);
        return { images, seed };
      } catch (e) {
        throw toImageError(e, LABEL);
      } finally {
        stopWatching();
      }
    },
  };
}

export const comfyBackend = createComfyBackend();
