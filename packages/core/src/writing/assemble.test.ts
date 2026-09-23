import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import { type Segment } from '../prompt/ir.js';
import { type LayoutProviderCaps } from '../prompt/layout/index.js';
import { estimateTokens } from '../tokenizer.js';
import { makeBook, makeEntry, makeSettings } from '../worldinfo/test-helpers.js';
import {
  assembleWriting,
  parseChapterNumber,
  parseWritingReferences,
  WRITING_SCAN_WINDOW,
  type WritingAssembleInput,
} from './assemble.js';
import { parseWritingTemplates } from './templates.js';

const readTemplates = (lang: 'zh-CN' | 'en') =>
  parseWritingTemplates(
    fs.readFileSync(new URL(`../../../i18n/prompts/writing.${lang}.md`, import.meta.url), 'utf8'),
  );
const ZH = readTemplates('zh-CN');
const EN = readTemplates('en');

const BREAKPOINT_CAPS: LayoutProviderCaps = {
  caching: 'breakpoints',
  maxBreakpoints: 4,
  systemInMessages: false,
  prefill: false,
};

const bible = makeBook([
  makeEntry({ id: 'b:1', constant: true, content: '世界观：灵气复苏后的第十年。', order: 10 }),
  makeEntry({ id: 'b:2', constant: true, content: '主角林澈，剑修，左手有旧伤。', order: 5 }),
  makeEntry({
    id: 'b:3',
    keys: ['青岚宗'],
    content: '青岚宗：北境第一剑宗，宗主沈墨。',
    order: 50,
  }),
  makeEntry({ id: 'b:4', keys: ['赤焰'], content: '赤焰：林澈的佩剑，遇水则暗。', order: 40 }),
]);

function baseInput(partial: Partial<WritingAssembleInput> = {}): WritingAssembleInput {
  return {
    project: {
      id: 'p1',
      title: '剑来北境',
      styleGuide: '冷峻克制，少用形容词。',
      outline: '第一卷：入宗。第二卷：下山。',
      language: 'zh-CN',
    },
    chapters: [
      { id: 'c1', title: '雪夜', order: 0, summary: '林澈雪夜上山。', done: true, text: '一' },
      {
        id: 'c2',
        title: '试剑',
        order: 1,
        summary: '林澈通过试剑。',
        summaryStale: true,
        done: true,
        text: '二',
      },
      { id: 'c3', title: '拜师', order: 2, summary: '', done: false, text: '' },
    ],
    current: { id: 'c3', textBefore: '林澈跪在殿前。' },
    action: 'continue',
    bible: [bible],
    wiSettings: makeSettings(),
    globalSystemPrompt: '全局：不要写成网文腔。',
    model: 'test-model',
    providerCaps: BREAKPOINT_CAPS,
    layoutMode: 'cache-aware',
    budget: 100_000,
    countTokens: estimateTokens,
    templates: ZH,
    ...partial,
  };
}

const ids = (segments: readonly Segment[]) => segments.map((s) => s.id);
const textOf = (segments: readonly Segment[], id: string) => {
  const segment = segments.find((s) => s.id === id);
  return segment?.parts.map((p) => (p.type === 'text' ? p.text : '')).join('') ?? '';
};

describe('assembleWriting：顺序与稳定性', () => {
  it('段落按契约顺序输出，稳定性与角色正确', () => {
    const { ir } = assembleWriting(
      baseInput({
        instruction: '让青岚宗宗主出场',
        current: { id: 'c3', textBefore: '林澈跪在殿前。', textAfter: '殿门忽然打开。' },
      }),
    );
    expect(ids(ir.segments)).toEqual([
      'writing:system',
      'writing:global-system',
      'writing:style',
      'writing:bible-constant',
      'writing:outline',
      'writing:summaries',
      'writing:chapter',
      'writing:bible-triggered',
      'writing:action',
    ]);
    expect(ir.segments.map((s) => s.stability)).toEqual([
      'static',
      'static',
      'static',
      'static',
      'static',
      'session',
      'history',
      'turn',
      'turn',
    ]);
    expect(ir.segments.map((s) => s.role)).toEqual([
      'system',
      'system',
      'system',
      'system',
      'system',
      'system',
      'user',
      'user',
      'user',
    ]);
    expect(textOf(ir.segments, 'writing:system')).toContain('《剑来北境》');
    // 常驻条目按 order 升序：order 5 在 order 10 之前
    const constant = textOf(ir.segments, 'writing:bible-constant');
    expect(constant.indexOf('主角林澈')).toBeLessThan(constant.indexOf('世界观'));
    // 常驻不在触发段里重复
    expect(textOf(ir.segments, 'writing:bible-triggered')).not.toContain('世界观');
    expect(textOf(ir.segments, 'writing:bible-triggered')).toContain('宗主沈墨');
    // 当前章之前、已完成的两章摘要都在
    const summaries = textOf(ir.segments, 'writing:summaries');
    expect(summaries).toContain('第 1 章《雪夜》：林澈雪夜上山。');
    expect(summaries).toContain('第 2 章《试剑》');
    expect(textOf(ir.segments, 'writing:chapter')).toContain('林澈跪在殿前。');
    const action = textOf(ir.segments, 'writing:action');
    expect(action).toContain('殿门忽然打开。');
    expect(action).toContain('让青岚宗宗主出场');
    expect(action).toContain('约 400 字');
    expect(ir.meta.layoutMode).toBe('cache-aware');
  });

  it('strict 与 cache-aware 段落顺序相同；空段不输出', () => {
    const input = baseInput({
      globalSystemPrompt: null,
      project: { id: 'p1', title: 'T', styleGuide: '', outline: '', language: 'zh-CN' },
      bible: [],
    });
    const cache = assembleWriting(input);
    const strict = assembleWriting({ ...input, layoutMode: 'strict' });
    expect(ids(cache.ir.segments)).toEqual(ids(strict.ir.segments));
    expect(ids(strict.ir.segments)).toEqual([
      'writing:system',
      'writing:summaries',
      'writing:chapter',
      'writing:action',
    ]);
  });

  it('project.systemPrompt 覆盖内置模板；英文模板与缺省目标长度', () => {
    const custom = assembleWriting(
      baseInput({ project: { ...baseInput().project, systemPrompt: '自定义写作系统提示词' } }),
    );
    expect(textOf(custom.ir.segments, 'writing:system')).toBe('自定义写作系统提示词');
    const en = assembleWriting(
      baseInput({ templates: EN, project: { ...baseInput().project, language: 'en' } }),
    );
    expect(textOf(en.ir.segments, 'writing:action')).toContain('about 300 words');
  });

  it('段 id 与静态前缀在续写前后保持不变（只有正文与指令变化）', () => {
    const a = assembleWriting(baseInput());
    const b = assembleWriting(
      baseInput({ current: { id: 'c3', textBefore: '林澈跪在殿前。雪落无声。' } }),
    );
    expect(ids(a.ir.segments)).toEqual(ids(b.ir.segments));
    for (const id of ['writing:system', 'writing:bible-constant', 'writing:summaries']) {
      expect(textOf(a.ir.segments, id)).toBe(textOf(b.ir.segments, id));
    }
  });
});

describe('assembleWriting：断点', () => {
  it('cache-aware：static 末尾与 session 末尾各一个断点', () => {
    const { ir, report } = assembleWriting(baseInput());
    const at = ir.cachePlan.breakpoints.map((i) => ir.segments[i]?.id);
    expect(at).toEqual(['writing:outline', 'writing:summaries']);
    expect(report.breakpoints.map((bp) => bp.layer)).toEqual(['static', 'session']);
  });

  it('没有摘要时只有 static 断点；prefix-auto 不打断点', () => {
    const noSummary = assembleWriting(
      baseInput({
        chapters: [{ id: 'c3', title: '拜师', order: 0, summary: '', done: false, text: '' }],
      }),
    );
    expect(noSummary.ir.cachePlan.breakpoints.map((i) => noSummary.ir.segments[i]?.id)).toEqual([
      'writing:outline',
    ]);
    const auto = assembleWriting(
      baseInput({
        providerCaps: { caching: 'prefix-auto', systemInMessages: true, prefill: false },
      }),
    );
    expect(auto.ir.cachePlan.breakpoints).toEqual([]);
    expect(auto.report.estimatedCacheablePrefixTokens).toBeGreaterThan(0);
  });

  it('布局器不搬动写作段（没有 moves，触发条目仍在正文之后）', () => {
    const { ir } = assembleWriting(baseInput({ instruction: '青岚宗' }));
    const order = ids(ir.segments);
    expect(order.indexOf('writing:bible-triggered')).toBeGreaterThan(
      order.indexOf('writing:chapter'),
    );
    expect(order.indexOf('writing:bible-triggered')).toBeLessThan(order.indexOf('writing:action'));
  });
});

describe('assembleWriting：预算', () => {
  it('当前章超预算时从前面截断，截断处加「（前文略）」', () => {
    const long = Array.from({ length: 400 }, (_, i) => `第${i}段，剑光如雪。`).join('\n');
    const { ir, report } = assembleWriting(
      baseInput({ budget: 1500, current: { id: 'c3', textBefore: long } }),
    );
    const chapter = textOf(ir.segments, 'writing:chapter');
    expect(chapter).toContain('（前文略）');
    expect(chapter).toContain('第399段');
    expect(chapter).not.toContain('第0段，');
    expect(report.chapterTruncation).not.toBeNull();
    expect(report.chapterTruncation?.droppedChars).toBeGreaterThan(0);
    expect(report.totalTokens).toBeLessThanOrEqual(1500);
    // 截断点对齐到行首
    expect(chapter).toMatch(/（前文略）\n第\d+段/);
  });

  it('摘要从最早的章节开始丢弃；正文至少保留剩余预算的 40%', () => {
    const chapters = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      title: `章${i}`,
      order: i,
      summary: `摘要${i}：`.padEnd(120, '事'),
      done: true,
      text: '',
    }));
    chapters.push({ id: 'cur', title: '当前', order: 10, summary: '', done: false, text: '' });
    const textBefore = '正'.repeat(3000);
    const input = baseInput({
      chapters,
      bible: [],
      globalSystemPrompt: null,
      budget: 2000,
      current: { id: 'cur', textBefore },
    });
    const { ir, report } = assembleWriting(input);
    expect(report.droppedSummaries.length).toBeGreaterThan(0);
    // 丢的是最早的
    expect(report.droppedSummaries[0]?.n).toBe(1);
    const keptN = report.summaries.map((s) => s.n);
    expect(Math.min(...keptN)).toBeGreaterThan(
      Math.max(...report.droppedSummaries.map((s) => s.n)),
    );
    const fixed = report.segments
      .filter((s) => s.kind !== 'summaries' && s.kind !== 'chapter')
      .reduce((sum, s) => sum + s.tokens, 0);
    const chapterTokens = report.segments.find((s) => s.kind === 'chapter')?.tokens ?? 0;
    expect(chapterTokens).toBeGreaterThanOrEqual(Math.floor((2000 - fixed) * 0.4) - 2);
    expect(textOf(ir.segments, 'writing:summaries')).not.toContain('摘要0');
  });

  it('过期摘要照样用并列在 report；已完成但无摘要的章节列为缺失', () => {
    const chapters = [
      ...baseInput().chapters,
      { id: 'c0', title: '序', order: -1, summary: '', done: true, text: 'x' },
    ];
    const { report } = assembleWriting(baseInput({ chapters }));
    expect(report.staleSummaries.map((s) => s.chapterId)).toEqual(['c2']);
    expect(report.missingSummaries.map((s) => s.chapterId)).toEqual(['c0']);
    expect(report.summaries.map((s) => s.chapterId)).toEqual(['c1', 'c2']);
  });

  it('只用当前章之前的摘要', () => {
    const { report } = assembleWriting(baseInput({ current: { id: 'c1', textBefore: '' } }));
    expect(report.summaries).toEqual([]);
  });
});

describe('assembleWriting：圣经扫描', () => {
  it('只扫光标前末尾窗口：关键词在窗口之外不触发', () => {
    const filler = '风'.repeat(WRITING_SCAN_WINDOW + 500);
    const head = assembleWriting(
      baseInput({ current: { id: 'c3', textBefore: `青岚宗${filler}` } }),
    );
    expect(head.report.bible.map((b) => b.entryId)).not.toContain('b:3');
    expect(head.report.scanChars).toBe(WRITING_SCAN_WINDOW);

    const tail = assembleWriting(
      baseInput({ current: { id: 'c3', textBefore: `${filler}青岚宗` } }),
    );
    const hit = tail.report.bible.find((b) => b.entryId === 'b:3');
    expect(hit).toMatchObject({ placement: 'turn', reason: 'key', matchedKeys: ['青岚宗'] });
  });

  it('选区与指令也进扫描；常驻条目进 static', () => {
    const bySelection = assembleWriting(
      baseInput({
        action: 'rewrite',
        current: { id: 'c3', textBefore: '', selection: '赤焰出鞘' },
      }),
    );
    expect(bySelection.report.bible.map((b) => b.entryId)).toContain('b:4');
    expect(textOf(bySelection.ir.segments, 'writing:action')).toContain('赤焰出鞘');

    const byInstruction = assembleWriting(baseInput({ instruction: '写青岚宗' }));
    expect(byInstruction.report.bible.map((b) => b.entryId)).toContain('b:3');

    const constants = byInstruction.report.bible.filter((b) => b.placement === 'static');
    expect(constants.map((b) => b.entryId).sort()).toEqual(['b:1', 'b:2']);
    expect(byInstruction.ir.meta.activations.length).toBe(3);
  });

  it('续写不把选区放进指令与扫描', () => {
    const { ir, report } = assembleWriting(
      baseInput({ current: { id: 'c3', textBefore: '', selection: '赤焰' } }),
    );
    expect(report.bible.map((b) => b.entryId)).not.toContain('b:4');
    expect(textOf(ir.segments, 'writing:action')).not.toContain('【选中的原文】');
  });

  it('光标后的衔接参考只取前 300 字', () => {
    const after = `${'后'.repeat(300)}尾巴`;
    const { ir } = assembleWriting(
      baseInput({ current: { id: 'c3', textBefore: '前', textAfter: after } }),
    );
    const action = textOf(ir.segments, 'writing:action');
    expect(action).toContain('后'.repeat(300));
    expect(action).not.toContain('尾巴');
  });
});

describe('assembleWriting：@引用', () => {
  const notes = [
    { id: 'n1', title: '人物表', text: '林澈：剑修。沈墨：宗主。' },
    { id: 'n2', title: '人物表（旧）', text: '作废' },
  ];

  it('@笔记 与 @第N章 作为 turn 段附在指令前', () => {
    const { ir, report } = assembleWriting(
      baseInput({ notes, instruction: '参考 @人物表 和 @第二章 的内容继续' }),
    );
    const order = ids(ir.segments);
    expect(order.indexOf('writing:references')).toBe(order.indexOf('writing:action') - 1);
    const refs = textOf(ir.segments, 'writing:references');
    expect(refs).toContain('林澈：剑修。沈墨：宗主。');
    expect(refs).toContain('林澈通过试剑。');
    expect(report.references.map((r) => [r.kind, r.id, r.source])).toEqual([
      ['note', 'n1', 'note'],
      ['chapter', 'c2', 'summary'],
    ]);
  });

  it('同一个 @ 取最长的笔记标题；最多 3 个', () => {
    const parsed = parseWritingReferences('@人物表（旧） @第1章 @第2章 @第3章 @人物表', notes);
    expect(parsed.map((p) => p.token)).toEqual([
      '@人物表（旧）',
      '@第1章',
      '@第2章',
      '@第3章',
      '@人物表',
    ]);
    const { report } = assembleWriting(
      baseInput({ notes, instruction: '@人物表（旧） @第1章 @第2章 @第3章' }),
    );
    expect(report.references).toHaveLength(3);
    expect(report.warnings.some((w) => w.includes('@引用'))).toBe(true);
  });

  it('中文数字章节号', () => {
    expect(parseChapterNumber('十二')).toBe(12);
    expect(parseChapterNumber('一百零三')).toBe(103);
    expect(parseChapterNumber('３')).toBe(3);
    expect(parseChapterNumber('二十')).toBe(20);
    expect(parseChapterNumber('x')).toBeNull();
  });
});

describe('parseWritingTemplates', () => {
  it('两种语言的模板都齐全', () => {
    expect(ZH['action.summarize']).toContain('200–400');
    expect(EN.system).toContain('{{projectTitle}}');
  });

  it('缺节时报错', () => {
    expect(() => parseWritingTemplates('## system\nhi')).toThrow(/缺少小节/);
  });
});
