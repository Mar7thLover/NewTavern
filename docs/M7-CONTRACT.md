# M7 契约：长篇写作共创

| 项目 | 内容 |
| ---- | ---- |
| 版本 | v1（2026-09-22） |
| 范围 | 写作项目 / 章节 / 笔记、设定圣经（复用世界书）、风格指南、大纲、TipTap 编辑器、AI 动作（续写 / 重写 / 扩写 / 压缩 / 摘要 / 自定义）、章节摘要链、版本历史与对照、导出 |
| 不含 | 多人协作、评论批注、DOCX / EPUB 导出、分支式写作（写作不用消息树）、CRPG（M8） |

先读：`docs/PLAN.md` §3.2（稳定性分层与布局器）/ §3.8、`docs/M3-CONTRACT.md`（组装与布局）、`docs/M6-CONTRACT.md` §1（工具调用、`callLlm` / `streamLlm`，写作的 AI 动作都走它们）、`apps/web/src/themes/README.md`、`docs/DESIGN.md`。
本文与代码冲突时以本文为准；实现中发现本文写错，在 §7 追加「修正」注明日期与代号。

表结构已在迁移 `0003` 加好：`writing_projects`、`documents`、`document_versions`（见 `apps/server/src/db/schema.ts`）。**不再新增迁移。**

**代号与目录归属**：

| 代号 | 内容 | 独占 | 共享（最小改动，改前重读） |
| ---- | ---- | ---- | ---- |
| WS | §2 §3 §4 | `packages/core/src/writing/**`（新）、`apps/server/src/routes/writing.ts`、`services/writing*.ts`、`packages/i18n/prompts/writing.{zh-CN,en}.md` | `app.ts`、`packages/core/src/index.ts`（导出） |
| WW | §5 §6 | `apps/web/src/features/writing/**`、`apps/web/src/lib/api-writing.ts` | `app/router.tsx`、`AppLayout.tsx`、命令面板、`themes/<id>/*.css`（只加写作页规则）、`themes/README.md` 的 data-part 清单、i18n `writing.*` |

---

## 1. 概念

- **项目**（writing_projects）：一部作品。settings：`{ connectionId?, model?, layoutMode: 'cache-aware' | 'strict'（缺省 cache-aware）, styleGuide: string, systemPrompt?: string（覆盖内置写作系统提示词）, contextBudget?: number（token，缺省按模型 maxContext 的 60%）, language?: 'zh-CN' | 'en', thinking? }`；`lorebookIds` = 设定圣经（复用世界书，编辑用现成的世界书编辑器）；`outline` = 大纲（纯文本 / Markdown）。
- **文档**（documents）：`kind='chapter'` 章节按 `docOrder` 成链；`kind='note'` 笔记不进上下文（除非被 @引用，见 §2.4）。`content` 是 TipTap JSON，`text` 是纯文本（服务端每次保存由前端一并提交，服务端重算 `wordCount`：中文按字、英文按词）。
- **摘要链**：章节 `done=true` 时生成摘要；`summaryStale=true` 表示摘要生成后正文又改过。

## 2. 上下文组装（`packages/core/src/writing/assemble.ts`，WS）

```ts
export interface WritingAssembleInput {
  project: { id: string; title: string; styleGuide: string; systemPrompt?: string; outline: string; language: 'zh-CN' | 'en' };
  chapters: { id: string; title: string; order: number; summary: string; done: boolean; text: string }[];  // 全部章节（按 order）
  current: { id: string; textBefore: string; selection?: string; textAfter?: string };                      // 光标 / 选区
  action: WritingAction;
  instruction?: string;
  bible: WIBook[];                 // 圣经世界书（已转成 WI 引擎的形态）
  wiSettings: WISettings;
  globalSystemPrompt?: string | null;
  model: string; providerCaps: LayoutProviderCaps;
  layoutMode: 'strict' | 'cache-aware';
  budget: number;                  // token 预算
  countTokens: (text: string) => number;
}
export type WritingAction = 'continue' | 'rewrite' | 'expand' | 'condense' | 'summarize' | 'custom';
export function assembleWriting(input: WritingAssembleInput): { ir: PromptIR; report: WritingContextReport };
```

段落与稳定性（顺序即输出顺序）：

| 顺序 | 段 | stability | 说明 |
| ---- | ---- | ---- | ---- |
| 1 | 写作系统提示词（内置双语模板，或 project.systemPrompt） | static | `packages/i18n/prompts/writing.{zh-CN,en}.md` |
| 2 | 全局系统提示词 | static | 复用 M3 的全局系统提示词设置 |
| 3 | 风格指南 | static | |
| 4 | 圣经常驻条目（constant） | static | 按 order 排 |
| 5 | 大纲 | static | |
| 6 | 已完成章节的摘要（当前章之前的，按 order） | session | 过期摘要照样用，report 里列出 |
| 7 | 当前章正文（光标前） | history | 超预算时从**前面**截断，截断处加「（前文略）」 |
| 8 | 触发的圣经条目（扫描「当前章光标前最后 ~2000 字 + 选区 + 指令」） | turn | 走 `scanWorldInfo`；constant 已在 4，不重复 |
| 9 | 动作指令（含选区、光标后片段的前 300 字作为衔接参考） | turn | 按 action 选模板 |

- 布局：cache-aware 时调用现有 `layoutCacheAware`（static 末尾打断点，session 末尾第二个断点），strict 时 `layoutStrict`；**段的顺序本身已经是缓存友好的**，布局器主要负责断点。
- 预算分配：先保证 1–5、8、9；剩余给 6 与 7，7 优先（至少保留 `min(40%, 实际长度)`），6 从最早的章节开始丢弃并记进 report。
- `WritingContextReport`：各段 token、被截断 / 丢弃的内容、过期摘要列表、激活的圣经条目（给前端「上下文」面板显示）。
- 单测覆盖：顺序与稳定性标注、预算截断、断点位置、圣经扫描只扫末尾窗口。

### 2.1 动作模板（`writing.{zh-CN,en}.md` 内分节）

- `continue`：从光标处续写，衔接光标后的文字（若有），不重复已有内容，长度约 `targetLength`（缺省 400 字 / 300 words）。
- `rewrite`：只输出选区的改写结果，保持信息量，按指令调整。
- `expand`：扩写选区到约 2 倍，补细节不改情节。
- `condense`：压缩选区到约一半。
- `summarize`：输出本章摘要（200–400 字，列人物动向、关键事件、伏笔），供后续章节上下文使用。
- `custom`：用户自定义指令作用于选区或光标处。
- 输出约束写进模板：只输出正文，不加解释、不加引号包裹、不加 Markdown 标题。

### 2.2 @引用

指令里写 `@笔记标题` 或 `@第N章` 时，把该笔记全文 / 该章摘要作为 turn 段附在指令前（最多 3 个，超出预算时截断）。

## 3. 服务端接口（`routes/writing.ts`，WS）

- 项目：`GET /api/writing/projects`（含章节数、总字数、更新时间）、`POST`、`GET /:id`（含文档列表摘要，不含正文）、`PUT /:id`（title / settings / lorebookIds / outline）、`DELETE /:id`。
- 文档：`POST /api/writing/projects/:id/documents` `{ kind, title, afterId? }`、`GET /api/writing/documents/:docId`（含 content / text / summary）、`PUT /api/writing/documents/:docId` `{ title?, content?, text?, done?, summary? }`（改 text 时若已有摘要置 `summaryStale=true`）、`DELETE`、`PUT /api/writing/projects/:id/order` `{ ids }`。
- 版本：`GET /api/writing/documents/:docId/versions`、`GET …/versions/:version`、`POST …/versions` `{ label? }`（手动存版）、`POST …/versions/:version/restore`（先把当前存一版再恢复）。每个文档保留最近 **100** 版；与上一版 text 相同不写。
- AI：`POST /api/writing/documents/:docId/ai`（SSE）`{ action, instruction?, cursor: number, selection?: { from, to }, textBefore, textAfter?, selectionText?, targetLength? }`：
  - 服务端先**写一版**（author=user, label=`before:<action>`），再组装（§2）并 `streamLlm`；
  - 事件：`context {report}`、`text {delta}`、`reasoning {delta}`、`usage {…}`、`done {text}`、`error {message}`；
  - 不改文档（前端决定怎么插入，插入后照常 PUT 保存；接受 AI 结果后前端再触发一次存版 author=ai）；
  - `summarize` 动作结束后服务端直接写 `documents.summary`、清 `summaryStale`；
  - 用量写 `generation_log`（nodeId 为空）。
- 章节完成：`PUT` 把 `done` 从 false 改为 true 时，服务端后台起一次 summarize（用项目的连接），完成后写回；失败不影响保存，前端下次读取时看到仍无摘要可手动重试。
- `POST /api/writing/projects/:id/inspect` `{ docId, action, cursor, … }` → 组装结果（IR 段落 + report），不调用模型，给前端「上下文」面板与检查器用。
- 导出：`GET /api/writing/projects/:id/export?format=md|txt`（按章节顺序，章节标题作二级标题；笔记不导出）。

## 4. 测试（WS）

- core：§2 的单测。
- 服务端（makeTestApp + registerFakeAdapter）：项目与文档增删改排序、字数、摘要过期标记、版本上限与 restore、AI 动作 SSE（断言请求里各段顺序、圣经条目触发、选区进指令）、done 触发摘要、导出。
- 真机（Z.AI glm-5.3-flash，Key 见记忆 `newtavern-test-endpoint`，只在 scratchpad 脚本里用）：建项目 + 圣经（5–8 条设定）+ 大纲，连续写 5 章（每章续写 3–4 次 + 完成生成摘要），断言第二次及之后的 AI 动作 `cacheRead > 0`，并人工抽查圣经设定没有被写崩；结果与各次用量记进报告。

## 5. 前端（`features/writing/`，WW）

### 5.1 路由

- `/writing`：项目列表（卡片：标题、章节数、字数、最近更新）+ 新建。
- `/writing/:projectId`（可带 `?doc=`）：项目页。
- 导航 `NAV_ITEMS` 的 `/writing` 改指真页；命令面板加「新建章节」「AI 续写」「存版本」动作（仅在项目页可用）。

### 5.2 项目页布局

- 左栏：章节树（拖拽排序、完成标记、摘要过期的小标、字数）+ 笔记分组 + 大纲入口。
- 中栏：TipTap 编辑器（`@tiptap/react` + StarterKit + Placeholder + CharacterCount；**懒加载分块**，不进首屏）。顶部：章节标题（可编辑）、字数、保存状态。编辑区宽度用 `--story-measure`，字体用 `--font-story`、字号与行高用 `--story-size` / `--story-leading`，所以六个世界会自然呈现各自的纸面。
- 右栏页签：**AI**（动作按钮 + 指令输入 + 连接 / 模型 / 目标长度）、**圣经**（绑定世界书的选择 + 嵌入 `LorebookEditor`，M6 拆出的组件；若 M6 尚未拆出，用跳转到 `/lorebooks/:id`）、**风格**（风格指南 + 项目系统提示词）、**上下文**（`/inspect` 的 report：各段 token、截断、过期摘要、触发条目）、**版本**。
- 窄屏（<1024）：左栏与右栏变抽屉，编辑器全宽；AI 动作在底部工具条。

### 5.3 AI 交互

- **续写**：流式直接插入光标处，插入的文字带临时标记（`data-part="writing-ai-pending"`，淡色底），结束后出现「保留 / 撤销 / 重来」；保留即清除标记并存版（author=ai）；撤销用 TipTap 事务回退整段；重来 = 撤销 + 再请求。生成中可停止（abort SSE，已生成部分保留为待定状态）。
- **重写 / 扩写 / 压缩 / 自定义**：需要选区；结果显示在对照视图（选区原文 vs 新文本，字符级 diff），「替换」才写入编辑器。
- **摘要**：章节菜单「生成摘要」或标记完成时自动；摘要在章节树悬停 / 右栏上下文里可看可改。
- 自动保存：输入停止 1.5 秒后 PUT；每 10 分钟若有改动自动存一版；离开页面有未保存改动时拦截。

### 5.4 版本页签

列表（版本号、作者、标签、时间、字数变化）；选中显示与当前稿的字符级 diff（`diff` 包的 `diffChars`，大文本时退化为 `diffWordsWithSpace` 并提示）；「恢复」「以此为基础新建章节」。

### 5.5 视觉

- 只用槽位与材质类；编辑纸面用 `surface-reading`；新增 `data-part`：`writing-shell`、`writing-tree`、`writing-page`、`writing-ai-pending`、`writing-diff`，写进 `themes/README.md`。
- 六个世界各补写作页的细节（写在各自 theme.css 里，互不参考）：书斋＝宣纸、段首缩进 2em、段间不空行；素＝纯排版、无纸面边框；酒馆＝羊皮纸钉在皮革上；琉璃＝冰板上书写；雨夜＝湿玻璃后的纸；暖房＝便签纸。**中文不用合成斜体**；AI 待定文字用各世界的 `--accent-soft` 底，不得大面积铺强调色。
- 截图（主会话审）：六个世界 × 支持的模式 × 1440 / 390，项目页有正文与待定 AI 文字的状态。

## 6. 验收

- 连续 5 章真机写作跑通（§4），第二次起 `cacheRead > 0`。
- 未连接模型时项目 / 章节 / 版本 / 导出都可用（AI 按钮给出去连接页的提示）。
- 首屏 bundle 不因 TipTap 增加（写作路由单独分块，`pnpm --filter @newtavern/web build` 输出里核对）。

## 7. 修正

（暂无）
