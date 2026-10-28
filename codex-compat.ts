// Codex 客户端画像与请求级协议头；不持有跨模型共享的可变会话状态。

import { isObjectRecord } from "./common.ts";
import { codexIdentityFromUserAgent } from "./presets/codex-client-headers.ts";
import type { ApiKind } from "./types.ts";

function setDefaultProtocolHeader(headers: Headers, name: string, value: string | undefined): void {
	if (!value || headers.has(name)) return;
	try {
		headers.set(name, value);
	} catch {
		// [喵喵喵]: 与官方可选协议头一致，无法表示为 HTTP header 时跳过投影，不阻断业务正文。
	}
}

/** 在 SDK 完成构造后收口 Codex 指纹；仅修改本次请求，不更改缓存与会话亲和契约。 */
export async function applyCodexRequestHeaders(
	request: Request,
	api: ApiKind,
	sessionId: string | undefined,
	explicitHeaderNames: ReadonlySet<string>,
): Promise<void> {
	for (const name of [...request.headers.keys()]) {
		if (name.startsWith("x-stainless-") && !explicitHeaderNames.has(name)) request.headers.delete(name);
	}
	for (const [name, value] of Object.entries(codexIdentityFromUserAgent(request.headers.get("user-agent")))) {
		if (!explicitHeaderNames.has(name)) request.headers.set(name, value);
	}
	if (api !== "openai-responses") return;

	// [喵喵喵]: 身份来自本次请求选项，不依赖 prompt_cache_key；关闭缓存也不改变线程身份。
	// session_id / x-session-id 属于 Pi 的接入亲和配置，不是这些 Codex 头的别名，必须保留。
	setDefaultProtocolHeader(request.headers, "session-id", sessionId);
	setDefaultProtocolHeader(request.headers, "thread-id", sessionId);
	setDefaultProtocolHeader(request.headers, "x-client-request-id", request.headers.get("thread-id") ?? request.headers.get("session-id") ?? sessionId);
	if (request.headers.has("x-codex-routing-hint")) return;

	// [喵喵喵]: 读取已序列化的请求副本，确保 model/tier 来自所有 payload transform 完成后的实际正文。
	const payload: unknown = await request.clone().json().catch(() => undefined);
	if (!isObjectRecord(payload) || typeof payload.model !== "string" || !payload.model) return;
	const tier = typeof payload.service_tier === "string" && payload.service_tier ? `;tier=${payload.service_tier}` : "";
	setDefaultProtocolHeader(request.headers, "x-codex-routing-hint", `model=${payload.model}${tier}`);
}
