/**
 * 长篇写作的上下文组装（M7 契约 §2）。
 *
 * 纯函数：输入项目 / 章节 / 光标 / 圣经世界书，输出 `PromptIR` 与给前端「上下文」面板看的报告。
 * 段落按稳定性分层、**顺序本身就是缓存友好的**：
 *
 * | # | 段 id | stability | role |
 * | - | ----- | --------- | ---- |
 * | 1 | `writing:system` 写作系统提示词 | static | system |
 * | 2 | `writing:global-system` 全局系统提示词 | static | system |
 * | 3 | `writing:style` 风格指南 | static | system |
 * | 4 | `writing:bible-constant` 圣经常驻条目 | static | system |
 * | 5 | `writing:outline` 大纲 | static | system |
 * | 6 | `writing:summaries` 已完成章节摘要 | session | system |
 * | 7 | `writing:chapter` 当前章正文（光标前） | history | user |
 * | 8 | `writing:bible-triggered` 触发的圣经条目 | turn | user |
 * | 8½ | `writing:references` @引用 | turn | user |
 * | 9 | `writing:action` 动作指令 | turn | user |
 *
 * 空段不输出；段 id 不随内容变化（便于缓存命中统计与检查器 diff）。
 * 1–6 用 system（Anthropic 这类把 system 抽到顶层的提供商会整体抽走，断点落在 system 块上），
 * 7 起用 user：留在消息里，续写时正文只在末尾增长，前缀自动缓存（prefix-auto）也能吃到正文部分。
 *
 * 布局复用 M3 的布局器：cache-aware → `layoutCacheAware`（static 末尾 + session 末尾两个断点），
 * strict → `layoutStrict`。7–9 的锚点都在 history 槽、深度 0，布局器不会搬动它们。
 */

import { type PromptIR, type Segment, type WIActivationSummary } from '../prompt/ir.js';
import {
  layoutCacheAware,
  layoutStrict,
  resolveLayoutPolicy,
  type LayoutBreakpoint,
  type LayoutProviderCaps,
} from '../prompt/layout/index.js';
import { scanWorldInfo } from '../worldinfo/engine.js';
import { type WIActivation, type WIBook, type WISettings } from '../worldinfo/types.js';
import {
  renderWritingTemplate,
  type WritingTemplateId,
  type WritingTemplates,
} from './templates.js';

export type WritingAction = 'continue' | 'rewrite' | 'expand' | 'condense' | 'summarize' | 'custom';

export const WRITING_ACTIONS: readonly WritingAction[] = [
  'continue',
  'rewrite',
  'expand',
  'condense',
  'summarize',
  'custom',
];

/** 需要选区的动作（custom 有无选区都行） */
export const WRITING_SELECTION_ACTIONS: readonly WritingAction[] = [
  'rewrite',
  'expand',
  'condense',
];

/** 圣经扫描窗口：光标前最后这么多个字符（契约 §2 第 8 段「~2000 字」） */
export const WRITING_SCAN_WINDOW = 2000;
/** 光标后的衔接参考只取前这么多个字符 */
export const WRITING_AFTER_SNIPPET = 300;
/** @引用 最多几个 */
export const WRITING_MAX_REFERENCES = 3;
/** 当前章正文至少保留剩余预算的这个比例（不超过其实际长度） */
export const WRITING_CHAPTER_MIN_SHARE = 0.4;
/** 续写的缺省目标长度：中文按字、英文按词 */
export const DEFAULT_WRITING_TARGET_LENGTH: Record<'zh-CN' | 'en', number> = {
  'zh-CN': 400,
  en: 300,
};

export const WRITING_SEGMENT_IDS = {
  system: 'writing:system',
  globalSystem: 'writing:global-system',
  style: 'writing:style',
  bibleConstant: 'writing:bible-constant',
  outline: 'writing:outline',
  summaries: 'writing:summaries',
  chapter: 'writing:chapter',
  bibleTriggered: 'writing:bible-triggered',
  references: 'writing:references',
  action: 'writing:action',
} as const;

export type WritingSegmentKind = keyof typeof WRITING_SEGMENT_IDS;

export interface WritingChapterInput {
  id: string;
  title: string;
  order: number;
  summary: string;
  /** 摘要生成后正文又改过（契约外补充：report 要列出过期摘要，需要这一位） */
  summaryStale?: boolean;
  done: boolean;
  text: string;
}

/** 笔记：只在被 @引用 时进上下文（§2.2） */
export interface WritingNoteInput {
  id: string;
  title: string;
  text: string;
}

export interface WritingAssembleInput {
  project: {
    id: string;
    title: string;
    styleGuide: string;
    systemPrompt?: string;
    outline: string;
    language: 'zh-CN' | 'en';
  };
  /** 全部章节（按 order） */
  chapters: WritingChapterInput[];
  /** 光标 / 选区；`selection` 是选中的文本 */
  current: { id: string; textBefore: string; selection?: string; textAfter?: string };
  action: WritingAction;
  instruction?: string;
  /** 圣经世界书（已转成 WI 引擎的形态） */
  bible: WIBook[];
  wiSettings: WISettings;
  globalSystemPrompt?: string | null;
  model: string;
  providerCaps: LayoutProviderCaps;
  layoutMode: 'strict' | 'cache-aware';
  /** token 预算 */
  budget: number;
  countTokens: (text: string) => number;
  /** 所选语言的提示词模板（`parseWritingTemplates(writing.<lang>.md)`；core 不读文件） */
  templates: WritingTemplates;
  /** 项目里的笔记（@引用 用）；缺省 = 没有笔记 */
  notes?: WritingNoteInput[];
  /** 续写目标长度（中文字 / 英文词）；缺省按语言取 400 / 300 */
  targetLength?: number;
}

export interface WritingReportSegment {
  id: string;
  kind: WritingSegmentKind;
  stability: Segment['stability'];
  role: Segment['role'];
  tokens: number;
}

export interface WritingReportSummary {
  chapterId: string;
  title: string;
  /** 章节序号（从 1 起，按 order） */
  n: number;
  tokens: number;
  stale: boolean;
}

export interface WritingReportBibleEntry {
  entryId: string;
  bookId: string;
  bookName?: string;
  comment?: string;
  reason: WIActivation['reason'];
  matchedKeys: string[];
  tokens: number;
  /** constant 进 static 段 4；其余进 turn 段 8 */
  placement: 'static' | 'turn';
}

export interface WritingReportReference {
  /** 指令里的原文，如 `@人物表`、`@第3章` */
  token: string;
  kind: 'note' | 'chapter';
  id: string;
  title: string;
  /** chapter：用的是摘要还是正文（无摘要时退回正文开头） */
  source: 'note' | 'summary' | 'text';
  tokens: number;
  truncated: boolean;
}

export interface WritingContextReport {
  action: WritingAction;
  layoutMode: 'strict' | 'cache-aware';
  budget: number;
  totalTokens: number;
  segments: WritingReportSegment[];
  /** 当前章正文被截断的情况（从前面截） */
  chapterTruncation: { originalTokens: number; keptTokens: number; droppedChars: number } | null;
  /** 进了上下文的摘要（按章节顺序） */
  summaries: WritingReportSummary[];
  /** 因预算被丢弃的摘要（从最早的章节开始丢） */
  droppedSummaries: WritingReportSummary[];
  /** 用上了但已过期的摘要（正文在摘要生成后又改过） */
  staleSummaries: WritingReportSummary[];
  /** 已完成但还没有摘要的章节（当前章之前） */
  missingSummaries: { chapterId: string; title: string; n: number }[];
  bible: WritingReportBibleEntry[];
  /** 圣经扫描实际用的文本长度（字符）：光标前窗口 + 选区 + 指令 */
  scanChars: number;
  references: WritingReportReference[];
  breakpoints: LayoutBreakpoint[];
  estimatedCacheablePrefixTokens: number;
  warnings: string[];
}

export interface WritingAssembleResult {
  ir: PromptIR;
  report: WritingContextReport;
}

interface Draft {
  kind: WritingSegmentKind;
  role: Segment['role'];
  stability: Segment['stability'];
  origin: Segment['origin'];
  slot: 'system' | 'history';
  text: string;
}

const ORIGINS: Record<WritingSegmentKind, Segment['origin']> = {
  system: { kind: 'preset', ref: 'writing-system' },
  globalSystem: { kind: 'global_system' },
  style: { kind: 'preset', ref: 'writing-style' },
  bibleConstant: { kind: 'worldinfo', ref: 'writing-bible-constant' },
  outline: { kind: 'preset', ref: 'writing-outline' },
  // 摘要用 injection 而不是 history：布局器把 history / user_input 当历史消息，会据此放第三个断点
  summaries: { kind: 'injection', ref: 'writing-summaries' },
  chapter: { kind: 'history', ref: 'writing-chapter' },
  bibleTriggered: { kind: 'worldinfo', ref: 'writing-bible-triggered' },
  references: { kind: 'injection', ref: 'writing-references' },
  action: { kind: 'user_input', ref: 'writing-action' },
};

const nonEmpty = (text: string | undefined | null): text is string =>
  typeof text === 'string' && text.trim() !== '';

/** 按 order 升序（稳定）：order 小的在前，与 ST 同一位置桶里的最终先后一致 */
function byOrderAsc(list: readonly WIActivation[]): WIActivation[] {
  return list
    .map((activation, index) => ({ activation, index }))
    .sort((a, b) => a.activation.entry.order - b.activation.entry.order || a.index - b.index)
    .map((item) => item.activation);
}

/** 把下标挪到不拆开代理对的位置 */
function safeIndex(text: string, index: number): number {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index;
}

/** 末尾 `n` 个字符（不拆代理对） */
export function tailChars(text: string, n: number): string {
  if (text.length <= n) return text;
  return text.slice(safeIndex(text, text.length - n));
}

/** 开头 `n` 个字符（不拆代理对） */
function headChars(text: string, n: number): string {
  if (text.length <= n) return text;
  const code = text.charCodeAt(n - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? n - 1 : n);
}

/**
 * 从**前面**截掉 `text`，使 `wrap(剩余)` 的 token 数不超过 `allowance`。
 * 二分找最小的起点，然后尽量对齐到下一个换行（在 200 字符之内时），避免从半句开始。
 */
function truncateFront(
  text: string,
  allowance: number,
  wrap: (rest: string) => string,
  countTokens: (text: string) => number,
): { start: number; rendered: string } {
  const fits = (start: number) => countTokens(wrap(text.slice(start))) <= allowance;
  if (fits(0)) return { start: 0, rendered: wrap(text) };
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid;
    else lo = mid + 1;
  }
  let start = safeIndex(text, lo);
  const newline = text.indexOf('\n', start);
  if (newline >= 0 && newline - start <= 200 && newline + 1 < text.length) start = newline + 1;
  return { start, rendered: wrap(text.slice(start)) };
}

/** 从**后面**截掉（引用用：保留开头），截断处加省略号 */
function truncateBack(
  text: string,
  allowance: number,
  countTokens: (text: string) => number,
): { text: string; truncated: boolean } {
  if (countTokens(text) <= allowance) return { text, truncated: false };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (countTokens(`${headChars(text, mid)}…`) <= allowance) lo = mid;
    else hi = mid - 1;
  }
  return { text: `${headChars(text, lo)}…`, truncated: true };
}

const CN_DIGITS: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

/** 「十二」「一百零三」「３」「12」→ 数字；认不出返回 null */
export function parseChapterNumber(raw: string): number | null {
  const ascii = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/^\d+$/.test(ascii)) return Number(ascii);
  let total = 0;
  let digit = 0;
  let seen = false;
  for (const ch of ascii) {
    if (ch in CN_DIGITS) {
      digit = CN_DIGITS[ch] ?? 0;
      seen = true;
    } else if (ch === '十') {
      total += (seen ? digit : 1) * 10;
      digit = 0;
      seen = false;
    } else if (ch === '百') {
      total += (seen ? digit : 1) * 100;
      digit = 0;
      seen = false;
    } else {
      return null;
    }
  }
  const value = total + digit;
  return value > 0 ? value : null;
}

const CHAPTER_REF =
  /@(?:第\s*([0-9０-９零〇一二两三四五六七八九十百]+)\s*章|(?:chapter|ch\.?)\s*(\d+))/giu;

interface ParsedReference {
  token: string;
  kind: 'note' | 'chapter';
  index: number;
  chapterNumber?: number;
  noteId?: string;
}

/** 解析指令里的 `@笔记标题` / `@第N章` / `@Chapter N`（按出现顺序，去重） */
export function parseWritingReferences(
  instruction: string,
  notes: readonly WritingNoteInput[],
): ParsedReference[] {
  const found: ParsedReference[] = [];
  const covered = new Set<number>();
  for (const match of instruction.matchAll(CHAPTER_REF)) {
    const raw = match[1] ?? match[2] ?? '';
    const n = parseChapterNumber(raw);
    covered.add(match.index);
    if (n === null) continue;
    found.push({ token: match[0], kind: 'chapter', index: match.index, chapterNumber: n });
  }
  // 笔记：同一个 @ 后面能匹配多个标题时取最长的
  const titled = notes
    .filter((note) => note.title.trim() !== '')
    .sort((a, b) => b.title.length - a.title.length);
  for (let i = instruction.indexOf('@'); i >= 0; i = instruction.indexOf('@', i + 1)) {
    if (covered.has(i)) continue;
    const note = titled.find((item) => instruction.startsWith(item.title, i + 1));
    if (note) found.push({ token: `@${note.title}`, kind: 'note', index: i, noteId: note.id });
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  return found.filter((ref) => {
    const key = ref.kind === 'note' ? `note:${ref.noteId}` : `chapter:${ref.chapterNumber}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function assembleWriting(input: WritingAssembleInput): WritingAssembleResult {
  const { templates: t, countTokens } = input;
  const lang = input.project.language;
  const warnings: string[] = [];
  const render = (id: WritingTemplateId, vars: Record<string, string | number> = {}) =>
    renderWritingTemplate(t[id], vars);
  const tokensOf = (text: string) => (text === '' ? 0 : countTokens(text));

  const chapters = [...input.chapters].sort((a, b) => a.order - b.order);
  const chapterIndex = chapters.findIndex((chapter) => chapter.id === input.current.id);
  const currentChapter = chapterIndex >= 0 ? chapters[chapterIndex] : undefined;
  const currentNote = (input.notes ?? []).find((note) => note.id === input.current.id);
  const currentTitle = currentChapter?.title ?? currentNote?.title ?? '';
  const instruction = input.instruction?.trim() ?? '';
  const selection = input.current.selection ?? '';
  const usesSelection = input.action !== 'continue' && input.action !== 'summarize';

  if (WRITING_SELECTION_ACTIONS.includes(input.action) && !nonEmpty(selection)) {
    warnings.push(`动作「${input.action}」需要选区，但选区为空`);
  }
  if (input.action === 'custom' && instruction === '') {
    warnings.push('自定义动作没有给出指令');
  }

  // ── 圣经扫描：只扫光标前末尾窗口 + 选区 + 指令
  const scanParts = [tailChars(input.current.textBefore, WRITING_SCAN_WINDOW)];
  if (usesSelection && nonEmpty(selection)) scanParts.push(selection);
  if (instruction !== '') scanParts.push(instruction);
  const scanText = scanParts.filter((part) => part !== '').join('\n');
  const scan =
    input.bible.length > 0
      ? scanWorldInfo({
          books: input.bible,
          // 扫描缓冲只有一条「消息」，扫描深度至少要 1 才扫得到它
          settings: { ...input.wiSettings, scanDepth: Math.max(1, input.wiSettings.scanDepth) },
          history: scanText === '' ? [] : [{ role: 'user', text: scanText }],
          globalScan: {},
          state: null,
          messageCount: 1,
          substitute: (text) => text,
          // 概率条目一律按「命中」处理：同样的输入必须得到同样的上下文（缓存与检查器预览一致）
          random: () => 0,
          countTokens,
          dryRun: true,
        })
      : null;
  if (scan) warnings.push(...scan.warnings);
  const activations = scan?.activations ?? [];
  const constants = byOrderAsc(activations.filter((a) => a.reason === 'constant'));
  const triggered = byOrderAsc(activations.filter((a) => a.reason !== 'constant'));
  const entryText = (list: readonly WIActivation[]) =>
    list
      .map((a) => a.content)
      .filter(nonEmpty)
      .join('\n\n');

  // ── 固定段 1–5
  const drafts: Partial<Record<WritingSegmentKind, Draft>> = {};
  const put = (
    kind: WritingSegmentKind,
    text: string,
    stability: Segment['stability'],
    role: Segment['role'],
    slot: 'system' | 'history',
  ) => {
    drafts[kind] = { kind, role, stability, origin: ORIGINS[kind], slot, text };
  };

  const systemText = nonEmpty(input.project.systemPrompt)
    ? input.project.systemPrompt
    : render('system', { projectTitle: input.project.title });
  put('system', systemText, 'static', 'system', 'system');
  if (nonEmpty(input.globalSystemPrompt)) {
    put('globalSystem', input.globalSystemPrompt, 'static', 'system', 'system');
  }
  if (nonEmpty(input.project.styleGuide)) {
    put(
      'style',
      render('label.style', { text: input.project.styleGuide.trim() }),
      'static',
      'system',
      'system',
    );
  }
  const constantText = entryText(constants);
  if (constantText !== '') {
    put(
      'bibleConstant',
      render('label.bible', { text: constantText }),
      'static',
      'system',
      'system',
    );
  }
  if (nonEmpty(input.project.outline)) {
    put(
      'outline',
      render('label.outline', { text: input.project.outline.trim() }),
      'static',
      'system',
      'system',
    );
  }

  // ── 8：触发的圣经条目
  const triggeredText = entryText(triggered);
  if (triggeredText !== '') {
    put(
      'bibleTriggered',
      render('label.triggered', { text: triggeredText }),
      'turn',
      'user',
      'history',
    );
  }

  // ── 9：动作指令
  const targetLength =
    input.targetLength && input.targetLength > 0
      ? Math.round(input.targetLength)
      : DEFAULT_WRITING_TARGET_LENGTH[lang];
  const actionBlocks: string[] = [];
  if (usesSelection && nonEmpty(selection)) {
    actionBlocks.push(render('block.selection', { text: selection }));
  }
  const after = input.current.textAfter ?? '';
  if (input.action !== 'summarize' && nonEmpty(after)) {
    actionBlocks.push(render('block.after', { text: headChars(after, WRITING_AFTER_SNIPPET) }));
  }
  if (instruction !== '') actionBlocks.push(render('block.instruction', { text: instruction }));
  actionBlocks.push(render(`action.${input.action}` as const, { targetLength }));
  put('action', actionBlocks.join('\n\n'), 'turn', 'user', 'history');

  // ── 8½：@引用（最多 3 个；每个不超过预算的 10%）
  const references: WritingReportReference[] = [];
  if (instruction !== '') {
    const parsed = parseWritingReferences(instruction, input.notes ?? []);
    if (parsed.length > WRITING_MAX_REFERENCES) {
      warnings.push(
        `指令里的 @引用 超过 ${WRITING_MAX_REFERENCES} 个，只取前 ${WRITING_MAX_REFERENCES} 个`,
      );
    }
    const perRef = Math.max(200, Math.floor(input.budget * 0.1));
    const blocks: string[] = [];
    for (const ref of parsed.slice(0, WRITING_MAX_REFERENCES)) {
      if (ref.kind === 'note') {
        const note = (input.notes ?? []).find((item) => item.id === ref.noteId);
        if (!note) continue;
        const cut = truncateBack(note.text, perRef, countTokens);
        const block = render('label.reference-note', { title: note.title, text: cut.text });
        blocks.push(block);
        references.push({
          token: ref.token,
          kind: 'note',
          id: note.id,
          title: note.title,
          source: 'note',
          tokens: tokensOf(block),
          truncated: cut.truncated,
        });
      } else {
        const n = ref.chapterNumber ?? 0;
        const chapter = chapters[n - 1];
        if (!chapter) {
          warnings.push(`引用 ${ref.token} 找不到对应章节`);
          continue;
        }
        const useSummary = nonEmpty(chapter.summary);
        const cut = truncateBack(useSummary ? chapter.summary : chapter.text, perRef, countTokens);
        const block = render('label.reference-chapter', {
          n,
          title: chapter.title,
          text: cut.text,
        });
        blocks.push(block);
        references.push({
          token: ref.token,
          kind: 'chapter',
          id: chapter.id,
          title: chapter.title,
          source: useSummary ? 'summary' : 'text',
          tokens: tokensOf(block),
          truncated: cut.truncated,
        });
      }
    }
    if (blocks.length > 0) put('references', blocks.join('\n\n'), 'turn', 'user', 'history');
  }

  // ── 预算：先保证 1–5、8、9（与引用），剩余给 6 与 7，7 优先
  const fixedKinds: WritingSegmentKind[] = [
    'system',
    'globalSystem',
    'style',
    'bibleConstant',
    'outline',
    'bibleTriggered',
    'references',
    'action',
  ];
  const fixedTokens = fixedKinds.reduce((sum, kind) => sum + tokensOf(drafts[kind]?.text ?? ''), 0);
  if (fixedTokens > input.budget) {
    warnings.push(
      `系统提示词、风格指南、设定、大纲与指令合计约 ${fixedTokens} token，已超出预算 ${input.budget}`,
    );
  }
  const remaining = Math.max(0, input.budget - fixedTokens);

  // 7 的完整形态
  const textBefore = input.current.textBefore;
  const truncatedMarker = render('label.truncated');
  const wrapChapter = (rest: string, cut: boolean) =>
    rest.trim() === '' && !cut
      ? render('label.chapter-empty', { title: currentTitle })
      : render('label.chapter', {
          title: currentTitle,
          text: cut ? `${truncatedMarker}\n${rest}` : rest,
        });
  const chapterFull = wrapChapter(textBefore, false);
  const chapterFullTokens = tokensOf(chapterFull);
  const chapterReserve = Math.min(
    Math.ceil(remaining * WRITING_CHAPTER_MIN_SHARE),
    chapterFullTokens,
  );

  // 6：当前章之前、已完成且有摘要的章节；超预算从最早的开始丢
  const upTo = currentChapter ? chapterIndex : chapters.length;
  const summaryCandidates: (WritingReportSummary & { line: string })[] = [];
  const missingSummaries: WritingContextReport['missingSummaries'] = [];
  chapters.slice(0, upTo).forEach((chapter, index) => {
    if (!chapter.done) return;
    const n = index + 1;
    if (!nonEmpty(chapter.summary)) {
      missingSummaries.push({ chapterId: chapter.id, title: chapter.title, n });
      return;
    }
    const line = render('label.summary-item', {
      n,
      title: chapter.title,
      summary: chapter.summary.trim(),
    });
    summaryCandidates.push({
      chapterId: chapter.id,
      title: chapter.title,
      n,
      tokens: tokensOf(line),
      stale: chapter.summaryStale === true,
      line,
    });
  });
  const summaryAllowance = Math.max(0, remaining - chapterReserve);
  const renderSummaries = (list: readonly { line: string }[]) =>
    list.length === 0
      ? ''
      : render('label.summaries', { text: list.map((s) => s.line).join('\n') });
  let kept = summaryCandidates;
  const droppedSummaries: WritingReportSummary[] = [];
  while (kept.length > 0 && tokensOf(renderSummaries(kept)) > summaryAllowance) {
    const [first, ...rest] = kept;
    if (first) droppedSummaries.push(stripLine(first));
    kept = rest;
  }
  const summariesText = renderSummaries(kept);
  if (summariesText !== '') put('summaries', summariesText, 'session', 'system', 'system');
  if (droppedSummaries.length > 0) {
    warnings.push(`预算不足，丢弃了最早 ${droppedSummaries.length} 章的摘要`);
  }

  // 7：剩下的都给当前章正文，超了从前面截
  const chapterAllowance = Math.max(0, remaining - tokensOf(summariesText));
  let chapterText = chapterFull;
  let chapterTruncation: WritingContextReport['chapterTruncation'] = null;
  if (chapterFullTokens > chapterAllowance) {
    const cut = truncateFront(
      textBefore,
      chapterAllowance,
      (rest) => wrapChapter(rest, true),
      countTokens,
    );
    chapterText = cut.rendered;
    chapterTruncation = {
      originalTokens: chapterFullTokens,
      keptTokens: tokensOf(chapterText),
      droppedChars: cut.start,
    };
    warnings.push(`当前章正文超出预算，已从开头截掉 ${cut.start} 个字符`);
  }
  put('chapter', chapterText, 'history', 'user', 'history');

  // ── 段落（固定顺序）
  const ORDER: WritingSegmentKind[] = [
    'system',
    'globalSystem',
    'style',
    'bibleConstant',
    'outline',
    'summaries',
    'chapter',
    'bibleTriggered',
    'references',
    'action',
  ];
  const segments: Segment[] = [];
  for (const kind of ORDER) {
    const draft = drafts[kind];
    if (!draft || draft.text === '') continue;
    segments.push({
      id: WRITING_SEGMENT_IDS[kind],
      role: draft.role,
      parts: [{ type: 'text', text: draft.text }],
      origin: draft.origin,
      anchor:
        draft.slot === 'system'
          ? { slot: 'system', order: segments.length }
          : { slot: 'history', depth: 0, order: segments.length },
      stability: draft.stability,
    });
  }

  // ── 布局
  const layoutCtx = {
    providerCaps: input.providerCaps,
    policy: resolveLayoutPolicy({ volatileHandling: 'warn' }),
    countTokens,
  };
  const layout =
    input.layoutMode === 'cache-aware'
      ? layoutCacheAware(segments, layoutCtx)
      : layoutStrict(segments, layoutCtx);
  warnings.push(...layout.report.warnings);

  const kindById = new Map(
    (Object.keys(WRITING_SEGMENT_IDS) as WritingSegmentKind[]).map((kind) => [
      WRITING_SEGMENT_IDS[kind] as string,
      kind,
    ]),
  );
  const reportSegments: WritingReportSegment[] = layout.segments.map((segment) => ({
    id: segment.id,
    kind: kindById.get(segment.id) ?? 'action',
    stability: segment.stability,
    role: segment.role,
    tokens: tokensOf(segment.parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n')),
  }));
  const totalTokens = reportSegments.reduce((sum, s) => sum + s.tokens, 0);

  const activationSummaries: WIActivationSummary[] = [...constants, ...triggered].map((a) => ({
    entryId: a.entry.id,
    bookId: a.entry.bookId,
    position: a.entry.position,
    ...(a.entry.depth === undefined ? {} : { depth: a.entry.depth }),
    role: 'system',
    order: a.entry.order,
  }));

  const bible: WritingReportBibleEntry[] = [...constants, ...triggered].map((a) => ({
    entryId: a.entry.id,
    bookId: a.entry.bookId,
    ...(a.entry.source?.bookName ? { bookName: a.entry.source.bookName } : {}),
    ...(a.entry.comment ? { comment: a.entry.comment } : {}),
    reason: a.reason,
    matchedKeys: a.matchedKeys,
    tokens: a.tokens,
    placement: a.reason === 'constant' ? 'static' : 'turn',
  }));

  const summaries = kept.map(stripLine);
  const ir: PromptIR = {
    model: input.model,
    sampling: {},
    segments: layout.segments,
    cachePlan: layout.cachePlan,
    meta: {
      chatId: `writing:${input.project.id}`,
      presetId: '',
      layoutMode: input.layoutMode,
      activations: activationSummaries,
      warnings,
      tokenEstimate: totalTokens,
    },
  };

  return {
    ir,
    report: {
      action: input.action,
      layoutMode: input.layoutMode,
      budget: input.budget,
      totalTokens,
      segments: reportSegments,
      chapterTruncation,
      summaries,
      droppedSummaries,
      staleSummaries: summaries.filter((s) => s.stale),
      missingSummaries,
      bible,
      scanChars: scanText.length,
      references,
      breakpoints: layout.report.breakpoints,
      estimatedCacheablePrefixTokens: layout.report.estimatedCacheablePrefixTokens,
      warnings,
    },
  };
}

function stripLine(item: WritingReportSummary & { line: string }): WritingReportSummary {
  return {
    chapterId: item.chapterId,
    title: item.title,
    n: item.n,
    tokens: item.tokens,
    stale: item.stale,
  };
}
