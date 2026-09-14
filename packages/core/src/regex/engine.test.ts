import { describe, expect, it, vi } from 'vitest';

import {
  applyRegexScripts,
  escapeRegex,
  regexFromString,
  runRegexScript,
  sanitizeRegexMacro,
  shouldRunRegexScript,
  type RegexRunContext,
  type RegexScript,
} from './engine.js';

function makeScript(overrides: Partial<RegexScript> = {}): RegexScript {
  return {
    id: 's1',
    name: '测试脚本',
    findRegex: '/a/g',
    replaceString: 'b',
    trimStrings: [],
    placement: [2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    scope: 'global',
    ...overrides,
  };
}

function makeCtx(overrides: Partial<RegexRunContext> = {}): RegexRunContext {
  return {
    placement: 2,
    direction: 'prompt',
    substitute: (text) => text,
    ...overrides,
  };
}

describe('regexFromString', () => {
  it('解析 /pattern/flags 形式', () => {
    const re = regexFromString('/fo+/gi');
    expect(re?.source).toBe('fo+');
    expect(re?.flags).toBe('gi');
  });

  it('裸 pattern 无 flags', () => {
    const re = regexFromString('fo+');
    expect(re?.source).toBe('fo+');
    expect(re?.flags).toBe('');
  });

  it('pattern 里可以有斜杠（贪婪匹配到最后一个）', () => {
    const re = regexFromString('/a\\/b/g');
    expect(re?.source).toBe('a\\/b');
    expect(re?.flags).toBe('g');
  });

  it('重复 flag 时退回把整个输入当 pattern（与 ST 一致）', () => {
    const re = regexFromString('/foo/gg');
    expect(re?.flags).toBe('');
    expect(re?.test('x/foo/gg')).toBe(true);
    expect(re?.test('foo')).toBe(false);
  });

  it('无效输入返回 null 而不抛', () => {
    expect(regexFromString('')).toBeNull();
    expect(regexFromString('/(/g')).toBeNull();
    // 'U' 是合法 flag 字符但 JS 不认，new RegExp 抛错后返回 null
    expect(regexFromString('/foo/U')).toBeNull();
  });
});

describe('escapeRegex / sanitizeRegexMacro', () => {
  it('escapeRegex 转义元字符', () => {
    expect(escapeRegex('a.b*c')).toBe('a\\.b\\*c');
  });

  it('sanitizeRegexMacro 把控制字符转成转义序列', () => {
    expect(sanitizeRegexMacro('a.b')).toBe('a\\.b');
    expect(sanitizeRegexMacro('a\nb\tc')).toBe('a\\nb\\tc');
    expect(sanitizeRegexMacro('a\\b')).toBe('a\\\\b');
  });
});

describe('shouldRunRegexScript 过滤', () => {
  it('placement 不含当前位置时跳过', () => {
    expect(shouldRunRegexScript(makeScript({ placement: [1] }), makeCtx({ placement: 2 }))).toBe(
      false,
    );
    expect(shouldRunRegexScript(makeScript({ placement: [1, 2] }), makeCtx({ placement: 2 }))).toBe(
      true,
    );
  });

  it('disabled 跳过', () => {
    expect(shouldRunRegexScript(makeScript({ disabled: true }), makeCtx())).toBe(false);
  });

  it('markdownOnly 只在 display 生效，promptOnly 只在 prompt 生效', () => {
    const md = makeScript({ markdownOnly: true });
    const prompt = makeScript({ promptOnly: true });
    expect(shouldRunRegexScript(md, makeCtx({ direction: 'display' }))).toBe(true);
    expect(shouldRunRegexScript(md, makeCtx({ direction: 'prompt' }))).toBe(false);
    expect(shouldRunRegexScript(md, makeCtx({ direction: 'stored' }))).toBe(false);
    expect(shouldRunRegexScript(prompt, makeCtx({ direction: 'prompt' }))).toBe(true);
    expect(shouldRunRegexScript(prompt, makeCtx({ direction: 'display' }))).toBe(false);
  });

  it('「两者」脚本在三个方向上都生效（见契约 §9 RX-1）', () => {
    const both = makeScript();
    for (const direction of ['prompt', 'display', 'stored'] as const) {
      expect(shouldRunRegexScript(both, makeCtx({ direction }))).toBe(true);
    }
  });

  it('isEdit 且 runOnEdit 为假时跳过', () => {
    expect(shouldRunRegexScript(makeScript({ runOnEdit: false }), makeCtx({ isEdit: true }))).toBe(
      false,
    );
    expect(shouldRunRegexScript(makeScript({ runOnEdit: true }), makeCtx({ isEdit: true }))).toBe(
      true,
    );
    expect(shouldRunRegexScript(makeScript({ runOnEdit: false }), makeCtx())).toBe(true);
  });

  it('min/maxDepth 只在给了 depth 时生效', () => {
    const script = makeScript({ minDepth: 2, maxDepth: 4 });
    expect(shouldRunRegexScript(script, makeCtx())).toBe(true);
    expect(shouldRunRegexScript(script, makeCtx({ depth: 1 }))).toBe(false);
    expect(shouldRunRegexScript(script, makeCtx({ depth: 2 }))).toBe(true);
    expect(shouldRunRegexScript(script, makeCtx({ depth: 4 }))).toBe(true);
    expect(shouldRunRegexScript(script, makeCtx({ depth: 5 }))).toBe(false);
  });

  it('minDepth 小于 -1 或为 null 时忽略下界', () => {
    expect(shouldRunRegexScript(makeScript({ minDepth: -2 }), makeCtx({ depth: 0 }))).toBe(true);
    expect(shouldRunRegexScript(makeScript({ minDepth: null }), makeCtx({ depth: 0 }))).toBe(true);
    // maxDepth 为负数时同样忽略上界
    expect(shouldRunRegexScript(makeScript({ maxDepth: -1 }), makeCtx({ depth: 9 }))).toBe(true);
  });
});

describe('runRegexScript', () => {
  it('{{match}} 等价于 $0', () => {
    const script = makeScript({ findRegex: '/\\w+/g', replaceString: '[{{match}}]' });
    expect(runRegexScript(script, 'ab cd', makeCtx())).toBe('[ab] [cd]');
  });

  it('编号捕获组与命名捕获组', () => {
    const numbered = makeScript({ findRegex: '/(\\w+): (\\w+)/g', replaceString: '$2=$1' });
    expect(runRegexScript(numbered, 'hp: 12', makeCtx())).toBe('12=hp');

    const named = makeScript({
      findRegex: '/(?<key>\\w+): (?<value>\\w+)/g',
      replaceString: '$<value>=$<key>',
    });
    expect(runRegexScript(named, 'hp: 12', makeCtx())).toBe('12=hp');
  });

  it('不存在的捕获组替换为空串', () => {
    const script = makeScript({ findRegex: '/(a)/g', replaceString: '[$1$2]' });
    expect(runRegexScript(script, 'a', makeCtx())).toBe('[a]');
  });

  it('trimStrings 对每个捕获组生效，且自身先过宏替换', () => {
    const script = makeScript({
      findRegex: '/<(.+?)>/g',
      replaceString: '$1',
      trimStrings: ['噪音', '{{user}}'],
    });
    const ctx = makeCtx({ substitute: (text) => text.replaceAll('{{user}}', 'Ren') });
    expect(runRegexScript(script, '<噪音正文Ren噪音>', ctx)).toBe('正文');
  });

  it('替换结果整体再过一次宏', () => {
    const script = makeScript({ findRegex: '/x/g', replaceString: '{{user}}' });
    const ctx = makeCtx({ substitute: (text) => text.replaceAll('{{user}}', 'Ren') });
    expect(runRegexScript(script, 'x', ctx)).toBe('Ren');
  });

  it('substituteRegex：NONE 不替换 find 里的宏', () => {
    const script = makeScript({ findRegex: '/{{word}}/g', replaceString: 'Y', substituteRegex: 0 });
    const ctx = makeCtx({ substitute: (text) => text.replaceAll('{{word}}', 'a.b') });
    expect(runRegexScript(script, '{{word}} axb a.b', ctx)).toBe('Y axb a.b');
  });

  it('substituteRegex：RAW 让宏结果当正则片段用', () => {
    const script = makeScript({ findRegex: '/{{word}}/g', replaceString: 'Y', substituteRegex: 1 });
    const ctx = makeCtx({ substitute: (text) => text.replaceAll('{{word}}', 'a.b') });
    expect(runRegexScript(script, 'axb a.b', ctx)).toBe('Y Y');
  });

  it('substituteRegex：ESCAPED 只转义宏结果，不动正则本身', () => {
    const script = makeScript({
      findRegex: '/({{word}})+/g',
      replaceString: 'Y',
      substituteRegex: 2,
    });
    const ctx = makeCtx({
      substitute: (text, postProcess) =>
        text.replaceAll('{{word}}', () => (postProcess ? postProcess('a.b') : 'a.b')),
    });
    // `+` 量词仍然有效，但宏里的 `.` 被转义成字面点
    expect(runRegexScript(script, 'axb a.ba.b', ctx)).toBe('axb Y');
  });

  it('无效正则不抛，返回原文并触发 onError', () => {
    const onError = vi.fn();
    const script = makeScript({ findRegex: '/(/g' });
    expect(runRegexScript(script, 'abc', makeCtx({ onError }))).toBe('abc');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBe(script);
  });

  it('disabled / 空 findRegex / 空文本时原样返回', () => {
    expect(runRegexScript(makeScript({ disabled: true }), 'aaa', makeCtx())).toBe('aaa');
    expect(runRegexScript(makeScript({ findRegex: '' }), 'aaa', makeCtx())).toBe('aaa');
    expect(runRegexScript(makeScript(), '', makeCtx())).toBe('');
  });

  it('没有 g flag 时只替换第一处', () => {
    expect(runRegexScript(makeScript({ findRegex: '/a/' }), 'aaa', makeCtx())).toBe('baa');
  });
});

describe('applyRegexScripts', () => {
  it('按数组顺序依次应用，后一条能看到前一条的结果', () => {
    const first = makeScript({ id: '1', findRegex: '/a/g', replaceString: 'b' });
    const second = makeScript({ id: '2', findRegex: '/b/g', replaceString: 'c' });
    expect(applyRegexScripts([first, second], 'a', makeCtx())).toBe('c');
    expect(applyRegexScripts([second, first], 'a', makeCtx())).toBe('b');
  });

  it('跳过不匹配过滤条件的脚本', () => {
    const scripts = [
      makeScript({ id: '1', placement: [1], findRegex: '/a/g', replaceString: 'X' }),
      makeScript({ id: '2', markdownOnly: true, findRegex: '/a/g', replaceString: 'Y' }),
      makeScript({ id: '3', promptOnly: true, findRegex: '/a/g', replaceString: 'Z' }),
    ];
    expect(applyRegexScripts(scripts, 'a', makeCtx({ placement: 2, direction: 'prompt' }))).toBe(
      'Z',
    );
    expect(applyRegexScripts(scripts, 'a', makeCtx({ placement: 2, direction: 'display' }))).toBe(
      'Y',
    );
  });

  it('空文本直接返回', () => {
    expect(applyRegexScripts([makeScript()], '', makeCtx())).toBe('');
  });

  it('一条脚本正则无效时只跳过它', () => {
    const onError = vi.fn();
    const scripts = [
      makeScript({ id: 'bad', findRegex: '/(/g' }),
      makeScript({ id: 'good', findRegex: '/a/g', replaceString: 'b' }),
    ];
    expect(applyRegexScripts(scripts, 'a', makeCtx({ onError }))).toBe('b');
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
