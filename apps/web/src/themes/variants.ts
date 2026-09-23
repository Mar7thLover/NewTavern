import type { ThemeMeta, ThemeMode, ThemeOptionValue } from './registry';

/**
 * 主题变体（M4（二）契约 §C）：一个世界的「另一套颜色 / 字体 / 圆角 / 影」。
 *
 * 变体只能改 slots.css 声明过的**白名单槽位**与 base 主题声明过的 options；
 * 世界的形态（材质类覆盖、记忆物件、纹理、背景处理）不因变体改变。
 * 值一律过校验：禁止 `url(` `;` `{` `}` `@` `<` 反斜杠 `expression(` `/*`，
 * 颜色须被 `CSS.supports('color', v)` 接受，字体只能从允许列表选，长度只能 0–64px。
 */

export const VARIANT_FORMAT = 'newtavern-theme-variant@1';

export type VariantSlots = Partial<Record<ThemeMode, Record<string, string>>>;

export interface ThemeVariant {
  format: typeof VARIANT_FORMAT;
  id: string;
  name: string;
  /** 六个世界之一 */
  base: string;
  slots: VariantSlots;
  options: Record<string, ThemeOptionValue>;
}

/* ------------------------------------------------------------------ */
/* 白名单                                                               */
/* ------------------------------------------------------------------ */

export type SlotKind = 'color' | 'font' | 'length' | 'shadow';

/** 编辑器分组：颜色（表面 / 文字 / 强调 / 语义）、字体、形、影 */
export type SlotGroup = 'surface' | 'ink' | 'accent' | 'semantic' | 'font' | 'shape' | 'shadow';

export interface SlotSpec {
  name: string;
  kind: SlotKind;
  group: SlotGroup;
}

const spec = (group: SlotGroup, kind: SlotKind, names: string[]): SlotSpec[] =>
  names.map((name) => ({ name, kind, group }));

/**
 * 可被变体覆盖的槽位（slots.css 的子集）。
 * 纹理（`--texture-*`）、动效、排版尺度、`--r-pill`（999px）不在其中：它们是世界的形态。
 */
export const VARIANT_SLOTS: readonly SlotSpec[] = [
  ...spec('surface', 'color', [
    '--canvas',
    '--reading',
    '--panel',
    '--control',
    '--raised',
    '--overlay',
    '--edge',
    '--edge-strong',
    '--edge-focus',
    '--edge-highlight',
  ]),
  ...spec('ink', 'color', [
    '--ink',
    '--ink-story',
    '--ink-2',
    '--ink-3',
    '--ink-on-primary',
    '--ink-link',
    '--ink-quote',
    '--ink-action',
  ]),
  ...spec('accent', 'color', [
    '--accent',
    '--accent-soft',
    '--primary',
    '--primary-2',
    '--primary-edge',
    '--primary-glow',
    '--primary-soft',
  ]),
  ...spec('semantic', 'color', [
    '--danger',
    '--danger-soft',
    '--success',
    '--success-soft',
    '--warning',
    '--warning-soft',
    '--info',
    '--info-soft',
  ]),
  ...spec('font', 'font', ['--font-ui', '--font-story', '--font-display']),
  ...spec('shape', 'length', ['--r-panel', '--r-card', '--r-control']),
  ...spec('shadow', 'shadow', ['--shadow-panel', '--shadow-raised', '--shadow-control']),
];

const SLOT_BY_NAME = new Map(VARIANT_SLOTS.map((slot) => [slot.name, slot]));

export function slotSpec(name: string): SlotSpec | undefined {
  return SLOT_BY_NAME.get(name);
}

export interface FontChoice {
  id: string;
  label: { zh: string; en: string };
  stack: string;
  /** 这套字需要的 web 字体（与各世界 loadFonts 用同一批分片包） */
  load?: () => Promise<unknown>;
}

/** 字体允许列表：各世界已声明的字体 + 系统栈 */
export const FONT_CHOICES: readonly FontChoice[] = [
  {
    id: 'inter',
    label: { zh: 'Inter / 思源黑体', en: 'Inter / Noto Sans SC' },
    stack:
      "'Inter Variable', Inter, 'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    load: () => import('@fontsource-variable/inter/index.css'),
  },
  {
    id: 'sans',
    label: { zh: '思源黑体', en: 'Noto Sans SC' },
    stack:
      "'Noto Sans SC', 'Source Han Sans SC', 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif",
    load: () => import('@fontsource/noto-sans-sc/chinese-simplified-400.css'),
  },
  {
    id: 'serif',
    label: { zh: '思源宋体', en: 'Noto Serif SC' },
    stack:
      "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', STSong, SimSun, serif",
    load: () => import('@fontsource/noto-serif-sc/chinese-simplified-400.css'),
  },
  {
    id: 'kai',
    label: { zh: '霞鹜文楷', en: 'LXGW WenKai' },
    stack: "'LXGW WenKai Screen', 'LXGW WenKai', 'Kaiti SC', STKaiti, KaiTi, serif",
    load: () => import('lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css'),
  },
  {
    id: 'system',
    label: { zh: '系统无衬线', en: 'System sans' },
    stack: "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  },
  {
    id: 'system-serif',
    label: { zh: '系统衬线', en: 'System serif' },
    stack: "'Songti SC', 'Noto Serif CJK SC', SimSun, Georgia, serif",
  },
];

export function fontChoiceOf(stack: string): FontChoice | undefined {
  return FONT_CHOICES.find((choice) => choice.stack === stack);
}

/** 长度类槽位上限 */
export const LENGTH_MAX_PX = 64;

/* ------------------------------------------------------------------ */
/* 值校验                                                               */
/* ------------------------------------------------------------------ */

export type Supports = (property: string, value: string) => boolean;

/** 注入样式的禁用片段（控制字符是有意拦截的） */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /url\(|;|\{|\}|@|<|>|\\|expression\(|\/\*|\*\/|[\u0000-\u001f\u007f]/i;

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`;
const COMPONENT = String.raw`(?:${NUMBER}(?:%|deg|rad|grad|turn)?|none)`;
const COLOR_FN = new RegExp(
  String.raw`^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*${COMPONENT}(?:\s*[,\s]\s*${COMPONENT}){2}(?:\s*[,/]\s*${COMPONENT})?\s*\)$`,
  'i',
);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
/** CSS 具名颜色（无 CSS 的环境里兜底用；浏览器里一律交给 CSS.supports） */
const NAMED = new Set(
  (
    'transparent currentcolor aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue ' +
    'darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid ' +
    'darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink ' +
    'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold ' +
    'goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush ' +
    'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey ' +
    'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime ' +
    'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin ' +
    'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise ' +
    'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue ' +
    'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow ' +
    'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

function fallbackIsColor(value: string): boolean {
  const v = value.trim();
  return HEX.test(v) || COLOR_FN.test(v) || NAMED.has(v.toLowerCase());
}

const LENGTH_TOKEN = new RegExp(String.raw`^[+-]?(?:\d+\.?\d*|\.\d+)(?:px|em|rem)?$`, 'i');

/** 顶层逗号切分（括号内的逗号不切） */
function splitTopLevel(value: string, separator: ',' | ' '): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of value) {
    if (char === '(') depth++;
    else if (char === ')') depth = Math.max(0, depth - 1);
    const isSep = separator === ' ' ? /\s/.test(char) : char === separator;
    if (isSep && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function fallbackIsShadow(value: string): boolean {
  if (value.trim() === 'none') return true;
  return splitTopLevel(value, ',').every((layer) => {
    const tokens = splitTopLevel(layer, ' ');
    let lengths = 0;
    let colors = 0;
    for (const token of tokens) {
      if (token === 'inset') continue;
      if (LENGTH_TOKEN.test(token)) lengths++;
      else if (fallbackIsColor(token)) colors++;
      else return false;
    }
    return lengths >= 2 && lengths <= 4 && colors <= 1;
  });
}

/** 浏览器里用 CSS.supports；测试（node）里用上面的兜底语法 */
export const defaultSupports: Supports = (property, value) => {
  const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
  if (css?.supports) return css.supports(property, value);
  if (property === 'color') return fallbackIsColor(value);
  if (property === 'box-shadow') return fallbackIsShadow(value);
  return false;
};

export type SlotValueProblem = 'type' | 'empty' | 'too_long' | 'forbidden' | 'color' | 'font' | 'length' | 'shadow' | 'unknown_slot';

/** 校验单个槽位值；合法返回 null，否则返回问题代码 */
export function checkSlotValue(
  name: string,
  value: unknown,
  supports: Supports = defaultSupports,
): SlotValueProblem | null {
  const slot = SLOT_BY_NAME.get(name);
  if (!slot) return 'unknown_slot';
  if (typeof value !== 'string') return 'type';
  const v = value.trim();
  if (!v) return 'empty';
  if (v.length > 200) return 'too_long';
  if (FORBIDDEN.test(v)) return 'forbidden';
  switch (slot.kind) {
    case 'color':
      return supports('color', v) ? null : 'color';
    case 'font':
      return fontChoiceOf(v) ? null : 'font';
    case 'length': {
      const match = /^(\d+(?:\.\d+)?)(px)?$/.exec(v);
      if (!match) return 'length';
      const px = Number(match[1]);
      if (!match[2] && px !== 0) return 'length';
      return px >= 0 && px <= LENGTH_MAX_PX ? null : 'length';
    }
    case 'shadow':
      return v === 'none' || supports('box-shadow', v) ? null : 'shadow';
  }
}

/* ------------------------------------------------------------------ */
/* 整份变体的解析（导入 / 读 settings）                                   */
/* ------------------------------------------------------------------ */

export type VariantIssueCode =
  | 'not_object'
  | 'format'
  | 'name'
  | 'base'
  | 'slots'
  | 'mode_unsupported'
  | 'slot_unknown'
  | 'slot_value'
  | 'option_unknown'
  | 'option_value'
  | 'id_regenerated';

export interface VariantIssue {
  code: VariantIssueCode;
  /** 出问题的位置：`slots.dark.--accent`、`options.rain` … */
  path?: string;
  /** 附加说明（槽位值的问题代码、被丢弃的模式名 …） */
  detail?: string;
}

export interface ParsedVariant {
  variant: ThemeVariant | null;
  /** 导致整份无效的问题 */
  errors: VariantIssue[];
  /** 已自动处理（丢弃不支持的模式、重新生成 id）的问题 */
  warnings: VariantIssue[];
}

const ID_PATTERN = /^v-[A-Za-z0-9_-]{4,40}$/;
const NAME_MAX = 60;

export function newVariantId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  let id = 'v-';
  for (const byte of bytes) id += alphabet[byte % alphabet.length];
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface ParseVariantOptions {
  themes: readonly Pick<ThemeMeta, 'id' | 'modes' | 'options'>[];
  /** 已有的变体 id：冲突时重新生成 */
  takenIds?: ReadonlySet<string>;
  supports?: Supports;
}

/** 校验并规范化一份变体 JSON；有 error 时 variant 为 null */
export function parseVariant(input: unknown, options: ParseVariantOptions): ParsedVariant {
  const errors: VariantIssue[] = [];
  const warnings: VariantIssue[] = [];
  const supports = options.supports ?? defaultSupports;
  if (!isRecord(input)) return { variant: null, errors: [{ code: 'not_object' }], warnings };

  if (input['format'] !== VARIANT_FORMAT) errors.push({ code: 'format', path: 'format' });

  const rawName = input['name'];
  const name = typeof rawName === 'string' ? rawName.trim() : '';
  if (!name || Array.from(name).length > NAME_MAX || FORBIDDEN.test(name)) {
    errors.push({ code: 'name', path: 'name' });
  }

  const theme = options.themes.find((item) => item.id === input['base']);
  if (!theme) errors.push({ code: 'base', path: 'base', detail: String(input['base'] ?? '') });

  const slots: VariantSlots = {};
  const rawSlots = input['slots'] ?? {};
  if (!isRecord(rawSlots)) {
    errors.push({ code: 'slots', path: 'slots' });
  } else {
    for (const [mode, values] of Object.entries(rawSlots)) {
      if (mode !== 'light' && mode !== 'dark') {
        errors.push({ code: 'slots', path: `slots.${mode}` });
        continue;
      }
      if (!isRecord(values)) {
        errors.push({ code: 'slots', path: `slots.${mode}` });
        continue;
      }
      if (theme && !theme.modes.includes(mode)) {
        warnings.push({ code: 'mode_unsupported', path: `slots.${mode}`, detail: mode });
        continue;
      }
      const out: Record<string, string> = {};
      for (const [slotName, value] of Object.entries(values)) {
        const problem = checkSlotValue(slotName, value, supports);
        if (problem === 'unknown_slot') {
          errors.push({ code: 'slot_unknown', path: `slots.${mode}.${slotName}` });
        } else if (problem) {
          errors.push({ code: 'slot_value', path: `slots.${mode}.${slotName}`, detail: problem });
        } else {
          out[slotName] = (value as string).trim();
        }
      }
      if (Object.keys(out).length > 0) slots[mode] = out;
    }
  }

  const variantOptions: Record<string, ThemeOptionValue> = {};
  const rawOptions = input['options'] ?? {};
  if (!isRecord(rawOptions)) {
    errors.push({ code: 'option_unknown', path: 'options' });
  } else {
    for (const [key, value] of Object.entries(rawOptions)) {
      const declared = theme?.options?.some((option) => option.key === key);
      // 布尔也收：手写 JSON 时常写 true / false
      const normalized = value === true ? 'on' : value === false ? 'off' : value;
      if (!declared) errors.push({ code: 'option_unknown', path: `options.${key}` });
      else if (normalized !== 'on' && normalized !== 'off') {
        errors.push({ code: 'option_value', path: `options.${key}` });
      } else variantOptions[key] = normalized;
    }
  }

  let id = typeof input['id'] === 'string' ? input['id'] : '';
  if (!ID_PATTERN.test(id) || options.takenIds?.has(id)) {
    if (id) warnings.push({ code: 'id_regenerated', path: 'id' });
    do id = newVariantId();
    while (options.takenIds?.has(id));
  }

  if (errors.length > 0 || !theme) return { variant: null, errors, warnings };
  return {
    variant: { format: VARIANT_FORMAT, id, name, base: theme.id, slots, options: variantOptions },
    errors,
    warnings,
  };
}

/** settings KV 里的列表：逐项校验，坏的丢掉（不报错，设置页只显示能用的） */
export function parseVariantList(
  value: unknown,
  themes: ParseVariantOptions['themes'],
  supports?: Supports,
): ThemeVariant[] {
  if (!Array.isArray(value)) return [];
  const out: ThemeVariant[] = [];
  const taken = new Set<string>();
  for (const item of value) {
    // 已存的变体 id 不该被重新生成：只有真的撞了才换
    const parsed = parseVariant(item, { themes, takenIds: taken, ...(supports ? { supports } : {}) });
    if (parsed.variant) {
      out.push(parsed.variant);
      taken.add(parsed.variant.id);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 生成样式                                                             */
/* ------------------------------------------------------------------ */

/**
 * 变体 → CSS 文本。选择器 `[data-theme][data-variant][data-mode]`（特异性 0,3,0）
 * 高于主题 theme.css 的槽位赋值（`[data-theme][data-mode]`，0,2,0）。
 * 值在这里再过一遍校验：永远不会把没通过的值写进样式表。
 */
export function variantCss(variant: ThemeVariant, supports: Supports = defaultSupports): string {
  if (!ID_PATTERN.test(variant.id) || !/^[a-z0-9-]+$/.test(variant.base)) return '';
  const blocks: string[] = [];
  for (const mode of ['light', 'dark'] as const) {
    const values = variant.slots[mode];
    if (!values) continue;
    const lines = Object.entries(values)
      .filter(([name, value]) => checkSlotValue(name, value, supports) === null)
      .map(([name, value]) => `  ${name}: ${value.trim()};`);
    if (lines.length === 0) continue;
    blocks.push(
      `[data-theme='${variant.base}'][data-variant='${variant.id}'][data-mode='${mode}'] {\n${lines.join('\n')}\n}`,
    );
  }
  return blocks.join('\n');
}

/** 变体用到的字体（应用时一并懒加载） */
export function variantFonts(variant: ThemeVariant): FontChoice[] {
  const out = new Set<FontChoice>();
  for (const values of Object.values(variant.slots)) {
    for (const [name, value] of Object.entries(values ?? {})) {
      if (slotSpec(name)?.kind !== 'font') continue;
      const choice = fontChoiceOf(value);
      if (choice) out.add(choice);
    }
  }
  return [...out];
}

/** 导出文件名：`<名字>.nt-theme.json`（去掉文件名里不安全的字符） */
export function variantFileName(variant: ThemeVariant): string {
  const safe = variant.name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '') || 'variant';
  return `${safe}.nt-theme.json`;
}

/* ------------------------------------------------------------------ */
/* 对比度（编辑器就地提示：正文 vs 阅读面 < 4.5）                          */
/* ------------------------------------------------------------------ */

/** WCAG 对比度；颜色取浏览器算出的 `rgb()`/`color(srgb …)` 字符串 */
export function contrastRatio(foreground: RgbColor, background: RgbColor): number {
  const lum = (c: RgbColor) => {
    const channel = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  };
  const a = lum(foreground);
  const b = lum(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export interface RgbColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 前景叠在底色上（alpha 合成） */
export function composite(top: RgbColor, bottom: RgbColor): RgbColor {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}
