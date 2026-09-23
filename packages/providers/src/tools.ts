import type { Part, PromptIR, ToolChoice } from '@newtavern/core';

/**
 * 工具调用的适配器共用小件（M6 契约 §1.2）：合成调用 id、参数解析、JSON Schema 清洗。
 * 请求渲染与流式解析各在适配器里做，这里只放与提供商无关的部分。
 */

export type ToolCallPart = Extract<Part, { type: 'tool_call' }>;
export type ToolResultPart = Extract<Part, { type: 'tool_result' }>;

/** 没有调用 id 的家族（Gemini 旧版、部分 OpenAI 兼容端点）按到达顺序生成 `call_<index>` */
export function syntheticCallId(index: number): string {
  return `call_${index}`;
}

/** 是否为 `syntheticCallId` 生成的 id（回传给认 id 的提供商时不带它） */
export function isSyntheticCallId(id: string): boolean {
  return /^call_\d+$/.test(id);
}

export function isToolPart(part: Part): part is ToolCallPart | ToolResultPart {
  return part.type === 'tool_call' || part.type === 'tool_result';
}

/** IR 里是否出现过工具 part（历史里的调用与结果） */
export function irHasToolParts(ir: PromptIR): boolean {
  return ir.segments.some((seg) => seg.parts.some(isToolPart));
}

/**
 * 工具参数（JSON 字符串）→ 对象。Anthropic `tool_use.input`、Gemini `functionCall.args` 要对象：
 * 空串视为 `{}`；解析失败或不是对象时返回 undefined，由调用方告警并用 `{}` 顶上。
 */
export function parseToolArgsObject(args: string): Record<string, unknown> | undefined {
  if (args.trim() === '') return {};
  try {
    const value: unknown = JSON.parse(args);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** tool_result 在只收字符串的提供商（OpenAI 系）里的正文：出错时加前缀，免得模型当成正常结果 */
export function toolResultText(part: ToolResultPart): string {
  return part.isError ? `Error: ${part.content}` : part.content;
}

/** 工具选择缺省 'auto' */
export function effectiveToolChoice(ir: PromptIR): ToolChoice {
  return ir.toolChoice ?? 'auto';
}

/** 强制调用的工具名不在 tools 里：告警（各家都会 400） */
export function checkForcedTool(ir: PromptIR, warnings: string[]): void {
  const choice = ir.toolChoice;
  if (typeof choice !== 'object') return;
  if (!(ir.tools ?? []).some((t) => t.name === choice.name)) {
    warnings.push(`toolChoice 指定的工具 ${choice.name} 不在 tools 里`);
  }
}

/**
 * Gemini `Schema`（OpenAPI 3.0 子集）认的关键字。其余（`additionalProperties`、`$ref`、`oneOf`、
 * `const`、`$schema` …）剔除；`const` 改写为单值 `enum`，`type: [T, 'null']` 改写为 `type:T + nullable`。
 * 见 https://ai.google.dev/api/caching#Schema
 */
const GOOGLE_SCHEMA_KEYS: ReadonlySet<string> = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'maxItems',
  'minItems',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'minLength',
  'maxLength',
  'pattern',
  'example',
  'anyOf',
  'propertyOrdering',
  'default',
  'items',
  'minimum',
  'maximum',
]);

/**
 * 把 JSON Schema 清洗成 Gemini `Schema`。返回新对象（不改入参），剔除的关键字去重后写进 `dropped`。
 */
export function sanitizeGoogleSchema(
  schema: Record<string, unknown>,
  dropped: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'const') {
      // 单值常量 → enum（Gemini 的 enum 只认字符串，其他类型照样剔除）
      if (typeof value === 'string' && schema.enum === undefined) out.enum = [value];
      else dropped.add(key);
      continue;
    }
    if (!GOOGLE_SCHEMA_KEYS.has(key)) {
      dropped.add(key);
      continue;
    }
    if (key === 'type' && Array.isArray(value)) {
      const types = value.filter((t): t is string => typeof t === 'string');
      const nonNull = types.filter((t) => t !== 'null');
      if (types.includes('null')) out.nullable = true;
      if (nonNull.length === 1) {
        out.type = nonNull[0];
      } else if (nonNull.length > 1) {
        // 多类型联合：Gemini 用 anyOf 表达
        out.anyOf = nonNull.map((t) => ({ type: t }));
      }
      continue;
    }
    if (key === 'properties' && isPlainObject(value)) {
      // properties 的键是字段名不是关键字，只清洗值
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) {
        props[name] = isPlainObject(sub) ? sanitizeGoogleSchema(sub, dropped) : sub;
      }
      out.properties = props;
      continue;
    }
    if (key === 'items' && isPlainObject(value)) {
      out.items = sanitizeGoogleSchema(value, dropped);
      continue;
    }
    if (key === 'anyOf' && Array.isArray(value)) {
      out.anyOf = value.map((sub) =>
        isPlainObject(sub) ? sanitizeGoogleSchema(sub, dropped) : sub,
      );
      continue;
    }
    out[key] = value;
  }
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
