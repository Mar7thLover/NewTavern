# M2 契约：提供商与对话

本文是 M2（见 `docs/PLAN.md` §四）各子系统之间的接口契约。并行开发时以本文为准；发现契约有缺陷，**在本文修改并注明**，不要各自私改。

版本：2026-09-13 v1

## 0. 范围与分工

| 代号 | 范围                                                                                                   | 目录                              |
| ---- | ------------------------------------------------------------------------------------------------------ | --------------------------------- |
| P    | 提供商基础设施（SSE 解析、错误归一化、IR→消息、能力目录）+ `openai-chat` + `anthropic` 适配器          | `packages/providers/**`           |
| G/R  | `google`、`openai-responses` 适配器（P 完成后）                                                        | `packages/providers/**`           |
| C    | 最小组装流水线 `assemblePrompt` + 宏引擎子集 + 内置默认预设                                            | `packages/core/**`                |
| S    | 服务端：连接与密钥、模型列表、聊天与消息树、生成 SSE、用量记录                                         | `apps/server/**`                  |
| W    | 前端：对话页（流式、取消、swipe/分支、编辑、重生成、推理折叠、用量）、连接与模型页、Persona 选择、i18n | `apps/web/**`、`packages/i18n/**` |

通用约定：

- 错误响应统一 `{ error: string; message?: string }`，`error` 是机器码（`invalid` / `not_found` / `provider_error` / `no_connection` …），`message` 面向人。
- 时间字段是 ISO 字符串（Drizzle `Date` 直接 JSON 化的结果）。
- 服务端返回的中文/英文文案不做 i18n；UI 只根据 `error` 码翻译，`message` 原样展示为补充。
- 所有 id 为 UUID 字符串。
- 只有 W 改 `packages/i18n/src/*.json`；其余代号不要碰 i18n 文件。
- 各代号只在自己的目录内新增/修改文件；需要别人改的，写进本文「待协调」一节。

## 1. 提供商层 `packages/providers`

`types.ts` 已定义 `ProviderAdapter / Connection / GenEvent / ModelCapabilities / ProviderRequest / ProviderError`，不改语义，只允许**增字段**。

### 1.1 基础模块（P 负责，G/R 复用）

```
src/
  types.ts            已有
  registry.ts         已有；index.ts 末尾调用 registerBuiltinAdapters()
  catalog.json        模型能力目录（见 1.3）
  catalog.ts          loadCatalog / lookupCapabilities(providerId, model, overrides?)
  sse.ts              parseSseStream(body: ReadableStream<Uint8Array>): AsyncIterable<{ event?: string; data: string; id?: string }>
                      —— 处理多行 data、CRLF、注释行、跨 chunk 断句；遇到 `[DONE]` 由调用方判断
  http.ts             providerFetch(conn, req, signal): Promise<Response>
                      —— 合并 conn.headers；非 2xx 读取 body 后 throw HttpError{status, body}
  errors.ts           httpStatusToKind(status): ProviderErrorKind；normalizeUnknownError(e): ProviderError
                      —— 401/403 auth、429 rateLimit、5xx/529 overloaded、400 且消息含 context/length → contextLength、AbortError → 不归一化（直接 stop:abort）
  messages.ts         irToChatMessages(ir, opts): ChatMessage[]
                      —— 把 PromptIR.segments 拉平为 { role, parts, cacheBreakpoint?: boolean, segmentIds: string[] }[]
                      —— opts.mergeSameRole（默认 true）合并相邻同角色；文本以 "\n\n" 连接（可配 joiner）
                      —— opts.systemPlacement: 'top' | 'inline'：'top' 把 anchor.slot==='system' 且在首个非 system 段之前的 system 段抽为 systemBlocks
                      —— opts.ensureLastUser：末尾不是 user 时追加 { role:'user', parts:[{type:'text',text:opts.lastUserFallback ?? '[Continue]'}] }
                      —— cachePlan.breakpoints 下标映射到合并后的消息：包含该 segment 的消息 cacheBreakpoint=true
  adapters/
    openai-chat.ts
    anthropic.ts
    google.ts
    openai-responses.ts
  index.ts            export * 各模块；registerBuiltinAdapters()
```

`Connection` 增字段（可选）：`{ label?: string; modelOverrides?: Record<string, Partial<ModelCapabilities>> }`。

### 1.2 适配器行为要点

- `buildRequest(ir, conn, model)` 是纯函数（不读环境、不随机），URL = `conn.baseUrl` 去尾斜杠 + 路径；`headers` 含鉴权（`Authorization: Bearer` / `x-api-key` / `x-goog-api-key`）与 `conn.headers`。
- 采样映射：`SamplingParams`（core）→ 各家字段；`maxTokens` 缺省取 `capabilities(model).maxOutput` 的 `min(4096, maxOutput)`；不支持的参数丢弃并在 `buildRequest` 返回值的 `warnings?: string[]`（`ProviderRequest` 增可选字段）里说明。
- `stream()`：`yield` 顺序 `text.delta* / reasoning.delta* / reasoning.opaque* / usage? / stop`；出错 `yield { type:'error' }` 后结束；`signal` 中止时 `yield { type:'stop', reason:'abort' }`。**任何情况下最后一个事件必须是 `stop` 或 `error`。**
- 推理：
  - `openai-chat`：`reasoning_content`（DeepSeek 等中转常见）→ `reasoning.delta`；`reasoning_effort` 仅当 `quirks.reasoningEffort !== false` 且能力 `thinking==='effort'`。
  - `anthropic`：`thinking` 块 `thinking_delta` → `reasoning.delta`；`signature_delta` 积累后在 `content_block_stop` 时 `yield reasoning.opaque{ payload: { type:'thinking', thinking, signature } }`；`redacted_thinking` 直接 opaque。历史里的 `Part.reasoning_opaque`（provider+model 匹配）原样放回对应 assistant 消息 content 开头。
  - `google`：`thoughtSignature` → opaque；`part.thought===true` 的文本 → `reasoning.delta`。
  - `openai-responses`：`reasoning` 输出项的 `encrypted_content` → opaque；`summary` → `reasoning.delta`。
- 缓存：
  - `anthropic`：`cacheBreakpoint` 的消息，其最后一个文本块加 `cache_control: { type:'ephemeral' }`（`ir.cachePlan.ttl==='1h'` 时加 `ttl:'1h'`）；system 抽到顶层 `system[]`，末块按同样规则加断点；断点数 ≤ `maxBreakpoints`（超出的忽略，靠前优先）。
  - `openai-chat`：无显式断点；`stream_options: { include_usage: true }`（`quirks.streamUsage !== false`）；`usage.prompt_tokens_details.cached_tokens` → `cacheRead`。
  - `openai-responses`：`prompt_cache_key = ir.meta.chatId`；`store:false`；`include:['reasoning.encrypted_content']`。
  - `google`：不做显式缓存；`usageMetadata.cachedContentTokenCount` → `cacheRead`。
- `usage` 事件：`input` 不含 cacheRead（Anthropic 语义：`input_tokens` 已排除缓存读写；OpenAI 的 `prompt_tokens` 含 cached，需减去）。归一后 **`input + cacheRead + cacheWrite` = 本次总输入**。
- `listModels(conn)`：OpenAI 类 `GET /models`；Anthropic `GET /v1/models`；Google `GET /v1beta/models`（去掉 `models/` 前缀，过滤支持 `generateContent` 的）。失败抛 `ProviderError`。
- `normalizeError(e)`：把 `HttpError` / 各家错误体（`error.message`、`error.type`）归一化；Anthropic `overloaded_error`→`overloaded`；Google `promptFeedback.blockReason`/`finishReason==='SAFETY'` → `stop:{reason:'filter'}`。
- OpenAI 兼容 quirks（`conn.quirks`）：`developerRole`、`reasoningContent`、`prefill`、`streamUsage`、`reasoningEffort`、`thinkingToggle`（发 `thinking:{type:'enabled'|'disabled'}` 开关推理）；由 baseUrl 推断默认值（`detectQuirks(baseUrl): Record<string, boolean>`：api.openai.com → developerRole/streamUsage/reasoningEffort；api.z.ai → reasoningContent/reasoningEffort/thinkingToggle；deepseek → reasoningContent；其他默认 streamUsage=true）。

### 1.3 catalog.json

```jsonc
{
  "version": 2,
  "updated": "2026-09-13",
  "defaults": { ...ModelCapabilities 全字段默认值 },
  "providers": { "<providerId>": { "capabilities": Partial<ModelCapabilities> } },
  "models": [
    { "provider": "anthropic", "match": "claude-fable-5*", "capabilities": { "thinking": "adaptive", "systemInMessages": true, "reasoningRoundtrip": "signature", "prefill": false, "maxContext": 1000000, "maxOutput": 128000, "caching": "breakpoints", "maxBreakpoints": 4, "cacheMinTokens": 1024 } },
    ...
  ]
}
```

`match` 为 glob（`*` 通配，大小写不敏感），越靠后的条目优先级越高（后写覆盖）。合并顺序：defaults → providers[id] → models 逐条匹配 → `conn.modelOverrides[model]`。P 负责填入 2026-09 时点的主流模型：Claude 5 家族（fable-5.1 / opus-5 / sonnet-5）、Haiku 4.5、GPT-5.x/GPT-6 系列、o 系列、Gemini 3.x / 2.5 系列、DeepSeek V3/R1。**不确定的数值宁可保守**（maxOutput 小、caching none）；来源写在 `catalog.json` 顶部 `_notes`。

### 1.4 测试

- 每个适配器：`buildRequest` 快照测试（固定 IR → 固定 body），`stream` 用录制/手写的 SSE 文本经 `new Response(text).body` 回放，断言事件序列与 usage 数值。
- `sse.ts` 跨 chunk 断句测试。
- `messages.ts` 同角色合并 / 末尾 user / 断点映射测试。

## 2. 组装 `packages/core`（C）

```ts
// packages/core/src/prompt/assemble.ts
export interface AssembleCharacter {
  id: string;
  name: string;
  data: {
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    [k: string]: unknown;
  };
}
export interface AssemblePersona {
  id?: string;
  name: string;
  description: string;
}
export interface AssemblePreset {
  id: string;
  format: 'st-openai' | 'native';
  /** st-openai：ST 预设 JSON 全量（prompts / prompt_order / 采样键）；native：见 DEFAULT_PRESET 结构 */
  data: Record<string, unknown>;
  sampling?: Record<string, unknown> | null;
}
export interface AssembleHistoryNode {
  id: string;
  role: 'user' | 'assistant' | 'system';
  name?: string | null;
  parts: Part[];
  reasoning?: { opaque?: { provider: string; model: string; payload: unknown }[] } | null;
  isHidden?: boolean;
}
export interface AssembleInput {
  chatId: string;
  model: string;
  /** 当前 provider+model，用于决定历史里的 reasoning_opaque 是否回传 */
  provider: string;
  preset: AssemblePreset | null; // null → DEFAULT_PRESET
  character: AssembleCharacter | null;
  persona: AssemblePersona | null;
  /** root→head 线性化后的历史（不含正在生成的节点）；isHidden 的节点被剔除 */
  history: AssembleHistoryNode[];
  layoutMode?: 'strict' | 'cache-aware'; // M2 两者输出相同段序；仅 cachePlan 不同
  options?: {
    preferCharacterPrompt?: boolean; // 默认 true：卡 system_prompt / post_history_instructions 覆盖 main / jailbreak
    maxContextTokens?: number; // 默认取预设 openai_max_context，否则 128000；超出时从历史最早开始丢（保留全部非历史段）
    now?: Date;
    seed?: number; // 宏用（M2 只用于 {{time}} {{date}} 可选实现）
  };
}
export function assemblePrompt(input: AssembleInput): PromptIR;
export const DEFAULT_PRESET: AssemblePreset; // format:'native'
```

### 2.1 ST 预设展开规则（M2 最小集，M3 用黄金测试修正）

参考 `D:\Projects\SillyTavern\public\scripts\openai.js`（`preparePromptsForChatCompletion`、`populateChatHistory`、`populateDialogueExamples`）与 `PromptManager.js`。

1. 取 `prompt_order`：优先 `character_id === 100001`（ST 全局 dummy），其次 `100000`，其次首个。
2. 遍历 order 中 `enabled===true` 的项，按 identifier 找 prompt；找不到跳过。
3. 标记 prompt（`marker: true`）按 identifier 展开：
   - `chatHistory`：历史段（每条历史节点一段，`origin.kind='history'`，`anchor.slot='history'`，`stability='history'`；最后一条 user 视为 `stability='turn'` 且 `origin.kind='user_input'`）。深度注入（`injection_position===1` 的 prompt）以 `anchor.slot='history'`、`anchor.depth=injection_depth` 插入历史：depth 0 = 最后一条之后，depth n = 倒数第 n 条之前；同 depth 按 `injection_order`（缺省 100）升序，再按 prompts 数组原顺序；角色取 prompt.role。
   - `charDescription` → `description`；`charPersonality` → 用 `personality_format`（缺省 `{{personality}}`）；`scenario` → `scenario_format`（缺省 `{{scenario}}`）；`personaDescription` → persona.description；均为 system 段，`origin.kind='character'|'persona'`，空则不产生段。
   - `dialogueExamples`：`mes_example` 先宏替换，按 `<START>` 切块（去空），每块一段 system：`[Start a new Chat]\n` + 块内容（ST 的 `new_example_chat`）；M2 不拆 user/assistant 行。
   - `worldInfoBefore` / `worldInfoAfter` / `enhanceDefinitions`（M3 前不产生段）。
4. 非标记 prompt：`content` 宏替换后为空则跳过；role 缺省 system；`injection_position===1` → 深度注入（同上），否则依次进 system 槽（`anchor.slot='system'`，`order` 递增）。
5. 覆盖：`preferCharacterPrompt` 且 prompt 无 `forbid_overrides`：identifier `main` 且 `card.system_prompt` 非空 → 内容替换为卡的 `system_prompt`；identifier `jailbreak`（或 `nsfw`? 否，仅 `jailbreak`）且 `card.post_history_instructions` 非空 → 替换。替换后仍做宏替换（卡内 `{{original}}` 替换为预设原内容）。
6. `squash_system_messages===true`：相邻 system 段（仅 system 槽内、且都不是深度注入）合并为一段，`\n` 连接（ST 用 `\n`）；`id` 取首段。
7. 采样：`temperature top_p top_k min_p frequency_penalty presence_penalty repetition_penalty openai_max_tokens→maxTokens seed`，从 `preset.sampling ?? preset.data` 取。
8. 历史裁剪：`tokenEstimate`（heuristic）超过 `maxContextTokens - maxTokens` 时，从最早的历史段开始丢弃（不丢非历史段与最后一条 user），`meta.warnings` 记一条。
9. `stability`：preset/character/persona/global_system 段 `static`；history 段 `history`；最后 user `turn`；深度注入 `turn`。
10. `cachePlan`：`breakpoints = [最后一个 static 段下标]`（若历史至少 1 条再加 `倒数第 2 条历史段下标`，供 Anthropic BP2；两个模式 M2 相同）；`ttl` 不设。`layoutMode` 原样写入 meta。
11. `id`：`preset:<identifier>` / `character:<field>` / `persona` / `history:<nodeId>` / `injection:<identifier>`；重复 identifier 加 `#n`。
12. 历史 assistant 节点若 `reasoning.opaque` 中有 `provider===input.provider && model===input.model` 的块，转为 `Part.reasoning_opaque` 放在该段 parts 开头；否则丢弃并在 warnings 记「推理块因模型切换被丢弃」（每次组装最多记 1 条）。

### 2.2 宏 `packages/core/src/macros/engine.ts`

`substituteMacros(text, ctx: MacroContext): string`，`MacroContext = { char, user, persona?, description?, personality?, scenario?, mesExamples?, original?, now?: Date }`。M2 支持：`{{char}} {{user}} {{persona}} {{description}} {{personality}} {{scenario}} {{mesExamples}} {{original}} {{newline}} {{trim}} {{noop}} {{time}} {{date}}`（大小写不敏感）；`{{// 注释}}` 删除；未知宏原样保留。`{{trim}}` 语义同 ST（删除其两侧空白与换行）。返回值另附 `volatile: boolean`（含 time/date 时 true）—— 提供 `substituteMacrosDetailed()` 返回 `{ text, volatile }`。

### 2.3 DEFAULT_PRESET（native）

```ts
{ id: 'builtin:default', format: 'native', data: {
    prompts: [ {identifier:'main', role:'system', content:'<双语通用 RP 系统提示，简短>'},
               {identifier:'charDescription', marker:true}, {identifier:'charPersonality', marker:true},
               {identifier:'scenario', marker:true}, {identifier:'personaDescription', marker:true},
               {identifier:'dialogueExamples', marker:true}, {identifier:'chatHistory', marker:true} ],
    prompt_order: [{ character_id: 100001, order: [...全部 enabled] }],
    temperature: 1, openai_max_tokens: 4096, openai_max_context: 128000 } }
```

native 与 st-openai 走同一展开逻辑（native 只是子集）。

### 2.4 导出

`packages/core/src/index.ts` 追加 `export * from './prompt/assemble.js'; export * from './macros/engine.js';`。

### 2.5 实现后对照 ST 1.18 源码的修正（C，2026-09-13）

以下条目以 **ST 实际行为为准**，实现已按此落地，§2.1/§2.2 的对应描述作废：

1. **`<START>` 分块前后各有一条分隔消息**。ST `populateDialogueExamples` 在**每个**示例块之前插入一条独立的 system 消息，内容取 `new_example_chat_prompt`（默认 **`[Example Chat]`**，不是 `[Start a new Chat]`），且不是拼在块内容前面。段 id：`preset:newExampleChat`(`#n`) + `character:mes_example`(`#n`)。
2. **历史最前有 `[Start a new Chat]`**。ST `populateChatHistory` 末尾 `insertAtStart(newMainChat)`，内容取 `new_chat_prompt`（默认 `[Start a new Chat]`）。§2.1 完全没提。实现：段 id `preset:newMainChat`，`origin.kind='preset'`、`ref='new_chat_prompt'`、`stability='static'`，放在历史段之前；`new_chat_prompt` 为空串则不产生段（`DEFAULT_PRESET` 即设为空串）。
3. **同 depth 内还要按 role 分组**。ST `populationInjectionPrompts` 的最终时序是 `injection_order 升序 → role（assistant, user, system）→ prompts 数组原顺序`；§2.1-3 漏了中间的 role 一级。另外 ST 会把同 (depth, order, role) 的多条注入用 `\n` **合并为一条消息**，实现为保留 IR 粒度仍每条一段（渲染层合并同角色即可），M3 黄金测试时需注意这一差异。
4. **`squash_system_messages` 作用于整条消息列表**，不是「仅 system 槽」。ST 在 `ChatCompletion.squashSystemMessages` 里对 flatten 后的全部消息做，历史里的 system 节点与深度注入同样会被卷入；排除条件是 `identifier ∈ {newMainChat, newChat, groupNudge}` 或消息带 `name`。实现照此，并额外要求两段都是纯文本段（含 image/document/reasoning_opaque 的段不合并）。
5. **`{{trim}}` 只吃换行不吃空格**。ST 正则 `(?:\r?\n)*{{trim}}(?:\r?\n)*`；§2.2「删除两侧空白与换行」不准确。
6. **`{{original}}` 在 env 最前且只展开一次**。ST `substituteParamsLegacy` 先把 `original` 放进 env，所以被插回的预设原文里的 `{{char}}` 等还会继续展开；同一段文本里第二次及以后的 `{{original}}` 替换为空串。
7. **历史消息文本也会走宏替换**。ST `populateChatHistory` 对每条历史消息调 `promptManager.preparePrompt(prompt)`（即 `substituteParams`）。§2.1 未提，实现照 ST 执行。
8. **`enhanceDefinitions` 不是 marker**。ST 默认预设里它是 `marker:false` 且有正文，`populateChatCompletion` 会正常加入。§2.1-3 把它列进「不产生段」的标记里是错的；实现走普通 prompt 路径。
9. **ST 会丢掉 `system_prompt:true` 的自定义 prompt**。`populateChatCompletion` 只显式处理 `main/nsfw/jailbreak/enhanceDefinitions/bias` + 标记 + `system_prompt === false` 的 prompt，其余 `system_prompt:true` 的条目静默丢弃。实现**故意不照抄**（任何非标记 prompt 都产生段），M3 黄金测试时这是已知偏差。
10. **`cachePlan` 第二个断点需要 ≥2 条历史段**。§2.1-10 写「历史至少 1 条」，但「倒数第 2 条」在只有 1 条时不存在；实现要求 ≥2 条。
11. `Segment` 新增可选字段 `name?: string`（见 §1.1 `messages.ts` 消费方）：历史消息的发言者名。

其余已知偏差（留给 M3）：示例对话不拆成 `example_user`/`example_assistant` 行（§2.1-3 明确的 M2 简化）；`names_behavior`、`send_if_empty`、`continue`/`impersonate`/群聊相关 prompt、token 预算的「保留预算」语义（ST 是边填边算，实现是先全量组装再从最早历史丢）均未实现。

## 3. 服务端 `apps/server`（S）

### 3.1 密钥 `services/secrets.ts`

- 主密钥文件 `data/<user>/master.key`（32 字节，hex；不存在则生成）。
- `encryptJson(obj) → string`（`v1:<iv hex>:<tag hex>:<cipher hex>`，AES-256-GCM），`decryptJson(str)`。
- `connections.keysEnc` 存 `encryptJson(string[])`。
- 对外**永不返回明文 Key**；列表/详情返回 `keyCount` 与 `keyHints: string[]`（每个 Key 末 4 位）。

### 3.2 连接 `routes/connections.ts`

```
GET    /api/connections                    → ConnectionSummary[]
POST   /api/connections                    body ConnectionInput → ConnectionSummary (201)
GET    /api/connections/:id                → ConnectionSummary
PUT    /api/connections/:id                body Partial<ConnectionInput>（apiKeys 缺省=不变；[] = 清空）→ ConnectionSummary
DELETE /api/connections/:id                → 204
GET    /api/connections/:id/models?refresh=1 → { models: ModelInfo[]; fetchedAt: string | null; source: 'cache'|'remote' }
POST   /api/connections/:id/test           body { model?: string } → { ok: true; latencyMs: number; modelCount?: number } | 4xx { error:'provider_error', kind, message }
GET    /api/connections/:id/capabilities?model=xxx → ModelCapabilities
```

```ts
interface ConnectionInput {
  provider: 'openai-chat' | 'openai-responses' | 'anthropic' | 'google';
  label: string;
  baseUrl?: string; // 缺省按 provider 默认：https://api.openai.com/v1 | https://api.openai.com/v1 | https://api.anthropic.com | https://generativelanguage.googleapis.com
  apiKeys?: string[]; // 多 Key 轮换：每次请求取 (计数器 % n)，401/429 换下一个重试一次
  headers?: Record<string, string>;
  proxy?: string | null; // M2 只存储，不实现代理转发（记 TODO）
  quirks?: Record<string, boolean>;
  modelOverrides?: Record<string, Partial<ModelCapabilities>>;
}
interface ConnectionSummary extends Omit<ConnectionInput, 'apiKeys'> {
  id;
  keyCount: number;
  keyHints: string[];
  createdAt;
  updatedAt;
}
```

`services/providers.ts`：`resolveConnection(id) → { conn: Connection(含明文 apiKey), adapter }`；`nextApiKey(connectionRow)`。

### 3.3 生成默认值

设置 KV `generation.default = { connectionId: string | null; model: string | null }`；`GET/PUT /api/settings/generation.default`（已有 settings 路由即可）。

### 3.4 聊天与消息树 `routes/chats.ts`

```
GET    /api/chats                          → ChatSummary[]（按 updatedAt 倒序）
POST   /api/chats                          body { characterIds?: string[]; personaId?: string|null; presetId?: string|null; title?: string; mode?: 'roleplay' } → ChatDetail (201)
                                            —— 若 characterIds[0] 有 first_mes：创建 assistant 根节点（first_mes 宏替换后），alternate_greetings 作为其 swipe 兄弟（siblingSeq 1..n）；head = 首个。无 first_mes 则 rootNodeId/headNodeId 为 null。
GET    /api/chats/:id                      → ChatDetail
PATCH  /api/chats/:id                      body Partial<{ title; personaId; presetId; headNodeId; overrides: ChatOverrides }> → ChatDetail
DELETE /api/chats/:id                      → 204（级联删节点）
POST   /api/chats/:id/messages             body { role: 'user'|'assistant'|'system'; text: string; parentId?: string|null (缺省 head); name?: string } → { node: MessageNode; chat: ChatSummary }
                                            —— 新节点 siblingSeq = 同父最大 +1；head 移到新节点
PATCH  /api/chats/:id/nodes/:nodeId        body Partial<{ text: string; isHidden: boolean; name: string }> → MessageNode
                                            —— 修改 text 时：清除该节点及其**所有后代**的 reasoning.opaque
DELETE /api/chats/:id/nodes/:nodeId        → { chat: ChatSummary }（删除子树；若 head 在子树内，head→parentId；若删的是根则 root/head 均按剩余兄弟或 null 处理）
POST   /api/chats/:id/generate             body GenerateBody → SSE（见 3.5）
```

```ts
interface ChatOverrides {
  connectionId?: string | null;
  model?: string | null;
  sampling?: Partial<SamplingParams>;
  thinking?: { effort?: string; budgetTokens?: number };
  layoutMode?: 'strict' | 'cache-aware';
}
interface ChatSummary {
  id;
  title;
  mode;
  characterIds;
  personaId;
  presetId;
  overrides;
  rootNodeId;
  headNodeId;
  metadata;
  createdAt;
  updatedAt;
  character?: { id; name; avatarAssetId: string | null } | null; // characterIds[0] 的摘要
  messageCount: number;
  lastMessageAt: string | null;
  preview: string | null; /* head 文本前 120 字 */
}
interface MessageNode {
  id;
  chatId;
  parentId: string | null;
  siblingSeq;
  role;
  name: string | null;
  parts: Part[];
  reasoning: { text?: string; opaque?: unknown[] } | null;
  usage: Usage | null;
  provider: string | null;
  model: string | null;
  isHidden;
  extra;
  createdAt;
}
interface ChatDetail extends ChatSummary {
  nodes: MessageNode[]; /* 该聊天全部节点 */
}
```

树操作放 `services/chat-tree.ts`（纯函数 + DB 封装），复用 `@newtavern/core` 的 `linearizePath / childrenOf`。

### 3.5 生成 SSE

`POST /api/chats/:id/generate`，`Content-Type: text/event-stream`，`Cache-Control: no-cache`，`X-Accel-Buffering: no`；先发 2KB 注释填充（iOS Safari 缓冲）；每 15 s 发 `: ping`。

```ts
interface GenerateBody {
  /** 若给出：先在 parentId（缺省 head）下创建 user 节点，再以其为父生成 */
  userMessage?: { text: string; name?: string } | null;
  /** 生成节点的父节点；缺省 head。swipe/重生成 = parentId 传目标 assistant 节点的 parentId */
  parentId?: string | null;
  connectionId?: string;
  model?: string; // 缺省依次取 chat.overrides → settings generation.default；都没有 → 400 { error:'no_connection' }
  layoutMode?: 'strict' | 'cache-aware';
}
```

事件（`event:` 名 + `data:` JSON）：

| event             | data                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------- |
| `node`            | `{ node: MessageNode; chat: ChatSummary }` —— 每创建一个节点发一次（user、assistant）   |
| `text.delta`      | `{ nodeId; text }`                                                                      |
| `reasoning.delta` | `{ nodeId; text }`                                                                      |
| `usage`           | `{ nodeId; usage: Usage }`                                                              |
| `image`           | `{ nodeId; assetId; mime }`（M2 可不实现，保留名字）                                    |
| `done`            | `{ node: MessageNode; chat: ChatSummary; stopReason; latencyMs }` —— 持久化后的最终节点 |
| `error`           | `{ nodeId?; error: { kind; message; status? }; retryable }`                             |

`Usage = { input; output; cacheRead; cacheWrite; reasoning }`。

流程：校验 → 解析连接/模型 → 组装（`assemblePrompt`，历史 = root→parentId 路径，剔除 isHidden）→ `adapter.buildRequest` → 创建 assistant 节点（parts 空，`provider/model` 填好）并移动 head → 发 `node` → `adapter.stream` 逐事件转发并累积 → 结束时把 text/reasoning(text+opaque)/usage/`extra.stopReason` 写回节点，`generation_log` 记一行 → 发 `done`。
客户端断开（`c.req.raw.signal` abort）→ 中止上游 → 已累积文本照常持久化，`extra.stopReason='abort'`，不发 `done`（客户端已走）。
provider 出错且**尚无任何文本**：删除刚创建的 assistant 节点，head 回退，发 `error`。有部分文本则保留节点并发 `error`。

每次生成把最终 `ProviderRequest`（去掉 headers）存入节点 `extra.request`，供 M3 检查器与调试；体积上限 200 KB，超出只存 body 长度。

### 3.6 其他

- `routes/models.ts`：`GET /api/models/catalog` → 目录里的 `models[]`（供前端做候选提示）。
- `app.ts` 挂载新路由；`app.test.ts` 补 chats/nodes/connections 的集成测试（generate 用一个注册进 registry 的 `fake` 适配器回放固定事件）。
- 新增 Drizzle 迁移：`chats` 加 `connection_id`? —— **不加列**，连接与模型走 `overrides` JSON。如确需迁移，`pnpm --filter @newtavern/server db:generate`。

## 4. 前端 `apps/web`（W）

### 4.1 信息架构

- `/`：对话页。桌面三栏：左「会话列表」(w-72，可折叠)、中「对话」、右「会话面板」(w-80，可折叠)。移动端单栏：会话列表与会话面板都是抽屉。
- `/connections`：连接与模型。
- 全局侧栏保持现状；`nav.chat` 高亮。

### 4.2 对话页组件（`features/chat/`）

```
ChatPage.tsx           路由入口；读 chatId 于 query `?c=`；无 chat 时显示 StartScreen
StartScreen.tsx        「选择角色开始」：角色网格（复用 library/shared Avatar）、「空白对话」按钮
ChatListPane.tsx       会话列表：头像、标题（缺省角色名）、预览、相对时间；新建、删除（ConfirmDialog）
ChatView.tsx           组合 MessageList + Composer + 顶栏（角色名 / 模型徽标 / 面板开关）
MessageList.tsx        线性化 root→head；自动滚动到底（用户上滑时停止跟随，显示「回到底部」）
MessageItem.tsx        单条消息：头像 + 名字 + 时间；正文 Markdown；hover/长按操作条；SwipeBar
ReasoningBlock.tsx     推理折叠区：流式中「思考中…」带 shimmer，有正文后自动折叠；展开显示 muted 小字
SwipeBar.tsx           ‹ i / n › 兄弟切换（swipe）；有后代的兄弟显示分叉徽标；重生成按钮
Composer.tsx           自适应高度 textarea；Enter 发送 / Shift+Enter 换行（触屏设备 Enter 换行）；生成中显示停止按钮
SessionPanel.tsx       角色卡片、连接/模型选择、Persona 选择、预设选择、布局模式、上一轮用量（input/output/cacheRead/cacheWrite/reasoning）与本会话累计
useGeneration.ts       fetch + ReadableStream 解析 SSE（自写小解析器，处理跨 chunk）；AbortController；把 delta 写入 zustand 流式缓冲
store/chat.ts          { streaming: Record<nodeId, { text; reasoning; status }> } 等瞬时状态；持久数据走 TanStack Query
```

API hooks 追加到 `lib/api.ts`（`useChats/useChat/useCreateChat/usePatchChat/useDeleteChat/usePostMessage/usePatchNode/useDeleteNode/useConnections/...`），类型与本文 §3 一致。

### 4.3 视觉方向（必须遵守）

- **阅读优先，不用气泡**。消息是「段落块」：36px 圆角头像 + 名字（`font-medium`）+ 时间（`text-xs text-muted-foreground`）一行，正文在下方，`max-w-[72ch]`，`text-[15px] leading-[1.75]`，段间距 `0.75em`。
- 助手消息直接放在背景上；用户消息放在 `bg-card` 的圆角卡里（`rounded-xl px-4 py-3`），头像同样在左。二者靠底色与头像区分，不左右对齐。
- Markdown：`react-markdown` + `remark-gfm`，禁用原生 HTML（M5 前端卡再开）。引号 `“…”`/`"…"` 内文本用 `text-primary` 着色（remark 插件或渲染后正则包裹，注意不要破坏代码块）。斜体用 `text-muted-foreground italic`。
- 流式：正文末尾一个 `▍` 光标（`animate-pulse`）；推理区未展开时一行「思考中…」+ 细 shimmer 条。
- 操作条只在 hover / 焦点 / 触屏长按显示，`ghost` 图标按钮（`lucide-react`）：复制、编辑、删除、重生成；助手消息还有 SwipeBar。
- 编辑：就地 textarea，Ctrl/⌘+Enter 保存、Esc 取消。
- Composer：`rounded-2xl border bg-card`，聚焦 `ring-2 ring-ring`；底部固定，`pb-[env(safe-area-inset-bottom)]`；发送按钮 `size-9 rounded-full`。
- 动效：`framer-motion`，新消息 `opacity 0→1, y 8→0, 200ms`；推理区高度 `layout` 动画；不要弹跳。
- 空状态与错误用现有 `EmptyState` / `QueryStatus` 风格。
- 深色为默认主题，明暗都必须好看；所有颜色走 token，不写死色值。
- 页面必须在 390px 宽可用：三栏折叠、Composer 不被键盘遮挡（`100dvh`）。

### 4.4 连接与模型页（`features/settings/ConnectionsPage.tsx`）

- 连接卡片列表：provider 徽标、label、baseUrl（截断）、`keyCount` 个 Key、默认标记。
- 新建/编辑 Modal：provider 单选（4 个 + 「常见端点」快捷填充：DeepSeek `https://api.deepseek.com`、OpenRouter `https://openrouter.ai/api/v1`、Ollama `http://localhost:11434/v1`、LM Studio `http://localhost:1234/v1`，均为 openai-chat）、label、Base URL、API Key（textarea，一行一个）、高级：自定义 Header（k=v 一行一个）、quirks 开关。
- 「测试」按钮 → `POST /test`；「刷新模型」→ `GET /models?refresh=1`；模型列表可搜索、点选设为默认（写 `generation.default`）。
- 空状态：引导创建第一个连接。

### 4.5 i18n

新增命名空间 `chat.*`、`connections.*`、`errors.*`（按 `error` 码：`no_connection`、`provider_error`、`auth`、`rateLimit`、`overloaded`、`contextLength`、`filter`、`invalid`、`network`）。zh-CN 与 en 同步。

## 5. 待协调

（各代号在此追加需要他人配合的事项，格式：`- [代号→代号] 事项`）

- [S→P] `registry` 需提供 `registerBuiltinAdapters()`；S 在 `services/providers.ts` 启动时调用；测试里 S 自己注册 `fake` 适配器。
  - **P 已完成**：`import { registerBuiltinAdapters } from '@newtavern/providers'`，可传入自定义 `ProviderRegistry`（默认写全局 `registry`），返回该 registry。
- [P→契约] `irToChatMessages` 的返回类型与 §1.1 不同：实际为 `{ systemBlocks: SystemBlock[]; messages: ChatMessage[] }`，因为 `systemPlacement: 'top'` 抽出的 system 块必须有地方承载。签名其余部分与 §1.1 一致。
- [P→C] `ModelCapabilities` 缺少"是否接受采样参数"的表达：Claude Fable 5/5.1、Opus 5/4.7/4.8、Sonnet 5 已移除 `temperature/top_p/top_k`（传了 400），而 Opus 4.6 / Sonnet 4.6 仍接受。P 暂时在 `adapters/anthropic.ts` 内用模型 glob 名单兜底（`NO_SAMPLING_PATTERNS`）。**建议 M3 给 `ModelCapabilities` 增加 `sampling: 'full' | 'none'` 字段并移入 catalog.json**，届时由改 `packages/core` 的人加字段，P/G/R 同步改适配器。
- [P→C] `PromptIR.sampling` 目前没有 thinking 相关字段。两个适配器都会读可选扩展 `ir.sampling.thinking = { effort?: string; budgetTokens?: number }`（类型上用 `Record<string, unknown>` 兜底），也接受 `buildRequest` 第 4 参数 `opts: BuildOptions` 传同样结构（**opts 优先**）。若 C 愿意，`SamplingParams` 可正式加上 `thinking?: { effort?: string; budgetTokens?: number }`。
- [P→S] 图片/文档 part 在两个适配器里都渲染为占位 URL `asset:<assetId>`（OpenAI 走 `image_url.url`，Anthropic 走 `source: { type:'url', url }`），并在 `ProviderRequest.warnings` 里记一条。**M4 由 S 在发请求前把占位替换为 data URL / base64**。
- [P→C] C 新加的 `Segment.name` 在 M2 的两个适配器里**暂未使用**：`irToChatMessages` 会合并相邻同角色段，`name` 会丢失语义。群聊需要发言者名时建议按 ST 的做法在组装阶段把名字前缀写进文本（`"名字: 内容"`），或在 M3 给 `irToChatMessages` 加 `nameStrategy: 'field' | 'prefix' | 'none'` 并禁用跨 name 的合并。
- [P→S] `listModels` 失败时抛出的是 `Error & { providerError: ProviderError }`（`name === 'ProviderErrorException'`），S 可直接读 `e.providerError` 填 `{ error:'provider_error', kind, message }`。
- [S→C] S 依赖 `assemblePrompt` 与 `DEFAULT_PRESET`；C 未就绪前 S 可先写一个同签名的临时实现放在 `apps/server/src/services/assemble-shim.ts`，C 完成后删除 shim 改为导入。
- [W→S] W 以本文 §3 类型为准写 `api.ts`；集成时以本文为裁决依据。
- [C→P] `Segment` 已新增可选字段 `name?: string`（历史消息发言者名）。`messages.ts` 的 `irToChatMessages` 请在合并同角色时把它带到 `ChatMessage`（OpenAI `name` 字段）；**带 `name` 的段不要与不带 `name` 的段合并**（ST 的 squash 同样跳过带 name 的消息）。
- [C→P] `assemblePrompt` 已就绪：`assemblePrompt(input) → PromptIR`、`DEFAULT_PRESET`，从 `@newtavern/core` 导出。历史段的 `reasoning_opaque` part 已按 provider+model 过滤好，适配器直接原样放回即可，不需要再判断。
- [C→S] `assemblePrompt` / `DEFAULT_PRESET` 已在 `@newtavern/core` 可用（§2 签名一致），`apps/server/src/services/assemble-shim.ts` 若已创建请删除并改为导入。注意 `AssembleHistoryNode.reasoning` 只需要 `{ opaque?: {provider, model, payload}[] }`，`reasoning.text` 不参与组装。
- [C→S] `assemblePrompt` 不做「保留预算」：它先全量组装再从最早的历史段开始丢弃到 `maxContextTokens - maxTokens` 以内，并在 `meta.warnings` 记一条中文提示。`maxContextTokens` 缺省取预设 `openai_max_context`，服务端如要按模型能力 `maxContext` 裁剪，请显式传 `options.maxContextTokens`。
- [C→W] 提示词检查器可用 `Segment.origin.kind` / `anchor` / `stability` / `volatile` 着色；`meta.warnings` 是中文原文，直接展示即可（不走 i18n）。`meta.presetId` 在未选预设时为 `builtin:default`。
- [W→S] 前端实际使用的字段与行为（W 已按 §3 实现完，集成时请对齐）：
  - `ChatSummary`：`title / character{ id,name,avatarAssetId } / preview / updatedAt / headNodeId / personaId / presetId / overrides`（会话列表与顶栏全靠这些）。
  - `PATCH /api/chats/:id` 请返回 `ChatDetail`；若只返回摘要，W 会保留缓存里的 `nodes`（不会崩，但 swipe 后需要等下一次 GET 才能补全）。切换兄弟就是 `PATCH { headNodeId: 叶子 }`，叶子由 W 用 `childrenOf` 在客户端下钻算出。
  - `DELETE /api/chats/:id/nodes/:nodeId` 返回 `{ chat }` 后，W 会立刻重新 `GET /api/chats/:id`（删子树后剩余节点以服务端为准）。
  - 生成 SSE：W 依赖 assistant 节点创建时**立刻**发 `node`（`provider/model` 填好、`parts` 可空），之后的 `text.delta` / `reasoning.delta` 只按 `nodeId` 累积；`done` 的最终节点会整体覆盖缓存。用户点「停止」= 客户端 abort，W 随后重新 `GET /api/chats/:id` 对齐已持久化的部分文本，所以服务端不发 `done` 没问题。
  - `error` 事件后 W 也会重新拉一次详情（因为无文本时服务端会删掉刚建的节点）。`error.kind` 会被翻译成 UI 文案，`message` 原样附在下面；已覆盖的码：`no_connection / provider_error / auth / rateLimit / overloaded / contextLength / filter / invalid / network / not_found`，其他码回落到「发生未知错误」。
  - `GET/PUT /api/settings/generation.default` 沿用既有 settings 路由的形态：**响应是 `{ key, value }`**，未设置过时 GET 返回 404。W 已按此适配（剥掉外层、404 视为「未设置」），S 不需要改这个路由。PUT 的请求体仍是 `{ connectionId, model }` 本体，与 `routes/chats.ts` 里的 `readGenerationDefault` 一致。
  - `GET /api/connections/:id/models` 的 `ModelInfo` 至少需要 `id`；`contextLength` 若给出，模型列表会显示。`?refresh=1` 的返回体与不带参数时一致。
  - `ConnectionSummary.keyHints` 用于显示「…末 4 位」；`PUT /api/connections/:id` 时 W 省略 `apiKeys` 表示不改、传 `[]` 表示清空（与 §3.2 一致）。
- [S→P] `buildRequest` 的第 4 个可选参数已按 [P→C] 里约定的 `BuildOptions` 形状调用：`routes/chats.ts` 里用「参数更多」的函数类型（`BuildRequestFn`）包了一层，把 `chat.overrides.thinking` 作为 `{ thinking }` 传第 4 参；适配器只声明三参也不会报错。S 侧无需再改。
- [S→P] `Connection` 请按 §1.1 增加可选 `label` / `modelOverrides`；S 目前用本地的 `ServerConnection extends Connection`（`apps/server/src/services/providers.ts`）顶着并在解析时填好这两个字段，P 加完即可删掉该接口。
- [S→P] **中转站鉴权失败仍回 HTTP 200 的坑**（真机实测）：Z.AI 的 Anthropic 兼容端点 `https://api.z.ai/api/anthropic`，Key 无效时 `GET /v1/models` 返回 **HTTP 200**，body 为 `{"code":401,"msg":"token expired or incorrect","success":false}`。当前 `listModels` 把它当成空列表，于是 `POST /connections/:id/test` 误报 `ok:true, modelCount:0`。建议在 `listModels` / `providerFetch` 里把「2xx 但 body 含 `success:false` 或 `code` 为非 2xx 数值、且没有 `data`/`models` 数组」也归一化成 `ProviderError{kind:'auth'|'invalid'}`。S 侧已临时在 `modelCount === 0` 时给 `/test` 响应加 `warning?: string`。流式生成路径没问题：坏 Key 的 401 已被正确归一化成 `kind:'auth'`。
- [S→W] **错误码清单**（响应体 `error` 字段）：`invalid` / `not_found` / `no_connection` / `provider_error`（带 `kind`：`auth|rateLimit|overloaded|contextLength|filter|invalid|network`）。状态码：`GET /connections/:id/models` 上游失败 → **502**；`POST /connections/:id/test` 上游失败 → **400**（照 §3.2 原文写的，故意不一致）；`/capabilities` 适配器未注册 → 400 `provider_error`。
- [S→W] `GET /api/models/catalog` 返回 `{ version, updated, models }`（`models` 就是 catalog 的 `models[]`），不是裸数组。
- [S→W] 生成 SSE 的实际事件顺序（真机实测 glm-5.3-flash，Anthropic 与 OpenAI 兼容端点一致）：`node`（仅当传了 `userMessage`，user 节点）→ `node`（assistant，`parts: []`，`provider/model` 已填）→ `reasoning.delta*` → `text.delta*` → `usage?` → `done`。约定：
  - 出错时以 `error` 结尾且**不发** `done`。`error.data.nodeId` **存在** = 已有部分文本、节点保留并已持久化；`nodeId` **缺失** = 节点已删除、head 已回退。
  - 客户端 abort 时服务端持久化已累积内容、写 `extra.stopReason='abort'`，**不发** `done`（与 W 的「停止后重新 GET 详情」一致）。
  - 首包是 2 KB 的 `:` 注释填充，之后每 15 s 一个 `: ping`；SSE 解析器必须忽略以 `:` 开头的注释行。
  - `reasoning.opaque` 不作为 SSE 事件下发，只在 `done` 的 `node.reasoning.opaque` 里出现（Anthropic 侧实测能拿到带签名的块）。
- [S→W] `GET/PUT /api/settings/:key` 保持 M1 的信封 `{ key, value }`（`app.test.ts` 有断言，契约 §3.3 写的是「已有 settings 路由即可」），所以 `useGenerationDefault` 请读 `.value`：`GET /api/settings/generation.default` → `{ key: 'generation.default', value: { connectionId, model } }`；PUT 的请求体是裸的 `{ connectionId, model }`，响应同样带信封。键不存在时 GET 返回 404，前端按「未设置」处理。
- [S→W] `PATCH /api/chats/:id`、`GET /api/chats/:id`、`POST /api/chats` 都返回 `ChatDetail`（含 `nodes`）；`POST /api/chats/:id/messages` 返回 `{ node, chat: ChatSummary }`；`DELETE /api/chats/:id/nodes/:nodeId` 返回 `{ chat: ChatSummary }`。
- [S→契约] 服务端未新增 Drizzle 迁移：连接/模型走 `chats.overrides` JSON，`connections` / `model_cache` / `generation_log` 用的都是 M0 已有的列。
