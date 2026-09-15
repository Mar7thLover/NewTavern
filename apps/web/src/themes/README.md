# 主题作者手册（themes/）

本文是实现一个「世界」（主题）的唯一共同参考。世界设定看 `docs/DESIGN.md` 你自己那一节与 §四 全局禁忌；**怎么接进引擎**看这里。

> 铁律：**只改你自己的 `themes/<id>/` 目录**。凡是需要改共享文件（组件、`slots.css`、`materials.css`、`registry.ts`、`signature.tsx`、i18n）才能做到的事，停下来在汇报里写清楚，不要自己动。

---

## 1. 新增一个主题要做的全部事情

```
apps/web/src/themes/<id>/
  theme.ts            # 必须：默认导出 ThemeMeta（registry 用 import.meta.glob 自动发现）
  theme.css           # 必须：槽位赋值 + 材质/结构形态覆盖 + 纹理/动效（按需懒加载的独立 chunk）
  signature.tsx       # 可选：记忆物件（SendButton、MessageOrnament、Backdrop …）
  illustrations.tsx   # 可选：空状态插画等自绘 SVG（由 signature 的 EmptyIllustration 引用）
```

不需要改任何注册表：`registry.ts` 自动发现 `./*/theme.ts`，`apply.ts` 自动懒加载 `./*/theme.css`，外观页自动出现预览卡。

### 1.1 `theme.ts`

```ts
import * as signature from './signature';
import type { ThemeMeta } from '../registry';

const yuye: ThemeMeta = {
  id: 'yuye', // = 目录名 = <html data-theme>
  name: { zh: '雨夜', en: 'Yuye' },
  tagline: { zh: '深夜的窗前，雨在玻璃上流……', en: '…' },
  modes: ['dark'],
  defaultMode: 'dark', // 用户选了主题不支持的模式时回落到这里
  fonts: { story: '霞鹜文楷', ui: '思源黑体', display: '霞鹜文楷' }, // 只作说明
  preview: { canvas: '…', reading: '…', ink: '…', primary: '…' }, // CSS 颜色字面量
  signature: { SendButton: signature.SendButton, Backdrop: signature.Backdrop },
  options: [{ key: 'rain', label: { zh: '雨', en: 'Rain' }, default: 'on' }],
  loadFonts: () => import('lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css').then(() => undefined),
};

export default yuye;
```

`ThemeMeta` 完整定义见 `registry.ts`。

### 1.2 `theme.css` 的写法（重要：作用域）

外观页会**同时**渲染所有世界的预览卡：每张卡是一个带 `data-theme / data-mode / data-opt-*` 的局部根，嵌在 `<html data-theme="当前主题">` 里面。所以：

1. **槽位赋值**直接写在作用域根上，变量天然按「最近的根」继承，不会串：

   ```css
   [data-theme='yuye'][data-mode='dark'] {
     --canvas: oklch(0.19 0.045 258);
     /* … */
   }
   ```

   `slots.css` 的回退值挂在 `:root, :where([data-theme])` 上——每个作用域根都先复位成默认值，你没赋的槽位不会从外层主题继承过来。

2. **元素规则**（改形态、改结构）必须用 `@scope`，把下界设为任何嵌套的 `[data-theme]`：

   ```css
   @scope ([data-theme='yuye']) to ([data-theme]) {
     .action-primary {
       /* … */
     }
     [data-part='message'] {
       /* … */
     }
   }

   /* 模式 / 选项分支：条件写在 scope 根上 */
   @scope ([data-theme='yuye'][data-opt-rain='on']) to ([data-theme]) {
     [data-part='backdrop'] {
       /* … */
     }
   }
   ```

   不能写成 `[data-theme='yuye'] .action-primary`：当用户住在雨夜时，这条会命中**别的世界的预览卡**（它们是 `<html data-theme="yuye">` 的后代）。`@scope … to ([data-theme])` 保证规则只作用到「离它最近的那个作用域根是我」的元素。
   注意 `@scope` 里的选择器不带根的特异性；主题 CSS 不在任何 `@layer` 里，所以依然压得过 `materials.css`（`@layer components`）与 Tailwind 工具类（`@layer utilities`）。

   > 参考：`su/theme.css` 就是这样写的（槽位赋值在根上，元素规则全部在 `@scope ([data-theme='su']) to ([data-theme])` 里）。

3. 作用域根自己要画的东西（比如纹理），写在根上即可：`[data-theme='jiuguan'] { … }` 只会命中根元素本身（`<html>` 或预览卡根）。

### 1.3 装包

`霞鹜文楷 屏幕版 lxgw-wenkai-screen-webfont` 与 `@fontsource-variable/inter` 已在依赖里。其他 npm 字体包自行：

```
pnpm --filter @newtavern/web add <包名>
```

主会话已预装：`@fontsource/noto-serif-sc`、`@fontsource/noto-sans-sc`（按 `chinese-simplified-<字重>.css` 引入），霞鹜文楷用 `lxgw-wenkai-screen-webfont/lxgwwenkaigbscreen.css`（字族 `'LXGW WenKai Screen'`）。

**Tailwind 类**：`index.css` 已加 `@source './themes'`，主题目录里的工具类会生成；若开发服务器仍漏生成，改写进 `theme.css` 即可。

**并行开发时装包会改 `apps/web/package.json` 与根 `pnpm-lock.yaml`，务必在汇报里写明装了什么包、为什么。** 只装按 `unicode-range` 分片的 web 字体包，不要引入整包 TTF。

---

## 2. 字体懒加载

- 在 `ThemeMeta.loadFonts` 里动态 `import()` 字体包的 CSS，返回 `Promise<void>`。引擎保证每个主题只调用一次：切到该主题时、首屏渲染前（`main.tsx` 等它完成再渲染，避免闪字），以及外观页预热预览卡时。
- 字体只在 `theme.css` 里通过 `--font-ui / --font-story / --font-display / --font-mono` 赋值，**每个栈都要带系统回退**。
- 霞鹜文楷屏幕版：包的 `package.json` 写的 `style.css` 并不存在，要直接引 `lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css`（常规，97 个 `unicode-range` 分片；另有 `lxgwwenkaiscreenr.css` 等变体），family 名是 `'LXGW WenKai Screen'`。

```ts
loadFonts: () =>
  Promise.all([import('lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css')]).then(() => undefined),
```

---

## 3. 槽位全表

组件里只出现这些变量（或它们映射出的 Tailwind 工具类：`bg-canvas`、`text-ink-2`、`border-edge`、`rounded-card`、`shadow-panel`、`font-story` …）。默认值 = 「素」白模式（`slots.css`）。

### 3.1 契约槽位（DESIGN §2.2）

| 组   | 槽位                                                      | 默认                                  | 用途                                                         |
| ---- | --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------ |
| 表面 | `--canvas`                                                | `oklch(0.99 0 0)`                     | 最底层（`app-shell`、`body`）                                |
|      | `--reading`                                               | `oklch(0.99 0 0)`                     | 阅读面：`message-list`、`composer-dock`、`start-screen`      |
|      | `--panel`                                                 | `oklch(0.99 0 0)`                     | 侧栏、`chat-aside`                                           |
|      | `--control`                                               | `oklch(0.965 0 0)`（素：transparent） | 输入框、`.field` 底                                          |
|      | `--raised`                                                | `oklch(1 0 0)`                        | 弹层、抽屉、下拉                                             |
|      | `--overlay`                                               | `oklch(0.15 0 0 / 0.32)`              | 模态遮罩                                                     |
| 边   | `--edge`                                                  | `oklch(0.88 0 0)`                     | 分隔线、控件描边                                             |
|      | `--edge-strong`                                           | `oklch(0.74 0 0)`                     | 悬停描边、强分隔                                             |
|      | `--edge-focus`                                            | 国际橙（素：墨）                      | 焦点线（`.focus-ring`、`.field:focus`）                      |
|      | `--edge-highlight`                                        | `transparent`                         | 材质高光（玻璃上缘、黄铜亮边）                               |
| 文字 | `--ink`                                                   | `oklch(0.15 0 0)`                     | 正文墨                                                       |
|      | `--ink-2`                                                 | `oklch(0.5 0 0)`                      | 次要                                                         |
|      | `--ink-3`                                                 | `oklch(0.62 0 0)`                     | 元信息（时间戳、计数）                                       |
|      | `--ink-on-primary`                                        | `oklch(0.99 0 0)`                     | 主动作上的字/图形                                            |
|      | `--ink-link`                                              | 国际橙                                | 链接                                                         |
|      | `--ink-quote`                                             | `oklch(0.15 0 0)`                     | 对白（Markdown 自动把成对引号包成 `.text-ink-quote`）        |
|      | `--ink-action`                                            | `oklch(0.5 0 0)`                      | 动作/斜体（`*…*` → `em`）                                    |
| 强调 | `--accent`                                                | 国际橙                                | 当前项、主动作悬停                                           |
|      | `--accent-soft`                                           | `oklch(0.955 0 0)`（素：transparent） | 悬停软底（`.action-quiet/.action-ghost:hover`、`.chip`）     |
|      | `--primary` / `--primary-2`                               | `oklch(0.15 0 0)`                     | 主动作底 / 渐变末端                                          |
|      | `--primary-edge` / `--primary-glow`                       | `transparent`                         | 主动作边 / 光晕                                              |
| 语义 | `--danger` `--success` `--warning` `--info`               | 见 slots.css                          | 语义色                                                       |
| 形   | `--r-panel` `--r-card` `--r-control` `--r-pill`           | 6 / 6 / 4 / 999px                     | `rounded-panel/card/control/pill`                            |
| 影   | `--shadow-panel` `--shadow-raised` `--shadow-control`     | `none`                                | `shadow-*` 与材质类                                          |
| 字   | `--font-ui` `--font-story` `--font-display` `--font-mono` | Inter + 思源黑体栈                    | `font-*`                                                     |
|      | `--story-size` / `--story-leading` / `--story-measure`    | 16px / 1.8 / 36em                     | 故事字号 / 行高 / 最大行宽                                   |
| 动   | `--ease` `--dur-panel` `--dur-hover` `--dur-press`        | `cubic-bezier(0,0,.2,1)` / 120ms×3    | 过渡；framer-motion 通过 `slotSeconds()` 读                  |
|      | `--motion-pulse`                                          | `none`                                | 生成中心跳的 `@keyframes` 名（`.pulse-live`）                |
| 纹理 | `--texture-canvas` / `--texture-reading`                  | `none`                                | `background-image`（`.surface-canvas` / `.surface-reading`） |

### 3.2 引擎扩展槽位

| 槽位                                                            | 默认                      | 用途                                                                                                    |
| --------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `--primary-soft`                                                | `oklch(0.955 0 0)`        | 主动作软底                                                                                              |
| `--danger-soft` `--success-soft` `--warning-soft` `--info-soft` | 浅底                      | 告警条、错误卡的底（`bg-danger-soft`）                                                                  |
| `--ink-story`                                                   | `oklch(0.38 0 0)`         | 叙述正文色（`message-body` 的默认字色；对白用 `--ink-quote` 靠明度/色区分）                             |
| `--gap-message`                                                 | `2rem`                    | 消息之间的间距（`gap-message`）                                                                         |
| `--origin-l0` `--origin-step` `--origin-c` `--origin-h`         | 0.3 / 0.045 / 0 / 0       | 检查器段来源色条的 oklch 明度阶梯                                                                       |
| `--story-indent`                                                | `0`                       | 故事段首缩进（书斋 `2em`）                                                                              |
| `--story-paragraph-gap`                                         | `0.75em`                  | 故事段间距（书斋 `0`）                                                                                  |
| `--story-weight`                                                | `400`                     | 故事字重（琉璃 `300`）                                                                                  |
| `--story-tracking`                                              | `normal`（素：`-0.01em`） | 故事字距                                                                                                |
| `--icon-stroke`                                                 | `2`                       | 全部 lucide 图标线宽（`svg.lucide`；暖房 2 且圆头——lucide 本身就是圆头）                                |
| `--action-style`                                                | `normal`                  | 动作（Markdown `*…*` 的 em）的字形：中文没有真斜体，合成倾斜很廉价，默认正体；确有需要的主题设 `italic` |

排版槽位的生效位置：`[data-part='message-body']` 读 `--story-weight / --story-tracking`；其中 Markdown 容器 `.nt-md` 的 `p` 读 `--story-indent / --story-paragraph-gap`（首/末子元素的外边距归零）。

明暗：`<html data-mode>`；Tailwind 的 `dark:` 变体按「最近的 `data-mode`」判断，预览卡里也正确。

---

## 4. 材质类清单（`materials.css`，`@layer components`）

主题可以在 `@scope` 里整体换形态，组件不知道差别。

| 类                                                             | 默认形态                                                                         | 用在哪                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `.surface-canvas`                                              | `--canvas` 底 + `--texture-canvas` + 墨字                                        | `app-shell`、预览卡根                                 |
| `.surface-reading`                                             | `--reading` 底 + `--texture-reading`                                             | `message-list`、`composer-dock`、`start-screen`、预览 |
| `.surface-panel`                                               | `--panel` 底                                                                     | 左侧栏 `sidebar`                                      |
| `.surface-control`                                             | `--control` 底                                                                   | 备用                                                  |
| `.surface-raised`                                              | `--raised` 底 + `--shadow-raised`                                                | `modal`、`drawer`、下拉、回到底部按钮                 |
| `.surface-overlay`                                             | `--overlay` 底                                                                   | `modal-overlay`、`drawer-overlay`                     |
| `.edge-rule` / `.edge-rule-strong`                             | 只设 `border-color`（配合 `border-*` 使用）                                      | 全站分隔线                                            |
| `.focus-ring` / `.focus-ring-inset`                            | `:focus-visible` 2px `--edge-focus` 描边（外/内）                                | 所有可聚焦元素                                        |
| `.action-primary`                                              | `--primary` 实底、`--ink-on-primary`、悬停/按下变 `--accent`、disabled 40%       | 主按钮、素的发送键                                    |
| `.action-quiet`                                                | 透明底 + 1px `--edge`，悬停 `--accent-soft` + `--edge-strong`                    | 次要按钮（`variant="outline"`）                       |
| `.action-ghost`                                                | 无边，`--ink-2`，悬停 `--accent-soft` + 墨字                                     | 图标按钮默认、第三级按钮                              |
| `.action-danger`                                               | 无边 `--ink-2`，悬停 `--danger-soft` + `--danger` 字                             | 删除图标                                              |
| `.action-danger-solid`                                         | `--danger` 实底                                                                  | 确认删除                                              |
| `.chip` / `.chip-outline` / `.chip-accent`                     | 胶囊：软底 / 线框 / 强调色线框                                                   | `Badge`                                               |
| `.field`                                                       | `--control` 底 + 1px `--edge`，聚焦 `--edge-focus`，`aria-invalid` 用 `--danger` | 输入框、选择框、`composer` 外框                       |
| `.avatar-frame`（`[data-role='user'\|'character'\|'system']`） | `--control` 底，角色 `--r-control`、用户 `--r-pill`，有 `img` 时去底             | 素的 `AvatarFrame` 输出的外框                         |
| `.switch-track` / `.switch-thumb`                              | 1px 线轨道 + 实心小滑块                                                          | `Switch`                                              |
| `.origin-bar` + `.origin-<kind>`                               | `oklch(l0 + step·i, c, h)` 的 2px 色条                                           | 检查器 `segment` 左侧                                 |
| `.motion-transform`                                            | `transform` 过渡（开合箭头、开关滑块）                                           | 素把它关掉                                            |
| `.pulse-live`                                                  | `animation-name: var(--motion-pulse)` 1.6s 循环；`prefers-reduced-motion` 下关闭 | 「生成中」提示                                        |

另有两条结构默认：`[data-part='message-body']`（字重/字距）、`.nt-md p`（缩进/段距），以及 `svg.lucide { stroke-width: var(--icon-stroke) }`。

---

## 5. `data-part` 清单

主题用 `[data-part='…']`（放在 `@scope` 里）改形态而不碰组件。布尔 data 属性的值是字符串 `"true" / "false"`。

### 5.1 外壳

| data-part       | DOM 位置                                                                                                                                                        | 附加属性                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| `app-shell`     | 应用最外层 `div`（`surface-canvas relative isolate flex`）                                                                                                      | —                                           |
| `backdrop`      | `app-shell` 第一个子元素；预览卡 `theme-preview` 第一个子元素。`fixed`(app)/`absolute`(preview) `inset-0 -z-10 overflow-hidden pointer-events-none aria-hidden` | `data-scope="app\|preview"`                 |
| `sidebar`       | 桌面左侧栏 `aside`（≥md）                                                                                                                                       | —                                           |
| `brand`         | `sidebar` 顶部的应用名块                                                                                                                                        | —                                           |
| `nav`           | 主导航 `nav`：侧栏里一份、窄屏顶栏里一份                                                                                                                        | `data-variant="sidebar\|compact"`           |
| `nav-item`      | `nav` 的每个链接 `a`                                                                                                                                            | `data-active`（另有 `aria-current="page"`） |
| `app-header`    | 右侧内容区顶栏 `header`                                                                                                                                         | —                                           |
| `server-status` | 顶栏右侧「在线」状态                                                                                                                                            | `data-online`                               |
| `main`          | 路由内容容器 `main`                                                                                                                                             | —                                           |

### 5.2 对话页（`/`）

| data-part                | DOM 位置                                                                                                   | 附加属性                                                                                |
| ------------------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `chat-page`              | 对话页三栏容器                                                                                             | —                                                                                       |
| `chat-aside`             | 左栏（会话列表，≥lg）/ 右栏（会话 · 检查器，≥xl）`aside`，带 `bg-panel` 与边线                             | `data-side="start\|end"`                                                                |
| `chat-aside-body`        | 右栏内容（页签 + 会话面板/检查器）；窄屏时在抽屉里                                                         | —                                                                                       |
| `chat-list`              | `ChatListPane` 根（在 `chat-aside[start]` 或左抽屉里）                                                     | —                                                                                       |
| `chat-list-header`       | 会话列表标题栏                                                                                             | —                                                                                       |
| `chat-list-item`         | 会话列表每一项 `li`（内含按钮与删除键）                                                                    | `data-active`                                                                           |
| `chat-list-marker`       | `chat-list-item` 内当前项左侧的强调短线 `span`（仅 `active` 时渲染）                                       | —                                                                                       |
| `start-screen`           | 未选会话时的开始页（滚动容器，`surface-reading`）                                                          | —                                                                                       |
| `start-persona`          | 开始页「以谁的身份开始」下拉的外层 `div`（有用户档案时才渲染）                                             | —                                                                                       |
| `character-card`         | 开始页每张角色卡 `button`（3:4）                                                                           | —                                                                                       |
| `character-card-initial` | `character-card` 内的首字 `span`（无头像图时渲染）                                                         | —                                                                                       |
| `character-card-name`    | `character-card` 内的名字 `span`                                                                           | —                                                                                       |
| `chat-view`              | 当前会话列（顶栏 + 消息 + 输入）；预览卡里也有                                                             | —                                                                                       |
| `chat-header`            | 会话顶栏 `header`                                                                                          | —                                                                                       |
| `chat-title`             | `chat-header` 内的会话标题文字 `div`                                                                       | —                                                                                       |
| `message-list`           | 消息滚动容器（`surface-reading`）；预览卡里也有                                                            | —                                                                                       |
| `message`                | 每条消息 `article`，**`position: relative`**                                                               | `data-role="user\|assistant\|system"`、`data-index`（路径下标，从 0）、`data-streaming` |
| `message-ornament`       | `message` 的第一个子元素，`absolute inset-0 pointer-events-none aria-hidden`，内含主题的 `MessageOrnament` | —                                                                                       |
| `message-row`            | `message` 内的行容器：头像 + `message-main`                                                                | —                                                                                       |
| `message-main`           | 包住 `message-header` 与 `message-body` 的那一列                                                           | —                                                                                       |
| `message-header`         | 名字 + 时间戳行                                                                                            | —                                                                                       |
| `reasoning`              | 推理折叠区（在 `message-header` 与 `message-body` 之间）                                                   | `data-open`                                                                             |
| `message-body`           | 故事正文容器（`font-story text-story leading-story text-ink-story`），内含 `.nt-md`（Markdown）或编辑框    | —                                                                                       |
| `message-actions`        | 消息下方操作条（默认透明，悬停/长按显示），内含 `swipe`                                                    | `data-visible`（与 `actionsVisible` 同步，透明度动画另见 className）                    |
| `swipe`                  | 助手消息的 swipe 条（主题的 `SwipeIndicator` + 重生成 + 分叉提示）                                         | —                                                                                       |
| `generation-error`       | 消息流末尾的生成失败卡                                                                                     | —                                                                                       |
| `empty-state`            | 空会话引导（以及库页面的空列表）                                                                           | —                                                                                       |
| `composer-dock`          | 底部输入区外层（`surface-reading`）；预览卡里也有                                                          | —                                                                                       |
| `composer`               | 输入框外框（`.field`，内含 textarea 与发送键）；预览卡里也有                                               | —                                                                                       |
| `composer-input`         | textarea（预览卡里是占位 `span`）                                                                          | —                                                                                       |
| `composer-hint`          | 输入框下方快捷键提示                                                                                       | —                                                                                       |
| `tabs` / `tab`           | 分段控件 / 页签（右栏「会话 · 检查器」、布局模式、检查器页签等）                                           | `tab`：`data-active`                                                                    |
| `session-panel`          | 会话设置面板根                                                                                             | —                                                                                       |
| `thinking-select`        | 会话面板「推理强度」下拉的外层 `div`（在「模型」下方；当前模型不支持推理时不渲染）                         | `data-value`（`follow` / `off` / `effort:<档位>` / `budget:<档位>`）                    |
| `panel-section`          | 会话面板里的折叠小节（作者注释 / 世界书 / 系统提示词）                                                     | `data-open`                                                                             |
| `usage-card`             | 用量卡                                                                                                     | —                                                                                       |
| `usage-bar`              | `usage-card` 内缓存命中比例条的底线（1px 发丝）`div`                                                       | —                                                                                       |
| `usage-bar-fill`         | `usage-bar` 内命中部分的填充段 `div`                                                                       | —                                                                                       |
| `inspector`              | 提示词检查器根                                                                                             | —                                                                                       |
| `segment`                | 检查器里每个段 `article`                                                                                   | `data-origin="preset\|character\|…"`                                                    |
| `segment-bar`            | `segment` 左侧来源色条 `span`                                                                              | —                                                                                       |
| `segment-header`         | `segment` 头部行（来源/角色/稳定性等徽标 + token 数）                                                      | —                                                                                       |
| `segment-body`           | `segment` 正文（可展开/折叠的文本按钮）                                                                    | —                                                                                       |
| `compare-view`           | 检查器「ST 对照」页签根（开发者模式打开时才会出现）                                                        | —                                                                                       |
| `compare-diff`           | 「ST 对照」结果里每一处差异（按消息下标对齐）                                                              | `data-kind="role\|content\|both\|onlyOurs\|onlyTheirs"`                                 |

### 5.3 其他页面与浮层

| data-part                   | DOM 位置                                                                                                              | 附加属性                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `page-header`               | 库页面/连接页的标题块（`LibraryHeader`）；开始页标题块                                                                | —                                                                                         |
| `library-item`              | 角色卡按钮 / 预设行 / 世界书行 / 用户档案卡                                                                           | `data-kind="character\|preset\|lorebook\|persona"`；预设行与用户档案卡另有 `data-default` |
| `preset-default-badge`      | 预设行名称旁的「默认」徽标 `span`（`Badge`，仅默认预设渲染）                                                          | —                                                                                         |
| `persona-form`              | 用户档案新建/编辑表单 `form`（`modal-body` 内，左头像右字段，窄屏单列）                                               | —                                                                                         |
| `persona-avatar-field`      | `persona-form` 左栏：`AvatarFrame` 预览 + 上传/移除按钮；选图后叠一层裁切弹窗（`image-cropper`）                      | —                                                                                         |
| `image-cropper`             | 图片裁切组件根（`ImageCropper`，在 `modal-body` 内）：视窗 + 提示 + 缩放条 + 按钮行                                   | —                                                                                         |
| `image-cropper-viewport`    | 正方形裁切视窗（可聚焦，`surface-control edge-rule border`），内含 `canvas` 与圆形参考线 `svg`（圆外 `fill-overlay`） | `data-status="loading\|ready\|error"`                                                     |
| `image-cropper-zoom`        | 缩放条：缩小键 + `input[type=range]`（`accent-primary`）+ 放大键                                                      | —                                                                                         |
| `persona-depth-fields`      | `persona-form` 里「按深度注入」时出现的深度 + 消息角色两栏                                                            | —                                                                                         |
| `preset-editor`             | 预设编辑器页根（`/presets/:id`）                                                                                      | —                                                                                         |
| `preset-section`            | 编辑器分区 `section`（基本 / 采样参数 / 提示词条目）                                                                  | `data-section="basic\|sampling\|prompts"`                                                 |
| `preset-prompt-list`        | 提示词条目列表 `ol`（按组装使用的 `prompt_order` 排序）                                                               | —                                                                                         |
| `preset-prompt-item`        | 每个条目 `li`（开关、上移/下移、名称；普通条目可展开编辑）                                                            | `data-marker`、`data-enabled`、`data-open`                                                |
| `preset-save-bar`           | 编辑器底部吸附的保存条（`surface-raised`，保存 / 放弃修改）                                                           | `data-dirty`                                                                              |
| `connection-card`           | 连接页每个连接 `li`                                                                                                   | —                                                                                         |
| `settings-nav`              | 设置页分区导航 `nav`                                                                                                  | —                                                                                         |
| `settings-nav-item`         | 分区按钮                                                                                                              | `data-active`（另有 `aria-current`）                                                      |
| `settings-section`          | 设置分区 `section`（标题 + 说明 + 内容）                                                                              | —                                                                                         |
| `theme-card`                | 外观页每张主题卡（外层 `div`，最上层盖一个透明点击 `button`）                                                         | `data-active`                                                                             |
| `theme-preview`             | 预览卡的作用域根：`data-theme / data-mode / data-opt-*`，`surface-canvas relative isolate overflow-hidden`            | 同 `<html>`                                                                               |
| `modal-overlay` / `modal`   | 模态遮罩 / 面板（Portal 到 `body`，仍在 `<html data-theme>` 作用域内）                                                | —                                                                                         |
| `modal-header`              | `modal` 头部行（仅传了 `title` 时渲染，含关闭键）                                                                     | —                                                                                         |
| `modal-title`               | `modal-header` 内的标题 `h2`                                                                                          | —                                                                                         |
| `modal-body`                | `modal` 正文（`children`）                                                                                            | —                                                                                         |
| `modal-footer`              | `modal` 底部按钮区（仅传了 `footer` 时渲染）                                                                          | —                                                                                         |
| `drawer-overlay` / `drawer` | 抽屉遮罩 / 面板                                                                                                       | `drawer`：`data-side="left\|right"`                                                       |
| `drawer-header`             | `drawer` 头部行（仅传了 `title` 时渲染，含关闭键）                                                                    | —                                                                                         |
| `drawer-title`              | `drawer-header` 内的标题 `div`                                                                                        | —                                                                                         |
| `drawer-body`               | `drawer` 正文（`children`）                                                                                           | —                                                                                         |

### 5.4 预览卡的结构（外观页）

```
[data-part=theme-card][data-active]
  [data-part=theme-preview][data-theme][data-mode][data-opt-*]   ← 作用域根
    [data-part=backdrop][data-scope=preview]
    [data-part=chat-view]
      [data-part=message-list]
        [data-part=message][data-role=assistant][data-index=0]
          [data-part=message-ornament]
          头像(AvatarFrame role=character) + [data-part=message-header] + [data-part=message-body] > .nt-md > p
          [data-part=message-actions] > [data-part=swipe] > SwipeIndicator
        MessageDivider(role=user, index=1)
        [data-part=message][data-role=user][data-index=1] …
      [data-part=composer-dock] > [data-part=composer] > [data-part=composer-input] + SendButton
  （卡片底部的名字与一句话不在作用域内，用当前主题的样子）
```

预览卡不接指针事件，里面的按钮只是画面。

---

## 6. 记忆物件（signature 契约）

`themes/signature.tsx` 的完整定义（摘录）：

```ts
export type MessageRole = 'user' | 'assistant' | 'system';
export type SendButtonState = 'idle' | 'ready' | 'generating';

export interface SendButtonProps {
  state: SendButtonState;
  disabled: boolean;
  label: string; // 无障碍名称（已本地化），同时作为原生 tooltip
  onClick: () => void;
}

export interface SwipeIndicatorProps {
  index: number; // 从 0 起
  total: number;
  busy: boolean;
  labels: { prev: string; next: string; new: string };
  onPrev: () => void;
  onNext: () => void; // 已在最后一项时调用方接成「再生成一条」
}

export type AvatarRole = 'user' | 'character' | 'system';
export interface AvatarFrameProps {
  role: AvatarRole;
  className?: string; // 只传尺寸（size-9 …）
  children: ReactNode; // <img class="size-full object-cover"> 或首字 <span>
}

export interface MessageDividerProps {
  role: MessageRole; // 分隔线下方那条消息的角色
  index: number; // 下方那条消息的路径下标（>0）
}

export type EmptyIllustrationKind =
  'chat' | 'chats' | 'characters' | 'presets' | 'lorebooks' | 'personas' | 'connections' | 'regex';
export interface EmptyIllustrationProps {
  kind: EmptyIllustrationKind;
  className?: string;
}

export interface StreamingCursorProps {
  kind: 'text' | 'reasoning';
}

export interface MessageOrnamentProps {
  role: MessageRole;
  id: string; // 消息节点 id
  index: number; // 路径下标
}

export type BackdropScope = 'app' | 'preview';
export interface BackdropProps {
  scope: BackdropScope;
}

export interface ThemeSignature {
  SendButton: ComponentType<SendButtonProps>;
  SwipeIndicator: ComponentType<SwipeIndicatorProps>;
  AvatarFrame: ComponentType<AvatarFrameProps>;
  MessageDivider: ComponentType<MessageDividerProps>;
  EmptyIllustration: ComponentType<EmptyIllustrationProps>;
  StreamingCursor: ComponentType<StreamingCursorProps>;
  MessageOrnament: ComponentType<MessageOrnamentProps>;
  Backdrop: ComponentType<BackdropProps>;
}

// 给主题用的工具
export function stableHash(value: string): number; // FNV-1a，同一 id 永远同一个数
export function stablePick<T>(id: string, items: readonly T[]): T; // 「随机但对该消息固定」
```

`ThemeMeta.signature` 是 `Partial<ThemeSignature>`，没提供的回落到 `_default`：前六件 = 「素」的实现，`MessageOrnament` / `Backdrop` = 什么也不画。

各件的挂载位置与约定：

| 物件                | 渲染位置                                                                                                    | 约定                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SendButton`        | `[data-part=composer]` 内、textarea 右侧；预览卡里 `state="ready"`                                          | 自己渲染 `<button>`，带 `aria-label={label}`、`title`、`disabled`；`generating` 时是停止键（不 disabled）                                                                                  |
| `SwipeIndicator`    | `[data-part=swipe]` 内；预览卡 `index=1 total=3`                                                            | 按钮都要有 `aria-label`；`busy` 时不可点                                                                                                                                                   |
| `AvatarFrame`       | 消息头像、会话列表、会话面板、角色详情、用户档案                                                            | 根元素要带 `className`（尺寸）；建议输出 `.avatar-frame` + `data-role` 以便复用材质                                                                                                        |
| `MessageDivider`    | `message-list` 里两条消息之间（`index>0`）；预览卡两条消息之间                                              | 是 `message-list` 的直接 flex 子项，会被 `gap-message` 前后隔开                                                                                                                            |
| `EmptyIllustration` | `[data-part=empty-state]` 顶部                                                                              | 自绘 SVG，`currentColor` / 槽位色；不要库存图标放大                                                                                                                                        |
| `StreamingCursor`   | 正文末尾（`.nt-caret` 里，inline）/ 推理区标题旁                                                            | inline 元素；动画遵守 reduced-motion                                                                                                                                                       |
| `MessageOrnament`   | `[data-part=message-ornament]` 内（引擎已给 `absolute inset-0`、`pointer-events:none`、`aria-hidden`）      | 你只画装饰，自己再 `absolute` 定位到角上；可以略伸出消息边界，但 `message-list` 横向 `overflow: hidden`、两侧只有 16px（≥sm 24px）内边距，预览卡根也裁剪，别伸出这个范围；不要放可交互元素 |
| `Backdrop`          | `[data-part=backdrop]` 内（引擎已给定位、`-z-10`、`overflow-hidden`、`pointer-events:none`、`aria-hidden`） | 用 `scope` 区分：`preview` 时画得更轻/更小（卡片约 360×300）；只要纯 CSS 就能做到的效果（雨、颗粒）也可以不写组件，直接在 `theme.css` 里给 `[data-part='backdrop']` 画 `background-image`  |

**Backdrop 能被看见的前提**：它垫在 `app-shell` 底色之上、所有内容之下，而 `surface-panel / surface-reading / bg-panel` 默认是实心的。要让雨透出来，就把 `--reading` / `--panel` 设成半透明，或者在 `@scope` 里给对应 `data-part` 去底/加 `backdrop-filter`。

---

## 7. 主题选项

```ts
export type ThemeOptionValue = 'on' | 'off';
export interface ThemeOption {
  key: string; // 小写字母、数字、连字符：会变成 data-opt-<key>
  label: ThemeText;
  default: ThemeOptionValue;
}
// ThemeMeta.options?: ThemeOption[]
```

- 存储：`useUiStore.themeOptions: Record<themeId, Record<key, 'on'|'off'>>`，`setThemeOption(themeId, key, value)`（zustand persist `newtavern-ui`，version 3）。每个世界各存各的。
- 生效：`applyTheme` 把**当前主题**的全部选项（存过的用存的，没存的用 `default`）写成 `<html data-opt-<key>="on|off">`，切换主题时先清掉旧主题的 `data-opt-*`；`index.html` 首屏脚本同步写存过的值。预览卡根上也写同样的 `data-opt-*`。
- 外观页在「白天与夜晚」下方渲染这个主题的选项开关（`Switch`），标题「这个世界的细节」。只对当前主题显示。
- CSS：`@scope ([data-theme='yuye'][data-opt-rain='on']) to ([data-theme]) { [data-part='backdrop'] { … } }`。
- 在 TS 里读：`resolveThemeOptions(theme, useUiStore.getState().themeOptions[theme.id])`（`registry.ts`）。

---

## 8. 动效

- 过渡时长、曲线只用 `--ease / --dur-panel / --dur-hover / --dur-press`。
- framer-motion 的时长由组件用 `slotSeconds('--dur-panel')`（`apply.ts`）读，**组件只做透明度**；位移、翻页、`rotateY` 这类形变由主题在 CSS 里给 `[data-part=…]` 加 `@keyframes` 实现。
- 生成中心跳：在 `theme.css` 定义 `@keyframes yuye-breathe { … }`，然后 `--motion-pulse: yuye-breathe;`。发送键的生成中状态由 `SendButton` 的 `state` 自己决定。
- `.motion-transform` 是开合箭头与开关滑块的 transform 过渡，只做透明度的世界可以在 scope 里 `transition-property: none`。

### `prefers-reduced-motion`

**所有**持续动画（雨、光的流动、呼吸、光标闪烁）与大于 8px 的位移，都必须包在：

```css
@media (prefers-reduced-motion: no-preference) {
  @scope ([data-theme='yuye'][data-opt-rain='on']) to ([data-theme]) { … animation … }
}
```

或者在 `reduce` 分支里显式 `animation: none`。`.pulse-live` 引擎已处理。静止画面（雨的斜线本身、颗粒）在 reduce 下保留，只停止运动。

---

## 9. 截图自检

工具：`node C:/Users/Administrator/AppData/Local/Temp/claude/D--Projects-NewTavern/9b29bc97-d4e8-425f-bbf5-c0d2fb334440/scratchpad/shoot.mjs`（先读它头部注释）。

- **每个代理用自己分配的 `--port`**（它会起独立 profile 的无头 Chrome）；结束时按 PID 关掉自己的 Chrome。
- 共享开发服务：前端 `http://localhost:5173`、服务端 `http://localhost:8787`，**不要启停这两个端口的进程**。
- 测试数据：`…/9b29bc97-…/scratchpad/fixtures.json`（「排版样张」会话：data-index 0 开场白、1 用户、2 约 400 字故事、3 用户、4 带 3 个 swipe 的助手、5 用户、6 带推理区的助手；含页面 URL 与常用选择器）。不要修改这个会话里的节点；要拍「生成中」时自建一个会话（把 `overrides.connectionId` 设为 fixtures 里的 mock 连接），并先起 mock（命令见 fixtures）。
- 页面：对话 `/?c=<chatId>`；开始页 `/`；外观 `/settings?section=appearance`；正则 `/settings?section=regex`；连接 `/connections`。
- 常用参数：

  ```bash
  node shoot.mjs --port <你的端口> --url "http://localhost:5173/?c=<chatId>" \
    --theme <id> --mode dark --w 1440 --out shots/<id>/chat-1440-dark.png
  # 手机宽度：--w 390（每张都检查打印出来的 scrollWidth 必须 = 390）
  # 外观/连接等长页面：--full
  # 记忆物件特写：--clip "[data-part='composer']" --pad 20
  # 主题选项（按主题分层）：--opts '{"yuye":{"rain":"off"}}'
  # 页面加载后执行脚本（点页签、输入文字、强制显示操作条）：--after x.js
  ```

- §2.5 验收全套：1440 与 390 × 每种模式 × 对话 / 开始 / 外观 / 连接；400 字故事可读性特写（`[data-part='message'][data-index='2']`）；三件记忆物件特写。
- 截图后用 Read 工具看图，逐条对照 DESIGN 你那一节与 §四；另外至少看一眼别的世界的预览卡没有被你的 CSS 染色（外观页，在你的主题下拍）。
