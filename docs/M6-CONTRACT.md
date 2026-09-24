# M6 契约：创作工作台（含本轮共用基础：工具调用）

| 项目 | 内容 |
| ---- | ---- |
| 版本 | v1（2026-09-22） |
| 范围 | §1 提供商工具调用与结构化输出（本轮共用基础，F1）；§2 工作台服务端基础（角色卡编辑、版本历史、提示库、草稿测试、触发模拟）；§3 AI 协作者；§4 工作台前端 |
| 不含 | 发布用元数据（封面、多语言简介）、按目标模型改写预设措辞、从对话样本反推设定 → 以后 |

先读：`docs/PLAN.md` §3.1 / §3.7、`docs/M3-CONTRACT.md`（组装与布局）、`apps/web/src/themes/README.md`（槽位、材质类、data-part）、`docs/DESIGN.md` §四（全局禁忌）。
本文与代码冲突时以本文为准；实现中发现本文写错，在 §6 追加「修正」注明日期与代号。

**代号与目录归属**（并行开发，各改各的；共享文件只做最小改动，改前重新读）：

| 代号 | 内容 | 独占目录 / 文件 | 共享（最小改动） |
| ---- | ---- | ---- | ---- |
| F1 | §1 工具调用 | `packages/providers/**`、`packages/core/src/prompt/ir.ts`、`apps/server/src/services/llm.ts`（新） | `routes/sandbox.ts`（聚合改用 collectStream）、`services/provider-request.ts` |
| ST | §2 + §3 服务端 | `routes/{characters,versions,prompt-library,studio}.ts`、`services/{versions,character-edit,studio-*}.ts`、`packages/i18n/prompts/studio.*` | `routes/{presets,lorebooks,chats}.ts`、`services/{assemble-input,importer,inspect}.ts`、`app.ts` |
| SW | §4 前端 | `apps/web/src/features/studio/**` | `features/library/{PresetEditorPage,LorebookEditorPage,CharactersPage}.tsx`、`app/router.tsx`、`AppLayout.tsx`、`lib/api*.ts`、i18n `studio.*` |

---

## 1. 工具调用与结构化输出（F1）

### 1.1 IR 扩展（`packages/core/src/prompt/ir.ts`）

```ts
export type Part =
  | …现有…
  /** assistant 段里模型发起的工具调用；args 为 JSON 字符串（原样回传，不重新序列化） */
  | { type: 'tool_call'; id: string; name: string; args: string }
  /** 工具结果；放在 role='user' 的段里（Anthropic 语义），适配器负责转成各家形态 */
  | { type: 'tool_result'; callId: string; name: string; content: string; isError?: boolean };

export interface PromptIR {
  …现有…
  tools?: ToolDef[];
  /** 缺省 'auto'；{ name } = 强制调用该工具 */
  toolChoice?: 'auto' | 'none' | 'required' | { name: string };
  /** 结构化输出：JSON Schema（与 tools 同时给时以各家限制为准，冲突时给 warning） */
  responseFormat?: { name: string; schema: Record<string, unknown>; strict?: boolean };
}
```

`isSquashableSegment` 对含 tool_call / tool_result 的段返回 false。组装流水线（assemble.ts）**不产生**这两种 part，只有直接构造 IR 的调用方（AI 协作者、前端卡 generate）会用；黄金测试必须仍然 62/62。

### 1.2 适配器（四家都要做）

| 适配器 | 请求 | 流式 |
| ---- | ---- | ---- |
| openai-chat | `tools:[{type:'function',function:{name,description,parameters,strict?}}]`、`tool_choice`；assistant 消息 `tool_calls`；tool_result → `role:'tool', tool_call_id`；`response_format:{type:'json_schema',json_schema:{name,schema,strict}}` | `delta.tool_calls[]` 按 **`index`** 维护 id/name（后续 chunk 的 id/name 为空要回填），修掉现有 bug |
| openai-responses | `tools:[{type:'function',name,description,parameters,strict}]`（与已有 image_generation 并存）；`function_call` / `function_call_output` 输入项；`text.format:{type:'json_schema',…}` | `response.output_item.added`（function_call）+ `response.function_call_arguments.delta`；有函数调用时 `stop:'tool'` |
| anthropic | `tools:[{name,description,input_schema}]`、`tool_choice:{type:'auto'|'any'|'tool',name}`；`tool_use` / `tool_result` 块；结构化输出用强制单工具（`tool_choice:{type:'tool'}`）模拟，结果按 `tool.call` 发出后由 collectStream 还原为 text | `content_block_start`(tool_use) + `input_json_delta` |
| google | `tools:[{functionDeclarations:[…]}]`、`toolConfig.functionCallingConfig`；`functionCall` / `functionResponse` parts；`generationConfig.responseMimeType:'application/json'` + `responseSchema` | `functionCall` part（一次给全参数，argsDelta = 整个 JSON） |

统一约定：**每个 `tool.call` 事件都带正确的 `id` 与 `name`**（没有 id 的家族用 `call_<index>` 生成），`argsDelta` 按到达顺序拼接即为完整参数；有工具调用而停止时 `stop.reason='tool'`。JSON Schema 中各家不支持的关键字（如 Google 不认 `additionalProperties`）由适配器剔除并记 warning。

### 1.3 降级：不支持工具的模型（`packages/providers/src/tool-fallback.ts`）

```ts
/** caps.tools=false 且 ir.tools 非空时调用：去掉 tools，在最后一个 system 段后追加协议说明段，
 *  把历史里的 tool_call / tool_result part 渲染成文本。返回新 IR（不改原对象）。 */
export function applyTextToolProtocol(ir: PromptIR, lang: 'zh-CN' | 'en'): PromptIR;
/** 从模型文本里解析 ```tool_call {"name":…,"arguments":{…}}``` 代码块（可多个）；rest = 去掉代码块后的正文 */
export function parseTextToolCalls(text: string): { toolCalls: CollectedToolCall[]; rest: string };
```

结构化输出降级同理：caps.structuredOutput=false 时在指令里附 schema，并从回复里抽第一个 JSON 对象。

### 1.4 收集助手（`packages/providers/src/collect.ts`）

```ts
export interface CollectedToolCall { id: string; name: string; args: string; parsed?: unknown; parseError?: string }
export interface CollectedResult {
  text: string;
  reasoning: string;
  opaque: { provider: string; model: string; payload: unknown }[];
  images: { mime: string; data: string }[];
  toolCalls: CollectedToolCall[];
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number };
  stop: { reason: 'end' | 'length' | 'refusal' | 'filter' | 'tool' | 'abort'; detail?: string };
  warnings: string[];
  error?: ProviderError;
}
export async function collectStream(
  adapter: ProviderAdapter, conn: Connection, req: ProviderRequest, signal: AbortSignal,
  onEvent?: (e: GenEvent) => void,
): Promise<CollectedResult>;
```

### 1.5 服务端一次性调用（`apps/server/src/services/llm.ts`，F1 新建）

```ts
export interface LlmCallInput {
  connectionId: string; model: string; ir: PromptIR;
  thinking?: ThinkingOptions; signal?: AbortSignal;
  onEvent?: (e: GenEvent) => void;   // 需要流式转发时（AI 协作者、写作）
}
/** 解析连接 + 解密 Key + 能力 → 必要时套 §1.3 降级 → buildProviderRequest → collectStream（降级时再 parseTextToolCalls）。
 *  写 generation_log（nodeId 为空，layoutMode 取 ir.meta.layoutMode）。 */
export async function callLlm(db: Db, dataDir: string, input: LlmCallInput): Promise<CollectedResult>;
/** 同上但返回事件流（写作续写要边收边推） */
export function streamLlm(db: Db, dataDir: string, input: LlmCallInput): AsyncIterable<GenEvent>;
```

`routes/sandbox.ts` 的非流式聚合改用 `collectStream`，行为不变。

### 1.6 验收

- 四家各一组契约回放测试：请求渲染（tools / tool_choice / 历史里的 tool_call 与 tool_result / responseFormat）+ 流式解析（单个与并行两个工具调用）。
- `collectStream`、`applyTextToolProtocol`、`parseTextToolCalls` 单测。
- 真机：Z.AI glm-5.3-flash 的 openai-chat 与 anthropic 两个端点各跑一次「调用 get_weather 工具 → 回传结果 → 得到最终回答」（Key 见记忆 `newtavern-test-endpoint`，不入仓库、不写进测试文件；只在隔离脚本里读环境变量）。
- 黄金测试 62/62。

---

## 2. 工作台服务端基础（ST）

### 2.1 角色卡编辑

- `POST /api/characters` `{ name, data? }` → 新建 V3 空卡（`spec:'v3'`，data 按 CCv3 默认字段补齐），返回 `CharacterDetail`。
- `PUT /api/characters/:id` `{ data, author?: 'user'|'ai' }`：`data` 是**完整** CCv3 data（前端从 GET 拿到的 data 改出来的），服务端只做：结构校验（必须是对象，`name` 非空字符串）、同步 `name` / `tags` 列、写 `editedAt=now`、写一版 `entity_versions`（§2.2）。未知字段原样保留。
  - `data.character_book` 不从这里改：卡的内嵌世界书仍在 lorebooks 表里编辑（`bookId`），导出时 `rebuildCharacterBook` 照旧合回。
  - 角色脚本（`extensions.tavern_helper.scripts` / `TavernHelper_scripts`）随 data 一起写。
- `POST /api/characters/:id/avatar`（multipart，浏览器端已裁成 512×512 WebP，复用 personas 的做法）/ `DELETE …/avatar`。
- **导出**：`exportCharacter` 在 `editedAt` 非空时**不再**返回原件字节，改为从 data 重写（PNG 用当前头像 + `writeCardToPng`，写 ccv3 + chara 两个 chunk；CHARX 用 `writeCharx`）。未编辑过的卡行为不变（仍回原件）。

### 2.2 版本历史（`services/versions.ts`）

```ts
type EntityType = 'character' | 'preset' | 'lorebook';
recordVersion(db, type, id, data, author: 'user'|'ai'): number   // 返回版本号；与上一版 JSON 相同则不写
listVersions(db, type, id): { version, author, createdAt, size }[]
getVersion(db, type, id, version): unknown
```

- 每个实体保留最近 **50** 版（写入时删最旧的）。
- 写入时机：角色卡 PUT、预设 PUT、世界书 PUT（data = `{ name, entries }` 的导出形态，即 `GET /api/lorebooks/:id` 的 entries）；以及导入时写第 1 版。请求体带 `author:'ai'` 时记 ai。
- 接口：`GET /api/versions/:type/:id`、`GET /api/versions/:type/:id/:version`、`POST /api/versions/:type/:id/:version/restore`（等价于用该版 data 走一次对应的 PUT，author='user'，产生新版本，不删历史）。

### 2.3 提示库

`/api/prompt-library`：`GET /`（?q= 按名称与内容 LIKE、?tag=）、`POST /`、`PUT /:id`、`DELETE /:id`。字段 `{ id, name, content, role: 'system'|'user'|'assistant'|null, tags: string[] }`。

### 2.4 草稿测试（未保存的改动也能试）

- `buildAssembleInput(db, ctx)` 的 ctx 加 `draft?: { character?: { id, data }, preset?: { id, data }, lorebook?: { id, name, entries } }`：给了就用内存对象代替对应数据库行（世界书草稿替换同 id 的那本书；卡草稿的 `extensions.depth_prompt`、正则仍按 data 读）。
- `POST /api/chats/:id/inspect`（与现有 GET 同参数，另收 body `{ draft }`）；`POST /api/chats/:id/generate` 的 body 加可选 `draft`。
- **测试对话**就是普通会话：`POST /api/chats` 的 body 可带 `metadata: { studio: { kind, entityId } }`；`GET /api/chats` 默认**排除** `metadata.studio` 非空的会话（`?includeStudio=1` 才返回）。同一实体复用最近一条测试会话（`GET /api/studio/test-chat/:kind/:id` 返回或新建）。
  - kind='preset' 时测试会话的 presetId = 该预设、角色取最近一张用过的卡或空；kind='lorebook' 时把该书绑到测试会话。

### 2.5 世界书触发模拟

`POST /api/lorebooks/:id/simulate` `{ text: string, entries?: 草稿条目（同 PUT 形态）, scanDepth? }` → 用 core 的 WI 引擎把 `text` 当作一条用户消息扫描一次，返回 `{ activated: { uid, comment, reason: 'constant'|'key'|'secondary'|'recursion'|'decorator', matchedKeys: string[], position, depth, order }[], skipped: { uid, reason }[] }`。不推进时间态、不落库。

---

## 3. AI 协作者（ST，依赖 §1）

### 3.1 接口

`POST /api/studio/assist`（SSE）

```ts
{
  connectionId: string; model: string;
  target: { kind: 'character' | 'preset' | 'lorebook'; id?: string };  // 无 id = 新建（一句话生成）
  draft: unknown;            // 当前编辑器草稿（character: CCv3 data；preset: ST 预设 data；lorebook: { name, entries }）
  conversation: { role: 'user' | 'assistant'; content: string }[];   // 之前几轮协作对话（纯文本）
  instruction: string;
  mode: 'edit' | 'generate';
  testChatId?: string;       // run_test_turn 用哪个测试会话的 persona / 历史
  lang: 'zh-CN' | 'en';
}
```

SSE 事件：`text {delta}`、`reasoning {delta}`、`tool {id, name, args, summary}`（调用发起）、`tool_result {id, ok, summary}`、`patch {ops: StudioPatchOp[]}`（**整轮结束时发一次**，相对于请求里的 draft）、`usage {…}`、`done {}`、`error {message}`。

### 3.2 工具（服务端在 draft 的内存副本上执行，最多 12 步）

| 工具 | 适用 | 说明 |
| ---- | ---- | ---- |
| `get_field {path}` | 全部 | 读草稿里的字段（JSON Pointer 风格路径，如 `/description`、`/prompts/3/content`） |
| `set_field {path, value}` | 全部 | 写字段；路径不存在的父级报错；预设只允许改 prompts / prompt_order / 采样参数 / name |
| `list_entries {query?}` | lorebook、character（内嵌书只读） | 列出条目摘要（uid、comment、keys、content 前 80 字） |
| `add_entry {entry}` / `update_entry {uid, patch}` / `delete_entry {uid}` | lorebook | 条目形态同 PUT |
| `set_prompt {identifier, content?, role?, enabled?, …}` | preset | 按 identifier 改提示词条目；不存在则新建自定义条目 |
| `run_test_turn {user_message}` | 全部 | 用**当前内存草稿**组装（§2.4 draft）并调用同一连接生成一轮，返回回复前 1500 字 |
| `inspect_prompt {}` | 全部 | 返回组装后各段的 origin / role / token 数与前 120 字 |
| `search_reference {query}` | 全部 | 在用户库（角色卡、世界书条目、预设名）里按 LIKE 检索，返回最多 10 条摘要 |

`StudioPatchOp = { op: 'set', path: string, value: unknown, before: unknown } | { op: 'add_entry', entry, uid } | { op: 'update_entry', uid, patch, before } | { op: 'delete_entry', uid, before }`——前端据此渲染字段级 diff 与逐条接受。

### 3.3 提示词

`packages/i18n/prompts/studio.{zh-CN,en}.md` 重写为完整的协作者系统提示词：角色（资深角色卡 / 预设 / 世界书作者）、工具使用规范（先读后写、改动最小化、不擅自改用户没提的字段）、CCv3 字段含义速查、ST 预设结构说明、世界书条目写法要点；`mode:'generate'` 附加「从一句话生成整卡」的步骤（名称 → 描述 → 性格 → 场景 → 开场白 ×1–3 → 示例对话 → 可选 3–8 条世界书条目，写入内嵌书时用 add_entry 需先建书：generate 模式下角色卡的 `character_book` 可直接 set_field `/character_book`，保存时服务端抽进 lorebooks 表）。模型不支持工具时走 §1.3 降级。

### 3.4 验收

- 路由测试（fake adapter 预录工具调用序列）：edit 模式改两个字段 → patch 正确、draft 原件不变；generate 模式从空卡生成；步数上限；工具报错回传给模型。
- 真机：Z.AI glm-5.3-flash 一句话生成整卡，保存后能直接测试对话。

---

## 4. 工作台前端（SW，依赖 §2 / §3）

### 4.1 路由与布局

- `/studio`：入口页——最近编辑（取 versions 最新的若干实体）、「新建角色卡 / 预设 / 世界书」、「一句话生成角色」输入框。
- `/studio/:kind/:id`（kind = character | preset | lorebook）。三栏（宽屏）：左 编辑器；中 测试对话（嵌入 `ChatView`，会话由 §2.4 的 test-chat 接口给出，生成与检查都带 draft）；右 页签「AI 协作 / 检查器 / 版本 / 提示库」。窄屏（<1024）：顶部分段切换「编辑 / 测试 / 协作」。
- 导航：`NAV_ITEMS` 的 `/studio` 改指真页；`CharactersPage` 详情弹窗、预设库、世界书库各加「在工作台打开」。

### 4.2 编辑器

- **角色卡编辑器**（新写，`features/studio/character/`）：名称、头像（`ImageCropper`）、描述、性格、场景、开场白 + 备用开场白（增删排序）、示例对话、系统提示词、历史后指令、`depth_prompt`（内容 / 深度 / 角色）、创作者、版本、标签、创作者笔记（含 `creator_notes_multilingual` 按语言页签）、内嵌世界书（跳到该书的编辑页签）、角色脚本（列表 + 启用开关；代码编辑复用 S 的脚本编辑器组件，未就绪时用多行文本框）、立绘（复用 V 的上传组件，未就绪时隐藏）。长文本字段用自适应高度的文本框并显示 token 估算。
- **预设 / 世界书编辑器**：把 `PresetEditorPage.tsx` / `LorebookEditorPage.tsx` 的内层编辑器拆成导出组件 `PresetEditor` / `LorebookEditor`（`features/library/preset-editor/`、`lorebook-editor/`），受控接口：`{ value, onChange, onSave, saving, embedded?: boolean }`；导航拦截、返回链接留在页面薄壳里。原页面行为不变（有现成测试的必须仍通过）。
  - 预设补：提示词条目**拖拽排序**（与现有拖放实现同方案）、布局策略（strict / cache-aware / 跟随导入默认）与逐条「保真锁」（写进 `layoutPolicy`）。
  - 世界书补：「触发模拟」抽屉（§2.5），输入一段文字看哪些条目会激活、为什么。
- 草稿状态由工作台统一持有（`useStudioDraft(kind, id)`：baseline / draft / dirty / save / revert），测试对话与检查器读同一份 draft。

### 4.3 AI 协作面板

- 顶部：连接与模型选择（默认跟随设置的默认连接）。
- 对话流：用户指令、模型文字（流式）、工具调用折叠条（名称 + 一句摘要，展开看参数与结果）。
- 收到 `patch`：显示「本轮改动」卡片——逐条字段级 diff（长文本按字符 diff，中文友好；世界书条目按条目），每条「接受 / 拒绝」，整体「全部接受」。接受 = 合进 draft（不自动保存）；保存时若 draft 含 AI 接受的改动，PUT 带 `author:'ai'`。
- 撤销：版本页签里回退；未保存时「还原到上次保存」。

### 4.4 版本与提示库页签

- 版本：列表（版本号、作者 user / ai、时间）；选中看与当前草稿的字段级 diff；「恢复此版本」（§2.2 restore 后刷新 baseline）。
- 提示库：搜索、标签过滤、新建 / 编辑 / 删除；「插入」——预设编辑器里插为新条目，角色卡编辑器里插到当前聚焦的文本框光标处。

### 4.5 视觉

只用槽位与材质类（`themes/README.md`），新增 `data-part`：`studio-shell`、`studio-editor`、`studio-assist`、`studio-diff`、`studio-diff-add`、`studio-diff-del`、`studio-tool-call`，写进 README 的清单。diff 的增删色用 `--success` / `--danger` 的 soft 形态，不得大面积铺色。六个世界下 1440 / 390 截图由主会话审。

### 4.6 验收

- 一句话生成整卡 → 保存 → 测试对话能直接聊。
- AI 编辑后导出 PNG，本机 ST 1.18 能导入且字段一致；未编辑过的卡导出仍与原件字节相同（测试断言）。
- 预设 / 世界书旧页面回归通过；拖拽排序后导出仍无损。

---

## 5. 统一要求

- 每个代理交付：`pnpm test`、`pnpm typecheck`、`pnpm lint` 在自己改动的包里通过；web 改动还要 `pnpm --filter @newtavern/web build`。
- 服务端新接口必须有 `makeTestApp` 路由测试；生成类用 `registerFakeAdapter`。
- 真机验证用隔离服务端：`NT_PORT=8799`（或其他未占用端口，**不得用 5173/5174/8787**），`NT_DATA_DIR` 指向会话 scratchpad；不往用户库写测试数据；清理只按自己的端口（PowerShell `Get-NetTCPConnection -LocalPort <port> | Stop-Process`）。
- 不提交 git（主会话统一提交）。

## 6. 修正

### 修正（2026-09-22，F1）

§1 的签名全部按原文实现，以下是**只增不改**的补充（调用方可以不用）：

1. **`ProviderRequest.structuredOutputTool?: string`**（providers `types.ts`）：Anthropic 用强制单工具模拟结构化输出时，适配器在请求上标注该工具名；`collectStream` 据此把它的 `tool.call` 还原为正文（`result.text` = 参数 JSON，`onEvent` 收到的是 `text.delta` 而不是 `tool.call`），并把 `stop.reason` 从 `tool` 归一化回 `end`。
2. **`LlmCallInput.lang?: 'zh-CN' | 'en'`**：§1.3 降级协议说明的语言。缺省按 IR 正文里有无中日韩字符推断。
3. **结构化输出降级的两个函数**（§1.3 只说「同理」没给签名），同在 `tool-fallback.ts`、从入口导出：
   - `applyTextResponseFormat(ir, lang): PromptIR` —— 去掉 `responseFormat`，在最后一个 system 段后附 schema 说明；
   - `extractFirstJson(text): { json: string; value: unknown } | undefined` —— 优先 ```json 代码块，其次括号配对扫描。
   另导出 `createToolCallTextFilter()`（流式滤掉 ```tool_call 代码块，`streamLlm` / `callLlm` 的 `onEvent` 在降级时用它，调用方看到的 `text.delta` 不含协议代码块）、`finalizeToolCall`、`irHasToolParts`、`syntheticCallId` / `isSyntheticCallId`。
4. **`callLlm` / `streamLlm` 的错误语义**：连接不存在 / 适配器未注册 → 抛 `ProviderServiceError`（`streamLlm` 在迭代时抛）；上游错误不抛，放进 `result.error`（流里是 `error` 事件）。多 Key 连接首事件鉴权 / 限流错误换下一个 Key 重试一次（同 chats 生成路径）。降级时解析出的工具调用在流末以 `tool.call` 补发，`stop` 随后才发（`reason:'tool'`）。
5. **细化的渲染约定**（契约表格没写到的）：
   - `tool_result.isError`：OpenAI 两家没有对应字段，正文前加 `Error: `；Anthropic 发 `is_error:true`；Google 发 `response:{ error }`。Google 的 `functionResponse.response` 必须是对象：结果是 JSON 对象就原样用，否则包成 `{ result }`。
   - Anthropic `toolChoice:'none'` → `{type:'none'}`；强制类 tool_choice（any / tool）与推理不兼容：模型可关推理就本轮发 `thinking:{type:'disabled'}`，不可关则退回 `auto`，均给 warning。结构化输出与其他 tools 同时给时 `tool_choice` 改为 `any`（最终答案须经输出工具给出）。
   - Responses 的 function tool `strict` 缺省为 true（会要求 schema 全字段 required），适配器显式写 `strict: t.strict ?? false`。
   - Google：函数调用与 JSON 输出同时用只有 `gemini-3*` 发两者，更早的模型丢掉 `responseFormat` 并告警；合成的 `call_<n>` id 不回传给 Gemini；functionCall 上的 `thoughtSignature` 以 `{ target:'tool', ordinal }` 记入 `reasoning.opaque`，回传时挂回同一个 functionCall（Gemini 3 要求）。
   - 四家都把「有工具调用却以 end 结束」归一化为 `stop.reason='tool'`（兼容端点常把 finish_reason 写成 stop）。
6. **目录**：openai-chat 的 `glm-*` 标 `structuredOutput:false`——Z.AI OpenAI 兼容端点收下 `response_format:{type:'json_schema'}` 但不遵守（2026-09-22 实测），走文本降级。
7. **`routes/sandbox.ts`**：M5（三）的代理已先行把聚合改成 `collectStream`（并接上 tools / json_schema 降级），F1 未再改动该文件；`services/provider-request.ts` 也无需改动。

### 修正（2026-09-22，ST）

§2 按原文实现，以下是偏离与补充：

1. **世界书版本数据的形状**：原文写「`GET /api/lorebooks/:id` 的 entries」，但那是数据库行（带 `bookId` / `createdAt` / `updatedAt` / `extra`），既不能直接回灌 PUT（`parseSaveInput` 拒收非编辑字段），时间戳也会让「与上一版相同不写」失效。实际存 `{ name, entries }`，每条 = PUT 的可编辑字段（与编辑器草稿同形，数字形态的 `delayUntilRecursion` 与 `useProbability` / `vectorized` / `outletName` 从 raw 取）+ `id` / `uid` / `extra`（`{ stKey, raw }`，只供恢复）。恢复时仍在书里的条目按 id 更新；已被删掉的条目按快照里的 uid（未被占用时）与原始 ST 条目重建，未知字段不丢（`lorebook-edit.ts` 的 `EntryInput.restore`，只有恢复路径会设）。
2. **预设版本数据 = ST 预设 data**（与草稿同形）；预设名只在 data 自带 `name` 时随版本恢复。`layoutPolicy` 列仍不经 PUT 写入（§4.2 的「写进 layoutPolicy」需要另开口子，本阶段没做）。
3. **版本写入时机的补充**：除 §2.2 列的 PUT 与导入外，`POST /api/characters`、`POST /api/presets`、`POST /api/presets/:id/duplicate`、`POST /api/presets/:id/reset-builtin`、`POST /api/lorebooks` 也各写一版；角色卡导入时抽出来的内嵌书同样写第 1 版。删角色卡时一并删它的版本（预设 / 世界书删除不清，`recent` 列表会跳过已删实体）。
4. **新增 `GET /api/versions/recent?limit=&type=`**：各实体最新一版按时间倒序，给 §4.1 入口页「最近编辑」用（原文没给接口）。
5. **草稿**：`draft.character` 只在与会话的卡 id 相同时替换；卡的正则仍读正则库里这张卡的脚本（导入时已抽表），内嵌书仍读 `bookId`——「正则仍按 data 读」按「照旧」理解，草稿里改 `extensions.regex_scripts` 不影响本轮。`draft.lorebook` 只替换本轮本来就会加载的同 id 书（测试会话已绑定），条目按 PUT 规则校验，无 id 的条目按 ST 模板补齐。`POST /api/chats/:id/inspect` 的其余参数仍在 query 里（与 GET 同）。
6. **测试会话**：`GET /api/studio/test-chat/:kind/:id` 新建时回 201、复用时回 200，响应都是 ChatDetail。`POST /api/chats` 只收 `metadata.studio`，其余 metadata 键新建时忽略。新建对话的主体从 `routes/chats.ts` 抽到 `services/chat-create.ts`（`createChat`），行为不变。
7. **触发模拟**：只扫这一本书；设置取全局 `worldInfo.settings`，预算按 32768 上下文换算，概率条目真实随机。返回在原文基础上多给 `id`（草稿里的新条目为 null）、`index`（在条目列表中的下标）、`recursionLevel`、`warnings`；`reason` 为 `secondary` 时 `matchedKeys` 是命中的主键后接命中的副键；`skipped.reason` 为引擎拒绝原因（`disabled` / `probability` / `budget` / `group-lost` …），另加 `no-match`（有关键词但没命中）。引擎侧新增可选 `WIScanInput.diagnostics` → `WIActivation.diagnostic { via: 'decorator'|'secondary', matchedSecondaryKeys }`，只多记信息、不改判定（黄金测试 62/62）。
8. **导出**：编辑过的卡（`editedAt` 非空，头像换过也算）从 data 重写。PNG 以当前头像为底图，**只有 PNG 头像能当底图**（服务端没有图像解码），所以角色卡头像上传请前端输出 PNG（WebP / JPEG 也收，但导出 PNG 时退回 1×1 占位图；CHARX 不受影响）。重写时从原件带回：顶层未知字段（库里只存 data）、PNG 的 `chara-ext-asset_:` 资源 chunk、CHARX 包内的其余文件（图标换成当前头像）。
9. **`PUT /api/characters/:id` 的 `character_book`**：卡已关联内嵌书（`bookId`）时忽略传入值、保留库里原值；还没有内嵌书时收下并抽进 lorebooks 表（支撑 §3.3 generate 模式直接 `set_field /character_book`）。结构校验除「对象 + name 非空」外还跑一遍 CCv3 解析（类型不对会让导出失败，提前 400）。

### 修正（2026-09-22，ST-assist：§3 AI 协作者 + 预设布局策略）

§3 按原文实现（`routes/studio.ts` + `services/studio-assist{,-tools,-prompt}.ts`，类型 `StudioAssistRequest` / `StudioAssistEvents` / `StudioPatchOp` 从 `routes/studio.ts` 导出），以下是补充与偏离：

1. **请求体**：`connectionId` / `model` 可省略，按设置 `generation.default` 补，都没有 → 400 `no_connection`；`draft` 缺省 `{}`、`conversation` 缺省 `[]`、`mode` 缺省 `'edit'`、`lang` 缺省 `'zh-CN'`；另收可选 `thinking`（同聊天覆盖项 `thinking`：`{ enabled?, effort?, budgetTokens? }`）。请求校验失败 400、`target.id` 指向不存在的实体 404、连接不存在 400——都在**开流之前**以 JSON 返回。
2. **SSE 事件细节**：`tool.args` 是解析后的参数对象（解析失败时为原始字符串）；`tool_result` 多一个 `content`（回传给模型的结果正文，前端展开时显示；上限 8000 字符）；`usage` 为整轮累计，只在 `done` / `error` 前发一次；`done = { steps, stopReason: 'end' | 'max_steps' }`。结束顺序：正常 `patch → usage → done`；上游错误 `patch → usage → error`（**不发 done**，已做的改动仍在 patch 里可审阅）；客户端断开后不再发任何事件、不再调用模型。`patch` 每轮都发（可能是空数组）。
3. **步数 = 模型调用次数**，一轮最多 12 次；第 12 次强制 `toolChoice:'none'` 并在工具结果后附一句「已到步数上限，请直接总结」，这一次若仍返回工具调用则不执行，`stopReason='max_steps'`。一次调用遇到 `rateLimit` / `overloaded` / `network` 错误、且还没有任何输出时退避重试（1.5 s、4 s，最多 2 次）——Z.AI 免费模型高峰期大半请求回 1305「过载」，不重试的话一轮十来次调用几乎必失败。
4. **`StudioPatchOp` 语义**（形状与原文一致）：
   - `set`：`path` 为 JSON Pointer（`-` 已换成具体下标）；路径原先不存在时**没有 `before` 键**（JSON 表达不了 undefined），数组下标 = 原长度表示追加；同一路径多次写只出一条，最终值等于原值的不出；祖先路径也被写过时子路径并入祖先那一条；按首次写入的顺序排列。
   - 世界书条目按 **uid** 归并：新增后又改 = 一条 `add_entry`（最终内容），新增后又删 = 无；`add_entry.entry` = PUT 的可编辑字段 + `uid`（新 uid 接在库里与草稿里的最大 uid 之后，不复用本轮删掉的；PUT 对无 id 的新条目会沿用它）；`update_entry.patch` 只含真正变了的字段，`before` 为这些字段在请求草稿里的原值；`delete_entry.before` 为请求草稿里的整条原条目（原样，含编辑器的界面字段）。编辑器里尚未保存、没有 uid 的新条目不能被条目工具寻址（`list_entries` 里显示 `uid: null`）。
5. **工具细节**：
   - `set_field`：预设只允许 `prompts` / `prompt_order` / `name` / `ST_SAMPLING_KEYS`（`temperature`、`top_p`、`openai_max_tokens`、`openai_max_context`、`reasoning_effort` 等），采样键做数字 / 字符串校验；**世界书只允许 `/name`**，条目一律走条目工具（否则前端拿不到按条目的补丁）；角色卡的 CCv3 字符串字段 / 字符串数组字段做类型校验，写后整卡再过一遍 CCv3 解析（空卡时六个必填字段按空串算），卡在库里已关联内嵌书时写 `/character_book*` 报错（只读）。写 `/character_book`（或其 `entries`）时给 CCv3 条目补缺省：`enabled:true`、`insertion_order:100`、`keys:[]`、`content:''`、`extensions:{}`、`id=下标`，`keys` / `secondary_keys` 给成逗号分隔字符串时切成数组。期望对象 / 数组的字段（`character_book`、`extensions`、`alternate_greetings`、`tags`、`prompts/<n>` …）收到 JSON 字符串时先解析。路径缺前导 `/` 时补上；`__proto__` 等键拒收。
   - 条目工具的字段名同 PUT（`keys` / `secondaryKeys` / `entryOrder` / `disabled` …），另认 ST 原名别名 `key` / `keysecondary` / `secondary_keys` / `order` / `insertion_order` / `disable`，`keys` 给成字符串时按逗号切；校验复用 `parseSaveInput`。
   - `set_prompt` 收 `identifier`（必填）与 `name` / `content` / `role` / `enabled` / `injection_position`（0/1）/ `injection_depth` / `injection_order`；`enabled` 写进顺序表（与组装器同一张：`character_id` 100001 → 100000 → 第一张）；identifier 不存在时新建自定义条目（`system_prompt:false, marker:false, role:'system', injection_position:0, injection_depth:4, injection_order:100, forbid_overrides:false`）并追加到顺序表末尾（默认启用）；给 marker 条目写 `content` 报错。补丁表现为 `set /prompts/<i>`（整条）与 `set /prompt_order/<k>/order`（整个数组）。
   - `run_test_turn` / `inspect_prompt`：需要 `target.id`。**无 id（尚未保存的 generate）时这两个工具不出现在工具表里**，模型硬调则返回说明性错误「还没有保存，请先保存」。测试会话取 `testChatId`，缺省按 `GET /api/studio/test-chat/:kind/:id` 取 / 建（因此可能新建一条测试会话）。组装用 `dryRun`、草稿按 §2.4 规则校验（草稿不合法时以工具错误回传），`run_test_turn` 的用户消息只是接在 head 后的内存节点、不落库；布局模式与推理设置取测试会话的覆盖项。`inspect_prompt` 返回 `{ tokenEstimate, segments: [{ origin, role, tokens, preview }], warnings }`。
   - `search_reference`：角色卡（名称 / 描述 / 性格）、世界书条目（正文 / 备注 / 关键词）、预设名，LIKE 检索，合计最多 10 条。
6. **提示词文件格式**：`studio.{zh-CN,en}.md` 按 `## <节名>` 切段：`system`（总是用）、`character` / `preset` / `lorebook`（按对象选一段）、`generate.character` / `generate.preset` / `generate.lorebook`（mode='generate' 时追加）；第一个节之前的内容是文件说明，不发送。系统提示词之后另有一个 system 段写「当前任务」（对象、是否已保存、模式、可用工具）与**草稿概览**（各字段长度与摘要、预设条目表、世界书条目表），模型要全文时用 `get_field`。之前几轮 `conversation` 按原角色进 IR，`instruction` 为最后一条 user。
7. **文本降级**：模型 `caps.tools=false` 时由 `callLlm` 套 §1.3 协议（已有路由测试：```tool_call 代码块被解析执行、流里的 `text` 不含协议代码块）。
8. **预设布局策略（改正上一段修正第 2 条）**：`PUT /api/presets/:id` 其实已经收 `layoutPolicy`（缺省 = 不动、null = 清空，形状见 `services/preset-edit.ts` 的 `PresetLayoutPolicy`：`mode?: 'strict'|'cache-aware'`（缺省 = 跟随会话 / 导入默认）、`lockedIdentifiers?: string[]`（逐条保真锁）、`tailWindow?`、`volatileHandling?`、`wiCarrierRole?`、`ttl?`），只是必须同时带整份 `data`。本次另开 **`PUT /api/presets/:id/layout-policy`** `{ layoutPolicy: PresetLayoutPolicy | null, author?: 'user'|'ai' }`：只写这一列（`{}` 与 null 等价，都存 null），返回整行，写一版版本（预设版本数据里布局策略在保留键 `__layoutPolicy`）；未知键 / 非法枚举 400，预设不存在 404。组装仍不读这一列。
9. **真机（2026-09-22）**：Z.AI `glm-5.3-flash` 两端点都回 1113 余额不足；`glm-4.5-flash` 当时约七成请求回 1305 过载（直连探测同样如此），没能跑完一轮；改用同样免费的 **`glm-4.7-flash`**（OpenAI 兼容端点，原生工具调用）跑通：有 id 与无 id 两条路径各一次「一句话生成整卡」（8–9 次 `set_field`，无 id 那次含 5 条 `/character_book`，途中一次 `alternate_greetings` 类型错误经工具报错后模型自行改正）→ 应用 patch 后 `PUT /api/characters/:id`（author=ai）/ `POST /api/characters`（内嵌书抽成独立世界书）→ `GET /api/studio/test-chat` + generate 正常回复。
