import { describe, expect, it } from 'vitest';

import { branchPath, buildChatMirror, toChatMessage } from './host-bridge';
import { selectSandboxLibs } from './libs';
import { parseSlashCommand } from './slash';
import { readCharacterScripts } from './ScriptRunner';
import type { ChatDetail, CharacterDetail, MessageNode } from '../../lib/api';

/** 最小可用的节点：只填映射会读到的字段 */
function node(id: string, parentId: string | null, role: MessageNode['role'], text: string, extra?: Partial<MessageNode>): MessageNode {
  return {
    id,
    chatId: 'c1',
    parentId,
    siblingSeq: 0,
    role,
    name: null,
    parts: [{ type: 'text', text }],
    reasoning: null,
    usage: null,
    provider: null,
    model: null,
    isHidden: false,
    extra: null,
    hasVariables: false,
    createdAt: '2026-09-17T00:00:00.000Z',
    ...extra,
  };
}

function detail(nodes: MessageNode[], headNodeId: string): ChatDetail {
  return {
    id: 'c1',
    title: '测试',
    mode: 'roleplay',
    characterIds: ['char-1'],
    personaId: null,
    presetId: null,
    overrides: null,
    rootNodeId: nodes[0]?.id ?? null,
    headNodeId,
    metadata: null,
    createdAt: '2026-09-17T00:00:00.000Z',
    updatedAt: '2026-09-17T00:00:00.000Z',
    character: { id: 'char-1', name: '昔涟', avatarAssetId: null },
    lorebookIds: [],
    messageCount: nodes.length,
    lastMessageAt: null,
    preview: null,
    nodes,
  };
}

describe('消息树 → 酒馆助手的楼层', () => {
  const nodes = [
    node('n1', null, 'assistant', '你来了。'),
    node('n2', 'n1', 'user', '早上好。'),
    node('n3', 'n2', 'assistant', '她抬起头。'),
    // n3 的兄弟（swipe）：不在当前分支上
    node('n4', 'n2', 'assistant', '她没理你。', { siblingSeq: 1 }),
  ];
  const chat = detail(nodes, 'n3');

  it('楼层号 = 当前分支 root→head 的下标', () => {
    expect(branchPath(chat).map((item) => item.id)).toEqual(['n1', 'n2', 'n3']);
    const mirror = buildChatMirror({
      chatId: 'c1',
      nodeId: 'n3',
      detail: chat,
      charData: null,
      variables: { message: { stat_data: { 好感度: 5 } }, chat: {}, character: {}, global: {}, script: {} },
      macros: { char: '昔涟', user: '', description: '', personality: '', scenario: '', lastMessageId: 2, variables: {} },
    });
    expect(mirror.map((item) => item.message_id)).toEqual([0, 1, 2]);
    expect(mirror.map((item) => item.message)).toEqual(['你来了。', '早上好。', '她抬起头。']);
    // 每条都带节点 id：切分支后楼层号会变，节点 id 不会
    expect(mirror.map((item) => item.node_id)).toEqual(['n1', 'n2', 'n3']);
    // 只有帧自己那层带变量快照（别的楼层按需取）
    expect(mirror[2]?.data).toEqual({ stat_data: { 好感度: 5 } });
    expect(mirror[1]?.data).toEqual({});
  });

  it('兄弟节点就是 swipes，swipe_id 指当前那条', () => {
    const message = toChatMessage(nodes[2] as MessageNode, 2, {
      nodes,
      characterName: '昔涟',
      userName: '旅人',
    });
    expect(message.swipes).toEqual(['她抬起头。', '她没理你。']);
    expect(message.swipe_id).toBe(0);
    expect(message.name).toBe('昔涟');
    expect(message.role).toBe('assistant');
  });

  it('没有会话详情时给空列表，而不是抛错', () => {
    expect(branchPath(undefined)).toEqual([]);
  });
});

describe('slash 子集', () => {
  it('解析命名参数与其余部分', () => {
    expect(parseSlashCommand('/setvar key=好感度 35')).toEqual({
      name: 'setvar',
      named: { key: '好感度' },
      rest: '35',
    });
    expect(parseSlashCommand('/echo 你好世界')).toEqual({ name: 'echo', named: {}, rest: '你好世界' });
    expect(parseSlashCommand('/setvar key="带 空格" 值')).toEqual({
      name: 'setvar',
      named: { key: '带 空格' },
      rest: '值',
    });
  });

  it('不是 slash 命令时返回 null', () => {
    expect(parseSlashCommand('好感度 +5')).toBeNull();
    expect(parseSlashCommand('')).toBeNull();
  });
});

describe('库的按需加载', () => {
  it('jQuery 与 lodash 总是给（社区卡的地基）', () => {
    const libs = selectSandboxLibs('<div>x</div>');
    expect(libs.scripts.some((src) => src.includes('jquery'))).toBe(true);
    expect(libs.scripts.some((src) => src.includes('lodash'))).toBe(true);
    expect(libs.scripts.some((src) => src.includes('zod'))).toBe(false);
  });

  it('提到 Vue / zod / YAML 才加载它们', () => {
    const libs = selectSandboxLibs('const app = Vue.createApp({}); const s = z.object({}); YAML.parse("a: 1")');
    expect(libs.scripts.some((src) => src.includes('vue'))).toBe(true);
    expect(libs.scripts.some((src) => src.includes('zod'))).toBe(true);
    expect(libs.scripts.some((src) => src.includes('yaml'))).toBe(true);
  });
});

describe('角色卡里的脚本', () => {
  const base = {
    id: 'char-1',
    name: '长夜月',
    spec: 'v3' as const,
    bookId: null,
    avatarAssetId: null,
    tags: [],
    createdAt: '',
    updatedAt: '',
    sourcePath: null,
    originalHash: null,
  };

  it('读新字段 extensions.tavern_helper.scripts', () => {
    const character = {
      ...base,
      data: {
        name: '长夜月',
        extensions: {
          tavern_helper: {
            scripts: [
              {
                id: 'mvu',
                name: 'MVU',
                content: "import 'https://cdn/bundle.js'",
                enabled: true,
                button: { enabled: true, buttons: [{ name: '重新处理变量', visible: true }] },
              },
              { id: 'off', name: '关掉的', content: 'x', enabled: false },
            ],
          },
        },
      },
    } as unknown as CharacterDetail;
    const scripts = readCharacterScripts(character);
    expect(scripts.map((script) => script.id)).toEqual(['mvu', 'off']);
    expect(scripts[0]?.buttons).toEqual([{ name: '重新处理变量', visible: true }]);
    expect(scripts[1]?.enabled).toBe(false);
  });

  it('也读旧字段 extensions.TavernHelper_scripts', () => {
    const character = {
      ...base,
      data: {
        name: 'x',
        extensions: { TavernHelper_scripts: [{ name: '老脚本', content: 'console.log(1)' }] },
      },
    } as unknown as CharacterDetail;
    const scripts = readCharacterScripts(character);
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.name).toBe('老脚本');
    expect(scripts[0]?.enabled).toBe(true);
  });

  it('没有脚本时给空数组', () => {
    expect(readCharacterScripts(undefined)).toEqual([]);
  });
});
