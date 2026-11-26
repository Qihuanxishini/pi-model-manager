import assert from "node:assert/strict";
import test from "node:test";
import { findPresetForApi, switchProviderDraftApiPreset } from "../presets/providers.ts";
import { appendUrlPath, resolveProviderDraftBaseUrl, resolveRuntimeBaseUrl, toNativeBaseUrl, validateRequestBaseUrl } from "../runtime-base-url.ts";
import type { ProviderDraft } from "../types.ts";

function createDraft(): ProviderDraft {
	const preset = findPresetForApi("openai-responses");
	return {
		providerId: "custom",
		providerName: "custom",
		api: preset.api,
		baseUrl: preset.baseUrl,
		apiKey: preset.apiKey,
		authHeader: preset.authHeader,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "http://127.0.0.1:7890",

		selectedIndex: 0,
	};
}

test("协议切换仅替换旧协议默认预设", () => {
	const draft = createDraft();
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.api, "anthropic-messages");
	assert.equal(draft.baseUrl, "https://api.anthropic.com/v1");
	assert.equal(draft.apiKey, "$ANTHROPIC_API_KEY");
});

test("协议切换保留认证与自定义 URL 前缀，并转换 Gemini 版本后缀", () => {
	for (const apiKey of ["sk-plaintext", "$MY_PRIVATE_KEY", "!secret-tool read provider"]) {
		const draft = createDraft();
		draft.baseUrl = "https://gateway.example.com/tenant-a/openai/v1?region=cn";
		draft.apiKey = apiKey;
		switchProviderDraftApiPreset(draft, "google-generative-ai");
		assert.equal(draft.baseUrl, "https://gateway.example.com/tenant-a/openai/v1beta?region=cn");
		assert.equal(draft.apiKey, apiKey);
	}
});

test("旧预设 URL 的尾斜杠不阻止安全替换", () => {
	const draft = createDraft();
	draft.baseUrl = "https://api.openai.com/v1/";
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.baseUrl, "https://api.anthropic.com/v1");
});

test("Gemini 草稿转换仅匹配末尾版本段，反向转换限于从 Gemini 切出", () => {
	const cases: [string, string][] = [
		["https://gateway.example.com", "https://gateway.example.com/v1beta"],
		["https://generativelanguage.googleapis.com/v1/", "https://generativelanguage.googleapis.com/v1beta"],
		[" https://v1.example.com:8443/v1/tenant/v1/ ", "https://v1.example.com:8443/v1/tenant/v1beta"],
		["https://gateway.example.com/tenant/v1beta/", "https://gateway.example.com/tenant/v1beta"],
		...["custom", "v1alpha", "v2", "xv1", "v1/models"].map((path): [string, string] => [
			`https://gateway.example.com/${path}`, `https://gateway.example.com/${path}`,
		]),
	];
	for (const [input, expected] of cases) {
		assert.equal(resolveProviderDraftBaseUrl("google-generative-ai", input), expected);
	}
	for (const api of ["openai-completions", "openai-responses", "anthropic-messages"] as const) {
		const url = "https://gateway.example.com/tenant/v1beta";
		assert.equal(resolveProviderDraftBaseUrl(api, url), url, "手动输入其他协议地址不反向改写");
		const draft = createDraft();
		draft.api = "google-generative-ai";
		draft.baseUrl = `${url}/`;
		switchProviderDraftApiPreset(draft, api);
		assert.equal(draft.baseUrl, "https://gateway.example.com/tenant/v1");
	}
	assert.equal(resolveRuntimeBaseUrl("google-generative-ai", "https://gateway.example.com/v1"), "https://gateway.example.com/v1");
	assert.equal(resolveRuntimeBaseUrl("google-generative-ai", "https://gateway.example.com"), "https://gateway.example.com");
});

test("地址工具保留 query，发送边界显式拒绝 Base URL 查询参数", () => {
	const runtimeUrl = resolveRuntimeBaseUrl("openai-responses", "https://gateway.example.com?tenant=a");
	const modelListUrl = new URL(appendUrlPath(runtimeUrl, "models"));
	assert.equal(modelListUrl.pathname, "/v1/models");
	assert.equal(modelListUrl.search, "?tenant=a");

	const anthropicUrl = new URL(resolveRuntimeBaseUrl("anthropic-messages", "https://gateway.example.com/v1?tenant=a"));
	assert.equal(anthropicUrl.pathname, "/v1");
	assert.equal(anthropicUrl.search, "?tenant=a");

	const googleUrl = new URL(resolveRuntimeBaseUrl("google-generative-ai", "https://generativelanguage.googleapis.com?tenant=a"));
	assert.equal(googleUrl.pathname, "/v1beta");
	assert.equal(googleUrl.search, "?tenant=a");
	for (const url of [runtimeUrl, anthropicUrl.href, googleUrl.href, "https://gateway.example.com/v1#fragment", "https://gateway.example.com/v1?"]) {
		assert.throws(() => validateRequestBaseUrl(url), /Base URL/);
	}
});

test("API 根地址补默认版本且与 Anthropic 原生存储形式可区分", () => {
	// openai SDK 默认 baseURL 含 /v1，内部只拼 /responses，所以根地址必须补 /v1
	assert.equal(resolveRuntimeBaseUrl("openai-responses", "https://api.deepseek.com"), "https://api.deepseek.com/v1");
	assert.equal(resolveRuntimeBaseUrl("openai-responses", "https://api.deepseek.com/"), "https://api.deepseek.com/v1");
	// 用户侧保留 API 根地址，原生存储边界转换成 Anthropic SDK 所需形式。
	assert.equal(resolveRuntimeBaseUrl("anthropic-messages", "https://api.anthropic.com/v1"), "https://api.anthropic.com/v1");
	assert.equal(resolveRuntimeBaseUrl("anthropic-messages", "https://api.anthropic.com"), "https://api.anthropic.com/v1");
	assert.deepEqual(toNativeBaseUrl("anthropic-messages", "https://api.anthropic.com/v1"), { baseUrl: "https://api.anthropic.com" });
	// 自定义路径是用户显式指定的端点，任何协议下都不改写
	assert.equal(resolveRuntimeBaseUrl("openai-responses", "https://gw.example.com/custom"), "https://gw.example.com/custom");
	assert.equal(resolveRuntimeBaseUrl("anthropic-messages", "https://gw.example.com/custom"), "https://gw.example.com/custom");

	// 幂等：归一化结果再归一化必须不变，否则存量数据会被反复判定为需要迁移
	for (const [api, url] of [
		["openai-responses", "https://api.deepseek.com"],
		["anthropic-messages", "https://api.anthropic.com/v1"],
		["google-generative-ai", "https://generativelanguage.googleapis.com"],
	] as const) {
		const once = resolveRuntimeBaseUrl(api, url);
		assert.equal(resolveRuntimeBaseUrl(api, once), once, `${api} 的归一化必须幂等`);
	}
});

test("切换协议时自定义地址按新协议规则重新归一化", () => {
	const toAnthropic = createDraft();
	toAnthropic.baseUrl = "https://gw.example.com/v1";
	switchProviderDraftApiPreset(toAnthropic, "anthropic-messages");
	assert.equal(toAnthropic.baseUrl, "https://gw.example.com/v1", "Anthropic 与 OpenAI 共享 API 根地址语义");

	switchProviderDraftApiPreset(toAnthropic, "openai-responses");
	assert.equal(toAnthropic.baseUrl, "https://gw.example.com/v1", "切换协议保留自定义版本路径");

	// 自定义路径在两个方向上都必须原样保留
	const custom = createDraft();
	custom.baseUrl = "https://gw.example.com/custom/path";
	switchProviderDraftApiPreset(custom, "anthropic-messages");
	assert.equal(custom.baseUrl, "https://gw.example.com/custom/path");
});

test("切入 Chat 时补标准协议兼容，并在切换协议后保留选择", () => {
	const draft = createDraft();
	switchProviderDraftApiPreset(draft, "openai-completions");
	assert.equal(draft.openAIChatCompatibilityMode, "standard");

	draft.openAIChatCompatibilityMode = "compatible";
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.openAIChatCompatibilityMode, "compatible");
	switchProviderDraftApiPreset(draft, "openai-completions");
	assert.equal(draft.openAIChatCompatibilityMode, "compatible");
});


test("Responses 流结束模式在协议切换后保留选择", () => {
	const draft = createDraft();
	assert.equal(draft.openAIResponsesStreamCompletionMode, undefined);
	draft.openAIResponsesStreamCompletionMode = "terminal-event";
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.openAIResponsesStreamCompletionMode, "terminal-event");
	switchProviderDraftApiPreset(draft, "openai-responses");
	assert.equal(draft.openAIResponsesStreamCompletionMode, "terminal-event");
});
