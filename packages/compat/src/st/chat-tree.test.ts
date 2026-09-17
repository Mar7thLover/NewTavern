import { describe, expect, it } from 'vitest';

import { parseChatJsonl, serializeChatJsonl } from './chat-jsonl.js';
import {
  exportInputFromDrafts,
  normalizeStMedia,
  parseStDate,
  stChatNames,
  stChatToTree,
  treeToStChat,
  type ExportNode,
} from './chat-tree.js';

const header = {
  user_name: '旅行者',
  character_name: '艾拉',
  create_date: '2026-09-12@22h10m05s',
  chat_metadata: { note_prompt: '', integrity: 'abc', variables: { hp: 10 } },
};

const lines: Record<string, unknown>[] = [
  // 0：开场白 3 个 swipe，选中第 2 个；未污染的聊天里 mes 已替换宏、swipes 没有
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: '2026-09-12T14:10:00.000Z',
    mes: '欢迎，旅行者。',
    extra: {},
    swipe_id: 1,
    swipes: ['你好。', '欢迎，{{user}}。', '又来了？'],
    swipe_info: [
      { send_date: '2026-09-12T14:10:00.000Z', extra: {} },
      { send_date: '2026-09-12T14:10:00.000Z', extra: {} },
      { send_date: '2026-09-12T14:10:00.000Z', extra: {}, custom: 1 },
    ],
  },
  // 1：用户消息，没有 is_system 键、epoch 时间
  {
    name: '旅行者',
    is_user: true,
    send_date: 1789275135211,
    mes: '来一杯麦酒。[图]',
    force_avatar: 'User Avatars/user.png',
    extra: {
      image: '/user/images/艾拉/a.png',
      file: { url: '/user/files/note.txt', size: 12, name: 'note.txt' },
    },
  },
  // 2：助手两个 swipe，带推理与生成时间；swipe_info 与消息一致
  {
    name: '艾拉',
    is_user: false,
    is_system: false,
    send_date: 'September 12, 2026 10:12pm',
    mes: '好的。',
    gen_started: '2026-09-12T14:12:00.000Z',
    gen_finished: '2026-09-12T14:12:03.000Z',
    extra: { api: 'claude', model: 'claude-opus-5', reasoning: '想一想' },
    swipe_id: 0,
    swipes: ['好的。', '马上来。'],
    swipe_info: [
      {
        send_date: 'September 12, 2026 10:12pm',
        gen_started: '2026-09-12T14:12:00.000Z',
        gen_finished: '2026-09-12T14:12:03.000Z',
        extra: { api: 'claude', model: 'claude-opus-5', reasoning: '想一想' },
      },
      {
        send_date: '2026-09-12@22h13m00s000ms',
        gen_started: '2026-09-12T14:13:00.000Z',
        extra: { api: 'claude', reasoning: '换个说法' },
      },
    ],
  },
  // 3：隐藏消息，旧版没有 swipe_info
  {
    name: '艾拉',
    is_user: false,
    is_system: true,
    send_date: 'bad date',
    mes: '（隐藏）',
    extra: {
      image_swipes: ['/user/images/x.png', '/user/images/y.png'],
      video: '/user/images/v.mp4',
    },
    swipe_id: 0,
    swipes: ['（隐藏）'],
  },
  // 4：旁白（narrator → system）
  {
    name: 'System',
    is_user: false,
    is_system: false,
    send_date: '2026-09-12T14:20:00.000Z',
    mes: '夜深了。',
    force_avatar: 'img/five.png',
    extra: { type: 'narrator', isSmallSys: true },
  },
  // 5：swipe_info 比 swipes 短
  {
    name: '艾拉',
    is_user: false,
    send_date: '2026-09-12T14:21:00.000Z',
    mes: 'B',
    extra: {},
    swipe_id: 1,
    swipes: ['A', 'B'],
    swipe_info: [{ send_date: '2026-09-12T14:20:30.000Z', extra: {} }],
  },
];

const jsonl = [header, ...lines].map((line) => JSON.stringify(line)).join('\n');

const toLines = (text: string) => text.split('\n').map((line) => JSON.parse(line) as unknown);

describe('ST 聊天 → 消息树', () => {
  const tree = stChatToTree(parseChatJsonl(jsonl));

  it('节点结构：swipe 兄弟、父子链、head', () => {
    expect(tree.nodes.map((node) => node.tempId)).toEqual([
      'm0s0',
      'm0s1',
      'm0s2',
      'm1',
      'm2s0',
      'm2s1',
      'm3s0',
      'm4',
      'm5s0',
      'm5s1',
    ]);
    const byId = new Map(tree.nodes.map((node) => [node.tempId, node]));
    expect(byId.get('m0s2')?.parentTempId).toBeNull();
    expect(byId.get('m0s2')?.siblingSeq).toBe(2);
    expect(byId.get('m1')?.parentTempId).toBe('m0s1');
    expect(byId.get('m2s1')?.parentTempId).toBe('m1');
    expect(byId.get('m3s0')?.parentTempId).toBe('m2s0');
    expect(byId.get('m5s0')?.parentTempId).toBe('m4');
    expect(tree.headTempId).toBe('m5s1');
    expect(tree.warnings).toEqual([]);
  });

  it('正文、角色、隐藏、推理、媒体', () => {
    const byId = new Map(tree.nodes.map((node) => [node.tempId, node]));
    expect(byId.get('m0s1')?.text).toBe('欢迎，旅行者。');
    expect(byId.get('m0s0')?.text).toBe('你好。');
    expect(byId.get('m1')).toMatchObject({ role: 'user', name: '旅行者', isHidden: false });
    expect(byId.get('m1')?.media).toEqual([{ type: 'image', url: '/user/images/艾拉/a.png' }]);
    expect(byId.get('m1')?.files).toEqual([
      { url: '/user/files/note.txt', size: 12, name: 'note.txt' },
    ]);
    expect(byId.get('m2s0')?.reasoning).toBe('想一想');
    expect(byId.get('m2s1')?.reasoning).toBe('换个说法');
    expect(byId.get('m3s0')).toMatchObject({ role: 'assistant', isHidden: true });
    expect(byId.get('m3s0')?.media.map((m) => m.type)).toEqual(['image', 'image', 'video']);
    expect(byId.get('m4')).toMatchObject({ role: 'system', name: 'System' });
  });

  it('createdAt 严格递增，能解析的时间照用', () => {
    const times = tree.nodes.map((node) => node.createdAt);
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeGreaterThan(times[i - 1] as number);
    }
    const byId = new Map(tree.nodes.map((node) => [node.tempId, node]));
    expect(byId.get('m0s0')?.createdAt).toBe(Date.parse('2026-09-12T14:10:00.000Z'));
    expect(byId.get('m1')?.createdAt).toBe(1789275135211);
    // 解析失败 → 前一个 + 1ms
    expect(byId.get('m3s0')?.createdAt).toBe((byId.get('m2s1')?.createdAt as number) + 1);
  });

  it('导入 → 导出 deep-equal', () => {
    const { chat, droppedBranches } = treeToStChat(exportInputFromDrafts(tree));
    expect(droppedBranches).toBe(0);
    expect(toLines(serializeChatJsonl(chat))).toEqual(toLines(jsonl));
  });

  it('只存必要的冗余：swipe_info 与消息一致时不另存', () => {
    const byId = new Map(tree.nodes.map((node) => [node.tempId, node]));
    expect(byId.get('m2s0')?.st.swipeInfo).toBeUndefined();
    expect(byId.get('m2s1')?.st.swipeInfo).toBeUndefined();
    expect(byId.get('m0s2')?.st.swipeInfo).toEqual(lines[0]?.['swipe_info']?.[2 as never]);
    expect(byId.get('m0s1')?.st).toMatchObject({
      mes: '欢迎，旅行者。',
      swipe: '欢迎，{{user}}。',
    });
  });
});

describe('消息树 → ST 聊天', () => {
  const tree = stChatToTree(parseChatJsonl(jsonl));

  const input = (mutate?: (nodes: Map<string, ExportNode>) => void, head = 'm5s1') => {
    const base = exportInputFromDrafts(tree, head);
    const nodes = new Map<string, ExportNode>();
    const clone = (node: ExportNode) => {
      const existing = nodes.get(node.id);
      if (existing) return existing;
      const copy = { ...node };
      nodes.set(node.id, copy);
      return copy;
    };
    const path = base.path.map(clone);
    const siblings = (node: ExportNode) => base.siblingsOf(node).map(clone);
    for (const node of path) siblings(node);
    mutate?.(nodes);
    return { ...base, path, siblingsOf: siblings };
  };

  it('切到另一个 swipe：消息层字段取自 swipe_info', () => {
    const { chat, droppedBranches } = treeToStChat(exportInputFromDrafts(tree, 'm5s0'));
    const message = chat.messages[5];
    expect(droppedBranches).toBe(0);
    expect(message?.mes).toBe('A');
    expect(message?.swipeId).toBe(0);
    expect(message?.sendDate).toBe('2026-09-12T14:20:30.000Z');
    expect(message?.swipes).toEqual(['A', 'B']);
    // 结构没变：swipe_info 保持原来的长度
    expect(message?.swipeInfo).toEqual([{ send_date: '2026-09-12T14:20:30.000Z', extra: {} }]);
  });

  it('切到的 swipe 旁边的兄弟已有后代 → 它成了分支', () => {
    const { chat, droppedBranches } = treeToStChat(exportInputFromDrafts(tree, 'm2s1'));
    const message = chat.messages[2];
    expect(droppedBranches).toBe(1);
    expect(chat.messages).toHaveLength(3);
    expect(message?.mes).toBe('马上来。');
    expect(message?.swipes).toEqual(['马上来。']);
    expect(message?.swipeId).toBe(0);
    expect(message?.sendDate).toBe('2026-09-12@22h13m00s000ms');
    expect(message?.extra).toEqual({ api: 'claude', reasoning: '换个说法' });
    expect(message?.rest['gen_started']).toBe('2026-09-12T14:13:00.000Z');
    expect(message?.rest['gen_finished']).toBeUndefined();
  });

  it('改正文与推理：mes / swipes / extra / swipe_info 同步', () => {
    const { chat } = treeToStChat(
      input((nodes) => {
        const node = nodes.get('m2s0') as ExportNode;
        node.text = '改过了。';
        node.reasoning = null;
        const greeting = nodes.get('m0s1') as ExportNode;
        greeting.text = '欢迎！';
      }),
    );
    const message = chat.messages[2];
    expect(message?.mes).toBe('改过了。');
    expect(message?.swipes).toEqual(['改过了。', '马上来。']);
    expect(message?.extra).toEqual({ api: 'claude', model: 'claude-opus-5' });
    expect((message?.swipeInfo?.[0] as { extra: unknown }).extra).toEqual({
      api: 'claude',
      model: 'claude-opus-5',
    });
    // 开场白改了正文 → swipes 里也写新正文
    expect(chat.messages[0]?.swipes).toEqual(['你好。', '欢迎！', '又来了？']);
  });

  it('有后代的兄弟是分支：丢弃并计数；隐藏状态写回 is_system', () => {
    const base = exportInputFromDrafts(tree);
    const branch: ExportNode = {
      id: 'branch',
      siblingSeq: 9,
      role: 'user',
      name: '旅行者',
      text: '另一条路',
      isHidden: false,
      createdAt: 1,
      reasoning: null,
      hasChildren: true,
    };
    const path = base.path.map((node) => (node.id === 'm1' ? { ...node, isHidden: true } : node));
    const { chat, droppedBranches } = treeToStChat({
      ...base,
      path,
      siblingsOf: (node) =>
        node.id === 'm1' ? [...base.siblingsOf(node), branch] : base.siblingsOf(node),
    });
    expect(droppedBranches).toBe(1);
    expect(chat.messages[1]?.swipes).toBeUndefined();
    expect(chat.messages[1]?.isSystem).toBe(true);
  });

  it('新节点（没有 st）：按 ST 新消息的形状；新 swipe 让 swipe_info 整体重建', () => {
    const base = exportInputFromDrafts(tree, 'm1');
    const fresh: ExportNode = {
      id: 'fresh',
      siblingSeq: 0,
      role: 'assistant',
      name: null,
      text: '新回复',
      isHidden: false,
      createdAt: Date.parse('2026-09-13T00:00:00.000Z'),
      reasoning: '新推理',
      hasChildren: false,
    };
    const extraSwipe: ExportNode = {
      ...fresh,
      id: 'fresh2',
      siblingSeq: 1,
      text: '另一个',
      reasoning: null,
    };
    const { chat } = treeToStChat({
      ...base,
      path: [...base.path, fresh],
      siblingsOf: (node) => (node.id === 'fresh' ? [fresh, extraSwipe] : base.siblingsOf(node)),
    });
    const record = JSON.parse(serializeChatJsonl(chat).split('\n')[3] as string) as unknown;
    expect(record).toEqual({
      name: '艾拉',
      is_user: false,
      is_system: false,
      send_date: '2026-09-13T00:00:00.000Z',
      mes: '新回复',
      extra: { reasoning: '新推理' },
      swipes: ['新回复', '另一个'],
      swipe_id: 0,
      swipe_info: [
        { send_date: '2026-09-13T00:00:00.000Z', extra: { reasoning: '新推理' } },
        { send_date: '2026-09-13T00:00:00.000Z', extra: {} },
      ],
    });
  });

  it('没有 header 时合成一个', () => {
    const node: ExportNode = {
      id: 'u',
      siblingSeq: 0,
      role: 'user',
      name: null,
      text: '你好',
      isHidden: false,
      createdAt: Date.UTC(2026, 0, 1),
      reasoning: null,
      hasChildren: false,
    };
    const { chat } = treeToStChat({
      path: [node],
      siblingsOf: () => [node],
      names: { user: '我', character: '她' },
    });
    expect(chat.header).toMatchObject({ userName: '我', characterName: '她', chatMetadata: {} });
    expect(chat.messages[0]).toMatchObject({ name: '我', isUser: true, mes: '你好' });
  });
});

describe('stChatNames', () => {
  it("header 有真名用 header；ST 新版写 'unused' 时取消息里的名字（跳过旁白）", () => {
    expect(stChatNames(parseChatJsonl(jsonl))).toEqual({
      characterName: '艾拉',
      userName: '旅行者',
    });
    const modern = parseChatJsonl(
      [
        { chat_metadata: {}, user_name: 'unused', character_name: 'unused' },
        lines[4],
        lines[1],
        lines[2],
      ]
        .map((line) => JSON.stringify(line))
        .join('\n'),
    );
    expect(stChatNames(modern)).toEqual({ characterName: '艾拉', userName: '旅行者' });
    expect(stChatNames(parseChatJsonl(JSON.stringify({ chat_metadata: {} })))).toEqual({
      characterName: null,
      userName: null,
    });
  });
});

describe('parseStDate', () => {
  it('ST 的几种时间格式', () => {
    expect(parseStDate(1789275135211)).toBe(1789275135211);
    expect(parseStDate('1789275135211')).toBe(1789275135211);
    expect(parseStDate('2026-09-12T14:10:00.000Z')).toBe(Date.parse('2026-09-12T14:10:00.000Z'));
    expect(parseStDate('2024-07-12@01h31m37s123ms')).toBe(Date.parse('2024-07-12T01:31:37.123Z'));
    expect(parseStDate('2024-7-2@01h31m37s')).toBe(Date.parse('2024-07-02T01:31:37Z'));
    expect(parseStDate('2024-6-5 @14h 56m 50s 682ms')).toBe(Date.parse('2024-06-05T14:56:50.682Z'));
    expect(parseStDate('June 19, 2023 2:20pm')).toBe(new Date(2023, 5, 19, 14, 20).getTime());
    expect(parseStDate('June 19, 2023 12:05am')).toBe(new Date(2023, 5, 19, 0, 5).getTime());
    expect(parseStDate('whenever')).toBeNull();
    expect(parseStDate(undefined)).toBeNull();
    expect(parseStDate(-5)).toBeNull();
  });
});

describe('normalizeStMedia', () => {
  it('照 migrateMediaToArray 归一且不改入参', () => {
    const extra = {
      media: [{ type: 'image', url: '/user/images/a.png', title: 't' }],
      image: '/user/images/a.png',
      image_swipes: ['/user/images/b.png'],
      video: '/user/images/c.mp4',
      file: { url: '/user/files/d.txt', name: 'd.txt' },
      files: [{ url: '/user/files/e.txt' }, { nope: true }],
    };
    const snapshot = JSON.stringify(extra);
    expect(normalizeStMedia(extra)).toEqual({
      media: [
        { type: 'image', url: '/user/images/a.png', title: 't' },
        { type: 'image', url: '/user/images/b.png' },
        { type: 'video', url: '/user/images/c.mp4' },
      ],
      files: [{ url: '/user/files/e.txt' }, { url: '/user/files/d.txt', name: 'd.txt' }],
    });
    expect(JSON.stringify(extra)).toBe(snapshot);
    expect(normalizeStMedia(null)).toEqual({ media: [], files: [] });
  });
});
