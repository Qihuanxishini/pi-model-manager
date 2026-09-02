# 与上游 Pi 的差异

本文记录 `pi-model-manager` 相对于上游 Pi Coding Agent 的功能边界和行为差异。

> 上游仓库：[`earendil-works/pi`](https://github.com/earendil-works/pi)
>
> 本项目是 Pi 扩展，不是 Pi 核心的 fork。它通过 `/model-manager` 管理 Pi 的原生配置文件，因此不会替换或修改 Pi 核心的模型注册、请求和余额查询实现。

## 功能差异

| 功能 | 上游 Pi | `pi-model-manager` |
| --- | --- | --- |
| Provider / Model 编辑 | 主要通过 `models.json` 或其它配置入口维护 | 提供 `/model-manager` TUI，可新增、编辑、删除 Provider 和 Model |
| 模型元数据 | 使用配置中已有的模型字段 | 保存模型时可从 `models.dev` 或 OpenRouter 同步 context、max tokens、输入模态、推理能力、thinking level 和 cost |
| 元数据来源 | 无本扩展提供的来源选择器 | 默认 `models.dev`，也支持 OpenRouter 和手工保留 |
| 请求头身份 | 使用 Pi 原生 Provider 行为 | 增加 Recommended、Disabled、Claude Code、Codex 和可复用 Custom profile |
| Provider 代理 | 使用 Pi 原生配置 | 可在 `/model-manager` 为每个 Provider 配置 HTTP(S) 代理 |
| 配置保存 | 由配置文件自身负责 | 使用跨进程锁、内容签名和可恢复事务，避免并发保存覆盖配置 |
| 余额状态 | 由独立扩展提供（上游核心不负责本项目的余额 UI） | 不处理余额配置、请求、缓存或 status；由 `pi-provider-status` 负责 |
| 界面语言 | 使用 Pi 默认界面语言 | 扩展界面默认简体中文，可按 `L` 切换 English |

## 配置文件边界

本项目不会把用户运行时配置提交到仓库，也不会使用仓库目录作为配置目录：

- Pi 原生模型配置：`~/.pi/agent/models.json`
- 扩展私有状态：`~/.pi/agent/extensions/pi-model-manager/state.json`
- 余额配置：`~/.pi/agent/balance-config.yaml`（由 `pi-provider-status` 唯一拥有）
- 配置事务文件：`~/.pi/agent/extensions/pi-model-manager/config-transaction.json`

`balance-config.yaml` 不由本扩展读取或写入；余额请求、缓存、status 和配置 TUI 由独立的 `pi-provider-status` 扩展负责。两者只通过稳定 Provider ID 关联。

## 模型元数据同步规则

保存模型时：

1. 选择 `models.dev`、OpenRouter 或手工模式。
2. `models.dev` 使用 Provider 和 Model ID 匹配远程数据。
3. OpenRouter 使用完整模型 ID（例如 `openai/gpt-5.4`）匹配远程数据。
4. 成功匹配后更新模型能力、上下文、输出上限、推理映射和价格。
5. OpenRouter 的 token 单价会转换为每百万 token 价格，以适配 Pi 的 `models.json` 格式。
6. 远程字段缺失时保留现有 context / maxTokens；手工模式不发起网络请求。

## 不同于上游的兼容约束

- `models.json` 仍是模型配置的唯一权威来源；扩展不会另建一套模型运行时数据库。
- 未被扩展明确接管的原生 Provider 不会被自动注册、改写或删除。
- Provider 改名和删除时，本扩展只修改 `models.json`；余额配置由 `pi-provider-status` 的对账流程处理。
- 余额请求、缓存、footer 和 status 不属于本扩展。
- 扩展要求 Pi `>=0.84.2`，并依赖 `@earendil-works/pi-tui >=0.75.0`。

## 上游同步原则

同步上游 Pi 时：

1. 先确认上游 API、配置 schema 和模型注册 API 没有不兼容变化。

2. 保留本项目的 TUI、模型元数据同步和配置事务代码；余额功能在 `pi-provider-status` 中维护。

3. 不要把真实的 `models.json`、`state.json`、`balance-config.yaml`、API key 或请求抓包数据加入 Git。
4. 运行完整测试：

   ```bash
   npm test
   ```

5. 如果上游改变配置路径或模型字段，先更新本文和 README，再更新实现与测试。
