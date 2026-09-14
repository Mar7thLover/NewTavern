/**
 * 世界书引擎测试（契约 §1.3）：扫描缓冲、键匹配、selective、概率、组、递归、预算、分桶。
 * 时间态在 timed.test.ts，装饰器在 decorators.test.ts。
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_DEPTH, sortActivations } from './engine.js';
import {
  activatedIds,
  makeBook,
  makeEntry,
  makeSettings,
  rejectionOf,
  runScan,
  userMessage,
} from './test-helpers.js';

describe('扫描缓冲', () => {
  const entries = [makeEntry({ id: 'e1', keys: ['apple'] })];
  // 历史是 root→parent 顺序，最后一条最新；缓冲取最近 scanDepth 条
  const history = [userMessage('apple pie'), userMessage('hello'), userMessage('world')];

  it('只扫描最近 scanDepth 条消息', () => {
    expect(activatedIds(runScan({ books: [makeBook(entries)], history }))).toEqual([]);
    expect(
      activatedIds(
        runScan({ books: [makeBook(entries)], history, settings: makeSettings({ scanDepth: 3 }) }),
      ),
    ).toEqual(['e1']);
  });

  it('条目自己的 scanDepth 覆盖全局设置', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['apple'], scanDepth: 3 })])];
    expect(activatedIds(runScan({ books, history }))).toEqual(['e1']);
  });

  it('条目 scanDepth 为 0 时什么都扫不到（ST：startDepth 恒为 0）', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['world'], scanDepth: 0 })])];
    expect(activatedIds(runScan({ books, history }))).toEqual([]);
  });

  it('includeNames 时扫描缓冲带「名字: 」前缀', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['Alice'] })])];
    const named = [userMessage('hello there', 'Alice')];
    expect(activatedIds(runScan({ books, history: named }))).toEqual([]);
    expect(
      activatedIds(
        runScan({
          books,
          history: named,
          settings: makeSettings({ includeNames: true }),
        }),
      ),
    ).toEqual(['e1']);
  });

  it('match* 开关把角色卡/persona 字段并入扫描源', () => {
    const globalScan = { characterDescription: 'a tired detective', personaDescription: 'a cat' };
    const plain = [makeEntry({ id: 'e1', keys: ['detective'] })];
    const matching = [
      makeEntry({ id: 'e1', keys: ['detective'], matchCharacterDescription: true }),
    ];
    expect(activatedIds(runScan({ books: [makeBook(plain)], globalScan }))).toEqual([]);
    expect(activatedIds(runScan({ books: [makeBook(matching)], globalScan }))).toEqual(['e1']);
  });

  it('injects 里的注入文本也进扫描缓冲', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['injected'] })])];
    expect(activatedIds(runScan({ books, injects: ['this is injected'] }))).toEqual(['e1']);
  });
});

describe('键匹配', () => {
  it('默认大小写不敏感，条目级 caseSensitive 覆盖全局', () => {
    const history = [userMessage('The DRAGON roars')];
    const loose = [makeEntry({ id: 'e1', keys: ['dragon'] })];
    const strict = [makeEntry({ id: 'e1', keys: ['dragon'], caseSensitive: true })];
    expect(activatedIds(runScan({ books: [makeBook(loose)], history }))).toEqual(['e1']);
    expect(activatedIds(runScan({ books: [makeBook(strict)], history }))).toEqual([]);
  });

  it('matchWholeWords 用 \\W 边界，不匹配词内子串', () => {
    const settings = makeSettings({ matchWholeWords: true });
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['cat'] })])];
    expect(
      activatedIds(runScan({ books, history: [userMessage('concatenate')], settings })),
    ).toEqual([]);
    expect(
      activatedIds(runScan({ books, history: [userMessage('a cat, here')], settings })),
    ).toEqual(['e1']);
  });

  it('整词匹配下多词键退化为子串匹配（ST 行为）', () => {
    const settings = makeSettings({ matchWholeWords: true });
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['black cat'] })])];
    expect(
      activatedIds(runScan({ books, history: [userMessage('a blackblack cat!')], settings })),
    ).toEqual(['e1']);
  });

  it('CJK 整词匹配：汉字两侧都是 \\W，键照常命中', () => {
    const settings = makeSettings({ matchWholeWords: true });
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['苹果'] })])];
    expect(
      activatedIds(runScan({ books, history: [userMessage('我今天吃苹果了')], settings })),
    ).toEqual(['e1']);
    // 紧邻 ASCII 单词字符时才失败，这是 ST 的已知边界行为
    expect(activatedIds(runScan({ books, history: [userMessage('x苹果y')], settings }))).toEqual(
      [],
    );
  });

  it('消息开头的键也能整词命中（ST 用 \\x01 作分隔符）', () => {
    const settings = makeSettings({ matchWholeWords: true });
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['cat'] })])];
    expect(activatedIds(runScan({ books, history: [userMessage('cat sat')], settings }))).toEqual([
      'e1',
    ]);
  });

  it('`/re/flags` 形式的键走正则并覆盖大小写与整词设置', () => {
    const settings = makeSettings({ matchWholeWords: true, caseSensitive: true });
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['/cat/i'] })])];
    expect(
      activatedIds(runScan({ books, history: [userMessage('CONCATENATE')], settings })),
    ).toEqual(['e1']);
  });

  it('非法正则形式的键按普通子串处理', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['/unclosed'] })])];
    expect(activatedIds(runScan({ books, history: [userMessage('a /unclosed key')] }))).toEqual([
      'e1',
    ]);
  });

  it('键与内容都过 substitute（ST substituteParams）', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', keys: ['{{char}}'], content: '{{char}} is here' })]),
    ];
    const result = runScan({
      books,
      history: [userMessage('Seraphine waves')],
      substitute: (text) => text.replaceAll('{{char}}', 'Seraphine'),
    });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.activations[0]?.content).toBe('Seraphine is here');
    expect(result.activations[0]?.matchedKeys).toEqual(['{{char}}']);
  });

  it('没有键的非 constant 条目永远不激活', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: [] })])];
    expect(activatedIds(runScan({ books, history: [userMessage('anything')] }))).toEqual([]);
  });
});

describe('selective 与副键逻辑', () => {
  const history = [userMessage('the red fox')];
  const scanWith = (selectiveLogic: 0 | 1 | 2 | 3, secondaryKeys: string[]) =>
    activatedIds(
      runScan({
        books: [makeBook([makeEntry({ id: 'e1', keys: ['fox'], secondaryKeys, selectiveLogic })])],
        history,
      }),
    );

  it('AND_ANY：任一副键命中即可', () => {
    expect(scanWith(0, ['red', 'blue'])).toEqual(['e1']);
    expect(scanWith(0, ['blue'])).toEqual([]);
  });

  it('NOT_ALL：存在未命中的副键即可', () => {
    expect(scanWith(1, ['red', 'blue'])).toEqual(['e1']);
    expect(scanWith(1, ['red'])).toEqual([]);
  });

  it('NOT_ANY：所有副键都不命中', () => {
    expect(scanWith(2, ['blue', 'green'])).toEqual(['e1']);
    expect(scanWith(2, ['red'])).toEqual([]);
  });

  it('AND_ALL：所有副键都命中', () => {
    expect(scanWith(3, ['red', 'the'])).toEqual(['e1']);
    expect(scanWith(3, ['red', 'blue'])).toEqual([]);
  });

  it('副键为空时忽略 selective', () => {
    expect(scanWith(3, [])).toEqual(['e1']);
  });

  it('selective 为 false 时不检查副键', () => {
    const books = [
      makeBook([
        makeEntry({
          id: 'e1',
          keys: ['fox'],
          secondaryKeys: ['blue'],
          selective: false,
          selectiveLogic: 0,
        }),
      ]),
    ];
    expect(activatedIds(runScan({ books, history }))).toEqual(['e1']);
  });
});

describe('constant / disabled / vectorized', () => {
  it('constant 条目无需键即可激活，reason 为 constant', () => {
    const result = runScan({ books: [makeBook([makeEntry({ id: 'e1', constant: true })])] });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.activations[0]?.reason).toBe('constant');
  });

  it('disabled 条目永不激活并记入 rejected', () => {
    const books = [makeBook([makeEntry({ id: 'e1', constant: true, disabled: true })])];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual([]);
    expect(rejectionOf(result, 'e1')).toEqual(['disabled']);
  });

  it('vectorized 条目照常参与键匹配（ST 1.18 的 checkWorldInfo 不读该字段）', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['apple'], vectorized: true })])];
    expect(activatedIds(runScan({ books, history: [userMessage('apple')] }))).toEqual(['e1']);
  });

  it('triggers 过滤生成类型', () => {
    const books = [makeBook([makeEntry({ id: 'e1', constant: true, triggers: ['continue'] })])];
    expect(activatedIds(runScan({ books }))).toEqual([]);
    expect(activatedIds(runScan({ books, trigger: 'continue' }))).toEqual(['e1']);
  });

  it('characterFilter 按角色名白/黑名单过滤', () => {
    const white = [
      makeEntry({
        id: 'e1',
        constant: true,
        characterFilter: { isExclude: false, names: ['Seraphine'], tags: [] },
      }),
    ];
    expect(activatedIds(runScan({ books: [makeBook(white)], characterName: 'Ren' }))).toEqual([]);
    expect(activatedIds(runScan({ books: [makeBook(white)], characterName: 'Seraphine' }))).toEqual(
      ['e1'],
    );
  });
});

describe('概率', () => {
  it('useProbability 且 probability < 100 时按注入的随机数判定', () => {
    const books = [
      makeBook([makeEntry({ id: 'e1', constant: true, useProbability: true, probability: 40 })]),
    ];
    // random 0.5 → roll 50 > 40 → 落选
    const failed = runScan({ books });
    expect(activatedIds(failed)).toEqual([]);
    expect(rejectionOf(failed, 'e1')).toEqual(['probability']);
    // roll 50 <= 60 → 通过
    const passed = runScan({
      books: [
        makeBook([makeEntry({ id: 'e1', constant: true, useProbability: true, probability: 60 })]),
      ],
    });
    expect(activatedIds(passed)).toEqual(['e1']);
  });

  it('未开启 useProbability 或 probability 为 100 时不摇骰', () => {
    const books = [makeBook([makeEntry({ id: 'e1', constant: true, probability: 1 })])];
    expect(activatedIds(runScan({ books, random: () => 0.99 }))).toEqual(['e1']);
  });
});

describe('包含组', () => {
  const history = [userMessage('a cat and a dog')];

  it('组内加权随机只留一个', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g', order: 200 }),
        makeEntry({ id: 'b', keys: ['cat'], group: 'g', order: 100 }),
      ]),
    ];
    expect(activatedIds(runScan({ books, history, random: () => 0.1 }))).toEqual(['a']);
    expect(activatedIds(runScan({ books, history, random: () => 0.9 }))).toEqual(['b']);
  });

  it('groupOverride（prioritize）优先于权重随机', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g', order: 200 }),
        makeEntry({ id: 'b', keys: ['cat'], group: 'g', order: 100, groupOverride: true }),
      ]),
    ];
    const result = runScan({ books, history, random: () => 0.1 });
    expect(activatedIds(result)).toEqual(['b']);
    expect(rejectionOf(result, 'a')).toEqual(['group-lost']);
    expect(result.activations[0]?.groupWinner).toBe(true);
  });

  it('useGroupScoring 时命中键数最高者胜出', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g', order: 200 }),
        makeEntry({ id: 'b', keys: ['cat', 'dog'], group: 'g', order: 100 }),
      ]),
    ];
    const settings = makeSettings({ useGroupScoring: true });
    expect(activatedIds(runScan({ books, history, settings, random: () => 0.1 }))).toEqual(['b']);
    // 关掉评分后回到加权随机
    expect(activatedIds(runScan({ books, history, random: () => 0.1 }))).toEqual(['a']);
  });

  it('条目级 useGroupScoring 也能开启评分', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g', order: 200, useGroupScoring: true }),
        makeEntry({ id: 'b', keys: ['cat', 'dog'], group: 'g', order: 100, useGroupScoring: true }),
      ]),
    ];
    expect(activatedIds(runScan({ books, history, random: () => 0.1 }))).toEqual(['b']);
  });

  it('groupWeight 影响随机结果', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g', order: 200, groupWeight: 10 }),
        makeEntry({ id: 'b', keys: ['cat'], group: 'g', order: 100, groupWeight: 90 }),
      ]),
    ];
    // roll = 0.5 * 100 = 50 > 10 → b 胜
    expect(activatedIds(runScan({ books, history, random: () => 0.5 }))).toEqual(['b']);
    // roll = 0.05 * 100 = 5 <= 10 → a 胜
    expect(activatedIds(runScan({ books, history, random: () => 0.05 }))).toEqual(['a']);
  });

  it('不同组互不影响', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['cat'], group: 'g1', order: 200 }),
        makeEntry({ id: 'b', keys: ['cat'], group: 'g2', order: 100 }),
      ]),
    ];
    expect(activatedIds(runScan({ books, history }))).toEqual(['a', 'b']);
  });
});

describe('递归', () => {
  const chain = [
    makeEntry({ id: 'a', keys: ['alpha'], content: 'mentions beta', order: 300 }),
    makeEntry({ id: 'b', keys: ['beta'], content: 'mentions gamma', order: 200 }),
    makeEntry({ id: 'c', keys: ['gamma'], content: 'the end', order: 100 }),
  ];
  const history = [userMessage('alpha')];

  it('关闭 recursive 时只激活第一层', () => {
    expect(activatedIds(runScan({ books: [makeBook(chain)], history }))).toEqual(['a']);
  });

  it('开启 recursive 时逐层激活并收敛，recursionLevel 递增', () => {
    const result = runScan({
      books: [makeBook(chain)],
      history,
      settings: makeSettings({ recursive: true }),
    });
    expect(activatedIds(result)).toEqual(['a', 'b', 'c']);
    expect(result.activations.map((item) => item.recursionLevel)).toEqual([0, 1, 2]);
    expect(result.activations.map((item) => item.reason)).toEqual([
      'key',
      'recursion',
      'recursion',
    ]);
  });

  it('preventRecursion 的条目内容不进递归缓冲', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['alpha'], content: 'mentions beta', preventRecursion: true }),
        makeEntry({ id: 'b', keys: ['beta'], content: 'x' }),
      ]),
    ];
    expect(
      activatedIds(runScan({ books, history, settings: makeSettings({ recursive: true }) })),
    ).toEqual(['a']);
  });

  it('excludeRecursion 的条目不会被递归激活', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['alpha'], content: 'mentions beta', order: 200 }),
        makeEntry({ id: 'b', keys: ['beta'], content: 'x', excludeRecursion: true, order: 100 }),
      ]),
    ];
    const result = runScan({ books, history, settings: makeSettings({ recursive: true }) });
    expect(activatedIds(result)).toEqual(['a']);
    expect(rejectionOf(result, 'b')).toEqual(['exclude-recursion']);
  });

  it('maxRecursionSteps 限制扫描轮数', () => {
    const result = runScan({
      books: [makeBook(chain)],
      history,
      settings: makeSettings({ recursive: true, maxRecursionSteps: 2 }),
    });
    expect(activatedIds(result)).toEqual(['a', 'b']);
  });

  it('delayUntilRecursion 的条目只在递归轮激活', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['alpha'], order: 200 }),
        makeEntry({ id: 'd', keys: ['alpha'], delayUntilRecursion: true, order: 100 }),
      ]),
    ];
    // 只有一个延迟层级时，它在开扫前就被 shift 成了「当前层级」，队列已空，
    // 所以不开 recursive 就永远不会有递归轮，条目也就永远不激活（ST 行为）
    const withoutRecursion = runScan({ books, history });
    expect(activatedIds(withoutRecursion)).toEqual(['a']);
    expect(rejectionOf(withoutRecursion, 'd')).toEqual(['delay-until-recursion']);

    const result = runScan({ books, history, settings: makeSettings({ recursive: true }) });
    expect(activatedIds(result)).toEqual(['a', 'd']);
    expect(result.activations[1]?.recursionLevel).toBe(1);
    // 首轮的压制只是中间状态，最终激活了就不该留在 rejected 里
    expect(rejectionOf(result, 'd')).toEqual([]);
  });

  it('还有未开闸的 delayUntilRecursion 层级时会补一轮递归扫描', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'l1', keys: ['alpha'], delayUntilRecursion: 1, order: 300 }),
        makeEntry({ id: 'l2', keys: ['alpha'], delayUntilRecursion: 2, order: 200 }),
      ]),
    ];
    // 层级队列 [1,2]：开扫前取走 1，首轮两者都被压制；首轮结束时队列还剩 2，
    // 于是强制补一轮递归扫描并把当前层级抬到 2，两个条目在同一轮一起开闸
    const result = runScan({ books, history });
    expect(activatedIds(result)).toEqual(['l1', 'l2']);
    expect(result.activations.map((item) => item.recursionLevel)).toEqual([1, 1]);
  });

  it('minActivations 在激活不足时逐步加深扫描', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['apple'] })])];
    const history = [userMessage('apple pie'), userMessage('hello')];
    const settings = makeSettings({ scanDepth: 1 });
    expect(activatedIds(runScan({ books, history, settings }))).toEqual([]);

    const result = runScan({
      books,
      history,
      settings: makeSettings({ scanDepth: 1, minActivations: 1 }),
    });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.activations[0]?.reason).toBe('minActivations');
  });

  it('minActivationsDepthMax 限制加深的上限', () => {
    const books = [makeBook([makeEntry({ id: 'e1', keys: ['apple'] })])];
    const history = [userMessage('apple'), userMessage('b'), userMessage('c'), userMessage('d')];
    const settings = makeSettings({ scanDepth: 1, minActivations: 1, minActivationsDepthMax: 2 });
    expect(activatedIds(runScan({ books, history, settings }))).toEqual([]);
  });
});

describe('预算', () => {
  const tenChars = '0123456789';

  it('超出预算的条目被拒，overflowed 置位', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', constant: true, content: tenChars, order: 300 }),
        makeEntry({ id: 'b', constant: true, content: tenChars, order: 200 }),
      ]),
    ];
    const result = runScan({ books, settings: makeSettings({ budgetTokens: 15 }) });
    expect(activatedIds(result)).toEqual(['a']);
    expect(rejectionOf(result, 'b')).toEqual(['budget']);
    expect(result.overflowed).toBe(true);
  });

  it('ignoreBudget 的条目在溢出后仍然加入', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', constant: true, content: tenChars, order: 300 }),
        makeEntry({ id: 'b', constant: true, content: tenChars, order: 200 }),
        makeEntry({ id: 'c', constant: true, content: tenChars, order: 100, ignoreBudget: true }),
        makeEntry({ id: 'd', constant: true, content: tenChars, order: 50 }),
      ]),
    ];
    const result = runScan({ books, settings: makeSettings({ budgetTokens: 15 }) });
    expect(activatedIds(result)).toEqual(['a', 'c']);
    expect(rejectionOf(result, 'd')).toEqual(['budget']);
  });

  it('budgetCap 收紧预算', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', constant: true, content: tenChars, order: 300 }),
        makeEntry({ id: 'b', constant: true, content: tenChars, order: 200 }),
      ]),
    ];
    const result = runScan({
      books,
      settings: makeSettings({ budgetTokens: 1000, budgetCap: 15 }),
    });
    expect(activatedIds(result)).toEqual(['a']);
  });

  it('overflowAlert 产生一条警告', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', constant: true, content: tenChars, order: 300 }),
        makeEntry({ id: 'b', constant: true, content: tenChars, order: 200 }),
      ]),
    ];
    const result = runScan({
      books,
      settings: makeSettings({ budgetTokens: 15, overflowAlert: true }),
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.budgetUsed).toBe(11);
  });

  it('预算溢出会中止递归', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'a', keys: ['alpha'], content: 'beta ' + tenChars, order: 300 }),
        makeEntry({ id: 'b', keys: ['beta'], content: tenChars, order: 200 }),
      ]),
    ];
    const result = runScan({
      books,
      history: [userMessage('alpha')],
      settings: makeSettings({ recursive: true, budgetTokens: 5 }),
    });
    expect(activatedIds(result)).toEqual([]);
    expect(result.overflowed).toBe(true);
  });
});

describe('排序与分桶', () => {
  it('activations 按 order 降序，桶内按 ST 的插入顺序（order 升序）', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'low', constant: true, order: 100, position: 0 }),
        makeEntry({ id: 'high', constant: true, order: 300, position: 0 }),
      ]),
    ];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual(['high', 'low']);
    expect(result.buckets.before.map((item) => item.entry.id)).toEqual(['low', 'high']);
  });

  it('各 position 落到对应的桶', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'p0', constant: true, position: 0 }),
        makeEntry({ id: 'p1', constant: true, position: 1 }),
        makeEntry({ id: 'p2', constant: true, position: 2 }),
        makeEntry({ id: 'p3', constant: true, position: 3 }),
        makeEntry({ id: 'p5', constant: true, position: 5 }),
        makeEntry({ id: 'p6', constant: true, position: 6 }),
        makeEntry({ id: 'p7', constant: true, position: 7, outletName: 'notes' }),
      ]),
    ];
    const { buckets } = runScan({ books });
    expect(buckets.before.map((item) => item.entry.id)).toEqual(['p0']);
    expect(buckets.after.map((item) => item.entry.id)).toEqual(['p1']);
    expect(buckets.anTop.map((item) => item.entry.id)).toEqual(['p2']);
    expect(buckets.anBottom.map((item) => item.entry.id)).toEqual(['p3']);
    expect(buckets.emBefore.map((item) => item.entry.id)).toEqual(['p5']);
    expect(buckets.emAfter.map((item) => item.entry.id)).toEqual(['p6']);
    expect(buckets.outlets['notes']?.map((item) => item.entry.id)).toEqual(['p7']);
  });

  it('position 4 按 (depth, role) 合并分桶，depth 缺省为 4', () => {
    const books = [
      makeBook([
        makeEntry({ id: 'd4a', constant: true, position: 4, depth: 4, order: 300 }),
        makeEntry({ id: 'd2u', constant: true, position: 4, depth: 2, role: 1, order: 200 }),
        makeEntry({ id: 'd4b', constant: true, position: 4, order: 100 }),
      ]),
    ];
    const { buckets } = runScan({ books });
    expect(buckets.depth).toHaveLength(2);
    expect(buckets.depth[0]).toMatchObject({ depth: DEFAULT_DEPTH, role: 0 });
    expect(buckets.depth[0]?.entries.map((item) => item.entry.id)).toEqual(['d4b', 'd4a']);
    expect(buckets.depth[1]).toMatchObject({ depth: 2, role: 1 });
  });

  it('内容为空的条目仍在 activations 里但不进桶', () => {
    const books = [makeBook([makeEntry({ id: 'e1', constant: true, content: '' })])];
    const result = runScan({ books });
    expect(activatedIds(result)).toEqual(['e1']);
    expect(result.buckets.before).toEqual([]);
    expect(rejectionOf(result, 'e1')).toEqual(['empty-content']);
  });

  it('出口条目缺少出口名时告警', () => {
    const books = [makeBook([makeEntry({ id: 'e1', constant: true, position: 7 })])];
    const result = runScan({ books });
    expect(result.buckets.outlets).toEqual({});
    expect(result.warnings).toHaveLength(1);
  });

  it('sortActivations 稳定且按 order 降序', () => {
    const result = runScan({
      books: [
        makeBook([
          makeEntry({ id: 'a', constant: true, order: 100 }),
          makeEntry({ id: 'b', constant: true, order: 100 }),
          makeEntry({ id: 'c', constant: true, order: 500 }),
        ]),
      ],
    });
    expect(sortActivations(result.activations).map((item) => item.entry.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('按作用域排序：聊天书 → persona 书 → 角色书 → 全局书（character_first）', () => {
    const books = [
      makeBook([makeEntry({ id: 'g', constant: true })], 'global', 'gb'),
      makeBook([makeEntry({ id: 'c', constant: true })], 'char', 'cb'),
      makeBook([makeEntry({ id: 'ch', constant: true })], 'chat', 'chb'),
      makeBook([makeEntry({ id: 'p', constant: true })], 'persona', 'pb'),
    ];
    // 同 order 时 ST 的插入顺序是排序结果的逆序
    expect(runScan({ books }).buckets.before.map((item) => item.entry.id)).toEqual([
      'g',
      'c',
      'p',
      'ch',
    ]);
    expect(
      runScan({ books, settings: makeSettings({ characterStrategy: 2 }) }).buckets.before.map(
        (item) => item.entry.id,
      ),
    ).toEqual(['c', 'g', 'p', 'ch']);
  });

  it('source 与 bookId 从书上回填', () => {
    const result = runScan({
      books: [makeBook([makeEntry({ id: 'e1', constant: true })], 'chat')],
    });
    expect(result.activations[0]?.entry.source).toEqual({ bookName: 'book-1-name', scope: 'chat' });
  });

  it('没有任何条目时返回空结果', () => {
    const result = runScan({ books: [] });
    expect(result.activations).toEqual([]);
    expect(result.budgetUsed).toBe(0);
    expect(result.newState.messageCount).toBe(0);
  });
});
