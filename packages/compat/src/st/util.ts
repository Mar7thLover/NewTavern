/** 共享小工具：对象守卫与 zod 错误中文化包装 */

import type { z } from 'zod';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOrThrow<S extends z.ZodType>(
  schema: S,
  data: unknown,
  label: string,
): z.output<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(根)'}: ${issue.message}`)
      .join('；');
    throw new Error(`${label}：${detail}`);
  }
  return result.data;
}
