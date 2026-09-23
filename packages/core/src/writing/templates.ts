/**
 * 写作提示词模板（M7 契约 §2.1）。
 *
 * 模板正文放在 `packages/i18n/prompts/writing.{zh-CN,en}.md`，按「## <id>」分节。
 * core 不读文件（纯函数、不依赖 Node），由服务端读出 Markdown 后调用 `parseWritingTemplates`，
 * 把结果作为 `WritingAssembleInput.templates` 传进来。
 *
 * 各节可用的占位符：
 * - `system`：`{{projectTitle}}`
 * - `label.style` / `label.bible` / `label.outline` / `label.summaries` / `label.triggered` /
 *   `block.selection` / `block.after` / `block.instruction`：`{{text}}`
 * - `label.summary-item`：`{{n}}`（章节序号，从 1 起）、`{{title}}`、`{{summary}}`
 * - `label.chapter`：`{{title}}`、`{{text}}`；`label.chapter-empty`：`{{title}}`
 * - `label.reference-note`：`{{title}}`、`{{text}}`；`label.reference-chapter`：`{{n}}`、`{{title}}`、`{{text}}`
 * - `action.*`：`{{targetLength}}`
 */

export const WRITING_TEMPLATE_IDS = [
  'system',
  'label.style',
  'label.bible',
  'label.outline',
  'label.summaries',
  'label.summary-item',
  'label.chapter',
  'label.chapter-empty',
  'label.truncated',
  'label.triggered',
  'label.reference-note',
  'label.reference-chapter',
  'block.selection',
  'block.after',
  'block.instruction',
  'action.continue',
  'action.rewrite',
  'action.expand',
  'action.condense',
  'action.summarize',
  'action.custom',
] as const;

export type WritingTemplateId = (typeof WRITING_TEMPLATE_IDS)[number];
export type WritingTemplates = Record<WritingTemplateId, string>;

const HEADING = /^##\s+(\S+)\s*$/;

/**
 * 解析 `writing.*.md`：以「## <id>」行分节，节内容去掉首尾空白；第一个标题之前的内容（文件说明注释）丢弃。
 * 缺节时抛错（模板文件是随仓库发布的，缺节是打包错误，越早暴露越好）。
 */
export function parseWritingTemplates(markdown: string): WritingTemplates {
  const sections = new Map<string, string[]>();
  let current: string[] | null = null;
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const match = HEADING.exec(line);
    if (match?.[1] !== undefined) {
      current = [];
      sections.set(match[1], current);
      continue;
    }
    current?.push(line);
  }
  const out: Partial<WritingTemplates> = {};
  const missing: string[] = [];
  for (const id of WRITING_TEMPLATE_IDS) {
    const lines = sections.get(id);
    if (lines === undefined) missing.push(id);
    else out[id] = lines.join('\n').trim();
  }
  if (missing.length > 0) throw new Error(`写作提示词模板缺少小节：${missing.join(', ')}`);
  return out as WritingTemplates;
}

/** `{{name}}` 占位符替换；未提供的名字原样保留（便于发现模板写错） */
export function renderWritingTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}
