// 4 种 API 协议的默认预设。新建接入/模型时用，便于一键填好常用字段。

import type { ApiKind, ModelInputKind, ProviderDraft } from "../types.ts";
import { resolveRuntimeBaseUrl } from "../runtime-base-url.ts";

export interface ProviderPreset {
	api: ApiKind;
	label: string;
	shortLabel: string;
	defaultProviderName: string;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	contextWindow: number;
	maxTokens: number;
	inputKinds: ModelInputKind[];
	defaultReasoning: boolean;
}

const PROVIDER_PRESETS: ProviderPreset[] = [
	{
		api: "openai-responses",
		label: "OpenAI Responses — instructions / input",
		shortLabel: "OpenAI Responses",
		defaultProviderName: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "$OPENAI_API_KEY",
		authHeader: false,
		contextWindow: 200000,
		maxTokens: 64000,
		inputKinds: ["text", "image"],
		defaultReasoning: true,
	},
	{
		api: "openai-completions",
		label: "OpenAI Chat Completions — OpenAI-compatible",
		shortLabel: "OpenAI Chat",
		defaultProviderName: "openai-chat",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "$OPENAI_API_KEY",
		authHeader: false,
		contextWindow: 200000,
		maxTokens: 64000,
		inputKinds: ["text", "image"],
		defaultReasoning: true,
	},
	{
		api: "anthropic-messages",
		label: "Anthropic Messages — Claude thinking",
		shortLabel: "Anthropic Messages",
		defaultProviderName: "anthropic",
		baseUrl: "https://api.anthropic.com",
		apiKey: "$ANTHROPIC_API_KEY",
		authHeader: false,
		contextWindow: 200000,
		maxTokens: 64000,
		inputKinds: ["text", "image"],
		defaultReasoning: true,
	},
	{
		api: "google-generative-ai",
		label: "Google Generative AI — Gemini thinking",
		shortLabel: "Google Generative AI",
		defaultProviderName: "google",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta",
		apiKey: "$GEMINI_API_KEY",
		authHeader: false,
		contextWindow: 1048576,
		maxTokens: 65536,
		inputKinds: ["text", "image"],
		defaultReasoning: true,
	},
];

export function findPresetForApi(api: ApiKind | undefined): ProviderPreset {
	return PROVIDER_PRESETS.find((preset) => preset.api === api) ?? PROVIDER_PRESETS[0]!;
}

function normalizePresetUrl(value: string): string | undefined {
	try {
		const url = new URL(value.trim());
		url.pathname = url.pathname.replace(/\/+$/, "") || "/";
		return url.toString();
	} catch {
		return undefined;
	}
}

function stillUsesPresetUrl(value: string, presetUrl: string): boolean {
	const normalizedValue = normalizePresetUrl(value);
	const normalizedPreset = normalizePresetUrl(presetUrl);
	return normalizedValue !== undefined && normalizedValue === normalizedPreset;
}

export function switchProviderDraftApiPreset(draft: ProviderDraft, nextApi: ApiKind): void {
	if (draft.api === nextApi) return;
	const previousPreset = findPresetForApi(draft.api);
	const nextPreset = findPresetForApi(nextApi);
	const replaceBaseUrl = stillUsesPresetUrl(draft.baseUrl, previousPreset.baseUrl);
	const replaceApiKey = draft.apiKey === previousPreset.apiKey;
	draft.api = nextApi;
	// [喵喵喵]: 协议切换回来时保留用户原先的选择；首次切入 Chat 才补标准模式。
	if (nextApi === "openai-completions" && draft.openAIChatCompatibilityMode === undefined) {
		draft.openAIChatCompatibilityMode = "standard";
	}
	// [喵喵喵]: 版本路径规则随协议而变（OpenAI 要 /v1、Anthropic 不要），
	// 保留的自定义地址必须按新协议重新归一化，否则切完协议就指向错误端点。
	draft.baseUrl = replaceBaseUrl ? nextPreset.baseUrl : resolveRuntimeBaseUrl(nextApi, draft.baseUrl);
	if (replaceApiKey) draft.apiKey = nextPreset.apiKey;
}
