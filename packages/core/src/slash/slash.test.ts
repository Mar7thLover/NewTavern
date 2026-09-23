import { describe, expect, it } from 'vitest';

import {
  isKnownSlashCommand,
  parseSlash,
  runSlash,
  SLASH_COMMANDS,
  SLASH_COMMAND_NAMES,
  SlashError,
  type SlashHost,
  type SlashInject,
  type SlashMessage,
} from './index.js';

/** 内存假宿主：记录每一次副作用 */
function makeHost(
  init: {
    local?: Record<string, unknown>;
    global?: Record<string, unknown>;
    messages?: SlashMessage[];
  } = {},
) {
  const tables: Record<'local' | 'global', Record<string, unknown>> = {
    local: structuredClone(init.local ?? {}),
    global: structuredClone(init.global ?? {}),
  };
  const log = {
    echo: [] as { text: string; severity?: string }[],
    sent: [] as { role: string; text: string; name?: string; comment?: boolean }[],
    hidden: [] as [number, number, boolean][],
    deleted: [] as number[][],
    input: [] as string[],
    generated: [] as { prompt: string; raw: boolean }[],
    calls: [] as string[],
    writes: 0,
  };
  let injects: SlashInject[] = [];
  const messages = init.messages ?? [];
  const host: SlashHost = {
    readVariables: (scope) => Promise.resolve(structuredClone(tables[scope])),
    writeVariables: (scope, table) => {
      tables[scope] = structuredClone(table);
      log.writes += 1;
      return Promise.resolve();
    },
    echo: (text, options) =>
      void log.echo.push({ text, ...(options?.severity ? { severity: options.severity } : {}) }),
    sendMessage: (input) => {
      log.sent.push(input);
      return Promise.resolve();
    },
    getMessages: () => Promise.resolve(messages),
    setHidden: (from, to, hidden) => {
      log.hidden.push([from, to, hidden]);
      return Promise.resolve();
    },
    deleteMessages: (indices) => {
      log.deleted.push(indices);
      return Promise.resolve();
    },
    setInput: (text) => void log.input.push(text),
    generate: (prompt, options) => {
      log.generated.push({ prompt, raw: options.raw });
      return Promise.resolve(`回复:${prompt}`);
    },
    trigger: () => {
      log.calls.push('trigger');
      return Promise.resolve();
    },
    continueGeneration: () => {
      log.calls.push('continue');
      return Promise.resolve();
    },
    regenerate: () => {
      log.calls.push('regenerate');
      return Promise.resolve();
    },
    inject: (prompt) => {
      injects = [...injects.filter((item) => item.id !== prompt.id), prompt];
      return Promise.resolve();
    },
    listInjects: () => Promise.resolve(injects),
    flushInjects: () => {
      injects = [];
      return Promise.resolve();
    },
    setBackground: (name) => {
      log.calls.push(`bg:${name}`);
      return Promise.resolve();
    },
    emote: (label) => {
      log.calls.push(`emote:${label}`);
      return Promise.resolve();
    },
    imagine: (prompt) => {
      log.calls.push(`imagine:${prompt}`);
      return Promise.resolve();
    },
  };
  return { host, tables, log, injects: () => injects };
}

const MESSAGES: SlashMessage[] = [
  { index: 0, name: '昔涟', role: 'assistant', text: '你好', hidden: false },
  { index: 1, name: '开拓者', role: 'user', text: '嗨', hidden: false },
  { index: 2, name: '昔涟', role: 'assistant', text: '今天去哪？', hidden: true },
  { index: 3, name: '开拓者', role: 'user', text: '图书馆', hidden: false },
];

describe('parseSlash', () => {
  it('命令、命名参数、单双引号、管道', () => {
    const script = parseSlash(`/setvar key=a "带 空格 的值" | /echo title='标 题' hi`);
    expect(script.commands).toHaveLength(2);
    const [setvar, echo] = script.commands;
    expect(setvar?.name).toBe('setvar');
    expect(setvar?.named).toEqual([
      { name: 'key', value: { kind: 'text', text: 'a', quoted: false } },
    ]);
    expect(setvar?.unnamed).toEqual([{ kind: 'text', text: '带 空格 的值', quoted: true }]);
    expect(echo?.named[0]).toEqual({
      name: 'title',
      value: { kind: 'text', text: '标 题', quoted: true },
    });
    expect(echo?.unnamed).toEqual([{ kind: 'text', text: 'hi', quoted: false }]);
  });

  it('命名参数之后的 key=value 当普通文本（与 ST 一致）', () => {
    const [command] = parseSlash('/echo hello key=value').commands;
    expect(command?.named).toEqual([]);
    expect(command?.unnamed).toEqual([{ kind: 'text', text: 'hello key=value', quoted: false }]);
  });

  it('嵌套闭包与闭包参数', () => {
    const [command] = parseSlash(
      '/if left=1 rule=eq right=1 {: /times 2 {: /echo x :} :}',
    ).commands;
    const closure = command?.unnamed[0];
    expect(closure?.kind).toBe('closure');
    if (closure?.kind !== 'closure') throw new Error('unreachable');
    expect(closure.commands[0]?.name).toBe('times');
    const inner = closure.commands[0]?.unnamed[1];
    expect(inner?.kind).toBe('closure');
    expect(closure.raw).toBe('{: /times 2 {: /echo x :} :}');

    const [withArgs] = parseSlash('/run {: who=世界 /echo 你好 {{var::who}} :}').commands;
    const argClosure = withArgs?.unnamed[0];
    if (argClosure?.kind !== 'closure') throw new Error('unreachable');
    expect(argClosure.args[0]?.name).toBe('who');
  });

  it('转义：\\| 不断命令，\\{ 保留到执行期', () => {
    const [command] = parseSlash('/echo a \\| b \\{: c').commands;
    expect(command?.unnamed[0]).toEqual({ kind: 'text', text: 'a | b \\{: c', quoted: false });
  });

  it('转义的 \\{ 执行时还原成字面量，不当闭包也不当宏', async () => {
    const { host } = makeHost();
    expect((await runSlash('/pass a \\{: b | /pass {{pipe}} \\{\\{pipe}}', host)).pipe).toBe(
      'a {: b {{pipe}}',
    );
  });

  it('{{…}} 宏里的 | 不断命令', () => {
    const script = parseSlash('/echo {{random::a|b}} | /pass x');
    expect(script.commands).toHaveLength(2);
    expect(script.commands[0]?.unnamed[0]).toEqual({
      kind: 'text',
      text: '{{random::a|b}}',
      quoted: false,
    });
  });

  it('// 注释行跳过，|| 关掉管道注入', () => {
    const script = parseSlash('// 这是注释\n/pass a || /echo');
    expect(script.commands.map((command) => command.name)).toEqual(['pass', 'echo']);
    expect(script.commands[1]?.injectPipe).toBe(false);
  });

  it('闭包没闭合、引号没闭合 → SlashError 带位置', () => {
    expect(() => parseSlash('/if left=1 {: /echo x')).toThrow(SlashError);
    expect(() => parseSlash('/setvar key="abc /echo')).toThrow(/位置/);
  });
});

describe('runSlash：管道与变量', () => {
  it('/setvar → /getvar 管道；{{pipe}}', async () => {
    const { host, tables } = makeHost();
    const result = await runSlash(
      '/setvar key=好感度 5 | /getvar 好感度 | /echo 当前 {{pipe}}',
      host,
    );
    expect(result).toEqual({ pipe: '当前 5', aborted: false });
    expect(tables.local.好感度).toBe('5');
  });

  it('无名参数为空时接收上一条结果；|| 不接', async () => {
    const { host } = makeHost();
    expect((await runSlash('/pass 你好 | /echo', host)).pipe).toBe('你好');
    expect((await runSlash('/pass 你好 || /echo', host)).pipe).toBe('');
  });

  it('/addvar：数字相加、字符串拼接、数组 push；/incvar /decvar', async () => {
    const { host, tables } = makeHost({ local: { n: 1, s: 'a', list: ['x'] }, global: {} });
    await runSlash(
      '/addvar key=n 4 | /addvar key=s b | /addvar key=list y | /incvar n | /incvar n | /decvar n',
      host,
    );
    expect(tables.local).toEqual({ n: 6, s: 'ab', list: ['x', 'y'] });
    expect((await runSlash('/addvar key=新 3', host)).pipe).toBe('3');
  });

  it('点路径写 MVU 变量并保持数字类型；[值,说明] 只改值', async () => {
    const { host, tables } = makeHost({
      local: { stat_data: { 好感度: 30, 信任: [10, '信任度，0-100'] } },
    });
    await runSlash('/setvar key=stat_data.好感度 50 | /addvar key=stat_data.信任 5', host);
    expect(tables.local).toEqual({ stat_data: { 好感度: 50, 信任: [15, '信任度，0-100'] } });
    expect((await runSlash('/getvar stat_data.信任', host)).pipe).toBe('15');
    expect((await runSlash('/getvar stat_data', host)).pipe).toBe(
      JSON.stringify({ 好感度: 50, 信任: [15, '信任度，0-100'] }),
    );
  });

  it('/setvar index= 与 /getvar index=', async () => {
    const { host, tables } = makeHost();
    await runSlash('/setvar key=ages index=John as=number 21 | /setvar key=list index=1 b', host);
    expect(tables.local.ages).toEqual({ John: 21 });
    expect(tables.local.list).toHaveLength(2);
    expect((tables.local.list as unknown[])[1]).toBe('b');
    expect((await runSlash('/getvar key=ages index=John', host)).pipe).toBe('21');
  });

  it('全局变量与 /flushvar /listvar', async () => {
    const { host, tables } = makeHost({ local: { a: 1 }, global: { g: 'x' } });
    await runSlash(
      '/setglobalvar key=h 2 | /addglobalvar key=h 3 | /flushvar a | /flushglobalvar g',
      host,
    );
    expect(tables.global).toEqual({ h: 5 });
    expect(tables.local).toEqual({});
    expect((await runSlash('/getglobalvar h', host)).pipe).toBe('5');
    const listed = await runSlash('/listvar', host);
    expect(listed.pipe).toContain('### Global variables:\nh: 5');
    expect(listed.pipe).toContain('No local variables');
  });

  it('{{getvar::}} {{getglobalvar::}} {{var::}} 宏', async () => {
    const { host } = makeHost({ local: { a: '甲' }, global: { b: '乙' } });
    const result = await runSlash(
      '/pass {{getvar::a}}{{getglobalvar::b}}{{var::a}}{{var::b}}',
      host,
    );
    expect(result.pipe).toBe('甲乙甲乙');
  });
});

describe('runSlash：流程控制', () => {
  it('/if 各 rule 与 else', async () => {
    const { host } = makeHost({ local: { hp: 30 } });
    const run = async (script: string) => (await runSlash(script, host)).pipe;
    expect(await run('/if left=hp rule=gt right=10 {: /pass 大 :}')).toBe('大');
    expect(await run('/if left=hp rule=lt right=10 else={: /pass 否 :} {: /pass 是 :}')).toBe('否');
    expect(await run('/if left=hp rule=eq right=30 {: /pass eq :}')).toBe('eq');
    expect(await run('/if left=hp rule=neq right=30 else={: /pass neq否 :} {: /pass x :}')).toBe(
      'neq否',
    );
    expect(await run('/if left=hp rule=gte right=30 {: /pass gte :}')).toBe('gte');
    expect(await run('/if left=hp rule=lte right=29 else={: /pass lte否 :} {: /pass x :}')).toBe(
      'lte否',
    );
    expect(await run('/if left=abcdef rule=in right=CD {: /pass in :}')).toBe('in');
    expect(await run('/if left=abc rule=nin right=z {: /pass nin :}')).toBe('nin');
    // 右操作数缺省：真值判断
    expect(await run('/if left=hp {: /pass 有 :}')).toBe('有');
    // 主体可以是命令文本（ST 允许）
    expect(await run('/if left=1 right=1 "/pass 文本主体"')).toBe('文本主体');
    await expect(runSlash('/if left=a rule=gt right=b {: /pass x :}', host)).rejects.toThrow(
      SlashError,
    );
  });

  it('/times 与 {{timesIndex}}', async () => {
    const { host, tables } = makeHost();
    const result = await runSlash('/times 3 {: /addvar key=seq {{timesIndex}} :}', host);
    expect(tables.local.seq).toBe(3);
    expect(result.pipe).toBe('3');
    const { host: host2, log } = makeHost();
    await runSlash('/times 2 /echo 第{{timesIndex}}次', host2);
    expect(log.echo.map((item) => item.text)).toEqual(['第0次', '第1次']);
  });

  it('/while 按条件循环；超过上限报错', async () => {
    const { host, tables } = makeHost({ local: { i: 0 } });
    await runSlash('/while left=i rule=lt right=5 {: /incvar i :}', host);
    expect(tables.local.i).toBe(5);

    const { host: host2 } = makeHost({ local: { i: 0 } });
    await expect(
      runSlash('/while left=i rule=lt right=1000 {: /incvar i :}', host2, { maxIterations: 20 }),
    ).rejects.toThrow(/循环超过 20 次上限/);
    await expect(runSlash('/times 500 {: /pass :}', host2)).rejects.toThrow(/上限/);
  });

  it('/run：闭包、变量里存的闭包、闭包参数', async () => {
    const { host, log } = makeHost({
      local: { 打招呼: '{: name=无名 /echo 你好，{{var::name}} :}' },
    });
    await runSlash('/run 打招呼', host);
    await runSlash('/run name=昔涟 打招呼', host);
    expect(log.echo.map((item) => item.text)).toEqual(['你好，无名', '你好，昔涟']);
    expect((await runSlash('/run {: /pass 直接 :}', host)).pipe).toBe('直接');
    // /setvar 存闭包，再 /run
    await runSlash('/setvar key=f {: /pass 存的 :} | /run f | /echo', host);
    expect(log.echo.at(-1)?.text).toBe('存的');
    await expect(runSlash('/run 不存在', host)).rejects.toThrow(/不存在/);
  });

  it('/return 结束当前闭包；/abort 中止整段', async () => {
    const { host, log } = makeHost();
    const result = await runSlash(
      '/run {: /pass a | /return b | /echo 不该执行 :} | /echo 外面{{pipe}}',
      host,
    );
    expect(result.pipe).toBe('外面b');
    expect(log.echo.map((item) => item.text)).toEqual(['外面b']);

    const aborted = await runSlash('/echo 一 | /abort | /echo 二', host);
    expect(aborted).toEqual({ pipe: '', aborted: true });
    expect(log.echo.at(-1)?.text).toBe('一');
  });

  it('未知命令报错，不静默', async () => {
    const { host } = makeHost();
    await expect(runSlash('/nosuch 1', host)).rejects.toThrow('unknown command /nosuch');
  });

  it('signal 取消后不再执行', async () => {
    const { host, log } = makeHost();
    const controller = new AbortController();
    controller.abort();
    const result = await runSlash('/echo 不该出现', host, { signal: controller.signal });
    expect(result.aborted).toBe(true);
    expect(log.echo).toEqual([]);
  });
});

describe('runSlash：输出、数学、消息、生成、注入、其他模块', () => {
  it('/echo 调 host 并把原文往下传', async () => {
    const { host, log } = makeHost();
    const result = await runSlash('/echo severity=warning 注意 | /pass {{pipe}}！', host);
    expect(log.echo).toEqual([{ text: '注意', severity: 'warning' }]);
    expect(result.pipe).toBe('注意！');
  });

  it('数学命令与 /len /rand', async () => {
    const { host } = makeHost({ local: { x: 10 } });
    const run = async (script: string) =>
      (await runSlash(script, host, { random: () => 0.5 })).pipe;
    expect(await run('/add 1 2 3')).toBe('6');
    expect(await run('/add x 5')).toBe('15');
    expect(await run('/sub 10 3 2')).toBe('5');
    expect(await run('/mul [2, 3, 4]')).toBe('24');
    expect(await run('/div 7 2')).toBe('3.5');
    expect(await run('/div 7 0')).toBe('0');
    expect(await run('/mod 7 3')).toBe('1');
    expect(await run('/len 你好世界')).toBe('4');
    expect(await run('/len [1,2,3]')).toBe('3');
    expect(await run('/len {"a":1,"b":2}')).toBe('2');
    expect(await run('/rand')).toBe('0.5');
    expect(await run('/rand from=1 to=11 round=floor')).toBe('6');
    expect(await run('/rand round=round 4')).toBe('2');
  });

  it('消息命令', async () => {
    const { host, log } = makeHost({ messages: MESSAGES });
    await runSlash(
      '/send 你好 | /sendas name=昔涟 嗯 | /sys 旁白 | /narrate 也是旁白 | /comment 注释',
      host,
    );
    expect(log.sent).toEqual([
      { role: 'user', text: '你好' },
      { role: 'assistant', text: '嗯', name: '昔涟' },
      { role: 'system', text: '旁白' },
      { role: 'system', text: '也是旁白' },
      { role: 'system', text: '注释', comment: true },
    ]);
    await runSlash('/hide 1-2 | /unhide 3 | /hide', host);
    expect(log.hidden).toEqual([
      [1, 2, true],
      [3, 3, false],
      [3, 3, true],
    ]);
    expect((await runSlash('/cut 1-2', host)).pipe).toBe('嗨\n今天去哪？\n');
    expect((await runSlash('/del 1', host)).pipe).toBe('图书馆\n');
    expect(log.deleted).toEqual([[1, 2], [3]]);
    await runSlash('/setinput 草稿', host);
    expect(log.input).toEqual(['草稿']);
  });

  it('/messages：缺省带名字、跳过隐藏；names=off / hidden=on / role / 范围', async () => {
    const { host } = makeHost({ messages: MESSAGES });
    const run = async (script: string) => (await runSlash(script, host)).pipe;
    expect(await run('/messages 0-3')).toBe('昔涟: 你好\n\n开拓者: 嗨\n\n开拓者: 图书馆');
    expect(await run('/messages names=off 0-1')).toBe('你好\n\n嗨');
    expect(await run('/messages hidden=on names=off 2')).toBe('今天去哪？');
    expect(await run('/messages role=user names=off')).toBe('嗨\n\n图书馆');
    expect(await run('/messages 9')).toBe('');
  });

  it('生成命令', async () => {
    const { host, log } = makeHost();
    expect((await runSlash('/gen 写一句诗', host)).pipe).toBe('回复:写一句诗');
    expect((await runSlash('/genraw lock=on 原始', host)).pipe).toBe('回复:原始');
    expect(log.generated).toEqual([
      { prompt: '写一句诗', raw: false },
      { prompt: '原始', raw: true },
    ]);
    await runSlash('/trigger | /continue | /regenerate', host);
    expect(log.calls).toEqual(['trigger', 'continue', 'regenerate']);
  });

  it('/inject 参数解析、/listinjects、空内容删除、/flushinjects', async () => {
    const { host, injects, log } = makeHost();
    const id = (
      await runSlash('/inject id=思考 position=chat depth=0 role=user scan=true 先想一想', host)
    ).pipe;
    expect(id).toBe('思考');
    expect(injects()).toEqual([
      { id: '思考', content: '先想一想', position: 'in_chat', depth: 0, role: 'user', scan: true },
    ]);
    await runSlash('/inject id=隐 position=none 触发词', host);
    expect(injects()[1]).toMatchObject({
      id: '隐',
      position: 'none',
      depth: 4,
      role: 'system',
      scan: false,
    });
    const auto = (await runSlash('/inject 自动编号', host, { random: () => 0.1 })).pipe;
    expect(auto).toMatch(/^[0-9a-z]{10}$/);
    expect(JSON.parse((await runSlash('/listinjects', host)).pipe)).toHaveLength(3);
    await runSlash('/inject id=隐', host);
    expect(injects().map((item) => item.id)).toEqual(['思考', auto]);
    await runSlash('/inject position=after 相对位置', host);
    expect(log.echo.at(-1)?.severity).toBe('warning');
    await runSlash('/flushinjects', host);
    expect(injects()).toEqual([]);
  });

  it('/bg /emote /imagine 交给宿主', async () => {
    const { host, log } = makeHost();
    await runSlash('/bg 雨夜 | /emote joy | /imagine a cat', host);
    expect(log.calls).toEqual(['bg:雨夜', 'emote:joy', 'imagine:a cat']);
  });
});

describe('命令清单', () => {
  it('契约列出的命令与别名都在', () => {
    const expected = [
      'echo',
      'pass',
      'return',
      'abort',
      'run',
      'if',
      'times',
      'while',
      'setvar',
      'getvar',
      'addvar',
      'incvar',
      'decvar',
      'flushvar',
      'listvar',
      'setglobalvar',
      'getglobalvar',
      'addglobalvar',
      'incglobalvar',
      'decglobalvar',
      'flushglobalvar',
      'add',
      'sub',
      'mul',
      'div',
      'mod',
      'rand',
      'len',
      'send',
      'sendas',
      'sys',
      'narrate',
      'comment',
      'hide',
      'unhide',
      'cut',
      'del',
      'messages',
      'setinput',
      'gen',
      'genraw',
      'trigger',
      'continue',
      'regenerate',
      'inject',
      'listinjects',
      'flushinjects',
      'bg',
      'emote',
      'imagine',
    ];
    for (const name of expected) expect(SLASH_COMMAND_NAMES).toContain(name);
    // 正式命令数（/narrate 是 /sys 的别名，不单算）
    expect(SLASH_COMMANDS).toHaveLength(49);
  });

  it('isKnownSlashCommand', () => {
    expect(isKnownSlashCommand('/setvar key=a 1')).toBe(true);
    expect(isKnownSlashCommand('  /ECHO hi')).toBe(true);
    expect(isKnownSlashCommand('/narrate x')).toBe(true);
    expect(isKnownSlashCommand('/nosuch')).toBe(false);
    expect(isKnownSlashCommand('/ 空格')).toBe(false);
    expect(isKnownSlashCommand('普通消息')).toBe(false);
  });
});
