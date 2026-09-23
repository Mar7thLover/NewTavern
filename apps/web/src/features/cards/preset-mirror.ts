/**
 * ST 预设 JSON → 酒馆助手 `Preset` 形状（`getPreset('in_use')` 读的镜像，M5（三）§3.2）。
 *
 * 照酒馆助手 4.9.3 `src/function/preset.ts` 的 `toPreset` / `toPresetPrompt` 逐字段换算：
 * `prompt_order`（character_id 100001）决定 `prompts` 的顺序与启用，不在顺序里的进 `prompts_unused`；
 * 采样参数取 `temperature` 等非 `_openai` 后缀的字段（新酒馆存的是导入时的 JSON，没有「当前 UI 值」）。
 * 正则脚本在 `extensions.regex_scripts` 里原样保留（酒馆助手会转成 TavernRegex 形状；卡里很少读它）。
 */

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const NAME_PREFIX: Record<string, string> = {
  '-1': 'none',
  '0': 'default',
  '2': 'content',
  '1': 'completion',
};

interface OrderEntry {
  identifier: string;
  enabled: boolean;
}

function readOrder(data: Json): OrderEntry[] {
  const lists = Array.isArray(data.prompt_order) ? data.prompt_order.filter(isRecord) : [];
  const picked =
    lists.find((list) => String(list.character_id) === '100001') ??
    lists.find((list) => String(list.character_id) === '100000') ??
    lists[0];
  const order = picked && Array.isArray(picked.order) ? picked.order : [];
  return order.filter(isRecord).flatMap((entry) =>
    typeof entry.identifier === 'string'
      ? [{ identifier: entry.identifier, enabled: entry.enabled !== false }]
      : [],
  );
}

function toPresetPrompt(prompt: Json, order: readonly OrderEntry[]): Json {
  const marker = prompt.marker === true;
  const normal = prompt.system_prompt === false && !marker;
  const system = prompt.system_prompt === true && !marker;
  const identifier = typeof prompt.identifier === 'string' ? prompt.identifier : '';
  const out: Json = {
    id: identifier,
    name: typeof prompt.name === 'string' ? prompt.name : 'unnamed',
    enabled:
      order.find((entry) => entry.identifier === identifier)?.enabled ?? prompt.enabled !== false,
  };
  if (normal || marker) {
    const inChat = prompt.injection_position === 1;
    out.position = inChat
      ? {
          type: 'in_chat',
          depth: typeof prompt.injection_depth === 'number' ? prompt.injection_depth : 4,
          order: typeof prompt.injection_order === 'number' ? prompt.injection_order : 100,
        }
      : { type: 'relative' };
  }
  out.role = prompt.role === 'user' || prompt.role === 'assistant' ? prompt.role : 'system';
  if (normal || system) out.content = typeof prompt.content === 'string' ? prompt.content : '';
  if (isRecord(prompt.extra)) out.extra = prompt.extra;
  return out;
}

const num = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : Number(value ?? fallback) || fallback;

export function toHelperPreset(data: Json): Json {
  const order = readOrder(data);
  const prompts = (Array.isArray(data.prompts) ? data.prompts : [])
    .filter(isRecord)
    .map((prompt) => toPresetPrompt(prompt, order));
  const ids = order.map((entry) => entry.identifier);
  const used = ids.flatMap((id) => prompts.filter((prompt) => prompt.id === id).slice(0, 1));
  const unused = prompts.filter((prompt) => !ids.includes(String(prompt.id)));
  const extensions = isRecord(data.extensions) ? data.extensions : {};

  return {
    settings: {
      max_context: num(data.openai_max_context),
      max_completion_tokens: num(data.openai_max_tokens),
      reply_count: num(data.n, 1),
      should_stream: Boolean(data.stream_openai),
      temperature: num(data.temperature, 1),
      frequency_penalty: num(data.frequency_penalty),
      presence_penalty: num(data.presence_penalty),
      top_p: num(data.top_p, 1),
      repetition_penalty: num(data.repetition_penalty, 1),
      min_p: num(data.min_p),
      top_k: num(data.top_k),
      top_a: num(data.top_a),
      seed: num(data.seed, -1),
      squash_system_messages: Boolean(data.squash_system_messages),
      reasoning_effort: typeof data.reasoning_effort === 'string' ? data.reasoning_effort : 'auto',
      request_thoughts: Boolean(data.show_thoughts),
      request_images: Boolean(data.request_images),
      enable_function_calling: Boolean(data.function_calling),
      enable_web_search: Boolean(data.enable_web_search),
      allow_sending_images:
        data.image_inlining === true
          ? typeof data.inline_image_quality === 'string'
            ? data.inline_image_quality
            : 'auto'
          : 'disabled',
      allow_sending_videos: Boolean(data.video_inlining),
      character_name_prefix: NAME_PREFIX[String(num(data.names_behavior))] ?? 'default',
      wrap_user_messages_in_quotes: Boolean(data.wrap_in_quotes),
    },
    prompts: used,
    prompts_unused: unused,
    extensions: {
      ...extensions,
      tavern_helper: isRecord(extensions.tavern_helper)
        ? extensions.tavern_helper
        : { scripts: [], variables: {} },
    },
  };
}
