import { describe, expect, it } from 'vitest';

import {
  applyWorldbookEntryColumns,
  buildWorldbook,
  listWorldbookEntries,
  parseWorldbook,
  serializeWorldbook,
  toWorldbookEntryColumns,
} from './worldbook.js';

const stEntry = {
  uid: 3,
  key: ['旅店', 'inn'],
  keysecondary: ['夜晚'],
  comment: '城东旅店',
  content: '旅店在城东。',
  constant: false,
  vectorized: false,
  selective: true,
  selectiveLogic: 1,
  addMemo: true,
  order: 90,
  position: 4,
  disable: false,
  excludeRecursion: true,
  preventRecursion: false,
  delayUntilRecursion: false,
  probability: 75,
  useProbability: true,
  depth: 2,
  group: '地点',
  groupOverride: false,
  groupWeight: 100,
  scanDepth: null,
  caseSensitive: null,
  matchWholeWords: true,
  useGroupScoring: null,
  automationId: '',
  role: 1,
  sticky: 2,
  cooldown: null,
  delay: 0,
  displayIndex: 0,
  characterFilter: { isExclude: false, names: [], tags: [] },
  triggers: [],
};

const stBook = {
  name: '测试世界',
  entries: {
    '3': stEntry,
    '7': {
      uid: 7,
      key: ['传说'],
      keysecondary: [],
      content: '古老的传说',
      constant: true,
      order: 100,
      position: 0,
      disable: true,
    },
  },
  originalData: { name: '测试世界', entries: [] },
};

const characterBookEntry = {
  keys: ['森林'],
  secondary_keys: [],
  content: '森林很暗。',
  enabled: false,
  insertion_order: 50,
  position: 'after_char',
  case_sensitive: true,
  extensions: { depth: 4 },
};

describe('ST 世界书', () => {
  it('对象形态往返 deep-equal', () => {
    const book = parseWorldbook(stBook);
    expect(JSON.parse(serializeWorldbook(book))).toEqual(stBook);
  });

  it('数组形态可解析并往返', () => {
    const arrayBook = { name: '内嵌', entries: [characterBookEntry], scan_depth: 3 };
    const book = parseWorldbook(arrayBook);
    const { form, items } = listWorldbookEntries(book);
    expect(form).toBe('array');
    expect(items[0]?.key).toBe('0');
    const { entries: _entries, ...meta } = book;
    expect(buildWorldbook(meta, form, items)).toEqual(arrayBook);
  });

  it('list → build 还原对象形态（保留 key）', () => {
    const book = parseWorldbook(stBook);
    const { form, items } = listWorldbookEntries(book);
    expect(items.map((i) => i.key)).toEqual(['3', '7']);
    const { entries: _entries, ...meta } = book;
    expect(buildWorldbook(meta, form, items)).toEqual(stBook);
  });

  it('ST 原生条目派生列', () => {
    const columns = toWorldbookEntryColumns(stEntry);
    expect(columns).toMatchObject({
      uid: 3,
      keys: ['旅店', 'inn'],
      secondaryKeys: ['夜晚'],
      comment: '城东旅店',
      selective: true,
      selectiveLogic: 1,
      entryOrder: 90,
      position: 4,
      disabled: false,
      probability: 75,
      depth: 2,
      group: '地点',
      scanDepth: null,
      matchWholeWords: true,
      role: 'user',
      sticky: 2,
      delay: 0,
      excludeRecursion: true,
      displayIndex: 0,
    });
  });

  it('character_book 条目派生列', () => {
    const columns = toWorldbookEntryColumns(characterBookEntry);
    expect(columns).toMatchObject({
      keys: ['森林'],
      entryOrder: 50,
      position: 1,
      disabled: true,
      caseSensitive: true,
      uid: null,
      comment: null,
    });
  });

  it('未编辑时写回列无损；编辑时沿用原字段名', () => {
    expect(applyWorldbookEntryColumns(stEntry, toWorldbookEntryColumns(stEntry))).toEqual(stEntry);
    expect(
      applyWorldbookEntryColumns(characterBookEntry, toWorldbookEntryColumns(characterBookEntry)),
    ).toEqual(characterBookEntry);

    const editedSt = applyWorldbookEntryColumns(stEntry, {
      keys: ['客栈'],
      disabled: true,
      role: 'assistant',
      scanDepth: 5,
    });
    expect(editedSt).toEqual({ ...stEntry, key: ['客栈'], disable: true, role: 2, scanDepth: 5 });

    const editedCb = applyWorldbookEntryColumns(characterBookEntry, {
      keys: ['树林'],
      disabled: false,
      entryOrder: 10,
    });
    expect(editedCb).toEqual({
      ...characterBookEntry,
      keys: ['树林'],
      enabled: true,
      insertion_order: 10,
    });
  });

  it('非法输入报中文错', () => {
    expect(() => parseWorldbook('x')).toThrow(/必须是对象/);
    expect(() => parseWorldbook({ name: '无条目' })).toThrow(/ST 世界书解析失败/);
  });
});
