import type { Part, PromptIR, Segment, ToolDef } from '@newtavern/core';

import { finalizeToolCall, type CollectedToolCall } from './collect.js';
import { syntheticCallId } from './tools.js';

/**
 * 不支持原生工具 / 结构化输出的模型的文本降级协议（M6 契约 §1.3）。
 *
 * 工具：去掉 `ir.tools`，在最后一个 system 段后追加协议说明段（工具清单 + 输出格式），
 * 模型用 ```tool_call 代码块发起调用；历史里的 tool_call / tool_result part 渲染成同样格式的文本。
 * 结构化输出：去掉 `ir.responseFormat`，在同一位置附 schema，从回复里抽第一个 JSON。
 */

export type FallbackLang = 'zh-CN' | 'en';

const TOOL_CALL_TAG = 'tool_call';
const TOOL_RESULT_TAG = 'tool_result';

/** 内容里本身有 ``` 时用更长的围栏，免得提前闭合 */
function fenceFor(content: string): string {
  let fence = '```';
  while (content.includes(fence)) fence += '`';
  return fence;
}

function block(tag: string, content: string): string {
  const fence = fenceFor(content);
  return `${fence}${tag}\n${content}\n${fence}`;
}

/** tool_call part → 与协议相同的代码块文本（arguments 能解析就内嵌对象，否则原样字符串） */
function renderToolCallText(part: Extract<Part, { type: 'tool_call' }>): string {
  let args: unknown = part.args;
  try {
    args = part.args.trim() === '' ? {} : (JSON.parse(part.args) as unknown);
  } catch {
    // 保留原字符串
  }
  return block(TOOL_CALL_TAG, JSON.stringify({ name: part.name, arguments: args }));
}

function renderToolResultText(part: Extract<Part, { type: 'tool_result' }>): string {
  const header = `${TOOL_RESULT_TAG} ${part.name}${part.isError ? ' error' : ''}`;
  return block(header, part.content);
}

/** 把一段里的工具 part 换成文本 part（其余 part 原样） */
function textifyToolParts(segment: Segment): Segment {
  if (!segment.parts.some((p) => p.type === 'tool_call' || p.type === 'tool_result')) {
    return segment;
  }
  const parts: Part[] = segment.parts.map((p): Part => {
    if (p.type === 'tool_call') return { type: 'text', text: renderToolCallText(p) };
    if (p.type === 'tool_result') return { type: 'text', text: renderToolResultText(p) };
    return p;
  });
  return { ...segment, parts };
}

const PROTOCOL_TEXT: Record<
  FallbackLang,
  {
    intro: string;
    rules: string[];
    required: string;
    forced: (name: string) => string;
    toolsHeading: string;
    params: string;
  }
> = {
  'zh-CN': {
    intro:
      '# 工具调用\n你可以调用下列工具。需要调用时，输出一个或多个如下格式的代码块（每个代码块一次调用），然后立即停止输出，等待工具结果：',
    rules: [
      '- `arguments` 必须是符合该工具参数 JSON Schema 的 JSON 对象；',
      '- 不要自己编写工具结果：结果会以 ```tool_result 代码块的形式出现在下一条用户消息里；',
      '- 不需要工具时直接正常回答，不要输出 tool_call 代码块。',
    ],
    required: '本轮必须至少调用一个工具。',
    forced: (name) => `本轮必须调用工具 ${name}。`,
    toolsHeading: '## 可用工具',
    params: '参数（JSON Schema）：',
  },
  en: {
    intro:
      '# Tool use\nYou can call the tools below. To call one, output one or more code blocks in exactly this format (one call per block), then stop and wait for the results:',
    rules: [
      '- `arguments` must be a JSON object that matches the tool’s parameter JSON Schema;',
      '- Never write tool results yourself: they will arrive as ```tool_result code blocks in the next user message;',
      '- If no tool is needed, just answer normally without any tool_call block.',
    ],
    required: 'You must call at least one tool in this turn.',
    forced: (name) => `You must call the tool ${name} in this turn.`,
    toolsHeading: '## Available tools',
    params: 'Parameters (JSON Schema):',
  },
};

function protocolText(tools: readonly ToolDef[], ir: PromptIR, lang: FallbackLang): string {
  const t = PROTOCOL_TEXT[lang];
  const example = block(TOOL_CALL_TAG, '{"name": "tool_name", "arguments": {}}');
  const lines = [t.intro, '', example, '', ...t.rules];
  const choice = ir.toolChoice;
  if (choice === 'required') lines.push('', t.required);
  else if (typeof choice === 'object') lines.push('', t.forced(choice.name));
  lines.push('', t.toolsHeading);
  for (const tool of tools) {
    lines.push(
      '',
      `### ${tool.name}`,
      tool.description,
      t.params,
      block('json', JSON.stringify(tool.parameters, null, 2)),
    );
  }
  return lines.join('\n');
}

/**
 * 在最后一个 system 段后插入一段 system 说明；没有 system 段时放在最前。
 * cachePlan 断点下标随之平移。
 */
function insertInstruction(ir: PromptIR, id: string, text: string): PromptIR {
  let at = -1;
  for (let i = ir.segments.length - 1; i >= 0; i -= 1) {
    const seg = ir.segments[i];
    if (seg?.role === 'system' && seg.anchor.slot === 'system') {
      at = i;
      break;
    }
  }
  if (at < 0) {
    for (let i = ir.segments.length - 1; i >= 0; i -= 1) {
      if (ir.segments[i]?.role === 'system') {
        at = i;
        break;
      }
    }
  }
  const ref = at >= 0 ? ir.segments[at] : undefined;
  const insertAt = at + 1;
  const segment: Segment = {
    id,
    role: 'system',
    parts: [{ type: 'text', text }],
    origin: { kind: 'injection', ref: id },
    anchor: { slot: ref?.anchor.slot ?? 'system', order: ref?.anchor.order ?? 0 },
    stability: 'static',
  };
  const segments = [...ir.segments.slice(0, insertAt), segment, ...ir.segments.slice(insertAt)];
  const breakpoints = (ir.cachePlan?.breakpoints ?? []).map((b) => (b >= insertAt ? b + 1 : b));
  return { ...ir, segments, cachePlan: { ...ir.cachePlan, breakpoints } };
}

/** caps.tools=false 且 ir.tools 非空时调用：去掉 tools，在最后一个 system 段后追加协议说明段，
 *  把历史里的 tool_call / tool_result part 渲染成文本。返回新 IR（不改原对象）。
 *  toolChoice='none' 或没有 tools 时只渲染历史、不加协议段。 */
export function applyTextToolProtocol(ir: PromptIR, lang: FallbackLang): PromptIR {
  const tools = ir.tools ?? [];
  const { tools: _tools, toolChoice: _choice, ...rest } = ir;
  let out: PromptIR = { ...rest, segments: ir.segments.map(textifyToolParts) };
  if (tools.length > 0 && ir.toolChoice !== 'none') {
    out = insertInstruction(out, 'tool_protocol', protocolText(tools, ir, lang));
  }
  return out;
}

/** 找工具调用代码块的开头：```tool_call（允许更长的围栏与行尾空白） */
const OPEN_RE = /(`{3,})[ \t]*tool_call[ \t]*\r?\n/g;

/** 从模型文本里解析 ```tool_call {"name":…,"arguments":{…}}``` 代码块（可多个）；rest = 去掉代码块后的正文。
 *  末尾没闭合的代码块（模型停在半截）照样解析到文本结尾。 */
export function parseTextToolCalls(text: string): { toolCalls: CollectedToolCall[]; rest: string } {
  const toolCalls: CollectedToolCall[] = [];
  let rest = '';
  let cursor = 0;
  OPEN_RE.lastIndex = 0;
  for (let m = OPEN_RE.exec(text); m !== null; m = OPEN_RE.exec(text)) {
    const fence = m[1] ?? '```';
    const bodyStart = m.index + m[0].length;
    const close = text.indexOf(fence, bodyStart);
    const bodyEnd = close < 0 ? text.length : close;
    rest += text.slice(cursor, m.index);
    cursor = close < 0 ? text.length : close + fence.length;
    OPEN_RE.lastIndex = cursor;
    toolCalls.push(parseCallBody(text.slice(bodyStart, bodyEnd), toolCalls.length));
  }
  rest += text.slice(cursor);
  return { toolCalls, rest: rest.replace(/\n{3,}/g, '\n\n').trim() };
}

function parseCallBody(body: string, index: number): CollectedToolCall {
  const id = syntheticCallId(index);
  const found = extractFirstJson(body);
  const value = found?.value;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      id,
      name: '',
      args: body.trim(),
      parseError: found ? '代码块不是 {"name", "arguments"} 对象' : '代码块不是合法 JSON',
    };
  }
  const obj = value as Record<string, unknown>;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const rawArgs = obj.arguments ?? obj.args ?? obj.parameters ?? {};
  const args = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
  const call = finalizeToolCall({ id, name, args });
  if (name === '') return { ...call, parseError: call.parseError ?? '代码块缺少 name' };
  return call;
}

const RESPONSE_FORMAT_TEXT: Record<FallbackLang, (name: string, schema: string) => string> = {
  'zh-CN': (name, schema) =>
    `# 输出格式（${name}）\n只输出一个符合下列 JSON Schema 的 JSON 值，不要输出任何其他文字、解释或代码围栏：\n${schema}`,
  en: (name, schema) =>
    `# Output format (${name})\nOutput only a single JSON value matching the JSON Schema below — no other text, explanation or code fences:\n${schema}`,
};

/** caps.structuredOutput=false 且 ir.responseFormat 存在时调用：去掉 responseFormat，
 *  在最后一个 system 段后附 schema 说明。返回新 IR（不改原对象）。 */
export function applyTextResponseFormat(ir: PromptIR, lang: FallbackLang): PromptIR {
  const rf = ir.responseFormat;
  const { responseFormat: _rf, ...rest } = ir;
  if (!rf) return { ...rest };
  const text = RESPONSE_FORMAT_TEXT[lang](
    rf.name,
    block('json', JSON.stringify(rf.schema, null, 2)),
  );
  return insertInstruction(rest, 'response_format', text);
}

/**
 * 从文本里抽第一个 JSON 对象 / 数组：优先 ```json 代码块，其次按括号配对扫描（跳过字符串里的括号），
 * 解析失败就从下一个起点继续找。找不到返回 undefined。
 */
export function extractFirstJson(text: string): { json: string; value: unknown } | undefined {
  const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1] !== undefined) {
    const inner = fenced[1].trim();
    try {
      return { json: inner, value: JSON.parse(inner) as unknown };
    } catch {
      // 代码块里不是纯 JSON：退回扫描
    }
  }
  for (let start = 0; start < text.length; start += 1) {
    const ch = text[start];
    if (ch !== '{' && ch !== '[') continue;
    const end = matchBracket(text, start);
    if (end < 0) continue;
    const candidate = text.slice(start, end + 1);
    try {
      return { json: candidate, value: JSON.parse(candidate) as unknown };
    } catch {
      // 继续找下一个起点
    }
  }
  return undefined;
}

/** 从 start 处的 { / [ 找到配对的闭括号下标；字符串内的括号不计；找不到返回 -1 */
function matchBracket(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') stack.push('}');
    else if (ch === '[') stack.push(']');
    else if (ch === '}' || ch === ']') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * 流式过滤：把 text.delta 里的 ```tool_call 代码块滤掉，只放行正文。
 * 围栏可能跨 chunk，开头不完整（还没见到换行）时先憋着；`flush()` 在流末吐出剩余正文。
 */
export function createToolCallTextFilter(): { push(delta: string): string; flush(): string } {
  let buf = '';
  let fence = '';
  const HEADER_RE = /^(`{3,})[ \t]*tool_call[ \t]*\r?$/;

  const push = (delta: string): string => {
    buf += delta;
    let out = '';
    for (;;) {
      if (fence !== '') {
        const close = buf.indexOf(fence);
        if (close < 0) {
          // 保留可能是半个闭合围栏的尾巴
          buf = buf.slice(Math.max(0, buf.length - (fence.length - 1)));
          return out;
        }
        buf = buf.slice(close + fence.length);
        fence = '';
        continue;
      }
      const idx = buf.indexOf('```');
      if (idx < 0) {
        // 末尾的 1–2 个反引号可能是围栏的开头，留到下一次
        const tail = /`{1,2}$/.exec(buf)?.[0].length ?? 0;
        out += buf.slice(0, buf.length - tail);
        buf = buf.slice(buf.length - tail);
        return out;
      }
      out += buf.slice(0, idx);
      buf = buf.slice(idx);
      const nl = buf.indexOf('\n');
      if (nl < 0) return out; // 围栏头还没收全
      const header = buf.slice(0, nl);
      const m = HEADER_RE.exec(header);
      if (m?.[1] !== undefined) {
        fence = m[1];
        buf = buf.slice(nl + 1);
      } else {
        // 普通代码块的围栏：原样放行
        out += buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
      }
    }
  };

  const flush = (): string => {
    const rest = fence === '' ? buf : '';
    buf = '';
    fence = '';
    return rest;
  };

  return { push, flush };
}
