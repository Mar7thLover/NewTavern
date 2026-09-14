# @newtavern/golden

黄金测试包：用 `tools/fixtures` 里的合成素材，验证新酒馆 **strict** 布局的输出与
SillyTavern 1.18 的实际请求逐字节一致（`docs/M3-CONTRACT.md` §4.2、§8）。

```
tools/golden/
├─ record/record.mjs   # 录制工具：驱动本机 ST 1.18，抓取它真正发给端点的请求体（只在开发机跑）
└─ src/*.test.ts       # 黄金测试：只读 tools/fixtures/st-requests 下的快照（CI 跑）
```

## 录制快照

```bash
pnpm --filter @newtavern/golden record -- --all
```

前置条件、参数、原理与「如何新增用例」都写在 [`tools/fixtures/README.md`](../fixtures/README.md)。
录制工具**不会**读写本机 SillyTavern 的 `data/` 目录，也不修改 ST 目录里的任何文件：
它用 `os.tmpdir()` 下的独立 `--dataRoot` 起一个临时 ST 实例。

## 跑测试

```bash
pnpm --filter @newtavern/golden test
pnpm --filter @newtavern/golden typecheck
```

测试遍历 `tools/fixtures/st-requests/cases.json` 里 `recorded: true` 的用例，
读同名快照，构造 `AssembleInputV2`（`layoutMode: 'strict'`）走一遍组装 + `buildRequest`，
再与 `request.messages` 做 deep-equal。`cases.json` 的 `inputs.settings` 用 ST 原键名，
映射到 `WISettings` 由测试侧负责。
