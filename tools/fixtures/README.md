# tools/fixtures

「新酒馆」兼容层（`packages/compat`）与适配器契约测试用的黄金样本目录，按类型分子目录：

```
tools/fixtures/
├─ cards/         # 角色卡：PNG（V2/V3 内嵌 chara/ccv3 tEXt chunk）与 CHARX
├─ presets/       # ST Chat Completion 预设 JSON
├─ worldbooks/    # ST 世界书（lorebook）JSON
├─ chats/         # ST 聊天记录 jsonl
└─ st-requests/   # ST 1.18 实际发出的请求快照，用于 strict 布局逐字节比对
```

## 这里放什么

只放**可公开分发**的内容：自制或已获授权公开分发的角色卡/预设/世界书/聊天样本、脱敏后的请求快照。
不要提交任何来自真实用户的私有数据——不确定授权状态的样本宁可不收。

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
