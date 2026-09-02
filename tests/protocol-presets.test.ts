import assert from "node:assert/strict";
import test from "node:test";
import { findPresetForApi, switchProviderDraftApiPreset } from "../presets/providers.ts";
import { appendUrlPath, resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
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
	assert.equal(draft.baseUrl, "https://api.anthropic.com");
	assert.equal(draft.apiKey, "$ANTHROPIC_API_KEY");
});

test("协议切换保留明文 key、自定义引用、命令和自定义 URL", () => {
	for (const apiKey of ["sk-plaintext", "$MY_PRIVATE_KEY", "!secret-tool read provider"]) {
		const draft = createDraft();
		draft.baseUrl = "https://gateway.example.com/tenant-a/openai/v1?region=cn";
		draft.apiKey = apiKey;
		switchProviderDraftApiPreset(draft, "google-generative-ai");
		assert.equal(draft.baseUrl, "https://gateway.example.com/tenant-a/openai/v1?region=cn");
		assert.equal(draft.apiKey, apiKey);
	}
});

test("旧预设 URL 的尾斜杠不阻止安全替换", () => {
	const draft = createDraft();
	draft.baseUrl = "https://api.openai.com/v1/";
	switchProviderDraftApiPreset(draft, "anthropic-messages");
	assert.equal(draft.baseUrl, "https://api.anthropic.com");
});

test("运行时 URL 路径变换保留 query 并在 query 前追加路径", () => {
	const runtimeUrl = resolveRuntimeBaseUrl("openai-responses", "https://gateway.example.com?tenant=a");
	const modelListUrl = new URL(appendUrlPath(runtimeUrl, "models"));
	assert.equal(modelListUrl.pathname, "/v1/models");
	assert.equal(modelListUrl.search, "?tenant=a");

	const anthropicUrl = new URL(resolveRuntimeBaseUrl("anthropic-messages", "https://gateway.example.com/v1?tenant=a"));
	assert.equal(anthropicUrl.pathname, "/");
	assert.equal(anthropicUrl.search, "?tenant=a");

	const googleUrl = new URL(resolveRuntimeBaseUrl("google-generative-ai", "https://generativelanguage.googleapis.com?tenant=a"));
	assert.equal(googleUrl.pathname, "/v1beta");
	assert.equal(googleUrl.search, "?tenant=a");
});

test("归一化结果可直接交给 SDK，且对根路径不留多余尾斜杠", () => {
	// openai SDK 默认 baseURL 含 /v1，内部只拼 /responses，所以根地址必须补 /v1
	assert.equal(resolveRuntimeBaseUrl("openai-responses", "https://api.deepseek.com"), "https://api.deepseek.com/v1");
	assert.equal(resolveRuntimeBaseUrl("openai-responses", "https://api.deepseek.com/"), "https://api.deepseek.com/v1");
	// anthropic SDK 内部拼 /v1/messages，所以 baseUrl 不能带 /v1
	assert.equal(resolveRuntimeBaseUrl("anthropic-messages", "https://api.anthropic.com/v1"), "https://api.anthropic.com");
	assert.equal(resolveRuntimeBaseUrl("anthropic-messages", "https://api.anthropic.com"), "https://api.anthropic.com");
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
	assert.equal(toAnthropic.baseUrl, "https://gw.example.com", "切到 Anthropic 要剥掉 /v1");

	switchProviderDraftApiPreset(toAnthropic, "openai-responses");
	assert.equal(toAnthropic.baseUrl, "https://gw.example.com/v1", "切回 OpenAI 要补回 /v1");

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
