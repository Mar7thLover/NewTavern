/**
 * 打包前端卡沙箱要用的第三方库到 `public/sandbox/lib/`。
 *
 * 为什么不直接让 iframe 从 CDN 取（酒馆助手就是那么做的）：
 *
 * - 沙箱 iframe 是 opaque origin，**ES 模块**跨源加载要求 CORS；经典脚本不要求。
 *   把库打成 IIFE 的经典脚本挂在宿主自己的源下，是唯一不依赖外站 CORS 头的办法。
 * - 断网 / 内网部署也要能用；库的版本由我们锁，不会某天被 CDN 换掉。
 *
 * 产物是构建产物，不进仓库（`public/sandbox/lib` 在 .gitignore 里）。
 * `pnpm dev` / `pnpm build` 会先跑本脚本；版本变了才重新打包（stamp 文件比对）。
 *
 * 库的选择照着酒馆助手 4.9.3 注入 iframe 的那一套：jQuery（卡几乎都用 `$()`）、
 * lodash（`_.get/_.set`，MVU 卡的标配）、Vue（`Vue.createApp`，新卡大量用）、
 * zod（`z.object`，MVU schema）、yaml（`YAML.parse`）。toastr 不打包——
 * 它只是提示框，引导脚本里用 RPC 转成宿主的提示，视觉上和应用统一。
 */

// 仓库根的 eslint.config.mjs 没给纯 JS 文件配 Node globals（与 tools/golden/record 同办法）
/* global console, process */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..');
const outDir = path.join(webRoot, 'public', 'sandbox', 'lib');
const stampFile = path.join(outDir, '.stamp.json');

/** 每个库：入口代码（挂到 window）+ 产物文件名 */
const LIBS = [
  {
    file: 'jquery.js',
    packages: ['jquery'],
    contents: `import $ from 'jquery';
window.$ = window.jQuery = $;`,
  },
  {
    file: 'lodash.js',
    packages: ['lodash'],
    contents: `import _ from 'lodash';
window._ = _;`,
  },
  {
    file: 'vue.js',
    packages: ['vue'],
    // esm-bundler 版带模板编译器：卡里写 in-DOM 模板（`<div v-if>`）也能跑
    contents: `import * as Vue from 'vue/dist/vue.esm-bundler.js';
window.Vue = Vue;`,
  },
  {
    file: 'zod.js',
    packages: ['zod'],
    // 全局 `z` 必须是 **zod 包的整个命名空间**，和酒馆助手一致：
    // 社区脚本里既有 `z.object(...)`（扁平导出），也有 `z.z.ZodObject`（嵌套的 classic 命名空间）。
    contents: `import * as zod from 'zod';
window.z = zod;
window.zod = zod;`,
  },
  {
    file: 'yaml.js',
    packages: ['yaml'],
    // 社区卡里 `YAML.parse` / `YAML.stringify` 与 js-yaml 风格的 `load` / `dump` 都有人用
    contents: `import * as YAML from 'yaml';
window.YAML = { ...YAML, load: YAML.parse, dump: YAML.stringify };`,
  },
];

function versionOf(name) {
  try {
    const url = import.meta.resolve(`${name}/package.json`);
    return JSON.parse(fs.readFileSync(fileURLToPath(url), 'utf8')).version;
  } catch {
    return 'unknown';
  }
}

function currentStamp() {
  const versions = Object.fromEntries(
    LIBS.flatMap((lib) => lib.packages.map((name) => [name, versionOf(name)])),
  );
  const shape = createHash('sha256')
    .update(JSON.stringify(LIBS.map((lib) => [lib.file, lib.contents])))
    .digest('hex')
    .slice(0, 12);
  return { versions, shape };
}

function upToDate(stamp) {
  if (process.env.NT_FORCE_SANDBOX_LIBS === '1') return false;
  if (!fs.existsSync(stampFile)) return false;
  if (!LIBS.every((lib) => fs.existsSync(path.join(outDir, lib.file)))) return false;
  try {
    return JSON.stringify(JSON.parse(fs.readFileSync(stampFile, 'utf8'))) === JSON.stringify(stamp);
  } catch {
    return false;
  }
}

const stamp = currentStamp();
if (upToDate(stamp)) {
  console.log('[sandbox-libs] 已是最新，跳过');
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });

for (const lib of LIBS) {
  await build({
    stdin: { contents: lib.contents, resolveDir: webRoot, sourcefile: lib.file, loader: 'js' },
    outfile: path.join(outDir, lib.file),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    minify: true,
    legalComments: 'none',
    define: {
      'process.env.NODE_ENV': '"production"',
      __VUE_OPTIONS_API__: 'true',
      __VUE_PROD_DEVTOOLS__: 'false',
      __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
    },
  });
  const size = fs.statSync(path.join(outDir, lib.file)).size;
  console.log(`[sandbox-libs] ${lib.file} ${(size / 1024).toFixed(0)} KB`);
}

fs.writeFileSync(stampFile, JSON.stringify(stamp, null, 2), 'utf8');
console.log('[sandbox-libs] 完成');
