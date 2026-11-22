// Claude Code 身份字段来自真实客户端捕获，协议 beta 由 Pi 按请求生成；Codex 采用 codex-proxy-rs 的通用 Rust CLI 画像。

export const CLAUDE_CODE_CLIENT_HEADERS: Record<string, string> = {
	"anthropic-dangerous-direct-browser-access": "true",
	"anthropic-version": "2023-06-01",
	"user-agent": "claude-cli/2.1.330 (external, sdk-cli)",
	"x-app": "cli",
	"x-stainless-arch": "x64",
	"x-stainless-lang": "js",
	"x-stainless-os": "Windows",
	"x-stainless-package-version": "0.128.0",
	"x-stainless-retry-count": "0",
	"x-stainless-runtime": "node",
	"x-stainless-runtime-version": "v26.12.1",
	"x-stainless-timeout": "600",
};

export const CODEX_CLI_CLIENT_HEADERS: Record<string, string> = {
	"originator": "codex_cli_rs",
	"user-agent": "codex_cli_rs/0.171.0 (Windows 10.0.26100; x86_64) unknown",
	"version": "0.171.0",
};
