import fs from 'node:fs';
import { createRequire } from 'node:module';

import { ST_SAMPLING_KEYS } from '@newtavern/compat';

import {
  L,
  previewText,
  type AssistState,
  type StudioAssistKind,
  type StudioAssistMode,
  type StudioLang,
} from './studio-assist-tools.js';

/**
 * AI 协作者的系统提示词（M6 §3.3）：读 `packages/i18n/prompts/studio.{zh-CN,en}.md`，
 * 按 `## <节名>` 切段后按语言缓存；再拼上「当前任务」与草稿概览。
 */

const require = createRequire(import.meta.url);
const cache = new Map<StudioLang, Map<string, string>>();

export function studioPromptPath(lang: StudioLang): string {
  return require.resolve(`@newtavern/i18n/prompts/studio.${lang}.md`);
}

/** `## name` 一行起一段；第一个标题之前的内容（文件说明注释）丢弃 */
export function parseStudioSections(source: string): Map<string, string> {
  const sections = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (name !== null) sections.set(name, lines.join('\n').trim());
  };
  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const match = /^## ([\w.-]+)\s*$/.exec(line);
    if (match) {
      flush();
      name = match[1] as string;
      lines = [];
    } else if (name !== null) {
      lines.push(line);
    }
  }
  flush();
  return sections;
}

export function loadStudioSections(lang: StudioLang): Map<string, string> {
  const hit = cache.get(lang);
  if (hit) return hit;
  const sections = parseStudioSections(fs.readFileSync(studioPromptPath(lang), 'utf8'));
  cache.set(lang, sections);
  return sections;
}

/** 系统提示词正文：system + 对象说明 + generate 步骤（mode='generate'） */
export function studioSystemPrompt(
  lang: StudioLang,
  kind: StudioAssistKind,
  mode: StudioAssistMode,
): string {
  const sections = loadStudioSections(lang);
  return [
    sections.get('system'),
    sections.get(kind),
    mode === 'generate' ? sections.get(`generate.${kind}`) : undefined,
  ]
    .filter((s): s is string => typeof s === 'string' && s !== '')
    .join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 草稿概览                                                             */
/* ------------------------------------------------------------------ */

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CARD_FIELDS = [
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'creator_notes',
  'creator',
  'character_version',
];

function fieldLine(lang: StudioLang, path: string, value: unknown, max = 120): string {
  if (value === undefined) return `- ${path}: ${L(lang, '（无）', '(absent)')}`;
  if (typeof value === 'string') {
    if (value.trim() === '') return `- ${path}: ${L(lang, '（空）', '(empty)')}`;
    return `- ${path} (${value.length}): ${previewText(value, max)}`;
  }
  return `- ${path}: ${previewText(value, max)}`;
}

function characterOverview(state: AssistState): string[] {
  const d = state.working;
  const lines = CARD_FIELDS.map((key) => fieldLine(state.lang, `/${key}`, d[key]));
  const alts = Array.isArray(d.alternate_greetings) ? d.alternate_greetings : [];
  lines.push(
    `- /alternate_greetings: ${alts.length}${alts.length > 0 ? ` — ${alts.map((a, i) => `[${i}] ${previewText(a, 40)}`).join(' ')}` : ''}`,
  );
  lines.push(`- /tags: ${JSON.stringify(Array.isArray(d.tags) ? d.tags : [])}`);
  const ext = isRecord(d.extensions) ? d.extensions : undefined;
  const depth = ext && isRecord(ext.depth_prompt) ? ext.depth_prompt : undefined;
  lines.push(
    depth
      ? `- /extensions/depth_prompt: depth=${String(depth.depth)} role=${String(depth.role)} ${previewText(depth.prompt, 80) || L(state.lang, '（空）', '(empty)')}`
      : `- /extensions/depth_prompt: ${L(state.lang, '（无）', '(absent)')}`,
  );
  if (ext) lines.push(`- /extensions keys: ${Object.keys(ext).join(', ') || '-'}`);
  const book = isRecord(d.character_book) ? d.character_book : undefined;
  if (state.characterBookId) {
    lines.push(
      `- /character_book: ${L(state.lang, '已关联库里的世界书（只读，list_entries 查看）', 'linked to a library lorebook (read-only, see list_entries)')}`,
    );
  } else if (book) {
    const count = Array.isArray(book.entries) ? book.entries.length : 0;
    lines.push(`- /character_book: ${count} ${L(state.lang, '条', 'entries')}`);
  } else {
    lines.push(`- /character_book: ${L(state.lang, '（无）', '(absent)')}`);
  }
  return lines;
}

function presetOverview(state: AssistState): string[] {
  const d = state.working;
  const lines: string[] = [];
  if (typeof d.name === 'string') lines.push(`- /name: ${d.name}`);
  const sampling = ST_SAMPLING_KEYS.filter((key) => d[key] !== undefined).map(
    (key) => `${key}=${JSON.stringify(d[key])}`,
  );
  lines.push(`- ${L(state.lang, '采样', 'sampling')}: ${sampling.join(', ') || '-'}`);

  // 与组装器一致的顺序表：100001 → 100000 → 第一张
  const lists = Array.isArray(d.prompt_order) ? d.prompt_order.filter(isRecord) : [];
  const listIndex = ['100001', '100000']
    .map((id) => lists.findIndex((l) => String(l.character_id) === id))
    .find((i) => i >= 0);
  const picked = lists[listIndex ?? 0];
  const order = picked && Array.isArray(picked.order) ? picked.order.filter(isRecord) : [];
  const enabled = new Map(order.map((o) => [o.identifier, o.enabled === true]));
  const position = new Map(order.map((o, i) => [o.identifier, i]));
  if (picked) {
    lines.push(
      `- /prompt_order/${(Array.isArray(d.prompt_order) ? d.prompt_order : []).indexOf(picked)} (character_id ${String(picked.character_id)}): ${order.length} ${L(state.lang, '项', 'items')}`,
    );
  }
  const prompts = Array.isArray(d.prompts) ? d.prompts : [];
  lines.push(`- /prompts (${prompts.length}):`);
  prompts.forEach((p, index) => {
    if (!isRecord(p)) return;
    const id = String(p.identifier);
    const flags = [
      p.marker === true ? 'marker' : null,
      enabled.has(id)
        ? enabled.get(id)
          ? 'on'
          : 'off'
        : L(state.lang, '不在顺序表', 'not in order'),
      position.has(id) ? `#${position.get(id)}` : null,
      p.injection_position === 1 ? `depth=${String(p.injection_depth)}` : null,
      typeof p.role === 'string' ? p.role : null,
    ].filter(Boolean);
    const content =
      typeof p.content === 'string' && p.content !== '' ? ` — ${previewText(p.content, 60)}` : '';
    lines.push(`  - [${index}] ${id} “${String(p.name ?? '')}” (${flags.join(', ')})${content}`);
  });
  return lines;
}

const OVERVIEW_ENTRY_LIMIT = 60;

function lorebookOverview(state: AssistState): string[] {
  const d = state.working;
  const entries = Array.isArray(d.entries) ? d.entries.filter(isRecord) : [];
  const lines = [
    fieldLine(state.lang, '/name', d.name),
    `- ${L(state.lang, '条目', 'entries')}: ${entries.length}`,
  ];
  entries.slice(0, OVERVIEW_ENTRY_LIMIT).forEach((entry, index) => {
    const keys = Array.isArray(entry.keys) ? entry.keys.slice(0, 6).join(', ') : '';
    const flags = [
      entry.constant === true ? 'constant' : null,
      entry.disabled === true ? 'disabled' : null,
    ].filter(Boolean);
    lines.push(
      `  - [${index}] uid=${typeof entry.uid === 'number' ? entry.uid : L(state.lang, '无（未保存的新条目）', 'none (unsaved new entry)')} “${String(entry.comment ?? '')}” keys: ${keys || '-'}${flags.length ? ` (${flags.join(', ')})` : ''} — ${previewText(entry.content, 50)}`,
    );
  });
  if (entries.length > OVERVIEW_ENTRY_LIMIT) {
    lines.push(
      `  - … ${L(state.lang, '其余用 list_entries 查看', 'use list_entries for the rest')}`,
    );
  }
  return lines;
}

/** 当前任务说明 + 草稿概览（放在系统提示词之后的第二个 system 段） */
export function studioContextText(state: AssistState, tools: readonly string[]): string {
  const lang = state.lang;
  const kindName = {
    character: L(lang, '角色卡', 'character card'),
    preset: L(lang, '预设', 'preset'),
    lorebook: L(lang, '世界书', 'lorebook'),
  }[state.kind];
  const target = state.targetId
    ? L(
        lang,
        `已保存的${kindName}（id ${state.targetId}）`,
        `saved ${kindName} (id ${state.targetId})`,
      )
    : L(lang, `尚未保存的新${kindName}`, `new, unsaved ${kindName}`);
  const lines = [
    L(lang, '# 当前任务', '# Current task'),
    `- ${L(lang, '对象', 'Target')}: ${target}`,
    `- ${L(lang, '模式', 'Mode')}: ${state.mode === 'generate' ? L(lang, '生成（从描述生成整份内容）', 'generate (create the whole thing from a description)') : L(lang, '编辑', 'edit')}`,
    `- ${L(lang, '可用工具', 'Available tools')}: ${tools.join(', ')}`,
  ];
  if (!state.targetId) {
    lines.push(
      `- ${L(lang, '还没有保存，不能试跑（run_test_turn / inspect_prompt 不可用）', 'Not saved yet, so there is no test run (run_test_turn / inspect_prompt are unavailable)')}`,
    );
  }
  lines.push(
    '',
    L(
      lang,
      '# 草稿概览（摘要，读全文用 get_field）',
      '# Draft overview (excerpts; use get_field for full text)',
    ),
  );
  const body =
    state.kind === 'character'
      ? characterOverview(state)
      : state.kind === 'preset'
        ? presetOverview(state)
        : lorebookOverview(state);
  return [...lines, ...body].join('\n');
}
