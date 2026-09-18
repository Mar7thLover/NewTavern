import { sanitizeInlineStyle, scopeCardCss } from '@newtavern/core';
import { defaultSchema } from 'rehype-sanitize';

/**
 * 卡自带前端（HTML）的渲染策略。
 *
 * 角色卡 / 世界书 / 预设的正则常把正文替换成一整段 HTML+CSS（社区叫「正则前端」）。
 * 我们按 ST 的做法内联渲染，但把安全边界收紧成三条：
 *
 * 1. **白名单净化**：以 `rehype-sanitize` 的 GitHub 白名单为底，放开卡真正需要的
 *    `class` / `style` / `data-*` / `<style>` / SVG 子集；`<script>` `<iframe>` 之类连内容一起剥掉。
 * 2. **CSS 关进作用域**：`<style>` 里的规则用 `@scope` 圈到这一条消息（见 core 的 `scopeCardCss`），
 *    卡不会污染整个应用，两张卡也不会互相打架。
 * 3. **不执行脚本**：带 `<script>` 的卡只会少掉交互，静态部分照样显示。
 *    需要跑脚本的前端卡是 M5 的 iframe 沙箱，不在这里。
 *
 * 注意：净化后的树是 react-markdown 直接转成 React 元素的，中途没有 `innerHTML` 再解析一次，
 * 所以不存在 mXSS 那类「净化完又被重新解释」的缺口。
 */

/* ------------------------------------------------------------------ */
/* 白名单                                                              */
/* ------------------------------------------------------------------ */

/** 卡画图标常用的 SVG 子集：只有纯绘制元素，`use` / `foreignObject` 一律不收 */
const SVG_TAGS = [
  'svg',
  'g',
  'defs',
  'title',
  'desc',
  'path',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'rect',
  'text',
  'tspan',
  'linearGradient',
  'radialGradient',
  'stop',
  'clipPath',
  'mask',
];

/** SVG 的绘制属性（hast 里是驼峰名） */
const SVG_ATTRIBUTES = [
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'fill',
  'fillOpacity',
  'fillRule',
  'gradientTransform',
  'gradientUnits',
  'offset',
  'opacity',
  'patternUnits',
  'points',
  'preserveAspectRatio',
  'r',
  'rx',
  'ry',
  'stopColor',
  'stopOpacity',
  'stroke',
  'strokeDasharray',
  'strokeDashoffset',
  'strokeLinecap',
  'strokeLinejoin',
  'strokeMiterlimit',
  'strokeOpacity',
  'strokeWidth',
  'textAnchor',
  'transform',
  'viewBox',
  'x',
  'x1',
  'x2',
  'xmlns',
  'y',
  'y1',
  'y2',
];

const defaultAttributes = defaultSchema.attributes ?? {};
const defaultTags = defaultSchema.tagNames ?? [];

/**
 * 正文用的净化白名单。
 *
 * `clobber` 清空是刻意的：卡的 CSS 常用 `#id` 选择器，默认的 `user-content-` 前缀会让它们全部落空。
 * DOM clobbering 的前提是宿主页面直接读 `window.<name>` / `document.<name>`，本应用不这么做。
 */
export const richSchema = {
  ...defaultSchema,
  clobber: [],
  strip: [
    'script',
    'iframe',
    'object',
    'embed',
    'applet',
    'link',
    'meta',
    'base',
    'form',
    'noscript',
    'template',
    'frame',
    'frameset',
  ],
  tagNames: [
    ...defaultTags,
    'style',
    'abbr',
    'big',
    'button',
    'caption',
    'center',
    'col',
    'colgroup',
    'figcaption',
    'figure',
    'font',
    'header',
    'footer',
    'main',
    'mark',
    'meter',
    'nav',
    'progress',
    'small',
    'time',
    'u',
    'wbr',
    ...SVG_TAGS,
  ],
  attributes: {
    ...defaultAttributes,
    img: [...(defaultAttributes.img ?? []), 'loading', 'decoding', 'srcSet', 'sizes'],
    // 按钮没有脚本可跑，type 固定成 button，免得落在某个表单里变成提交键
    button: [['type', 'button']],
    meter: ['value', 'min', 'max', 'low', 'high', 'optimum'],
    progress: ['value', 'max'],
    time: ['dateTime'],
    font: ['color', 'face', 'size'],
    '*': [
      ...(defaultAttributes['*'] ?? []),
      'className',
      'style',
      'data*',
      'role',
      ...SVG_ATTRIBUTES,
    ],
  },
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    // 卡里内嵌 base64 图片是常态
    src: ['http', 'https', 'data'],
  },
  required: {
    ...(defaultSchema.required ?? {}),
    button: { type: 'button' },
  },
};

/* ------------------------------------------------------------------ */
/* rehype 插件：CSS 作用域化 + 行内 style 净化                          */
/* ------------------------------------------------------------------ */

/** hast 节点的最小子集；和 Markdown.tsx 一样，不为类型引入 unified 的间接依赖 */
interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

function walk(node: HastNode, uid: string): void {
  if (node.type === 'element' && node.tagName === 'style') {
    const source = (node.children ?? [])
      .filter((child) => child.type === 'text')
      .map((child) => child.value ?? '')
      .join('');
    const { css } = scopeCardCss(source, uid);
    node.children = css ? [{ type: 'text', value: css }] : [];
    return;
  }

  const style = node.properties?.style;
  if (typeof style === 'string' && node.properties) {
    node.properties.style = sanitizeInlineStyle(style);
  }

  for (const child of node.children ?? []) walk(child, uid);
}

/**
 * 把这条消息里 `<style>` 的 CSS 关进 `[data-nt-html="<uid>"]`，并净化行内 `style`。
 * 必须排在 `rehype-sanitize` 之后：净化先决定哪些节点还在，我们再改内容。
 */
export function rehypeCardHtml(options: { uid: string }) {
  return (tree: HastNode) => {
    walk(tree, options.uid);
  };
}
