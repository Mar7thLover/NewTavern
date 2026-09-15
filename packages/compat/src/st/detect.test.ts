import { describe, expect, it } from 'vitest';

import { detectStJsonKind, detectStTextKind } from './detect.js';

const v2Card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '艾拉',
    description: '',
    personality: '',
    scenario: '',
    first_mes: '',
    mes_example: '',
  },
};

describe('detectStJsonKind', () => {
  it('识别角色卡：V2/V3、V1 平铺、gradio char_name、裸 data', () => {
    expect(detectStJsonKind(v2Card)).toBe('character');
    expect(detectStJsonKind({ ...v2Card, spec: 'chara_card_v3', spec_version: '3.0' })).toBe(
      'character',
    );
    expect(detectStJsonKind({ name: '老卡', description: 'd', first_mes: 'hi' })).toBe('character');
    expect(detectStJsonKind({ char_name: '酒保', char_persona: '话少' })).toBe('character');
    expect(detectStJsonKind({ data: { name: '裸' } })).toBe('character');
  });

  it('识别世界书：entries 为对象或数组；带 name/description 也仍是世界书', () => {
    expect(detectStJsonKind({ entries: { '0': { key: ['a'], content: 'x' } } })).toBe('lorebook');
    expect(detectStJsonKind({ entries: [] })).toBe('lorebook');
    expect(detectStJsonKind({ name: '王国', description: '设定集', entries: {} })).toBe('lorebook');
  });

  it('识别预设与正则脚本（单个与数组）', () => {
    expect(detectStJsonKind({ prompts: [], prompt_order: [] })).toBe('preset');
    expect(detectStJsonKind({ temperature: 1, chat_completion_source: 'openai' })).toBe('preset');
    expect(detectStJsonKind({ scriptName: 's', findRegex: '/a/g' })).toBe('regex');
    expect(detectStJsonKind([{ scriptName: 's', findRegex: '/a/g' }])).toBe('regex');
  });

  it('识别聊天记录 header', () => {
    expect(detectStJsonKind({ user_name: 'You', character_name: '艾拉', chat_metadata: {} })).toBe(
      'chat',
    );
  });

  it('识别不出时返回 null', () => {
    expect(detectStJsonKind({ foo: 1 })).toBeNull();
    expect(detectStJsonKind([1, 2])).toBeNull();
    expect(detectStJsonKind([])).toBeNull();
    expect(detectStJsonKind('text')).toBeNull();
  });
});

describe('detectStTextKind', () => {
  it('JSON 文本与带 BOM 的文本', () => {
    expect(detectStTextKind(JSON.stringify({ entries: {} }))).toBe('lorebook');
    expect(detectStTextKind(String.fromCharCode(0xfeff) + JSON.stringify(v2Card))).toBe(
      'character',
    );
  });

  it('JSONL 按首行识别聊天记录', () => {
    const jsonl = [
      JSON.stringify({ user_name: 'You', character_name: '艾拉', chat_metadata: {} }),
      JSON.stringify({ name: '艾拉', is_user: false, mes: '你好' }),
    ].join('\n');
    expect(detectStTextKind(jsonl)).toBe('chat');
  });

  it('非 JSON 文本返回 null', () => {
    expect(detectStTextKind('not json')).toBeNull();
    expect(detectStTextKind('')).toBeNull();
  });
});
