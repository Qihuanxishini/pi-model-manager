// 用户侧 API 根地址与 Pi 原生 Anthropic SDK 地址之间的转换。

import { t } from "./i18n.ts";
import type { ApiKind } from "./types.ts";

function formatUrl(url: URL): string {
	return url.toString().replace(/^(https?:\/\/[^/?#]+)\/(?=$|[?#])/i, "$1");
}

function trimPath(url: URL): void {
	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
}

export function appendUrlPath(baseUrl: string, ...segments: string[]): string {
	const url = new URL(baseUrl.trim());
	const prefix = url.pathname.replace(/\/+$/, "");
	const suffix = segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
	url.pathname = `${prefix}/${suffix}`;
	return formatUrl(url);
}

/** 校验发生在编辑/注册/发现边界，不允许 SDK 把端点拼进查询参数或 fragment。 */
export function validateRequestBaseUrl(baseUrl: string): void {
	const url = new URL(baseUrl.trim());
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(t("Base URL 必须使用 http 或 https"));
	if (baseUrl.includes("?") || baseUrl.includes("#")) {
		throw new Error(t("Base URL 不支持查询参数（?）或片段（#）；请填写 API 根地址"));
	}
	if (url.username || url.password) throw new Error(t("Base URL 不支持内嵌认证；请使用 API key 或请求头配置"));
}

export function resolveRuntimeBaseUrl(api: ApiKind, baseUrl: string): string {
	const url = new URL(baseUrl.trim());
	trimPath(url);
	if (url.pathname === "/") {
		if (api === "openai-completions" || api === "openai-responses" || api === "anthropic-messages") url.pathname = "/v1";
		else if (api === "google-generative-ai" && url.hostname === "generativelanguage.googleapis.com") url.pathname = "/v1beta";
	}
	return formatUrl(url);
}

/** 标准 Anthropic 根地址存成 SDK 原生形式，自定义版本路径由私有元数据标识。 */
export function toNativeBaseUrl(api: string, baseUrl: string): { baseUrl: string; anthropicApiRoot?: true } {
	if (api !== "anthropic-messages") return { baseUrl };
	const url = new URL(resolveRuntimeBaseUrl(api, baseUrl));
	if (url.pathname.endsWith("/v1")) {
		url.pathname = url.pathname.slice(0, -3) || "/";
		return { baseUrl: formatUrl(url) };
	}
	return { baseUrl: formatUrl(url), anthropicApiRoot: true };
}

export function fromNativeBaseUrl(
	api: string,
	baseUrl: string,
	anthropicApiRoot = false,
	legacyNormalization = false,
): string {
	if (api !== "anthropic-messages" || anthropicApiRoot) return baseUrl;
	try {
		const url = new URL(baseUrl.trim());
		trimPath(url);
		// [喵喵喵]: 旧版插件在注册前剥去末尾 /v1；读取旧配置必须先复现该行为再显式补回版本路径。
		if (legacyNormalization && url.pathname.toLowerCase().endsWith("/v1")) url.pathname = url.pathname.slice(0, -3) || "/";
		return appendUrlPath(formatUrl(url), "v1");
	} catch {
		// [喵喵喵]: 受控简化 — 解析失败的 Base URL 原样返回交由上层校验拦截；边界：非交互调用方（如状态读回）拿不到提示；升级：出现排查诉求时为读回路径接入统一的告警通道
		return baseUrl;
	}
}
