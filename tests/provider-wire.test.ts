import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { reconcileProvider, unregisterManagedProvider } from "../provider-registrar.ts";
import { closeLocalProxyServer } from "../local-proxy-service.ts";
import type { ApiKind, StoredProvider } from "../types.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { buildSynchronizedModelsDocument } from "../models-json-sync.ts";

const realRuntime = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";
const emptyCredentials = { async read() {}, async list() { return []; }, async modify() {}, async delete() {} };
const context = {
	systemPrompt: "Follow the test system instructions.",
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
	tools: [{ name: "lookup", description: "Look up a value", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] } }],
};

function sse(api: ApiKind): string {
	const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
	if (api === "openai-completions") return event({ id: "test", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] })
		+ event({ id: "test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";
	if (api === "google-generative-ai") return event({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } });
	if (api === "anthropic-messages") {
		return [
			{ type: "message_start", message: { id: "test", type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
			{ type: "message_stop" },
		].map((value) => `event: ${value.type}\n${event(value)}`).join("");
	}
	const item = { id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] };
	return [
		{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	].map(event).join("");
}

function provider(api: ApiKind, baseUrl: string): StoredProvider {
	const ids = { "openai-completions": "deepseek-reasoner", "openai-responses": "gpt-5.2", "anthropic-messages": "claude-sonnet-4-6", "google-generative-ai": "gemini-2.5-flash" };
	return {
		name: "Wire fixture", api, baseUrl, apiKey: "fake-gateway-key", managed: true,
		clientHeaderProfile: "custom", customClientHeaders: { "User-Agent": "wire-fixture", "X-Test-Client": "user-value", "Anthropic-Beta": "user-beta,interleaved-thinking-2025-05-14" },
		models: [{ id: ids[api], reasoning: true, input: ["text"], contextWindow: 128000, maxTokens: 12000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(api === "anthropic-messages" ? { compat: { forceAdaptiveThinking: true } } : {}) }],
	};
}

test("真实 Pi：四协议代理前后端点、业务头、payload 和 SSE 结果一致", { skip: !realRuntime, timeout: 30_000 }, async () => {
	const captured: { url: string; headers: Record<string, unknown>; body: unknown }[] = [];
	const serverErrors: string[] = [];
	let api: ApiKind = "openai-completions";
	const server = createServer(async (req, res) => {
		try {
			let body = "";
			for await (const chunk of req) body += chunk;
			const headers = { ...req.headers };
			const url = String(headers["x-test-target-url"] ?? req.url);
			for (const name of ["x-test-target-url", "host", "connection", "proxy-connection", "content-length", "transfer-encoding"]) delete headers[name];
			captured.push({ url, headers, body: JSON.parse(body) });
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sse(api));
		} catch (error) {
			res.destroy(error as Error);
		}
	});
	server.on("clientError", (error: any, socket) => {
		serverErrors.push(`${error.code}: ${error.message}\n${error.rawPacket?.toString()}`);
		socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const localUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "127.0.0.1") return originalFetch(request);
		assert.ok(url.hostname.endsWith(".invalid") || url.hostname === "api.deepseek.com", `Unexpected network target: ${url.origin}`);
		const local = new Request(`${localUrl}${url.pathname}${url.search}`, request);
		local.headers.set("x-test-target-url", request.url);
		return originalFetch(local);
	};
	const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
	try {
		for (api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			const id = `wire-${api}`;
			const hostname = api === "openai-completions" ? "api.deepseek.com" : "gateway.invalid";
			const config = provider(api, `http://${hostname}/xxx`);
			const untouched = structuredClone(config);
			const results: unknown[] = [];
			for (const enabled of [false, true]) {
				await reconcileProvider(pi, id, { ...config, httpProxyEnabled: enabled, httpProxyUrl: localUrl });
				const model = runtime.getModel(id, config.models[0]!.id)!;
				assert.equal(model.baseUrl, config.baseUrl);
				const result = await runtime.streamSimple(model, context as any, { reasoning: "high", maxTokens: 12000 }).result();
				assert.equal(result.stopReason, "stop", `${api}, proxy=${enabled}: ${result.errorMessage}; ${serverErrors.join("\n")}`);
				assert.equal(result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""), "ok");
				results.push(captured.at(-1));
			}
			assert.deepEqual(config, untouched);
			assert.deepEqual(results[1], results[0], api);
			const request = captured.at(-1)!;
			assert.equal(request.headers["user-agent"], "wire-fixture");
			assert.equal(request.headers["x-test-client"], "user-value");
			const path = new URL(request.url).pathname;
			assert.ok(path.startsWith("/xxx/"), path);
			if (api === "anthropic-messages") {
				assert.equal(path, "/xxx/messages");
				assert.equal(request.headers["anthropic-beta"], "user-beta,interleaved-thinking-2025-05-14");
			}
			if (api === "openai-completions") {
				const body = request.body as any;
				assert.equal(body.messages[0].role, "system");
				assert.equal(body.max_tokens, 12000);
				assert.deepEqual(body.thinking, { type: "enabled" });
				assert.equal(body.store, undefined);
			}
			unregisterManagedProvider(pi, id);
		}
		assert.equal(captured.length, 8);
	} finally {
		globalThis.fetch = originalFetch;
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("真实 Pi：标准 Anthropic 原生可用，加载插件后独立端点和混合协议仍按 API 根地址发送", { skip: !realRuntime, timeout: 15_000 }, async () => {
	const directory = await mkdtemp(resolve(".test-native-wire-"));
	const modelsPath = join(directory, "models.json");
	const config = provider("anthropic-messages", "http://gateway.invalid/tenant/v1");
	config.models.push({ ...config.models[0]!, id: "custom-root", baseUrl: "http://gateway.invalid/xxx" });
	config.models.push({ ...provider("openai-completions", "unused").models[0]!, api: "openai-completions", baseUrl: "http://api.deepseek.com/independent" });
	const source = buildSynchronizedModelsDocument({ version: 2, providers: { "native-wire": config }, managedProviderIds: ["native-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} }, { providers: {} });
	await writeFile(modelsPath, JSON.stringify(source));
	const urls: string[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		urls.push(request.url);
		return new Response(sse(request.url.endsWith("/chat/completions") ? "openai-completions" : "anthropic-messages"), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false });
		const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
		const nativeModel = runtime.getModel("native-wire", config.models[0]!.id)!;
		assert.ok(nativeModel);
		assert.equal((await runtime.streamSimple(nativeModel, context as any).result()).stopReason, "stop");
		assert.equal(urls.at(-1), "http://gateway.invalid/tenant/v1/messages?beta=true");
		await reconcileProvider(pi, "native-wire", config);
		for (const model of config.models) {
			const selected = runtime.getModel("native-wire", model.id)!;
			assert.equal((await runtime.streamSimple(selected, context as any).result()).stopReason, "stop");
		}
		assert.deepEqual(urls.slice(1), ["http://gateway.invalid/tenant/v1/messages?beta=true", "http://gateway.invalid/xxx/messages?beta=true", "http://api.deepseek.com/independent/chat/completions"]);
		unregisterManagedProvider(pi, "native-wire");
		for (const api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			for (const suffix of ["?tenant=a", "#fragment"]) {
				const invalid = provider(api, `http://gateway.invalid/v1${suffix}`);
				await reconcileProvider(pi, "invalid-wire", invalid);
				const result = await runtime.streamSimple(runtime.getModel("invalid-wire", invalid.models[0]!.id)!, context as any).result();
				assert.equal(result.stopReason, "error");
				assert.match(result.errorMessage!, /Base URL/);
			}
		}
		assert.equal(urls.length, 4, "无效 Base URL 不进入 fetch");
		unregisterManagedProvider(pi, "invalid-wire");
	} finally {
		globalThis.fetch = originalFetch;
		await rm(directory, { recursive: true, force: true });
	}
});

test("真实 Pi：四协议代理流可在结束前收到文本并取消，代理失败不会直连", { skip: !realRuntime, timeout: 20_000 }, async () => {
	let api: ApiKind = "openai-completions";
	let failProxy = false;
	let upstreamClosed = Promise.withResolvers<void>();
	const server = createServer(async (req, res) => {
		for await (const _ of req) {}
		res.on("close", () => upstreamClosed.resolve());
		if (failProxy) {
			res.writeHead(502, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "proxy fixture failure" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		const frames = { "openai-completions": 1, "anthropic-messages": 3, "openai-responses": 4, "google-generative-ai": 1 };
		res.write(`${sse(api).split("\n\n").slice(0, frames[api]).join("\n\n")}\n\n`);
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const proxyUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const originalFetch = globalThis.fetch;
	let directRequests = 0;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (new URL(request.url).hostname === "127.0.0.1") return originalFetch(request);
		directRequests += 1;
		throw new Error("Unexpected direct request");
	};
	const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
	try {
		for (api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			const config = { ...provider(api, "http://gateway.invalid/xxx"), httpProxyEnabled: true, httpProxyUrl: proxyUrl };
			await reconcileProvider(pi, "cancel-wire", config);
			upstreamClosed = Promise.withResolvers<void>();
			const controller = new AbortController();
			const stream = runtime.streamSimple(runtime.getModel("cancel-wire", config.models[0]!.id)!, context as any, { signal: controller.signal });
			let receivedText = false;
			for await (const event of stream) {
				if (event.type === "text_delta") {
					receivedText = true;
					controller.abort();
					break;
				}
			}
			assert.equal(receivedText, true, api);
			assert.equal((await stream.result()).stopReason, "aborted", api);
			await upstreamClosed.promise;
			unregisterManagedProvider(pi, "cancel-wire");
		}
		failProxy = true;
		const config = { ...provider("openai-completions", "http://gateway.invalid/xxx"), httpProxyEnabled: true, httpProxyUrl: proxyUrl };
		await reconcileProvider(pi, "failure-wire", config);
		const result = await runtime.streamSimple(runtime.getModel("failure-wire", config.models[0]!.id)!, context as any, { signal: AbortSignal.timeout(5000) }).result();
		assert.equal(result.stopReason, "error", result.errorMessage);
		assert.match(result.errorMessage!, /proxy fixture failure|502/);
		assert.equal(directRequests, 0);
		unregisterManagedProvider(pi, "failure-wire");
	} finally {
		globalThis.fetch = originalFetch;
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
