import { describe, expect, it } from 'vitest';

import { parseChatJsonl, serializeChatJsonl } from './chat-jsonl.js';

const header = {
  user_name: '旅行者',
  character_name: '艾拉',
  create_date: '2026-09-12@22h10m05s',
  chat_metadata: { note_prompt: '', integrity: 'abc', variables: { hp: 10 } },
};

const messages = [
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: 'September 12, 2026 10:10pm',
    mes: '欢迎来到酒馆。',
    extra: {},
    swipe_id: 1,
    swipes: ['欢迎来到酒馆。', '又一位客人。'],
    swipe_info: [
      { send_date: 'September 12, 2026 10:10pm', extra: {} },
      {
        send_date: 'September 12, 2026 10:11pm',
        gen_started: '2026-09-12T14:11:00.000Z',
        extra: {},
      },
    ],
  },
  {
    name: '旅行者',
    is_user: true,
    send_date: 1789275135211,
    mes: '来一杯麦酒。',
    extra: { bias: '' },
    force_avatar: 'user.png',
  },
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: 'September 12, 2026 10:12pm',
    mes: '好的，{{user}}。',
    gen_started: '2026-09-12T14:12:00.000Z',
    gen_finished: '2026-09-12T14:12:03.000Z',
    extra: { api: 'claude', model: 'claude-opus-5', reasoning: '……' },
  },
];

const jsonl = [header, ...messages].map((line) => JSON.stringify(line)).join('\n');

describe('ST 聊天 jsonl', () => {
  it('往返 deep-equal（逐行对象比较）', () => {
    const chat = parseChatJsonl(jsonl);
    expect(chat.header.userName).toBe('旅行者');
    expect(chat.messages).toHaveLength(3);
    expect(chat.messages[0]?.swipes).toEqual(['欢迎来到酒馆。', '又一位客人。']);
    expect(chat.messages[0]?.swipeId).toBe(1);
    expect(chat.messages[1]?.isSystem).toBeUndefined();
    expect(chat.messages[1]?.rest).toEqual({ force_avatar: 'user.png' });

    const back = serializeChatJsonl(chat)
      .split('\n')
      .map((line) => JSON.parse(line) as unknown);
    expect(back).toEqual([header, ...messages]);
  });

  it('容忍 BOM、CRLF 与空行', () => {
    const messy =
      '\uFEFF' + [header, messages[1]].map((l) => JSON.stringify(l)).join('\r\n\r\n') + '\r\n';
    const chat = parseChatJsonl(messy);
    expect(chat.messages).toHaveLength(1);
    expect(chat.messages[0]?.mes).toBe('来一杯麦酒。');
  });

  it('只有 header 的空聊天', () => {
    expect(parseChatJsonl(JSON.stringify(header)).messages).toEqual([]);
  });

  it('错误报中文并带行号', () => {
    expect(() => parseChatJsonl('')).toThrow(/为空/);
    expect(() => parseChatJsonl(JSON.stringify(messages[1]))).toThrow(/缺少首行 header/);
    expect(() => parseChatJsonl(`${JSON.stringify(header)}\n{bad`)).toThrow(
      /第 2 行不是有效的 JSON/,
    );
    expect(() => parseChatJsonl(`${JSON.stringify(header)}\n{"name":"x"}`)).toThrow(
      /第 2 行缺少 mes/,
    );
  });
});
