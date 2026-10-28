// 在 Pi 已构造请求后选择传输路线；协议判断始终使用真实网关地址。

import { lazyStream, type Provider } from "@earendil-works/pi-ai";
import { getClaudeCodeSessionId } from "./claude-code-compat.ts";
import { applyCodexRequestHeaders } from "./codex-compat.ts";
import { mergeModelRequestHeaders, resolveClientHeaderProfile } from "./presets/client-headers.ts";
import { t } from "./i18n.ts";
import { getProviderHttpProxyUrl, openTemporaryLocalProxyRoute } from "./local-proxy-service.ts";
import { appendUrlPath, resolveRuntimeBaseUrl, validateRequestBaseUrl } from "./runtime-base-url.ts";
import type { ApiKind, StoredProvider } from "./types.ts";

const RESPONSES_TERMINAL_EVENTS = new Set([
	"response.completed",
	"response.incomplete",
	"response.failed",
	"error",
]);

function findSseFrameBoundary(buffer: Uint8Array): number {
	for (let index = 0; index < buffer.length; index += 1) {
		if (buffer[index] === 10 && buffer[index + 1] === 10) return index + 2;
		if (buffer[index] === 13 && buffer[index + 1] === 13) return index + 2;
		if (buffer[index] === 13 && buffer[index + 1] === 10 && buffer[index + 2] === 13 && buffer[index + 3] === 10) return index + 4;
	}
	return -1;
}

function isResponsesTerminalFrame(frame: Uint8Array): boolean {
	const text = new TextDecoder().decode(frame);
	let eventType: string | undefined;
	const dataLines: string[] = [];
	for (const line of text.split(/\r?\n|\r/)) {
		if (line.startsWith("event:")) eventType = line.slice("event:".length).trim();
		if (line.startsWith("data:")) dataLines.push(line.slice("data:".length).trimStart());
	}
	if (eventType && RESPONSES_TERMINAL_EVENTS.has(eventType)) return true;
	const data = dataLines.join("\n").trim();
	if (!data || data === "[DONE]") return false;
	try {
		const parsed = JSON.parse(data) as { type?: unknown };
		return typeof parsed.type === "string" && RESPONSES_TERMINAL_EVENTS.has(parsed.type);
	} catch {
		return false;
	}
}

function appendBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
	const combined = new Uint8Array(left.length + right.length);
	combined.set(left);
	combined.set(right, left.length);
	return combined;
}

function wrapResponsesTerminalStream(response: Response): Response {
	if (!response.body || !response.ok) return response;
	const reader = response.body.getReader();
	let buffer = new Uint8Array();
	let terminal = false;
	const body = new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (!terminal) {
				const boundary = findSseFrameBoundary(buffer);
				if (boundary >= 0) {
					const frame = buffer.slice(0, boundary);
					buffer = buffer.slice(boundary);
					terminal = isResponsesTerminalFrame(frame);
					controller.enqueue(frame);
					if (terminal) {
						controller.close();
						await reader.cancel().catch(() => {});
					}
					return;
				}
				const next = await reader.read();
				if (next.done) {
					if (buffer.length > 0) controller.enqueue(buffer);
					controller.close();
					return;
				}
				buffer = appendBytes(buffer, next.value);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export function createProviderTransport(native: Provider, provider: StoredProvider): Provider {
	const endpoints = new Map(provider.models.map((model) => {
		const api = model.api ?? provider.api;
		const baseUrl = resolveRuntimeBaseUrl(api as ApiKind, model.baseUrl ?? provider.baseUrl);
		const profile = resolveClientHeaderProfile(provider.clientHeaderProfile, api as ApiKind);
		const explicitHeaderNames = new Set(Object.keys(mergeModelRequestHeaders(provider.headers, model.headers) ?? {}));
		return [model.id, { api, baseUrl, profile, explicitHeaderNames }];
	}));
	const proxyUrl = provider.httpProxyEnabled ? getProviderHttpProxyUrl(provider) : undefined;

	const wrap = (stream: Provider["streamSimple"]): Provider["streamSimple"] => (model, context, options) => lazyStream(model, async () => {
		const endpoint = endpoints.get(model.id);
		if (!endpoint || endpoint.api !== model.api) throw new Error(t("请求模型不属于当前接入配置：{modelId}", { modelId: model.id }));
		validateRequestBaseUrl(endpoint.baseUrl);
		// [喵喵喵]: models.json 已保存完整模型头，由宿主在 transformHeaders 前解析；发送层不能再次合并配置而复活被删除的头。
		options = { ...options };
		// [喵喵喵]: models.json 会叠加在动态 provider 之上；还原用户侧 API 根地址，不能让原生持久化形式参与路径拼接。
		const upstreamModel = { ...model, baseUrl: endpoint.baseUrl };
		if (model.api === "google-generative-ai") {
			// [喵喵喵]: Google 适配器先按精确键拼入默认 User-Agent，再构造 Headers；使用该拼写才能覆盖而不是合并成两个值。
			if (options.headers?.["user-agent"] !== undefined) {
				const { "user-agent": userAgent, ...headers } = options.headers;
				options = { ...options, headers: { ...headers, "User-Agent": userAgent } };
			}
			if (!proxyUrl) return stream(upstreamModel, context, options);
			const route = await openTemporaryLocalProxyRoute(native.id, endpoint.baseUrl, proxyUrl);
			try {
				// [喵喵喵]: Google 不支持请求级 fetch，只有发送副本使用本地地址；其模型能力判断基于模型 ID。
				const result = stream({ ...upstreamModel, baseUrl: route.url }, context, options);
				void result.result().then(() => route.close(), () => route.close());
				return result;
			} catch (error) {
				route.close();
				throw error;
			}
		}
		if (model.api !== "openai-completions" && model.api !== "openai-responses" && model.api !== "anthropic-messages") {
			if (proxyUrl) throw new Error(t("该协议尚不支持接入级代理：{api}", { api: model.api }));
			return stream(upstreamModel, context, options);
		}
		const usesCodexHeaders = endpoint.profile === "codex-cli";
		if (!proxyUrl
			&& !usesCodexHeaders
			&& model.api !== "anthropic-messages"
			&& !(model.api === "openai-responses" && provider.openAIResponsesStreamCompletionMode === "terminal-event")) {
			return stream(upstreamModel, context, options);
		}
		const fetchImpl = options?.fetch ?? globalThis.fetch;
		const transportFetch: typeof fetch = async (input, init) => {
			let request = new Request(input, init);
			if (model.api === "anthropic-messages") {
				const url = new URL(request.url);
				const sdkEndpoint = new URL(appendUrlPath(endpoint.baseUrl, "v1", "messages"));
				if (url.origin !== sdkEndpoint.origin || url.pathname !== sdkEndpoint.pathname) {
					throw new Error(t("Anthropic 请求路径与当前适配契约不符"));
				}
				// [喵喵喵]: 仅替换 SDK 明确追加的端点路径，保留 beta 等请求参数，不对 URL 做全局 /v1 替换。
				url.pathname = new URL(appendUrlPath(endpoint.baseUrl, "messages")).pathname;
				request = new Request(url, request);
				if (endpoint.profile === "claude-code") {
					// [喵喵喵]: 从已构造的 body 取会话 ID，避免重试或会话重置后读取全局状态造成头与 metadata 错配。
					const payload: unknown = await request.clone().json().catch(() => undefined);
					const sessionId = getClaudeCodeSessionId(payload);
					if (sessionId) request.headers.set("x-claude-code-session-id", sessionId);
				}
			}
			if (usesCodexHeaders) {
				await applyCodexRequestHeaders(request, model.api as ApiKind, options?.sessionId, endpoint.explicitHeaderNames);
			}
			let response: Response;
			if (!proxyUrl) {
				response = await fetchImpl(request);
			} else {
				const route = await openTemporaryLocalProxyRoute(native.id, request.url, proxyUrl);
				try {
					// [喵喵喵]: 经由本地代理转发时强制禁止自动跟随重定向，防止客户端绕过代理直连上游
					response = await fetchImpl(new Request(route.url, new Request(request, { redirect: "manual" })));
				} finally {
					// [喵喵喵]: 收到响应头时转发端已经取得路由；删除查找项不会中断已建立的 SSE 流。
					route.close();
				}
			}
			if (model.api === "openai-responses"
				&& provider.openAIResponsesStreamCompletionMode === "terminal-event") {
				// [喵喵喵]: 某些中转已发出正式终态事件却保持连接；完整转交该 frame 后即可按协议结束本地流。
				return wrapResponsesTerminalStream(response);
			}
			return response;
		};
		return stream(upstreamModel, context, { ...options, fetch: transportFetch });
	});

	return {
		...native,
		stream: wrap(native.stream.bind(native)) as Provider["stream"],
		streamSimple: wrap(native.streamSimple.bind(native)),
	};
}
