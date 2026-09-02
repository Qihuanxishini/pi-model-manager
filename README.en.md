# pi-model-manager

English · [简体中文](./README.md)

[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.84.2-6f42c1)](https://github.com/earendil-works/pi)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.2-2f81f7.svg)](https://github.com/NietzscheLi/pi-model-manager)

A TUI model and provider manager for [Pi](https://github.com/earendil-works/pi). It keeps Pi's native `models.json` as the single source of truth for model configuration while adding provider/model editing, client-header identities, proxy routing, and protocol compatibility controls.

> The current stable version is `0.3.2` and requires Pi `>=0.84.2`.
>
> This project is a maintained fork of [Qihuanxishini/pi-model-manager](https://github.com/Qihuanxishini/pi-model-manager). It is distributed under the [AGPL-3.0 license](./LICENSE). When redistributing a modified version you must retain the copyright and license notices, provide the corresponding source, and clearly mark your changes.

## Interface preview

The screens below are rendered by the real components at 88 columns. In practice column widths adapt to your data, the selected row is highlighted with a background colour, and column values are semantically coloured. This preview uses Simplified Chinese; the live UI can switch between Simplified Chinese and English from the dashboard.

```text
────────────────────────────────────────────────────────────────────────────────────────
/model-manager
4 接入 · 5 模型 · 0 内置抓包 · 0 自定义请求头

  接入                API          模型  请求头           代理    认证    状态
❯ OpenAI (openai)     Responses       2  Auto→Codex       direct  env     ready
  Claude (claude)     Claude          1  ClaudeCode       direct  env     ready
  Gemini (gemini)     Gemini          1  Auto→不添加      direct  env     ready
  Local vLLM (local)  Chat            1  Off              proxy   key     ready

────────────────────────────────────────────────────────────────────────────────────────
OpenAI (openai)
  endpoint  https://api.openai.com/v1
  proxy     direct
  api       Responses · headers Auto→Codex · auth env
  models    gpt-5.6-sol, gpt-5.6-terra

↑↓ 选择   Enter 进入   N 新建接入   D 删除接入   H 请求头   Esc 退出   / 搜索
────────────────────────────────────────────────────────────────────────────────────────
```

<details>
<summary>Show the other four screens</summary>

### Models inside a provider

```text
────────────────────────────────────────────────────────────────────────────────────────
/model-manager / OpenAI
Responses · 2 模型 · headers Auto→Codex · proxy direct · auth env
endpoint  https://api.openai.com/v1

  模型 ID         显示名    输入        Thinking   上下文
❯ gpt-5.6-sol     默认      文本,视觉   开           1.1M
  gpt-5.6-terra   默认      文本,视觉   开           1.1M

↑↓ 选择   Enter 编辑模型   A 添加模型   E 编辑接入   D 删除模型
Esc 返回   / 搜索
────────────────────────────────────────────────────────────────────────────────────────
```

### Provider setup

```text
────────────────────────────────────────────────────────────────────────────────────────
编辑接入 openai
API Responses · 请求头 自动推荐（Auto→Codex）
接入 ID 必填，且不能与已有或 pi 内置接入重复
Ctrl+S 保存并同步 models.json；不切换当前会话模型

  接入 ID         openai
  显示名称        OpenAI
  API 协议        OpenAI Responses
❯ Base URL        https://api.openai.com/v1
  本机代理        关闭
  代理地址        关闭时不使用
  API key         $OPENAI_API_KEY
  认证头          默认
  请求头          自动推荐（Auto→Codex）

↑↓ 选择   ←→ 切换选项   Enter 编辑   Ctrl+S 保存并同步   Esc 返回
────────────────────────────────────────────────────────────────────────────────────────
```

### Model capabilities

```text
────────────────────────────────────────────────────────────────────────────────────────
编辑模型 gpt-5.6-sol
接入 openai · API Responses
Ctrl+S 保存并启用模型；不切换当前会话模型

  模型 ID         gpt-5.6-sol
  重新拉取        上游模型列表
  显示名称        默认 = 模型 ID
❯ 视觉支持        开启
  Thinking        开启
  Fast mode       关闭
  上下文窗口      1050000
  最大输出        128000
  请求头          跟随接入（Auto→Codex）

↑↓ 选择   ←→ 切换选项   Enter 编辑   Ctrl+S 保存并启用   Esc 返回
────────────────────────────────────────────────────────────────────────────────────────
```

### Model discovery

```text
────────────────────────────────────────────────────────────────────────────────────────
选择模型（openai）
搜索: <直接输入搜索>
匹配 9 / 9 · 页码 1 / 2

  gpt-5.3
  gpt-5.4
  gpt-5.4-mini
  gpt-5.5
  gpt-5.6-luna
❯ gpt-5.6-sol  ← 当前
  gpt-5.6-terra
  gpt-image-2

↑↓ 选择 · ←→/PgUp/PgDn 翻页 · 输入搜索 · Backspace 删除 · Enter 确认 · Esc 取消
────────────────────────────────────────────────────────────────────────────────────────
```

</details>

## Features

- Create, edit, and delete providers and models from the `/model-manager` TUI.
- Start in Simplified Chinese and press `L` on the dashboard to switch to English; the language preference is saved.
- Supports `openai-completions`, `openai-responses`, `anthropic-messages`, and `google-generative-ai`.
- Fetch model IDs from compatible upstream APIs or enter them manually.
- Configure context window, maximum output, vision support, and reasoning support.
- Choose Anthropic Adaptive Thinking or Legacy Thinking.
- Enable `service_tier=priority` (Fast mode) per OpenAI Responses model.
- Route each provider directly or through its own HTTP(S) proxy.
- Use recommended, disabled, Claude Code, Codex, or custom client-header profiles.
- Reference API keys as literals, `$ENV_VAR` / `${ENV_VAR}`, or Pi `!command` values.
- Persist configuration with a cross-process lock and recoverable two-file transactions, then re-register managed providers after saving.

## Installation

### Install from GitHub (recommended for now)

```bash
pi install git:github.com/NietzscheLi/pi-model-manager
```

Try it for the current run without adding it to Pi's package settings:

```bash
pi -e git:github.com/NietzscheLi/pi-model-manager
```

Update Git-installed extensions with:

```bash
pi update --extensions
```

### Install from npm

`pi-model-manager` is published as a public npm package:

```bash
pi install npm:pi-model-manager
```

## Quick start

1. Start the Pi TUI.
2. Run:

   ```text
   /model-manager
   ```

3. Manage providers from the dashboard:

   | Key | Action |
   | --- | --- |
   | `Enter` | Open the selected provider and manage its models |
   | `N` | Create a provider and its first model |
   | `D` | Delete the selected provider |
   | `H` | Manage reusable header profiles |
   | `L` | Switch the UI language (Simplified Chinese / English); the choice applies immediately and is saved |
   | `/` | Search the current list; `Tab` leaves the input while keeping the filter, `Esc` clears it |
   | `Esc` | Go back or exit |

   Single-letter shortcuts are case-insensitive. The footer hints wrap per item, so they are never truncated away on narrow terminals.

4. In an editor, use `↑` / `↓` to select a field and press `Enter` to edit it. Toggle switch fields in place with `←` / `→`, then press `Ctrl+S` to save.

Saving updates and enables the model, but it does not force the current session to switch models.

## Provider and model configuration

Each provider can define:

- API protocol and base URL
- API key and authorization-header behavior
- Client-header identity
- Provider-specific HTTP(S) proxy
- One or more models

When adding a model, the extension attempts to fetch the upstream model list. The complete discovery flow, including authentication fallbacks, shares one 10-second limit and can be cancelled with `Esc`. You can still enter a model ID manually after failure or cancellation.

The base URL is normalized as you enter it into the root address each protocol's SDK expects: OpenAI variants get `/v1` appended, Anthropic has `/v1` stripped, and Google gets `/v1beta` on its official host. A non-root path you type explicitly (such as `https://gw.example.com/custom`) is never rewritten. Switching the API protocol re-normalizes the address for the new protocol. As a result `models.json` always stores the actual request root, so Pi can use it directly even when this extension is not loaded.

Model capabilities include:

- Display name
- Vision support (text only, or text + image input)
- Reasoning support
- Anthropic Adaptive/Legacy Thinking
- OpenAI Responses Fast mode
- Context window and maximum output tokens

## Client-header profiles

| Profile | Behavior |
| --- | --- |
| Recommended | Claude Code for Anthropic Messages, Codex for OpenAI Completions/Responses, and no identity headers for other protocols |
| Disabled | Adds no extension-managed client identity headers |
| Claude Code | Uses the built-in Claude Code compatibility headers and adds required Anthropic request metadata |
| Codex | Uses the built-in Codex TUI compatibility headers |
| Custom | Uses a reusable JSON header set created in the header-profile panel |

The current built-in values were derived from real client requests with authentication fields removed:

- Claude Code `2.1.243`
- Codex TUI `0.149.1`

These headers only help API gateways that require a recognized client identity; they do not replace an API key. The public repository and npm package contain **no request-capture tooling, user captures, authentication headers, or machine-local state**. Disable identity headers or create a custom profile if a built-in profile does not fit your endpoint.

Custom profiles reject authentication-related sensitive headers. Put authentication material in the provider's API-key setting instead.

## Configuration files

| Path | Purpose |
| --- | --- |
| `~/.pi/agent/models.json` | Native Pi provider and model definitions; the single source of truth for model configuration |
| `~/.pi/agent/extensions/pi-model-manager/state.json` | Extension metadata such as header choices, custom profiles, proxy switches, and Fast mode |

The extension generates client headers, proxy routes, and dynamic registrations only for explicitly managed providers. Ownership requires both a managed ID in `state.json` and a `piModelManager.managed` marker on the Provider node in `models.json`; this prevents a deleted Provider ID from silently taking ownership of an unrelated native Provider that later reuses the same ID. Native providers without this ownership evidence remain unmanaged: saving unrelated settings does not rewrite their existing headers or unknown native fields. Built-in Pi providers cannot be edited or deleted through this extension.

Plugin configuration writes are serialized with a cross-process lock, and `enabledModels` also honors Pi's `proper-lockfile` lock. An intent journal makes the `models.json` / `state.json` pair recoverable after interruption, and readers reject an in-progress half-written pair. External editors do not honor these locks, so content hashes are still checked before saving; an external change cancels the save instead of being overwritten.

## Secrets and security

Pi extensions run with the current user's permissions and have full system access. Review the source before installing any third-party extension.

Prefer environment-variable or command references over plaintext secrets in `models.json`:

```text
$OPENAI_API_KEY
${ANTHROPIC_API_KEY}
!your-secret-command
```

Additional considerations:

- Custom client headers are not a credential store.
- Enabling a provider proxy routes that provider's requests through the configured proxy URL.
- Model discovery sends a network request to the configured upstream endpoint.
- The repository ignores `state.json`, runtime logs, request captures, and other machine-specific files.

## Compatibility

| Component | Requirement |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `>=0.84.2` |
| `@earendil-works/pi-tui` | `>=0.75.0` |
| Runtime mode | `/model-manager` requires the Pi TUI |

The TUI copy defaults to Simplified Chinese; press `L` on the dashboard to switch to English.

## Local development

```bash
git clone https://github.com/NietzscheLi/pi-model-manager.git
cd pi-model-manager
npm install
pi -e .
```

Pi loads the TypeScript entry point directly; no separate build step is required. Do not commit `state.json`, `bootstrap-meta.json`, `node_modules`, or request-capture data.

Inspect the public package contents with:

```bash
npm pack --dry-run
```

## Reporting issues

Open a reproducible report in [GitHub Issues](https://github.com/NietzscheLi/pi-model-manager/issues). Remove API keys, authentication headers, proxy credentials, and private endpoints before sharing configuration or logs.

## Friendly links

* [Linux DO](https://linux.do)

## License

This project is licensed under the [GNU Affero General Public License v3.0 only](./LICENSE). Modified distributions must provide the corresponding source, remain under AGPL-3.0, and identify their changes; they must not represent themselves as official releases. See [NOTICE](./NOTICE).
