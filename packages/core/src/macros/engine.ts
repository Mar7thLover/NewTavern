/**
 * 宏引擎（M2 子集）。行为对齐 SillyTavern 1.18 `public/scripts/macros.js` 的
 * `evaluateMacros`：先处理 newline/trim/noop，再替换环境变量，最后处理注释与时间宏。
 * 宏名大小写不敏感、不允许内部空白（与 ST 的正则一致）；未知宏原样保留。
 * 完整宏集（getvar/random/pick/roll 等）留到 M3。
 */

export interface MacroContext {
  /** {{char}}：角色名 */
  char?: string;
  /** {{user}}：用户（Persona）名 */
  user?: string;
  /** {{persona}}：Persona 描述（ST 语义：不是名字） */
  persona?: string;
  /** {{description}}：角色卡 description */
  description?: string;
  /** {{personality}}：角色卡 personality */
  personality?: string;
  /** {{scenario}}：角色卡 scenario */
  scenario?: string;
  /** {{mesExamples}}：角色卡 mes_example */
  mesExamples?: string;
  /** {{original}}：仅在角色卡覆盖预设提示词时提供；未提供时原样保留 */
  original?: string;
  /** {{time}} / {{date}} 的基准时刻，缺省 new Date() */
  now?: Date;
}

export interface MacroResult {
  text: string;
  /** 含随时间变化的宏（{{time}} / {{date}}），该段不应进入可缓存的稳定层 */
  volatile: boolean;
}

/** 会随时间变化的宏；命中即把所在段标记为 volatile */
const VOLATILE_PATTERN = /{{(?:time|date)}}/i;

/** 环境宏名 → MacroContext 键；顺序即替换顺序（与 ST 的 env 遍历同为一趟一个宏） */
const ENV_MACROS = [
  // ST 把 original 放在 env 的最前，因此被插回的原内容里的 {{char}} 等还会继续展开
  'original',
  'char',
  'user',
  'persona',
  'description',
  'personality',
  'scenario',
  'mesExamples',
] as const satisfies readonly (keyof MacroContext)[];

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** moment 的 `LT` 格式（en 语言环境）：`8:05 PM` */
function formatTime(date: Date): string {
  const hours24 = date.getHours();
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes} ${hours24 < 12 ? 'AM' : 'PM'}`;
}

/** moment 的 `LL` 格式（en 语言环境）：`September 13, 2026` */
function formatDate(date: Date): string {
  return `${MONTHS[date.getMonth()]} ${date.getDate()}, ${date.getFullYear()}`;
}

/** 替换文本中的宏，并报告是否含易变宏 */
export function substituteMacrosDetailed(text: string, ctx: MacroContext = {}): MacroResult {
  if (!text) return { text: '', volatile: false };

  const volatile = VOLATILE_PATTERN.test(text);
  let out = text;

  // 一、环境宏之前的内建宏（ST preEnvMacros）
  out = out.replace(/{{newline}}/gi, () => '\n');
  // ST：{{trim}} 连同两侧的换行一起删除（只吃换行，不吃空格）
  out = out.replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, () => '');
  out = out.replace(/{{noop}}/gi, () => '');

  // 二、环境宏
  for (const name of ENV_MACROS) {
    const value = ctx[name];
    if (name === 'original') {
      // {{original}} 只在调用方提供时替换（角色卡覆盖预设时才有意义），否则保留字面量；
      // 且与 ST 一致：只有第一次出现会展开，其余替换为空串
      if (value === undefined) continue;
      let used = false;
      out = out.replace(/{{original}}/gi, () => {
        if (used) return '';
        used = true;
        return value;
      });
      continue;
    }
    const replacement = typeof value === 'string' ? value : '';
    out = out.replace(new RegExp(`{{${name}}}`, 'gi'), () => replacement);
  }

  // 三、环境宏之后的内建宏（ST postEnvMacros）
  out = out.replace(/{{\/\/[\s\S]*?}}/g, () => '');
  if (volatile) {
    const now = ctx.now ?? new Date();
    out = out.replace(/{{time}}/gi, () => formatTime(now));
    out = out.replace(/{{date}}/gi, () => formatDate(now));
  }

  return { text: out, volatile };
}

/** 替换文本中的宏（不关心易变性时用这个） */
export function substituteMacros(text: string, ctx: MacroContext = {}): string {
  return substituteMacrosDetailed(text, ctx).text;
}
