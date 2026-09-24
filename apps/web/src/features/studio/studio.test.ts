import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resources } from '@newtavern/i18n';
import { describe, expect, it } from 'vitest';

import { newLorebookEntry, type LorebookDraft } from '../library/lorebook-editor/model';
import type { PresetDraft } from '../library/preset-editor';
import { streamAssist, toAssistEvent, AssistHttpError, type AssistEvent } from './assist/api';
import {
  applyAssistEvent,
  decideOps,
  finishTurn,
  newTurn,
  pendingIndexes,
  toConversation,
} from './assist/turns';
import {
  addCardScript,
  deleteCardScript,
  patchCardScript,
  readCardScripts,
} from './character/scripts';
import { assembleDraftOf, assistDraftOf, pairDirty } from './draft/adapters';
import {
  compareCharacterVersion,
  compareLorebookVersion,
  comparePresetVersion,
  opsToRows,
} from './draft/changes';
import {
  applyCharacterOps,
  applyLorebookOps,
  applyPresetOps,
  parsePointer,
  setAtImmutable,
} from './draft/patch';
import { initDraftState, studioDraftReducer } from './draft/state';
import { collapseEqual, diffStats, diffText } from './draft/text-diff';
import { diffList, diffValue } from './diff/value-diff';
import type { CharacterDraft, StudioPair, StudioPatchOp } from './types';

/*
 * 工作台纯逻辑：草稿状态机（useStudioDraft 的核心）、补丁合并、改动行（AI 补丁与版本对比）、
 * 字符级 diff、协作 SSE 解析与对话状态、角色脚本读写、词条覆盖。
 */

const card = (): CharacterDraft => ({
  name: '灯塔看守',
  description: '沉默的老人',
  first_mes: '……',
  alternate_greetings: ['早。'],
  extensions: { depth_prompt: { prompt: '', depth: 4, role: 'system' }, other: { keep: 1 } },
  unknown_field: 'keep',
});

const preset = (): PresetDraft => ({
  name: '默认',
  data: {
    temperature: 1,
    prompts: [
      { identifier: 'main', name: 'Main', content: 'Hi', role: 'system' },
      { identifier: 'chatHistory', name: 'Chat History', marker: true },
    ],
    prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }] }],
  },
  layoutPolicy: null,
});

const book = (): LorebookDraft => ({
  name: '港口',
  entries: [
    {
      ...newLorebookEntry('e1'),
      id: 'e1',
      uid: 0,
      keys: ['灯塔'],
      content: '一座白色灯塔',
      comment: '灯塔',
    },
    {
      ...newLorebookEntry('e2'),
      id: 'e2',
      uid: 1,
      keys: ['码头'],
      content: '旧码头',
      comment: '码头',
    },
  ],
});

/* ------------------------------------------------------------------ */

describe('JSON Pointer 与不可变写入', () => {
  it('解析转义并补前导斜杠', () => {
    expect(parsePointer('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(parsePointer('description')).toEqual(['description']);
    expect(parsePointer('/')).toEqual([]);
  });

  it('沿路径浅拷贝、不改入参；缺父级补对象；下标越界追加', () => {
    const data = card();
    const next = setAtImmutable(data, ['extensions', 'depth_prompt', 'prompt'], 'x');
    expect(next).not.toBe(data);
    expect((data.extensions as { depth_prompt: { prompt: string } }).depth_prompt.prompt).toBe('');
    expect((next.extensions as { other: unknown }).other).toBe(
      (data.extensions as { other: unknown }).other,
    );
    expect(setAtImmutable({}, ['a', 'b'], 1)).toEqual({ a: { b: 1 } });
    expect(setAtImmutable({ list: ['a'] }, ['list', '5'], 'b')).toEqual({ list: ['a', 'b'] });
    expect(setAtImmutable({}, ['__proto__', 'x'], 1)).toEqual({});
  });
});

describe('补丁合并', () => {
  it('角色卡：set 逐条合并，未知字段保留，条目补丁忽略', () => {
    const ops: StudioPatchOp[] = [
      {
        op: 'set',
        path: '/description',
        value: '沉默的老人，守着灯塔四十年',
        before: '沉默的老人',
      },
      { op: 'set', path: '/alternate_greetings/1', value: '又起雾了。' },
      { op: 'set', path: '/extensions/depth_prompt/prompt', value: '说话简短', before: '' },
      { op: 'delete_entry', uid: 3, before: {} },
    ];
    const next = applyCharacterOps(card(), ops);
    expect(next.description).toBe('沉默的老人，守着灯塔四十年');
    expect(next.alternate_greetings).toEqual(['早。', '又起雾了。']);
    expect(next.unknown_field).toBe('keep');
    expect((next.extensions as Record<string, unknown>).other).toEqual({ keep: 1 });
  });

  it('预设：/name 写名称，/prompts/<i> 整条替换', () => {
    const next = applyPresetOps(preset(), [
      { op: 'set', path: '/name', value: '精简版', before: '默认' },
      {
        op: 'set',
        path: '/prompts/0',
        value: { identifier: 'main', name: 'Main', content: '更短', role: 'system' },
      },
      { op: 'set', path: '/temperature', value: 0.8, before: 1 },
    ]);
    expect(next.name).toBe('精简版');
    expect(next.data.name).toBeUndefined();
    expect((next.data.prompts as { content?: string }[])[0]?.content).toBe('更短');
    expect(next.data.temperature).toBe(0.8);
    expect(assistDraftOf({ kind: 'preset', baseline: preset(), draft: next }).name).toBe('精简版');
  });

  it('世界书：按 uid 增改删，新条目带 uid 与本地 key', () => {
    const next = applyLorebookOps(book(), [
      { op: 'set', path: '/name', value: '港口小镇', before: '港口' },
      {
        op: 'update_entry',
        uid: 0,
        patch: { content: '一座白色的旧灯塔' },
        before: { content: '一座白色灯塔' },
      },
      { op: 'delete_entry', uid: 1, before: { uid: 1, comment: '码头' } },
      {
        op: 'add_entry',
        uid: 2,
        entry: { keys: ['酒馆'], content: '港口唯一的酒馆', comment: '酒馆', uid: 2 },
      },
    ]);
    expect(next.name).toBe('港口小镇');
    expect(next.entries.map((e) => e.uid)).toEqual([0, 2]);
    expect(next.entries[0]?.content).toBe('一座白色的旧灯塔');
    expect(next.entries[1]?.key.startsWith('new:')).toBe(true);
    expect(next.entries[1]?.keys).toEqual(['酒馆']);
    // 重复接受同一条新增不会加两次
    const again = applyLorebookOps(next, [
      { op: 'add_entry', uid: 2, entry: { keys: ['酒馆'], uid: 2 } },
    ]);
    expect(again.entries).toHaveLength(2);
  });
});

describe('草稿状态机（useStudioDraft）', () => {
  const pair = (): StudioPair => {
    const data = card();
    return { kind: 'character', baseline: data, draft: data };
  };

  it('编辑 → dirty；改回基线 = 还原；接受 AI 改动记 aiTouched', () => {
    let state = initDraftState(pair());
    expect(pairDirty(state.pair)).toBe(false);
    const edited = { ...state.pair.draft, name: '看守' };
    state = studioDraftReducer(state, { type: 'edit', draft: edited })!;
    expect(pairDirty(state.pair)).toBe(true);
    expect(state.revision).toBe(1);
    state = studioDraftReducer(state, {
      type: 'applyOps',
      ops: [{ op: 'set', path: '/scenario', value: '雾港' }],
    })!;
    expect(state.aiTouched).toBe(true);
    expect((state.pair.draft as CharacterDraft).scenario).toBe('雾港');
    state = studioDraftReducer(state, { type: 'edit', draft: state.pair.baseline })!;
    expect(state.aiTouched).toBe(false);
    expect(pairDirty(state.pair)).toBe(false);
  });

  it('保存：没再改就换成服务端版本；期间又改了则保留草稿', () => {
    let state = initDraftState(pair());
    const submitted = { ...state.pair.draft, name: '看守' };
    state = studioDraftReducer(state, { type: 'edit', draft: submitted })!;
    const serverRow = { ...submitted, tags: [] };
    const saved = studioDraftReducer(state, { type: 'saved', baseline: serverRow, submitted })!;
    expect(saved.pair.draft).toBe(serverRow);
    expect(pairDirty(saved.pair)).toBe(false);

    const later = { ...submitted, name: '看守人' };
    const moved = studioDraftReducer(state, { type: 'edit', draft: later })!;
    const saved2 = studioDraftReducer(moved, { type: 'saved', baseline: serverRow, submitted })!;
    expect(saved2.pair.draft).toBe(later);
    expect(pairDirty(saved2.pair)).toBe(true);
  });

  it('还原与组装草稿：只有有改动时才带 draft', () => {
    let state = initDraftState(pair());
    expect(assembleDraftOf(state.pair, 'c1')).toBeUndefined();
    state = studioDraftReducer(state, { type: 'edit', draft: { ...state.pair.draft, name: 'x' } })!;
    expect(assembleDraftOf(state.pair, 'c1')).toEqual({
      character: { id: 'c1', data: state.pair.draft },
    });
    state = studioDraftReducer(state, { type: 'revert' })!;
    expect(assembleDraftOf(state.pair, 'c1')).toBeUndefined();
    // 名称为空不能组装（服务端会 400）
    state = studioDraftReducer(state, { type: 'edit', draft: { ...state.pair.draft, name: ' ' } })!;
    expect(assembleDraftOf(state.pair, 'c1')).toBeUndefined();
  });

  it('世界书组装草稿只带改动字段（同 PUT）', () => {
    const base = book();
    const draft: LorebookDraft = {
      ...base,
      entries: base.entries.map((e) => (e.uid === 0 ? { ...e, content: '新' } : e)),
    };
    const body = assembleDraftOf({ kind: 'lorebook', baseline: base, draft }, 'b1');
    expect(body?.lorebook?.entries[0]).toEqual({ id: 'e1', content: '新' });
    expect(body?.lorebook?.entries[1]).toEqual({ id: 'e2' });
  });
});

describe('改动行', () => {
  it('补丁 → 行：set 保留有无 before；条目按动作', () => {
    const rows = opsToRows([
      { op: 'set', path: '/first_mes', value: 'a' },
      { op: 'set', path: '/description', value: 'b', before: 'c' },
      { op: 'add_entry', uid: 5, entry: { keys: ['k'], content: 'x', comment: '标题', uid: 5 } },
      { op: 'update_entry', uid: 1, patch: { content: 'y' }, before: { content: 'z' } },
      { op: 'delete_entry', uid: 2, before: { comment: '旧', content: 'w', keys: [] } },
    ]);
    expect(rows[0]).toMatchObject({ type: 'field', hasBefore: false });
    expect(rows[1]).toMatchObject({ type: 'field', hasBefore: true, before: 'c' });
    expect(rows[2]).toMatchObject({ type: 'entry', action: 'add', title: '标题' });
    const addFields = rows[2]?.type === 'entry' ? rows[2].fields.map((f) => f.field) : [];
    expect(addFields).toEqual(['keys', 'content', 'comment']);
    expect(rows[3]).toMatchObject({ type: 'entry', action: 'update' });
    expect(rows[4]).toMatchObject({ type: 'entry', action: 'delete', title: '旧' });
  });

  it('版本对比：角色卡叶子级、预设剥掉 __layoutPolicy、世界书按 id 对齐', () => {
    const current = card();
    const version = { ...card(), description: '年轻的看守', alternate_greetings: ['晚。'] };
    const rows = compareCharacterVersion(current, version);
    expect(rows.map((r) => (r.type === 'field' ? r.path : ''))).toEqual([
      '/description',
      '/alternate_greetings/0',
    ]);

    const p = preset();
    const presetRows = comparePresetVersion(p, {
      ...p.data,
      temperature: 0.5,
      __layoutPolicy: { mode: 'cache-aware' },
    });
    expect(presetRows.map((r) => (r.type === 'field' ? r.path : ''))).toEqual([
      '/temperature',
      '/__layoutPolicy',
    ]);

    const b = book();
    const lorebookRows = compareLorebookVersion(b, {
      name: '港口',
      entries: [
        { id: 'e1', uid: 0, keys: ['灯塔'], content: '改过', comment: '灯塔' },
        { id: 'old', uid: 9, keys: ['旧'], content: '已删的', comment: '旧条目' },
      ],
    });
    expect(lorebookRows.map((r) => (r.type === 'entry' ? r.action : r.type))).toEqual([
      'update',
      'delete',
      'add',
    ]);
  });
});

describe('字符级 diff', () => {
  it('中文按字比较', () => {
    const diff = diffText('她走进了酒馆', '她慢慢走进了港口的酒馆');
    expect(diff.mode).toBe('chars');
    expect(diff.segments.filter((s) => s.type === 'add').map((s) => s.text)).toEqual([
      '慢慢',
      '港口的',
    ]);
    expect(diffStats(diff.segments)).toEqual({ added: 5, removed: 0 });
  });

  it('一侧为空时整段替换；超长退到按词', () => {
    expect(diffText('', 'abc')).toEqual({
      segments: [{ type: 'add', text: 'abc' }],
      mode: 'replace',
    });
    const long = 'word '.repeat(6000);
    expect(diffText(long, `${long}tail`).mode).toBe('words');
  });

  it('折叠长的相同段，只留改动附近', () => {
    const same = '甲'.repeat(300);
    const parts = collapseEqual(diffText(`${same}乙${same}`, `${same}丙${same}`).segments, 10);
    expect(parts[0]).toEqual({ type: 'gap', count: 290 });
    expect(parts.some((p) => p.type === 'gap' && p.count === 290)).toBe(true);
    expect(parts.every((p) => p.type !== 'equal' || p.text.length === 10)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

function sse(events: [string, unknown][], chunkSize = 7): Response {
  const encoder = new TextEncoder();
  const text =
    `:${'-'.repeat(32)}\n\n` +
    events
      .map(([event, data]) => `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`)
      .join('') +
    ': ping\n\n';
  const bytes = encoder.encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      // 故意切成小块：跨 chunk 断句、CRLF 被切开
      for (let i = 0; i < bytes.length; i += chunkSize)
        controller.enqueue(bytes.slice(i, i + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const REQUEST = {
  target: { kind: 'character' as const, id: 'c1' },
  draft: {},
  conversation: [],
  instruction: '补全设定',
  mode: 'edit' as const,
  lang: 'zh-CN' as const,
};

async function collect(response: Response): Promise<AssistEvent[]> {
  const out: AssistEvent[] = [];
  const fetcher = (async () => response) as unknown as typeof fetch;
  for await (const event of streamAssist(REQUEST, new AbortController().signal, fetcher))
    out.push(event);
  return out;
}

describe('协作 SSE', () => {
  it('按顺序解析全部事件，跨块与心跳不影响', async () => {
    const events = await collect(
      sse([
        ['reasoning', { delta: '想想' }],
        ['text', { delta: '我先读' }],
        ['text', { delta: '一下描述。' }],
        [
          'tool',
          {
            id: 't1',
            name: 'get_field',
            args: { path: '/description' },
            summary: '读取 /description',
          },
        ],
        ['tool_result', { id: 't1', ok: true, summary: '12 字', content: '"沉默的老人"' }],
        [
          'patch',
          { ops: [{ op: 'set', path: '/description', value: 'x', before: 'y' }, { op: 'bogus' }] },
        ],
        ['usage', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 2 }],
        ['done', { steps: 2, stopReason: 'end' }],
      ]),
    );
    expect(events.map((e) => e.type)).toEqual([
      'reasoning',
      'text',
      'text',
      'tool',
      'tool_result',
      'patch',
      'usage',
      'done',
    ]);
    const patch = events.find((e) => e.type === 'patch');
    expect(patch?.type === 'patch' && patch.ops).toHaveLength(1);

    // 并进一轮
    let turn = newTurn('1', '补全设定', 'edit');
    for (const event of events) turn = applyAssistEvent(turn, event);
    expect(turn.status).toBe('done');
    expect(turn.items.map((i) => i.type)).toEqual(['reasoning', 'text', 'tool']);
    expect(turn.items[1]).toEqual({ type: 'text', text: '我先读一下描述。' });
    expect(turn.items[2]).toMatchObject({ type: 'tool', result: { ok: true, summary: '12 字' } });
    expect(turn.patch?.decisions).toEqual(['pending']);
    expect(turn.usage?.input).toBe(10);
  });

  it('上游出错：patch 仍在、状态为 error、没有 done', async () => {
    const events = await collect(
      sse([
        ['patch', { ops: [{ op: 'set', path: '/name', value: 'n' }] }],
        ['error', { message: '过载', kind: 'overloaded' }],
      ]),
    );
    let turn = newTurn('1', 'x', 'generate');
    for (const event of events) turn = applyAssistEvent(turn, event);
    expect(turn.status).toBe('error');
    expect(turn.error).toBe('过载');
    expect(turn.patch?.ops).toHaveLength(1);
  });

  it('开流前的 JSON 错误抛 AssistHttpError', async () => {
    const response = new Response(
      JSON.stringify({ error: 'no_connection', message: '未指定连接或模型' }),
      {
        status: 400,
      },
    );
    await expect(collect(response)).rejects.toMatchObject({
      name: 'AssistHttpError',
      status: 400,
      code: 'no_connection',
    });
    expect(new AssistHttpError('m', 404, undefined)).toBeInstanceOf(Error);
  });

  it('认不出的事件与坏 JSON 忽略', () => {
    expect(toAssistEvent({ event: 'weird', data: '{}' })).toBeNull();
    expect(toAssistEvent({ event: 'text', data: 'not json' })).toBeNull();
  });
});

describe('协作对话状态', () => {
  const withPatch = () =>
    applyAssistEvent(
      applyAssistEvent(newTurn('1', '改名', 'edit'), { type: 'text', delta: '好的。' }),
      {
        type: 'patch',
        ops: [
          { op: 'set', path: '/name', value: 'a' },
          { op: 'set', path: '/description', value: 'b' },
          { op: 'set', path: '/scenario', value: 'c' },
        ],
      },
    );

  it('逐条决定只改 pending 项', () => {
    let turn = withPatch();
    turn = decideOps(turn, [0], 'accepted');
    turn = decideOps(turn, [0, 1], 'rejected');
    expect(turn.patch?.decisions).toEqual(['accepted', 'rejected', 'pending']);
    expect(pendingIndexes(turn)).toEqual([2]);
  });

  it('conversation 附上处理结果；没有产出的轮次与进行中的轮次不进上下文', () => {
    const done = decideOps(
      applyAssistEvent(withPatch(), { type: 'done', steps: 1, stopReason: 'end' }),
      [0],
      'accepted',
    );
    const failed = finishTurn(newTurn('2', '失败的', 'edit'), '中断');
    const running = newTurn('3', '进行中', 'edit');
    const conversation = toConversation([done, failed, running], (a, r, p) => `[${a}/${r}/${p}]`);
    expect(conversation).toEqual([
      { role: 'user', content: '改名' },
      { role: 'assistant', content: '好的。\n\n[1/0/2]' },
    ]);
    expect(failed.status).toBe('error');
  });
});

describe('角色脚本（酒馆助手格式）', () => {
  const withScripts = (): CharacterDraft => ({
    name: 'x',
    extensions: {
      tavern_helper: {
        variables: { a: 1 },
        scripts: [
          {
            type: 'script',
            enabled: true,
            name: '状态栏',
            id: 's1',
            content: 'console.log(1)',
            info: '',
            button: { enabled: true, buttons: [{ name: '刷新', visible: true }] },
            data: { k: 1 },
            export_with: { data: true, button: true },
          },
          {
            type: 'folder',
            name: '工具',
            enabled: true,
            scripts: [
              {
                type: 'script',
                enabled: false,
                name: '骰子',
                id: 's2',
                content: '',
                info: '',
                button: { enabled: true, buttons: [] },
              },
            ],
          },
        ],
      },
    },
  });

  it('平铺读取（含文件夹），改动只落在那个脚本上', () => {
    const data = withScripts();
    const scripts = readCardScripts(data);
    expect(scripts.map((s) => [s.name, s.folder, s.enabled])).toEqual([
      ['状态栏', null, true],
      ['骰子', '工具', false],
    ]);
    const next = patchCardScript(data, scripts[1]!, { enabled: true, content: 'roll()' });
    const helper = (
      next.extensions as { tavern_helper: { variables: unknown; scripts: unknown[] } }
    ).tavern_helper;
    expect(helper.variables).toEqual({ a: 1 });
    expect(helper.scripts[0]).toBe(
      (data.extensions as { tavern_helper: { scripts: unknown[] } }).tavern_helper.scripts[0],
    );
    expect(readCardScripts(next)[1]).toMatchObject({ enabled: true, content: 'roll()' });
  });

  it('旧格式 ScriptItem 与 TavernHelper_scripts：保持格式；增删', () => {
    const legacy: CharacterDraft = {
      name: 'x',
      extensions: {
        TavernHelper_scripts: [
          {
            type: 'script',
            value: { id: 'o1', name: '旧', content: 'a', enabled: false, buttons: [] },
          },
        ],
      },
    };
    const [script] = readCardScripts(legacy);
    expect(script).toMatchObject({ name: '旧', legacy: true });
    const patched = patchCardScript(legacy, script!, { buttons: [{ name: 'b', visible: true }] });
    const raw = (
      patched.extensions as { TavernHelper_scripts: { value: Record<string, unknown> }[] }
    ).TavernHelper_scripts[0]!.value;
    expect(raw.buttons).toEqual([{ name: 'b', visible: true }]);
    expect(raw.button).toBeUndefined();
    expect(readCardScripts(deleteCardScript(patched, readCardScripts(patched)[0]!))).toEqual([]);

    const added = addCardScript(
      { name: 'y' },
      { name: '新', content: 'c', info: '', buttons: [], buttonsEnabled: true },
    );
    expect(readCardScripts(added)).toMatchObject([{ name: '新', enabled: false, legacy: false }]);
  });
});

describe('词条覆盖（studio）', () => {
  it('源码里用到的 studio.* 字面量键中英都有', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) files.push(full);
      }
    };
    walk(root);
    const missing: string[] = [];
    const get = (dict: unknown, key: string) =>
      key
        .split('.')
        .reduce<unknown>(
          (node, part) =>
            node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
          dict,
        );
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/\bt\(\s*'(studio\.[\w.-]+)'/g)) {
        for (const [lang, bundle] of Object.entries(resources)) {
          if (get(bundle.translation, match[1]!) === undefined)
            missing.push(`${lang}: ${match[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('结构化值差异（数组 / 对象不吐 JSON）', () => {
  it('字符串数组按条目：新增整条、删除整条、改动条目内部再比，未变的计数', () => {
    const diff = diffValue(
      ['早。', '晚。', '夜里好。'],
      ['早。', '晚安。', '夜里好。', '又起雾了。'],
    );
    expect(diff.kind).toBe('list');
    if (diff.kind !== 'list') return;
    expect(diff.short).toBe(true);
    expect(diff.items.map((item) => item.status)).toEqual(['same', 'change', 'same', 'add']);
    const changed = diff.items[1];
    expect(changed).toMatchObject({ status: 'change', index: 1 });
    expect(changed?.status === 'change' && changed.diff).toMatchObject({
      kind: 'text',
      before: '晚。',
      after: '晚安。',
    });
    expect(diff.items[3]).toMatchObject({
      status: 'add',
      index: 3,
      diff: { kind: 'text', after: '又起雾了。', hasBefore: false },
    });
  });

  it('原先没有 / 空数组 → 全部是新增条目；长文本不算短列表', () => {
    const long = '神秘的小屋里，那团迷雾稍稍散去，露出角落里那双清澈的眼睛。';
    const fromEmpty = diffValue([], [long]);
    const fromNothing = diffValue(undefined, [long], false, true);
    for (const diff of [fromEmpty, fromNothing]) {
      expect(diff).toMatchObject({ kind: 'list', short: false });
      if (diff.kind === 'list')
        expect(diff.items).toEqual([expect.objectContaining({ status: 'add' })]);
    }
    const removed = diffValue(['a', 'b'], []);
    expect(removed.kind === 'list' && removed.items.map((i) => i.status)).toEqual(['del', 'del']);
  });

  it('对象按字段列出变化，未变字段计数；嵌套结构标记为复杂', () => {
    const diff = diffValue(
      { prompt: '说话简短', depth: 4, role: 'system' },
      { prompt: '说话更简短', depth: 2, role: 'system' },
    );
    expect(diff).toMatchObject({ kind: 'fields', unchanged: 1, complex: false });
    if (diff.kind !== 'fields') return;
    expect(diff.rows.map((row) => [row.key, row.status, row.diff.kind])).toEqual([
      ['prompt', 'change', 'text'],
      ['depth', 'change', 'text'],
    ]);
    expect(diff.rows[1]?.diff).toMatchObject({ before: '4', after: '2' });

    const nested = diffValue(undefined, { identifier: 'x', injection: { depth: 1 } }, false, true);
    expect(nested).toMatchObject({ kind: 'fields', complex: true });
    if (nested.kind === 'fields')
      expect(nested.rows.every((row) => row.status === 'add')).toBe(true);
  });

  it('对象数组按整条对齐，改动的条目内部按字段比', () => {
    const diff = diffList(
      [
        { identifier: 'main', enabled: true },
        { identifier: 'nsfw', enabled: true },
      ],
      [
        { identifier: 'main', enabled: true },
        { identifier: 'nsfw', enabled: false },
        { identifier: 'new', enabled: true },
      ],
    );
    expect(diff.map((item) => item.status)).toEqual(['same', 'change', 'add']);
    const changed = diff[1];
    expect(changed?.status === 'change' && changed.diff).toMatchObject({
      kind: 'fields',
      unchanged: 1,
      rows: [{ key: 'enabled', status: 'change' }],
    });
  });

  it('基本值：数字布尔转文字，null 为空', () => {
    expect(diffValue(true, false)).toMatchObject({ kind: 'text', before: 'true', after: 'false' });
    expect(diffValue(null, 'x')).toMatchObject({ kind: 'text', before: '', after: 'x' });
  });
});
