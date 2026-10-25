// 由私有 request-capture-service 根据真实客户端请求生成；公开插件仅消费这些脱敏后的内置值。

export const CLAUDE_CODE_CLIENT_HEADERS: Record<string, string> = {
	"anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,mid-conversation-tool-changes-2026-07-01,advanced-tool-use-2025-11-20,effort-2025-11-24",
	"anthropic-dangerous-direct-browser-access": "true",
	"anthropic-version": "2023-06-01",
	"user-agent": "claude-cli/2.1.310 (external, sdk-cli)",
	"x-app": "cli",
	"x-stainless-arch": "x64",
	"x-stainless-lang": "js",
	"x-stainless-os": "Windows",
	"x-stainless-package-version": "0.128.0",
	"x-stainless-retry-count": "0",
	"x-stainless-runtime": "node",
	"x-stainless-runtime-version": "v26.3.0",
	"x-stainless-timeout": "600",
};

export const CODEX_CLI_CLIENT_HEADERS: Record<string, string> = {
	"originator": "codex-tui",
	"user-agent": "codex-tui/0.164.0 (Windows 10.0.26300; x86_64) unknown (codex-tui; 0.164.0)",
	"x-codex-beta-features": "remote_compaction_v2",
};
