import type { SrcdocLibs } from '@newtavern/sandbox-sdk';

/**
 * 前端卡 iframe 里注入哪些库。见 docs/M5-CONTRACT.md §4.2。
 *
 * 全部来自宿主自己的源（`public/sandbox/lib/`，由 `scripts/build-sandbox-libs.mjs`
 * 打成 IIFE 的经典脚本）：opaque origin 下经典脚本跨源加载不需要 CORS，ES 模块需要。
 *
 * **按需加载**：`$` 与 `_` 是社区卡的地基（酒馆助手一直注入它们，卡里直接就用），
 * 其余三个只在卡真的提到时才给 —— zod 压完还有 440 KB，不能每张卡都拖。
 */

const LIB_BASE = '/sandbox/lib';

interface OptionalLib {
  file: string;
  /** 卡的 HTML 里出现这个就加载 */
  hint: RegExp;
}

/** nt-regex：core 的正则引擎（`formatAsTavernRegexedString` 同步要用），几 KB，每帧都给 */
const BASE_LIBS = [`${LIB_BASE}/jquery.js`, `${LIB_BASE}/lodash.js`, `${LIB_BASE}/nt-regex.js`];

const OPTIONAL_LIBS: OptionalLib[] = [
  { file: 'vue.js', hint: /\bVue\b/ },
  // `z.object(...)`、`z.string()`：MVU 的 zod schema 脚本
  { file: 'zod.js', hint: /\bz\s*\.\s*[a-z]/ },
  { file: 'yaml.js', hint: /\bYAML\b/ },
];

/**
 * 社区卡默认假定存在的外链资源（酒馆助手会注入同样几个）。
 * 只有 `standard` 以上的信任级别才给，并且设置里可以整体关掉（离线 / 隐私）。
 */
export const EXTERNAL_STYLES = [
  'https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free/css/all.min.css',
];

export const EXTERNAL_SCRIPTS = ['https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4'];

/** 从 CDN 拉代码的卡 / 脚本：真正要用什么库只有运行时才知道，只能全给 */
const REMOTE_IMPORT = /\bimport\s*[(\s'"]|\bfrom\s*['"]https?:/;

export interface SelectLibsOptions {
  /**
   * 不做按需判断，全给。脚本帧一律用这个：脚本正文常常只有一行
   * `import 'https://cdn.../bundle.js'`，从字面上看不出它要 Vue 还是 zod
   * （真实例子：MVU 的 bundle 需要 Vue，它的 zod schema 脚本需要 z）。
   */
  all?: boolean;
}

export function selectSandboxLibs(html: string, options: SelectLibsOptions = {}): SrcdocLibs {
  const scripts = [...BASE_LIBS];
  const all = options.all === true || REMOTE_IMPORT.test(html);
  for (const lib of OPTIONAL_LIBS) {
    if (all || lib.hint.test(html)) scripts.push(`${LIB_BASE}/${lib.file}`);
  }
  return { scripts };
}
