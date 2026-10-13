import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { StateDocument, StoredProvider } from "../types.ts";

const agentDir = await mkdtemp(resolve(".test-endpoint-migration-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { STATE_DIR, STATE_PATH, serializeMetadataState } = await import("../state-metadata-store.ts");
const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { readState, buildStateDocumentFromModelsJson } = await import("../state-store.ts");
const { buildSynchronizedModelsDocument } = await import("../models-json-sync.ts");
const { migrateManagedEndpointConfiguration, persistManagedConfiguration } = await import("../configuration-persistence.ts");
const { createProviderDraftFromStored, upsertProviderInDocument } = await import("../state-document.ts");
const { appendUrlPath, resolveRuntimeBaseUrl } = await import("../runtime-base-url.ts");

beforeEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(STATE_DIR, { recursive: true });
});
after(async () => { await rm(agentDir, { recursive: true, force: true }); });
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function fixture() {
	const models = {
		rootExtension: "preserve",
		providers: {
			anthropic: {
				api: "anthropic-messages", baseUrl: "https://gateway.test/anthropic", piModelManager: { managed: true }, providerExtension: "preserve",
				models: [
					{ id: "inherited", headers: { "x-custom": "keep" }, modelExtension: 1 },
					{ id: "own-root", baseUrl: "https://other.test/custom/v1", modelExtension: 2 },
					{ id: "responses", api: "openai-responses", modelExtension: 3 },
				],
			},
			mixed: {
				api: "openai-completions", baseUrl: "https://gateway.test/gateway/v1", piModelManager: { managed: true },
				models: [{ id: "chat" }, { id: "claude", api: "anthropic-messages" }],
			},
			external: { api: "anthropic-messages", baseUrl: "https://external.test/v1", models: [{ id: "external", unknown: true }] },
		},
	};
	const metadata = { version: 4, managedProviderIds: ["anthropic", "mixed", "external"], providers: { anthropic: { clientHeaderProfile: "disabled" }, mixed: { clientHeaderProfile: "disabled" } }, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} };
	return { models, metadata };
}

test("旧 Anthropic 路径、独立端点和混合协议在 v5 迁移后保真，且备份完整、迁移幂等", async () => {
	const { models, metadata } = fixture();
	const modelsSource = json(models);
	const metadataSource = json(metadata);
	await writeFile(MODELS_JSON_PATH, modelsSource);
	await writeFile(STATE_PATH, metadataSource);
	const before = await readState();
	assert.equal(before.providers.anthropic!.baseUrl, "https://gateway.test/anthropic/v1");
	assert.equal(before.providers.anthropic!.models[1]!.baseUrl, "https://other.test/custom/v1");
	assert.equal(before.providers.anthropic!.models[2]!.baseUrl, "https://gateway.test/anthropic");
	assert.equal(before.providers.mixed!.models[1]!.baseUrl, "https://gateway.test/gateway/v1/v1");
	assert.equal(before.providers.external!.managed, false);

	assert.equal(await migrateManagedEndpointConfiguration(), true);
	const afterState = await readState();
	assert.deepEqual(afterState, before);
	const savedSource = await readFile(MODELS_JSON_PATH, "utf8");
	const saved = JSON.parse(savedSource);
	assert.equal(saved.providers.anthropic.baseUrl, "https://gateway.test/anthropic");
	assert.equal(saved.providers.anthropic.models[1].baseUrl, "https://other.test/custom");
	assert.equal(saved.providers.anthropic.models[2].baseUrl, "https://gateway.test/anthropic");
	assert.equal(saved.providers.mixed.models[1].baseUrl, "https://gateway.test/gateway/v1");
	assert.deepEqual(saved.providers.external, models.providers.external);
	assert.equal(saved.providers.anthropic.models[1].modelExtension, 2);
	assert.equal(saved.rootExtension, "preserve");
	const savedMetadata = await readFile(STATE_PATH, "utf8");
	assert.equal(JSON.parse(savedMetadata).version, 5);
	const backups = (await readdir(STATE_DIR)).filter((name) => name.startsWith("base-url-v5-"));
	assert.equal(backups.length, 1);
	const backup = JSON.parse(await readFile(join(STATE_DIR, backups[0]!), "utf8"));
	assert.equal(backup.modelsJson.oldSource, modelsSource);
	assert.equal(backup.metadataState.oldSource, metadataSource);
	assert.equal(await migrateManagedEndpointConfiguration(), false);
	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), savedSource);
	assert.equal(await readFile(STATE_PATH, "utf8"), savedMetadata);
});

test("任意局部保存也先升级旧地址表示，再以同一事务写入 v5 元数据", async () => {
	const { models, metadata } = fixture();
	await writeFile(MODELS_JSON_PATH, json(models));
	await writeFile(STATE_PATH, json(metadata));
	const before = await readState();
	await persistManagedConfiguration({ modelRegistry: { refresh: async () => undefined } } as any, (latest) => {
		const document = structuredClone(latest);
		document.requestHeaderProfiles.new = { name: "New", headers: { "x-test": "value" } };
		return { document, changedProviderIds: [], removedProviderIds: [] };
	});
	assert.deepEqual((await readState()).providers, before.providers);
	assert.equal(JSON.parse(await readFile(STATE_PATH, "utf8")).version, 5);
});

function createState(baseUrl: string): StateDocument {
	const provider: StoredProvider = {
		name: "Managed", api: "anthropic-messages", baseUrl, managed: true, clientHeaderProfile: "disabled",
		models: [{ id: "claude", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 16000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	};
	return { version: 2, managedProviderIds: ["managed"], providers: { managed: provider }, requestHeaderProfiles: {}, clientHeaderCaptures: {} };
}

test("Anthropic API 根地址读写往返保真，标准路径原生可用，自定义路径仅增加内部标记", async () => {
	for (const root of ["https://gw.test", "https://gw.test/v1", "https://gw.test/xxx", "https://gw.test/anthropic/v1", "https://gw.test/v1/v1"]) {
		const apiRoot = resolveRuntimeBaseUrl("anthropic-messages", root);
		const state = createState(apiRoot);
		const source = buildSynchronizedModelsDocument(state, { providers: {} });
		const metadata = JSON.parse(serializeMetadataState(state));
		const loaded = await buildStateDocumentFromModelsJson(source, metadata, true);
		assert.deepEqual(loaded, state);
		assert.deepEqual(buildSynchronizedModelsDocument(loaded, source), source);
		assert.equal(serializeMetadataState(loaded), serializeMetadataState(state));
		if (metadata.providers.managed?.anthropicApiRoot) {
			assert.equal(source.providers.managed!.baseUrl, apiRoot);
		} else {
			assert.equal(appendUrlPath(source.providers.managed!.baseUrl!, "v1/messages"), appendUrlPath(apiRoot, "messages"));
		}
	}
});

test("接管原生 Anthropic 接入保留其原有聊天地址和混合协议模型", async () => {
	const source = { providers: { managed: { api: "anthropic-messages", baseUrl: "https://gw.test/tenant", models: [{ id: "claude" }, { id: "chat", api: "openai-completions" }] } } };
	const original = await buildStateDocumentFromModelsJson(source, JSON.parse(serializeMetadataState({ ...createState("unused"), providers: {}, managedProviderIds: [] })));
	const draft = createProviderDraftFromStored("managed", original.providers.managed!);
	assert.equal(draft.baseUrl, "https://gw.test/tenant/v1");
	const adopted = upsertProviderInDocument(original, undefined, draft);
	assert.equal(adopted.providers.managed!.baseUrl, "https://gw.test/tenant/v1");
	assert.equal(adopted.providers.managed!.models[1]!.baseUrl, "https://gw.test/tenant");
	const native = buildSynchronizedModelsDocument(adopted, source);
	assert.equal(native.providers.managed!.baseUrl, "https://gw.test/tenant");
	assert.equal(native.providers.managed!.models![1]!.baseUrl, "https://gw.test/tenant");
	draft.baseUrl = "https://gw.test/new-root";
	const redirected = upsertProviderInDocument(original, undefined, draft);
	assert.equal(redirected.providers.managed!.baseUrl, draft.baseUrl);
	assert.equal(redirected.providers.managed!.models[0]!.baseUrl, undefined);
	assert.equal(redirected.providers.managed!.models[1]!.baseUrl, undefined);
});

test("fromNativeBaseUrl 与 switchProviderDraftApiPreset 在非法 URL 下安全降级不崩溃", async () => {
	const { fromNativeBaseUrl } = await import("../runtime-base-url.ts");
	const { switchProviderDraftApiPreset } = await import("../presets/providers.ts");

	// fromNativeBaseUrl 遇到非标准 URL 保持原样不抛错
	assert.equal(fromNativeBaseUrl("anthropic-messages", "not-a-valid-url"), "not-a-valid-url");
	assert.equal(fromNativeBaseUrl("anthropic-messages", "$MY_GATEWAY_URL"), "$MY_GATEWAY_URL");

	// switchProviderDraftApiPreset 遇到损坏 URL 自动降级为目标协议预设地址
	const brokenDraft = {
		providerId: "test",
		providerName: "Test",
		api: "openai-completions" as const,
		baseUrl: "http://[invalid-url",
		apiKey: "$KEY",
		authHeader: false,
		clientHeaderProfile: "recommended" as const,
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "",
		selectedIndex: 0,
	};
	switchProviderDraftApiPreset(brokenDraft, "anthropic-messages");
	assert.equal(brokenDraft.api, "anthropic-messages");
	assert.equal(brokenDraft.baseUrl, "https://api.anthropic.com/v1");
});
