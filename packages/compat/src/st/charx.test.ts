import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import type { V3Card } from './card.js';
import { readCharx, resolveEmbeddedUri, writeCharx } from './charx.js';

const card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '包装角色',
    description: '描述',
    personality: '',
    scenario: '',
    first_mes: '你好',
    mes_example: '',
    extensions: { custom: { nested: [1, 2] } },
    assets: [{ type: 'icon', uri: 'embeded://assets/icon/main.png', name: 'main', ext: 'png' }],
    group_only_greetings: [],
    unknown_field: '保留',
  },
} as unknown as V3Card;

function makeSample(): Uint8Array {
  return zipSync({
    'card.json': strToU8(JSON.stringify(card)),
    'assets/icon/main.png': new Uint8Array([1, 2, 3]),
    'assets/other/readme.txt': strToU8('说明'),
  });
}

describe('charx', () => {
  it('读 → 写 → 再读 deep-equal', () => {
    const first = readCharx(makeSample());
    expect(first.card).toEqual(card);
    expect([...first.files.keys()].sort()).toEqual([
      'assets/icon/main.png',
      'assets/other/readme.txt',
    ]);
    expect(first.files.get('assets/icon/main.png')).toEqual(new Uint8Array([1, 2, 3]));

    const second = readCharx(writeCharx(first.card, first.files));
    expect(second.card).toEqual(first.card);
    expect(second.files).toEqual(first.files);
  });

  it('card.json 为 V2 时升级为 V3', () => {
    const v2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'v2',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
      },
    };
    const { card: upgraded } = readCharx(zipSync({ 'card.json': strToU8(JSON.stringify(v2)) }));
    expect(upgraded.spec).toBe('chara_card_v3');
    expect(upgraded.data.assets).toEqual([]);
  });

  it('非 zip 或缺 card.json 报中文错', () => {
    expect(() => readCharx(new Uint8Array([1, 2, 3]))).toThrow(/CHARX/);
    expect(() => readCharx(zipSync({ 'x.txt': strToU8('x') }))).toThrow(/缺少 card.json/);
  });

  it('解析 embeded:// uri', () => {
    expect(resolveEmbeddedUri('embeded://assets/a.png')).toBe('assets/a.png');
    expect(resolveEmbeddedUri('embedded://assets/a.png')).toBe('assets/a.png');
    expect(resolveEmbeddedUri('https://example.com/a.png')).toBeUndefined();
    expect(resolveEmbeddedUri('ccdefault:')).toBeUndefined();
  });
});
