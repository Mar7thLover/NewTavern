# 新酒馆 NewTavern

[![ci](https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml/badge.svg)](https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](LICENSE)

从零重写的 AI 角色扮演 / 写作前端。Web 应用 + 本地服务端（与 SillyTavern 同款的部署方式：本机跑一个进程，手机在同一局域网里用浏览器访问，API Key 只留在服务端）。

角色卡、预设、世界书、正则、聊天记录都直接吃 SillyTavern 的格式，**逐字节对照**它 1.18 实际发出的请求做过黄金测试；在此之上换了一套现代前端、四家提供商的原生适配，以及一个把提示词布局重排到能命中前缀缓存的组装流水线。

> **v0.1.0 — 早期版本。** 对话主链路（导入卡 → 选预设 → 流式对话 → swipe/分支 → 检查提示词）已经可以日常使用，但整体仍是 SillyTavern 的一个子集：前端卡与酒馆助手兼容、创作工作台、群聊都还没做。见文末「还没有的东西」。

---

## 现在能做什么

**四种协议，不是一种协议套四个壳**
OpenAI Chat Completions 兼容 / OpenAI Responses（推理项与加密推理回传）/ Anthropic Messages（缓存断点、中途 system 消息、adaptive thinking）/ Google Gemini（thinking level、隐式与显式缓存）。42 条模型的能力目录 + 远端探测 + 每模型手动覆盖；OpenAI 兼容中转站按 Base URL 与 `/models` 自动识别 quirks（`reasoning_content`、prefill、`stream_options` 之类）。

**缓存感知的提示词布局**
`strict` 逐字节复刻 SillyTavern 的组装结果（62 组 fixture 全部一致）；`cache-aware` 在不改变语义的前提下重排段落去命中各家前缀缓存——本机 20 轮真机会话平均缓存命中率 81.7%。两种模式随时切换，代价在检查器里看得见。

**提示词检查器**
发出去之前，每一段来自哪里（预设条目 / 角色卡字段 / 世界书哪一条被什么关键词激活 / 深度注入 / 作者注释 / 全局系统提示词）、被哪条正则改过、占多少 token、哪几个缓存断点落在哪里，逐段列出；还能和 SillyTavern 的组装结果做差异对照（开发者模式）。

**SillyTavern 资产无损进出**
角色卡 V2/V3（PNG / CHARX / JSON，未修改则导出原始字节）、预设、世界书、用户档案、正则脚本、聊天 jsonl（swipe / 分支 / 隐藏 / 附件都映射进消息树）。整目录迁移向导会扫描 ST 安装目录并让你逐项勾选，**只读不改**那边的文件。

**世界书、宏、正则、变量**
移植 ST 的激活算法（递归、组评分、sticky / cooldown / delay、装饰器），但时间态按消息节点快照——swipe 与重生成不会像 ST 那样把计数推进两次。

**多模态**
图片与 PDF 输入（PDF 抽文本）、四家适配器的原生图片/文档渲染、模型生图（Gemini / Responses 工具 / OpenRouter 形态）落库并直接显示，附带灯箱与画廊。

**六个主题，是六个互不相干的世界**
素 / 琉璃 / 书斋 / 酒馆 / 雨夜 / 暖房——各有自己的材质、光线、字体、动作和「记忆物件」（发送键、消息分隔、空状态插画各不相同），骨架与快捷键完全一致。设计原则写在 [`docs/DESIGN.md`](docs/DESIGN.md)。

中英双语 UI 与内置提示词；命令面板 `Ctrl/⌘ + K`；2000 条消息的会话首屏只渲染 5–7 个节点。

---

## 快速开始

需要 **Node ≥ 22** 与 **pnpm 11.8**（`corepack enable` 即可）。

```bash
pnpm install
pnpm dev
```

开发模式下打开 <http://localhost:5173>（Vite 带 `/api` 代理），服务端在 8787。

日常使用建议跑构建版，前端与 API 同一个端口：

```bash
pnpm build
pnpm --filter @newtavern/server start   # http://localhost:8787
```

服务端默认绑 `0.0.0.0`，手机在同一局域网用 `http://<电脑的局域网 IP>:8787` 就能访问。

**第一次用**：「连接与模型」加一个连接（Base URL + Key，拉取模型列表并测试）→「角色」导入一张卡 → 回到「对话」开始。已经在用 SillyTavern 的话，直接走「迁移向导」。

### 环境变量

| 变量            | 默认                    | 说明                                   |
| --------------- | ----------------------- | -------------------------------------- |
| `NT_PORT`       | `8787`                  | 服务端端口                             |
| `NT_HOST`       | `0.0.0.0`               | 绑定地址，只想本机访问就设 `127.0.0.1` |
| `NT_DATA_DIR`   | `./data/default`        | 数据目录                               |
| `NT_WEB_DIST`   | `./apps/web/dist`       | 前端构建产物目录                       |
| `NT_API_TARGET` | `http://localhost:8787` | 仅开发模式：Vite 把 `/api` 代理到哪里  |

---

## 数据与密钥

```
data/default/
├─ tavern.sqlite     # 唯一真源（WAL）
├─ master.key        # 本地主密钥，权限 0600
├─ characters/       # 导入时的原始 PNG / CHARX 字节
├─ assets/           # 内容寻址的图片、生图结果、卡内资源
└─ backups/
```

API Key 用 AES-256-GCM 加密后存库，主密钥是 `master.key`；接口对外只返回后 4 位。`data/` 不进 git。

⚠️ **服务端目前没有任何访问控制。** 能连上这个端口的人就能用你的 Key、读你的全部聊天记录。请只在信任的局域网里开放，不要暴露到公网（登录密码与自签 HTTPS 在计划内，还没做）。迁移向导额外限制为只接受本机请求。

---

## 仓库结构

```
apps/
  web/            React 19 + Vite + Tailwind v4 + Zustand + TanStack Query
  server/         Hono + SQLite (Drizzle)：REST + SSE、资产、API 转发、密钥保管
packages/
  core/           纯 TS：领域模型、提示词 IR、组装流水线、世界书 / 宏 / 正则 / 变量 / 消息树
  providers/      四类适配器、能力目录、流式事件归一化
  compat/         ST 兼容：PNG/CHARX 卡、预设、世界书、正则、聊天 jsonl、目录迁移
  sandbox-sdk/    前端卡沙箱协议（M5 才会用上）
  i18n/           zh-CN / en 词典与双语内置提示词
  config/         共享 tsconfig / eslint
tools/
  fixtures/       黄金样本：合成卡 / 预设 / 世界书 / 聊天 + ST 1.18 实际请求快照
  golden/         驱动本机 ST 抓取真实请求体的录制工具
docs/             PLAN.md（计划与进度）、DESIGN.md（设计宪章）、M{2,3,4}-CONTRACT.md（接口契约）
```

`packages/core` 在浏览器与 Node 里跑的是同一份代码：前端用它做检查器实时预览，服务端用它做发请求前的最终组装（以服务端为准）。

---

## 开发

```bash
pnpm typecheck
pnpm lint
pnpm test          # 单元 + 适配器契约回放 + 黄金测试
pnpm format
```

测试里最要紧的是 `tools/golden`：62 组合成用例先驱动本机 SillyTavern 1.18 录下它真正发出的请求体，再断言 `strict` 布局的输出与之逐字节一致。录制需要本机装有 ST：

```bash
node tools/golden/record/record.mjs --all
```

两项可选测试，只在给了环境变量时才跑：

```bash
# 用本机 ST 的真实数据做导入导出往返
NT_ST_DATA_DIR=/path/to/SillyTavern/data/default-user pnpm --filter @newtavern/compat test

# 对真实端点冒烟（Key 只从环境变量读）
NT_SMOKE_PROVIDER=anthropic NT_SMOKE_BASE_URL=... NT_SMOKE_MODEL=... NT_SMOKE_KEY=... \
  pnpm --filter @newtavern/providers exec tsx scripts/smoke.ts
```

---

## 还没有的东西

- **前端卡与酒馆助手兼容**（沙箱、核心 API 子集、MVU 变量）—— M5，`packages/sandbox-sdk` 目前只有协议骨架
- **创作工作台**（卡 / 预设 / 世界书的编辑与 AI 协作）—— M6；先行做了预设与世界书的基础编辑器
- **长篇写作共创、CRPG 分支存档、多智能体开放世界** —— M7 / M8
- **群聊**：不在对话里，也不迁移
- 立绘表情、背景、外接生图后端（SD / ComfyUI / NovelAI）、主题导入导出 —— M4（二）
- Tauri 桌面封装、插件 API —— M9

已知的验证缺口：多模态只在 mock 端点上验证过（手头的测试端点没有视觉模型）；Google 与 OpenAI Responses 的生图、OpenRouter 的流式 `delta.images` 形状未实测；Google 与 Responses 的文本链路只有契约回放测试，真机只跑过 OpenAI 兼容与 Anthropic 兼容端点。

完整进度见 [`docs/PLAN.md`](docs/PLAN.md) 的「进度记录」。

---

## 许可证

[AGPL-3.0-or-later](LICENSE)。
