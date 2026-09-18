import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * 按依赖拆 vendor chunk（M4 §4）。只认下面列出的包，别的依赖照常跟着引用它的 chunk 走：
 * - 字体包（`@fontsource/*`、霞鹜文楷）不在列表里，仍由各主题的 `loadFonts` 按需加载；
 * - markdown 系只被对话页用到，拆出来后随对话页 chunk 一起按需加载；
 * - react 系几乎不随应用发版变化，单独成块利于缓存。
 */
const VENDOR_CHUNKS: { name: string; test: (pkg: string) => boolean }[] = [
  {
    name: 'react',
    test: (pkg) =>
      ['react', 'react-dom', 'scheduler', 'react-router', 'cookie', 'set-cookie-parser'].includes(
        pkg,
      ),
  },
  {
    name: 'motion',
    test: (pkg) => ['framer-motion', 'motion-dom', 'motion-utils'].includes(pkg),
  },
  {
    name: 'markdown',
    test: (pkg) =>
      /^(react-markdown|unified|remark-.+|rehype-.+|micromark.*|mdast-.+|hast-.+|unist-.+|vfile.*|estree-util-.+|character-.+|is-(alphabetical|alphanumerical|decimal|hexadecimal))$/.test(
        pkg,
      ) ||
      [
        'bail',
        'ccount',
        'comma-separated-tokens',
        'space-separated-tokens',
        'decode-named-character-reference',
        'devlop',
        'html-url-attributes',
        'inline-style-parser',
        'longest-streak',
        'markdown-table',
        'parse-entities',
        // rehype-raw 走 parse5 真解析一遍原生 HTML（正文块与卡自带前端）
        'parse5',
        'entities',
        'web-namespaces',
        'html-void-elements',
        'property-information',
        'stringify-entities',
        'style-to-js',
        'style-to-object',
        'trim-lines',
        'trough',
        'zwitch',
        '@ungap/structured-clone',
      ].includes(pkg),
  },
];

/** 模块路径 → 包名（取最后一个 node_modules 之后的段，兼容 pnpm 的 .pnpm 目录） */
function packageOf(id: string): string | null {
  const match = /.*[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/.exec(id);
  return match?.[1]?.replace('\\', '/') ?? null;
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true, // 局域网可访问
    port: 5173,
    proxy: {
      '/api': {
        // NT_API_TARGET：另起一套隔离服务端时覆盖（缺省是本机 8787）
        target: process.env.NT_API_TARGET ?? 'http://localhost:8787',
        changeOrigin: true,
        // 写 X-Forwarded-For：局域网客户端经开发代理访问时，服务端仍能认出真实来源（迁移接口只允许本机，M4 §2.3）
        xfwd: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          // 只拆 JS；CSS（字体 @font-face、主题）交给 Vite 按引用关系处理
          if (!/\.[cm]?[jt]sx?$/.test(id.split('?')[0] ?? id)) return undefined;
          const pkg = packageOf(id);
          if (!pkg) return undefined;
          return VENDOR_CHUNKS.find((chunk) => chunk.test(pkg))?.name;
        },
      },
    },
  },
});
