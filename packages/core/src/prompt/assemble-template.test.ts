/**
 * EJS 模板渲染点（M5（三）契约 §4.2）。这里用假渲染器验证「在哪些段、什么时机调用、变量怎么回写」，
 * 真正的 EJS 引擎（QuickJS）在 `@newtavern/compat/ejs` 里测。
 */

import { describe, expect, it } from 'vitest';

import { makeBook, makeEntry, makeSettings } from '../worldinfo/test-helpers.js';
import { assemblePrompt, type AssembleInputV2, type TemplateRenderer } from './assemble.js';
import { type PromptIR, type Segment } from './ir.js';

const PROMPT_IDS = ['main', 'worldInfoBefore', 'charDescription', 'chatHistory'];

function input(overrides: Partial<AssembleInputV2> = {}): AssembleInputV2 {
  return {
    chatId: 'c1',
    model: 'gpt-x',
    provider: 'openai-chat',
    preset: {
      id: 'p',
      format: 'st-openai',
      data: {
        prompts: [
          {
            identifier: 'main',
            system_prompt: true,
            role: 'system',
            content: 'MAIN <%= 1 %> {{char}}',
          },
          { identifier: 'worldInfoBefore', marker: true },
          { identifier: 'charDescription', marker: true },
          { identifier: 'chatHistory', marker: true },
        ],
        prompt_order: [
          {
            character_id: 100001,
            order: PROMPT_IDS.map((identifier) => ({ identifier, enabled: true })),
          },
        ],
        new_chat_prompt: '',
        openai_max_context: 100000,
        openai_max_tokens: 0,
      },
    },
    character: { id: 'ch', name: 'Kit', data: { description: 'DESC <%- x %>' } },
    persona: { id: 'pe', name: 'Ada', description: '' },
    history: [
      { id: 'h1', role: 'assistant', parts: [{ type: 'text', text: 'Hi<% setvar("a", 1) %>!' }] },
      { id: 'h2', role: 'user', parts: [{ type: 'text', text: 'Hello' }] },
    ],
    lorebooks: [
      makeBook(
        [makeEntry({ id: 'e1', constant: true, content: 'WI <%= getvar("n") %>', comment: 'x' })],
        'char',
      ),
    ],
    wiSettings: makeSettings(),
    variables: { chat: { n: 1, keep: 'k' }, global: { g: 1 } },
    messageCount: 2,
    providerCaps: { caching: 'none', systemInMessages: true, prefill: true },
    rng: { seed: 'seed-1' },
    ...overrides,
  };
}

const find = (ir: PromptIR, id: string): Segment => {
  const segment = ir.segments.find((item) => item.id === id);
  if (!segment) throw new Error(`未找到段 ${id}`);
  return segment;
};
const text = (segment: Segment): string =>
  segment.parts.map((part) => (part.type === 'text' ? part.text : '')).join('');

describe('EJS 渲染点', () => {
  it('没有渲染器：原样保留，meta 不带 templated', () => {
    const result = assemblePrompt(input());
    expect(text(find(result.ir, 'preset:main'))).toBe('MAIN <%= 1 %> Kit');
    expect(result.ir.meta.templated).toBeUndefined();
  });

  it('宏先展开再渲染；历史交给渲染器按 history 处理；段 id 记进 templated', () => {
    const calls: { text: string; site: string; ref?: string }[] = [];
    const renderer: TemplateRenderer = (value, ctx) => {
      calls.push({ text: value, site: ctx.site, ...(ctx.ref ? { ref: ctx.ref } : {}) });
      if (ctx.site === 'history') return value.replace(/<%[\s\S]*?%>/g, '');
      return value.replace(/<%[\s\S]*?%>/g, `[${ctx.site}]`);
    };
    const result = assemblePrompt(input({ templateRenderer: renderer }));
    // 宏已展开（{{char}} → Kit）才交给模板
    expect(calls.find((call) => call.site === 'preset')?.text).toBe('MAIN <%= 1 %> Kit');
    expect(text(find(result.ir, 'preset:main'))).toBe('MAIN [preset] Kit');
    expect(text(find(result.ir, 'character:description'))).toBe('DESC [character]');
    expect(text(find(result.ir, 'worldinfo:before'))).toBe('WI [worldinfo]');
    expect(text(find(result.ir, 'history:h1'))).toBe('Hi!');
    expect(calls.find((call) => call.site === 'history')?.ref).toBe('h1');
    expect(result.ir.meta.templated?.sort()).toEqual(
      ['character:description', 'preset:main', 'worldinfo:before'].sort(),
    );
  });

  it('模板写的变量并回事务：非 dryRun 随结果返回，dryRun 不返回', () => {
    const renderer: TemplateRenderer = (value, ctx) => {
      if (ctx.site === 'preset') {
        ctx.vars.chat.n = 2;
        ctx.vars.global.g = 5;
        delete ctx.vars.chat.keep;
      }
      return value;
    };
    const live = assemblePrompt(input({ templateRenderer: renderer }));
    expect(live.variables.chat).toEqual({ n: 2 });
    expect(live.variables.globalChanges).toEqual({ g: 5 });
    const dry = assemblePrompt(input({ templateRenderer: renderer, dryRun: true }));
    expect(dry.variables.chat).toEqual({ n: 1, keep: 'k' });
  });

  it('告警进 meta.warnings；渲染成空的段被丢掉', () => {
    const renderer: TemplateRenderer = (value, ctx) => {
      if (ctx.site === 'character') {
        ctx.warn('坏模板');
        return '';
      }
      return value;
    };
    const result = assemblePrompt(input({ templateRenderer: renderer }));
    expect(result.ir.meta.warnings).toContain('坏模板');
    expect(result.ir.segments.some((segment) => segment.id === 'character:description')).toBe(
      false,
    );
  });

  it('getwi 的条目正文由 prepareWorldInfo 先过正则与宏', () => {
    let prepared = '';
    const renderer: TemplateRenderer = (value, ctx) => {
      if (ctx.site === 'worldinfo') prepared = ctx.prepareWorldInfo?.('条目 {{user}}') ?? '';
      return value;
    };
    assemblePrompt(input({ templateRenderer: renderer }));
    expect(prepared).toBe('条目 Ada');
  });
});
