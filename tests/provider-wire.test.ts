import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { after } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { injectClaudeCodeMetadata, resetClaudeCodeMetadataSession } from "../claude-code-compat.ts";
import { closeLocalProxyServer } from "../local-proxy-service.ts";
import { CODEX_CLI_CLIENT_HEADERS } from "../presets/builtin-client-headers.ts";
import type { ApiKind, StateDocument, StoredProvider } from "../types.ts";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const agentDir = await mkdtemp(resolve(".test-provider-wire-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { reconcileProvider, unregisterManagedProvider } = await import("../provider-registrar.ts");
const { buildSynchronizedModelsDocument } = await import("../models-json-sync.ts");
after(async () => { await rm(agentDir, { recursive: true, force: true }); });

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

async function writeStateFixture(state: StateDocument): Promise<string> {
	const { STATE_DIR, STATE_PATH, serializeMetadataState } = await import("../state-metadata-store.ts");
	const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
	const { invalidateStateCache } = await import("../state-cache.ts");
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(MODELS_JSON_PATH, JSON.stringify(buildSynchronizedModelsDocument(state, { providers: {} })));
	await writeFile(STATE_PATH, serializeMetadataState(state));
	invalidateStateCache();
	return MODELS_JSON_PATH;
}

test("真实 Pi：客户端画像、协议 beta、跨 profile 切换及直连/代理保持请求级隔离", { skip: !realRuntime, timeout: 30_000 }, async () => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { default: extension } = await import("../index.ts");
	const captured: { headers: Record<string, unknown>; body: any }[] = [];
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		captured.push({ headers: { ...req.headers }, body: JSON.parse(body) });
		const api = req.url!.includes("/messages") ? "anthropic-messages" : req.url!.includes("/chat/completions") ? "openai-completions" : "openai-responses";
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse(api));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const localUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (url.hostname === "127.0.0.1") return originalFetch(request);
		assert.equal(url.hostname, "switch.invalid", "测试禁止真实外网请求");
		return originalFetch(new Request(`${localUrl}${url.pathname}${url.search}`, request));
	};
	try {
		for (const httpProxyEnabled of [false, true]) {
			const claude = { ...provider("anthropic-messages", "http://switch.invalid/v1"), clientHeaderProfile: "claude-code" as const };
			claude.models[0]!.compat = { forceAdaptiveThinking: true, supportsMidConvoEffort: true };
			claude.models.push({ ...claude.models[0]!, id: "explicit-beta", headers: { "Anthropic-Beta": "user-beta", "X-Claude-Code-Session-Id": "model-session" } });
			claude.models.push({ ...claude.models[0]!, id: "edited-beta", headers: { "Anthropic-Beta": "edited-beta" } });
			const codex = { ...provider("openai-responses", "http://switch.invalid/v1"), clientHeaderProfile: "recommended" as const };
			codex.models.push({ ...codex.models[0]!, id: "another-model" });
			codex.models.push({ ...provider("openai-completions", "unused").models[0]!, api: "openai-completions" });
			codex.models.push({ ...codex.models[0]!, id: "explicit", headers: {
				"User-Agent": "codex_exec/0.166.0", "Originator": "explicit-origin", "Version": "explicit-version",
				"X-Stainless-Lang": "explicit-lang", "Thread-Id": "explicit-thread", "X-Codex-Routing-Hint": "explicit-route",
			} });
			codex.compat = { sessionAffinityFormat: "openrouter" };
			codex.models[0]!.openAIServiceTier = "priority";
			const custom = { ...provider("openai-responses", "http://switch.invalid/v1"), clientHeaderProfile: "custom" as const, customClientHeaders: { "User-Agent": "custom-client", "X-Stainless-Lang": "custom-lang" } };
			const disabled = { ...custom, clientHeaderProfile: "disabled" as const };
			const configs = Object.fromEntries(Object.entries({ claude, codex, custom, disabled }).map(([id, config]) => [id, { ...config, httpProxyEnabled, httpProxyUrl: localUrl }]));
			const state = { version: 2 as const, providers: configs, managedProviderIds: Object.keys(configs), requestHeaderProfiles: {}, clientHeaderCaptures: {
				"codex-cli": { capturedAt: "fixture", headers: { ...CODEX_CLI_CLIENT_HEADERS } },
				"claude-code": { capturedAt: "fixture", headers: { "user-agent": "claude-cli/2.1.326 (external, sdk-cli)", "x-stainless-lang": "js", "Anthropic-Beta": "old-captured-beta" } },
			} };
			const modelsPath = await writeStateFixture(state);
			const { STATE_PATH } = await import("../state-metadata-store.ts");
			const savedModels = JSON.parse(await readFile(modelsPath, "utf8"));
			const savedMetadata = JSON.parse(await readFile(STATE_PATH, "utf8"));
			savedModels.providers.claude.models[0].headers["Anthropic-Beta"] = "old-generated-beta";
			savedMetadata.models[`claude/${claude.models[0]!.id}`].generatedClientHeaders["anthropic-beta"] = "old-generated-beta";
			savedMetadata.models["claude/edited-beta"].generatedClientHeaders["anthropic-beta"] = "old-generated-beta";
			await writeFile(modelsPath, JSON.stringify(savedModels));
			await writeFile(STATE_PATH, JSON.stringify(savedMetadata));
			const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
			const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
			let hookMode: "none" | "override" | "delete" = "none";
			const headerHook = (pi: any) => {
				pi.on("before_provider_headers", (event: any, ctx: any) => {
					if (ctx.model?.provider === "claude") {
						if (hookMode === "override") Object.assign(event.headers, {
							"Anthropic-Beta": "hook-beta", "X-Claude-Code-Session-Id": "hook-session",
						});
						if (hookMode === "delete") {
							event.headers["anthropic-beta"] = null;
							event.headers["X-Claude-Code-SESSION-ID"] = null;
						}
						return;
					}
					if (ctx.model?.provider !== "codex") return;
					if (hookMode === "override") Object.assign(event.headers, {
						"user-agent": "codex_cli_rs/9.9.9 (hook) unknown", originator: "hook-origin", version: "hook-version",
						"x-stainless-lang": "hook-lang", "thread-id": "hook-thread", "x-codex-routing-hint": "hook-route",
					});
					if (hookMode === "delete") for (const name of ["originator", "version", "x-stainless-lang", "session-id", "thread-id", "x-client-request-id", "x-codex-routing-hint"]) event.headers[name] = null;
				});
			};
			const resourceLoader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager, extensionFactories: [extension, headerHook], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
			await resourceLoader.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			delete savedModels.providers.claude.models[0].headers["Anthropic-Beta"];
			assert.deepEqual(JSON.parse(await readFile(modelsPath, "utf8")), savedModels, "迁移只移除已认领的旧 beta，不改用户覆盖或其它模型字段");
			const migrated = JSON.parse(await readFile(STATE_PATH, "utf8"));
			assert.equal(migrated.models[`claude/${claude.models[0]!.id}`].generatedClientHeaders["anthropic-beta"], undefined);
			assert.equal(migrated.clientHeaderCaptures["claude-code"].headers["Anthropic-Beta"], undefined);
			const manager = SessionManager.inMemory(agentDir);
			const { session } = await createAgentSession({ cwd: agentDir, agentDir, modelRuntime: runtime, model: runtime.getModel("claude", claude.models[0]!.id)!, resourceLoader, settingsManager, sessionManager: manager, tools: [] });
			const errors: string[] = [];
			try {
				await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setStatus() {}, setWidget() {} } as any, onError: (error: any) => errors.push(error.error) });
				let claudeSession: unknown;
				for (const [id, modelId] of [["claude", claude.models[0]!.id], ["codex", "gpt-5.2"], ["codex", "another-model"], ["codex", "deepseek-reasoner"], ["claude", claude.models[0]!.id], ["codex", "gpt-5.2"], ["codex", "explicit"], ["custom", "gpt-5.2"], ["disabled", "gpt-5.2"]]) {
					await session.setModel(runtime.getModel(id!, modelId!)!);
					const before = captured.length;
					await session.prompt("continue the same conversation");
					assert.equal(session.getLastAssistantText(), "ok");
					assert.equal(captured.length, before + 1, `${id}/${modelId} must send exactly once`);
					const { headers, body } = captured.at(-1)!;
					if (id === "claude") {
						const identity = JSON.parse(body.metadata.user_id);
						claudeSession ??= identity.session_id;
						assert.equal(identity.session_id, claudeSession);
						assert.equal(headers["x-claude-code-session-id"], claudeSession);
						assert.match(String(headers["user-agent"]), /^claude-cli\//);
						assert.equal(headers["x-stainless-lang"], "js");
						assert.equal(headers.originator, undefined);
						const betas = String(headers["anthropic-beta"]).split(",").map((beta) => beta.trim());
						assert.ok(betas.includes("mid-conversation-output-config-2026-07-01"), "保留 Pi 根据 compat 生成的协议 beta");
						assert.ok(betas.includes("thinking-binding-controls-2026-08-01"));
						assert.equal(betas.filter((beta) => beta === "claude-code-20250219").length, 1);
						assert.equal(betas.includes("per-turn-control-2026-07-01"), false);
						assert.equal(betas.includes("context-1m-2025-08-07"), false);
						assert.equal(betas.includes("interleaved-thinking-2025-05-14"), false);
					} else if (id === "codex") {
						assert.equal(headers["x-claude-code-session-id"], undefined);
						assert.equal(body.metadata?.user_id, undefined);
						if (modelId === "explicit") {
							assert.equal(headers.version, "explicit-version");
							assert.equal(headers.originator, "explicit-origin");
							assert.equal(headers["x-stainless-lang"], "explicit-lang");
							assert.equal(headers["thread-id"], "explicit-thread");
							assert.equal(headers["x-codex-routing-hint"], "explicit-route");
							continue;
						}
						assert.equal(headers["user-agent"], CODEX_CLI_CLIENT_HEADERS["user-agent"]);
						assert.equal(headers.version, CODEX_CLI_CLIENT_HEADERS.version);
						assert.equal(headers.originator, CODEX_CLI_CLIENT_HEADERS.originator);
						assert.equal(Object.keys(headers).some((name) => name.startsWith("x-stainless-")), false);
						if (body.input) {
							assert.equal(headers["session-id"], manager.getSessionId());
							assert.equal(headers["thread-id"], manager.getSessionId());
							assert.equal(headers["x-client-request-id"], manager.getSessionId());
							assert.equal(headers["x-session-id"], manager.getSessionId(), "保留原有会话亲和字段");
							assert.equal(headers["x-codex-routing-hint"], `model=${body.model}${body.service_tier ? `;tier=${body.service_tier}` : ""}`);
							assert.equal(body.service_tier, modelId === "gpt-5.2" ? "priority" : undefined);
						} else {
							assert.equal(headers["session-id"], undefined, "Chat 不添加 Responses 专用会话头");
							assert.equal(headers["x-codex-routing-hint"], undefined);
						}
					} else {
						if (id === "custom") assert.equal(headers["user-agent"], "custom-client");
						else assert.doesNotMatch(String(headers["user-agent"]), /^codex/);
						assert.equal(headers["x-stainless-lang"], id === "custom" ? "custom-lang" : "js");
						assert.equal(headers.originator, undefined);
						// [喵喵喵]: Pi 原生 Responses 也会发送 session-id；以 Codex 专属 thread-id 检查画像隔离。
						assert.equal(headers["thread-id"], undefined);
						assert.equal(headers["x-codex-routing-hint"], undefined);
					}
				}
				await session.setModel(runtime.getModel("codex", "gpt-5.2")!);
				for (const mode of ["override", "delete"] as const) {
					hookMode = mode;
					const before = captured.length;
					await session.prompt("Apply the request header hook");
					assert.equal(session.getLastAssistantText(), "ok");
					assert.equal(captured.length, before + 1);
					const { headers } = captured.at(-1)!;
					if (mode === "override") {
						assert.equal(headers["user-agent"], "codex_cli_rs/9.9.9 (hook) unknown");
						assert.equal(headers.originator, "hook-origin");
						assert.equal(headers.version, "hook-version");
						assert.equal(headers["x-stainless-lang"], "hook-lang");
						assert.equal(headers["thread-id"], "hook-thread");
						assert.equal(headers["x-codex-routing-hint"], "hook-route");
					} else {
						for (const name of ["originator", "version", "x-stainless-lang", "session-id", "thread-id", "x-client-request-id", "x-codex-routing-hint"]) assert.equal(headers[name], undefined, `${name} 被钩子删除后不得重新加入`);
					}
				}
				hookMode = "none";
				await session.setModel(runtime.getModel("claude", "explicit-beta")!);
				await session.prompt("Keep explicit beta");
				assert.equal(session.getLastAssistantText(), "ok");
				assert.equal(captured.at(-1)!.headers["anthropic-beta"], "user-beta");
				assert.equal(captured.at(-1)!.headers["x-claude-code-session-id"], "model-session");
				await session.setModel(runtime.getModel("claude", claude.models[0]!.id)!);
				const claudeHookSessionHeaders: unknown[] = [];
				for (const mode of ["override", "delete"] as const) {
					hookMode = mode;
					await session.prompt("Apply the Claude request header hook");
					assert.equal(session.getLastAssistantText(), "ok");
					assert.equal(captured.at(-1)!.headers["anthropic-beta"], mode === "override" ? "hook-beta" : undefined);
					assert.equal(JSON.parse(captured.at(-1)!.body.metadata.user_id).session_id, claudeSession);
					claudeHookSessionHeaders.push(captured.at(-1)!.headers["x-claude-code-session-id"]);
				}
				assert.deepEqual(claudeHookSessionHeaders, ["hook-session", undefined], "会话头必须保留钩子覆盖及删除，且不改写正文 metadata");
				hookMode = "none";
				const refreshed = JSON.parse(await readFile(modelsPath, "utf8"));
				for (const [beta, providerSessionId, modelSessionId] of [
					["refreshed-beta", "provider-session", undefined],
					[undefined, "provider-session", "model-session"],
					[undefined, undefined, undefined],
				] as const) {
					const model = refreshed.providers.claude.models[0];
					if (beta) model.headers["anthropic-beta"] = beta;
					else delete model.headers["anthropic-beta"];
					refreshed.providers.claude.headers ??= {};
					if (providerSessionId) refreshed.providers.claude.headers["X-Claude-Code-Session-Id"] = providerSessionId;
					else delete refreshed.providers.claude.headers["X-Claude-Code-Session-Id"];
					if (modelSessionId) model.headers["X-Claude-Code-SESSION-ID"] = modelSessionId;
					else delete model.headers["X-Claude-Code-SESSION-ID"];
					await writeFile(modelsPath, JSON.stringify(refreshed));
					await runtime.refresh({ allowNetwork: false });
					await session.setModel(runtime.getModel("claude", claude.models[0]!.id)!);
					await session.prompt("Use refreshed request header configuration");
					assert.equal(session.getLastAssistantText(), "ok");
					if (beta) assert.equal(captured.at(-1)!.headers["anthropic-beta"], beta);
					else assert.match(String(captured.at(-1)!.headers["anthropic-beta"]), /mid-conversation-output-config-2026-07-01.*claude-code-20250219/);
					assert.equal(captured.at(-1)!.headers["x-claude-code-session-id"], modelSessionId ?? providerSessionId ?? claudeSession);
					assert.equal(JSON.parse(captured.at(-1)!.body.metadata.user_id).session_id, claudeSession);
				}
				const uncached = await runtime.streamSimple(runtime.getModel("codex", "gpt-5.2")!, context as any, { sessionId: manager.getSessionId(), cacheRetention: "none", onPayload: (payload: any) => ({ ...payload, model: "routed-model", service_tier: "ultrafast" }) }).result();
				assert.equal(uncached.stopReason, "stop", uncached.errorMessage);
				assert.equal(captured.at(-1)!.headers["session-id"], manager.getSessionId());
				assert.equal(captured.at(-1)!.headers.session_id, undefined);
				assert.equal(captured.at(-1)!.body.prompt_cache_key, undefined);
				assert.equal(captured.at(-1)!.headers["x-codex-routing-hint"], "model=routed-model;tier=ultrafast");
				assert.deepEqual(errors, []);
			} finally {
				await session.extensionRunner.emit({ type: "session_shutdown" });
				session.dispose();
			}
		}
	} finally {
		globalThis.fetch = originalFetch;
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("真实 Pi：ClaudeCode 会话头与实际 JSON metadata 一致，不受发送前会话重置影响", { skip: !realRuntime, timeout: 15_000 }, async () => {
	const config = { ...provider("anthropic-messages", "http://gateway.invalid/v1"), clientHeaderProfile: "claude-code" as const };
	const state = { version: 2 as const, providers: { "session-wire": config }, managedProviderIds: ["session-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} };
	const modelsPath = await writeStateFixture(state);
	const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
	const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
	const originalFetch = globalThis.fetch;
	let captured: Request | undefined;
	globalThis.fetch = async (input, init) => {
		captured = new Request(input, init);
		return new Response(sse("anthropic-messages"), { headers: { "content-type": "text/event-stream" } });
	};
	try {
		await reconcileProvider(pi, "session-wire", config);
		const model = runtime.getModel("session-wire", config.models[0]!.id)!;
		const result = await runtime.streamSimple(model, context as any, {
			onPayload(payload) {
				const transformed = injectClaudeCodeMetadata(payload, model, state);
				resetClaudeCodeMetadataSession();
				return transformed;
			},
		}).result();
		assert.equal(result.stopReason, "stop", result.errorMessage);
		assert.ok(captured);
		const body = await captured.json();
		const identity = JSON.parse(body.metadata.user_id);
		assert.deepEqual(Object.keys(identity).sort(), ["account_uuid", "device_id", "session_id"]);
		assert.match(identity.device_id, /^[0-9a-f]{64}$/);
		assert.equal(identity.account_uuid, "");
		assert.match(identity.session_id, /^[0-9a-f-]{36}$/);
		assert.equal(captured.headers.get("x-claude-code-session-id"), identity.session_id);
	} finally {
		globalThis.fetch = originalFetch;
		unregisterManagedProvider(pi, "session-wire");
	}
});

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
	// [喵喵喵]: 生产入口总是先持久化再注册；宿主必须持有同一份原生模型配置，才能在头钩子之前解析模型级表达式。
	const modelsPath = await writeStateFixture({ version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
	const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
	try {
		for (api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			const id = `wire-${api}`;
			const hostname = api === "openai-completions" ? "api.deepseek.com" : "gateway.invalid";
			const config = provider(api, `http://${hostname}/xxx`);
			config.headers = { "X-Remove-Provider": "remove", "X-Provider-Override": "configured" };
			config.models[0]!.headers = { "X-Remove-Model": "remove", "X-Model-Route": "$PI_WIRE_MODEL_ROUTE" };
			const untouched = structuredClone(config);
			const results: unknown[] = [];
			for (const enabled of [false, true]) {
				const stored = { ...config, httpProxyEnabled: enabled, httpProxyUrl: localUrl };
				await writeStateFixture({ version: 2, providers: { [id]: stored }, managedProviderIds: [id], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
				await runtime.refresh({ allowNetwork: false });
				await reconcileProvider(pi, id, stored);
				const model = runtime.getModel(id, config.models[0]!.id)!;
				assert.equal(model.baseUrl, config.baseUrl);
				let transforms = 0;
				const result = await runtime.streamSimple(model, context as any, {
					reasoning: "high", maxTokens: 12000,
					env: { PI_WIRE_MODEL_ROUTE: "resolved-model-route" },
					headers: { "X-Provider-Override": "call-override" },
					transformHeaders(input) {
						transforms++;
						const headers = new Headers(input);
						assert.equal(headers.get("x-provider-override"), "call-override");
						assert.equal(headers.get("x-model-route"), "resolved-model-route");
						headers.delete("x-remove-provider");
						headers.delete("x-remove-model");
						headers.set("x-model-route", "hook-route");
						return Object.fromEntries(headers);
					},
				}).result();
				assert.equal(transforms, 1);
				assert.equal(result.stopReason, "stop", `${api}, proxy=${enabled}: ${result.errorMessage}; ${serverErrors.join("\n")}`);
				assert.equal(result.content.filter((block: any) => block.type === "text").map((block: any) => block.text).join(""), "ok");
				results.push(captured.at(-1));
			}
			assert.deepEqual(config, untouched);
			assert.deepEqual(results[1], results[0], api);
			const request = captured.at(-1)!;
			assert.equal(request.headers["user-agent"], "wire-fixture");
			assert.equal(request.headers["x-test-client"], "user-value");
			assert.equal(request.headers["x-provider-override"], "call-override");
			assert.equal(request.headers["x-model-route"], "hook-route");
			assert.equal(request.headers["x-remove-provider"], undefined);
			assert.equal(request.headers["x-remove-model"], undefined);
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

test("真实 Pi：Google 全档位同名出站、钩子及原生预算协议保持有效", { skip: !realRuntime, timeout: 20_000 }, async () => {
	const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
	const { normalizeThinkingLevelMap } = await import("../presets/thinking.ts");
	const captured: any[] = [];
	let responseStatus = 200;
	const server = createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		captured.push(JSON.parse(body));
		if (responseStatus !== 200) {
			res.writeHead(responseStatus, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { code: responseStatus, message: "unsupported fixture level", status: "INVALID_ARGUMENT" } }));
			return;
		}
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse("google-generative-ai"));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const localUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const id = "google-thinking-wire";
	let pi: any;
	try {
		const config = provider("google-generative-ai", `${localUrl}/v1beta`);
		config.models[0]!.id = "gemini-4-neon";
		config.models[0]!.contextWindow = 8192;
		config.models[0]!.thinkingLevelMap = normalizeThinkingLevelMap(config.api, true, undefined, config.models[0]!.id);
		const modelsPath = await writeStateFixture({ version: 2, providers: { [id]: config }, managedProviderIds: [id], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
		const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, refreshOnCreate: false, allowModelNetwork: false });
		pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) };
		const levels = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
		for (const httpProxyEnabled of [false, true]) {
			await reconcileProvider(pi, id, { ...config, httpProxyEnabled, httpProxyUrl: localUrl });
			const model = runtime.getModel(id, config.models[0]!.id)!;
			assert.deepEqual(getSupportedThinkingLevels(model), ["off", ...levels]);
			const off = await runtime.streamSimple(model, context as any).result();
			assert.equal(off.stopReason, "stop", off.errorMessage);
			assert.deepEqual(captured.at(-1).generationConfig.thinkingConfig, { thinkingBudget: 0 });
			const nativeCap = captured.at(-1).generationConfig.maxOutputTokens;
			assert.ok(nativeCap > 0 && nativeCap < model.maxTokens, "原生上下文余量收紧输出上限");
			for (const reasoning of levels) {
				let payloadCalls = 0;
				let responses = 0;
				let streamEvents = 0;
				const result = await runtime.streamSimple(model, context as any, {
					reasoning,
					onPayload(payload: any, requestModel) {
						payloadCalls++;
						assert.equal(requestModel.reasoning, true);
						assert.equal(payload.config.thinkingConfig.thinkingLevel, reasoning.toUpperCase());
						return { ...payload, config: { ...payload.config, temperature: 0.42 } };
					},
					onResponse(_response, requestModel) {
						responses++;
						assert.equal(requestModel.reasoning, true);
					},
					onProviderStreamEvent(_event, requestModel) {
						streamEvents++;
						assert.equal(requestModel.reasoning, true);
					},
				}).result();
				assert.equal(result.stopReason, "stop", `${reasoning}, proxy=${httpProxyEnabled}: ${result.errorMessage}`);
				assert.equal(payloadCalls, 1);
				assert.equal(responses, 0, "Google 原生成功流不触发 onResponse");
				assert.equal(streamEvents, 1);
				assert.deepEqual(captured.at(-1).generationConfig.thinkingConfig, { includeThoughts: true, thinkingLevel: reasoning.toUpperCase() });
				assert.equal(captured.at(-1).generationConfig.maxOutputTokens, nativeCap);
				assert.equal(captured.at(-1).generationConfig.temperature, 0.42);
			}
			const restricted = { ...model, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: null, xhigh: null, max: "max" } };
			const maxOnly = await runtime.streamSimple(restricted, context as any, { reasoning: "max" }).result();
			assert.equal(maxOnly.stopReason, "stop", maxOnly.errorMessage);
			assert.equal(captured.at(-1).generationConfig.thinkingConfig.thinkingLevel, "MAX");
			const hookOverride = await runtime.streamSimple(model, context as any, {
				reasoning: "max", onPayload(payload: any) { payload.config.thinkingConfig = { thinkingLevel: "HOOK_LEVEL" }; },
			}).result();
			assert.equal(hookOverride.stopReason, "stop", hookOverride.errorMessage);
			assert.deepEqual(captured.at(-1).generationConfig.thinkingConfig, { thinkingLevel: "HOOK_LEVEL" });
			responseStatus = 400;
			let failedResponses = 0;
			const rejected = await runtime.streamSimple(model, context as any, {
				reasoning: "max", maxRetries: 0,
				onResponse(response, requestModel) {
					failedResponses++;
					assert.equal(response.status, 400);
					assert.equal(requestModel.reasoning, true);
				},
			}).result();
			assert.equal(rejected.stopReason, "error");
			assert.match(rejected.errorMessage!, /unsupported fixture level/);
			assert.equal(failedResponses, 1);
			responseStatus = 200;
		}
		unregisterManagedProvider(pi, id);
		config.models[0]!.id = "gemini-2.5-flash";
		config.models[0]!.thinkingLevelMap = normalizeThinkingLevelMap(config.api, true, undefined, config.models[0]!.id);
		await reconcileProvider(pi, id, config);
		const budgetModel = runtime.getModel(id, config.models[0]!.id)!;
		assert.deepEqual(getSupportedThinkingLevels(budgetModel), ["off", "minimal", "low", "medium", "high"]);
		const budget = await runtime.streamSimple(budgetModel, context as any, { reasoning: "high", thinkingBudgets: { high: 4096 } }).result();
		assert.equal(budget.stopReason, "stop", budget.errorMessage);
		assert.deepEqual(captured.at(-1).generationConfig.thinkingConfig, { includeThoughts: true, thinkingBudget: 4096 });
	} finally {
		if (pi) unregisterManagedProvider(pi, id);
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("真实 Pi：Gemini 草稿地址转换后经保存重载，发现与聊天使用同一版本路径", { skip: !realRuntime, timeout: 15_000 }, async () => {
	const { resolveProviderDraftBaseUrl } = await import("../runtime-base-url.ts");
	const { createProviderDraftFromStored } = await import("../state-document.ts");
	const { saveProviderConfiguration } = await import("../model-mutations.ts");
	const { readState } = await import("../state-store.ts");
	const { fetchModelIds } = await import("../tui/model-list-fetch.ts");
	const paths: string[] = [];
	const server = createServer(async (req, res) => {
		for await (const _ of req) {}
		paths.push(new URL(req.url!, localUrl).pathname);
		if (req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ models: [{ name: "models/gemini-2.5-flash" }] }));
		} else {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end(sse("google-generative-ai"));
		}
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const localUrl = `http://127.0.0.1:${(server.address() as any).port}`;
	const id = "gemini-draft-wire";
	try {
		const config = provider("google-generative-ai", `${localUrl}/tenant/v1`);
		const state: StateDocument = { version: 2, providers: { [id]: config }, managedProviderIds: [id], requestHeaderProfiles: {}, clientHeaderCaptures: {} };
		const modelsPath = await writeStateFixture(state);
		const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false });
		const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
		const draft = createProviderDraftFromStored(id, config);
		draft.baseUrl = resolveProviderDraftBaseUrl(draft.api, `${config.baseUrl}/`);
		const expectedRoot = `${localUrl}/tenant/v1beta`;
		assert.equal(draft.baseUrl, expectedRoot);
		await saveProviderConfiguration(pi, { modelRegistry: runtime, ui: { notify() {} } } as any, state, draft, id);
		assert.equal(JSON.parse(await readFile(modelsPath, "utf8")).providers[id].baseUrl, expectedRoot);
		unregisterManagedProvider(pi, id);

		const stored = (await readState()).providers[id]!;
		assert.equal(stored.baseUrl, expectedRoot);
		const reloaded = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false });
		const reloadedPi = { registerProvider: (native: any) => reloaded.registerNativeProvider(native), unregisterProvider: (id: string) => reloaded.unregisterProvider(id) } as any;
		try {
			for (const httpProxyEnabled of [false, true]) {
				await reconcileProvider(reloadedPi, id, { ...stored, httpProxyEnabled, httpProxyUrl: localUrl });
				const discovery = await fetchModelIds({ ...draft, baseUrl: stored.baseUrl, httpProxyEnabled, httpProxyUrl: localUrl });
				assert.deepEqual(discovery, { status: "loaded", modelIds: ["gemini-2.5-flash"] });
				const model = reloaded.getModel(id, config.models[0]!.id)!;
				assert.ok(model);
				const result = await reloaded.streamSimple(model, context as any).result();
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.deepEqual(paths.slice(-2), ["/tenant/v1beta/models", "/tenant/v1beta/models/gemini-2.5-flash:streamGenerateContent"]);
			}
		} finally {
			unregisterManagedProvider(reloadedPi, id);
		}
	} finally {
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("真实 Pi：标准 Anthropic 原生可用，加载插件后独立端点和混合协议仍按 API 根地址发送", { skip: !realRuntime, timeout: 15_000 }, async () => {
	const config = provider("anthropic-messages", "http://gateway.invalid/tenant/v1");
	config.models.push({ ...config.models[0]!, id: "custom-root", baseUrl: "http://gateway.invalid/xxx" });
	config.models.push({ ...provider("openai-completions", "unused").models[0]!, api: "openai-completions", baseUrl: "http://api.deepseek.com/independent" });
	const modelsPath = await writeStateFixture({ version: 2, providers: { "native-wire": config }, managedProviderIds: ["native-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
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
				await writeStateFixture({ version: 2, providers: { "invalid-wire": invalid }, managedProviderIds: ["invalid-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
				await runtime.refresh({ allowNetwork: false });
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
	const modelsPath = await writeStateFixture({ version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
	const pi = { registerProvider: (native: any) => runtime.registerNativeProvider(native), unregisterProvider: (id: string) => runtime.unregisterProvider(id) } as any;
	try {
		for (api of ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"] as ApiKind[]) {
			const config = { ...provider(api, "http://gateway.invalid/xxx"), httpProxyEnabled: true, httpProxyUrl: proxyUrl };
			await writeStateFixture({ version: 2, providers: { "cancel-wire": config }, managedProviderIds: ["cancel-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
			await runtime.refresh({ allowNetwork: false });
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
		await writeStateFixture({ version: 2, providers: { "failure-wire": config }, managedProviderIds: ["failure-wire"], requestHeaderProfiles: {}, clientHeaderCaptures: {} });
		await runtime.refresh({ allowNetwork: false });
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

test("真实 Pi：原生模型刷新同时更新端点、认证和混合协议传输，不绕过接入代理", { skip: !realRuntime, timeout: 20_000 }, async () => {
	const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const { default: extension } = await import("../index.ts");
	const captured: { url: string; headers: Record<string, unknown> }[] = [];
	const server = createServer(async (req, res) => {
		for await (const _ of req) {}
		captured.push({ url: req.url!, headers: { ...req.headers } });
		const api = req.url!.includes("/messages") ? "anthropic-messages"
			: req.url!.includes("/chat/completions") ? "openai-completions"
				: req.url!.includes("streamGenerateContent") ? "google-generative-ai" : "openai-responses";
		res.writeHead(200, { "content-type": "text/event-stream" });
		res.end(sse(api));
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, "127.0.0.1", "已开启接入代理的模型不得直连");
		return originalFetch(request);
	};
	const id = "refresh-wire";
	const config: StoredProvider = {
		...provider("openai-responses", "http://refresh.invalid/before/v1"),
		clientHeaderProfile: "disabled", customClientHeaders: {}, authHeader: true,
		headers: { "X-Remove-After-Refresh": "old" },
		httpProxyEnabled: true, httpProxyUrl: `http://127.0.0.1:${(server.address() as any).port}`,
	};
	const state: StateDocument = { version: 2, providers: { [id]: config }, managedProviderIds: [id], requestHeaderProfiles: {}, clientHeaderCaptures: {} };
	let session: any;
	try {
		const modelsPath = await writeStateFixture(state);
		const runtime = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath, allowModelNetwork: false, refreshOnCreate: false });
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager, extensionFactories: [extension], noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true });
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		({ session } = await createAgentSession({ cwd: agentDir, agentDir, modelRuntime: runtime, model: runtime.getModel(id, config.models[0]!.id)!, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(agentDir), tools: [] }));
		const errors: string[] = [];
		await session.bindExtensions({ mode: "tui", uiContext: { notify() {}, setStatus() {}, setWidget() {} } as any, onError: (error: any) => errors.push(error.error) });
		await session.prompt("Reply only OK");
		assert.equal(session.getLastAssistantText(), "ok");
		assert.equal(captured.at(-1)!.url, "http://refresh.invalid/before/v1/responses");

		const next: StoredProvider = {
			...config, baseUrl: "http://refresh.invalid/after/v1", apiKey: "refreshed-fixture-key", headers: { "X-Refreshed": "new" },
			models: [config.models[0]!, ...(["openai-completions", "anthropic-messages", "google-generative-ai"] as ApiKind[]).map((api) => ({
				...provider(api, "unused").models[0]!, api, baseUrl: `http://refresh.invalid/${api}/v1`,
			}))],
		};
		await writeFile(modelsPath, JSON.stringify(buildSynchronizedModelsDocument({ ...state, providers: { [id]: next } }, { providers: {} })));
		await runtime.refresh({ signal: AbortSignal.timeout(10_000) });
		await session.prompt("Continue");
		assert.equal(session.getLastAssistantText(), "ok");
		assert.equal(captured.at(-1)!.url, "http://refresh.invalid/after/v1/responses");
		assert.equal(captured.at(-1)!.headers.authorization, "Bearer refreshed-fixture-key");
		// [喵喵喵]: /model 选中刷新后的对象才会替换 Pi 会话模型的旧 headers；传输层不能在头钩子后替宿主重合并。
		await session.setModel(runtime.getModel(id, config.models[0]!.id)!);
		await session.prompt("Continue");
		assert.equal(session.getLastAssistantText(), "ok");
		assert.equal(captured.at(-1)!.headers["x-remove-after-refresh"], undefined);
		assert.equal(captured.at(-1)!.headers["x-refreshed"], "new");
		for (const model of next.models.slice(1)) {
			const selected = runtime.getModel(id, model.id);
			assert.ok(selected, model.id);
			assert.equal(selected.api, model.api);
			await session.setModel(selected);
			const before = captured.length;
			await session.prompt("Continue");
			assert.equal(session.getLastAssistantText(), "ok", model.api);
			assert.equal(captured.length, before + 1, `${model.api} 必须通过代理发送一次`);
			const request = captured.at(-1)!;
			assert.ok(request.url.startsWith(`http://refresh.invalid/${model.api}/v1/`), request.url);
			assert.equal(request.headers.authorization, "Bearer refreshed-fixture-key");
			assert.equal(request.headers["x-remove-after-refresh"], undefined);
		}
		assert.deepEqual(errors, []);
	} finally {
		if (session) {
			await session.extensionRunner.emit({ type: "session_shutdown" });
			session.dispose();
		}
		globalThis.fetch = originalFetch;
		await closeLocalProxyServer();
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
