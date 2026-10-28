// 客户端请求头：5 个模式（recommended / disabled / claude-code / codex-cli / custom）。
// ClaudeCode profile 的 body metadata 信号由 ../claude-code-compat.ts 在请求发送前补齐。
//
// [喵喵喵]: 内置值由私有抓包工具生成，公开插件不携带捕获能力 (2026-07-26)

import { cloneStringRecord, hasStringRecordEntries } from "../common.ts";
import { buildCodexClientHeaders } from "./codex-client-headers.ts";
import { t } from "../i18n.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, ClientHeaderProfileId, CompatSettings, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { CLAUDE_CODE_CLIENT_HEADERS, CODEX_CLI_CLIENT_HEADERS } from "./builtin-client-headers.ts";

const ANTHROPIC_INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";


export function getClientHeaderProfileLabel(profile: ClientHeaderProfileId): string {
	if (profile === "recommended") return t("自动推荐");
	if (profile === "disabled") return t("不添加");
	if (profile === "custom") return t("自定义请求头");
	return profile === "claude-code" ? "ClaudeCode" : "Codex";
}

function removeAnthropicBetaFeature(headers: Record<string, string>, feature: string): void {
	const betaHeaderKey = Object.keys(headers).find((name) => name.toLowerCase() === "anthropic-beta");
	if (!betaHeaderKey) return;
	const retained = headers[betaHeaderKey]!
		.split(",")
		.map((value) => value.trim())
		.filter((value) => value && value !== feature);
	if (retained.length > 0) headers[betaHeaderKey] = retained.join(",");
	else delete headers[betaHeaderKey];
}

function cloneHeadersForCompat(
	headers: Record<string, string>,
	api: ApiKind,
	compat?: CompatSettings,
): Record<string, string> {
	const cloned = cloneStringRecord(headers);
	if (api === "anthropic-messages" && compat?.forceAdaptiveThinking === true) {
		removeAnthropicBetaFeature(cloned, ANTHROPIC_INTERLEAVED_THINKING_BETA);
	}
	return cloned;
}


/** 按大小写不敏感的字段名合并请求头，后者覆盖前者。 */
export function mergeModelRequestHeaders(
	nativeHeaders: Record<string, string> | undefined,
	profileHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const merged: Record<string, string> = {};
	for (const headers of [nativeHeaders, profileHeaders]) {
		for (const [name, value] of Object.entries(headers ?? {})) merged[name.toLowerCase()] = value;
	}
	return hasStringRecordEntries(merged) ? merged : undefined;
}

/** 读取 models.json 时剥离当前 profile 管理的字段，避免把生成值误当作用户原生 headers。 */
export function stripManagedClientHeaders(
	storedHeaders: Record<string, string> | undefined,
	profileHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const nativeHeaders = cloneStringRecord(storedHeaders);
	for (const [name, value] of Object.entries(profileHeaders ?? {})) {
		for (const [storedName, storedValue] of Object.entries(nativeHeaders)) {
			if (storedName.toLowerCase() === name.toLowerCase() && storedValue === value) delete nativeHeaders[storedName];
		}
	}
	return hasStringRecordEntries(nativeHeaders) ? nativeHeaders : undefined;
}

export function resolveProviderCustomHeaders(
	selection: { requestHeaderProfileId?: string; customClientHeaders?: Record<string, string> },
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Record<string, string> {
	const profileId = selection.requestHeaderProfileId;
	return (profileId && requestHeaderProfiles[profileId]?.headers) || selection.customClientHeaders || {};
}

function getRecommendedClientHeaderProfile(api: ApiKind): ClientHeaderProfileId {
	if (api === "anthropic-messages") return "claude-code";
	if (api === "openai-completions" || api === "openai-responses") return "codex-cli";
	return "disabled";
}

export function resolveClientHeaderProfile(profile: ClientHeaderProfileId, api: ApiKind): ClientHeaderProfileId {
	return profile === "recommended" ? getRecommendedClientHeaderProfile(api) : profile;
}

export function getClientHeadersForProfile(
	profile: ClientHeaderProfileId,
	api: ApiKind,
	customHeaders: Record<string, string>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
	compat?: CompatSettings,
): Record<string, string> | undefined {
	const resolved = resolveClientHeaderProfile(profile, api);
	if (resolved === "disabled") return undefined;
	if (resolved === "claude-code") {
		const headers = hasStringRecordEntries(clientHeaderCaptures[resolved]?.headers)
			? clientHeaderCaptures[resolved]!.headers
			: CLAUDE_CODE_CLIENT_HEADERS;
		return cloneHeadersForCompat(headers, api, compat);
	}
	if (resolved === "codex-cli") {
		const headers = hasStringRecordEntries(clientHeaderCaptures[resolved]?.headers)
			? clientHeaderCaptures[resolved]!.headers
			: CODEX_CLI_CLIENT_HEADERS;
		return buildCodexClientHeaders(headers);
	}
	return hasStringRecordEntries(customHeaders) ? cloneStringRecord(customHeaders) : undefined;
}
export function getClientHeaderProfileDisplay(profile: ClientHeaderProfileId, api: ApiKind): string {
	const resolved = resolveClientHeaderProfile(profile, api);
	if (profile === "recommended") {
		return `${getClientHeaderProfileLabel("recommended")} → ${getClientHeaderProfileLabel(resolved)}`;
	}
	return getClientHeaderProfileLabel(profile);
}
