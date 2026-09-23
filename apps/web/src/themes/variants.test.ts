import { describe, expect, it } from 'vitest';

import {
  FONT_CHOICES,
  VARIANT_FORMAT,
  checkSlotValue,
  contrastRatio,
  parseVariant,
  parseVariantList,
  variantCss,
  variantFileName,
} from './variants';

/** 不依赖 THEMES（import.meta.glob 在 node 里拿不到 CSS）：用两个最小的世界描述 */
const THEMES = [
  { id: 'liuli', modes: ['light', 'dark'] as const, options: [] },
  {
    id: 'yuye',
    modes: ['dark'] as const,
    options: [{ key: 'rain', label: { zh: '雨', en: 'Rain' }, default: 'on' as const }],
  },
].map((theme) => ({ ...theme, modes: [...theme.modes] }));

const base = {
  format: VARIANT_FORMAT,
  id: 'v-abcdef',
  name: '夜航琉璃',
  base: 'liuli',
  slots: { light: { '--accent': 'oklch(0.70 0.12 190)' }, dark: { '--canvas': '#123' } },
  options: {},
};

describe('变体槽位值校验', () => {
  it('接受颜色 / 允许的字体 / 0–64px / 阴影', () => {
    expect(checkSlotValue('--accent', 'oklch(0.7 0.12 190 / 0.5)')).toBeNull();
    expect(checkSlotValue('--ink', 'rgb(10, 20, 30)')).toBeNull();
    expect(checkSlotValue('--panel', 'transparent')).toBeNull();
    expect(checkSlotValue('--font-story', FONT_CHOICES[3]?.stack)).toBeNull();
    expect(checkSlotValue('--r-card', '12px')).toBeNull();
    expect(checkSlotValue('--r-card', '0')).toBeNull();
    expect(checkSlotValue('--shadow-panel', 'none')).toBeNull();
    expect(checkSlotValue('--shadow-panel', '0 8px 30px oklch(0.7 0.05 220 / 0.25)')).toBeNull();
  });

  it('拦截注入：url( 分号 花括号 @ < 反斜杠 expression( 注释', () => {
    const evil = [
      'url(https://evil.test/x.png)',
      'red; background: url(x)',
      'red } body { display:none',
      '{',
      '@import "x.css"',
      '<style>',
      'red\\3b',
      'expression(alert(1))',
      'red /* hi */',
      'red\n}',
    ];
    for (const value of evil) {
      expect(checkSlotValue('--accent', value), value).toBe('forbidden');
    }
    expect(checkSlotValue('--accent', 'x'.repeat(201))).toBe('too_long');
  });

  it('按类型拒绝', () => {
    expect(checkSlotValue('--accent', 'notacolor')).toBe('color');
    expect(checkSlotValue('--font-ui', 'Comic Sans MS')).toBe('font');
    expect(checkSlotValue('--r-panel', '65px')).toBe('length');
    expect(checkSlotValue('--r-panel', '2em')).toBe('length');
    expect(checkSlotValue('--r-panel', '-1px')).toBe('length');
    expect(checkSlotValue('--shadow-raised', '0 0 red blue green')).toBe('shadow');
    expect(checkSlotValue('--texture-canvas', 'none')).toBe('unknown_slot');
    expect(checkSlotValue('--r-pill', '999px')).toBe('unknown_slot');
    expect(checkSlotValue('--accent', 3)).toBe('type');
  });
});

describe('整份变体', () => {
  it('合法的变体原样通过', () => {
    const parsed = parseVariant(base, { themes: THEMES });
    expect(parsed.errors).toEqual([]);
    expect(parsed.variant).toMatchObject({ id: 'v-abcdef', base: 'liuli', name: '夜航琉璃' });
  });

  it('逐条列出原因：未知槽位、恶意值、未声明的选项、坏 base', () => {
    const parsed = parseVariant(
      {
        ...base,
        slots: {
          light: { '--accent': 'url(x)', '--texture-canvas': 'none', '--ink': 'red;' },
        },
        options: { rain: 'on' },
      },
      { themes: THEMES },
    );
    expect(parsed.variant).toBeNull();
    expect(parsed.errors).toEqual([
      { code: 'slot_value', path: 'slots.light.--accent', detail: 'forbidden' },
      { code: 'slot_unknown', path: 'slots.light.--texture-canvas' },
      { code: 'slot_value', path: 'slots.light.--ink', detail: 'forbidden' },
      { code: 'option_unknown', path: 'options.rain' },
    ]);
    expect(parseVariant({ ...base, base: 'nope' }, { themes: THEMES }).errors[0]?.code).toBe('base');
    expect(parseVariant({ ...base, format: 'x' }, { themes: THEMES }).errors[0]?.code).toBe('format');
    expect(parseVariant('{}', { themes: THEMES }).errors[0]?.code).toBe('not_object');
    expect(parseVariant({ ...base, name: '<b>' }, { themes: THEMES }).errors[0]?.code).toBe('name');
  });

  it('不支持的模式丢弃并提示；选项只收 base 声明过的；id 冲突重新生成', () => {
    const parsed = parseVariant(
      {
        ...base,
        base: 'yuye',
        slots: { light: { '--accent': 'red' }, dark: { '--accent': 'oklch(0.8 0.1 75)' } },
        options: { rain: false },
      },
      { themes: THEMES, takenIds: new Set(['v-abcdef']) },
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.warnings.map((w) => w.code)).toEqual(['mode_unsupported', 'id_regenerated']);
    expect(parsed.variant?.slots).toEqual({ dark: { '--accent': 'oklch(0.8 0.1 75)' } });
    expect(parsed.variant?.options).toEqual({ rain: 'off' });
    expect(parsed.variant?.id).not.toBe('v-abcdef');
    expect(parsed.variant?.id).toMatch(/^v-[A-Za-z0-9]{12}$/);
  });

  it('列表：坏的丢掉，好的保留', () => {
    const list = parseVariantList(
      [base, { ...base, id: 'v-second', slots: { light: { '--accent': '}' } } }, 'junk'],
      THEMES,
    );
    expect(list.map((v) => v.id)).toEqual(['v-abcdef']);
    expect(parseVariantList(null, THEMES)).toEqual([]);
  });
});

describe('生成样式', () => {
  it('选择器带 data-variant，值再过一遍校验', () => {
    const parsed = parseVariant(base, { themes: THEMES });
    const css = variantCss(parsed.variant!);
    expect(css).toContain("[data-theme='liuli'][data-variant='v-abcdef'][data-mode='light'] {");
    expect(css).toContain('--accent: oklch(0.70 0.12 190);');
    expect(css).toContain("[data-mode='dark'] {\n  --canvas: #123;");
    // 绕过 parseVariant 手塞的坏值也写不进去
    const sneaky = variantCss({
      ...parsed.variant!,
      slots: { light: { '--accent': 'red; } body { display: none', '--ink': 'blue' } },
    });
    expect(sneaky).not.toContain('display');
    expect(sneaky).toContain('--ink: blue;');
    expect(variantCss({ ...parsed.variant!, id: "x'] body" })).toBe('');
  });

  it('文件名与对比度', () => {
    expect(variantFileName({ ...parseVariant(base, { themes: THEMES }).variant!, name: 'a/b c' })).toBe(
      'a-b-c.nt-theme.json',
    );
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(black, white)).toBeCloseTo(21, 0);
    expect(contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, white)).toBeCloseTo(4.48, 1);
  });
});
