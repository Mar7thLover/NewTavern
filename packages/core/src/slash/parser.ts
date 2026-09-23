/**
 * slash 脚本（STscript 子集）的解析器。见 docs/M5-CONTRACT.md 第二部分 §3.1。
 *
 * 行为照 SillyTavern `public/scripts/slash-commands/SlashCommandParser.js`（宽松转义模式）核对：
 *
 * - 命令 = `/名字`，名字取到空白或命令结尾为止；
 * - 命名参数必须紧跟在命令名后面（`key=value`，值可以是闭包 / 引号串 / `[列表]` / 裸词）；
 *   一旦开始无名参数，后面的 `key=value` 就是普通文本（与 ST 一致）；
 * - 无名参数 = 余下全部文本（去首尾空白），中间出现闭包则切成「文本 + 闭包」片段；
 *   以引号开头时整段引号串作为一段（引号内的空白原样保留）；
 * - 命令结尾：未转义的 `|`（在 `{{…}}` 宏里面的不算）、闭包结尾 `:}`、文本结束；
 * - `||`：下一条命令**不**自动接收管道值；
 * - 闭包 `{: … :}` 可以嵌套；闭包开头可以有 `key=value` 形式的闭包参数（作为闭包内的 `{{var::key}}`）；
 * - 转义：`\|` → `|`、`\"` / `\'` → 引号、`\\` → `\`；`\{` `\}` 在解析时**保留**，执行时宏展开之后才还原
 *   （ST 同样在 substituteParams 之后才反转义，所以 `\{\{pipe}}` 不会被展开）；
 * - `//` 与 `/#` 开头是注释，一直跳到命令结尾或换行（ST 只认命令结尾；这里多认一个换行，
 *   这样 `// 说明` 独占一行时不会把下一行命令吞掉）；
 * - 两条命令之间不是 `/` 开头的散文字被丢弃（与 ST 一致）。
 *
 * 与 ST 的差异：引号除了 `"` 还认 `'`（契约要求单双引号都支持）；不支持 `/:` 快速回复简写、
 * `/parser-flag`、`/breakpoint`、`/*` 块注释之外的调试语法。
 */

export class SlashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlashError';
  }
}

/** 一段参数值：文本（可能带宏，执行时展开）或闭包 */
export type SlashArgNode = SlashTextNode | SlashClosureNode;

export interface SlashTextNode {
  kind: 'text';
  text: string;
  /** 是不是引号串（引号串不去首尾空白） */
  quoted: boolean;
}

export interface SlashClosureNode {
  kind: 'closure';
  /** 闭包参数（`{: a=1 /echo {{var::a}} :}`） */
  args: SlashNamedArg[];
  commands: SlashCommandNode[];
  /** 源码原文（含 `{:` `:}`），闭包存进变量 / 进管道时就是它 */
  raw: string;
}

export interface SlashNamedArg {
  name: string;
  value: SlashArgNode;
}

export interface SlashCommandNode {
  kind: 'command';
  name: string;
  named: SlashNamedArg[];
  unnamed: SlashArgNode[];
  /** false = 前面是 `||`，不自动接收上一条的结果 */
  injectPipe: boolean;
  /** 命令在源码里的起点（报错定位用） */
  start: number;
}

/** 解析结果：根闭包 */
export interface SlashScript {
  commands: SlashCommandNode[];
  raw: string;
}

const NAMED_ARG_RE = /^(\w+)=/;

class Parser {
  private index = 0;
  /** 当前闭包嵌套层数（0 = 根） */
  private depth = 0;

  constructor(private readonly text: string) {}

  parseScript(): SlashScript {
    const commands = this.parseBlock();
    return { commands, raw: this.text };
  }

  private get char(): string {
    return this.text[this.index] ?? '';
  }

  private at(sequence: string, offset = 0): boolean {
    return this.text.startsWith(sequence, this.index + offset);
  }

  private get done(): boolean {
    return this.index >= this.text.length;
  }

  private fail(message: string, position = this.index): never {
    throw new SlashError(`${message}（位置 ${position}）`);
  }

  private skipWhitespace(): void {
    while (!this.done && /\s/.test(this.char)) this.index += 1;
  }

  private atClosureStart(): boolean {
    return this.at('{:');
  }

  private atClosureEnd(): boolean {
    return this.depth > 0 && this.at(':}');
  }

  /** 命令结尾：未转义的 `|`、闭包结尾、文本结束（反斜杠由调用方先处理） */
  private atCommandEnd(macroDepth = 0): boolean {
    if (this.done) return true;
    if (this.atClosureEnd()) return true;
    return this.char === '|' && macroDepth === 0;
  }

  /** 一个命令块（根或闭包体），直到闭包结尾或文本结束 */
  private parseBlock(): SlashCommandNode[] {
    const commands: SlashCommandNode[] = [];
    let injectPipe = true;
    for (;;) {
      this.skipWhitespace();
      if (this.done) {
        if (this.depth > 0) this.fail('闭包没有闭合（缺少 :}）');
        break;
      }
      if (this.atClosureEnd()) break;

      if (this.at('//') || this.at('/#')) {
        this.skipComment();
      } else if (this.char === '/') {
        const command = this.parseCommand();
        command.injectPipe = injectPipe;
        commands.push(command);
        injectPipe = true;
      } else if (this.char !== '|') {
        // 命令之间的散文字：丢弃到命令结尾（ST 同样丢弃）
        while (!this.atCommandEnd()) {
          if (this.char === '\\') this.index += 1;
          this.index += 1;
        }
      }

      this.skipWhitespace();
      if (this.char === '|') {
        this.index += 1;
        if (this.char === '|') {
          injectPipe = false;
          this.index += 1;
        }
      }
    }
    return commands;
  }

  private skipComment(): void {
    while (!this.done && !this.atCommandEnd() && this.char !== '\n') {
      if (this.char === '\\') this.index += 1;
      this.index += 1;
    }
  }

  private parseCommand(): SlashCommandNode {
    const start = this.index;
    this.index += 1; // 「/」
    let name = '';
    while (!this.done && !/\s/.test(this.char) && !this.atCommandEnd()) {
      name += this.char;
      this.index += 1;
    }
    if (name === '') this.fail('命令名为空', start);

    const named: SlashNamedArg[] = [];
    this.skipWhitespace();
    while (
      !this.atCommandEnd() &&
      NAMED_ARG_RE.test(this.text.slice(this.index, this.index + 64))
    ) {
      named.push(this.parseNamedArg());
      this.skipWhitespace();
    }

    const unnamed = this.atCommandEnd() ? [] : this.parseUnnamed();
    return { kind: 'command', name: name.toLowerCase(), named, unnamed, injectPipe: true, start };
  }

  private parseNamedArg(): SlashNamedArg {
    const match = NAMED_ARG_RE.exec(this.text.slice(this.index, this.index + 64));
    const name = match?.[1] ?? '';
    this.index += name.length + 1;
    if (this.atClosureStart()) return { name, value: this.parseClosure() };
    if (this.char === '"' || this.char === "'") {
      return { name, value: { kind: 'text', text: this.parseQuoted(), quoted: true } };
    }
    if (this.char === '[')
      return { name, value: { kind: 'text', text: this.parseList(), quoted: false } };
    return { name, value: { kind: 'text', text: this.parseBareValue(), quoted: false } };
  }

  /** 引号串：到同种未转义引号为止；`\"` `\\` 反转义，`\{` `\}` 原样保留 */
  private parseQuoted(): string {
    const quote = this.char;
    const start = this.index;
    this.index += 1;
    let value = '';
    for (;;) {
      if (this.done) this.fail('引号没有闭合', start);
      const char = this.char;
      if (char === '\\') {
        const next = this.text[this.index + 1] ?? '';
        if (next === quote || next === '\\' || next === '|') {
          value += next;
          this.index += 2;
          continue;
        }
        value += char;
        this.index += 1;
        continue;
      }
      if (char === quote) {
        this.index += 1;
        return value;
      }
      value += char;
      this.index += 1;
    }
  }

  /** `[a, b]`：原样取到配对的 `]`（JSON 列表值，执行时再解析） */
  private parseList(): string {
    const start = this.index;
    let depth = 0;
    let value = '';
    for (;;) {
      if (this.done) this.fail('列表没有闭合（缺少 ]）', start);
      const char = this.char;
      value += char;
      this.index += 1;
      if (char === '[') depth += 1;
      else if (char === ']') {
        depth -= 1;
        if (depth === 0) return value;
      }
    }
  }

  /** 裸值：到空白或命令结尾 */
  private parseBareValue(): string {
    let value = '';
    let macroDepth = 0;
    while (!this.done && !/\s/.test(this.char) && !this.atCommandEnd(macroDepth)) {
      if (this.char === '\\') {
        value += this.readEscape();
        continue;
      }
      if (this.at('{{')) macroDepth += 1;
      else if (this.at('}}') && macroDepth > 0) macroDepth -= 1;
      value += this.char;
      this.index += 1;
    }
    return value;
  }

  /** 反斜杠转义：`\|` `\\` `\"` `\'` 反转义；`\{` `\}` 保留原样（执行时才还原）；其余保留反斜杠 */
  private readEscape(): string {
    const next = this.text[this.index + 1] ?? '';
    if (next === '|' || next === '\\' || next === '"' || next === "'") {
      this.index += 2;
      return next;
    }
    if (next === '{' || next === '}' || next === ':') {
      this.index += 2;
      return `\\${next}`;
    }
    this.index += 1;
    return '\\';
  }

  private parseUnnamed(): SlashArgNode[] {
    const pieces: SlashArgNode[] = [];
    let buffer = '';
    let macroDepth = 0;

    if (this.char === '"' || this.char === "'") {
      // 只有「整个无名参数就是一个引号串」时才当引号处理；`'s` 这类撇号照常当文本
      const save = this.index;
      let quoted: string | null = null;
      try {
        quoted = this.parseQuoted();
      } catch {
        quoted = null;
      }
      if (quoted !== null) {
        this.skipWhitespace();
        if (this.atCommandEnd() || this.atClosureStart()) {
          pieces.push({ kind: 'text', text: quoted, quoted: true });
        } else {
          this.index = save;
        }
      } else {
        this.index = save;
      }
    }

    const flush = () => {
      if (buffer !== '') pieces.push({ kind: 'text', text: buffer, quoted: false });
      buffer = '';
    };

    while (!this.atCommandEnd(macroDepth)) {
      if (this.char === '\\') {
        buffer += this.readEscape();
        continue;
      }
      if (macroDepth === 0 && this.atClosureStart()) {
        flush();
        pieces.push(this.parseClosure());
        continue;
      }
      if (this.at('{{')) {
        macroDepth += 1;
        buffer += '{{';
        this.index += 2;
        continue;
      }
      if (this.at('}}') && macroDepth > 0) {
        macroDepth -= 1;
        buffer += '}}';
        this.index += 2;
        continue;
      }
      buffer += this.char;
      this.index += 1;
    }
    flush();

    // 首尾非引号文本去空白，空的丢掉（ST parseUnnamedArgument 同样处理）
    const first = pieces[0];
    if (first?.kind === 'text' && !first.quoted) {
      first.text = first.text.trimStart();
      if (first.text === '') pieces.shift();
    }
    const last = pieces[pieces.length - 1];
    if (last?.kind === 'text' && !last.quoted) {
      last.text = last.text.trimEnd();
      if (last.text === '') pieces.pop();
    }
    return pieces;
  }

  private parseClosure(): SlashClosureNode {
    const start = this.index;
    this.index += 2; // 「{:」
    this.depth += 1;
    this.skipWhitespace();
    const args: SlashNamedArg[] = [];
    while (
      !this.done &&
      !this.atClosureEnd() &&
      NAMED_ARG_RE.test(this.text.slice(this.index, this.index + 64))
    ) {
      args.push(this.parseNamedArg());
      this.skipWhitespace();
    }
    const commands = this.parseBlock();
    if (!this.at(':}')) this.fail('闭包没有闭合（缺少 :}）', start);
    this.index += 2;
    this.depth -= 1;
    return { kind: 'closure', args, commands, raw: this.text.slice(start, this.index) };
  }
}

/** 解析一段 slash 脚本；语法错抛 `SlashError`（带位置） */
export function parseSlash(script: string): SlashScript {
  return new Parser(script).parseScript();
}

/** 整段文本是不是一个闭包（`{: … :}`），是就解析出来（`/run` 执行变量里存的闭包用） */
export function parseClosureText(text: string): SlashClosureNode | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{:') || !trimmed.endsWith(':}')) return null;
  const script = parseSlash(`/__closure ${trimmed}`);
  const command = script.commands[0];
  const closure = command?.unnamed[0];
  if (
    script.commands.length !== 1 ||
    command?.unnamed.length !== 1 ||
    closure?.kind !== 'closure'
  ) {
    return null;
  }
  return closure;
}
