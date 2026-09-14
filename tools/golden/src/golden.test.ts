/**
 * 黄金测试（M3 契约 §4.2）：用 `tools/fixtures/st-requests/` 里录制的 ST 1.18 真实请求，
 * 逐条校验 strict 模式下 `assemblePrompt` 的输出。
 *
 * 流程：fixture 文件 → `@newtavern/compat` 解析 → `map.ts` 映射成契约类型 →
 * `assemblePrompt({ layoutMode: 'strict' })` → 渲染成 OpenAI 消息 → 与快照 deep-equal。
 *
 * 渲染为什么不直接用 `openaiChatAdapter.buildRequest`：
 * `@newtavern/providers` 的 `irToChatMessages` 默认 `mergeSameRole: true` 且丢掉
 * `Segment.name`，而 ST 既不合并相邻同角色消息、又会给示例对话写 `name: example_user`。
 * 因此这里用 `mergeSameRole: false` 调同一个模块，再把 `name` 带回去（见 §9 AS-8）；
 * 采样参数仍然走 `buildRequest` 比对。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseCardJson, parseChatJsonl, parsePreset, unwrapCard } from '@newtavern/compat';
import {
  assemblePrompt,
  type AssembleHistoryNode,
  type AssembleInputV2,
  type PromptIR,
  type RegexScript,
  type WIBook,
  type WITimedState,
} from '@newtavern/core';
import { irToChatMessages, partsToText } from '@newtavern/providers';
import { describe, expect, it } from 'vitest';

import { mapCharacterDepthPrompt, mapRegexScript, mapWiSettings, mapWorldbook } from './map.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures');
const REQUESTS = path.join(FIXTURES, 'st-requests');

/** 录制时 mock 端点返回的固定回复（见 `tools/golden/record/record.mjs`） */
const MOCK_REPLY = '记录完成。Recorded.';
const MOCK_MODEL = 'newtavern-golden-mock';

interface CaseInputs {
  card: string;
  preset: string;
  worldbooks?: string[];
  characterBook?: string | null;
  chatLorebook?: string | null;
  globalRegex?: string[];
  chat: string;
  persona: string;
  settings?: Record<string, unknown>;
  authorsNote?: {
    text: string;
    position: 0 | 1 | 2;
    depth: number;
    role: 0 | 1 | 2;
    interval: number;
  } | null;
  priorUserMessages?: string[];
  userMessage: string;
}

interface CaseEntry {
  id: string;
  description?: string;
  inputs: CaseInputs;
  recorded?: boolean;
  knownDeviations?: string[];
}

interface RecordedRequest {
  messages: { role: string; content: string; name?: string }[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  [k: string]: unknown;
}

interface Snapshot {
  id: string;
  capturedAt?: string;
  inputs: CaseInputs;
  request: RecordedRequest;
  knownDeviations?: string[];
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
}

function fixture(kind: string, id: string, ext = '.json'): unknown {
  const file = path.join(FIXTURES, kind, `${id}${ext}`);
  return ext === '.json' ? readJson(file) : fs.readFileSync(file, 'utf8');
}

function loadCases(): CaseEntry[] {
  const file = path.join(REQUESTS, 'cases.json');
  if (!fs.existsSync(file)) return [];
  const parsed = readJson(file) as { cases?: CaseEntry[] };
  return Array.isArray(parsed.cases) ? parsed.cases : [];
}

function loadSnapshot(id: string): Snapshot | null {
  const file = path.join(REQUESTS, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return readJson(file) as Snapshot;
}

// ───────────────────────── fixture → AssembleInputV2 ─────────────────────────

interface BuiltCase {
  /** 每一轮的输入（最后一轮才是被比对的那一轮） */
  turns: AssembleInputV2[];
}

function buildCase(entry: CaseEntry, capturedAt: string): BuiltCase {
  const inputs = entry.inputs;
  const card = unwrapCard(parseCardJson(fixture('cards', inputs.card)));
  const cardData = card.data as Record<string, unknown>;
  const characterName = String(cardData.name ?? inputs.card);
  const preset = parsePreset(fixture('presets', inputs.preset)) as Record<string, unknown>;
  const persona = fixture('personas', inputs.persona) as { name: string; description: string };

  // ── 世界书：全局 + 角色（`extensions.world`）+ 聊天绑定；ST 会按名字去重
  const globalNames = inputs.worldbooks ?? [];
  const books: WIBook[] = globalNames.map((name) =>
    mapWorldbook(fixture('worldbooks', name), 'global', name),
  );
  const seen = new Set(books.map((book) => book.name));
  const chatBook = inputs.chatLorebook
    ? mapWorldbook(fixture('worldbooks', inputs.chatLorebook), 'chat', inputs.chatLorebook)
    : null;
  if (chatBook && !seen.has(chatBook.name)) {
    books.push(chatBook);
    seen.add(chatBook.name);
  }
  if (inputs.characterBook) {
    const charBook = mapWorldbook(
      fixture('worldbooks', inputs.characterBook),
      'char',
      inputs.characterBook,
    );
    const extensions = cardData.extensions as Record<string, unknown> | undefined;
    // ST `getCharacterLore` 只认 `data.extensions.world`
    if (extensions?.world === charBook.name && !seen.has(charBook.name)) {
      books.push(charBook);
      seen.add(charBook.name);
    }
  }

  // ── 正则：全局在前、角色在后（ST `getRegexScripts` 的顺序）
  const regexScripts: RegexScript[] = [];
  for (const name of inputs.globalRegex ?? []) {
    const list = fixture('regex', name) as Record<string, unknown>[];
    list.forEach((raw, index) => regexScripts.push(mapRegexScript(raw, 'global', index)));
  }
  const scoped = (cardData.extensions as { regex_scripts?: Record<string, unknown>[] } | undefined)
    ?.regex_scripts;
  if (Array.isArray(scoped)) {
    scoped.forEach((raw, index) => regexScripts.push(mapRegexScript(raw, 'character', index)));
  }

  const maxContext = Number(preset.openai_max_context ?? 32000);
  const maxResponse = Number(preset.openai_max_tokens ?? 0);
  const wiSettings = mapWiSettings(inputs.settings ?? {}, { maxContext, maxResponse });

  // ── 历史：聊天 jsonl → 节点
  const chatText = fixture('chats', inputs.chat, '.jsonl') as string;
  const chat = parseChatJsonl(chatText);
  const base: AssembleHistoryNode[] = chat.messages.map((message, index) => ({
    id: `c${index}`,
    // ST `setOpenAIMessages`：非 user 一律 assistant（只有 extra.type===NARRATOR 才是 system）
    role: message.isUser === true ? 'user' : 'assistant',
    name: message.isUser === true ? persona.name : (message.name ?? characterName),
    parts: [{ type: 'text', text: message.mes }],
    ...(message.isSystem === true ? { isHidden: true } : {}),
  }));

  const priors = inputs.priorUserMessages ?? [];
  const histories: AssembleHistoryNode[][] = [];
  const running = [...base];
  for (let i = 0; i < priors.length; i += 1) {
    histories.push([
      ...running,
      {
        id: `p${i}`,
        role: 'user',
        name: persona.name,
        parts: [{ type: 'text', text: priors[i] ?? '' }],
      },
    ]);
    running.push({
      id: `p${i}`,
      role: 'user',
      name: persona.name,
      parts: [{ type: 'text', text: priors[i] ?? '' }],
    });
    running.push({
      id: `r${i}`,
      role: 'assistant',
      name: characterName,
      parts: [{ type: 'text', text: MOCK_REPLY }],
    });
  }
  histories.push([
    ...running,
    {
      id: 'final',
      role: 'user',
      name: persona.name,
      parts: [{ type: 'text', text: inputs.userMessage }],
    },
  ]);

  const note = inputs.authorsNote;
  const turns = histories.map((history) => {
    const visible = history.filter((node) => node.isHidden !== true);
    const built: AssembleInputV2 = {
      chatId: entry.id,
      model: MOCK_MODEL,
      provider: 'openai-chat',
      preset: { id: inputs.preset, format: 'st-openai', data: preset },
      character: { id: inputs.card, name: characterName, data: cardData },
      persona: { name: persona.name, description: persona.description },
      history,
      layoutMode: 'strict',
      lorebooks: books,
      wiSettings,
      wiState: null,
      authorsNote: note
        ? {
            text: note.text,
            position: note.position,
            depth: note.depth,
            role: note.role,
            interval: note.interval,
          }
        : { text: '', position: 1, depth: 4, role: 0, interval: 1 },
      characterDepthPrompt: mapCharacterDepthPrompt(
        cardData.extensions as Record<string, unknown> | undefined,
      ),
      globalSystemPrompt: null,
      regexScripts,
      variables: { chat: {}, global: {} },
      messageCount: visible.length,
      providerCaps: {
        caching: 'prefix-auto',
        systemInMessages: true,
        prefill: false,
      },
      rng: { seed: `golden:${entry.id}` },
      now: new Date(capturedAt),
    };
    return built;
  });

  return { turns };
}

// ───────────────────────── IR → ST 形状的消息 ─────────────────────────

interface RenderedMessage {
  role: string;
  content: string;
  name?: string;
}

function renderMessages(ir: PromptIR): RenderedMessage[] {
  // mergeSameRole:false → 一段一条消息，与 ST `ChatCompletion.getChat()` 一致
  const { messages } = irToChatMessages(ir, {
    mergeSameRole: false,
    systemPlacement: 'inline',
  });
  const nameById = new Map(ir.segments.map((segment) => [segment.id, segment.name]));
  const out: RenderedMessage[] = [];
  for (const message of messages) {
    const content = partsToText(message.parts, '\n');
    if (content === '') continue;
    const name = message.segmentIds.map((id) => nameById.get(id)).find((item) => item);
    out.push({ role: message.role, content, ...(name ? { name } : {}) });
  }
  return out;
}

/** 首个差异的可读描述 */
function describeDiff(ours: RenderedMessage[], theirs: RenderedMessage[]): string {
  const max = Math.max(ours.length, theirs.length);
  for (let i = 0; i < max; i += 1) {
    const a = ours[i];
    const b = theirs[i];
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const clip = (value: RenderedMessage | undefined): string => {
      if (!value) return '（无）';
      const body = value.content;
      const text = body.length > 400 ? `${body.slice(0, 200)} …… ${body.slice(-200)}` : body;
      return `${value.role}${value.name ? `(${value.name})` : ''}: ${JSON.stringify(text)}`;
    };
    return [
      `首个差异在下标 ${i}（我们 ${ours.length} 条 / ST ${theirs.length} 条）`,
      `  我们：${clip(a)}`,
      `  ST  ：${clip(b)}`,
    ].join('\n');
  }
  return '消息列表一致';
}

// ───────────────────────── 用例 ─────────────────────────

const cases = loadCases();
const recorded = cases.filter((entry) => loadSnapshot(entry.id) !== null);

if (recorded.length === 0) {
  describe.skip('黄金测试（ST 1.18 快照）', () => {
    it('尚无录制快照', () => {
      expect(true).toBe(true);
    });
  });
  console.warn(
    `[golden] tools/fixtures/st-requests/ 里还没有任何 <case-id>.json 快照（cases.json 有 ${cases.length} 条用例），` +
      '整套黄金测试已跳过。请先运行 `pnpm --filter @newtavern/golden record`。',
  );
} else {
  describe('黄金测试（ST 1.18 快照）', () => {
    for (const entry of recorded) {
      const snapshot = loadSnapshot(entry.id) as Snapshot;
      const deviations = snapshot.knownDeviations ?? entry.knownDeviations ?? [];
      const runner = deviations.length > 0 ? it.skip : it;

      runner(`${entry.id}：${entry.description ?? ''}`, () => {
        const built = buildCase(entry, snapshot.capturedAt ?? '2026-09-14T00:00:00.000Z');
        let state: WITimedState | null = null;
        let last: ReturnType<typeof assemblePrompt> | null = null;
        for (const turn of built.turns) {
          last = assemblePrompt({ ...turn, wiState: state });
          state = last.wiState;
        }
        if (last === null) throw new Error('没有生成任何一轮');

        const ours = renderMessages(last.ir);
        const theirs = snapshot.request.messages;
        expect(ours, describeDiff(ours, theirs)).toEqual(theirs);

        // 采样参数（映射了的那几个）
        const sampling = last.ir.sampling;
        if (snapshot.request.temperature !== undefined) {
          expect(sampling.temperature).toBe(snapshot.request.temperature);
        }
        if (snapshot.request.top_p !== undefined) {
          expect(sampling.topP).toBe(snapshot.request.top_p);
        }
        if (snapshot.request.frequency_penalty !== undefined) {
          expect(sampling.frequencyPenalty).toBe(snapshot.request.frequency_penalty);
        }
        if (snapshot.request.presence_penalty !== undefined) {
          expect(sampling.presencePenalty).toBe(snapshot.request.presence_penalty);
        }
        if (snapshot.request.max_tokens !== undefined) {
          expect(sampling.maxTokens).toBe(snapshot.request.max_tokens);
        }
      });
    }
  });
}
