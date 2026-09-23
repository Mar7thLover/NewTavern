# M5（二）契约：前端卡运行时、酒馆助手兼容与 MVU 变量

| 项目 | 内容                                                                                                                       |
| ---- | -------------------------------------------------------------------------------------------------------------------------- |
| 版本 | v1（2026-09-17）                                                                                                           |
| 范围 | 带脚本的前端卡（iframe 沙箱 + RPC + 状态镜像）、酒馆助手 API shim、MVU 变量引擎、脚本库、变量面板                        |
| 不含 | 变量管理器的可视化编辑、EJS 提示词模板、额外模型二次解析、slash 命令全量、脚本库的编辑界面（只跑卡自带的脚本）→ M5（三） |

先读：`docs/PLAN.md` §3.5、`docs/M3-CONTRACT.md` §3.5（变量按节点存）、`apps/web/src/themes/README.md` §10（M5（一）的正文块与内联 HTML）。
本文与代码冲突时以本文为准；实现中发现本文写错，在 §8 追加「修正」注明日期。

参照物是社区的既有实现：**酒馆助手（JS-Slash-Runner）4.9.3** 与 **MVU（MagVarUpdate）**。
凡是「与酒馆助手一致 / 与 MVU 一致」的说法，都是照着本机 `data/default-user/extensions/JS-Slash-Runner/@types`
与 MagVarUpdate 仓库源码核对过的，不是凭印象写的。

---

## 1. 总览：一条消息里的前端卡是怎么跑起来的

```text
模型输出
  └─ 显示侧正则（角色卡自带，把 <StatusPlaceHolderImpl/> 换成一整段 HTML）
       └─ splitCardSegments（core/richtext/cards.ts）认出「围栏里的 HTML 文档」
            └─ FrontendCardFrame：srcdoc = CSP + 本地库 + 引导脚本 + 卡的 HTML
                 ├─ guest（sandbox-sdk/guest.ts）：window.newtavern + 酒馆助手 shim + Mvu
                 │    ├─ 同步读：状态镜像（chatMessages / variables / charData / macroContext）
                 │    └─ 异步写：postMessage RPC → 宿主 handlers → REST
                 └─ 高度：guest ResizeObserver → height 信号 → iframe 样式
```

变量那一半在服务端：

```text
生成流式结束
  └─ runMvuForNode：从本节点快照出发解析 <UpdateVariable> → 写回本节点 variables
       ├─ SSE `variables` 事件 → 前端写缓存 + 广播 mag_variable_update_ended
       └─ 下一轮组装：{{get_message_variable::stat_data}} 直接读得到
```

---

## 2. MVU 变量引擎（`packages/compat/src/mvu`，服务端跑）

### 2.1 为什么在服务端

1. 变量是**提示词的输入**。放在浏览器里意味着「渲染完前端卡才写回变量」，用户生成后立刻关页面这一轮就丢了。
2. 变量按**消息节点**存（M3 §3.5），swipe / 重生天然从父快照重算；重放只有服务端能沿分支可靠地做。
3. 前端卡照样能读写：镜像 + RPC（§4）。

开关：设置 KV `mvu = { enabled: boolean }`（默认开）。关掉后变量表照旧可读可写，只是不再自动解析模型输出。

### 2.2 `[InitVar]` 初始化

- 触发点：每轮生成**组装之前**（第一轮的提示词就能看到初始值），以及手动「重新解析这条」。
- 来源：该会话能看到的所有世界书（全局 → 聊天 → 角色卡 → persona），**不过滤 disabled**——
  社区惯例是把 `[InitVar]` 条目禁用掉（它不该进提示词）。
- 判定：条目**备注**含 `[InitVar]`（大小写不论）。
- 内容：`<InitVar>…</InitVar>` 或 ``` 围栏可以裹着；先展开宏（`{{user}}` / `{{char}}`），再按 YAML 解析（JSON 是 YAML 的子集）。
- 合并：同一本书里多个条目深合并；**已有变量优先**（`{ ...初始值, ...当前值 }`），中途加字段不会冲掉进度。
- 记账：吃过的书记在 `initialized_lorebooks`，不会初始化两次。

两种真实写法都支持（本机两张真卡逐条核对过）：YAML 平铺（长夜月），JSON + `$meta` + `[值, "说明"]` 二元组（黄金庭院）。

### 2.3 命令与语义

抽取（`commands.ts`）：扫 `_.set|insert|assign|remove|unset|delete|add(`，按括号配对找结尾，
**要求闭括号后紧跟分号**（与 MVU 一致；否则正文里提一句 `_.set(...)` 会被误当命令），`//` 后是理由。
另外认 `<JSONPatch>[…]</JSONPatch>`（RFC 6902 子集：replace/add/remove/move/delta）。

| 命令                             | 语义                                                                                      |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `_.set(path, [old,] new)`        | 路径**必须已存在**（变量由 `[InitVar]` 定义）；`old` 只是模型的自我核对，实际取最后一个参数 |
| `_.add(path, delta)`             | 数值加减；布尔值用 `true` 取反                                                             |
| `_.insert(path, [key,] value)`   | 数组 push / 按下标插入；对象 merge / 按键写入（别名 `_.assign`）                           |
| `_.remove(path[, key])`          | 删键、按下标或按值删数组元素（别名 `_.delete` / `_.unset`）                                |
| `move`（仅 JSON Patch）          | 搬一个子树                                                                                 |

值的解析顺序照抄 MVU：`true/false/null` → `JSON.parse` → YAML（宽松写法）→ 算术 → YAML → 去引号的字符串。
**日期与时间不当算术**（`2025-04-10` 按减法是 2011、`07:30` 会被 YAML 读成 60 进制），这两种状态栏里最常见。

**VWD（带说明的值）**：`[值, "说明"]` 二元组，`set` / `add` 只改 `[0]` 并保留说明；
`$meta.strictSet = true` 时关掉这条特判（那类卡的提示词会要求模型写精确路径 `好感度[0]`）。
`$meta.extensible = false` 时 `insert` 不能加新键。

产出：`display_data`（全表副本，改过的位置变成 `旧->新 (理由)`）与 `delta_data`（只有改过的位置），
都挂在 `MvuData` **顶层**；`stat_data` 里只有变量本身（MVU 更新过程中临时挂的 `$internal` 收尾会删掉，
留着会让前端卡把它当成一行状态显示出来——真卡上撞到过）。

### 2.4 分支与重放

- 每个助手节点存**它自己那一轮结束后**的快照；父节点不动 → swipe / 重生自动从同一起点重算。
- `POST /chats/:id/mvu/replay`：从某节点起沿当前 head 路径逐条重算（编辑了历史正文、手改了变量之后用）。
- `POST /chats/:id/mvu/run`：只重算某一条（对应 MVU 的「重新处理变量」）。

---

## 3. 变量的存法与接口

### 3.1 五个作用域

| 酒馆助手 `type` | 新酒馆的存法                                                    |
| --------------- | --------------------------------------------------------------- |
| `message`       | `message_nodes.variables`（按节点的完整快照，MVU 的 stat_data 在这） |
| `chat`          | **同一份**节点快照（新酒馆的聊天变量本来就按节点存，`{{getvar}}` 也读它） |
| `character`     | `variables` 表 scope='character'、ownerId=characterId            |
| `global`        | `variables` 表 scope='global'                                    |
| `script`        | `variables` 表 scope='script'、ownerId=scriptId                  |
| `preset`        | **不支持**（读到空表，写入报错）                                 |

### 3.2 宏（`packages/core/src/macros/helper-variables.ts`）

- `{{get_<message|chat|character|preset|global>_variable::路径}}`：字符串原样、其余 `JSON.stringify`；
- `{{format_…_variable::路径}}`：YAML，续行按宏前面的缩进对齐；
- 两者都**剥掉 `$` 开头的键**（`$meta` / `$internal` 是簿记，不该进提示词）——与酒馆助手一致。

### 3.3 节点载荷

`MessageNode` 新增 `hasVariables: boolean`（只给标记不给内容：一条快照几 KB，长对话会把详情接口撑爆，M4 §4）。
要内容走下面的接口。

### 3.4 接口

| 方法与路径                        | 作用                                                                     |
| --------------------------------- | ------------------------------------------------------------------------ |
| `GET /chats/:id/variables?nodeId=` | 该节点的快照 + global/character 表；节点没有快照时沿路径上溯，**再没有就回落到 `[InitVar]` 的初始形态**（开场白上的卡也能先画出来） |
| `PUT /chats/:id/variables`        | 整表替换，`{ scope, nodeId?, ownerId?, variables }`                       |
| `POST /chats/:id/mvu/run`         | 重新解析某条消息并写回它的快照                                           |
| `POST /chats/:id/mvu/replay`      | 从某条起沿当前分支重算                                                   |
| `POST /chats/:id/mvu/parse`       | 只算不写（前端卡的 `Mvu.parseMessage`）                                  |
| `GET/PUT /variables/:scope`       | 与会话无关的表（global / character / script）                            |

生成 SSE 新增事件：

```ts
event: variables
data: { nodeId, changed, variables, updates: [{ type, path, oldValue, newValue, reason, display }], errors, initialized? }
```

---

## 4. 沙箱（`packages/sandbox-sdk` + `apps/web/src/features/cards`）

### 4.1 识别（`packages/core/src/richtext/cards.ts`）

社区前端卡的实际形态：角色卡的**显示侧正则**把占位符替换成一整段 HTML，并且**裹在 Markdown 围栏里**。

- 围栏（``` / ~~~，语言标记为空或 `html`/`xml`/`vue`/`svg`）+ 内容像 HTML 文档（有 `<html|head|body|script>`，
  或有 `<style>` 且有别的元素）→ 一张卡；
- 没围栏但整段带 `<script>` / `<body>` → 整条当一张卡；
- 明确标了 `js` / `python` 的围栏一律不是卡（那是代码示例）。

**带 `<script>` 的必须进沙箱**（内联渲染会把脚本剥掉，卡就成了静态图）；不带脚本的 HTML 继续走
M5（一）的内联渲染（白名单净化 + `@scope`），那条路和主题配合更好。

流式中不建帧：先占位，消息写完再把卡跑起来（每个增量都重建 iframe 会让卡不停重跑）。

### 4.2 文档与信任级别

`buildSrcdoc()` 产出的文档顺序：CSP meta → `<base href=宿主源>` → 重置样式与主题变量 →
本地库（经典脚本）→ 注入配置 → 引导脚本 → 卡的 HTML。

| 级别            | `sandbox` 属性                              | CSP 要点                                          | 什么时候用                       |
| --------------- | ------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| `strict`        | allow-scripts/forms/modals/popups/downloads | 无 https 外链、`connect-src 'none'`               | 完全不信任来源                   |
| `standard`（默认） | 同上                                        | 允许 https 脚本 / 样式 / 图片 / 字体；`connect-src` 只到宿主 | 绝大多数社区卡                   |
| `trusted`       | 同上                                        | `connect-src *`                                   | 自己写的、或要调外部 API 的卡    |
| `legacy-unsafe` | **加 allow-same-origin**                    | 同 trusted                                        | 依赖 `window.parent`/真 localStorage 的老卡；等于放弃隔离 |

设置存在服务端 KV `cards`：`{ defaultTrust, trustByCharacter, externalLibs, scripts }`；
「跑不跑带脚本的卡」是本机开关（`cardRuntime`，设置 → 外观 → 正文 与 设置 → 前端卡 两处同一个）。

**注入的库**（`public/sandbox/lib/`，由 `apps/web/scripts/build-sandbox-libs.mjs` 打成 IIFE 经典脚本）：
jQuery、lodash always；Vue / zod / YAML 按卡里是否提到加载，**脚本帧与从 CDN 取代码的卡一律全给**
（真实例子：MVU 的 bundle 需要 Vue，它的 zod schema 脚本需要 `z`，而脚本正文只有一行 import 看不出来）。
`z` 是 zod 包的整个命名空间（社区脚本里 `z.object(...)` 与 `z.z.ZodObject` 两种写法都有）。
外链（FontAwesome、Tailwind）按设置给，`strict` 下不给。

opaque origin 下 `localStorage` / `sessionStorage` 一读就抛，引导脚本铺了**内存版 polyfill**
（`pinia` 拉进来的 `@vue/devtools-kit` 一上来就读 localStorage，不铺这层整张卡都起不来）。
内存版**刷新即丢**，要持久化请用变量表。

### 4.3 RPC 与镜像

信封：`{ channel:'newtavern-sandbox', version, nonce, frameId, payload }`。宿主验身两条：
`event.source === frame.contentWindow` **且** nonce 对得上（opaque origin 下 `event.origin` 是 `"null"`，不可作依据）。

同步 API 靠镜像：`chatMessages` / `variables` / `charData` / `macroContext` / `scriptButtons`，
首屏随 srcdoc 注入，之后数据变化用 `pushMirror` 推。**镜像变化不重建 iframe**（否则卡的内部状态全丢）。

方法表：`chat.set/create/delete`、`variables.replace`、`mvu.parse/replace`、`generate`、`generate.stop`、
`slash.run`、`book.entries/write`、`notify`、`script.buttons`、`event.emit`、`mirror.refresh`。

### 4.4 楼层号 vs 节点 id

酒馆助手按「第几楼」定位消息，新酒馆是消息树。映射规则：

- 楼层号 = **当前分支 root→head 的下标**，`getCurrentMessageId()` 就是帧所在节点的下标；
- 每条 `ChatMessage` 额外带 `node_id`：切分支后楼层号会变，节点 id 不会；
- `deleteChatMessages` 删的是「该楼层**及其后代**」（树上删节点等于删子树），不是抽掉中间一层；
- `createChatMessages` 的 `insert_before` 暂不支持，只能追加到末尾（会给一条提示）。

### 4.5 事件

应用内用原生名（`message:added` 等）广播，转发给 iframe 时按表映射成酒馆助手的名字。
**真的会广播**的：`message_sent` `message_received` `message_updated` `message_edited` `message_deleted`
`message_swiped` `character_message_rendered` `user_message_rendered` `generation_started` `generation_ended`
`generation_stopped` `stream_token_received` `chat_id_changed` `app_ready`、iframe 事件四个、
MVU 的 `mag_variable_initiailized` / `mag_variable_update_started` / `mag_command_parsed` / `mag_variable_update_ended`。
`tavern_events` 表是**全的**（卡拿 `undefined` 去注册会静默失效，比报错更难查），但表里其余的名字不会触发。

### 4.6 `generate` / `generateRaw`

`POST /chats/:id/sandbox/generate`（SSE）。与正式生成的区别：**不写消息树、不推进世界书时间态、不产生变量副作用**（dryRun 组装）。

支持的 `config` 子集：`user_input`、`should_stream`、`max_chat_history`、`ordered_prompts`
（只认 `RolePrompt` 与 `chat_history` / `user_input` 两个占位符）。
`injects` / `overrides` / `tools` / `json_schema` / `preset_name` 暂不支持：带了就回一条 warning，其余照常生成。

### 4.7 脚本库

角色卡的 `extensions.tavern_helper.scripts`（新）或 `extensions.TavernHelper_scripts`（旧）——
导入 ST 卡时这两个字段本来就原样保留。脚本在**隐藏 iframe** 里跑，正文包一层 `<script type="module">`
（社区脚本几乎都是 `import '…cdn…/bundle.js'`）。脚本按钮显示在输入框上方，点了广播 `script_button:<id>:<名字>`。

**内置 MVU 开着时跳过原版 MVU 框架脚本**（内容里出现 `MagVarUpdate`）：两套引擎一起跑只会打架。
想用原版：设置 → 前端卡里关掉「自动解析变量更新」。

---

## 5. 兼容矩阵（酒馆助手 4.9.3）

### 5.1 已实现

| 分类 | 函数                                                                                                                                                    |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 消息 | `getChatMessages` `setChatMessages` `createChatMessages` `deleteChatMessages` `getCurrentMessageId` `getLastMessageId` `getMessageId` `getIframeName`     |
| 变量 | `getVariables` `replaceVariables` `insertOrAssignVariables` `insertVariables` `deleteVariable` `updateVariablesWith` `getAllVariables`                    |
| 事件 | `eventOn` `eventOnce` `eventMakeFirst` `eventMakeLast` `eventRemoveListener` `eventClearEvent` `eventClearListener` `eventClearAll` `eventEmit` `eventEmitAndWait` `eventOnButton` |
| 生成 | `generate` `generateRaw` `stopGenerationById` `stopAllGeneration`                                                                                        |
| 世界书 | `getLorebookEntries` `setLorebookEntries` `createLorebookEntries` `deleteLorebookEntries` `replaceLorebookEntries`                                     |
| 脚本 | `getScriptId` `getScriptName` `getButtonEvent` `getScriptButtons` `replaceScriptButtons` `updateScriptButtonsWith` `appendInexistentScriptButtons`        |
| 杂项 | `getCharData` `substitudeMacros`（同步子集）`triggerSlash`（子集）`errorCatched` `initializeGlobal` `waitGlobalInitialized` `reloadIframe` `toastr.*`     |
| MVU  | `Mvu.events` `Mvu.getMvuData` `Mvu.replaceMvuData` `Mvu.parseMessage` `Mvu.isDuringExtraAnalysis`                                                        |

### 5.2 未实现（调用会**明确报错**，不静默失效）

`playAudio` / `pauseAudio` / 音频系列、`createCharacter` / `deleteCharacter` / 角色写入系列、
预设系列（`getPreset` / `setPreset` / `loadPreset` …）、扩展安装系列、`injectPrompts` / `uninjectPrompts`、
`registerMacroLike`、`rotateChatMessages`。

行为上「能调用但不完整」的：

| 接口                          | 差异                                                       |
| ----------------------------- | ---------------------------------------------------------- |
| `formatAsTavernRegexedString` | 原样返回（显示侧正则没有同步入口），会打一条警告            |
| `substitudeMacros`            | 只认 `{{char}} {{user}} {{description}} {{personality}} {{scenario}} {{lastMessageId}} {{getvar::}} {{get_*_variable::}}` |
| `registerVariableSchema`      | 空实现（变量管理器 UI 是 M5（三）的事）                     |
| `SillyTavern.*`               | 只有 `chat` / `characters` / `chatId` / `substituteParams` / `eventSource` / `getContext`；其余属性访问会打一条警告并返回 undefined |
| `EjsTemplate` / `showdown`    | 没有（EJS 提示词模板是另一件事，见 §7）                     |
| `triggerSlash`                | 只认 `/echo /setvar /getvar /addvar /flushvar /send /sys /comment` 与它们的 global 变体，其余报错 |

### 5.3 沙箱带来的差异（与酒馆助手「不隔离」的做法比）

- `window.parent` 拿不到宿主（`legacy-unsafe` 除外）；
- `localStorage` 是内存版，刷新即丢；
- `standard` 下卡自己发的网络请求（`fetch` / `XHR`）只能到宿主，外部 API 要用 `trusted`；
- 卡里的 `alert` / `confirm` 能用（`allow-modals`），但会挡住整页，不建议。

---

## 6. 界面

- 设置 → 外观 → 正文：**跑带脚本的前端卡**（本机开关，关掉退回代码块）。
- 设置 → **前端卡**：运行开关、外链开关、脚本库开关、信任级别（默认 + 按角色卡覆盖）、MVU 自动解析开关。
- 卡的右上角（hover 出现）：重新加载、报错数（点开看详情）、`legacy-unsafe` 的警告标。
- 检查器 → **变量**页签：本条消息 / 全局 / 角色卡三张表，`[值,说明]` 的说明显示在右侧；
  本轮变化（delta）单列一段；两个动作：重新解析这条、从这条重算。

---

## 7. 已知未做（留给 M5（三）与之后）

1. **变量管理器**：可视化编辑变量、按 schema 校验（`registerVariableSchema` 现在是空实现）。
2. **EJS 提示词模板**（`<%_ _%>`）与酒馆助手宏的开关：社区卡里有一部分依赖它。
3. **额外模型解析**（MVU 的「另起一个模型专门算变量」）与自动清理旧楼层变量。
4. **slash 命令**：现在只有 7 条；完整的管道 / 闭包语法是另一个里程碑。
5. **全局脚本库的管理界面**：现在只跑角色卡自带的脚本，全局脚本没有导入 / 编辑入口。
6. **卡的主题贴合**：`themeCss` 通道已经打通（`buildSrcdoc` 的 `themeCss`），但还没有把六个世界的槽位真正喂进去。
7. `injects` / `overrides`：前端卡的 `generate` 还不能往提示词里塞东西。

---

## 8. 修正

（暂无）


---
---

# 第二部分：M5（三）契约——变量管理器、脚本库、slash、前端卡生成补全、EJS

| 项目 | 内容 |
| ---- | ---- |
| 版本 | v1（2026-09-22） |
| 范围 | §1 变量管理器与 schema；§2 全局脚本库；§3 slash / 前端卡 generate 补全 / 提示条 / 卡的主题贴合 / MVU 补全；§4 EJS 提示词模板 |
| 仍不做 | 音频接口、`registerMacroLike`、`installExtension`、`createCharacter` / `deleteCharacter`、QuickReply、完整 STscript（只做契约列出的命令） |

表结构已由主会话在迁移 `0003` 加好：`scripts`；`variables.scope` 可取 `'preset'`。本部分不再新增迁移。
`AssembleInputV2` 已由主会话加好三个字段的类型（`extraInjections` / `promptOverrides` / `templateRenderer`）和 `ir.meta.templated`，实现归下表。

**代号与目录归属**：

| 代号 | 内容 | 独占 | 共享（最小改动，改前重读） |
| ---- | ---- | ---- | ---- |
| S | §1 §2 §3 | `apps/web/src/features/{cards,inspector,scripts}/**`、`apps/web/src/components/ui/toast.tsx`（新）、`packages/core/src/slash/**`（新）、`packages/sandbox-sdk/**`、`routes/scripts.ts`、`services/scripts.ts`、`packages/compat/src/mvu/**` | `packages/core/src/prompt/assemble.ts`（只实现 extraInjections / promptOverrides）、`routes/{sandbox,variables,chats}.ts`、`services/{assemble-input,mvu,variables,st-migration}.ts`、`features/settings/SettingsPage.tsx`、`app.ts`、i18n `scripts.* variableEditor.* toast.* cards.*` |
| E | §4 | `packages/compat/src/ejs/**`（新，单独入口 `@newtavern/compat/ejs`）、`services/ejs.ts`（新） | `packages/core/src/prompt/assemble.ts`（只在渲染点调用 templateRenderer）、`services/assemble-input.ts`（注入渲染器）、检查器段落标注（`features/inspector/SegmentList.tsx` 一处小改，和 S 协调：改前重读） |

参照物：酒馆助手 4.9.3 源码在本机 `D:\Projects\SillyTavern\data\default-user\extensions\JS-Slash-Runner`（`@types/` 完整声明，`dist/index.js.map` 带 sourcesContent）；ST 的 slash 实现在 `D:\Projects\SillyTavern\public\scripts\slash-commands*.js`；EJS 参照 GitHub `zonde306/ST-Prompt-Template`（没有本地副本，按它的 README 与源码核对）。

---

## 1. 变量管理器（S）

- 检查器「变量」页签从只读改为可编辑的树：作用域切换 message（=chat，当前节点快照）/ global / character / script / **preset**。
  - 节点：对象可展开；叶子可改值（字符串、数字、布尔、null、JSON 文本四种编辑形态，可切类型）；增加键、删除键、重命名键。
  - MVU `[值, 说明]` 二元组：只编辑值，说明灰显只读；`$meta` 等 `$` 开头的簿记键默认折叠。
  - 保存 = 整表 PUT（现有 `PUT /api/chats/:id/variables` 与 `PUT /api/variables/:scope`），保存前显示改动计数，支持撤销到打开时的状态。
  - 编辑 message 作用域只改**当前节点**快照，提示「从这里往后的楼层不会自动重算，需要时点『从这条重算』」。
- `preset` 作用域打通：`routes/variables.ts` 接受 `preset`（ownerId = presetId），`assemble-input` 把当前预设的变量表喂进 `variables.preset`；前端卡 `getVariables({type:'preset'})` / `replaceVariables(…, {type:'preset'})` 可读写。
- `registerVariableSchema(schema, { type })`（酒馆助手签名）：guest 端把 zod schema 用 `z.toJSONSchema()` 转成 JSON Schema，经 RPC `variables.registerSchema` 交给宿主；宿主存进 `chats.metadata.variableSchemas[type]`（按会话）。变量管理器按 schema 校验并就地标错（不阻止保存，但保存前列出错误）；MVU 应用 `<UpdateVariable>` 后若有 message 作用域的 schema，校验失败只写 warning 到节点 `extra.mvuWarnings`，不回滚。

## 2. 全局脚本库（S）

### 2.1 接口

- `GET /api/scripts?scope=global|preset&ownerId=` → `ScriptRow[]`（按 displayOrder）。
- `POST /api/scripts` `{ scope, ownerId?, name, content, enabled?, buttons? }`；`PUT /api/scripts/:id`（部分字段）；`DELETE /api/scripts/:id`；`PUT /api/scripts/order` `{ ids: string[] }`。
- `POST /api/scripts/import`（multipart 或 JSON）：接受酒馆助手导出的单个脚本 JSON 与脚本数组 / 脚本树（文件夹展平，文件夹名进 `data.folder`）；原件整份存 `data`；默认 `enabled:false`，返回导入条数（前端问「现在启用吗」，与自带正则同一交互）。
- `GET /api/scripts/:id/export` → 酒馆助手格式（以 `data` 为底叠加列值）。
- 预设自带脚本：导入预设时把 `extensions.tavern_helper.scripts`（及旧字段）抽成 `scope:'preset'` 行（原件不动、导出无损，做法同自带正则）；启动回填一次。
- ST 迁移：读 `settings.json` 里 JS-Slash-Runner 的全局脚本（字段名照 4.9.3 源码核对），导入为 global 脚本，保持原启用状态。

### 2.2 运行

- `ScriptRunner` 运行顺序：全局 → 当前预设的 → 当前角色卡的；每个脚本仍是独立隐藏 iframe；关闭总开关（设置 → 前端卡 → 脚本库）则都不跑。
- 按钮：三类脚本的按钮合并显示在输入框上方，按上面的顺序。

### 2.3 界面

- 设置里新增一节「脚本库」（`?section=scripts`）：分组（全局 / 当前预设）列表，拖拽排序、启用开关、导入、导出、新建、删除。
- 脚本编辑器 `features/scripts/ScriptEditor.tsx`（导出给工作台复用）：懒加载 CodeMirror 6（JavaScript 语法高亮、行号、搜索）、名称、按钮列表编辑（名称 + 是否显示）、「作者说明」（`data.info`）。编辑器颜色只用槽位。

## 3. slash、前端卡 generate、提示条、主题贴合、MVU 补全（S）

### 3.1 slash（`packages/core/src/slash/`）

- 解析器：命令 `/name`、位置参数与 `key=value` 命名参数、单双引号、管道 `|`（上一条结果进 `{{pipe}}` 与下一条的无名参数）、闭包 `{: … :}`、`{{var::name}}` 与 `{{getvar::}}` 宏、转义 `\|`、`\{`。
- 执行器：`runSlash(script, host: SlashHost, opts: { maxIterations: 100 })`，host 接口由 web 实现（`features/cards/slash-host.ts`）；未知命令抛 `SlashError('unknown command /xxx')`，**不静默**。
- 命令（共 40 条，别名写在括号里）：
  - 输出与流程：`/echo` `/pass` `/return` `/abort` `/run`（执行闭包或已命名的快速命令变量） `/if left= right= rule=(eq|neq|lt|gt|lte|gte|in|nin) else={: :} {: :}` `/times n {: :}` `/while left= right= rule= {: :}`
  - 变量：`/setvar key= [index=]` `/getvar` `/addvar` `/incvar` `/decvar` `/flushvar` `/listvar` `/setglobalvar` `/getglobalvar` `/addglobalvar` `/incglobalvar` `/decglobalvar` `/flushglobalvar`
  - 数学与字符串：`/add` `/sub` `/mul` `/div` `/mod` `/rand [from= to= round=]` `/len`
  - 消息：`/send` `/sendas name=` `/sys` `/narrate`（=sys） `/comment` `/hide` `/unhide` `/cut` `/del n` `/messages [names=] range` `/setinput`
  - 生成：`/gen [lock=] prompt` `/genraw prompt` `/trigger` `/continue` `/regenerate`
  - 注入：`/inject id= position=chat depth= role= [scan=]` `/listinjects` `/flushinjects`
  - 其他模块：`/bg name|assetId`（M4（二）§A）、`/emote label`（§B）、`/imagine prompt`（§D）
- 原 `features/cards/slash.ts` 改为调用 core 的解析执行器；`triggerSlash` 与 Composer 里以 `/` 开头的输入都走它（Composer：输入以 `/` 开头且第一个词是已知命令时执行而不发送；未知命令给提示条，不发送）。

### 3.2 前端卡 generate 与注入

- `generate` / `generateRaw` 支持 `injects`、`overrides`、`tools`、`json_schema`、`preset_name`（按名称找预设，找不到报错）：
  - `injects` → `AssembleInputV2.extraInjections`（字段照 4.9.3 `InjectionPrompt`：`position:'in_chat'|'none'`、`depth`、`role`、`should_scan`）；
  - `overrides` → `promptOverrides`（字段见 assemble.ts 的类型，未列出的覆盖项给 warning）；
  - `tools` / `json_schema` → IR 的 `tools` / `responseFormat`（M6 契约 §1），工具调用结果按酒馆助手的返回形态交回卡。
- `injectPrompts(prompts, { once? })` / `uninjectPrompts(ids)`：存进 `chats.metadata.injects`（`once:true` 的在下一次生成成功后删除）；组装时并入 `extraInjections`。slash `/inject` 同一存储。
- `getPreset(name)` / `loadPreset(name)`（切换会话预设）；`formatAsTavernRegexedString(text, source, destination, {depth, character_name})` 改为真正调用 core 正则引擎（与显示侧同一套脚本选择规则）。
- 同步更新 M5 契约 §5.2 的兼容矩阵（本文件第一部分），标出这些接口的新状态。

### 3.3 应用级提示条

- `components/ui/toast.tsx`：`toast({ title, description?, tone: 'info'|'success'|'warning'|'danger', action? })`，右下（手机为顶部）堆叠最多 3 条，5 秒自动消失（danger 不自动消失），只用槽位与材质类；`prefers-reduced-motion` 下无位移动画。挂在 `AppLayout`。
- `FrontendCardFrame.tsx:132` 的遗留改用它；卡内 `toastr` 仍是卡自己的（不动）。

### 3.4 卡的主题贴合

- `buildSrcdoc` 的 `themeCss` 填入当前世界（含变体）的槽位值：从 `getComputedStyle(document.documentElement)` 读 `slots.css` 声明的槽位清单，生成 `:root{--nt-canvas:…;--nt-ink:…}` 并同时给酒馆助手常见的 `--SmartThemeBodyColor`、`--SmartThemeEmColor`、`--SmartThemeQuoteColor`、`--SmartThemeBlurTintColor`、`--SmartThemeBorderColor` 映射；切换主题时通过已有的镜像通道推送更新，不重建 iframe。

### 3.5 MVU 补全

- 额外模型解析：settings KV `mvu` 加 `extraModel?: { connectionId, model, when: 'missing' | 'always' }`；本轮正文里没有 `<UpdateVariable>` / `<JSONPatch>` 且 when='missing'（或 'always'）时，用 `callLlm`（M6 契约 §1.5）以「当前变量 + 本轮正文 + 卡里的变量更新规则（世界书里含 `[mvu_update]` / 名称含「变量更新规则」的条目）」请求一段 `<UpdateVariable>`，再走原引擎应用；节点 `extra.mvuSource = 'extra-model'`。
- 旧楼层快照清理：settings `mvu.keepSnapshots`（缺省 0 = 不清理）；>0 时在每次写入后，把当前路径上距 head 超过 N 层的节点的 `variables` 置为 `{ $pruned: true }`（重放遇到时从最近的完整快照起算并提示）。

## 4. EJS 提示词模板（E）

### 4.1 引擎（`packages/compat/src/ejs/`，入口 `@newtavern/compat/ejs`，只在服务端用）

- 语法（ST-Prompt-Template 兼容子集）：`<% code %>`、`<%_ code _%>`（吃掉前后空白）、`<%= expr %>`（HTML 转义——与 ST-Prompt-Template 一致，核对后以它为准）、`<%- expr %>`（原样）、`-%>`（吃掉后面的换行）、`<%%` 字面量。模板编译为一个 async 函数体。
- 执行：**quickjs-emscripten**（同步变体）沙箱。每段模板 200ms 超时（interrupt handler）、内存上限 32 MB、栈上限；没有 `require` / 网络 / 文件。编译结果按模板文本哈希缓存（LRU 500）。宿主函数全部同步，`await` 在沙箱内跑 pending jobs 解决。
- 宿主函数（对齐 ST-Prompt-Template 的名字与参数）：
  - `getvar(path, { scope?, defaults? })`、`setvar(path, value, { scope? })`、`incvar` / `decvar`；scope 缺省为 message(=chat)；`getvar('stat_data.昔涟.好感度')` 取点路径；VWD `[值, 说明]` 二元组按原样返回（与 ST-Prompt-Template 行为核对）。
  - `getwi(book | null, titleOrUid)`：在本次组装可见的世界书里按 comment（标题）或 uid 找条目，返回**渲染后的**内容（递归渲染，深度上限 5）；book 为 null 时搜全部。
  - `getchar(field?)`、`getpreset?` 不做；`print(...)` 追加输出；`_`（lodash 的 get/set/has/clone/merge/isEqual 子集，在沙箱里注入的纯 JS 实现）。
  - 未实现的 ST-Prompt-Template 函数调用时抛错，错误信息指出函数名。
- 导出：

```ts
export function createEjsRenderer(host: EjsHost, opts?: { timeoutMs?: number; memoryMb?: number }): {
  render(text: string, ctx: Parameters<TemplateRenderer>[1]): string;   // 与 core 的 TemplateRenderer 同签名
  dispose(): void;
};
export function hasEjs(text: string): boolean;   // 快速判断，免得每段都进沙箱
```

### 4.2 接入组装（core + 服务端）

- `assemblePrompt` 在这些点调用 `templateRenderer`（有且 `hasEjs` 为真时）：已激活世界书条目的 content（在 WI 激活之后、放置之前）、预设条目正文、角色卡字段（description / personality / scenario / system_prompt / post_history_instructions / mes_example / first_mes）、作者注释、persona 描述。**历史消息不渲染**（ST-Prompt-Template 默认也不渲染聊天消息里的模板，核对后以它为准，若它默认渲染则在 §5 修正里说明并照做）。
  - 渲染发生在宏展开**之前**（与 ST-Prompt-Template 的处理顺序核对后以它为准）。
  - 被渲染过的段 id 记进 `ir.meta.templated`；检查器段落列表给这些段加「模板」小标。
- 服务端 `services/ejs.ts`：按请求创建渲染器（host 闭包里拿到本次的 lorebooks 与变量工作副本），组装结束 `dispose`；settings KV `ejs: { enabled: boolean }`，**默认 true**；设置 → 前端卡 里加开关。
- 模板里的 `setvar` 写进本次组装的变量工作副本，随 `AssembleResult.variables` 返回并按现有规则落库（dryRun / 检查器不落库）。

### 4.3 验收

- 单测：语法（五种标签、空白吞吐、嵌套 if/else、for 循环、async getwi）、超时（死循环 200ms 内中断并返回原文 + warning）、内存上限、缓存。
- 真样本：导入本机 ST 的「黄金庭院」卡与世界书，把 `stat_data.昔涟.好感度` 分别改为 20 / 50 / 70 / 95，检查器里「昔涟」人设条目依次变成阶段 01 / 02 / 03 / 04 的内容。
- 黄金测试 62/62（缺省无渲染器，行为不变）。
- QuickJS 冷启动时间记录在报告里（首次渲染与后续渲染的耗时）。

## 5. 待协调与修正（M5（三））

（暂无）
