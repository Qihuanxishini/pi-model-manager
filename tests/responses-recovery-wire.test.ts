import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const realRuntime = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";
const magicEntry = realRuntime && process.env.PI_TEST_MAGIC_ENTRY ? resolve(process.env.PI_TEST_MAGIC_ENTRY) : undefined;

function sse(index: number): string {
	const reasoning = { type: "reasoning", id: `rs_new_${index}`, summary: [], encrypted_content: `cipher-new-${index}` };
	const message = { type: "message", id: `msg_new_${index}`, role: "assistant", content: [{ type: "output_text", text: "recovered", annotations: [] }] };
	return [
		{ type: "response.created", response: { id: `resp_${index}`, status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: reasoning },
		{ type: "response.output_item.done", output_index: 0, item: reasoning },
		{ type: "response.output_item.added", output_index: 1, item: { ...message, content: [] } },
		{ type: "response.content_part.added", output_index: 1, content_index: 0, item_id: message.id, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 1, content_index: 0, item_id: message.id, delta: "recovered" },
		{ type: "response.output_item.done", output_index: 1, item: message },
		{ type: "response.completed", response: { id: `resp_${index}`, status: "completed", output: [reasoning, message], usage: { input_tokens: magicEntry ? 12000 : 1, output_tokens: 1, total_tokens: magicEntry ? 12001 : 2 } } },
	].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

test(`真实 Pi${magicEntry ? " + Magic Context" : ""}：400 后仅剥离旧 ID，保留思维链并在下一轮保留新 ID`, { skip: !realRuntime, timeout: 30_000 }, async () => {
	const agentDir = await mkdtemp(resolve(".test-responses-recovery-wire-"));
	const originalCwd = process.cwd();
	const originalFetch = globalThis.fetch;
	const overrides: Record<string, string | undefined> = { PI_CODING_AGENT_DIR: agentDir };
	if (magicEntry) Object.assign(overrides, {
		HOME: join(agentDir, "home"), USERPROFILE: join(agentDir, "home"),
		XDG_CONFIG_HOME: join(agentDir, "config"), XDG_DATA_HOME: join(agentDir, "data"),
		TMP: join(agentDir, "tmp"), TEMP: join(agentDir, "tmp"),
		MAGIC_CONTEXT_STORAGE_DIR: join(agentDir, "data", "cortexkit", "magic-context"),
		MAGIC_CONTEXT_LOG_PATH: join(agentDir, "magic.log"), MAGIC_CONTEXT_LOG_SYNC: "1",
		MAGIC_CONTEXT_TEST_DATA_DIR: undefined, MAGIC_CONTEXT_PI_SUBAGENT: "0",
	});
	const previousEnv = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
	const requests: any[] = [];
	const notifications: string[] = [];
	const errors: string[] = [];
	const usageParents: { leafType: string; matchesLastInput: boolean }[] = [];
	const magicTools = new Map<string, any>();
	let session: any;
	let magicContext: any;
	try {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		if (magicEntry) {
			for (const folder of ["home", "tmp", "config/cortexkit"]) await mkdir(join(agentDir, folder), { recursive: true });
			await writeFile(join(agentDir, "config/cortexkit/magic-context.jsonc"), JSON.stringify({
				enabled: true, compaction: { enabled: true }, historian: { disable: true },
				dreamer: { disable: true, inject_docs: false }, embedding: { provider: "off" },
				smart_notes: { enabled: false }, memory: { enabled: true, auto_promote: false, auto_search: { enabled: false } },
				commit_cluster_trigger: { enabled: false }, cache_ttl: "never",
			}));
			process.chdir(agentDir);
		}
		const { STATE_DIR, STATE_PATH } = await import("../state-metadata-store.ts");
		const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
		const { default: extension } = await import("../index.ts");
		const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
		const costs = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		await mkdir(STATE_DIR, { recursive: true });
		await writeFile(MODELS_JSON_PATH, JSON.stringify({ providers: { gateway: {
			name: "Gateway", api: "openai-responses", baseUrl: "https://recovery.invalid/v1", apiKey: "fake-wire-key", piModelManager: { managed: true },
			models: [{ id: "gpt-5.2", reasoning: true, contextWindow: 128000, maxTokens: 16000, input: ["text"], cost: costs }],
		} } }));
		await writeFile(STATE_PATH, JSON.stringify({ version: 5, managedProviderIds: ["gateway"], providers: {
			gateway: { openAIResponsesAutoRecoveryEnabled: true, clientHeaderProfile: "disabled" },
		}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} }));
		globalThis.fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(new URL(request.url).hostname, "recovery.invalid", "测试禁止真实外网请求");
			requests.push(await request.json());
			if (requests.length === 1) return new Response(JSON.stringify({ error: { message: "Item with id 'rs_old' was not found", type: "invalid_request_error" } }), { status: 400, headers: { "content-type": "application/json" } });
			// [喵喵喵]: 此 mock 描述已确认支持无 ID 密文回放的网关场景，不把它当作所有 Azure 端点的契约。
			for (const item of requests.at(-1).input) {
				if (item.type === "reasoning") assert.ok(Array.isArray(item.summary));
				if (item.type === "message" && Array.isArray(item.content)
					&& item.content.some((part: any) => part.type === "output_text" || part.type === "refusal")) {
					assert.equal(item.status, "completed");
				}
			}
			return new Response(sse(requests.length), { headers: { "content-type": "text/event-stream" } });
		};
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const modelRuntime = await ModelRuntime.create({ credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} }, modelsPath: MODELS_JSON_PATH, allowModelNetwork: false, refreshOnCreate: false });
		const factories: any[] = [];
		if (magicEntry) {
			const magic = await import(pathToFileURL(magicEntry).href);
			factories.push((pi: any) => magic.default(new Proxy(pi, { get(target, key) {
				if (key === "registerTool") return (tool: any) => { magicTools.set(tool.name, tool); return target.registerTool(tool); };
				return Reflect.get(target, key);
			} })));
		}
		factories.push(extension, (pi: any) => {
			pi.on("session_start", (_event: any, ctx: any) => { magicContext = ctx; });
			pi.on("message_end", (event: any, ctx: any) => {
				if (!magicEntry || event.message.role !== "assistant" || event.message.stopReason !== "stop") return;
				const branch = ctx.sessionManager.getBranch();
				const lastInput = branch.findLast((entry: any) => entry.type === "message" && ["user", "toolResult"].includes(entry.message.role));
				const leaf = ctx.sessionManager.getEntry(ctx.sessionManager.getLeafId());
				const parent = leaf?.type === "message" && leaf.message === event.message ? ctx.sessionManager.getEntry(leaf.parentId) : leaf;
				usageParents.push({ leafType: parent?.type, matchesLastInput: parent?.id === lastInput?.id });
			});
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: agentDir, agentDir, settingsManager, extensionFactories: factories,
			noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const manager = magicEntry ? SessionManager.create(agentDir, join(agentDir, "sessions")) : SessionManager.inMemory(agentDir);
		manager.appendMessage({ role: "user", content: "earlier question", timestamp: 1 });
		manager.appendMessage({
			role: "assistant", api: "openai-responses", provider: "gateway", model: "gpt-5.2", timestamp: 2,
			content: [
				{ type: "thinking", thinking: "old summary", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_old", summary: [{ type: "summary_text", text: "old summary" }], encrypted_content: "cipher-old" }) },
				{ type: "text", text: "old reply", textSignature: JSON.stringify({ v: 1, id: "msg_old" }) },
			],
			stopReason: "stop", usage: { ...costs, totalTokens: 0, cost: { ...costs, total: 0 } },
		});
		({ session } = await createAgentSession({ cwd: agentDir, agentDir, modelRuntime, model: modelRuntime.getModel("gateway", "gpt-5.2")!, thinkingLevel: "high", resourceLoader, settingsManager, sessionManager: manager, tools: magicEntry ? ["ctx_memory", "ctx_reduce", "ctx_expand"] : [] }));
		await session.bindExtensions({ mode: "tui", uiContext: { notify: (message: string) => notifications.push(message), setStatus() {}, setWidget() {} } as any, onError: (error: any) => errors.push(error.error) });
		if (magicEntry) {
			assert.ok(session.getActiveToolNames().includes("ctx_reduce"), `必须加载完整 Magic 上下文管理，不能静默降级；${errors.join("; ")}；${await readFile(join(agentDir, "magic.log"), "utf8")}`);
			const written = await magicTools.get("ctx_memory").execute("fixture-memory", { action: "write", category: "PROJECT_RULES", content: "fixture-memory-stays" }, undefined, undefined, magicContext);
			assert.notEqual(written.isError, true, "隔离记忆必须成功写入");
		}
		await session.prompt("resume the conversation");
		assert.deepEqual(errors, []);
		assert.equal(requests.length, 2, `应自动恢复一次；通知：${notifications.join("; ")}`);
		assert.equal(session.getLastAssistantText(), "recovered");
		const expectedReasoning = { ...requests[0].input.find((item: any) => item.id === "rs_old") };
		assert.equal(expectedReasoning.encrypted_content, "cipher-old");
		delete expectedReasoning.id;
		assert.equal(requests[1].input.some((item: any) => item.id === "rs_old" || item.id === "msg_old"), false);
		assert.deepEqual(requests[1].input.find((item: any) => item.encrypted_content === "cipher-old"), expectedReasoning, "旧 reasoning 只删除 ID，摘要与密文完整保留");
		const expectedReply = { ...requests[0].input.find((item: any) => item.id === "msg_old") };
		delete expectedReply.id;
		assert.deepEqual(requests[1].input.find((item: any) => item.content?.[0]?.text === "old reply"), expectedReply, "message 旧 ID 一并剥离，不替换或改写正文");
		assert.equal(manager.getBranch().filter((entry: any) => entry.type === "custom" && entry.customType === "pi-model-manager:responses-state-recovery").length, 1);
		assert.equal(notifications.filter((message) => /自动恢复成功/.test(message)).length, 1);
		assert.ok(manager.getBranch().some((entry: any) => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "error"), "原始失败历史仍保留");
		await session.prompt("continue with the recovered reasoning");
		assert.equal(requests.length, 3, "正常下一轮不额外重试");
		assert.equal(requests[2].input.find((item: any) => item.id === "rs_new_2").encrypted_content, "cipher-new-2");
		assert.deepEqual(requests[2].input.find((item: any) => item.encrypted_content === "cipher-old"), expectedReasoning, "后续只对已报错的旧 ID 保持剥离，旧密文仍然保留");
		assert.equal(notifications.filter((message) => /自动恢复成功/.test(message)).length, 1, "正常请求不冒充一次恢复");
		assert.deepEqual(errors, []);
		if (magicEntry) {
			for (const request of requests) {
				assert.ok(JSON.stringify(request).includes("fixture-memory-stays"), "Magic 记忆注入在恢复前后必须保留");
				assert.match(JSON.stringify(request.input), /§\d+§/, "Magic 编号与上下文转换必须实际执行");
			}
			assert.deepEqual(usageParents, [{ leafType: "context_edit", matchesLastInput: false }, { leafType: "message", matchesLastInput: true }]);
			const { DatabaseSync } = await import("node:sqlite");
			const db = new DatabaseSync(join(process.env.MAGIC_CONTEXT_STORAGE_DIR!, "context.db"), { readOnly: true });
			try {
				assert.equal(db.prepare("SELECT COUNT(*) AS count FROM memories WHERE content = ?").get("fixture-memory-stays")!.count, 1);
				const meta = db.prepare("SELECT last_input_tokens FROM session_meta WHERE session_id = ?").get(manager.getSessionId());
				assert.equal(meta!.last_input_tokens, 12000, "恢复后的实测输入用量仍必须被 Magic 正常保存");
			} finally { db.close(); }
			const log = await readFile(join(agentDir, "magic.log"), "utf8");
			assert.doesNotMatch(log, /fail.closed|degrading silently|config:.*(?:invalid|parse.error)/i);
			console.info("Magic 联合验证：记忆注入、编号、旧 ID 剥离、思维链保留及常规用量保存通过；恢复回复的 LKG 父条目关联不匹配，下一正常回复恢复匹配。");
		}
	} finally {
		if (magicEntry && session) await session.extensionRunner.emit({ type: "session_shutdown" });
		session?.dispose();
		globalThis.fetch = originalFetch;
		process.chdir(originalCwd);
		for (const [key, value] of Object.entries(previousEnv)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		// [喵喵喵]: Magic 在 exit 钩子中关闭 SQLite；Windows 必须等文件句柄释放后再删除本轮临时目录。
		if (magicEntry) process.once("exit", () => rmSync(agentDir, { recursive: true, force: true }));
		else await rm(agentDir, { recursive: true, force: true });
	}
});
