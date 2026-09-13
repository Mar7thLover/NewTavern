import { describe, expect, it } from 'vitest';

import {
  parseRegexScript,
  parseRegexScripts,
  regexDirection,
  serializeRegexScript,
  serializeRegexScripts,
} from './regex.js';

const scriptFixture = {
  id: '6f3c1d2e-0000-4000-8000-000000000001',
  scriptName: '隐藏状态栏',
  findRegex: '/<status>[\\s\\S]*?<\\/status>/g',
  replaceString: '',
  trimStrings: [],
  placement: [2],
  disabled: false,
  markdownOnly: true,
  promptOnly: false,
  runOnEdit: true,
  substituteRegex: 0,
  minDepth: null,
  maxDepth: 3,
  future_field: '保留',
};

describe('ST 正则脚本', () => {
  it('单个脚本往返 deep-equal', () => {
    const script = parseRegexScript(scriptFixture);
    expect(JSON.parse(serializeRegexScript(script))).toEqual(scriptFixture);
  });

  it('数组往返 deep-equal，单个对象也归一为数组', () => {
    const legacy = { scriptName: '旧版', findRegex: 'a', substituteRegex: true };
    const scripts = parseRegexScripts([scriptFixture, legacy]);
    expect(JSON.parse(serializeRegexScripts(scripts))).toEqual([scriptFixture, legacy]);
    expect(parseRegexScripts(scriptFixture)).toHaveLength(1);
  });

  it('方向判定', () => {
    expect(regexDirection(parseRegexScript(scriptFixture))).toBe('display');
    expect(
      regexDirection(parseRegexScript({ ...scriptFixture, markdownOnly: false, promptOnly: true })),
    ).toBe('prompt');
    expect(regexDirection(parseRegexScript({ scriptName: 'x', findRegex: 'x' }))).toBe('both');
  });

  it('非法输入报中文错并标出下标', () => {
    expect(() => parseRegexScripts([scriptFixture, { scriptName: '缺 findRegex' }])).toThrow(
      /第 2 个正则脚本/,
    );
  });
});
