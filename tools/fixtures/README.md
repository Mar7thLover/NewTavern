# tools/fixtures

「新酒馆」兼容层（`packages/compat`）与**黄金测试**（`tools/golden`）的样本目录。

黄金测试的目标（`docs/PLAN.md` §3.2「保真度保障」、`docs/M3-CONTRACT.md` §4.2）：
同一套输入下，新酒馆 **strict** 布局输出的请求体与 SillyTavern 1.18 实际发给端点的请求体
**逐字节一致**。本目录既提供那套输入（合成素材），也提供 ST 的真实输出（请求快照）。

## 授权：全部 CC0

```
除另有说明外，本目录下的全部角色卡、预设、世界书、聊天记录、Persona、正则脚本
均为「新酒馆」项目自创内容，以 CC0-1.0（公共领域贡献）发布。
```

内容不含任何第三方角色、预设、世界书文本。往这里新增素材时同样只能放自创或已获授权公开
分发的内容——不确定授权状态的样本宁可不收。**任何情况下都不要把真实用户数据
（本机 SillyTavern 的 `data/` 目录）复制进来。**

## 目录结构

```
tools/fixtures/
├─ cards/          # 合成角色卡（CCv3 JSON；需要 PNG 时由 compat 现场生成，不提交二进制）
├─ presets/        # 合成 ST Chat Completion 预设
├─ worldbooks/     # 合成 ST 世界书（多一个 name 字段 = 写入 ST 时的世界名/文件名）
├─ chats/          # 合成 ST 聊天记录 jsonl
├─ personas/       # { name, description }
├─ regex/          # 合成 ST 正则脚本（数组，录制时写进 extension_settings.regex）
└─ st-requests/
   ├─ cases.json   # 用例清单（唯一真源）
   └─ <case-id>.json  # 每个用例的 ST 请求快照
```

### 素材清单

| 文件                            | 用途                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `cards/quill.json`              | 极简英文卡：只有描述/性格/场景/开场白/一段示例，做最小基线                                                          |
| `cards/lin-yueyao.json`         | 「全功能」中英混合卡：`system_prompt`、`post_history_instructions`、三段 `mes_example`、两条 `alternate_greetings`、`extensions.depth_prompt`、`extensions.regex_scripts`、`extensions.world`、内嵌 `character_book` |
| `cards/kanata.json`             | CJK 卡，配合中文世界书做整词/子串匹配                                                                              |
| `presets/baseline.json`         | ST 默认 prompt_order 的基线预设                                                                                     |
| `presets/depth-inject.json`     | 五个自定义 prompt：`injection_position=1` 的 depth 0/2/4、三种 role、同深度不同 `injection_order`，外加一个相对位置段 |
| `presets/squash-system.json`    | `squash_system_messages: true`                                                                                      |
| `presets/forbid-overrides.json` | `main` / `jailbreak` 带 `forbid_overrides: true`                                                                    |
| `presets/empty-and-disabled.json` | 空 `main`、被 `prompt_order` 关闭的段、非空 `send_if_empty`                                                       |
| `presets/custom-formats.json`   | 自定义 `new_chat_prompt` / `new_example_chat_prompt` / `wi_format` / `scenario_format` / `personality_format`        |
| `presets/macro-probe.json`      | 把一批宏塞进 `main` / `nsfw`，用来观察 ST 的宏展开结果                                                              |
| `presets/names-completion.json` | `names_behavior: 2`（消息带 `name`）                                                                                |
| `worldbooks/positions.json`     | position 0–6 各一条 + 两条同位置不同 `order`                                                                        |
| `worldbooks/constant.json`      | `constant` 条目、禁用条目、永不命中的反例                                                                           |
| `worldbooks/logic.json`         | `selectiveLogic` 0–3、正则键、条目级 `caseSensitive` / `matchWholeWords` / `scanDepth`                               |
| `worldbooks/groups.json`        | 组：`groupOverride`（prioritize）、`useGroupScoring`、单成员组（避开随机）                                          |
| `worldbooks/timed.json`         | `sticky` / `cooldown` / `delay`                                                                                     |
| `worldbooks/recursion.json`     | 三层递归链 + `preventRecursion` + `excludeRecursion` + `delayUntilRecursion`                                        |
| `worldbooks/budget.json`        | 三条长条目触发预算溢出 + 一条 `ignoreBudget`                                                                        |
| `worldbooks/cjk.json`           | 中文整词/单字/子串匹配 + 英文整词反例                                                                               |
| `worldbooks/names.json`         | 键就是角色名/用户名，用来观察 `world_info_include_names` 对扫描缓冲的影响                                           |
| `worldbooks/yueyao-inn.json`    | 角色书（由 `lin-yueyao` 卡的 `extensions.world` 绑定），含 constant / 触发 / position 4                             |
| `worldbooks/chat-notes.json`    | 聊天书（绑定到 `chat_metadata.world_info`）                                                                         |
| `chats/quill-basic.jsonl`       | 两条历史                                                                                                            |
| `chats/quill-long.jsonl`        | 八条历史，用于深度注入、`delay`、扫描窗口、作者注释 interval                                                        |
| `chats/quill-hidden.jsonl`      | 含 system 消息与 `is_system: true` 的隐藏消息                                                                       |
| `chats/yueyao-basic.jsonl`      | 中英混合四条历史（含一条带 `(OOC: …)` 的用户消息，配合角色域正则）                                                  |
| `chats/yueyao-long.jsonl`       | 中英混合八条历史                                                                                                    |
| `chats/kanata-cjk.jsonl`        | 纯中文三条历史                                                                                                      |
| `personas/*.json`               | `Wren`（英文）与 `小禾`（中文）                                                                                     |
| `regex/*.json`                  | 用户输入 / AI 输出 / min-max depth / 世界书 四组正则脚本                                                            |

**注意**：`cards/lin-yueyao.json` 的 `extensions.world` 指向世界名 `FX Yueyao Inn`
（= `worldbooks/yueyao-inn.json` 的 `name`）。用到这张卡的用例必须在 `inputs.characterBook`
里带上 `yueyao-inn`，否则 ST 会因为卡里有内嵌 `character_book` 而弹出导入询问框，阻塞自动化。

## 用例清单格式 `st-requests/cases.json`

```jsonc
{
  "stVersion": "1.18.0",
  "license": "CC0-1.0",
  "cases": [
    {
      "id": "wi-position-before-after",      // kebab-case，同时是快照文件名
      "description": "一句话说明这个用例测什么",
      "inputs": {
        "card": "quill",                     // cards/<id>.json
        "preset": "baseline",                // presets/<id>.json
        "worldbooks": ["positions"],         // worldbooks/<id>.json，写入 worlds/ 并进全局选中
        "characterBook": null,               // 写入 worlds/，由卡的 extensions.world 绑定（角色作用域）
        "chatLorebook": null,                // 写入 worlds/，绑到 chat_metadata.world_info（聊天作用域）
        "globalRegex": [],                   // regex/<id>.json，写进 extension_settings.regex
        "chat": "quill-basic",               // chats/<id>.jsonl
        "persona": "wren",                   // personas/<id>.json
        "settings": { "world_info_depth": 2 },  // ST 原键名，覆盖在 ST 默认值之上
        "authorsNote": null,                 // { text, position, depth, role, interval }，写进 chat_metadata.note_*
        "priorUserMessages": [],             // 在被录制的那一轮之前先发的用户消息（用于推进 sticky/cooldown 等时间态）
        "userMessage": "I need the lantern."  // 本轮用户输入
      },
      "expect": ["人读的预期，如「lantern 条目落在 charDescription 之前」"],
      "recorded": true,                      // 由 record.mjs 回写
      "notRecordedReason": "…"               // 录制失败时由 record.mjs 回写
    }
  ]
}
```

`inputs.settings` 用 **ST 原键名**（`world_info_depth`、`world_info_budget`、
`world_info_recursive`、`world_info_case_sensitive`、`world_info_match_whole_words`、
`world_info_use_group_scoring`、`world_info_max_recursion_steps`、`world_info_min_activations`、
`world_info_min_activations_depth_max`、`world_info_include_names`、`world_info_budget_cap`、
`world_info_overflow_alert`、`world_info_character_strategy`）；黄金测试负责把它们映射到
`WISettings`（见 `docs/M3-CONTRACT.md` §9）。未列出的键取 ST 默认值。

## 请求快照格式 `st-requests/<case-id>.json`

```jsonc
{
  "id": "wi-position-before-after",
  "description": "…",
  "stVersion": "1.18.0",
  "capturedAt": "2026-09-14T02:02:28.979Z",
  "inputs": { /* cases.json 里同一条的副本，保证快照自包含 */ },
  "expect": ["…"],
  "request": { /* ST 后端转发给端点的原始 body，原样保存 */ },
  "notes": ["录制过程中观察到的异常"]
}
```

`request` 是 **ST 服务端转发给上游端点的 body**（不是浏览器发给 ST 的 body），
也就是 `src/endpoints/backends/chat-completions.js` 里 `POST ${custom_url}/chat/completions`
的那个对象：`messages` / `model` / `temperature` / `max_tokens` / `stream` /
`presence_penalty` / `frequency_penalty` / `top_p` 等。

## 录制

### 前置条件

- 本机装有 SillyTavern 1.18.0。路径由环境变量 `NT_ST_DIR` 指定，默认 `D:\Projects\SillyTavern`
  （也可以用 `--st-dir`）。
- Google Chrome（默认 `C:\Program Files\Google\Chrome\Application\chrome.exe`，
  可用环境变量 `NT_CHROME` 覆盖）。
- Node 22（用到 `node:module` 的 `registerHooks` 与内建 TS 类型剥离，直接加载
  `@newtavern/compat` 的 TS 源码来生成角色卡 PNG）。
- 端口 8100（ST）、9911（mock 端点）、9222（Chrome 调试）空闲，可用参数改。

### 跑起来

```bash
pnpm --filter @newtavern/golden record -- --all
# 或
node tools/golden/record/record.mjs --case preset-default-minimal
```

参数：`--all` / `--case <id>`（可重复）/ `--st-dir` / `--st-port` / `--mock-port` /
`--cdp-port` / `--keep`（保留临时 dataRoot 便于排查）。

### 它做了什么

1. 在进程内起一个记录请求体的 mock OpenAI 端点（`/v1/models` + `/v1/chat/completions`，
   返回固定短回复）。
2. 在 ST 目录内用 `node server.js --dataRoot <临时目录> --port … --listen false
   --browserLaunchEnabled false --whitelist false --basicAuthMode false --disableCsrf true`
   起一个 ST 实例。**临时 dataRoot 在 `os.tmpdir()/newtavern-golden/<timestamp>` 下，
   全程不读写本机 ST 自己的 `data/` 目录，也不修改 ST 目录里的任何文件。**
3. 首次启动后把 ST 自动铺好的 `default-user` 快照成模板；**每个用例都从模板重建
   一份干净的 `default-user`**（并清空 `characters/` `worlds/` `chats/` `OpenAI Settings/`，
   去掉 ST 自带的 Seraphina/Eldoria），再写入该用例的卡 PNG、预设、世界书、聊天 jsonl、
   `settings.json`、`secrets.json`（`api_key_custom` 是假值）。
4. 用 headless Chrome + CDP `Runtime.evaluate` 调 `SillyTavern.getContext()`：
   点连接按钮 → `/preset <名字>` → `selectCharacterById` → `openCharacterChat('golden')`
   → 写 `#send_textarea` 并调 `generate('normal')`（`priorUserMessages` 会先按顺序发一遍）。
5. 取 mock 收到的**最后一个** body，连同 `stVersion` / `capturedAt` / `inputs` / `notes`
   写进 `st-requests/<case-id>.json`，并把 `recorded` 回写到 `cases.json`。

工具是幂等的、可重跑的，只在开发机上用，CI 不跑；`tools/golden` 的 vitest 只读快照。
每个用例结束后只结束工具自己启动的进程（按 PID 结束进程树，不会按镜像名批量杀 node/chrome）。

### 新增用例

1. 需要新素材就往 `cards/` `presets/` `worldbooks/` `chats/` `personas/` `regex/` 里加
   （世界书记得写 `name`，它同时是写入 ST 时的世界名与文件名）。
2. 在 `cases.json` 的 `cases` 数组里追加一条，`id` 用 kebab-case，`expect` 写人能读懂的预期。
3. `node tools/golden/record/record.mjs --case <新 id>`，检查生成的快照是否符合 `expect`。
4. 录不出来的用例把原因留在 `cases.json` 的 `notRecordedReason` 里（`recorded: false`），
   黄金测试会跳过它们。

### 设计约束

- **用例里不放 `random` / `roll` / `time` / `date` / `idle_duration` 这类宏**，也不放
  `probability < 100` 或多成员随机权重组——它们无法与 ST 对齐；这些逻辑走
  `packages/core` 的单元测试（固定 `random`）。
- 组的确定性来自 `groupOverride`（prioritize）与 `useGroupScoring`（按命中键数评分）。
- 时间态（sticky / cooldown）通过 `priorUserMessages` 让 ST 自己推进，不去手写
  `chat_metadata.timedWorldInfo`（里面的 `hash` 由 ST 内部计算，手写会被丢弃）。

## `NT_ST_DATA_DIR` 可选往返测试

除了本目录的黄金样本，`packages/compat/src/st/real-samples.test.ts` 还提供一套**可选**测试，
用来在开发机上直接对着一份真实 SillyTavern 用户数据目录（例如本地安装的
`data/default-user`）跑角色卡 / 预设 / 世界书 / 聊天记录的导入导出往返，作为黄金样本之外的
补充验收，不依赖把这些私有文件收进仓库。

用法：设置环境变量 `NT_ST_DATA_DIR` 指向该目录后运行

```bash
NT_ST_DATA_DIR=/path/to/SillyTavern/data/default-user pnpm --filter @newtavern/compat test -- real-samples
```

- 只读该目录下的 `characters/`、`OpenAI Settings/`、`worlds/`、`chats/` 四个子目录；不会读取
  `secrets.json`、`settings.json` 等其他文件。
- 断言只比较解析结果是否往返一致，不会把卡片/预设/世界书/聊天的内容文本打印到测试输出或
  提交到仓库；输出里只会出现文件名与统计数字。
- 未设置该变量，或目录不存在时，这套测试整体跳过（`describe.skip`），不影响默认的
  `pnpm --filter @newtavern/compat test`，也不会在 CI 中运行（CI 环境没有这个目录）。
- **不要把这份真实数据目录里的文件复制进本仓库**——黄金样本（上面几个子目录）必须是可公开
  分发的内容，真实用户数据只通过 `NT_ST_DATA_DIR` 在本机临时读取。
