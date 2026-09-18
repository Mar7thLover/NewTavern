import { describe, expect, it } from 'vitest';

import { extractCommands, parseParameters } from './commands.js';
import { applyCommands, applyMessage, emptyMvuData, statPaths, stripInternal, type MvuData } from './engine.js';
import { initializeMvu, unwrapInitVarContent } from './init.js';
import { getPath, pathFix, toPath } from './path.js';
import { evaluateArithmetic, parseCommandValue } from './value.js';

/**
 * 两种真实卡的写法都在这里定型：
 * - 「长夜月」：YAML 的 `[InitVar]` + `<JSONPatch>` 更新
 * - 「黄金庭院」：JSON 的 `[InitVar]`（带 `$meta` 与 `[值, "说明"]`）+ `_.set/_.add/_.insert/_.remove`
 */

function data(stat: Record<string, unknown>): MvuData {
  return { ...emptyMvuData(), stat_data: stat };
}

describe('路径', () => {
  it('toPath 认点、下标与带引号的键', () => {
    expect(toPath('a.b[0]')).toEqual(['a', 'b', '0']);
    expect(toPath('三月七.好感度')).toEqual(['三月七', '好感度']);
    expect(toPath('foo["a b"].c')).toEqual(['foo', 'a b', 'c']);
    expect(toPath('')).toEqual([]);
  });

  it('pathFix 把模型的各种写法收敛成一种', () => {
    expect(pathFix('系统.日期[0]')).toBe('系统.日期[0]');
    expect(pathFix('["武器栏"]')).toBe('[武器栏]');
    expect(pathFix('foo."a b".c')).toBe('foo["a b"].c');
    // 带引号的数字是字符串键，裸数字是下标
    expect(pathFix('m["0"]')).toBe('m["0"]');
    expect(pathFix('m[0]')).toBe('m[0]');
  });
});

describe('值解析', () => {
  it('标量、容器与宽松写法', () => {
    expect(parseCommandValue('35')).toBe(35);
    expect(parseCommandValue("'早上好'")).toBe('早上好');
    expect(parseCommandValue('"07:30"')).toBe('07:30');
    expect(parseCommandValue('true')).toBe(true);
    expect(parseCommandValue('null')).toBeNull();
    expect(parseCommandValue('{好感度: 5}')).toEqual({ 好感度: 5 });
    expect(parseCommandValue("['刀', '枪',]")).toEqual(['刀', '枪']);
    expect(parseCommandValue('控制')).toBe('控制');
  });

  it('时间与日期保持模型写的字面量，不被 YAML 读成数字 / Date', () => {
    expect(parseCommandValue('07:30')).toBe('07:30');
    expect(parseCommandValue('2025-04-10')).toBe('2025-04-10');
    expect(parseCommandValue('光历3960年·3月·21日')).toBe('光历3960年·3月·21日');
  });

  it('算术表达式', () => {
    expect(evaluateArithmetic('10 + 2')).toBe(12);
    expect(evaluateArithmetic('30 * 60 * 1000')).toBe(1800000);
    expect(evaluateArithmetic('Math.round(3.6)')).toBe(4);
    expect(evaluateArithmetic('sqrt(16)')).toBe(4);
    expect(evaluateArithmetic('0.1 + 0.2')).toBe(0.3);
    // 不是算术的一律 null，交给字符串分支
    expect(evaluateArithmetic('控制')).toBeNull();
    expect(evaluateArithmetic('sqrt')).toBeNull();
    expect(evaluateArithmetic('alert(1)')).toBeNull();
  });
});

describe('命令抽取', () => {
  it('抽出 UpdateVariable 里的四种命令与理由', () => {
    const commands = extractCommands(`
<UpdateVariable>
<Analysis>whatever</Analysis>
_.set('三月七.好感度', 30, 35);//并肩作战
_.add('系统.时间', 30);
_.insert('武器栏', '猎枪');//捡到
_.remove('武器栏', 0);
</UpdateVariable>`);
    expect(commands.map((command) => command.type)).toEqual(['set', 'add', 'insert', 'delete']);
    expect(commands[0]?.args).toEqual(["'三月七.好感度'", '30', '35']);
    expect(commands[0]?.reason).toBe('并肩作战');
    expect(commands[2]?.reason).toBe('捡到');
  });

  it('参数里出现 `_.set(...)` 片段时不提前收尾', () => {
    const commands = extractCommands(`_.set('日记', ["里面写了 _.set('x',1);//注释"]);//记下`);
    expect(commands).toHaveLength(1);
    expect(commands[0]?.args[1]).toBe(`["里面写了 _.set('x',1);//注释"]`);
  });

  it('没有分号的不算命令（正文里提一句 `_.set(...)` 不会被吃掉）', () => {
    expect(extractCommands("她说要 _.set('好感度', 5) 一下")).toHaveLength(0);
  });

  it('别名归一：assign→insert，remove/unset→delete', () => {
    const commands = extractCommands("_.assign('a', 1);_.unset('b');");
    expect(commands.map((command) => command.type)).toEqual(['insert', 'delete']);
  });

  it('JSONPatch 形式翻译成命令', () => {
    const commands = extractCommands(`
<UpdateVariable>
<JSONPatch>
[
  { "op": "replace", "path": "/三月七/好感度", "value": 35 },
  { "op": "add", "path": "/武器栏/-", "value": "猎枪" },
  { "op": "remove", "path": "/旧字段" }
]
</JSONPatch>
</UpdateVariable>`);
    expect(commands.map((command) => command.type)).toEqual(['set', 'insert', 'delete']);
    expect(commands[0]?.args[0]).toBe('["三月七"]["好感度"]');
    expect(commands[1]?.args).toEqual(['["武器栏"]', '"-"', '"猎枪"']);
  });

  it('参数切分认引号与嵌套容器里的逗号', () => {
    expect(parseParameters(`'a', {x: 1, y: [2, 3]}, "c,d"`)).toEqual([
      "'a'",
      '{x: 1, y: [2, 3]}',
      '"c,d"',
    ]);
  });
});

describe('应用命令', () => {
  it('set 只改 [值, 说明] 的值并保留说明，数字字符串转数字', () => {
    const result = applyMessage(data({ 昔涟: { 好感度: [0, '[0,100]对 user 的好感度'] } }), `_.set('昔涟.好感度', 0, '5');//夸了她`);
    expect(getPath(result.data.stat_data, '昔涟.好感度')).toEqual([5, '[0,100]对 user 的好感度']);
    expect(result.updates[0]?.display).toBe('0->5 (夸了她)');
    expect(getPath(result.data.delta_data, '昔涟.好感度')).toBe('0->5 (夸了她)');
    // display_data 是全表副本，没改的位置保持原值
    expect(getPath(result.data.display_data, '昔涟.好感度')).toBe('0->5 (夸了她)');
  });

  it('set 的路径必须已存在（模型不能凭空造字段）', () => {
    const result = applyMessage(data({ 时间: '08:00' }), `_.set('凭空.字段', 1);`);
    expect(result.changed).toBe(false);
    expect(result.errors[0]?.message).toContain('路径不存在');
  });

  it('strictSet 时 set 整体替换二元组', () => {
    const result = applyMessage(
      data({ $meta: { strictSet: true }, a: [1, '说明'] }),
      `_.set('a', 2);`,
    );
    expect(getPath(result.data.stat_data, 'a')).toBe(2);
  });

  it('add 加减数字、取反布尔', () => {
    const result = applyMessage(
      data({ 好感度: [10, '说明'], 时间: 480, 开关: true }),
      `_.add('好感度', -3);_.add('时间', 30);_.add('开关', true);`,
    );
    expect(getPath(result.data.stat_data, '好感度')).toEqual([7, '说明']);
    expect(getPath(result.data.stat_data, '时间')).toBe(510);
    expect(getPath(result.data.stat_data, '开关')).toBe(false);
  });

  it('insert 往数组 push、往对象 merge，三参按下标 / 键插入', () => {
    const result = applyMessage(
      data({ 武器栏: ['刀'], 角色: { 甲: 1 } }),
      `_.insert('武器栏', '枪');_.insert('武器栏', 0, '弓');_.insert('角色', {乙: 2});`,
    );
    expect(getPath(result.data.stat_data, '武器栏')).toEqual(['弓', '刀', '枪']);
    expect(getPath(result.data.stat_data, '角色')).toEqual({ 甲: 1, 乙: 2 });
  });

  it('extensible=false 时 insert 不能加新键', () => {
    const result = applyMessage(
      data({ $meta: { extensible: false }, 角色: { 甲: 1 } }),
      `_.insert('角色', {乙: 2});`,
    );
    expect(result.changed).toBe(false);
    expect(result.errors[0]?.message).toContain('不可扩展');
  });

  it('remove 按下标、按值、按键删', () => {
    const result = applyMessage(
      data({ 武器栏: ['刀', '枪'], 角色: { 甲: 1, 乙: 2 }, 旧: 1 }),
      `_.remove('武器栏', 0);_.remove('角色', '乙');_.remove('旧');`,
    );
    expect(getPath(result.data.stat_data, '武器栏')).toEqual(['枪']);
    expect(getPath(result.data.stat_data, '角色')).toEqual({ 甲: 1 });
    expect(result.data.stat_data.旧).toBeUndefined();
  });

  it('JSONPatch 的 move 与 add', () => {
    const result = applyMessage(
      data({ 甲: 1, 容器: {} }),
      `<JSONPatch>[{"op":"move","from":"/甲","path":"/容器/乙"},{"op":"add","path":"/容器/丙","value":3}]</JSONPatch>`,
    );
    expect(result.data.stat_data).toMatchObject({ 容器: { 乙: 1, 丙: 3 } });
    expect(result.data.stat_data.甲).toBeUndefined();
  });

  it('没有命令时不产出 display/delta，也不算 changed', () => {
    const result = applyMessage(data({ a: 1 }), '她只是笑了笑。');
    expect(result.changed).toBe(false);
    expect(result.data.display_data).toBeUndefined();
    expect(result.data.stat_data.$internal).toBeUndefined();
  });

  it('入参不会被改动（swipe / 重生要从父快照重新起算）', () => {
    const base = data({ a: [1, '说明'] });
    applyMessage(base, `_.set('a', 9);`);
    expect(getPath(base.stat_data, 'a')).toEqual([1, '说明']);
  });

  it('宏在命令的值里展开', () => {
    const result = applyMessage(data({ 名字: '' }), `_.set('名字', '{{user}}');`, {
      substituteMacros: (text) => text.replaceAll('{{user}}', '旅人'),
    });
    expect(result.data.stat_data.名字).toBe('旅人');
  });

  it('applyCommands 可以直接吃调用方改过的命令', () => {
    const result = applyCommands(data({ a: 1 }), [
      { type: 'set', full_match: '(script)', args: ['a', '2'], reason: '脚本强行更新' },
    ]);
    expect(result.data.stat_data.a).toBe(2);
    expect(result.updates[0]?.reason).toBe('脚本强行更新');
  });
});

describe('InitVar', () => {
  it('YAML 写法（长夜月）', () => {
    const result = initializeMvu(emptyMvuData(), [
      {
        name: '长夜月',
        entries: [
          {
            comment: '[InitVar]请勿打开',
            content: '---\n时间: 光历3960年·3月·21日\n三月七:\n  状态: 休眠\n  好感度: 30\n',
          },
        ],
      },
    ]);
    expect(result.data.stat_data).toEqual({
      时间: '光历3960年·3月·21日',
      三月七: { 状态: '休眠', 好感度: 30 },
    });
    expect(result.initialized).toEqual(['长夜月']);
  });

  it('JSON 写法带 $meta 与 [值, 说明]（黄金庭院）', () => {
    const result = initializeMvu(emptyMvuData(), [
      {
        name: '黄金庭院',
        entries: [
          {
            comment: '[InitVar]',
            content: '{ "$meta": { "extensible": false, "strictSet": true }, "昔涟": { "好感度": [0, "对 user 的好感度"] } }',
          },
        ],
      },
    ]);
    expect(result.data.stat_data.$meta).toEqual({ extensible: false, strictSet: true });
    expect(getPath(result.data.stat_data, '昔涟.好感度')).toEqual([0, '对 user 的好感度']);
  });

  it('已有变量优先，新字段补进来', () => {
    const existing: MvuData = {
      ...emptyMvuData(),
      stat_data: { 好感度: 50 },
      initialized_lorebooks: {},
    };
    const result = initializeMvu(existing, [
      { name: '书', entries: [{ comment: '[initvar]', content: '好感度: 0\n新字段: 1' }] },
    ]);
    expect(result.data.stat_data).toEqual({ 好感度: 50, 新字段: 1 });
  });

  it('吃过的书不再初始化第二次', () => {
    const once = initializeMvu(emptyMvuData(), [
      { name: '书', entries: [{ comment: '[InitVar]', content: 'a: 1' }] },
    ]);
    once.data.stat_data.a = 99;
    const twice = initializeMvu(once.data, [
      { name: '书', entries: [{ comment: '[InitVar]', content: 'a: 1' }] },
    ]);
    expect(twice.initialized).toEqual([]);
    expect(twice.data.stat_data.a).toBe(99);
  });

  it('内容裹在 <InitVar> 或围栏里也能读', () => {
    expect(unwrapInitVarContent('<InitVar>\na: 1\n</InitVar>')).toBe('a: 1');
    expect(unwrapInitVarContent('```yaml\na: 1\n```')).toBe('a: 1');
  });

  it('解析失败只报错，不炸整本书', () => {
    const result = initializeMvu(emptyMvuData(), [
      { name: '书', entries: [{ comment: '[InitVar]', content: '{ 不是: [合法' }] },
    ]);
    expect(result.errors).toHaveLength(1);
    expect(result.data.stat_data).toEqual({});
  });
});

describe('提示词与面板用的读取', () => {
  it('stripInternal 去掉 $ 簿记键（MVU 宏就是这么把 $meta 挡在提示词外的）', () => {
    const result = applyMessage(data({ $meta: { strictSet: false }, a: [1, '说明'] }), `_.set('a', 2);`);
    expect(stripInternal(result.data.stat_data)).toEqual({ a: [2, '说明'] });
  });

  it('statPaths 列出叶子路径，二元组算一个叶子', () => {
    expect(statPaths(data({ 系统: { 日期: ['2025', '格式'] }, 开关: true }))).toEqual([
      '系统.日期',
      '开关',
    ]);
  });
});
