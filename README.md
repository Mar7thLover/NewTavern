<p align="center">
  <img src="docs/assets/newtavern-mark.svg" alt="NewTavern Logo：书页与敞开的门" width="112" height="112" />
</p>

<h1 align="center">新酒馆 · NewTavern</h1>

<p align="center">面向 AI 角色扮演与写作的自托管 Web 应用</p>

<p align="center"><strong>简体中文</strong> · <a href="README.en.md" lang="en">English</a></p>

<p align="center">
  <a href="https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml"><img src="https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="许可证：AGPL-3.0-or-later" /></a>
</p>

NewTavern 采用浏览器前端与本地服务端架构，兼容 SillyTavern 的主要资源格式，提供原生模型协议适配、缓存感知的提示词组装与可视化检查。数据和 API 密钥保存在本地服务端，模型请求发送至你配置的提供商；同一局域网内可通过电脑或手机浏览器访问。

> **当前版本：v0.1.0，早期开发阶段。** 已支持角色导入、流式对话、回复切换、分支与提示词检查。功能范围及验证限制见[当前限制与路线图](#当前限制与路线图)。

## 核心功能

- **模型接入**：原生支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages 与 Google Gemini；提供模型能力目录、远端探测与手动覆盖。
- **提示词组装与检查**：`strict` 模式对齐 SillyTavern 1.18 的组装行为；`cache-aware` 模式优化提示词布局以利用前缀缓存。检查器展示片段来源、世界书激活原因、正则处理、Token 用量与缓存断点。
- **资源兼容与迁移**：支持 V2/V3 角色卡（PNG、CHARX、JSON）、预设、世界书、用户档案、正则脚本与 JSONL 聊天记录的导入导出。目录迁移向导只读扫描源文件，支持逐项选择。
- **对话与上下文管理**：支持流式回复、回复切换（swipe）、分支、世界书、宏、正则与变量；世界书时间状态按消息节点保存。
- **多模态**：支持图片、PDF 与文本附件，以及适配模型的图片生成、灯箱和画廊。支持范围取决于模型与提供商，验证状态见下文。
- **界面与主题**：提供中英文界面、六套内置主题、命令面板（`Ctrl/⌘ + K`）与长会话列表虚拟化。

## 快速开始

需要 **Node.js 22 或更高版本**与 **pnpm 11.8.0**。在仓库根目录执行：

```bash
pnpm install
pnpm build
pnpm --filter @newtavern/server start
```

打开 [http://localhost:8787](http://localhost:8787)。首次使用时，在「连接与模型」中添加 API 地址和密钥、选择并测试模型，再到「角色」导入角色卡并开始对话。现有 SillyTavern 用户可通过「迁移向导」导入资源。

服务端默认监听 `0.0.0.0`，局域网设备可通过 `http://<电脑的局域网 IP>:8787` 访问。仅需本机访问时，将 `NT_HOST` 设为 `127.0.0.1`。

> **访问安全**：当前服务端没有身份认证或访问控制。能访问服务端的人即可读取聊天记录并使用已配置的 API 密钥。仅在可信局域网内使用，不要直接暴露到公网。迁移接口仅接受本机请求。

### 配置

| 环境变量        | 默认值                       | 用途                            |
| --------------- | ---------------------------- | ------------------------------- |
| `NT_PORT`       | `8787`                       | 服务端端口                      |
| `NT_HOST`       | `0.0.0.0`                    | 服务端监听地址                  |
| `NT_DATA_DIR`   | `<仓库根目录>/data/default`  | 数据存储目录                    |
| `NT_WEB_DIST`   | `<仓库根目录>/apps/web/dist` | 前端构建产物目录                |
| `NT_API_TARGET` | `http://localhost:8787`      | 开发模式下 Vite 的 API 代理目标 |

### 数据与密钥

聊天记录与配置保存在数据目录的 `tavern.sqlite` 中；原始角色卡、媒体资源与备份分别位于 `characters/`、`assets/` 和 `backups/`。

API 密钥使用 AES-256-GCM 加密存储，主密钥保存在同目录的 `master.key` 中，API 响应仅显示密钥末四位。备份时应一并保留数据库、资源与主密钥；`data/` 默认不纳入 Git 版本控制。

## 开发

安装依赖后启动开发环境：

```bash
pnpm dev
```

前端地址为 [http://localhost:5173](http://localhost:5173)，API 服务端口为 `8787`，Vite 自动代理 `/api` 请求。

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

测试覆盖单元逻辑、提供商协议契约回放与 SillyTavern 兼容性。黄金测试基于 62 组合成用例，将 `strict` 模式的消息组装结果与 SillyTavern 1.18 的实际请求快照进行比对。录制流程见[黄金测试说明](tools/golden/README.md)，样本与前置条件见[测试样本说明](tools/fixtures/README.md)。

### 仓库结构

| 目录                   | 职责                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `apps/web`             | React 19、Vite 与 Tailwind CSS 前端                          |
| `apps/server`          | Hono 与 SQLite 服务端，提供 REST/SSE、资源管理与模型请求转发 |
| `packages/core`        | 领域模型、提示词组装、世界书与消息树；前后端共享             |
| `packages/providers`   | 模型协议适配、能力目录与流式事件归一化                       |
| `packages/compat`      | SillyTavern 格式兼容与迁移                                   |
| `packages/i18n`        | 中英文词典与内置提示词                                       |
| `packages/sandbox-sdk` | 前端卡沙箱协议骨架，尚未实现运行时                           |
| `packages/config`      | 共享开发配置                                                 |
| `tools`                | 测试样本与黄金测试录制工具                                   |
| `docs`                 | 项目计划、设计规范与接口契约                                 |

## 当前限制与路线图

NewTavern 尚未覆盖 SillyTavern 的全部功能。以下能力尚未实现：

- 前端卡运行时、酒馆助手兼容与 MVU 变量支持。
- 完整创作工作台及 AI 协作编辑；目前仅有预设与世界书的基础编辑器。
- 群聊及群聊迁移、长篇写作共创、CRPG 分支存档与多智能体开放世界。
- 立绘表情、背景、外接生图后端（SD、ComfyUI、NovelAI）与主题导入导出。
- 身份认证、自签名 HTTPS、Tauri 桌面封装与插件 API。

**验证范围**：文本对话的真实端点测试目前仅覆盖 OpenAI 兼容与 Anthropic 兼容接口；Google Gemini 与 OpenAI Responses 文本链路仅通过协议契约回放验证。多模态仅通过模拟端点验证，Google Gemini、OpenAI Responses 的图片生成及 OpenRouter 流式图片返回仍待真实端点测试。

项目进度见[开发计划](docs/PLAN.md)，界面设计原则见[设计规范](docs/DESIGN.md)。

## 许可证

本项目采用 [AGPL-3.0-or-later](LICENSE) 许可证。
