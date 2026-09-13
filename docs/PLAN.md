# 「新酒馆」(NewTavern) 项目计划

| 项目 | 内容                                                                   |
| ---- | ---------------------------------------------------------------------- |
| 状态 | M0、M1 已完成；M2 已实现并集成（2026-09-13），进度见 §四末「进度记录」 |
| 版本 | v0.2（2026-09-13）                                                     |
| 语言 | 中文为主，UI 与内置提示词中英双语                                      |

---

## 一、背景与目标

**问题**：SillyTavern（下称 ST，2026-05 最新 1.18.0）仍是 Node + jQuery 的老架构，十年式的设置面板、功能堆叠冗杂、视觉陈旧；对新一代 API 特性（OpenAI Responses 推理项与缓存断点、Anthropic 缓存断点与中途 system 消息、Gemini 隐式/显式缓存与原生生图）支持零散；前端卡、变量系统等依赖第三方扩展（酒馆助手）打补丁；制卡/制预设与「用 AI 来做」完全割裂。

**目标**：从零构建一个 AI 创意角色扮演 / 写作前端「新酒馆」，做到：

1. 最美的视觉与交互（设计系统、主题、移动端、流式渲染）。
2. 最全面的多协议 API 支持：OpenAI Chat Completions 兼容、OpenAI Responses（推理）、Anthropic Messages、Google Gemini；模型能力自动探测。
3. 原生多模态：图片/文档输入，生图输出直接显示；「前端卡」充分利用模型的编码能力。
4. 四种玩法：角色扮演、长篇写作共创、CRPG（分支选项、存档）、多智能体开放世界。
5. 兼容既有范式：ST 角色卡 V2/V3（PNG / CHARX / JSON）、ST 预设、世界书、正则、聊天记录；酒馆助手核心 API 与 MVU 变量。
6. 「创作工作台」：把角色卡 / 预设 / 世界书的制作与 AI 辅助编辑合并为同一工具。
7. 个性化系统提示词与全局管理；用户请求与预设、世界书有机结合。
8. **缓存感知的提示词布局**：充分利用各家前缀缓存降低成本，同时提供严格保真模式，保证预设有效性不打折。
9. 中英双语 UI 与内置提示词。

**已确定的决策**

| 决策         | 结论                                                                                                                                    |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| 产品形态     | Web 应用 + 本地轻量服务端（ST 同款部署，手机局域网可访问，Key 留服务端；后期 Tauri 封装）                                               |
| 技术栈       | TypeScript 全栈：React 19 + Vite + Tailwind v4 + shadcn/ui + Zustand + TanStack Query；Node 22 + Hono + SQLite (Drizzle)；pnpm monorepo |
| 酒馆助手兼容 | 前端卡兼容优先：iframe 沙箱 + 核心 API 子集 + MVU，其余按需补齐                                                                         |
| MVP          | 核心对话 + 多协议 API + 卡/预设/世界书导入 + 缓存感知组装 + 基础美观 UI + 中英文                                                        |

**其他假设**：单用户、本地优先（多用户档案留到后期，但数据目录结构预留）；局域网访问可选密码；仓库以 `Mar7thLover` 身份提交；包命名空间 `@newtavern/*`；Node 22 LTS。

---

## 二、总体架构

### 2.1 仓库结构（pnpm monorepo）

```
NewTavern/
├─ apps/
│  ├─ web/            # React 19 SPA（Vite）。聊天、库、工作台、设置、前端卡宿主
│  └─ server/         # Hono 服务端。REST + SSE、SQLite、文件资产、API 转发、密钥保管
├─ packages/
│  ├─ core/           # 纯 TS，无 DOM/Node 依赖：zod 领域模型、提示词 IR、组装流水线、世界书引擎、宏、正则、变量事务、消息树操作、分词抽象
│  ├─ providers/      # 提供商适配器：openai-chat / openai-responses / anthropic / google / image-*；catalog.json 能力注册表；流式事件归一化
│  ├─ compat/         # ST 与酒馆助手兼容：PNG/CHARX 卡读写、预设/世界书/正则/聊天导入导出、MVU 指令解析、slash 子集
│  ├─ sandbox-sdk/    # 前端卡 RPC 协议类型、宿主端、iframe 端引导脚本（原生 API + 酒馆助手 shim）、前端卡 d.ts；独立构建成单文件
│  ├─ i18n/           # zh-CN / en 词典与内置提示词双语资源（web、server、core 共用）
│  └─ config/         # 共享 tsconfig / eslint / prettier
├─ tools/fixtures/    # ST 黄金样本：卡 + 预设 + 世界书 + 聊天 + ST 1.18 实际发出的请求快照
├─ docs/              # 架构、兼容矩阵、提示词布局说明、贡献指南（双语）
├─ scripts/           # 开发/构建/发布脚本
└─ package.json, pnpm-workspace.yaml, tsconfig.base.json, .github/workflows/ci.yml
```

设计系统组件首期放在 `apps/web/src/components/ui`（只有一个消费者，避免过早抽象）；Tauri 版复用同一 web 包，待第二个消费者出现再抽成 `packages/ui`。

### 2.2 运行时拓扑

- `apps/server` 单进程：静态托管 `apps/web` 构建产物 + `/api/*`；生成走 SSE；所有第三方 API 请求由服务端发出（支持 HTTP 代理、Key 轮换、自定义 Header、OpenAI 兼容中转站）。
- 数据目录 `data/<user>/`（首期只有 `default`，目录结构预留多用户）：`tavern.sqlite`（WAL）、`characters/`（原始 PNG/CHARX 字节保留，未修改则导出原件）、`assets/`（内容寻址，图片、生图结果、卡内资源）、`backups/`。DB 是唯一真源，文件系统只存二进制与原始导入件。
- `packages/core` 同时在浏览器与 Node 运行：前端用于「提示词检查器」实时预览与工作台，服务端用于真正发请求前的最终组装（唯一权威）。

### 2.3 核心数据流

```
用户输入 ─► 组装流水线(core) ─► PromptIR ─► 适配器渲染(providers) ─► 提供商
                                 │                                    │
                          提示词检查器(预览/diff)             归一化流式事件(SSE)
                                                                      ▼
                                              消息树写入(server) ─► UI 流式渲染 ─► 正则(显示) ─► 前端卡沙箱 / MVU
```

---

## 三、核心设计

### 3.1 提供商适配层 `packages/providers`

**统一接口（草图）**

```ts
interface ProviderAdapter {
  id: 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';
  listModels(conn: Connection): Promise<ModelInfo[]>;
  capabilities(model: string, conn: Connection): ModelCapabilities; // catalog.json + 远端探测 + 用户覆盖 + 端点 quirks 合并
  buildRequest(ir: PromptIR, conn: Connection, model: string): ProviderRequest; // 纯函数：web 端可预览、可做黄金测试
  stream(conn: Connection, req: ProviderRequest, signal: AbortSignal): AsyncIterable<GenEvent>;
  countTokens?(conn: Connection, req: ProviderRequest): Promise<number>;
  normalizeError(e: unknown): ProviderError; // auth | rateLimit | overloaded | contextLength | filter | invalid | network
}
interface ModelCapabilities {
  thinking: 'none' | 'budget' | 'effort' | 'level' | 'adaptive'; // Haiku budget / OpenAI effort / Gemini level / Anthropic adaptive
  effortLevels?: string[];
  caching: 'none' | 'prefix-auto' | 'breakpoints' | 'explicit-object';
  cacheMinTokens?: number;
  maxBreakpoints?: number;
  systemInMessages: boolean;
  reasoningRoundtrip: 'none' | 'signature' | 'encrypted' | 'thoughtSignature';
  imageIn: boolean;
  imageOut: boolean;
  documentIn: boolean;
  tools: boolean;
  structuredOutput: boolean;
  prefill: boolean;
  maxContext: number;
  maxOutput: number;
}
type GenEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'reasoning.delta'; text: string }
  | { type: 'reasoning.opaque'; provider: string; model: string; payload: unknown } // 需原样回传的块
  | { type: 'image'; mime: string; data: string }
  | { type: 'tool.call'; id: string; name: string; argsDelta: string }
  | {
      type: 'usage';
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
    }
  | {
      type: 'stop';
      reason: 'end' | 'length' | 'refusal' | 'filter' | 'tool' | 'abort';
      detail?: string;
    }
  | { type: 'error'; error: ProviderError; retryable: boolean };
```

**OpenAI 兼容端点的 quirks**：按 Base URL 与 `/models` 返回自动识别（DeepSeek、Ollama、LM Studio、vLLM、常见中转站），`quirks` 记录：是否有 `developer` 角色、是否返回 `reasoning_content`、是否支持 prefill、是否支持 `stream_options.include_usage`、是否支持 `reasoning_effort`；用户可手动覆盖。

**各家映射要点**

| 提供商             | system                                              | 推理                                                                                                                           | 缓存                                                                                                                                                                         | 多模态                                                                | 备注                                                                                                                                                                                                                                          |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic Messages | `system[]` 文本块，末块挂 `cache_control`           | `thinking:{type:'adaptive'}` + `output_config.effort`；Haiku 4.5 等旧模型 `budget_tokens`；thinking 块含签名需原样回传         | `cache_control` 断点 ≤4，`ttl: '1h'` 可选；顶层自动断点；Opus 5/Fable 系列支持 messages 内 `role:'system'` 中途指令不破坏前缀                                                | image / document(PDF) 输入；无生图                                    | 连续同角色合并、末尾必须 user；4.6+ 无 prefill：预设里的 assistant 尾段自动转为 depth-0 指令（新模型 `role:system`，旧模型 user 包裹）并在检查器告警；`stop_reason: 'refusal'` 归一化；529/429 退避；Fable 5.1 编辑历史会使后续 thinking 失效 |
| OpenAI Responses   | static 层 → `instructions`，其余 → `input[]`        | `reasoning:{effort,summary}`；默认 `store:false` + `include:['reasoning.encrypted_content']`，加密推理项存节点回传（分支友好） | 自动前缀缓存 + `prompt_cache_key`(=chatId)；GPT-5.6+ `prompt_cache_options`/`prompt_cache_breakpoint` 映射 cachePlan；GPT-6 用 `configuration_update` 输入项改 effort 保前缀 | `input_image`/`input_file`；`image_generation` 工具事件归一为 `image` | `text.format` 结构化输出；也支持 `previous_response_id` 有状态模式（可选）                                                                                                                                                                    |
| OpenAI Chat 兼容   | 多条 `system` 消息保序                              | `reasoning_effort`（若支持）；第三方常见 `reasoning_content` 字段                                                              | 自动前缀缓存 ≥1024 token；`usage.prompt_tokens_details.cached_tokens`                                                                                                        | `image_url`                                                           | `stream_options.include_usage`；quirks 见上                                                                                                                                                                                                   |
| Google Gemini      | `systemInstruction` + `contents`（user/model 合并） | `thinkingConfig.thinkingLevel`（3+）/ `thinkingBudget`（2.5）+ `includeThoughts`；`thoughtSignature` 回传                      | 隐式缓存默认开（最小 2048–4096 token，稳定内容放前）；显式 `cachedContents` 可选用于 static 层（hash 变化即失效重建，UI 提示存储费）                                         | `inlineData`/Files；`responseModalities:['TEXT','IMAGE']` 原生生图    | 图像模型不支持 thinking_level；safety 默认 `BLOCK_NONE`；`promptFeedback.blockReason` → `filter`；`usageMetadata.cachedContentTokenCount`                                                                                                     |

**推理内容持久化**：助手消息保存 `reasoning: { visible?: string; opaque?: { provider, model, payload }[] }`。下一轮若 provider+model 相同则回传 opaque；否则丢弃（并在检查器提示会失去缓存/推理连续性）。用户编辑历史消息时，清除该点之后所有 opaque 块。

**连接配置**：provider 类型、Base URL、多 Key（轮换/故障转移）、自定义 Header、代理、模型列表缓存、每模型覆盖（能力、上下文、价格）。密钥用本地主密钥加密存储。

### 3.2 提示词组装流水线与缓存感知布局 `packages/core`

**阶段**

1. **Collect**：预设（prompts + prompt_order + 采样参数）、角色卡字段与内嵌世界书、用户 Persona、全局系统提示词覆盖层、聊天/全局世界书、作者注释、聊天历史、变量、正则脚本、前端卡 injects。
2. **Normalize**：CCv3 装饰器（`@@depth @@position @@role @@activate_only_after @@activate_only_every @@keep_activate_after_match @@dont_activate_after_match @@scan_depth @@additional_keys @@exclude_keys @@is_greeting @@ignore_on_max_context` 等）覆写为与 ST 字段统一的 `WIEntry` 模型，一套引擎处理；卡内 `character_book` 视为临时世界书。
3. **History**：消息树 root→head 路径线性化 → 应用提示词侧正则（含 min/max depth）→ 剔除隐藏消息。
4. **Macros**：`{{char}} {{user}} {{persona}} {{description}} {{scenario}} {{personality}} {{mesExamples}} {{lastMessage}} {{getvar}} {{setvar}} {{random}} {{pick}} {{roll}} {{time}} {{date}} {{idle_duration}} {{trim}} {{noop}}` 等；带 seed 的 RNG，`{{pick}}` 会话稳定；`{{setvar}}` 副作用进变量事务；标记**易变宏**（time/date/random/roll/lastMessage）所在段为 `volatile`。
5. **World Info Scan**：按 ST 算法移植——扫描缓冲（最近 scan_depth 条 + 可选 persona/描述）、主键/副键/selective_logic 0–3、正则键、constant、probability、inclusion group 与 use_group_scoring、sticky/cooldown/delay（时间态**按消息节点快照**，swipe/重生时从父节点起算）、递归（含 exclude/prevent/delay_until_recursion）直至收敛或预算满、token_budget。输出：激活条目 + position(0–6)/depth/role/order 分桶。
6. **Regex**：ST 正则脚本按作用域（用户输入 / AI 输出 / 世界书 / 斜杠）与方向（仅提示词 / 仅显示）应用；显示侧在渲染层处理。
7. **Placement（Build IR）**：按 prompt_order 展开占位符（`main nsfw jailbreak chatHistory worldInfoBefore worldInfoAfter charDescription charPersonality scenario personaDescription dialogueExamples enhanceDefinitions` + 自定义 prompt 的 role/injection_position/injection_depth/injection_order）；`chatHistory` 展开为历史 + 深度注入（作者注释@depth、世界书 pos4、`injection_position=1` 的 prompt、前端卡 injects）按 depth/order/role 合并；世界书 position 映射（0 角色定义前、1 角色定义后、2/3 作者注释上下、4 @depth、5/6 示例对话前后包裹 `dialogueExamples`）；卡的 `system_prompt`/`post_history_instructions` 覆盖 main/jailbreak 遵循 ST 开关；每段记录 ST 原始锚点 `anchor`。
8. **Layout（缓存感知）**：见下。
9. **Render / Inspect**：适配器 `buildRequest` 把 IR 转为原生请求；处理同角色合并、末尾必须为 user、图片块、工具定义、断点标记；检查器展示与 diff。

**IR 草图**

```ts
interface PromptIR {
  model: string;
  sampling: SamplingParams;
  tools?: ToolDef[];
  segments: Segment[]; // 最终顺序
  cachePlan: { breakpoints: number[]; ttl?: '5m' | '1h' }; // 指向 segments 下标
  meta: {
    chatId: string;
    presetId: string;
    layoutMode: 'strict' | 'cache-aware';
    activations: WIActivation[];
    warnings: string[];
    tokenEstimate: number;
  };
}
interface Segment {
  id: string; // 来源 + uid 的稳定 id，用于 diff
  role: 'system' | 'user' | 'assistant';
  parts: Part[]; // text | image | document | reasoning_opaque
  origin: {
    kind:
      | 'preset'
      | 'character'
      | 'persona'
      | 'worldinfo'
      | 'authors_note'
      | 'history'
      | 'injection'
      | 'user_input'
      | 'variables'
      | 'global_system';
    ref?: string;
  };
  anchor: { slot: 'system' | 'history'; depth?: number; order: number }; // ST 原始位置，strict 模式与 diff 的依据
  stability: 'static' | 'session' | 'turn' | 'history';
  volatile?: boolean; // 含易变宏
  locked?: boolean; // 保真锁：禁止布局器移动
}
```

**布局器不变量**：只做**跨层移动，不改层内相对顺序**，且以 segment 为粒度（不做 token 级或 LLM 摘要等有损策略）。这样缓存优化带来的语义偏差是有界的、可枚举的、可预览的。

**稳定性分层**

| 层      | 内容                                                                     | 变化频率     |
| ------- | ------------------------------------------------------------------------ | ------------ |
| static  | 预设文本、角色卡字段、Persona、constant 世界书、全局系统提示词、工具定义 | 编辑时才变   |
| session | 聊天绑定世界书的 constant 条目、作者注释、sticky 条目                    | 会话内偶尔变 |
| history | 聊天历史（追加式）                                                       | 每轮追加     |
| turn    | 触发式世界书、@depth 注入、变量快照、易变宏、本轮用户输入                | 每轮变       |

**布局模式**

- **strict（严格保真）**：完全按 ST 顺序输出，不移动任何段；断点只放在天然稳定边界（static 末尾、最后一条未受注入影响的历史消息）。导入的 ST 预设**默认使用 strict**，保证行为与 ST 一致。
- **cache-aware（缓存优先，原生预设默认）**，设尾部窗口 k（默认 4 条）：
  - 触发式世界书若原本落在 static 区（position 0/1/5/6），移入「易变块」，以 depth=k 插到历史尾部：Anthropic Opus 5/Fable 系列用 `role:'system'` 消息；OpenAI 用 `developer`；其他用 user 包裹 `[World Info]`（可配置）。
  - depth ≤ k 的注入保持原位（本来就只影响尾部）；depth > k 的注入夹紧到 k（可逐条 `locked` 回原位）。
  - 易变宏只允许出现在 turn 层；出现在 static 文本时按会话冻结或告警。
  - 断点策略：Anthropic 显式 BP1=static 末尾（可选 1h TTL），BP2=session 末尾（每轮滑动），tools 单独占一个，顶层自动断点覆盖历史尾部；OpenAI 用 `prompt_cache_key=chatId`，GPT-5.6+ 在 static 末尾放 `prompt_cache_breakpoint`；Gemini 保证 static 在最前，超过阈值时可选建 `cachedContents`（static hash 变化即失效重建）。
  - 历史追加式；编辑早期消息、切换模型/工具集、改 thinking/effort 都在检查器中标出「将导致缓存失效」。
- **逐段覆盖**：预设或世界书条目可设 `locked`，强制留在原位；预设级策略可整体锁定。

**保真度保障**

- 提示词检查器：展示每个提供商的最终请求、按段着色来源/层级/token/断点、strict 与 cache-aware 的 segment 级 diff（标注「被移动 / 被夹紧」）、预计缓存命中比例、上一轮实际 `cacheRead/cacheWrite`；附「粘贴 ST 请求 JSON 比对」工具。
- 黄金测试：`tools/fixtures` 用真实 ST 预设 + 世界书 + 聊天样本，strict 模式输出与 ST 1.18 实际发出的请求快照逐字节比对（含 squash system、示例 `<START>` 切分、同 order 按 uid 排序等细节）。
- 集成测试（需 Key，可选）：同一聊天连发两轮，断言第二轮 `cacheRead > 0`；20 轮会话 cache-aware 命中率 ≥ 70%。

### 3.3 数据模型与存储 `apps/server/src/db/schema.ts`

SQLite + Drizzle，灵活字段用 JSON 列，可查询字段拉平。

| 表                                                     | 关键字段                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| characters                                             | id, name, spec ('v2'/'v3'), data JSON（完整 CCv3 data，未知字段原样保留）, book_id, avatar_asset_id, source_path, original_hash, tags[], created_at, updated_at                                                                                                                                                                 |
| assets                                                 | id, kind (avatar/background/emotion/generated/upload/card_embedded), mime, path, sha256（内容寻址去重）, width, height, source, meta JSON                                                                                                                                                                                       |
| presets                                                | id, name, format ('st-openai'/'native'), api_family, data JSON, sampling JSON, layout_policy JSON                                                                                                                                                                                                                               |
| lorebooks / lorebook_entries                           | 书：id, name, scope (global/char/chat), settings JSON；条目按 ST 字段逐列（keys[], secondary_keys[], content, constant, selective, selective_logic, position, depth, order, probability, group, sticky, cooldown, delay, role, use_regex, case_sensitive, match_whole_words）+ decorators JSON + extra JSON 兜底                |
| personas                                               | id, name, description, avatar_asset_id, position                                                                                                                                                                                                                                                                                |
| chats                                                  | id, title, mode ('roleplay'/'writing'/'crpg'), character_ids[], persona_id, preset_id, overrides JSON, root_node_id, head_node_id, metadata JSON；世界书绑定用 chat_lorebooks 关联表                                                                                                                                            |
| message_nodes                                          | id, chat_id, parent_id, sibling_seq, role, name, parts JSON, reasoning JSON (text/provider/model/opaque), variables JSON（消息级变量快照）, wi_state JSON（sticky/cooldown/delay 快照）, usage JSON, provider, model, is_hidden, extra JSON, created_at —— **树结构**：无后代的兄弟即 swipe，有后代即分支；切换 head 即切换分支 |
| variables / variable_events                            | scope ('global'/'character'/'chat'/'script'), owner_id, key, value JSON；事务日志                                                                                                                                                                                                                                               |
| connections / model_cache                              | id, provider, label, base_url, keys_enc, headers JSON, proxy, quirks JSON, model_overrides JSON；模型列表缓存                                                                                                                                                                                                                   |
| generation_log                                         | id, node_id, provider, model, usage (input/output/cacheRead/cacheWrite/reasoning), cost, latency, layout_mode                                                                                                                                                                                                                   |
| regex_scripts                                          | id, scope ('global'/'character'), find, replace, flags, placement[], direction, order                                                                                                                                                                                                                                           |
| entity_versions                                        | entity_type, entity_id, version, data JSON, author ('user'/'ai')——预设/角色/世界书的版本历史，支撑工作台 AI 编辑撤销                                                                                                                                                                                                            |
| settings / prompt_library                              | KV；可复用提示片段                                                                                                                                                                                                                                                                                                              |
| jobs                                                   | id, kind (image_gen/summary/import), status, payload JSON, result JSON                                                                                                                                                                                                                                                          |
| writing_projects / documents / document_versions（M7） | 项目、章节、版本快照、大纲、圣经                                                                                                                                                                                                                                                                                                |
| game_states（M8）                                      | chat_id, node_id, state JSON（存档 = 节点指针 + 状态快照）                                                                                                                                                                                                                                                                      |

全文检索用 SQLite FTS5（角色、世界书条目、消息）。

**导入导出**（`packages/compat`）：角色卡 ↔ PNG（读取优先 `ccv3` 再 `chara`，写回同时写两者）/ CHARX / JSON，未修改的卡直接导出原始字节；预设 ↔ ST JSON；世界书 ↔ ST JSON；聊天 ↔ ST jsonl（导入时 swipes 变兄弟节点，导出取 root→head 路径、无后代兄弟回填 `swipes[]`，其余分支不可导出，UI 明示）；一键从 ST `data/<user>` 目录整体迁移向导。往返原则：未知字段原样保留、保留 ST 原生 id（uid/identifier）、import→export deep-equal 测试。

### 3.4 兼容层 `packages/compat`

| 模块      | 内容                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| card      | PNG tEXt 读写（`chara` base64 V2、`ccv3`、`chara-ext-asset_:` 资源 chunk）、CHARX zip（`card.json` + `assets/`、`embeded://`）、V1→V2→V3 升级、`extensions` 保留（含 `regex_scripts`、`depth_prompt`、`world`、酒馆助手脚本） |
| preset    | ST OpenAI 预设解析、identifier 映射、未知 prompt 保留、采样参数映射到各家                                                                                                                                                     |
| worldinfo | ST 激活算法移植 + CCv3 装饰器；黄金测试                                                                                                                                                                                       |
| regex     | 脚本模型、placement/direction、`formatAsTavernRegexedString` 语义                                                                                                                                                             |
| macros    | 宏引擎（与 ST 行为对齐）                                                                                                                                                                                                      |
| chat      | ST jsonl 导入导出                                                                                                                                                                                                             |
| mvu       | `<UpdateVariable>` / `_.set(path, old, new)` 等指令解析、`[InitVar]` 初始化、`stat_data/display_data/delta_data` 生成                                                                                                         |

### 3.5 前端卡沙箱与酒馆助手桥 `packages/sandbox-sdk` + `apps/web/src/features/cards`

- **渲染**：消息渲染器识别 ```html 围栏或 `<script>/<body>` 启发式 → `<FrontendCardFrame>`；角色脚本用同机制在隐藏 iframe 运行。srcdoc 包装 = CSP meta + 引导脚本 + 本地打包的 jQuery/Lodash/toastr/zod/YAML + 主题 CSS 变量 + 卡 HTML。含 iframe 的消息不参与虚拟滚动高度缓存；高度用 ResizeObserver → postMessage 自适应（防抖，用户滚动中冻结）。
- **信任级别**（按角色卡设置，默认 standard）：`strict`（无外链脚本）/ `standard`（`sandbox="allow-scripts allow-forms allow-modals allow-popups"`，opaque origin，允许 https script/style/img/font，connect-src 仅本站代理）/ `trusted`（connect-src *）/ `legacy-unsafe`（加 `allow-same-origin`，强警告，纯为依赖 `window.parent`/`localStorage` 的老卡兜底）。opaque origin 下 `localStorage` 抛异常、`crypto.subtle` 受限，引导脚本提供内存 polyfill。
- **RPC 协议**：`postMessage` + 请求 id + 结构化克隆；宿主校验 `event.source === frame.contentWindow` 与 srcdoc 内注入的一次性 nonce（origin 为 null 不可信）；每帧绑定 message_id 与能力集；`generate` 流式以事件推送。
- **状态镜像解决同步 API**：酒馆助手部分 API（如 `getChatMessages`、`getVariables`、`getCharData`、`substitudeMacros`）为同步返回。宿主在每次相关状态变化时把快照（可见消息、变量、角色数据、宏上下文）推入 iframe，同步 getter 读镜像；写操作与 `generate/generateRaw/eventEmit/triggerSlash` 走异步 RPC。
- **API 分层**：原生 API（`window.newtavern.*`，Promise 化、类型化） → 酒馆助手 shim（全局函数 `getChatMessages/setChatMessages/createChatMessages/deleteChatMessages/getVariables/replaceVariables/insertOrAssignVariables/updateVariablesWith/generate/generateRaw/eventOn/eventOnce/eventEmit/eventEmitAndWait/eventRemoveListener/eventMakeFirst/eventMakeLast/tavern_events/iframe_events/getLorebookEntries/setLorebookEntries/createLorebookEntries/deleteLorebookEntries/getCharData/getCurrentMessageId/getLastMessageId/substitudeMacros/formatAsTavernRegexedString/triggerSlash/getButtonEvent` 等）。`generate` 的 `config`（`user_input image should_stream overrides injects max_chat_history ordered_prompts preset_name should_silence tools tool_choice json_schema`）映射到组装流水线的覆盖入口。
- **事件**：宿主事件总线 → `tavern_events` 名称映射表（MESSAGE_RECEIVED/MESSAGE_UPDATED/GENERATION_STARTED/GENERATION_ENDED/STREAM_TOKEN_RECEIVED_* 等），未实现的事件在兼容矩阵文档中列出。
- **MVU**：内置引擎（可切换为运行原版 MVU 脚本）——`MESSAGE_RECEIVED` → 解析 `<UpdateVariable>` 内 `_.set/_.insert/_.delete` → `VariableTransaction.begin(父节点快照)` → 应用并计算 `delta_data/display_data` → 可选按 `[InitVar]` 校验 → commit 写入节点 `variables` → 广播原生 `variables:updated` 与兼容事件 `mag_variable_updated/mag_variable_update_ended`；重生/swipe 自动从父快照起算，提供 `replayFrom(nodeId)`；前端卡通过镜像即时刷新。
- **脚本库**：全局脚本 / 角色绑定脚本（存于 `extensions.TavernHelper_scripts` 保持互通）在隐藏 iframe 中运行。

### 3.6 多模态与生图

- 输入：编辑器粘贴/拖放图片与 PDF → assets → IR `image/document` part → 各家原生块。
- 输出：Gemini 图像模型（`responseModalities`）直接返回图片；OpenAI `gpt-image-*`（Images API 或 Responses `image_generation` 工具）；外接生图后端：Stable Diffusion WebUI / ComfyUI / NovelAI / 任意 OpenAI 兼容 `images` 端点。生图结果是消息的一等 part，也可由前端卡调用 `generateImage()`。
- 展示：灯箱、按聊天的画廊、CCv3 `emotion` 资源驱动的立绘/表情（视觉小说模式）、背景资源。

### 3.7 创作工作台 `apps/web/src/features/studio`

- 同一工作区三个页签共用「测试对话」面板与「提示词检查器」：角色卡（全部 CCv3 字段 + 资源 + 内嵌世界书 + 多语言创作者笔记）、预设（拖拽排序、role/position/depth、采样、布局策略、保真锁）、世界书（表格 + 装饰器编辑 + 触发模拟）。
- **AI 协作者**：使用用户配置的任一连接，具备工具 `get_field / set_field / add_entry / update_entry / run_test_turn / inspect_prompt / search_reference`；每次修改生成可审阅 diff，支持撤销与版本历史；内置双语提示词模板（`packages/i18n/prompts/studio.{zh-CN,en}.md`）；可从一句话生成整卡、从对话样本反推设定、按目标模型优化预设措辞。
- 导出为 ST 格式无损；发布用元数据（封面、简介、多语言）。

### 3.8 长篇写作共创（M7）

- 项目 = 章节文档 + 设定圣经（复用世界书）+ 风格指南 + 大纲；编辑器 TipTap（ProseMirror）；AI 动作：续写、重写选区、扩写、压缩、章节摘要（自动生成用于后续上下文）；上下文构建复用组装流水线（圣经在 static 层→可缓存）；版本历史与对比。

### 3.9 CRPG / 多智能体 / 分支（M8）

- 游戏状态 JSON（队伍、属性、物品、位置、任务、flag），规则以工具形式暴露给叙述模型（掷骰、检定、库存变更）；选项用结构化输出返回并渲染为按钮；分支基于消息树；存档 = 节点指针 + 状态快照。
- 多智能体：Director（世界/状态）、Narrator（文本）、NPC agents（各自角色卡与记忆）、Rules；`packages/core/orchestrator` 的回合调度器；共享字节一致的前缀以命中缓存（先发一个请求等首 token 再并发其余）。
- 开放世界：地点图存于世界书，NPC 按地点激活。

### 3.10 设计系统与 UI `apps/web/src/components/ui`

- Tailwind v4 OKLCH 设计 token；明暗主题 + 用户主题导入导出；CJK 排版（思源黑体/宋体、霞鹜文楷可选）；Framer Motion 动效；三栏布局（库 / 对话 / 检查器）移动端折叠；虚拟化消息列表；Markdown、引号高亮、代码、图片、前端卡统一渲染；流式打字与推理折叠区；命令面板（Ctrl+K）。
- 页面：对话、角色库、预设库、世界书库、工作台、写作、连接与模型、设置、迁移向导。

### 3.11 国际化

- `i18next` + `react-i18next`，`zh-CN`、`en` 一等公民；内置系统提示词、工作台提示词、错误信息全部双语；CCv3 `creator_notes_multilingual` 按 UI 语言展示。

### 3.12 全局管理与个性化系统提示词

- 连接档案与「按模式默认模型」；**全局系统提示词覆盖层**：用户的长期偏好指令（写作风格、禁忌、语言）作为 static 层的一段，可选放在预设 main 之前/之后，按角色可覆盖，且计入缓存前缀；备份/恢复；ST 目录一键迁移。

---

## 四、里程碑与验收

| 里程碑                             | 内容                                                                                                                                                                   | 验收标准                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **M0 基建**（约 1 周）             | `git init`（Mar7thLover 身份）、monorepo、tsconfig/eslint/prettier/vitest、Hono 骨架并托管前端、Drizzle 迁移、设计 token、i18n 脚手架、CI                              | `pnpm dev` 局域网可访问；CI 通过；空壳页面双语切换                                                                 |
| **M1 导入与数据**（约 2 周）       | 卡（PNG/CHARX/JSON）/世界书/预设/Persona/正则/聊天 jsonl 导入导出、ST 目录迁移向导、角色库/预设库/世界书库 UI                                                          | 往返 deep-equal 测试全绿；20 张真实卡导入无损                                                                      |
| **M2 提供商与对话**（约 2 周）     | 4 类适配器 + 连接管理 + 模型列表 + catalog；最小组装（预设顺序 + 卡字段 + 历史）；对话 UI（流式、取消、swipe/分支树、编辑、重生成、推理折叠）；用量与缓存统计；Persona | 4 家流式可用；`cacheRead` 有数；推理块正确回传；手机浏览器可用                                                     |
| **M3 组装流水线与缓存**（约 3 周） | 宏/正则/世界书引擎/prompt_order/作者注释/全局系统提示词；strict + cache-aware 布局；检查器与 diff；黄金测试；基础美化                                                  | 30 组 fixture strict 与 ST 逐字节一致；20 轮会话 cache-aware 命中率 ≥ 70%；导入 10 张主流卡 + 5 个主流预设正常对话 |
| **MVP = M0–M3**                    |                                                                                                                                                                        |                                                                                                                    |
| **M4 视觉与多模态**（2–3 周）      | 图片/PDF 输入；Gemini/OpenAI 生图 + SD/ComfyUI/NovelAI；画廊、立绘表情、背景；主题系统打磨、命令面板                                                                   | 图文混排消息、生图直接显示、主题导入导出                                                                           |
| **M5 前端卡与酒馆助手**（约 3 周） | 沙箱与信任级别、RPC、状态镜像、酒馆助手 shim、事件映射、MVU 引擎、变量面板、脚本库                                                                                     | 社区 Top 20 前端卡中 ≥ 15 张开箱可用；5 张流行 MVU 卡零修改可用                                                    |
| **M6 创作工作台**（约 3 周）       | 三页签工作台、测试对话、AI 协作者与工具、diff/撤销/版本历史、提示库、导出                                                                                              | 一句话生成整卡并可直接对话；AI 编辑后导出 PNG 在 ST 中可导入                                                       |
| **M7 长篇写作**（约 3 周）         | 项目/章节/圣经/大纲、TipTap、AI 动作、摘要、版本                                                                                                                       | 完成 5 章连贯写作，圣经缓存命中                                                                                    |
| **M8 CRPG 与多智能体**（4 周+）    | 状态/规则工具/选项/存档、调度器、多 agent、开放世界                                                                                                                    | 一个示例战役可分支、存读档、多 NPC 各自发言                                                                        |
| **M9 打包与生态**                  | Tauri 桌面版、插件 API、文档站、发布流程                                                                                                                               | 安装包可用；第三方扩展示例                                                                                         |

---

### 进度记录

| 日期       | 里程碑 | 完成                                                                                                                                                                                                                                                                                                                                                                         | 未完成 / 延后                                                                                                                                                                                          |
| ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-12 | M0     | 全部                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                                                                                                                      |
| 2026-09-13 | M1     | 卡/预设/世界书/Persona 导入导出与库页面；正则、聊天 jsonl 的 compat 解析；本机 ST 真实样本往返验收（`NT_ST_DATA_DIR` 可选测试：8 张卡、14 个预设、7 本世界书、12 个聊天全部无损）                                                                                                                                                                                            | ST 目录迁移向导；正则/聊天 jsonl 的导入路由；卡内嵌世界书抽到 lorebooks 表                                                                                                                             |
| 2026-09-13 | M2     | 4 类适配器（openai-chat / openai-responses / anthropic / google）+ SSE 解析 + 错误归一化 + 能力目录 v2（42 条）；连接管理（AES-GCM 加密多 Key、轮换、模型列表缓存、测试）；最小组装 `assemblePrompt`（ST prompt_order / 深度注入 / 覆盖 / squash / 宏子集）；消息树（swipe = 兄弟、分支 = 有后代）；生成 SSE；对话页与连接页；用量与缓存统计；接口契约 `docs/M2-CONTRACT.md` | 真机验证只覆盖 Z.AI 的 OpenAI 兼容与 Anthropic 兼容端点（GLM 5.3 Flash），Google 与 OpenAI Responses 只有契约回放测试；`Segment.name` 在同角色合并时未使用（群聊 M3+）；消息列表虚拟化与代码分割（M4） |

## 五、MVP（M0–M3）关键文件清单

```
apps/server/src/index.ts                       # Hono app、静态托管、SSE、hc 类型化客户端导出
apps/server/src/routes/{connections,models,characters,presets,lorebooks,personas,chats,nodes,generate,import,settings}.ts
apps/server/src/db/{schema.ts,migrate.ts,client.ts}
apps/server/src/services/{generation.ts,secrets.ts,assets.ts,importer.ts}
apps/web/src/{main.tsx,app/router.tsx,app/store/*.ts}
apps/web/src/components/ui/*                    # shadcn 组件与设计 token（tokens.css、theme.ts）
apps/web/src/features/chat/{ChatView,MessageList,MessageItem,Composer,ReasoningPanel,BranchBar}.tsx
apps/web/src/features/inspector/PromptInspector.tsx
apps/web/src/features/library/{Characters,Presets,Lorebooks,Personas}.tsx
apps/web/src/features/settings/{Connections,Models,General,Migration}.tsx
packages/core/src/prompt/{ir.ts,assembler.ts}
packages/core/src/prompt/layout/{strict.ts,cacheAware.ts}
packages/core/src/{macros/engine.ts,regex/engine.ts,worldinfo/engine.ts,variables/transaction.ts,tree/path.ts,tokenizer.ts}
packages/providers/src/{types.ts,catalog.json,registry.ts,openai-chat.ts,openai-responses.ts,anthropic.ts,google.ts,sse.ts}
packages/compat/src/st/{png-text.ts,charx.ts,card-upgrade.ts,preset.ts,worldbook.ts,regex.ts,chat-jsonl.ts,migrate-dir.ts}
packages/i18n/src/{zh-CN.json,en.json,prompts/*}
tools/fixtures/{cards,presets,worldbooks,chats,st-requests}/*
```

---

## 六、验证方式

- **单元/黄金测试**（vitest）：卡片 PNG/CHARX 往返；预设/世界书解析；世界书激活算法对照 ST 样本；strict 布局逐字节对照 ST 请求快照；宏与正则。
- **适配器契约测试**：用录制的各家流式响应回放，断言归一化事件序列与用量字段。
- **集成测试（可选，需环境变量 Key）**：每家提供商真实两轮对话，断言第二轮缓存读取 > 0、推理块正确回传、`refusal`/`length` 正确处理。
- **端到端**（Playwright）：导入卡 → 新建对话 → 流式回复 → swipe/分支 → 检查器展示；移动端视口。
- **手动**：`pnpm dev` 启动，用浏览器与手机同网访问；用社区真实卡与预设实测。

---

## 七、主要风险与对策

1. **缓存优先布局改变角色扮演行为**：导入预设默认 strict；检查器 diff；逐段保真锁；文档说明。
2. **世界书算法细节多**（递归、组评分、sticky/cooldown、装饰器）：直接移植 ST 逻辑并用真实样本黄金测试。
3. **酒馆助手同步 API**：状态镜像 + legacy 模式兜底；兼容矩阵公开列出未实现项。
4. **提供商接口漂移**：能力注册表数据化、模型列表实时拉取、每模型手动覆盖；适配器契约测试用回放数据。
5. **Anthropic 4.6+ 无 prefill、thinking 块与历史编辑约束**（Fable 5.1 编辑早期轮次使后续 thinking 失效）：编辑即清除下游 opaque 块；预设中的「prefill」段在这些模型上自动转为 depth-0 指令并在检查器提示。
6. **token 估算不精确与缓存最小阈值**：`js-tiktoken`（OpenAI）、Anthropic `count_tokens`（可选）、Gemini `countTokens`（可选）；预算留余量；断点段小于模型最小阈值（512–4096）会静默不缓存，检查器要提示。
7. **分支树下的时间态**：sticky/cooldown/delay 与 MVU `stat_data` 必须按消息节点快照，ST 按消息计数存 chat_metadata 的做法在 swipe/重生时会双重推进。
8. **密钥与局域网安全**：Key 加密存储、LAN 访问可设密码、iframe 默认 opaque origin、RPC 校验 source 与 nonce。
9. **局域网 http 非安全上下文**：手机访问时 `crypto.randomUUID`、Clipboard API、Service Worker 不可用，iOS Safari 对 SSE 易缓冲——ID 生成走服务端或自实现、SSE 加心跳与 padding、提供 mkcert 自签 HTTPS 选项。
10. **Windows 路径与编码、大 PNG 资源 chunk**：路径统一用 `node:path`、流式处理 PNG。

---

## 八、实施顺序（启动时的第一批动作）

1. M0：初始化仓库（`git init`，仓库内设置 `Mar7thLover` 身份），建立 monorepo、工具链、Hono 骨架、Drizzle 迁移、i18n 脚手架、CI。
2. M1：`packages/compat` 的卡/预设/世界书/聊天解析与往返测试 + 服务端存储与库 UI；同时收集 `tools/fixtures` 黄金样本。
3. M2：`packages/providers` 四个适配器 + SSE 生成服务 + 对话 UI（含消息树）。
4. M3：`packages/core` 完整组装流水线（宏/正则/世界书/布局）+ 检查器，黄金测试驱动。

---

## 九、参考资料

- SillyTavern 发布页（1.18.0，2026-05）：https://github.com/SillyTavern/SillyTavern/releases
- Character Card V3 规范：https://github.com/kwaroran/character-card-spec-v3/blob/main/SPEC_V3.md
- 酒馆助手（JS-Slash-Runner / TavernHelper）文档：https://n0vi028.github.io/JS-Slash-Runner-Doc/
  - 请求生成：https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/功能详情/请求生成.html
  - 事件系统：https://n0vi028.github.io/JS-Slash-Runner-Doc/guide/功能详情/监听和发送事件.html
- OpenAI Responses API 参考：https://developers.openai.com/api/reference/resources/responses/methods/create
- OpenAI 提示词缓存：https://developers.openai.com/api/docs/guides/prompt-caching
- OpenAI 推理项与 Responses API：https://cookbook.openai.com/examples/responses_api/reasoning_items
- Gemini 上下文缓存：https://ai.google.dev/gemini-api/docs/caching
- Gemini 3 API 更新（thinking_level 等）：https://developers.googleblog.com/new-gemini-api-updates-for-gemini-3/
- Anthropic 提示词缓存与模型行为：以 Claude API 官方文档为准（adaptive thinking、`cache_control`、中途 `role:system` 消息、无 prefill、`refusal`）
- RisuAI（Svelte 5 + Tauri）作为竞品架构参考：https://ai.miraheze.org/wiki/RisuAI
