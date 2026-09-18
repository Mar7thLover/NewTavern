/**
 * 正文块识别（主题无关）。
 *
 * 预设让模型输出的「状态栏 / 思考 / 选项 / 摘要 / 旁白 / 场外话 / 变量更新」有几十种写法，
 * 但结构只有那么几种。这一层只负责**认出结构**，把它们改写成一套统一的语义标记：
 *
 *   <div data-nt-block="status">…</div>
 *
 * 长什么样由各个世界自己的 `themes/<id>/blocks.css` 决定（见 themes/README.md §10）。
 * 引擎不产出任何颜色、边框、圆角——只产出结构。识别逻辑只写一遍，六个世界各写各的皮肤。
 *
 * 只在**显示侧**跑：存档与提示词里始终是原文。输出会经过 Markdown 与净化白名单
 * （`apps/web/src/features/chat/html`），所以这里可以放心吐 HTML。
 */

/** 语义类型。`data` = 变量更新之类的机器指令，默认折叠。 */
export type RichBlockKind = 'think' | 'status' | 'ooc' | 'options' | 'summary' | 'aside' | 'data';

export const RICH_BLOCK_KINDS: readonly RichBlockKind[] = [
  'think',
  'status',
  'ooc',
  'options',
  'summary',
  'aside',
  'data',
];

/**
 * 标签名 → 语义类型。故意收得很紧：只认预设里真正常见的写法。
 * `<note>` `<panel>` `<action>` 这类过于通用的词不收，避免把卡自带的前端标签吃掉。
 */
const TAG_KIND = new Map<string, RichBlockKind>([
  ['thinking', 'think'],
  ['think', 'think'],
  ['thought', 'think'],
  ['thoughts', 'think'],
  ['reasoning', 'think'],
  ['思考', 'think'],
  ['思维', 'think'],
  ['思维链', 'think'],
  ['内心', 'think'],
  ['内心独白', 'think'],
  ['心声', 'think'],

  ['status', 'status'],
  ['statusbar', 'status'],
  ['status_bar', 'status'],
  ['statusbox', 'status'],
  ['状态', 'status'],
  ['状态栏', 'status'],
  ['状态面板', 'status'],
  ['属性栏', 'status'],
  ['数值栏', 'status'],

  ['ooc', 'ooc'],
  ['场外', 'ooc'],
  ['作者的话', 'ooc'],
  ['旁注', 'ooc'],

  ['options', 'options'],
  ['choices', 'options'],
  ['选项', 'options'],
  ['行动选项', 'options'],
  ['分支选项', 'options'],

  ['summary', 'summary'],
  ['recap', 'summary'],
  ['摘要', 'summary'],
  ['总结', 'summary'],
  ['记忆', 'summary'],
  ['回顾', 'summary'],

  ['aside', 'aside'],
  ['narration', 'aside'],
  ['旁白', 'aside'],
  ['场景描述', 'aside'],

  ['updatevariable', 'data'],
  ['update_variable', 'data'],
  ['variables', 'data'],
  ['mvu', 'data'],
  ['变量更新', 'data'],
]);

/** 独占一行的方括号小标题：`【状态】` / `[选项]`。比标签更容易误伤，收得更紧。 */
const BRACKET_KIND = new Map<string, RichBlockKind>([
  ['状态', 'status'],
  ['状态栏', 'status'],
  ['属性', 'status'],
  ['数值', 'status'],
  ['面板', 'status'],
  ['status', 'status'],
  ['stats', 'status'],

  ['选项', 'options'],
  ['行动', 'options'],
  ['行动选项', 'options'],
  ['options', 'options'],
  ['choices', 'options'],

  ['摘要', 'summary'],
  ['总结', 'summary'],
  ['记忆', 'summary'],
  ['summary', 'summary'],

  ['思考', 'think'],
  ['内心', 'think'],
  ['心声', 'think'],

  ['旁白', 'aside'],
  ['场景', 'aside'],
]);

export interface RichTextOptions {
  /** 各类型的默认标题（走 i18n）。源里自带中文标签时用源里的。 */
  labels?: Partial<Record<RichBlockKind, string>>;
  /** 不识别这些类型 */
  disabled?: readonly RichBlockKind[];
  /**
   * 关掉「渲染卡自带的 HTML 前端」时传 true：识别之外的原文一律转义，
   * 于是页面上只有我们自己生成的那点标记是活的。
   */
  escapeSource?: boolean;
}

/** 原文的转义策略：`escapeSource` 决定它是转义还是原样放行 */
type Escape = (value: string) => string;

const passThrough: Escape = (value) => value;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 属性值：只会放我们自己的标签名与标题，仍然按属性规则转义 */
function attr(value: string): string {
  return escapeHtml(value).replace(/\s+/g, ' ').trim();
}

/** 长的先排：正则的 `|` 是有序的，`状态栏` 必须排在 `状态` 前面 */
function alternation(keys: Iterable<string>): string {
  return [...keys]
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join('|');
}

const TAG_PATTERN = alternation(TAG_KIND.keys());
const BRACKET_PATTERN = alternation(BRACKET_KIND.keys());

/**
 * 不能动的区域：围栏代码、行内代码，以及卡自带前端里的 `pre/code/style/script`。
 * 落在这些区间里的候选一律跳过。
 */
const PROTECTED_RE =
  /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]*`|<(pre|code|style|script)\b[\s\S]*?(?:<\/\1\s*>|$)/gi;

function protectedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  PROTECTED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PROTECTED_RE.exec(text)) !== null) {
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

function overlaps(ranges: readonly [number, number][], start: number, end: number): boolean {
  return ranges.some(([from, to]) => start < to && end > from);
}

/* ------------------------------------------------------------------ */
/* 内容解析：状态行与选项行                                            */
/* ------------------------------------------------------------------ */

/** 条状进度的字符对：实心 / 空心 */
const BAR_PAIRS: readonly (readonly [string, string])[] = [
  ['★', '☆'],
  ['●', '○'],
  ['■', '□'],
  ['▰', '▱'],
  ['♥', '♡'],
  ['◆', '◇'],
  ['█', '░'],
];

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function countChar(text: string, char: string): number {
  let count = 0;
  for (const item of text) if (item === char) count++;
  return count;
}

/** 从值里读出 0–1 的比例：`60/100`、`60%`、`★★★☆☆`。读不出返回 null。 */
export function meterRatio(value: string): number | null {
  const fraction = /(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/.exec(value);
  if (fraction) {
    const total = Number(fraction[2]);
    if (total > 0) return clamp01(Number(fraction[1]) / total);
  }
  const percent = /(-?\d+(?:\.\d+)?)\s*[%％]/.exec(value);
  if (percent) return clamp01(Number(percent[1]) / 100);
  for (const [full, empty] of BAR_PAIRS) {
    const filled = countChar(value, full);
    const blank = countChar(value, empty);
    if (filled + blank > 0) return clamp01(filled / (filled + blank));
  }
  return null;
}

/** 表格分隔行 `|---|:--:|` */
function isTableRule(line: string): boolean {
  return /^\s*\|?[\s:|-]*\|[\s:|-]*$/.test(line) && line.includes('-');
}

interface StatusRow {
  key: string | null;
  value: string;
}

/** 一行 → 若干个「键值」。认冒号、Markdown 表格行，以及一行里用 `|` 并排的多组。 */
function statusRows(line: string): StatusRow[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  // Markdown 表格行：第一格是键，其余合成值
  if (trimmed.startsWith('|') && trimmed.endsWith('|') && !isTableRule(trimmed)) {
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length >= 2) return [{ key: cells[0] ?? '', value: cells.slice(1).join(' · ') }];
    return [{ key: null, value: cells.join(' ') }];
  }

  // 一行里并排多组：`时间：黄昏 | 地点：酒馆`（每段都得有冒号才算）
  const parts = trimmed.split(/\s*[|｜]\s*/).filter(Boolean);
  if (parts.length > 1 && parts.every((part) => /[:：]/.test(part))) {
    return parts.flatMap((part) => statusRows(part));
  }

  const pair = /^\s*(?:[-*•]\s*)?[【[]?([^:：【\][】]{1,24}?)[\]】]?\s*[:：]\s*(.*)$/.exec(trimmed);
  const key = pair?.[1]?.trim();
  if (key) return [{ key, value: (pair?.[2] ?? '').trim() }];
  return [{ key: null, value: trimmed.replace(/^\s*[-*•]\s*/, '') }];
}

function renderStatusBody(body: string, esc: Escape): string {
  const rows: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.trim() || isTableRule(line)) continue;
    for (const row of statusRows(line)) {
      if (row.key === null && !row.value) continue;
      const ratio = meterRatio(row.value);
      // 数值条是独立的一小段轨道：主题拿它当刻度 / 水位 / 糖条都行，不用去算文字宽度
      const track =
        ratio === null
          ? ''
          : `<span data-nt-part="meter" aria-hidden="true"><span data-nt-part="meter-fill"></span></span>`;
      const meterAttrs =
        ratio === null ? '' : ` data-nt-meter="" style="--nt-meter:${ratio.toFixed(4)}"`;
      const key = row.key === null ? '' : `<span data-nt-part="key">${esc(row.key)}</span>`;
      rows.push(
        `<div data-nt-part="row"${row.key === null ? ' data-nt-plain=""' : ''}>` +
          key +
          `<span data-nt-part="value"${meterAttrs}>` +
          track +
          `<span data-nt-part="value-text">${esc(row.value)}</span>` +
          `</span></div>`,
      );
    }
  }
  return rows.join('');
}

/** `1. 去酒馆` / `A) 留下` / `- 离开` → 序号 + 正文 */
const OPTION_RE =
  /^\s*(?:[-*•]|[(（]?(\d{1,2}|[A-Za-z]|[一二三四五六七八九十]{1,3})[)）.、．:：]?)\s*(.*)$/;

function renderOptionsBody(body: string, esc: Escape): string {
  const items: string[] = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = OPTION_RE.exec(trimmed);
    const marker = match?.[1] ?? String(items.length + 1);
    const text = (match?.[2] ?? '').trim() || trimmed;
    items.push(
      `<li data-nt-part="option" data-nt-marker="${attr(marker)}">` +
        `<span data-nt-part="marker">${attr(marker)}</span>` +
        `<span data-nt-part="option-text">${esc(text)}</span>` +
        `</li>`,
    );
  }
  if (items.length === 0) return '';
  return `<ol data-nt-part="body">${items.join('')}</ol>`;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function titleOf(
  kind: RichBlockKind,
  explicit: string | null,
  labels: RichTextOptions['labels'],
): string {
  const text = explicit ?? labels?.[kind] ?? kind;
  return `<div data-nt-part="title">${attr(text)}</div>`;
}

/**
 * 正文要继续吃 Markdown 的类型（思考、场外、旁白、摘要）用「空行式」：
 * `<div …>` 独占一段 → 空行 → 正文按 Markdown 解析 → 空行 → `</div>`。
 * 这是 CommonMark 的 HTML 块规则，rehype-raw 会把三段重新拼回一棵树。
 */
function wrapProse(kind: RichBlockKind, head: string, body: string): string {
  return (
    `\n\n<div data-nt-block="${kind}">${head}<div data-nt-part="body">\n\n` +
    `${body.trim()}\n\n</div></div>\n\n`
  );
}

/** 结构化的类型（状态栏、选项）整块一行输出：内容由我们自己排，不再过 Markdown */
function wrapCompact(kind: RichBlockKind, head: string, inner: string): string {
  return `\n\n<div data-nt-block="${kind}">${head}${inner}</div>\n\n`;
}

function render(
  kind: RichBlockKind,
  explicitTitle: string | null,
  body: string,
  labels: RichTextOptions['labels'],
  esc: Escape,
): string {
  const head = titleOf(kind, explicitTitle, labels);
  const trimmed = body.trim();

  if (kind === 'data') {
    // 机器指令：原样转义进 pre，默认折叠，别打断阅读
    const label = attr(explicitTitle ?? labels?.data ?? 'data');
    return (
      `\n\n<details data-nt-block="data"><summary data-nt-part="title">${label}</summary>` +
      `<pre data-nt-part="body">${escapeHtml(trimmed)}</pre></details>\n\n`
    );
  }
  if (!trimmed) return '';
  if (kind === 'status') {
    const rows = renderStatusBody(trimmed, esc);
    return rows
      ? wrapCompact(kind, head, `<div data-nt-part="rows">${rows}</div>`)
      : wrapProse(kind, head, esc(trimmed));
  }
  if (kind === 'options') {
    const list = renderOptionsBody(trimmed, esc);
    return list ? wrapCompact(kind, head, list) : wrapProse(kind, head, esc(trimmed));
  }
  return wrapProse(kind, head, esc(trimmed));
}

/* ------------------------------------------------------------------ */
/* 识别                                                                */
/* ------------------------------------------------------------------ */

interface Hit {
  start: number;
  end: number;
  html: string;
}

/** `<状态栏>…</状态栏>`；流式中还没收到闭合标签时一直吃到结尾 */
function tagHits(
  text: string,
  skip: ReadonlySet<RichBlockKind>,
  options: RichTextOptions,
  esc: Escape,
): Hit[] {
  // 用 `(?=[\s/>])` 而不是 `\b` 收尾：`\b` 看的是 [A-Za-z0-9_]，中文标签名后面根本没有词边界
  const re = new RegExp(`<(${TAG_PATTERN})(?=[\\s/>])([^>]*)>([\\s\\S]*?)(?:</\\1\\s*>|$)`, 'gi');
  const guard = protectedRanges(text);
  const hits: Hit[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const raw = match[1] ?? '';
    const attrs = match[2] ?? '';
    if (attrs.trimEnd().endsWith('/')) continue; // 自闭合，不是容器
    const kind = TAG_KIND.get(raw.toLowerCase());
    if (!kind || skip.has(kind)) continue;
    const end = match.index + match[0].length;
    if (overlaps(guard, match.index, end)) continue;
    // 中文标签自带标题（`<状态栏>` → 状态栏）；英文标签走 i18n 默认名
    const explicit = /[^ -~]/.test(raw) ? raw : null;
    hits.push({
      start: match.index,
      end,
      html: render(kind, explicit, match[3] ?? '', options.labels, esc),
    });
  }
  return hits;
}

/**
 * 独占一行的 `【状态】`，吃到下一个空行 / 下一个小标题 / 结尾。
 * 预设里的状态栏十有八九长这样，没有闭合标签可依靠，只能靠空行收尾。
 */
function bracketHits(
  text: string,
  skip: ReadonlySet<RichBlockKind>,
  options: RichTextOptions,
  esc: Escape,
): Hit[] {
  const re = new RegExp(`^[ \\t]*[【[]\\s*(${BRACKET_PATTERN})\\s*[】\\]][ \\t]*$`, 'gim');
  const guard = protectedRanges(text);
  const hits: Hit[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const label = match[1] ?? '';
    const kind = BRACKET_KIND.get(label.toLowerCase());
    if (!kind || skip.has(kind)) continue;

    const bodyStart = match.index + match[0].length;
    const rest = text.slice(bodyStart);
    const stop = /\n[ \t]*(?:\n|[【[][^\n【[\]】]*[】\]][ \t]*(?:\n|$))/.exec(rest);
    const bodyEnd = bodyStart + (stop ? stop.index : rest.length);
    const body = text.slice(bodyStart, bodyEnd);
    if (!body.trim()) continue;
    if (overlaps(guard, match.index, bodyEnd)) continue;
    hits.push({
      start: match.index,
      end: bodyEnd,
      html: render(kind, label, body, options.labels, esc),
    });
  }
  return hits;
}

/** 行内的 `（OOC：…）` / `[OOC: …]`：不换行，包成 span 留在段落里 */
const OOC_INLINE_RE = /[(（[]\s*(?:OOC|ooc|Ooc|场外)\s*[:：]?\s*([^)）\]\n]{1,400})[)）\]]/g;

function oocHits(text: string, skip: ReadonlySet<RichBlockKind>, esc: Escape): Hit[] {
  if (skip.has('ooc')) return [];
  const guard = protectedRanges(text);
  const hits: Hit[] = [];
  OOC_INLINE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OOC_INLINE_RE.exec(text)) !== null) {
    const end = match.index + match[0].length;
    if (overlaps(guard, match.index, end)) continue;
    hits.push({
      start: match.index,
      end,
      html: `<span data-nt-block="ooc" data-nt-inline="">${esc((match[1] ?? '').trim())}</span>`,
    });
  }
  return hits;
}

/**
 * 把文本里认得出的结构改写成语义块。认不出的原样返回。
 *
 * 只在显示侧调用；重叠的候选按「起点靠前、范围更大」优先，后来的丢弃。
 */
export function enrichRichText(text: string, options: RichTextOptions = {}): string {
  if (!text) return text;
  const esc: Escape = options.escapeSource ? escapeHtml : passThrough;
  const skip = new Set(options.disabled ?? []);
  if (skip.size >= RICH_BLOCK_KINDS.length) return esc(text);

  const hits = [
    ...tagHits(text, skip, options, esc),
    ...bracketHits(text, skip, options, esc),
    ...oocHits(text, skip, esc),
  ].sort((a, b) => a.start - b.start || b.end - a.end);
  if (hits.length === 0) return esc(text);

  let out = '';
  let cursor = 0;
  for (const hit of hits) {
    if (hit.start < cursor) continue; // 与前一个重叠，丢弃
    out += esc(text.slice(cursor, hit.start)) + hit.html;
    cursor = hit.end;
  }
  out += esc(text.slice(cursor));
  // 空行式包装会制造多余空行，收一收，免得 Markdown 里多出空段
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '');
}
