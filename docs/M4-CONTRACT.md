# M4（一）契约：ST 迁移收尾、多模态、长对话与命令面板

| 项目 | 内容                                                                                     |
| ---- | ---------------------------------------------------------------------------------------- |
| 版本 | v1（2026-09-16）                                                                         |
| 范围 | M1 遗留的 ST 迁移 + M4 的多模态输入、模型生图输出、画廊/灯箱、命令面板、虚拟化与代码分割 |
| 不含 | 背景、立绘表情、外接生图后端（SD / ComfyUI / NovelAI）、主题导入导出 → M4（二）          |

先读：`docs/PLAN.md`（总计划）、`docs/DESIGN.md`（任何前端改动前必读）、`docs/M2-CONTRACT.md` / `docs/M3-CONTRACT.md`（接口与已修正事项）。
本文与代码冲突时，先改本文再改代码；实现中发现本文写错，在 §9 追加「修正」小节注明日期与代号。

---

## 0. 分工与所有权

| 代号 | 内容                                                   | 独占的目录 / 文件                                                                                                                                                                                                                                                                                                          | 波次            |
| ---- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| P4   | 提供商：多模态渲染、生图输出解析、请求体脱敏           | `packages/providers/**`                                                                                                                                                                                                                                                                                                    | 一              |
| MG   | ST 迁移：聊天 jsonl 导入导出、目录迁移向导             | `packages/compat/**`；`apps/server/src/{services/importer.ts, services/chat-transfer*.ts, services/st-migration*.ts, routes/import.ts, routes/chat-transfer.ts, routes/migration.ts}` 及对应测试；`apps/web/src/features/migration/**`、`apps/web/src/features/chat/ChatListPane.tsx`、`apps/web/src/lib/api-migration.ts` | 一              |
| UX   | 长对话性能、代码分割、命令面板                         | `apps/web/src/features/chat/{MessageList.tsx, ChatPage.tsx}`、`apps/web/src/app/{router.tsx, AppLayout.tsx, store/ui.ts}`、`apps/web/src/features/palette/**`、`apps/web/vite.config.ts`；服务端只动 `apps/server/src/services/chat-tree.ts` 的 `toMessageNode`                                                            | 一              |
| MSS  | 多模态服务端：上传、附件入树、组装内联、生图落库、清理 | `apps/server/src/{routes/assets.ts, routes/chats.ts, services/assets.ts, services/assemble-input.ts, services/provider-request.ts, services/media*.ts}` 及对应测试；`packages/core/src/prompt/assemble.ts`（只为 §3.6 的 `{{persona}}`）                                                                                   | 二（P4 完成后） |
| MSW  | 多模态前端：输入托盘、消息附件、灯箱、画廊、生图开关   | `apps/web/src/features/chat/{Composer.tsx, MessageItem.tsx, ChatView.tsx, SessionPanel.tsx, SessionSettings.tsx, useGeneration.ts}`、`apps/web/src/app/store/chat.ts`、`apps/web/src/components/{Lightbox.tsx, Attachment*.tsx}`、`apps/web/src/features/settings/SettingsPage.tsx`                                        | 二（P4 完成后） |

**共享文件规则**（多个代理会同时改）：`apps/server/src/app.ts`、`apps/web/src/lib/api.ts`、`packages/i18n/src/{zh-CN,en}.json`。
只用 Edit 做**局部**替换（每次先重新 Read），不得整文件重写、不得重排或格式化别人的段落；i18n 新键放在自己的顶层命名空间里
（MG：`migration.*` 与 `chat.transfer.*`；UX：`palette.*`；MSW：`chat.attach.*`、`lightbox.*`、`gallery.*`、`settings.storage.*`）。
`api.ts` 里只追加类型与 hook；MG 的 hook 放 `lib/api-migration.ts`。

**测试隔离**：真机/端到端验证一律 `NT_DATA_DIR=<会话 scratchpad>/<代号>-data` + 自己的端口（MG 8801、UX 8802 / web 5182、MSS 8803、MSW 8804 / web 5184），
不要用 8787 / 5173，**不要往 `data/default`（用户的库）写任何东西**。不读 `D:\Projects\SillyTavern\data\default-user\secrets.json`。

**不改表结构**：本轮所有新数据都放进已有的 JSON 列（`assets.meta`、`chats.metadata`、`message_nodes.extra`、`settings`），不新增 Drizzle 迁移。
用户本机的开发服务端（8787 / 5173）正在跑，热重载会加载你的改动——保证每次保存后服务端仍能启动，不要留半成品的语法错误过久。

**提交**：代理不提交、不推送，由主会话集成后统一提交。完成时回报：改了哪些文件、测试结果、未做与偏离契约之处。

Step 0 已由主会话完成：`Part` 的 image / document 加了可选 `name`；`features/migration/MigrationPage.tsx` 桩文件并接到 `/migration` 路由。

---

## 1. 共享类型

### 1.1 `packages/core/src/prompt/ir.ts`（已改）

```ts
| { type: 'image'; assetId: string; mime: string; name?: string }
| { type: 'document'; assetId: string; mime: string; name?: string }
```

`document` 的 mime 只有两类：`application/pdf`，或文本类（`text/*`、`application/json`）。

### 1.2 `packages/providers/src/types.ts`（P4 加）

```ts
/** 服务端预先读出的资产内容（base64 不带 data: 前缀） */
export interface ResolvedAsset {
  mime: string;
  base64: string;
  name?: string;
}

export interface BuildOptions {
  thinking?: ThinkingOptions;
  /**
   * 资产解析器。提供时 image / document 渲染为各家原生内联块；
   * 缺省（检查器预览、黄金测试）时保持 `asset:<id>` 占位，不告警「需替换」。
   */
  resolveAsset?: (assetId: string) => ResolvedAsset | undefined;
  /**
   * 请求模型输出图片。undefined = 按默认：google / openai-chat 在 caps.imageOut 时开，
   * openai-responses 关（image_generation 工具单独计费）。true / false = 显式开关。
   */
  imageOutput?: boolean;
}

/** 把请求体里的内联媒体（data URL、长 base64）替换成占位串，供落库与检查器展示 */
export function redactInlineMedia(body: unknown): unknown;
```

### 1.3 SSE 与节点（MSS ↔ MSW）

- `POST /api/chats/:id/generate` 请求体：`userMessage?: { text: string; name?: string; attachments?: string[] }`（assetId，按顺序）。
- 新 SSE 事件 `image`：`{ nodeId: string; part: { type: 'image'; assetId: string; mime: string } }`，在收到提供商 `image` 事件、资产落盘后发出。
- `done` 里的 `node.parts` 是**最终顺序**：文本与图片按到达顺序交错（连续文本增量合并进同一个 text part）。
- `ChatOverrides.imageOutput?: boolean`（缺省 = 按 §1.2 默认）。

---

## 2. MG：ST 迁移

### 2.1 纯转换 `packages/compat/src/st/chat-tree.ts`

```ts
export interface TreeNodeDraft {
  tempId: string; // 'm12' / 'm12s1'（第 12 条消息的第 1 个 swipe）
  parentTempId: string | null;
  siblingSeq: number;
  role: 'user' | 'assistant' | 'system';
  name: string | null;
  text: string;
  isHidden: boolean;
  createdAt: number; // ms；保证严格递增（见下）
  reasoning: string | null;
  media: StMediaRef[]; // extra.media / 旧 extra.image / image_swipes 归一后的图片引用
  files: StFileRef[]; // extra.files（文本附件）
  /** 原样保留，导出时以它为底 */
  st: {
    rest: Record<string, unknown>;
    extra?: Record<string, unknown>;
    swipeInfo?: unknown;
    sendDate?: unknown;
    mes?: string;
  };
}
export function stChatToTree(chat: ImportedChat): {
  header: ImportedChatHeader;
  nodes: TreeNodeDraft[];
  headTempId: string | null;
  warnings: string[];
};
export function treeToStChat(input: {
  header?: ImportedChatHeader;
  path: ExportNode[];
  siblingsOf: (node) => ExportNode[];
}): { chat: ImportedChat; droppedBranches: number };
```

映射规则（对照 `D:\Projects\SillyTavern\public\script.js` 与 `public/scripts/chats.js` 核实，不一致以 ST 为准并记入 §9）：

- 角色：`extra.type === 'narrator'` → system；`is_user` → user；其余 assistant。`is_system: true` → `isHidden`。
- swipes：第 i 条消息若有 `swipes`，每个 swipe 一个兄弟节点（siblingSeq = swipe 下标），`swipe_id` 指向的那个接后续消息；
  其余是无后代兄弟。`swipe_info[k]` 的 `send_date` / `extra` 属于第 k 个兄弟。没有 `swipes` 就是单节点。
- `extra.reasoning` → `reasoning`；`send_date` 解析 ST 的几种格式（`humanizedDateTime`、`"July 31, 2026 11:01am"`、ISO、epoch 数字）；
  解析失败或不递增时取 `前一个 + 1ms`，保证 `loadNodes` 的时间序与消息顺序一致。
- 媒体归一照 ST `migrateMediaToArray`（`image` / `image_swipes` / `video` → `media[]`；`file` → `files[]`）。
- 导出：root→head 路径每个节点一条消息；该节点的**无后代兄弟**回填 `swipes`（按 siblingSeq，`swipe_id` = 路径节点位置）；
  **有后代的兄弟是分支，不可导出**，计入 `droppedBranches`。节点有 `st` 时以它为底叠加当前 text / swipes / reasoning / is_system。
  图片与文件附件不导出文件本体（`extra.media` 保留原 url；新上传的附件不写入），计入告警。
- 测试：合成用例覆盖 swipes、分支、隐藏、narrator、媒体迁移；本机样本（`NT_ST_DATA_DIR` 可选）全部聊天 **导入→导出 deep-equal**。

### 2.2 服务端：聊天导入导出

- `services/chat-transfer.ts`：
  - `importStChat(db, assets, { fileName, bytes, characterId?, mediaRoot? })`：一个事务内**批量插入**（预生成 id，不要逐条 `insertNode`，它每次全表读节点）。
    - 标题 = 文件名去 `.jsonl`；`characterId` 缺省时按 `header.character_name` 精确匹配唯一角色，匹配不上就不绑角色（告警）。
    - `chats.metadata.st = { header, sourceHash }`（sha256 of bytes）；`chat_metadata.note_*` → `metadata.authorsNote`（形状见 `services/authors-note.ts`，
      `note_position` / `note_role` / `note_depth` / `note_interval` 对应）；`chat_metadata.world_info`（书名）→ `chat_lorebooks` 按名匹配；
      `chat_metadata.variables` → 根节点与 head 节点的 `variables` 快照。
    - 节点 `extra.st` = draft.st；`mediaRoot`（目录迁移时 = ST 用户目录）存在时把 `media[].url`（`/user/images/...`、`user/images/...`）
      与 `files[].url`（`/user/files/...`）解析成文件、存资产、追加 image / document part；否则只保留在 `extra.st` 并计告警。
    - 返回 `{ chat: ChatSummary, messageCount, nodeCount, warnings }`。
  - `exportStChat(db, chatId)` → `ExportedFile`（`<标题>.jsonl`）+ `droppedBranches`。
- 路由：`POST /api/import/chat`（multipart：`file`，可选 `characterId`）→ 201；
  `GET /api/chats/:id/export`（`routes/chat-transfer.ts`，在 `app.ts` 里第二次 `.route('/chats', …)` 挂载）→ 下载，响应头 `X-NT-Dropped-Branches`。
- `importer.ts` 的 `KIND_HINTS.chat` 改成「这是 SillyTavern 聊天记录，请在对话列表里导入」。

### 2.3 服务端：目录迁移

`services/st-migration.ts` + `routes/migration.ts`（挂 `/api/migration`）。

- **只允许本机**：请求来源不是回环地址（`127.0.0.1` / `::1` / `::ffff:127.0.0.1`，从 `c.env.incoming.socket.remoteAddress` 取）→
  403 `{ error: 'forbidden', message: '迁移会读取这台电脑上的文件夹，只能在运行服务端的电脑上打开本页操作' }`。
- `POST /api/migration/st/scan` `{ path }`：
  - 接受 ST 根目录（有 `data/`）、`data/`、或用户目录（有 `settings.json` 或 `characters/`）。多个用户时返回 `{ users: [{ name, path }] }` 让前端选。
  - 返回清单：
    ```ts
    interface StInventory {
      root: string;
      characters: { file: string; name: string; exists: boolean; chatCount: number }[];
      chats: { file: string; characterFile: string | null; title: string; exists: boolean }[]; // file 相对 chats/
      groupChats: number; // 暂不迁移，只报数
      presets: { file: string; name: string; exists: boolean }[]; // OpenAI Settings/*.json
      lorebooks: { file: string; name: string; entryCount: number; exists: boolean }[]; // worlds/*.json
      regex: { count: number; newCount: number }; // settings.json extension_settings.regex
      personas: { avatar: string; name: string; exists: boolean }[]; // power_user.personas + persona_descriptions
      defaultPersona: string | null; // power_user.default_persona
      worldInfo: { globalBooks: string[]; hasSettings: boolean };
      skipped: {
        backgrounds: number;
        instruct: number;
        context: number;
        themes: number;
        quickReplies: number;
      }; // 只报数
    }
    ```
  - `exists` 判重：角色按原件 sha256（`characters.original_hash`）；预设 / 世界书按同名；聊天按 `metadata.st.sourceHash`；
    档案按「同名且头像 sha256 相同」；正则按 `scriptName + findRegex`。
- `POST /api/migration/st/run` `{ path, select }`，SSE：
  - `select = { characters: string[]; chats: string[]; presets: string[]; lorebooks: string[]; personas: string[]; regex: boolean; worldInfo: boolean; defaultPersona: boolean }`
  - 顺序：世界书 → 角色 → 档案 → 预设 → 正则 → 世界书全局设置 → 聊天（聊天要用到前面建立的 角色文件名→id、书名→id 映射；
    未勾选但库里已有同 hash 的角色也要能关联）。
  - 事件：`item { category, file, status: 'imported' | 'skipped' | 'failed', id?, message? }`；`done { counts, warnings }`。单项失败不中断。
  - 档案：`User Avatars/<avatar>` 存头像；`persona_descriptions[avatar]` 的 `description / title / position / depth / role / lorebook` 对应
    `personas` 表（position 数字 → `in_prompt(0) / top_an(2) / bottom_an(3) / at_depth(4) / none(9)`；role 0/1/2 → system/user/assistant；lorebook 按书名）。
    `defaultPersona` 勾选时写设置 `defaultPersonaId`。
  - 世界书全局设置：`world_info_settings` 映射到 `worldInfo.settings`（`services/wi-settings.ts` 的 `WIUiSettings`），`world_info.globalSelect` 书名 → `worldInfo.globalBookIds`。
  - 聊天：`chats/<角色文件名去扩展名>/*.jsonl`，`mediaRoot` = 用户目录。
- 测试：用临时目录构造迷你 ST 目录做单测；另有可选测试（`NT_ST_DATA_DIR`）对本机样本 scan + run 到临时库，断言无 failed。

### 2.4 前端

- `/migration`（`features/migration/MigrationPage.tsx`）：三步——**选目录**（路径输入，示例 `D:\SillyTavern` 或 `…\data\default-user`，多用户时选用户）→
  **清单**（按类别分组的勾选列表，新项默认勾选、已存在的默认不勾并标「已在库中」，类别头显示「勾选 / 总数」与全选；`skipped` 一行说明哪些东西这一版不迁移）→
  **迁移中 / 完成**（逐项进度流，失败项可展开原因；完成后给去角色 / 预设 / 世界书 / 对话的入口）。
  非本机访问时整页只显示 403 的说明。视觉只用材质类与槽位（DESIGN §2），六个主题下都要成立。
- 对话列表（`ChatListPane.tsx`）：头部加「导入聊天记录」（`.jsonl`）→ 小弹窗选角色（按 `character_name` 预选匹配项，可选「不绑定角色」）→ 上传 → 打开导入的对话；
  每项的操作里加「导出为 SillyTavern 聊天记录」，`X-NT-Dropped-Branches > 0` 时提示「有 N 条分支不在当前路径上，没有导出」。

---

## 3. P4 / MSS / MSW：多模态

### 3.1 P4：渲染（有 `resolveAsset` 时）

| 适配器           | image                                                        | document: PDF                                                                           | 助手角色里的图片                  |
| ---------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------- | --------------------------------- |
| openai-chat      | `{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}` | caps.documentIn 时 `{type:'file', file:{filename, file_data:'data:…'}}`，否则丢弃并告警 | 丢弃并告警（接口不接受）          |
| openai-responses | `{type:'input_image', image_url:'data:…'}`                   | `{type:'input_file', filename, file_data:'data:…'}`                                     | 丢弃并告警                        |
| anthropic        | `{type:'image', source:{type:'base64', media_type, data}}`   | `{type:'document', source:{type:'base64', media_type:'application/pdf', data}}`         | 丢弃并告警                        |
| google           | `{inlineData:{mimeType, data}}`                              | 同左                                                                                    | 保留（model 角色可带 inlineData） |

- caps.imageIn 为 false：丢弃全部 image part，告警「模型不支持图片输入，已丢弃 N 张图片」。caps.documentIn 为 false 的 PDF 同理。
- 文本类 document 不应到达适配器（MSS 在组装前内联，§3.3）；万一到达，按 `resolveAsset` 解码为文本块。
- `resolveAsset` 返回 undefined：丢弃并告警「找不到资产 <id>」。
- 顺序：一条消息里 text 与媒体的相对顺序保持；Anthropic 建议图片在文本前——**不要重排**，保持 parts 顺序（与用户看到的一致）。

### 3.2 P4：生图输出与能力

- google：`imageOutput` 生效时 `generationConfig.responseModalities = ['TEXT','IMAGE']`；已有的 inlineData → `image` 事件保留；
  图片 part 上的 `thoughtSignature` 按现有 opaque 机制回传。
- openai-responses：`imageOutput === true` 时 `tools` 追加 `{ type: 'image_generation' }`（与已有 tools 合并）；解析保留。
- openai-chat：`imageOutput` 生效时加 `modalities: ['image','text']`；解析 OpenRouter 形态：流式 `choices[0].delta.images[]`、非流式 `message.images[]`，
  元素 `{ type:'image_url', image_url:{ url:'data:image/png;base64,…' } }` → `image` 事件（非 data URL 的 http 链接：`image` 事件不支持，告警并把链接作为 Markdown 图片文本输出）。
- anthropic：`imageOutput === true` 告警「该提供商不支持图片输出」。
- 目录：核对 `catalog.json` 的 imageIn / documentIn / imageOut（GPT-4o/4.1/5 系与 o 系 imageIn+documentIn；Claude 全系 imageIn+documentIn；
  Gemini 全系 imageIn+documentIn，`*-image*` 模型 imageOut；GLM 文本模型与 DeepSeek 均为 false）。不确定的保持保守（false）并在注释里说明依据。
- `redactInlineMedia`：深度遍历，`data:<mime>;base64,<…>` 串 → `data:<mime>;base64,<省略 N 字节>`；
  Anthropic `source.data`、Google `inlineData.data`、Responses 生图结果等长 base64（>512 字符且仅 base64 字符）→ `<base64 省略 N 字节>`。纯函数，不改入参。
- 测试：四个适配器 × {有 / 无 resolver、imageIn 为 false、助手图片、PDF}；生图解析回放（Gemini inlineData、Responses image_generation_call、OpenRouter delta.images）；redact。

### 3.3 MSS：服务端

- **上传** `POST /api/assets`（multipart `file`）→ 201 `{ id, kind:'upload', mime, name, size, width?, height?, pages?, textLength? }`。
  - 按魔数/扩展名判定，只收：`image/png|jpeg|webp|gif`、`application/pdf`、文本类（`.txt .md .markdown .json .csv .log .yaml .yml .xml .html` 且能按 UTF-8 解码）。
    其余 415 `{ error:'unsupported', message }`。上限 20 MB（413）。
  - `services/assets.ts` 的宽高读取补齐 JPEG / WebP / GIF。
  - PDF：尝试抽取文本存 `assets.meta.text`（上限 50 万字）与 `meta.pages`；可选依赖 `unpdf`（纯 JS）。抽取失败不报错，`meta.text` 为空。
  - `meta.name` 存原文件名。同 sha256 去重已有；去重命中时仍返回（名字以本次上传为准返回，不改库）。
- **入树**：`generate` 的 `userMessage.attachments` 与 `POST /:id/messages` 的 `attachments?: string[]` → parts `[text, ...媒体]`
  （image/document 由资产 mime 决定，带 `name`）。不存在的 assetId → 400。文本为空但有附件允许发送。
  `PATCH /:id/nodes/:nodeId` 加 `attachments?: string[]`：替换该节点全部 image/document part（text 保留）。
- **组装前内联**（`assemble-input.ts` 的 history 映射）：
  - 文本类 document → 按 ST `appendFileContent`：`fileTexts.join('\n\n') + '\n\n' + 原文本`，part 本身去掉；
  - PDF：`caps.documentIn` 时保留 part；否则若 `meta.text` 非空按文本内联（前缀一行 `[<文件名>]`），为空则保留 part 交给适配器告警丢弃；
  - image 原样保留（适配器按 caps 处理）。
- **发请求**：`provider-request.ts` 收集 IR 里全部 assetId，预读成 Map，传 `resolveAsset`；`overrides.imageOutput` 传 `imageOutput`。
  `requestForStorage` 先 `redactInlineMedia` 再判体积。inspect 仍不传 resolver（占位）。
- **生图落库**：`image` 事件 → `assets.save({ kind:'generated', source:'generated:<nodeId>' })` → parts 追加 → SSE `image`。
  「无文本即删节点」的判断改成「无文本且无图片」。中止时已收到的图片保留。
- `overrides.imageOutput` 的 PATCH 校验（boolean 或 null = 删键）。
- **清理** `POST /api/assets/gc` → `{ removed, freedBytes }`：删除「创建超过 24 小时、且不被 characters / personas 头像、任何节点 parts、
  `characters.data` 里的资产引用」的 `upload` / `generated` / `avatar` 资产的行与文件。`card_embedded` 不动。
- **`{{persona}}` 修正**（`packages/core/src/prompt/assemble.ts`）：角色卡字段里的 `{{persona}}` 目前展开为空（种子上下文缺 persona）。
  对照 ST 1.18 `getCharacterCardFields` / `substituteParams` 核实展开顺序后修，黄金测试须仍 62/62；若 ST 行为与直觉不同，照 ST 并记 §9。
- 测试：上传判定与限额、附件入树、内联规则、resolver 与脱敏、生图落库（用假适配器发 `image` 事件）、GC 不误删。

### 3.4 MSW：前端

- **输入托盘**（`Composer.tsx`）：附件按钮（选择文件，`accept` 同上）、粘贴图片、把文件拖到对话区（`ChatView.tsx` 放下区域，拖入时整块出现一层提示）。
  托盘在输入框上方：图片是缩略图，文档是「图标 + 文件名 + 大小」小片，每项可移除；上传中显示进度且发送键不可用；上传失败的项标红可重试。
  当前模型 `imageIn` / `documentIn` 为 false 时，托盘下一行轻提示「当前模型看不到图片，发送时会被丢弃」（PDF 有抽取文本时提示「将以文本发送」）。
  能力来源：沿用会话面板取模型能力的方式（`/api/models` 或节点 `extra.capabilities`），找不到能力时不提示。
- **消息里的附件**（`MessageItem.tsx`）：按 parts 顺序渲染——图片为自适应网格（1 张原比例限高、2–4 张两列方格、更多三列），文档为小片；
  点击图片打开灯箱；流式中收到的 `image` 追加在正文后，`done` 后按最终顺序。编辑模式下附件可移除（保存时 PATCH `attachments`）。
- **灯箱**（`components/Lightbox.tsx`）：全屏遮罩、左右切换、Esc 关闭、下载原图、手机左右滑动；`role="dialog"` 与焦点圈定。
- **画廊**：会话面板加「图片」分区，列出本对话**所有节点**（不只当前路径）的图片，新的在前，点击进灯箱。
- **生图开关**：会话设置里在当前模型 `imageOut` 为 true 时出现「允许模型输出图片」，写 `overrides.imageOutput`。
- **存储清理**：设置页加「存储」分区，一个「清理未使用的文件」按钮 → `POST /api/assets/gc`，显示结果。
- 挂点：`data-part="composer-tray" | "attachment" | "message-media" | "lightbox" | "gallery"`，供主题覆盖形态。

---

## 4. UX：长对话、代码分割、命令面板

- **载荷瘦身**（`chat-tree.ts` 的 `toMessageNode`）：返回给前端的节点 `extra` 去掉 `request`、`layout`、`activations`、`st`（前端没有用到；检查器走 inspect 端点）。
  改前 grep 确认 web 与服务端测试不依赖这些字段；导出/检查器直接读行，不经 `toMessageNode`。
- **虚拟化**（`MessageList.tsx`）：`@tanstack/react-virtual`，动态高度（`measureElement`），`MessageDivider` 放进虚拟项内部。
  必须保留：切换对话直接落底；贴底时流式增量与新消息自动跟随；上滑后出现「回到底部」；空对话引导与末尾错误卡；
  `data-part="message"` / `data-index` / `data-role` 等主题挂点不变（书斋的回目、酒馆的铆钉依赖它们）。
  去掉 `motion.article` 的 `layout` 动画（与虚拟化冲突），新消息仍只做透明度出现。这一处在 `MessageItem.tsx`：UX 在第一波可以只改这一个属性，
  MSW 第二波开始时 UX 已改完（MSW 以磁盘上的版本为准）。
  验收：合成 2000 条消息的对话，首屏渲染 DOM 里的 `[data-part="message"]` 不超过 40 个，滚动到顶再回底无跳动，流式跟随正常。
- **代码分割**：路由页面 `React.lazy` + 主题化的轻量 `Suspense` 占位；`vite.config.ts` 按依赖拆分 vendor（markdown 系、framer-motion、react 系）。
  回报 `vite build` 前后的主包与各 chunk 体积。字体保持按主题懒加载，不要因此回退成全量引入。
- **命令面板**（`features/palette/`）：`Ctrl/⌘ + K` 打开；导航栏加一个搜索入口给触屏。命令源：
  页面跳转、最近对话（按标题/角色名匹配，选中即打开）、角色（选中 = 用该角色新建对话）、切换主题（六个世界 + 支持时的模式）、
  对话页内的「打开检查器 / 会话面板」（通过 `store/ui.ts` 的请求通道，由 `ChatPage.tsx` 响应）。
  中文按子串匹配，拉丁字母不区分大小写；输入法组合中不触发导航；`↑↓` 选择、`Enter` 执行、`Esc` 关闭；`role="dialog"` + `combobox` / `listbox`。
  外观用 `surface-raised`、`field`、`chip` 等材质类，`data-part="command-palette"`，六个世界下都要成立、不得带入任何一个世界的专属材质。

---

## 5. 验收（主会话集成时做）

1. `pnpm -r run typecheck`、`pnpm test`（黄金 62/62）全绿；`pnpm lint` 无新增错误。
2. 迁移：对本机 `D:\Projects\SillyTavern\data\default-user` 在隔离库里 scan + run 全选，无 failed；导入的聊天导出后与原文件 deep-equal（无分支的）。
3. 多模态：mock OpenAI 兼容端点断言收到 `image_url` data URL 与 `file`；mock 返回 OpenRouter 形态图片，前端显示并进画廊；Z.AI 真机纯文本对话不受影响。
4. 长对话：2000 条合成对话打开、滚动、流式跟随正常。
5. 六个主题 × 桌面 1440 / 手机 390：对话页（含附件托盘、图片消息、灯箱）、命令面板、迁移页截图逐张审（DESIGN §2.5、§四）。

---

## 9. 待协调与修正

（格式：`- [代号→代号] 事项`；契约修正另起 `### 修正` 小节注明日期）

- [P4→MSS] `resolveAsset` 返回的 `base64` 不带 `data:` 前缀；`mime` 以资产表为准（优先于 part.mime），`name` 优先于 part.name 作 PDF 文件名（都没有时用 `<assetId>.pdf`）。适配器不缩放、不校验体积：Anthropic 单图 5 MB、Gemini 内联请求总计 20 MB 等上限由服务端在上传 / 组装时把关。
- [P4→MSS] `requestForStorage` 先 `redactInlineMedia(req.body)` 再判体积（从 `@newtavern/providers` 导入）；同时导出 `classifyDocumentMime`（`'pdf' | 'text' | 'other'`，§3.3 的内联规则可复用）、`parseDataUrl`、`toDataUrl`、`decodeBase64Utf8`。
- [P4→MSS] `GenEvent` 新增 `{ type: 'warning'; message: string }`（非致命；目前只有 openai-chat 收到 http 图片链接时发出）。建议并入节点 `extra.warnings`；忽略也不影响生成。
- [P4→MSS/MSW] 适配器告警文案（测试可按原文断言）：`模型不支持图片输入，已丢弃 N 张图片`、`模型不支持 PDF 输入，已丢弃 N 个 PDF`、`找不到资产 <id>，已丢弃`、`<OpenAI Chat|Responses|Anthropic|Gemini> 的 <角色> 消息不接受图片 / PDF，已丢弃 N 个`、`不支持的文档类型 <mime>，已丢弃 <id>`、`该提供商不支持图片输出，已忽略 imageOutput`（Anthropic）、`目录没有标注 <model> 支持图片输出，仍按请求开启`（显式 `imageOutput:true` 而 caps.imageOut 为 false）。
- [P4→MSW] 生图开关看 `caps.imageOut`：openai-responses 的 gpt-4o / gpt-4.1 / gpt-5 系 / o3 现在为 true（表示可挂 image_generation 工具，缺省关）；openai-chat 只有 OpenRouter 形态的 `google/gemini-*-image*`、`openai/gpt-5-image*` 为 true（缺省开）。
- [MG→UX] `vite.config.ts` 的 `/api` 代理建议加 `xfwd: true`。迁移接口的本机判定（§2.3）在开发模式下只能靠 Origin / Referer 挡住局域网浏览器；不带这两个头的非浏览器客户端（curl 等）经 `http://<局域网 IP>:5173` 访问时，服务端看到的对端是 Vite 代理的 localhost。加上后代理会写 `X-Forwarded-For`，服务端已按它拒绝。生产形态（服务端直接托管 web dist）不受影响。
- [MG→UX] `toChatSummary` 的 `metadata` 带着导入时保存的 `metadata.st.header`（ST 的 chat_metadata，本机样本每份 0.3–16 KB，含 MVU 变量），`GET /api/chats` 每项都会下发。会话多了之后建议列表摘要剥掉 `metadata.st`（前端不用它；导出直接读行）。
- [MG→MSS] 聊天导入 / 目录迁移从 ST 带过来的图片与文本附件存为 `kind:'upload'`、`source:'st-import'`、`meta.name` = 文件名，被节点 parts 引用；GC 按 parts 判引用即可。档案头像是 `kind:'avatar'`。
- [MG→主会话] `apps/server/src/app.test.ts`「传错页面时提示去哪里导入」一条的期望文案随 `KIND_HINTS.chat` 改成「这是 SillyTavern 聊天记录，请在对话列表里导入。」（只改这一行）。
- [MG→主会话] 新增 `data-part`（`themes/README.md` §5 不在 MG 所有权内，请补进清单）：对话列表 `chat-list-actions`（每项的删除 + 导出竖排一组；悬停 / 聚焦时出现，`pointer: coarse` 常显）；导入弹窗 `chat-import-form`、`chat-import-result`；迁移页 `migration-page`、`migration-forbidden`、`migration-steps`、`migration-step`（`data-active`）、`migration-source`、`migration-users`、`migration-review`、`migration-category`（`data-category="characters|chats|lorebooks|presets|personas|settings"`）、`migration-item`（`data-exists`、`data-error`）、`migration-skipped`、`migration-start-bar`（与 `preset-save-bar` 同形态）、`migration-run`、`migration-progress`、`migration-log`、`migration-log-item`（`data-status="imported|skipped|failed"`）、`migration-warnings`、`migration-next`。

### 修正（2026-09-16，P4）

1. **`redactInlineMedia` 的位置**：实现放在 `packages/providers/src/media.ts`，从包入口导出（不在 `types.ts`，`types.ts` 只放类型）。§1.2 的 `ResolvedAsset` / `BuildOptions` 按原文落在 `types.ts`。
2. **§3.2 openai-chat 的「告警」需要事件通道**：流式解析阶段没有 `ProviderRequest.warnings` 可写，故 `GenEvent` 增加 `warning` 事件（见上条 [P4→MSS]）。http 链接降级文本为 `![image](<url>)`，前面已有正文时先空一行。
3. **§3.1 表格只写了「助手角色里的图片」**：实际接口约束是「只有 user 消息能带图片 / PDF」。openai-chat 的 system / developer、Responses 的 developer、Anthropic 顶层 system 与 messages 内 `role:'system'`、Gemini 的 `systemInstruction` 里的媒体同样丢弃，按角色汇总告警。Gemini 的 model 角色照原文保留 inlineData。能力检查先于角色检查（imageIn 为 false 时计入「模型不支持图片输入」）。没有 resolver 时这些丢弃规则照样执行，检查器预览与真实请求一致。
4. **媒体全被丢弃后的空消息**：原文未提。Anthropic / Gemini 的空 content 会 400，照 ST `convertClaudeMessages` 的做法补一个零宽空格文本块（`​`）；Responses 跳过空 input 项（相邻 user 项 Responses 允许）；openai-chat 保持空字符串 content。
5. **§3.2 google「图片 part 上的 thoughtSignature 按现有 opaque 机制回传」**：现有机制只把签名按顺序挂到文本 part，生图模型（`gemini-3-pro-image` 等）的签名在 inlineData part 上，且可能与文本段交错，按顺序挂会错位。故扩展 opaque payload：`{ type:'thoughtSignature', thoughtSignature, partIndex, target: 'text'|'image', ordinal }`（ordinal = 该签名在那次响应里挂在第几个文本段 / 第几张图；文本段 = 被图片隔开的连续文本，与 §1.3「连续文本增量合并进同一个 text part」的落库形态一一对应）。回传时按 target+ordinal 挂回（相邻 model 节点合并时序号从各自推理块之后算起），目标不存在时退而挂第一个未签名的文本 / 图片 part；没有 target 的旧 payload 仍按顺序挂文本 part，已落库数据不受影响。另外 `thought: true` 的 inlineData（推理草图）不再发 `image` 事件。
6. **§1.2 `imageOutput:false` 在 Gemini 生图模型上**：生图模型不传 `responseModalities` 时默认就会出图，「显式关」若只是不加字段并不生效，故发 `responseModalities: ['TEXT']`；非生图模型显式 false 不加字段。
7. **§3.1 Responses 的 PDF 占位**：M2 的占位是 `input_file.file_id`，按本契约改为与真实请求同形的 `{ type:'input_file', filename, file_data:'asset:<id>' }`。`input_image` 未加 `detail`（官方为可选，缺省 auto）。
8. **§3.2 目录「o 系 imageIn+documentIn」**：o1-mini / o1-preview / o3-mini 官方无 vision，两个 OpenAI 协议下都单列为 false（o3-mini 在 Responses 下 imageOut 也为 false）；o1 / o3 / o4-mini 为 true。其他核对结果与依据写在 `catalog.json` 的 `_notes`，要点：
   - openai-chat 的 **provider 级 `imageIn: true` 保留**（M2 决定）。该协议是 OpenRouter 等网关的入口，模型 id 带前缀、目录匹配不到；前端目前没有编辑 `modelOverrides` 的界面，改成 false 会让网关上的视觉模型全部丢图且用户无从修正。已知纯文本模型（DeepSeek、GLM 文本模型、o1-mini 等）逐条写 false。`documentIn` 的 provider 级默认保持 false，只给 GPT-4o / 4.1 / 5 / 6 与 o1 / o3 / o4-mini 开。**主会话若倾向「未知一律 false」，改 `providers.openai-chat.capabilities.imageIn` 一处即可，测试只覆盖已登记模型。**
   - 新增 openai-chat `glm-*v`、`glm-*v-*`（GLM 视觉模型）imageIn=true；Anthropic 兼容端点下的 GLM 保持 false。
   - Responses 的 `gpt-image-*` 条目删除：它只能作 image_generation 工具的 `model` 参数，不能作 `/responses` 主模型。
   - Gemini 新增通配 `gemini-*-image*`（imageOut=true、thinking='none'）与 `gemini-3.1-flash-lite-image*`（上下文 / 输出取保守值 32768 / 8192）。

### 修正（2026-09-16，UX）

1. **§4 载荷瘦身「grep 确认测试不依赖这些字段」不成立**：`apps/server/src/chats.test.ts`（`done.node.extra.request.url`）与 `inspect.test.ts`（`done.node.extra.layout / activations / request.body`）断言的是 SSE `done` 里的节点。瘦身按原文放在 `toMessageNode`（生成的 `node` / `done` 事件、详情、PATCH 返回一律不带 `request / layout / activations / st`），这两处测试改为从 `message_nodes` 行读同样的字段，并加断言「节点不带这些键」。`extra.stopReason / capabilities / warnings` 照常下发（MSW 取能力要用）。
2. **§4 虚拟化的 DOM 结构**（主题挂点不变，结构有两点要让主题作者知道）：
   - `[data-part=message-list]` 现在是 `position: relative` 的滚动容器，里面是「撑高的占位 div + 每条消息一个 absolute 的 div + 尾部 div（生成中 / 错误卡 / 底部留白）」。每条消息的 div 与原内层列同宽同边距，`[data-part=message]` 是它的直接子元素——雨夜的 `[data-part='message-list'] > div > [data-part='message']` 仍然命中；酒馆缝线依赖的「message-list 的父级」也没变。
   - `MessageDivider` 渲染在**上一条**消息的 div 末尾（一个 `flex-col gap-message pt-message` 的小容器里），不再是列表的直接 flex 子项；留白总量与原来一致（有分隔物时上下各一个 `--gap-message`）。这样只有路径最后一条消息是 `:last-child`，暖房 `[data-part='message-list'] [data-part='message']:last-child` 的出现动画语义不变。
   - 虚拟项的下标属性用 `data-item-index`（`data-index` 仍只在 `[data-part=message]` 上，语义是路径下标）；滚动容器加了 `overflow-anchor: none`（位置修正由虚拟列表做）。
   - 滚出视口的消息会卸载，重新进入时 `MessageItem` 的透明度出现动画与主题的出现动画会再播一次（视口上下各预渲染 4 条，正常滚动时在视口外就播完了）。焦点在里面的消息（就地编辑中）滚出视口也不卸载。
3. **§4 代码分割的 Suspense**：边界放在 `AppLayout` 的 `<Outlet />` 外（`data-part="route-fallback"`，240 ms 后才出现一行 `.pulse-live` 的「加载中…」）。站内导航由 React Router 的过渡完成，停在旧页面直到新页面 chunk 就绪，不闪占位；首屏页面在 `router.tsx` 求值时就开始下载，其余页面浏览器空闲时预取。vendor 拆成 `react`（react / react-dom / scheduler / react-router）、`markdown`、`motion` 三块，后两块只随对话页 chunk 按需加载；字体包不参与拆分，仍按主题懒加载。
4. **§4 命令面板的请求通道**：`store/ui.ts` 新增不持久化的 `paletteOpen / setPaletteOpen` 与 `chatPanelRequest / requestChatPanel(tab) / clearChatPanelRequest(nonce)`；`ChatPage` 收到请求时**只打开**对应页签（已开着就停在那一页，不会像顶栏按钮那样切换成关闭）。`api.ts` 没有改动（面板复用 `useChats / useCharacters / useCreateChat`）。
5. **新增 `data-part`**（`themes/README.md` §5 不在 UX 所有权内，请主会话补进清单）：`command-palette-overlay`、`command-palette`（`role=dialog`）、`command-palette-header`、`command-palette-field`（`.field` 外框）、`command-palette-input`（`role=combobox`）、`command-palette-list`（`role=listbox`）、`command-palette-group`（`data-group="actions|chats|pages|characters|themes"`）、`command-palette-group-label`、`command-palette-item`（`role=option`，`data-active`、`data-group`、`data-current`）、`command-palette-marker`（选中项左侧 2px 强调短线）、`command-palette-empty`、`command-palette-footer`、`command-palette-trigger`（顶栏入口）、`route-fallback`。面板外观只用 `surface-overlay / surface-raised / edge-rule / field / chip-outline / chip-accent` 与 `bg-accent-soft / bg-accent`，六个世界都靠各自对材质类的覆盖成形；想要更强的世界感（酒馆的皮面、书斋的叠纸）由主题在 `@scope` 里给 `[data-part='command-palette']` 加。

### 修正（2026-09-16，MG）

1. **ST 新版 header 的名字是 `'unused'`**：ST 1.18 `saveChat` 写的 header 固定是 `{ chat_metadata, user_name: 'unused', character_name: 'unused' }`，也没有 `create_date`（本机 12 份聊天全部如此）。§2.2「按 `header.character_name` 精确匹配唯一角色」因此改为 compat `stChatNames`：header 里的名字不是 `'unused'` 时用 header，否则取第一条非用户、非旁白消息的 `name`；用户档案同理取第一条用户消息的 `name`（唯一匹配，否则默认档案）。前端导入弹窗的预选用同一规则。
2. **§2.1 `st` 的实际形状**（`StNodeSource`）：`{ rest; extra?; sendDate?; swipeInfo?; mes?; swipe?; group? }`。
   - 语义是「假如选中的是这个 swipe，这条消息长什么样」：路径节点存消息本身；其余兄弟存消息的键 + `swipe_info[k]` 的 `send_date / gen_started / gen_finished / extra`（ST `syncSwipeToMes` 切换 swipe 时就是这样抄回消息的）。`rest` 用 ST 键名，含 `name / is_user / is_system / force_avatar / gen_*` 等，保证键的有无也能还原。
   - `swipeInfo` 只在原 `swipe_info[k]` 与「由节点字段重建的元素」不同才存（避免推理全文存两份）；`mes` + `swipe` 只在原 `swipes[k]` ≠ 节点正文时存——本机样本有 11 条开场白 `mes ≠ swipes[swipe_id]`（未污染的聊天里 mes 已替换宏、swipes 没有，ST `syncMesToSwipe` 此时不回写），导出时正文未改就还原原 swipe。
   - `group = { message, size, index, infoLength }`：swipe 组「结构没变」（兄弟个数、顺序、来源消息一致）时 `swipe_info` 保持原长度（原来没有 `swipe_info` 就不写）；变了按兄弟整体重建。
   - 切到另一个 swipe 后导出，该兄弟若旁边的兄弟已有后代，后者按原规则算分支。
3. **§2.1 其他规则**：`is_user` / `is_system` 按 ST 的真值判断（不是 `=== true`），`extra.type === 'narrator'` 优先于 `is_user`；`swipe_id` 无效时取 `mes` 在 swipes 里的下标，否则 0，并告警；`send_date` 照 ST `parseTimestamp`——humanized 格式按 **UTC** 解释（ST 加 `Z`），`June 19, 2023 2:20pm` 按本地时间；时间起点取第一个能解析的消息时间（header 的 humanized 时间按 UTC 解释会与消息错开时区，只作兜底）。
4. **§2.1 额外导出**：`parseStDate`、`humanizedDateTime`、`normalizeStMedia`、`stChatNames`、`exportInputFromDrafts`（把草稿直接当树交给 `treeToStChat`，往返测试与导入预览用）；`chat-jsonl.ts` 增 `chatMessageToStRecord / chatMessageFromStRecord / chatHeaderToStRecord / chatHeaderFromStRecord`。`treeToStChat` 入参加可选 `names: { user?, character? }`（没有 `st` 的新节点缺 name 时的回退），`ExportNode = { id, siblingSeq, role, name, text, isHidden, createdAt, reasoning, hasChildren, st? }`，`siblingsOf` 返回含自身的全部同父节点。
5. **§2.2 导入细节**：
   - 预设 = 默认预设、档案按第 1 条（与新建对话一致）。`chat_metadata.world_info` 同名多本时优先 `scope='global'`。
   - 作者注释：header 里有任何一个 `note_*` 键就写 `metadata.authorsNote`（空文本也写——AN 为空时 anTop / anBottom 仍按 position 落位），非法值回落 ST 默认。`timedWorldInfo` 没有映射（ST 的 hash 键与我们的条目 id 对不上），只随 header 保留。
   - 聊天 `createdAt` = min(header 时间, 首条消息时间)，`updatedAt` = 最后一条消息时间（迁移后列表仍按原来的活跃时间排序）。节点 parts 总是 `[text, ...媒体]`（text 可为空串）。
   - `extra.stAssetIds`：从 ST 引用导入的资产 id，导出时这些不算「没写进文件的附件」。
   - 媒体：`data:` URL 不依赖 `mediaRoot`，单独导入也解码成资产；图片只收 png / jpeg / webp / gif（按魔数）；文件附件 pdf → `application/pdf`，其余须能按 UTF-8 解码，按扩展名给文本 mime（未知为 `text/plain`）；视频 / 音频、超过 20 MB、找不到的文件、`mediaRoot` 外的路径都只留在 `extra.st` 并计告警。
   - 导出时会话里改过的作者注释、聊天世界书、变量（head 路径上最近的快照）写回 header 的 `chat_metadata`，没改动原样；没有 `metadata.st` 的会话合成 header（`user_name` = 档案名或 User，`character_name` = 角色名或标题，`create_date` = humanized 本地时间）。
6. **§2.2 接口**：`POST /api/import/chat` 的 `characterId`：不带 = 自动匹配，**空串 = 不绑定角色**，不存在 → 400；201 返回 `{ chat, messageCount, nodeCount, warnings }`（`messageCount` 是 jsonl 消息行数，`nodeCount` 含 swipe 兄弟）。实现挂在 `importer.importChat`（同样先做「传错页面」识别，角色卡传进来会提示去角色页）。`GET /api/chats/:id/export` 另加响应头 `X-NT-Skipped-Attachments` 并设 `Access-Control-Expose-Headers`；文件名里的 `\/:*?"<>|` 与控制字符换成 `_`，mime `application/x-ndjson`。
7. **§2.3 本机判定加强**：TCP 对端必须是回环地址之外，请求若带 `Origin` / `Referer` / `X-Forwarded-For` / `X-Real-IP` / `X-Forwarded-Host`，它们也必须指向本机（Vite 开发代理 `host: true` 会把局域网浏览器的请求从 localhost 转过来）。`c.env.incoming` 缺失（进程内调用）一律 403。新增 `GET /api/migration/access`（本机 200 `{ ok: true }`，否则 403）供前端进页面判断。
8. **§2.3 scan**：
   - 识别用户目录时跳过 `_` 开头的目录（ST 的 `_storage` / `_uploads` / `_cache`）；路径两端的引号会去掉。
   - 角色只列 `characters/*.png` 顶层（子目录是表情立绘）；读不出卡的项带 `error`（前端不可勾）。预设 / 世界书 JSON 解析失败同样带 `error`。清单各项因此多一个可选的 `error` 字段。
   - **预设 / 世界书名 = 文件名**：ST 里它们就按文件名称呼（`ARGO1.4.json` 的 JSON 里 `name` 是 `ARGO_1.4`），迁移时用文件名建库（`importer.importPreset / importLorebook` 加 `options.name`），`globalSelect`、档案的 `lorebook`、聊天的 `world_info` 才对得上。预设判重同时比 JSON 里的 `name`；世界书判重只看非角色内嵌（`scope ≠ 'char'`）的书。
   - 聊天目录 ↔ 角色文件照 ST：`avatar.replace('.png', '')`（只替换第一个）。
   - `worldInfo.globalBooks` 兼容旧设置（`world_info` 为字符串 / 数组、或世界书设置平铺在 settings 顶层）。
9. **§2.3 run**：
   - SSE 开头多一个 `start { total }`；运行中异常发 `error { message }`；客户端断开后在两项之间停下。
   - `item.category` 取值 `lorebooks | characters | personas | presets | regex | settings | chats`：世界书全局设置与默认档案是 `category: 'settings'`、`file` 为 `worldInfo` / `defaultPersona`；正则逐条发，`file` 为 `scriptName`，库里已有（`scriptName + findRegex`）的是 `skipped`。`done.counts` 按类别给 `{ imported, skipped, failed }`。
   - 勾选了「已在库中」的项照样再导入一份（用户自己决定）；只有正则按判重跳过。
   - 世界书全局设置以库里现有值为底，只覆盖 ST 里有的键（`Number()` / `Boolean()` 照 ST `setWorldInfoSettings`），`world_info_budget > 100` 照 ST 改回 25；`globalSelect` 解析出的书与库里现有 `worldInfo.globalBookIds` **合并**（不覆盖用户已选的），找不到的书名计告警。
   - 档案：`position` 1（`AFTER_CHAR`，已废弃）照 ST 视为 `in_prompt`；`depth` 不是 0–10000 的整数回落 2；头像文件缺失 / 格式不支持时仍建档案，item 带 `message`。
   - 聊天的角色关联顺序：本次导入的 → 库里同原件 hash 的（未勾选也算）→ 按消息里的角色名匹配（第 1 条）。

### 修正（2026-09-16，MSS）

**多模态服务端**

1. **上传响应**：`POST /api/assets` → 201 `{ id, kind, mime, name, size, width?, height?, pages?, textLength? }`。`kind` 是库里那一行的实际 kind（去重命中别处存的同内容文件时可能不是 `upload`）。`textLength`：文本类 = 解码后字符数；PDF = `meta.text` 长度（抽取失败为 0，行里 `meta.text = ''`）；图片不给。413 `{ error:'too_large' }`、415 `{ error:'unsupported' }`、缺文件 / 非 multipart / 空文件 400。去重命中且那一行是没抽过文本的 PDF（例如聊天导入存的）时补抽 `meta.text`，名字不改。
2. **文本类 mime**：`.txt/.log → text/plain`、`.md/.markdown → text/markdown`、`.json → application/json`、`.csv → text/csv`、`.yaml/.yml → text/yaml`、`.xml → text/xml`、`.html → text/html`（都落在 `classifyDocumentMime` 的 `text` 类）。含 NUL 视为二进制。`GET /api/assets/:id/file` 对非图片非 PDF 的资产一律回 `text/plain; charset=utf-8` + `CSP: sandbox`（上传的 .html 同源打开不执行），全部带 `nosniff`。
3. **attachments 元素**：除 assetId 字符串外也接受 `{ id, name? }`（同内容换名重传时，名字以这次为准写进 part）；`generate` / `POST messages` / `PATCH nodes` 三处一致。资产不存在或 mime 不能作附件 → 400 `{ error:'invalid', message }`（generate 在开流前校验）。`POST messages` 只带附件时 `text` 可省略。`PATCH nodes` 的 `attachments: []` / `null` = 移除全部附件；改附件同改正文一样清下游 `reasoning.opaque`。
4. **空文本 part**：有媒体时不存 `{ type:'text', text:'' }`（只发附件的消息 parts 里没有文本 part；PATCH 同理）。原因是 Anthropic 拒绝空文本块，而适配器目前会把空文本 part 原样渲染成块 —— **[MSS→P4]** 建议 anthropic / google 渲染时跳过空文本块（历史数据里仍可能有），未实测。
5. **内联的位置与差异**：文件文本拼在第一个文本 part 前（没有就新建）；多个文档与「有抽取文本的 PDF」按附件顺序进 `fileTexts`。与 ST 的差异：ST 先对消息跑提示词正则再拼文件文本（`script.js` Generate 里 `getRegexedString` → `appendFileContent`），我们拼好后整段交给组装器，文件文本也会经过提示词正则与宏替换，`{{lastUserMessage}}` 也会带上文件文本；要逐字对齐需要组装器支持「不做正则 / 宏的前缀」，本轮未做。
6. **检查器**：`buildInspect(db, context, assets?)` 多一个参数，文档与真实请求一样先内联；imageOutput 也传给检查器的 buildRequest。图片 / PDF 仍是 `asset:<id>` 占位。`POST /api/inspect/compare` 未接资产（文档附件显示占位）。改动了 `services/inspect.ts`（无主文件）。
7. **节点告警**：`extra.warnings` = 组装告警 + 适配器 `request.warnings`（如「模型不支持图片输入，已丢弃 N 张图片」）+ 流式 `warning` 事件，去重。
8. **生图落库**：mime 以文件头为准，认不出时只接受 PNG / JPEG / WebP / GIF，其他（如 SVG）不落库、记告警。按 sha256 去重，同一张图第二次生成返回第一次的资产行（`source` 指向第一次的节点）。组装 / 适配器抛异常时，已收到文本或图片的节点不删，写入已收到的 parts（`extra.stopReason: 'error'`），否则生成图没有任何节点引用。
9. **GC**：除契约列出的引用外，保守地把 `chats.metadata`、`settings` 里出现的 id 也算引用（背景等以后放那里）。另外进程内记「最近 24 小时被上传端点返回过」的 id，GC 跳过——去重命中的老资产 createdAt 很早，用户可能正要发送。
10. **ChatOverrides.imageOutput** 加在 `services/chat-tree.ts` 的类型上（只加一个字段，没动 `toMessageNode`）。`createChatsRoutes(db, providers, assets)`、`createAssetsRoutes(db, assets)` 签名变了，`app.ts` 已同步。
11. **依赖**：`apps/server` 加 `unpdf@^1.8.1`（纯 JS，无依赖，解包约 2.1 MB，内含 pdf.js serverless 构建），动态 `import()`，加载失败 / 加密 / 损坏 / 30 秒超时都按「抽取失败」处理。**[MSS→MG]** 聊天导入存 PDF 时可调 `services/media.ts` 的 `extractPdfText` 填 `meta.text`；不填也行，用户再上传同一文件时会补抽。
12. **没做**：按提供商把关单图 / 单请求体积（Anthropic 5 MB、Gemini 20 MB 等，P4 §9 建议）——目前只有上传 20 MB 上限；超限时由上游报错。

**`{{persona}}`（§3.3 末条）：结论是照 ST 1.18 默认的新宏引擎，改了组装器与开场白**

用黄金录制工具的副本（scratchpad，不改仓库）驱动本机 ST 1.18 实录了 5 组请求：卡的 description / personality / scenario / mes_example / system_prompt / post_history_instructions / depth_prompt、档案描述、开场白、历史用户消息、本轮输入、作者注释里都写 `{{persona}}` `{{description}}` `{{scenario}}`，分别在新宏引擎（`experimental_macro_engine: true`，发行版默认值，本机用户设置也是 true）与旧引擎下录。

- **机制**：`getCharacterCardFieldsLazy`（script.js）对上述卡字段与档案描述都先 `baseChatReplace` = `substituteParams(v, { replaceCharacterCard: false })`。新引擎在这一步 `env.character` 是空对象，`persona` / `charDescription` / `charScenario` 等宏已注册、handler 返回 `?? ''`，所以**卡字段里的卡类宏展开为空串**；`{{original}}` 因 `env.functions.original` 不存在抛错被保留原样，留到 `preparePrompt` 再展开。宏输出不再被解析，后续几遍 `substituteParams` 对已展开文本无影响。
- **非卡字段文本**（档案描述进提示词——IN_PROMPT 标记 / AT_DEPTH 扩展提示词 / TOP·BOTTOM_AN 拼接用的都是原始描述；聊天消息；作者注释）随后做完整替换，卡类宏展开为**各字段 baseChatReplace 后的值**。例：档案描述 `PDESC[char={{char}}|description={{description}}|persona={{persona}}]` 进提示词为 `PDESC[char=Quill|description=DESC[persona=|…]|persona=PDESC[char=Quill|description=|persona=]]`。
- 档案位置不影响 `{{persona}}` 的取值（`fields.persona` 不看位置）。
- 旧引擎（设置关掉时）卡字段里的卡类宏保留字面量，之后每多一遍带卡字段的替换就嵌套一层、永远剩一层字面量（开场白能嵌套到近万字），结果取决于渲染次数，不确定；**不照旧引擎实现**。

与改前对比：卡 description / personality / scenario / mes_example 里的 `{{persona}}` 原本就是空（与 ST 一致，**这不是 bug**）；真正不一致的是——
(a) system_prompt / post_history_instructions / depth_prompt 里的 `{{persona}}` 原来展开成档案描述，ST 是空；
(b) 档案描述里的 `{{description}}` `{{persona}}` `{{scenario}}` 原来是空，ST 是字段的 base 值（三种位置都是）；
(c) `{{charPrompt}}` `{{charJailbreak}}` `{{charDepthPrompt}}` `{{creatorNotes}}` 原来取原文，ST 取 base 值（世界书全局扫描的 creatorNotes / characterDepthPrompt 同理）；
(d) 开场白（`POST /api/chats` 建根节点时展开）里的 `{{persona}}` 原来取档案原文。

改法：`packages/core/src/prompt/assemble.ts` 里这些字段先 trim 再用种子上下文展开（ST 也是 `.trim()` 后 baseChatReplace；description / personality / scenario / mes_example 顺带补上 trim），卡覆盖 main / jailbreak 用 base 值（易变标记保留），档案描述进提示词时用完整上下文展开原文，AT_DEPTH 的扫描缓冲同样用完整展开（ST `getExtensionPromptByName`）；`routes/chats.ts` 开场白的 persona / description 等取 base 值。测试：`packages/core/src/prompt/assemble-card-macros.test.ts` 逐字节照抄三组新引擎实录（IN_PROMPT / AT_DEPTH / TOP_AN），改前 4 个用例失败；`apps/server/src/persona-macros.test.ts` 覆盖开场白。黄金测试 62/62。

### 修正（2026-09-16，MSW）

1. **托盘的位置**：§3.4「托盘在输入框上方」落为 `composer-dock` 里、`[data-part=composer]` 外框**之上**的一行（不塞进 `.field` 外框）：六个主题都改过 `composer` 的对齐 / 圆角 / 内边距，塞进去会把它们的输入框撑变形。附件键（回形针）在 `composer` 里、textarea 左侧（`data-part="composer-attach"`）。
2. **挂点补充**（§3.4 只列了五个）：`composer-tray-hint`（托盘下的轻提示）、`attachment-ext`（文档类型字）、`attachment-button`（移除 / 重试，`data-tone`）、`attachment-progress`、`attachment-drop` / `attachment-drop-frame`（拖入提示层）、`lightbox-backdrop` / `lightbox-bar` / `lightbox-stage` / `lightbox-image` / `lightbox-button`、`gallery-item`、`image-output-switch`、`storage-gc`。`[data-part=attachment]` 带 `data-kind="image|pdf|text"`、`data-context="tray|message|edit"`、`data-status`（托盘：`uploading|done|error`；消息图片：`loading|ready|error`）；`[data-part=message-media]` 带 `data-kind="images|documents|edit"`、`data-layout="single|pair|triple"`、`data-count`。酒馆 / 暖房 / 书斋在各自 `theme.css` 末尾加了附件形态（相片与纸签 / 奶白软卡 / 裱画与纸签），其余三个世界用默认形态。**`themes/README.md` 的 data-part 清单未同步（不在 MSW 名下），请主会话补。**
3. **发送的附件形态**：前端按 MSS 修正 3 发 `attachments: [{ id, name }]`（`GenerateBody.userMessage.attachments` 类型放宽为 `(string | { id, name? })[]`），去重命中旧资产时消息里显示这次的文件名。
4. **托盘挡发送**：有上传中或失败的项时发送键不可用（契约未规定）；失败项能重试的（网络 / 5xx）给重试键，413 / 415 与本地判定的类型不符、超 20 MB 只能移除。托盘下的提示按「失败项 → 模型看不到图片 → PDF 读不了（有抽取文本时「将以文本发送」，还没传完的 PDF 不下结论）」给出，能力查不到时不提示。
5. **消息里的文档小片不显示大小**：part 只有 `mime / name`，没有体积接口，小片显示「PDF 文档 / MD 文本」，点开是 `/api/assets/:id/file`（新窗口）。托盘里的小片显示大小与 PDF 页数。
6. **灯箱的范围**：从消息里点开 = 这条消息的全部图片；从会话面板「图片」点开 = 整个对话（全部节点，新的在前）。底是该世界的 canvas（不透明），不是统一黑幕。
7. **生图开关的默认值**由前端按连接的 provider 推断显示（`openai-responses` 默认关，其余 `caps.imageOut` 为真的默认开，与 §1.2 一致）；开关只写 boolean，不写 `null`。
8. **设置页分区标题**：「存储」的导航文字用 `settings.storage.title`（不往 `settings.sections.*` 里加键，守 §0 的命名空间规则）。
9. **[MSW→UX]** `MessageList.tsx` 的 `estimateMessageHeight` 只按文本估高，带图片的消息首次测量时位置修正会大一些（单图约 +330px、方格网格约 +200–400px）；建议按 `node.parts` 里的 image / document 数补一段估高。`MessageItem` 没有改 `MessageList` 的任何接口。

### 修正（2026-09-17，主会话）

1. **§3.1「caps.imageIn / documentIn 为 false 就丢弃媒体」作废**：能力目录必然滞后于新模型，也压不住网关上带前缀的 id——
   真机上 `glm-5.3-flash` 明明能看图，却被 `catalog.json` 里 `{ match: 'glm-*', imageIn: false }` 一条整代通配判成不收图片，
   用户附的图被静默丢掉，只在节点 `extra.warnings` 里留一句没人看的告警。改为：**用户附上的图片 / PDF 一律照发**，
   收不收由提供商说了算（报错可见，好过自欺欺人）。`createMediaRenderer` 不再接 `caps`，
   告警 `模型不支持图片输入，已丢弃 N 张图片` / `模型不支持 PDF 输入，已丢弃 N 个 PDF` 随之取消。
   保留的丢弃只剩三类，都不是对模型能力的猜测：**角色形状**（OpenAI 的 assistant/system content 不接受 image_url、
   Anthropic 顶层 system 只收文本、Gemini 的 systemInstruction 同理——放进去整条请求 400，连同这次的图片一起废掉）、
   **资产读不到**、**mime 不是图片 / PDF / 文本**。目录里的 `imageIn` / `documentIn` 从此只用于 UI 提示。
2. **§3.4 托盘提示**：「当前模型看不到图片，发送时会被丢弃」（`chat.attach.imageDropped`）与
   「PDF 发送时会被丢弃」（`chat.attach.pdfDropped`）两条随之删除（两个 i18n 键一并删）。
   只留 `pdfAsText`：`documentIn` 为 false 时服务端仍按 §3.3 把 PDF 抽出的文本内联进正文（内容不丢，只是换了形态），提示一句。


---
---

# 第二部分：M4（二）契约——背景、立绘表情、主题变体、外接生图

| 项目 | 内容 |
| ---- | ---- |
| 版本 | v1（2026-09-22） |
| 范围 | §A 背景；§B 立绘表情；§C 主题变体（导入导出）；§D 外接生图后端 |
| 不含 | 视觉小说全屏模式、立绘动画 / Live2D、生图的局部重绘 / 图生图、群聊立绘 |

表结构已由主会话在迁移 `0003` 加好：`character_sprites`；`connections.provider` 可取 `image-sd | image-comfy | image-novelai | image-openai`；`assets.kind` 早已有 `background` / `emotion`。**本部分不再新增迁移**，其余数据进 settings KV 与已有 JSON 列。

用户已定（2026-09-22）：
- **背景由各世界各自处理**：琉璃＝隔冰模糊（背景在冰板后，`blur` + 冰蓝白罩，虹边照旧）；雨夜＝隔湿玻璃（背景在玻璃后压暗偏蓝，雨与颗粒照常在最上层）；酒馆＝窗外景（背景只出现在一个带木窗框的区域里，四周暗角，羊皮纸与皮革不透明）；暖房＝柔光衰减（背景褪成暖奶油色调的淡影）。**素与书斋默认不显示背景**；外观设置里的「在素 / 书斋里也显示背景」打开后，两者统一用一层按模式调色的淡化遮罩（canvas 色 85% 覆盖），不做任何材质。
- 立绘框、背景处理都属于各世界自己的皮肤，写在 `themes/<id>/theme.css`（或新增 `themes/<id>/media.css`，由 apply.ts 一并懒加载），不得在骨架里写死某个世界的样式。

**代号与目录归属**：

| 代号 | 内容 | 独占 | 共享（最小改动，改前重读） |
| ---- | ---- | ---- | ---- |
| V | §A §B §C | `apps/web/src/features/{backgrounds,sprites}/**`、`apps/web/src/themes/**`（含六个世界的 css）、`routes/{backgrounds,sprites}.ts`、`services/{backgrounds,sprites,expression}.ts` | `AppLayout.tsx`、`features/chat/{ChatView,SessionPanel,SessionSettings}.tsx`、`features/settings/AppearanceSettings.tsx`、`services/{importer,st-migration}.ts`、`app.ts`、`store/ui.ts`、i18n `backgrounds.* sprites.* themeVariants.*` |
| IMG | §D | `packages/providers/src/image/**`、`routes/imagine.ts`、`services/{image-gen,jobs}.ts`、`apps/web/src/features/imagine/**` | `routes/connections.ts`、`features/settings/ConnectionsPage.tsx`、`features/chat/Composer.tsx`、`services/assemble-input.ts`（过滤生图节点）、`packages/sandbox-sdk`（`generateImage`）、`features/cards/host-bridge.ts`、i18n `imageGen.*` |

---

## A. 背景（V）

### A.1 数据

- 背景库 = `assets.kind='background'`，`meta.name` 存显示名（上传时的文件名去扩展名）。
- 生效顺序：**会话 > 角色 > 全局**。
  - 会话：`chats.metadata.background`：`assetId` | `'none'`（本会话明确不要背景）| 缺省（继承）。
  - 角色：settings KV `backgroundByCharacter: Record<characterId, assetId>`（不动卡数据）。
  - 全局：settings KV `defaultBackground: assetId | null`。
- 「素 / 书斋也显示背景」是本机偏好，放 `useUiStore`（`backdropInMinimalWorlds: boolean`，默认 false）。

### A.2 接口

- `GET /api/backgrounds` → `{ assetId, name, width, height, createdAt }[]`（新的在前）。
- `POST /api/backgrounds`（multipart `file`，图片 ≤ 20 MB；复用 `assets.save`）→ 同上单项。
- `PATCH /api/backgrounds/:assetId` `{ name }`；`DELETE /api/backgrounds/:assetId`（同时清掉引用它的 settings 项；会话 metadata 里的悬空引用在读取时当作缺省）。
- 会话绑定走现有 `PATCH /api/chats/:id { metadata: { background } }`；角色 / 全局走 settings。
- `media-gc` 不回收 `background`（现状如此，保持）。

### A.3 渲染

- `BackdropLayer`（`themes/signature.tsx` 一带）接收 `imageUrl | null`；有图时在 `<html>`（或应用根）上设 `data-has-backdrop=""`，并把图挂在 `--user-backdrop: url(…)` 上（只由应用自己写，变体 JSON 不能写 url，见 §C）。
- 每个世界按上面的「用户已定」写 `[data-has-backdrop]` 规则；**生成中动画、雨、颗粒等既有层次不能被背景盖住**；阅读面的对比度必须仍达标（CDP 抽测正文与阅读面的对比度 ≥ 4.5）。
- `prefers-reduced-motion` 与移动端：背景不做视差、不做动画；390 宽用 `background-size: cover` + 居中。

### A.4 界面

- 会话面板「背景」：缩略图网格（第一格「继承」、第二格「无」），点选即切；「上传」；「设为此角色默认 / 设为全局默认」。
- 设置 → 外观：全局默认背景、背景库管理（重命名、删除）、「在素 / 书斋里也显示背景」开关。
- 命令面板：「切换背景」动作（打开会话面板的背景页）。

### A.5 ST 迁移

- 迁移向导导入 `backgrounds/` 下全部图片（本机 23 张）为背景库；ST 聊天 `chat_metadata.custom_background`（形如 `url("backgrounds/xxx.jpg")`）映射到对应会话的 `metadata.background`。
- 迁移结果里单列「背景 N 张」。

---

## B. 立绘表情（V）

### B.1 数据与接口

- 标签集合：ST 的 28 个默认表情——`admiration amusement anger annoyance approval caring confusion curiosity desire disappointment disapproval disgust embarrassment excitement fear gratitude grief joy love nervousness neutral optimism pride realization relief remorse sadness surprise`；允许自定义标签（`[a-z0-9_-]{1,32}` 或任意中文，去首尾空白）。
- `GET /api/characters/:id/sprites` → `{ label, assetId }[]`。
- `PUT /api/characters/:id/sprites/:label`（multipart `file`）/ `DELETE …/:label`。
- `POST /api/characters/:id/sprites/import`（multipart zip：ST 的立绘包，文件名 = 标签；同名覆盖）。
- 导入角色卡时：CHARX 里 `type:'emotion'` 的资源（`name` 为标签）自动写进 `character_sprites`；PNG 的 `chara-ext-asset_:` 资源同理（有 `type:'emotion'` 描述的才算）。
- ST 迁移：`characters/<角色名>/` 目录下的图片按文件名（去扩展名）作标签导入到同名角色（本机样本 Seraphina）。

### B.2 表情选择

- settings KV `sprites`：`{ mode: 'off' | 'classify' | 'manual', connectionId?: string, model?: string, fallback: string /* 默认 'neutral' */ }`，默认 `mode:'classify'`，未配连接时用会话当前连接。
- `POST /api/chats/:id/nodes/:nodeId/expression` `{ label?: string }`：
  - 带 label = 手动指定；
  - 不带 = 分类：取该节点正文（去掉代码块与 HTML，截最后 1500 字），用 `callLlm`（M6 契约 §1.5）+ 结构化输出 `{ label: enum(该角色已有立绘的标签) }` 一次短调用（`maxTokens` 32，关闭推理）；失败或角色没有立绘时返回 fallback。F1 未交付前可先用 `callLlm` 的签名写，测试用 fake adapter。
  - 结果写进节点 `extra.expression`，返回 `{ label }`。
- 前端在一轮生成**结束后**（非流式期间）对当前角色的最新助手节点调用一次；swipe 切换时读节点里已有的 `extra.expression`，没有就再分类。
- slash `/emote <label>`（S 实现命令，调用本接口的手动形式）。

### B.3 界面

- 对话页立绘区：桌面宽屏（≥1280）放在消息区右侧、底部对齐；窄屏在输入框上方一条可折叠的小窗（默认折叠成头像大小）。无立绘的角色不出现立绘区。
- 切换表情做 200ms 透明度过渡（素：120ms；书斋：无动画，直接换）。
- 立绘框是各世界的记忆物件延伸：琉璃＝冰板相框、书斋＝裱画轴、素＝无框、酒馆＝铜框挂在皮革上、雨夜＝窗玻璃后的剪影、暖房＝贴纸描边。写在各自主题目录，注入方式同 `signature`（在 `ThemeSignature` 里加可选 `SpriteFrame`，缺省用素的无框实现）。
- 工作台的角色卡编辑器会复用上传组件：导出 `SpriteManager({ characterId })`（`features/sprites/SpriteManager.tsx`）。

---

## C. 主题变体（V）

### C.1 格式

```jsonc
{
  "format": "newtavern-theme-variant@1",
  "id": "v-<nanoid>",          // 导入时冲突则重新生成
  "name": "夜航琉璃",
  "base": "liuli",             // 六个世界之一
  "slots": {                   // 只允许 slots.css 声明过的槽位（白名单常量表）
    "light": { "--accent": "oklch(0.70 0.12 190)" },
    "dark":  { "--canvas": "oklch(0.18 0.03 235)" }
  },
  "options": { "rain": false }   // 只允许 base 主题声明过的 options
}
```

- 值校验：长度 ≤ 200；禁止包含 `url(`、`;`、`{`、`}`、`@`、`<`、反斜杠、`expression(`、`/*`；颜色槽位必须能被 `CSS.supports('color', v)` 接受；字体槽位只能从允许列表里选（各世界已声明的字体 + 系统栈）；长度类槽位（圆角等）只允许 `0`–`64px`。
- 模式：只允许 base 主题支持的模式键；不支持的键导入时丢弃并提示。

### C.2 运行时

- settings KV `themeVariants: Variant[]`；当前选择放 `useUiStore`（`variantId: string | null`，切换世界时若 base 不符自动置空）。
- registry 加 `registerVariants(list)`；`applyTheme` 在 `<html>` 上多设 `data-variant`，并维护一段 `<style id="nt-theme-variant">`：选择器 `[data-theme='<base>'][data-variant='<id>'][data-mode='<mode>']`，优先级高于该主题 theme.css 的槽位赋值。
- 世界的形态（材质类覆盖、记忆物件、纹理）**不因变体改变**——变体只动槽位值与 options。

### C.3 界面

- 设置 → 外观：世界预览卡下方「变体」一行（该世界的变体小卡 + 「派生变体」）。
- 变体编辑器（抽屉）：分组编辑颜色（表面 / 文字 / 强调 / 语义）、字体（下拉）、形（圆角滑块）、影（开关 + 预设档位）；实时预览卡（复用主题选择器的活预览）；对比度不足（正文 vs 阅读面 < 4.5）时就地提示。
- 导出（下载 `.nt-theme.json`）、导入（文件选择，校验失败逐条列出原因）、复制、删除。

---

## D. 外接生图后端（IMG）

### D.1 后端适配（`packages/providers/src/image/`）

```ts
export type ImageBackendId = 'image-sd' | 'image-comfy' | 'image-novelai' | 'image-openai';
export interface ImageGenParams {
  prompt: string; negative?: string; width: number; height: number;
  steps?: number; cfg?: number; sampler?: string; seed?: number; model?: string;
  /** ComfyUI：工作流 JSON（API 格式），占位 %prompt% %negative% %seed% %width% %height% %steps% %cfg% %model% */
  workflow?: Record<string, unknown>;
}
export interface ImageBackend {
  id: ImageBackendId;
  listModels(conn: Connection): Promise<{ id: string; name?: string }[]>;
  generate(conn: Connection, p: ImageGenParams, signal: AbortSignal,
           onProgress?: (fraction: number) => void): Promise<{ images: { mime: string; data: string }[]; seed?: number }>;
}
```

| 后端 | 端点 |
| ---- | ---- |
| SD WebUI / Forge | `POST {base}/sdapi/v1/txt2img`；模型 `GET /sdapi/v1/sd-models`；进度 `GET /sdapi/v1/progress` 轮询 |
| ComfyUI | `POST {base}/prompt`（替换占位后的工作流）→ 轮询 `GET /history/{prompt_id}` → `GET /view?filename=…&type=output`；模型 `GET /object_info/CheckpointLoaderSimple` |
| NovelAI | `POST https://image.novelai.net/ai/generate-image`（Bearer Key，返回 zip，取第一张 png） |
| OpenAI 兼容 | `POST {base}/v1/images/generations`（`b64_json`）；模型用 `/v1/models` |

`Connection.provider` 的类型要放宽以容纳生图后端（`ProviderId | ImageBackendId`，或生图单独一个 `ImageConnection` 类型）——由 IMG 决定，改动写进 §E 修正。

### D.2 服务端

- 连接：`connections` 表复用（Key 同样加密、同样的代理与自定义 Header）；`GET /api/connections` 的结果里带 `kind: 'chat' | 'image'`，对话相关的连接下拉只列 chat；连接测试对生图后端调 `listModels`。
- settings KV `imageGen`：`{ connectionId, model?, defaults: { width, height, steps, cfg, sampler, negative }, promptWriter?: { connectionId, model }, comfyWorkflow?: object, stylePrefix?: string }`。
- `POST /api/chats/:id/imagine`（SSE）`{ mode: 'free' | 'last_message' | 'character', prompt?, negative?, width?, height?, parentId? }`：
  1. 建 `jobs` 行（kind `image_gen`，status 流转 pending → running → done / failed）；
  2. `last_message` / `character`：先用 promptWriter（缺省 = 会话连接）调 `callLlm`（M6 契约 §1.5）写一段英文生图提示词（参照 ST SD 扩展的「描述最后一条消息 / 描述角色外貌」两种模板，写在 `packages/i18n/prompts/imagine.{zh-CN,en}.md`）；
  3. 调后端，事件：`job {id, status}`、`prompt {text}`、`progress {fraction}`、`node {…MessageNode}`、`error {message}`、`done`；
  4. 结果存为 `generated` 资产，追加为当前 head 的子节点：`role:'assistant'`、`name` = 角色名、parts = `[{type:'image',…}]`、`extra: { generatedBy: 'image', imagePrompt, backend, seed }`，并移动 head。
- **生图节点默认不进提示词**：`assemble-input` 线性化历史时跳过 `extra.generatedBy==='image'` 的节点（它的子节点照常）；检查器里显示为「已跳过（生图）」。
- `GET /api/jobs/:id`（查状态，前端刷新页面后续看进度用）。

### D.3 前端

- 连接页：「生图后端」分组，新建时选四种之一；ComfyUI 额外有「导入工作流 JSON」。
- Composer：附件按钮旁「生图」菜单——「画最后一条消息」「画角色」「自由描述…」（弹出输入框，可改尺寸与负面词）；进行中显示进度条，可取消（abort SSE）。
- 生图消息正常显示（已有的图片 part 渲染与灯箱），可「重画」（同参数新 seed，作为该节点的 swipe 兄弟）。
- 前端卡原生 API：`newtavern.generateImage({ prompt, negative?, width?, height? }) → Promise<{ assetUrl }>`（只生成并存资产，不写消息树）；RPC 名 `image.generate`。slash `/imagine [prompt]`（S 实现命令，调用 `/api/chats/:id/imagine` 的 free 模式）。

### D.4 验收

- 四个后端各一组 mock HTTP 服务的集成测试（本机没有 SD / ComfyUI / NovelAI Key）：参数映射、进度、错误归一化、ComfyUI 占位替换。报告里写明「只做了 mock 验证」。
- 路由测试：imagine 三种模式、节点入树与 head 移动、组装时跳过生图节点、job 状态。

---

## E. 待协调与修正（M4（二））

### 修正（2026-09-22，MIG）：收尾验收

1. **§A.5 ST 迁移补全**（`services/st-migration.ts`）：
   - 清单 `backgrounds` 多一个 `current`：ST 当前的全局背景（`settings.background.name`，老版本只有 `url` 也认），文件在 `backgrounds/` 里才给。
     选择多一个 `defaultBackground`（缺省 false；前端默认不勾——它会改变所有会话的样子）：勾了就把那张背景设成 settings `defaultBackground`，
     事件 `item { category:'settings', file:'defaultBackground' }`，背景没进库时 `skipped`。
   - `custom_background` 的解码照 ST：系统背景 `url("backgrounds/<encodeURIComponent>")`，聊天专属背景（`forceSetBackground`，生图扩展等写的）
     `url("<encodeURI(user/images/…)>")`。后者随聊天收进背景库（按内容去重，`source: 'st-import:chat-background'`）；`http(s):` / `data:` 外链不收。
     对不上的会话照常导入（背景继承），item 的 `message` 与 `done.warnings` 各记一句。
   - 清单里的预设项多 `scripts?`（自带酒馆助手脚本个数）与 `scriptsEnabled?`（在酒馆助手 `script.enabled.presets` 里）；角色项已有 `sprites?`。前端清单里都显示出来。
   - 本机实测：背景 23/23 逐字节一致、名字对上；Seraphina 立绘 28/28 逐字节一致；预设自带脚本 13 个（ARGO_1.2 那 1 个按原件开启，
     小冰块那个原件就关着、仍关着），导出与原件 deep-equal 11/13——另 2 个（TGbreak）原件缺 `export_with`，规范化后补上了默认值 `{data:true,button:true}`，
     与酒馆助手读进来时的 zod 默认一致。本机没有全局脚本、没有任何聊天锁过背景（`custom_background` 只能用夹具测）。
2. **§A.3 背景的缺省形态**：各世界的 `media.css`（隔冰、隔湿玻璃、窗外景、柔光衰减）与 `SpriteFrame` **都还没写**（视觉归主会话）。
   为了背景至少能看见，引擎加了缺省形态 `themes/backdrop.css`（在 `index.css` 里引入）：
   - `BackdropLayer` 多一个 `treatment`（= `ThemeMeta.backdrop`），写进 `<html data-has-backdrop="world|veil">`；
   - `[data-part='user-backdrop']::after` 一层 canvas 色 85% 遮罩（`@layer components`，各世界在自己的 `@scope` 里覆盖）；
   - `veil`（素 / 书斋，`theme.ts` 已标 `backdrop: 'veil'`）且外观里打开「也显示背景」时，应用外壳里的阅读面、侧栏去底（不在 layer 里，靠 scope 更近胜出），预览卡不受影响。
   - 现状：琉璃 / 雨夜的面板本来半透明，背景隔着它们就能看见；酒馆 / 暖房的面板不透明，基本看不见，等各自的 `media.css`。
3. **§B.3 立绘区的摆法**：按**对话列宽度**（`SPRITE_STAGE_MIN_WIDTH = 860px`）而不是视口 ≥1280 决定 `stage` / `strip`——
   1440 宽而左右两栏都开着时对话列只有五百多像素，放右侧会把正文挤得没法读。
4. **i18n**：`backgrounds.* sprites.* themeVariants.* toast.*` 先前整块缺失（界面露出键名），已补齐中英；`apps/web/src/i18n-coverage.test.ts` 兜住这几个命名空间。
