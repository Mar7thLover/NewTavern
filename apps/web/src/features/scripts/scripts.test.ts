import { describe, expect, it } from 'vitest';

import { cleanButtons, moveItem, type ScriptRow } from './api';
import { collectRunnableScripts, fromScriptRow, type CardScript } from '../cards/ScriptRunner';

const script = (id: string, patch: Partial<CardScript> = {}): CardScript => ({
  id,
  name: id,
  content: `${id}()`,
  enabled: true,
  buttons: [],
  buttonsEnabled: true,
  source: 'global',
  ...patch,
});

describe('脚本库排序', () => {
  it('moveItem：上下移与拖拽落点', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveItem(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c']);
    // 越界：原样 / 夹到边上
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
  });
});

describe('按钮规整', () => {
  it('去空白、去空名、按名字去重', () => {
    expect(
      cleanButtons([
        { name: ' 打开 ', visible: true },
        { name: '', visible: true },
        { name: '打开', visible: false },
        { name: '重置', visible: false },
      ]),
    ).toEqual([
      { name: '打开', visible: true },
      { name: '重置', visible: false },
    ]);
  });
});

describe('脚本运行顺序与过滤', () => {
  it('全局 → 预设 → 角色卡；关着的、空的、原版 MVU 框架脚本不跑', () => {
    const skipped: string[] = [];
    const result = collectRunnableScripts(
      {
        global: [script('g1'), script('g-off', { enabled: false })],
        preset: [
          script('p1', { source: 'preset' }),
          script('p-empty', { source: 'preset', content: '  ' }),
        ],
        character: [
          script('mvu', {
            source: 'character',
            content: "import 'https://cdn/MagVarUpdate/bundle.js'",
          }),
          script('c1', { source: 'character' }),
        ],
      },
      { builtinMvu: true, onSkip: (item) => skipped.push(item.id) },
    );
    expect(result.map((item) => item.id)).toEqual(['g1', 'p1', 'c1']);
    expect(skipped).toEqual(['mvu']);
  });

  it('内置 MVU 关掉时原版框架脚本照常跑', () => {
    const result = collectRunnableScripts(
      { global: [], preset: [], character: [script('mvu', { content: 'MagVarUpdate' })] },
      { builtinMvu: false },
    );
    expect(result.map((item) => item.id)).toEqual(['mvu']);
  });

  it('脚本库的行转成运行形状（scope 即来源）', () => {
    const row: ScriptRow = {
      id: 'r1',
      scope: 'preset',
      ownerId: 'p',
      name: '悬浮球',
      content: 'x',
      enabled: true,
      buttons: [{ name: '开', visible: true }],
      buttonsEnabled: false,
      info: '',
      folder: null,
      data: {},
      displayOrder: 0,
      createdAt: '',
      updatedAt: '',
    };
    expect(fromScriptRow(row)).toEqual({
      id: 'r1',
      name: '悬浮球',
      content: 'x',
      enabled: true,
      buttons: [{ name: '开', visible: true }],
      buttonsEnabled: false,
      source: 'preset',
    });
  });
});
