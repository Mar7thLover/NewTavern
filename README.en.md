<p align="center">
  <img src="docs/assets/newtavern-mark.svg" alt="NewTavern logo: book pages and an open doorway" width="112" height="112" />
</p>

<h1 align="center">NewTavern</h1>

<p align="center">A self-hosted web application for AI roleplay and writing</p>

<p align="center"><a href="README.md" lang="zh-CN">简体中文</a> · <strong>English</strong></p>

<p align="center">
  <a href="https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml"><img src="https://github.com/Mar7thLover/NewTavern/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg" alt="License: AGPL-3.0-or-later" /></a>
</p>

NewTavern combines a browser interface with a local server. It supports major SillyTavern resource formats, native model protocols, cache-aware prompt assembly, and visual prompt inspection. Data and API keys are stored on the local server, while model requests are sent to your configured providers. Desktop and mobile browsers can connect over the same local network.

> **Current version: v0.1.0, early development.** Character imports, streaming conversations, reply switching, branching, and prompt inspection are available. See [limitations and roadmap](#limitations-and-roadmap) for feature coverage and validation status.

## Features

- **Model connections**: Native support for OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and Google Gemini, with a model capability catalog, remote detection, and manual overrides.
- **Prompt assembly and inspection**: `strict` mode follows SillyTavern 1.18 assembly behavior; `cache-aware` mode optimizes prompt layout for prefix caching. The inspector shows segment sources, world info activation reasons, regex processing, token usage, and cache breakpoints.
- **Resource compatibility and migration**: Import and export V2/V3 character cards (PNG, CHARX, JSON), presets, world info, personas, regex scripts, and JSONL chats. The directory migration wizard scans source files without modifying them and lets you select individual items.
- **Conversations and context**: Streaming replies, reply switching (swipes), branches, world info, macros, regex, and variables. World info timing state is saved per message node.
- **Multimodal support**: Image, PDF, and text attachments, plus image generation for supported models, a lightbox, and a gallery. Availability depends on the model and provider; see validation status below.
- **Interface and themes**: Chinese and English interfaces, six built-in themes, a command palette (`Ctrl/⌘ + K`), and virtualized message lists for long conversations.

## Quick start

Requires **Node.js 22 or later** and **pnpm 11.8.0**. Run from the repository root:

```bash
pnpm install
pnpm build
pnpm --filter @newtavern/server start
```

Open [http://localhost:8787](http://localhost:8787). Add your API endpoint and key in the connections and models page, select and test a model, then import a character card to start a conversation. Existing SillyTavern users can import resources through the migration wizard.

The server listens on `0.0.0.0` by default. Devices on your local network can connect at `http://<your-computer-LAN-IP>:8787`. Set `NT_HOST` to `127.0.0.1` for access from this computer only.

> **Access security**: The server currently has no authentication or access control. Anyone who can reach it can read your chats and use your configured API keys. Use it only on a trusted local network; do not expose it directly to the public internet. Migration endpoints accept local requests only.

### Configuration

| Environment variable | Default                           | Purpose                              |
| -------------------- | --------------------------------- | ------------------------------------ |
| `NT_PORT`            | `8787`                            | Server port                          |
| `NT_HOST`            | `0.0.0.0`                         | Server bind address                  |
| `NT_DATA_DIR`        | `<repository-root>/data/default`  | Data directory                       |
| `NT_WEB_DIST`        | `<repository-root>/apps/web/dist` | Frontend build directory             |
| `NT_API_TARGET`      | `http://localhost:8787`           | Vite API proxy target in development |

### Data and keys

Chats and configuration are stored in `tavern.sqlite` within the data directory. Original character cards, media assets, and backups are stored in `characters/`, `assets/`, and `backups/`, respectively.

API keys are encrypted with AES-256-GCM using `master.key` in the same directory. API responses reveal only the last four characters of each key. Back up the database, assets, and master key together. The `data/` directory is excluded from Git by default.

## Development

After installing dependencies, start the development environment:

```bash
pnpm dev
```

The frontend runs at [http://localhost:5173](http://localhost:5173), with the API server on port `8787`. Vite proxies `/api` requests automatically.

The server `dev` script uses Node’s built-in `--watch` (`node --watch --import tsx`) instead of `tsx watch`: the latter’s child process stalls during module loading once `pnpm -r --parallel` takes over stdio, so the server silently never starts (reproducible on Windows).

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
```

Tests cover unit logic, provider protocol contract replays, and SillyTavern compatibility. Golden tests compare `strict` message assembly against actual SillyTavern 1.18 request snapshots using 62 synthetic cases. See the [golden test guide](tools/golden/README.md) for recording instructions and the [fixture guide](tools/fixtures/README.md) for samples and prerequisites.

### Repository structure

| Directory              | Responsibility                                                               |
| ---------------------- | ---------------------------------------------------------------------------- |
| `apps/web`             | React 19, Vite, and Tailwind CSS frontend                                    |
| `apps/server`          | Hono and SQLite server for REST/SSE, assets, and model request forwarding    |
| `packages/core`        | Shared domain models, prompt assembly, world info, and message trees         |
| `packages/providers`   | Model protocol adapters, capability catalog, and normalized streaming events |
| `packages/compat`      | SillyTavern format compatibility and migration                               |
| `packages/i18n`        | Chinese and English dictionaries and built-in prompts                        |
| `packages/sandbox-sdk` | Frontend card sandbox protocol scaffold; runtime not yet implemented         |
| `packages/config`      | Shared development configuration                                             |
| `tools`                | Test fixtures and golden test recording tools                                |
| `docs`                 | Project plan, design guidelines, and interface contracts                     |

## Limitations and roadmap

NewTavern does not yet cover all SillyTavern features. The following capabilities are not implemented:

- Frontend card runtime, Tavern Helper compatibility, and MVU variable support.
- A complete authoring workspace with AI-assisted editing; only basic preset and world info editors are available.
- Group chats and their migration, long-form collaborative writing, CRPG branch saves, and multi-agent open worlds.
- Character expressions, backgrounds, external image generation backends (SD, ComfyUI, NovelAI), and theme import/export.
- Authentication, self-signed HTTPS, a Tauri desktop app, and a plugin API.

**Validation status**: Live text conversation tests currently cover only OpenAI-compatible and Anthropic-compatible endpoints. Google Gemini and OpenAI Responses text flows have only been validated through protocol contract replays. Multimodal features have only been tested against mock endpoints; Google Gemini and OpenAI Responses image generation, as well as OpenRouter streaming image responses, still require live endpoint testing.

See the [development plan](docs/PLAN.md) for progress and the [design guidelines](docs/DESIGN.md) for interface principles. These supporting documents are currently in Chinese.

## License

Licensed under [AGPL-3.0-or-later](LICENSE).
