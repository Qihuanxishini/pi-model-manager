import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test, { after } from "node:test";
import { Key } from "@earendil-works/pi-tui";

const agentDir = await mkdtemp(resolve(".test-responses-recovery-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { STATE_DIR, STATE_PATH, serializeMetadataState } = await import("../state-metadata-store.ts");
const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { readState } = await import("../state-store.ts");
const { invalidateStateCache } = await import("../state-cache.ts");
const { createRequestPipeline } = await import("../request-pipeline.ts");
const { createProviderDraft, createProviderDraftFromStored, upsertProviderInDocument } = await import("../state-document.ts");
const { editProvider } = await import("../tui/editor-provider.ts");
after(async () => { await rm(agentDir, { recursive: true, force: true }); });

async function seed(enabled = true) {
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(MODELS_JSON_PATH, JSON.stringify({ providers: { gateway: {
		api: "openai-responses", baseUrl: "https://recovery.invalid/v1", piModelManager: { managed: true },
		models: [{ id: "gpt-5.2" }, { id: "unaffected" }],
	} } }));
	await writeFile(STATE_PATH, JSON.stringify({ version: 5, managedProviderIds: ["gateway"], providers: {
		gateway: { openAIResponsesAutoRecoveryEnabled: enabled },
	}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} }));
	invalidateStateCache();
}

function harness() {
	const branch: any[] = [];
	const notifications: { message: string; level: string }[] = [];
	const ctx = {
		model: { provider: "gateway", id: "gpt-5.2", api: "openai-responses", baseUrl: "https://recovery.invalid/v1" },
		hasUI: true,
		ui: { notify(message: string, level: string) { notifications.push({ message, level }); } },
		sessionManager: { getBranch: () => branch, getSessionId: () => "session-fixture" },
	} as any;
	return { branch, notifications, ctx, pipeline: createRequestPipeline() };
}

function payload() {
	return {
		model: "gpt-5.2", instructions: "rules", service_tier: "auto", reasoning: { effort: "high" },
		include: ["reasoning.encrypted_content"], previous_response_id: "resp_old",
		input: [
			{ role: "user", content: "keep user text" },
			{ type: "reasoning", id: "rs_old", summary: [{ type: "summary_text", text: "keep summary" }], content: [{ type: "reasoning_text", text: "prefer summary" }], encrypted_content: "cipher-old" },
			{ type: "message", role: "assistant", id: "msg_old", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "keep reply", annotations: [] }, { type: "refusal", refusal: "keep refusal" }] },
			{ type: "function_call", id: "fc_old", call_id: "call_keep", name: "lookup", arguments: '{"id":"business-id","encrypted_content":"business-value"}' },
			{ type: "function_call_output", call_id: "call_keep", output: "keep result" },
			{ type: "message", role: "assistant", id: "msg_pi_0", status: "completed", content: [{ type: "output_text", text: "local fallback", annotations: [] }] },
			{ type: "reasoning", id: "rs_empty", summary: [], encrypted_content: "cipher-empty" },
			{ type: "reasoning", id: "rs_content", summary: [], content: [{ type: "reasoning_text", text: "keep readable reasoning" }], encrypted_content: "cipher-content" },
		],
	};
}

function failed(message = "400 The requested item was created under a different Azure OpenAI resource.") {
	const assistant = {
		role: "assistant", api: "openai-responses", provider: "gateway", model: "gpt-5.2",
		content: [], stopReason: "error", errorMessage: message, timestamp: 2,
	};
	return {
		type: "agent_before_settle", outcome: "error", entries: [], continue: false,
		context: {
			canContinue: false, pendingMessages: [],
			contextEntries: [{ sourceEntry: { id: "failed-entry" }, messages: [assistant] }],
			contextMessages: [assistant], llmMessages: [{ role: "user", content: "resume" }, assistant],
		},
	} as any;
}

function commit(h: ReturnType<typeof harness>, result: any) {
	for (const entry of result.entries) h.branch.push({ ...entry, id: `entry-${h.branch.length}` });
}

function response(stopReason = "stop") {
	return { message: { role: "assistant", provider: "gateway", model: "gpt-5.2", api: "openai-responses", stopReason } } as any;
}

test("报错前不改写，报错后仅剥离旧 item ID，完整保留思维链、密文及工具配对；记录可重载且按分支和模型隔离", async () => {
	await seed();
	const h = harness();
	const original = payload();
	const untouched = structuredClone(original);
	assert.equal(await h.pipeline.transform(original, h.ctx), undefined);
	const previousEntry = { type: "custom", customType: "fixture:previous-extension", data: { preserved: true } };
	const boundary = failed();
	boundary.entries = [previousEntry];
	const result = await h.pipeline.recover(boundary, h.ctx);
	assert.equal(result?.entries?.[0], previousEntry, "必须保留前序扩展已提出的条目及顺序");
	assert.deepEqual(boundary.entries, [previousEntry], "不能原地改写宿主传入的提案列表");
	assert.equal(result?.continue, true, "错误 assistant 尚未省略时 canContinue=false 不能阻止恢复");
	assert.deepEqual(result?.entries?.at(-1), { type: "context_edit", targetId: "failed-entry", replacement: null });
	assert.equal(JSON.stringify(result).includes("cipher-old"), false, "持久化恢复记录不保存密文");
	commit(h, result);
	const transformed = await h.pipeline.transform(original, h.ctx) as any;
	const expectedInput = structuredClone(original.input);
	for (const index of [1, 2, 3, 6, 7]) delete expectedInput[index]!.id;
	assert.deepEqual(transformed, { ...original, input: expectedInput }, "请求仅剥离旧服务端 item ID，不改变推理、密文、引用、正文或工具配对");
	assert.equal(transformed.input[5].id, "msg_pi_0", "本地占位 ID 不是资源绑定状态，不应被隔离");
	assert.deepEqual(original, untouched);
	h.pipeline.observeResult(response(), h.ctx);
	assert.match(h.notifications.at(-1)!.message, /自动恢复成功/);
	const next = payload();
	next.input.push({ type: "reasoning", id: "rs_new", summary: [], encrypted_content: "cipher-new" });
	const reloaded = createRequestPipeline();
	const replay = await reloaded.transform(next, h.ctx) as any;
	assert.deepEqual(replay.input.at(-1), next.input.at(-1), "新推理保持完整");
	assert.equal(replay.reasoning.effort, "high");
	assert.deepEqual(replay.include, ["reasoning.encrypted_content"]);
	assert.equal(await reloaded.transform({ ...next, model: "unaffected" }, { ...h.ctx, model: { ...h.ctx.model, id: "unaffected" } }), undefined);
	assert.equal(await reloaded.transform(next, { ...h.ctx, model: { ...h.ctx.model, baseUrl: "https://other.invalid/v1" } }), undefined);
	assert.equal(await reloaded.transform(next, { ...h.ctx, sessionManager: { ...h.ctx.sessionManager, getBranch: () => [] } }), undefined);
});

test("关闭或普通 400 不读取目标错误；只接受指定状态错误，重试失败不循环且下一轮可独立恢复并逐次提示", async () => {
	await seed(false);
	const disabled = harness();
	await disabled.pipeline.transform(payload(), disabled.ctx);
	const trapped = failed();
	Object.defineProperty(trapped.context.contextEntries[0].messages[0], "errorMessage", { get() { throw new Error("关闭时不应检测错误"); } });
	assert.equal(await disabled.pipeline.recover(trapped, disabled.ctx), undefined);
	assert.deepEqual(disabled.notifications, []);
	await seed();
	const h = harness();
	for (const error of ["400 invalid request", "401 unauthorized", "429 rate limited", "500 upstream error",
		'400 {"message":"Upstream rejected the request as invalid","type":"invalid_request_error"}',
		"400 encrypted content quota exceeded"]) {
		await h.pipeline.transform(payload(), h.ctx);
		assert.equal(await h.pipeline.recover(failed(error), h.ctx), undefined);
	}
	const recoverableErrors = [
		"Item with id 'rs_old' was not found", "Item with id 'msg_old' not found",
		"Item 'msg_old' of type 'message' was provided without its required 'reasoning' item",
		"400 encrypted content could not be verified", "invalid_encrypted_content",
		"The encrypted content gAAA...ng== could not be verified.",
		"The encrypted content 'gAAA...==' could not be decrypted.",
		"The encrypted content for item rs_old could not be verified.",
		"The encrypted content gAAA...== for item rs_old could not be decrypted.",
	];
	for (const error of recoverableErrors) {
		h.pipeline.beginActivity();
		await h.pipeline.transform(payload(), h.ctx);
		assert.equal((await h.pipeline.recover(failed(error), h.ctx))?.continue, true);
		h.pipeline.observeResult(response("error"), h.ctx);
		assert.match(h.notifications.at(-1)!.message, /重试失败/);
		assert.equal(await h.pipeline.recover(failed(error), h.ctx), undefined);
	}
	assert.equal(h.notifications.filter((item) => /重试失败/.test(item.message)).length, recoverableErrors.length);
	h.pipeline.beginActivity();
	await h.pipeline.transform(payload(), h.ctx);
	await seed(false);
	assert.equal(await h.pipeline.recover(failed(), h.ctx), undefined, "发送后关闭开关也不会启动恢复");
});

test("已产生部分输出、服务端引用、store:true 和无可剥离 ID 的请求不会自动重放；取消恢复有明确提示", async () => {
	await seed();
	const h = harness();
	await h.pipeline.transform(payload(), h.ctx);
	const partial = failed();
	partial.context.contextEntries[0].messages[0].content = [{ type: "text", text: "partial response" }];
	assert.equal(await h.pipeline.recover(partial, h.ctx), undefined);
	for (const item of [{ type: "item_reference", id: "ref_old" }, { type: "compaction", encrypted_content: "opaque" },
		{ type: "web_search_call", id: "ws_old", status: "completed" }]) {
		await h.pipeline.transform({ ...payload(), input: [item] }, h.ctx);
		assert.equal(await h.pipeline.recover(failed(), h.ctx), undefined);
	}
	await h.pipeline.transform({ ...payload(), store: true }, h.ctx);
	assert.equal(await h.pipeline.recover(failed(), h.ctx), undefined);
	await h.pipeline.transform({ ...payload(), input: [{ type: "reasoning", summary: [], encrypted_content: "cipher-only" }] }, h.ctx);
	assert.equal(await h.pipeline.recover(failed(), h.ctx), undefined, "只有密文或 response 引用、没有旧 item ID 时不进行无效重试");
	await h.pipeline.transform(payload(), h.ctx);
	await h.pipeline.recover(failed(), h.ctx);
	h.pipeline.finishActivity(true, h.ctx);
	assert.match(h.notifications.at(-1)!.message, /已取消/);
});

test("接入开关默认关闭，TUI 可切换并保存；私有配置往返保真，关闭后不保存字段", async () => {
	await seed(false);
	assert.equal(createProviderDraft().openAIResponsesAutoRecoveryEnabled, false);
	const state = await readState();
	const draft = createProviderDraftFromStored("gateway", state.providers.gateway!);
	let menu: any;
	const outcome = editProvider({ ui: { custom(factory: any) {
		return new Promise((done) => { menu = factory({ requestRender() {} }, { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text }, {}, done); });
	} } } as any, draft, "编辑接入");
	for (let index = 0; index < 5; index += 1) menu.handleInput(Key.down);
	assert.match(menu.render(100).join("\n"), /跨资源自动恢复\s+◀ 关闭 ▶/);
	menu.handleInput(Key.right);
	assert.equal(draft.openAIResponsesAutoRecoveryEnabled, true);
	assert.match(menu.render(100).join("\n"), /完整保留思维链/);
	menu.handleInput(Key.ctrl("s"));
	assert.equal((await outcome).action, "save");
	const changed = upsertProviderInDocument(state, "gateway", draft);
	const metadata = serializeMetadataState(changed);
	assert.equal(JSON.parse(metadata).providers.gateway.openAIResponsesAutoRecoveryEnabled, true);
	await writeFile(STATE_PATH, metadata);
	invalidateStateCache();
	assert.equal((await readState()).providers.gateway!.openAIResponsesAutoRecoveryEnabled, true);
	draft.openAIResponsesAutoRecoveryEnabled = false;
	assert.equal(JSON.parse(serializeMetadataState(upsertProviderInDocument(changed, "gateway", draft))).providers.gateway?.openAIResponsesAutoRecoveryEnabled, undefined);
});
