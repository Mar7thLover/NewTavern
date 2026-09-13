import { describe, expect, it } from 'vitest';

import { base64FromUtf8, utf8FromBase64 } from './base64.js';
import {
  EMBEDDED_ASSET_PREFIX,
  parseCardJson,
  readCardEmbeddedAssets,
  readCardFromPng,
  serializeCard,
  writeCardToPng,
  type V3Card,
} from './card.js';
import { downgradeV3toV2, upgradeV2toV3 } from './card-upgrade.js';
import {
  PNG_SIGNATURE,
  encodePngChunk,
  readPngTextChunks,
  upsertPngTextChunk,
} from './png-text.js';

const v3Fixture = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  custom_top_field: { note: '顶层未知字段' },
  data: {
    name: '测试角色',
    description: '一个用于测试的角色\n第二行',
    personality: '冷静',
    scenario: '酒馆',
    first_mes: '你好，旅行者。',
    mes_example: '<START>\n{{user}}: 嗨\n{{char}}: 你好',
    creator_notes: '作者备注',
    system_prompt: '系统提示词',
    post_history_instructions: '历史后指令',
    alternate_greetings: ['又见面了。', '欢迎。'],
    character_book: {
      name: '内嵌书',
      scan_depth: 4,
      entries: [
        {
          keys: ['旅店', 'inn'],
          content: '旅店在城东。',
          enabled: true,
          insertion_order: 100,
          case_sensitive: false,
          position: 'before_char',
          extensions: { custom_ext: 1 },
          secondary_keys: ['酒馆'],
          selective: true,
          selectiveLogic: 2,
          probability: 80,
          useProbability: true,
          scanDepth: 3,
          scan_depth: 2,
          unknown_entry_field: '保留我',
        },
        {
          keys: ['传说'],
          content: '古老的传说……',
          enabled: false,
          insertion_order: 50,
          position: 4,
        },
      ],
      extensions: {},
      unknown_book_field: true,
    },
    tags: ['测试', 'rpg'],
    creator: 'tester',
    character_version: '1.2',
    extensions: {
      world: '关联世界书',
      regex_scripts: [{ id: 'x' }],
      TavernHelper_scripts: [{ name: '脚本' }],
      depth_prompt: { prompt: '作者注释', depth: 2, role: 'system' },
    },
    assets: [
      { type: 'icon', uri: 'embeded://assets/icon.png', name: 'icon', ext: 'png' },
      { type: 'emotion', uri: 'https://example.com/happy.png', name: 'happy', ext: 'png' },
    ],
    creator_notes_multilingual: { 'zh-CN': '备注', en: 'notes' },
    group_only_greetings: ['群问候'],
    creation_date: 1700000000,
    modification_date: 1700000001,
    source: ['https://example.com/source'],
    nickname: '昵称',
    unknown_data_field: [1, 2, 3],
  },
};

const v2Fixture = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  custom_top: '顶层未知',
  data: {
    name: 'V2 角色',
    description: 'desc',
    personality: 'pers',
    scenario: 'scen',
    first_mes: '第一条消息',
    mes_example: '示例',
    creator_notes: '备注',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['hi'],
    character_book: null,
    tags: [],
    creator: 'someone',
    character_version: '0.1',
    extensions: { depth_prompt: { prompt: 'x', depth: 4 } },
    unknown_v2_field: '保留',
  },
};

const v1Fixture = {
  name: 'V1 角色',
  description: '旧格式描述',
  personality: '开朗',
  scenario: '森林',
  first_mes: '嗨！',
  mes_example: '例子',
  creator_notes: '旧备注',
  tags: ['old'],
  unknown_v1_field: '顶层保留',
};

/** 最小合法 PNG（IHDR + IDAT + IEND） */
function makePng(): Uint8Array {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1);
  view.setUint32(4, 1);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const parts = [
    PNG_SIGNATURE,
    encodePngChunk('IHDR', ihdr),
    encodePngChunk('IDAT', new Uint8Array([1, 2, 3])),
    encodePngChunk('IEND', new Uint8Array(0)),
  ];
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

describe('parseCardJson / serializeCard', () => {
  it('V3 往返 deep-equal，未知字段保留', () => {
    const parsed = parseCardJson(v3Fixture);
    expect(parsed.spec).toBe('v3');
    expect(parsed.data.name).toBe('测试角色');
    expect(JSON.parse(serializeCard(parsed))).toEqual(v3Fixture);
  });

  it('V2 往返 deep-equal', () => {
    const parsed = parseCardJson(v2Fixture);
    expect(parsed.spec).toBe('v2');
    expect(JSON.parse(serializeCard(parsed))).toEqual(v2Fixture);
  });

  it('V1 平铺卡升级为 V2', () => {
    const parsed = parseCardJson(v1Fixture);
    expect(parsed.spec).toBe('v2');
    expect(parsed.data.name).toBe('V1 角色');
    expect(parsed.data.creator_notes).toBe('旧备注');
    expect(parsed.data.extensions).toEqual({});
    // V1 顶层未知字段保留在 V2 顶层
    expect(parsed.card.unknown_v1_field).toBe('顶层保留');
  });

  it('非法输入报中文错', () => {
    expect(() => parseCardJson('not json')).toThrow(/必须是对象/);
    expect(() => parseCardJson({ spec: 'chara_card_v2', spec_version: '2.0', data: {} })).toThrow(
      /V2 角色卡解析失败/,
    );
    expect(() => parseCardJson({ description: 'x' })).toThrow(/缺少 name/);
  });
});

describe('PNG 角色卡读写', () => {
  it('写 V3 → 读回 deep-equal；ccv3 为完整 V3、chara 为 V2 降级', () => {
    const png = writeCardToPng(makePng(), v3Fixture as unknown as V3Card);
    const back = readCardFromPng(png);
    expect(back.spec).toBe('v3');
    expect(back.card).toEqual(v3Fixture);

    const texts = readPngTextChunks(png);
    const ccv3 = JSON.parse(utf8FromBase64(texts.get('ccv3')!));
    expect(ccv3).toEqual(v3Fixture);
    const chara = JSON.parse(utf8FromBase64(texts.get('chara')!));
    expect(chara.spec).toBe('chara_card_v2');
    expect(chara.data.assets).toBeUndefined();
    expect(chara.data.group_only_greetings).toBeUndefined();
    expect(chara.data.extensions).toEqual(v3Fixture.data.extensions);
    expect(chara.data.character_book).toEqual(v3Fixture.data.character_book);
  });

  it('写 V2 → chara 为原内容、ccv3 为升级结果，读回得到 V3', () => {
    const parsed = parseCardJson(v2Fixture);
    const png = writeCardToPng(makePng(), parsed);
    const texts = readPngTextChunks(png);
    expect(JSON.parse(utf8FromBase64(texts.get('chara')!))).toEqual(v2Fixture);
    const expectedV3 = upgradeV2toV3(parsed.spec === 'v2' ? parsed.card : ({} as never));
    expect(JSON.parse(utf8FromBase64(texts.get('ccv3')!))).toEqual(expectedV3);
    const back = readCardFromPng(png);
    expect(back.spec).toBe('v3');
    expect(back.card).toEqual(expectedV3);
  });

  it('ccv3 优先于 chara', () => {
    const png = writeCardToPng(makePng(), v3Fixture as unknown as V3Card);
    const otherV2 = {
      ...v2Fixture,
      data: { ...v2Fixture.data, name: '旧 V2 名字' },
    };
    const tampered = writeCharaOnly(png, otherV2);
    const back = readCardFromPng(tampered);
    expect(back.spec).toBe('v3');
    expect(back.data.name).toBe('测试角色');
  });

  it('无 ccv3 时读 chara（V2）', () => {
    const png = writeCharaOnly(makePng(), v2Fixture);
    const back = readCardFromPng(png);
    expect(back.spec).toBe('v2');
    expect(back.card).toEqual(v2Fixture);
  });

  it('pngBytes 为 null 时使用占位底图', () => {
    const png = writeCardToPng(null, v3Fixture as unknown as V3Card);
    const back = readCardFromPng(png);
    expect(back.card).toEqual(v3Fixture);
  });

  it('写入后未知 chunk 原样保留', () => {
    const unknown = encodePngChunk('vpAg', new Uint8Array([9, 9, 9]));
    const base = makePng();
    // 手工拼一个带未知 chunk 的 PNG（IHDR + vpAg + IDAT + IEND）
    const ihdrLen = 12 + 13;
    const withUnknown = new Uint8Array(base.length + unknown.length);
    withUnknown.set(base.subarray(0, 8 + ihdrLen), 0);
    withUnknown.set(unknown, 8 + ihdrLen);
    withUnknown.set(base.subarray(8 + ihdrLen), 8 + ihdrLen + unknown.length);
    const out = writeCardToPng(withUnknown, v3Fixture as unknown as V3Card);
    let found = -1;
    for (let i = 0; i + unknown.length <= out.length; i++) {
      let ok = true;
      for (let j = 0; j < unknown.length; j++) if (out[i + j] !== unknown[j]) ok = false;
      if (ok) found = i;
    }
    expect(found).toBeGreaterThan(-1);
  });

  it('无卡 PNG 报错', () => {
    expect(() => readCardFromPng(makePng())).toThrow(/未找到角色卡数据/);
  });
});

describe('内嵌资源 chunk', () => {
  it('写入读回一致，覆盖时旧资源被清除', () => {
    const assets = new Map<string, Uint8Array>([
      ['assets/icon.png', new Uint8Array([1, 2, 3, 4])],
      ['assets/emotions/happy.png', new Uint8Array([5, 6])],
    ]);
    const png = writeCardToPng(makePng(), v3Fixture as unknown as V3Card, assets);
    const back = readCardEmbeddedAssets(png);
    expect(back.size).toBe(2);
    expect(back.get('assets/icon.png')).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(back.get('assets/emotions/happy.png')).toEqual(new Uint8Array([5, 6]));

    const replaced = writeCardToPng(
      png,
      v3Fixture as unknown as V3Card,
      new Map([['assets/icon.png', new Uint8Array([9])]]),
    );
    const back2 = readCardEmbeddedAssets(replaced);
    expect(back2.size).toBe(1);
    expect(back2.get('assets/icon.png')).toEqual(new Uint8Array([9]));
    // 关键字带前缀
    const texts = readPngTextChunks(replaced);
    expect(texts.has(EMBEDDED_ASSET_PREFIX + 'assets/icon.png')).toBe(true);
  });
});

function writeCharaOnly(png: Uint8Array, card: unknown): Uint8Array {
  return upsertPngTextChunk(png, 'chara', base64FromUtf8(JSON.stringify(card)));
}

describe('downgrade 一致性', () => {
  it('downgradeV3toV2 丢弃 V3 专有字段但保留 extensions', () => {
    const parsed = parseCardJson(v3Fixture);
    if (parsed.spec !== 'v3') throw new Error('unreachable');
    const v2 = downgradeV3toV2(parsed.card);
    expect(v2.spec).toBe('chara_card_v2');
    expect(v2.data.name).toBe('测试角色');
    expect(v2.data.extensions).toEqual(v3Fixture.data.extensions);
    expect((v2.data as Record<string, unknown>)['assets']).toBeUndefined();
    expect((v2.data as Record<string, unknown>)['nickname']).toBeUndefined();
    // 顶层未知字段保留
    expect((v2 as Record<string, unknown>)['custom_top_field']).toEqual(v3Fixture.custom_top_field);
  });
});
