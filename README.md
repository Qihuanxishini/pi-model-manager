# pi-model-manager

[English](./README.en.md) · 简体中文

[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.85.1-6f42c1)](https://github.com/earendil-works/pi)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.7-2f81f7.svg)](https://github.com/Qihuanxishini/pi-model-manager)

一个面向 [Pi](https://github.com/earendil-works/pi) 的 TUI 模型与接入管理扩展。它以 Pi 原生 `models.json` 为模型配置的唯一权威来源，并提供接入/模型编辑、请求头身份、代理路由和协议兼容配置。

> 本扩展要求 Pi `>=0.85.1`。

## 界面预览

下面的界面文本由真实组件渲染得出（终端宽 88 列）。实际使用时列宽会按当前数据收敛，选中行有背景色，各列状态按语义着色。

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
<summary>展开其余四个界面</summary>

### 接入内的模型列表

```text
────────────────────────────────────────────────────────────────────────────────────────
/model-manager / OpenAI
Responses · 2 模型 · headers Auto→Codex · proxy direct · auth env
endpoint  https://api.openai.com/v1

  模型 ID         显示名    输入        Thinking   上下文
❯ gpt-5.6-sol     默认      文本,视觉   开           1.1M
  gpt-5.6-terra   默认      文本,视觉   开           1.1M

↑↓ 选择   Enter 编辑模型   A 添加模型   E 编辑接入   D 删除模型   Esc 返回   / 搜索
────────────────────────────────────────────────────────────────────────────────────────
```

### 接入配置

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

### 模型能力

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

### 模型发现

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

## 功能

- 在 `/model-manager` TUI 中新增、编辑和删除接入与模型。
- 界面默认使用简体中文；可在主面板按 `L` 切换为 English，语言选择会持久保存。
- 原生支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`。
- 为 OpenAI Chat 接入提供标准 Pi 默认行为与 `system` role 兼容模式。
- 从兼容上游拉取模型 ID，也可手动填写模型。
- 配置上下文窗口、最大输出、视觉支持和 Thinking。
- 支持 Anthropic Adaptive Thinking 与 Legacy Thinking。
- 可为 OpenAI Responses 模型启用 `service_tier=priority`（Fast mode）。
- 为每个接入单独配置直连或 HTTP(S) 代理。
- 提供自动推荐、禁用、Claude Code、Codex 和自定义请求头模式。
- API key 支持字面值、`$ENV_VAR` / `${ENV_VAR}` 和 Pi 的 `!command` 引用。
- 使用跨进程锁与可恢复双文件事务持久化配置，并在保存后重新注册受管理的 Provider。

## 安装

### 从 GitHub 安装（当前推荐）

```bash
pi install git:github.com/Qihuanxishini/pi-model-manager
```

也可以先临时试用，不写入 Pi 的包配置：

```bash
pi -e git:github.com/Qihuanxishini/pi-model-manager
```

更新 Git 安装的扩展：

```bash
pi update --extensions
```

### 从 npm 安装

`pi-model-manager` 已发布为公开 npm 包：

```bash
pi install npm:pi-model-manager
```

## 快速开始

1. 启动 Pi TUI。
2. 执行：

   ```text
   /model-manager
   ```

3. 在主面板中管理接入：

   | 按键 | 操作 |
   | --- | --- |
   | `Enter` | 进入所选接入并管理模型 |
   | `N` | 新建接入及其第一个模型 |
   | `D` | 删除所选接入 |
   | `H` | 管理可复用请求头 |
   | `L` | 切换界面语言（简体中文 / English），选择后立即生效并持久保存 |
   | `/` | 搜索当前列表；`Tab` 退出输入但保留过滤，`Esc` 清空 |
   | `Esc` | 返回或退出 |

   单字母快捷键不区分大小写；底部提示按终端宽度折行，窄终端下也不会丢失。

4. 在编辑器中使用 `↑` / `↓` 选择字段，按 `Enter` 编辑；开关类字段可用 `←` / `→` 就地切换；按 `Ctrl+S` 保存。

保存会更新并启用模型，但不会强制切换当前会话正在使用的模型。

## 配置模型

### 接入配置

每个接入可以配置：

- API 协议与 Base URL
- API key 与认证头行为
- 请求头身份
- 接入级 HTTP(S) 代理
- 一个或多个模型

新建模型时，扩展会尝试从上游读取模型列表；整次发现共用一个 10 秒上限，可按 `Esc` 手动取消。列表与聊天使用同一 API 根地址和配置的认证信息，错误会区分认证失败、接口不存在、限流和上游异常。失败或取消后仍可手动输入模型 ID。

Base URL 表示 API 根地址：OpenAI 两种协议和 Anthropic 只填域名时补 `/v1`，显式填写路径时保留该路径，再追加协议端点。例如 Anthropic 的 `https://gw.example.com/xxx` 请求 `/xxx/messages`，模型列表请求 `/xxx/models`。Google 在官方根地址上补 `/v1beta`，自定义路径保持原样。Base URL 不支持查询参数（`?`）、片段（`#`）或内嵌认证；SDK 正常生成的请求参数不受影响。

Anthropic 标准端点在写入 `models.json` 时转换为 Pi 原生 SDK 所需形式，因此未加载扩展时也能使用；自定义版本路径通过 `state.json` 私有标记衔接，依赖扩展的发送适配。代理开关只改变传输路线，最终端点、业务请求头和 payload 保持一致；代理失败会报错。

### Chat 协议兼容

当 API 协议为 `openai-completions`（OpenAI Chat）时，接入编辑器会显示「协议兼容」。用 `←` / `→` 切换，或按 `Enter` 查看完整说明；该设置作用于接入内的所有模型。

| 模式 | 保存行为 | 使用场景 |
| --- | --- | --- |
| 标准 · Pi 默认 | 移除 `compat.supportsDeveloperRole` 覆写，保留 Pi 对端点的默认兼容判断 | 常规 Chat 接入 |
| 兼容 · system | 写入 `compat.supportsDeveloperRole: false`；reasoning 模型的系统提示词使用 `system` role | 中转不能正确处理 `developer` role，导致系统提示词或人设失效 |

优先使用「标准 · Pi 默认」。只有确认接入需要 `system` role 时才选择「兼容 · system」；切换回标准会恢复 Pi 的默认判断。

### 模型能力

模型编辑器支持：

- 显示名称
- 视觉支持（仅文本或文本 + 图片输入）
- Thinking 开关
- Anthropic Adaptive/Legacy Thinking 协议
- OpenAI Responses Fast mode
- Context window 与最大输出 token

## 请求头模式

| 模式 | 行为 |
| --- | --- |
| 自动推荐 | Anthropic Messages 使用 Claude Code；OpenAI Completions/Responses 使用 Codex；其他协议不附加身份头 |
| 不添加 | 不添加扩展管理的客户端身份请求头 |
| Claude Code | 使用内置 Claude Code 兼容请求头，并为 Anthropic 请求补充必要的兼容 metadata |
| Codex | 使用内置 Codex TUI 兼容请求头 |
| 自定义 | 使用在请求头面板中创建的可复用 JSON 请求头集合 |

当前内置值来自真实客户端请求并已移除认证信息：

- Claude Code `2.1.278`
- Codex TUI `0.155.1`

这些值只用于兼容需要识别客户端身份的 API 中转，不代替 API key。公开仓库和 npm 包**不包含请求捕获工具、用户抓包、认证头或本机状态**。如果内置值不适合你的服务，请关闭身份头或创建自定义请求头。

自定义请求头会拒绝认证类敏感字段；认证信息应放在接入的 API key 配置中。

显式原生请求头覆盖内置模板；选择自定义请求头时，自定义值拥有最终优先级。同名字段按大小写不敏感方式合并。自定义 `anthropic-beta` 清单完整保留，Adaptive Thinking 不会修改它。

## 配置文件

| 路径 | 用途 |
| --- | --- |
| `~/.pi/agent/models.json` | Pi 原生接入与模型定义；模型配置的唯一权威来源 |
| `~/.pi/agent/extensions/pi-model-manager/state.json` | 请求头选择、自定义请求头、代理开关、Fast mode 和 Anthropic 自定义端点标记等私有元数据 |

扩展只会为明确受管理的 Provider 生成请求头、代理路由和动态注册配置。所有权由 `state.json` 的受管理 ID 与 `models.json` Provider 节点中的 `piModelManager.managed` 标记共同确认，防止已删除的 Provider ID 在日后被同名原生配置复用时遭到插件接管。没有这些所有权信息的原生 Provider 保持未管理，其已有 Header 和未知原生字段不会因保存其它配置而被改写；Pi 内置 Provider 不在本扩展中提供编辑或删除入口。

插件自身的配置写入由跨进程锁串行化，`enabledModels` 还同时遵守 Pi 的 `proper-lockfile` 锁；`models.json` 与 `state.json` 通过事务意图文件在中断后恢复，读取方不会采用事务进行中的半完成组合。外部编辑器不受这些锁约束，因此保存前仍会校验内容签名；检测到外部修改时会取消保存而不是覆盖。

旧端点配置会升级到 v5 元数据，保持原最终聊天地址，迁移前的双文件快照保存在插件配置目录的 `base-url-v5-*.json`。快照包含原始配置，应按凭据文件保护；回退时需配套恢复代码、`models.json` 和 `state.json`。

## 密钥与安全

Pi 扩展以当前用户权限运行并拥有完整系统访问能力。安装任何第三方扩展前都应审阅源码。

推荐通过环境变量或命令引用 API key，避免把密钥明文写入 `models.json`：

```text
$OPENAI_API_KEY
${ANTHROPIC_API_KEY}
!your-secret-command
```

其他注意事项：

- 自定义请求头不是保存认证凭据的位置。
- 启用接入代理后，该接入的请求会经过你填写的代理地址。
- 拉取模型列表会向所配置的上游地址发起网络请求。
- 仓库忽略 `state.json`、运行日志、请求捕获数据和其他机器专属文件。

## 兼容性

| 组件 | 要求 |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `>=0.85.1` |
| `@earendil-works/pi-ai` | `>=0.85.1` |
| `@earendil-works/pi-tui` | `>=0.75.0` |
| 运行模式 | `/model-manager` 需要 Pi TUI |

默认 TUI 文案为简体中文；可在主面板按 `L` 切换为 English。

## 本地开发

```bash
git clone https://github.com/Qihuanxishini/pi-model-manager.git
cd pi-model-manager
npm install
pi -e .
```

扩展由 Pi 直接加载 TypeScript 入口，不需要单独构建步骤。开发时请勿提交 `state.json`、`bootstrap-meta.json`、`node_modules` 或任何请求捕获数据。

测试分为替身测试和真实宿主测试，当前真实宿主验证基线为 Pi `0.99.0`：

```bash
npm test
PI_TEST_RUNTIME_ROOT="/path/to/node_modules/@earendil-works/pi-coding-agent" npm run test:runtime
```

`npm test` 使用测试替身，并跳过真实宿主用例；`test:runtime` 只运行 `tests/*-wire.test.ts`，包括完整内置接入目录保护与协议转发检查。`PI_TEST_RUNTIME_ROOT` 指向已安装的 Pi 包目录，Windows Git Bash 下使用 `C:/...` 形式。这些测试使用本地响应与虚拟凭据，不调用外部模型服务。

宿主提供的包在 `peerDependencies` 中声明为 `"*"`，实际支持版本见上方兼容性表；运行时仍复用 Pi 提供的模块。

验证公开包内容：

```bash
npm pack --dry-run
```

## 问题反馈

请通过 [GitHub Issues](https://github.com/Qihuanxishini/pi-model-manager/issues) 提交可复现的问题。报告配置问题时，请删除 API key、认证头、代理凭据和私有 endpoint。

## 友情链接

* [Linux DO](https://linux.do)

## 许可证

本项目采用 [GNU Affero General Public License v3.0 only](./LICENSE)。分发修改版本时必须公开对应源码、继续使用 AGPL-3.0，并明确标注改动；修改版不得冒充官方发行。详见 [NOTICE](./NOTICE)。
