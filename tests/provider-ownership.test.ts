import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const agentDir = join(tmpdir(), `pi-model-manager-ownership-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

const {
	createEmptyMetadata,
	readMetadataStateSnapshot,
	serializeMetadataState,
	STATE_DIR,
	STATE_PATH,
} = await import("../state-metadata-store.ts");
const { buildStateDocumentFromModelsJson } = await import("../state-store.ts");
const {
	createProviderDraft,
	createProviderDraftFromStored,
	upsertProviderInDocument,
	upsertRequestHeaderProfileInDocument,
} = await import("../state-document.ts");

beforeEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(STATE_DIR, { recursive: true });
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

const externalModels = {
	providers: {
		external: {
			name: "External",
			api: "openai-completions",
			baseUrl: "https://external.test/v1",
			models: [{
				id: "external-model",
				headers: { "user-agent": "native-client", "x-native": "keep" },
			}],
		},
	},
};

test("没有插件 Metadata 的原生 Provider 保持未管理且保留原生 Header", async () => {
	const state = await buildStateDocumentFromModelsJson(externalModels, createEmptyMetadata());
	const provider = state.providers.external!;
	assert.equal(provider.managed, false);
	assert.equal(provider.clientHeaderProfile, "disabled");
	assert.deepEqual(provider.models[0]!.headers, {
		"user-agent": "native-client",
		"x-native": "keep",
	});
	assert.deepEqual(state.managedProviderIds, []);
});

test("v2 Metadata 迁移会从已有 Provider Metadata 推断受管理集合", async () => {
	await writeFile(STATE_PATH, `${JSON.stringify({
		version: 2,
		providers: { external: { clientHeaderProfile: "disabled" } },
		models: {},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	}, null, 2)}\n`, "utf8");
	const snapshot = await readMetadataStateSnapshot();
	assert.deepEqual(snapshot.metadata.managedProviderIds, ["external"]);

	const state = await buildStateDocumentFromModelsJson(externalModels, snapshot.metadata);
	assert.equal(state.providers.external!.managed, true);
});

test("v4 所有权标记阻止陈旧 Provider ID 接管同名原生配置", async () => {
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = ["external"];
	const reusedState = await buildStateDocumentFromModelsJson(externalModels, metadata, true);
	assert.deepEqual(reusedState.managedProviderIds, []);
	assert.equal(reusedState.providers.external!.managed, false);

	reusedState.managedProviderIds = ["missing", "external"];
	const serialized = JSON.parse(serializeMetadataState(reusedState));
	assert.deepEqual(serialized.managedProviderIds, []);

	const markedModels = structuredClone(externalModels) as typeof externalModels & {
		providers: { external: typeof externalModels.providers.external & { piModelManager: { managed: true } } };
	};
	markedModels.providers.external.piModelManager = { managed: true };
	const managedState = await buildStateDocumentFromModelsJson(markedModels, metadata, true);
	assert.equal(managedState.providers.external!.managed, true);
	assert.deepEqual(managedState.managedProviderIds, ["external"]);
});

test("v2 Metadata 也会从 Model Metadata 键恢复 Provider 所有权", async () => {
	await writeFile(STATE_PATH, `${JSON.stringify({
		version: 2,
		providers: {},
		models: { "external/external-model": { openAIServiceTier: "priority" } },
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	}, null, 2)}\n`, "utf8");
	const snapshot = await readMetadataStateSnapshot();
	assert.deepEqual(snapshot.metadata.managedProviderIds, ["external"]);
});

test("请求头 Profile 重命名只传播到受管理 Provider", () => {
	const provider = {
		name: "Provider",
		api: "openai-completions" as const,
		baseUrl: "https://example.test/v1",
		managed: true,
		clientHeaderProfile: "custom" as const,
		requestHeaderProfileId: "old-profile",
		models: [],
	};
	const unmanagedProvider = {
		...provider,
		managed: false,
	};
	const state = {
		version: 2 as const,
		providers: { managed: provider, external: unmanagedProvider },
		managedProviderIds: ["managed"],
		requestHeaderProfiles: {
			"old-profile": { name: "Old", headers: { "x-client": "one" } },
		},
		clientHeaderCaptures: {},
	};
	const renamed = upsertRequestHeaderProfileInDocument(state, "old-profile", {
		profileId: "new-profile",
		profileName: "New",
		headers: { "x-client": "two" },
		selectedIndex: 0,
	});

	assert.equal(renamed.providers.managed!.requestHeaderProfileId, "new-profile");
	assert.equal(renamed.providers.external!.requestHeaderProfileId, "old-profile");
});

test("显式保存 Provider 会记录所有权", () => {
	const state = {
		version: 2 as const,
		providers: {},
		managedProviderIds: [],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	const draft = createProviderDraft();
	draft.providerId = "managed";
	const next = upsertProviderInDocument(state, undefined, draft);
	assert.equal(next.providers.managed!.managed, true);
	assert.deepEqual(next.managedProviderIds, ["managed"]);
});

test("Chat 协议兼容仅在兼容模式覆盖 supportsDeveloperRole 并保留其它 compat", () => {
	const state = {
		version: 2 as const,
		providers: {
			gateway: {
				name: "Gateway",
				api: "openai-completions" as const,
				baseUrl: "https://gateway.example.test/v1",
				managed: true,
				clientHeaderProfile: "recommended" as const,
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
				models: [],
			},
		},
		managedProviderIds: ["gateway"],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	const compatibleDraft = createProviderDraftFromStored("gateway", state.providers.gateway);
	assert.equal(compatibleDraft.openAIChatCompatibilityMode, "compatible");

	compatibleDraft.openAIChatCompatibilityMode = "standard";
	const standard = upsertProviderInDocument(state, "gateway", compatibleDraft);
	assert.deepEqual(standard.providers.gateway!.compat, {
		supportsReasoningEffort: true,
	});
	assert.equal(createProviderDraftFromStored("gateway", standard.providers.gateway!).openAIChatCompatibilityMode, "standard");
});


test("Responses 流结束兼容只写入插件 Metadata 并可恢复", async () => {
	const state = {
		version: 2 as const,
		providers: {
			gateway: {
				name: "Gateway",
				api: "openai-responses" as const,
				baseUrl: "https://gateway.example.test/v1",
				managed: true,
				clientHeaderProfile: "recommended" as const,
				openAIResponsesStreamCompletionMode: "terminal-event" as const,
				models: [],
			},
		},
		managedProviderIds: ["gateway"],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	const serialized = JSON.parse(serializeMetadataState(state));
	assert.equal(serialized.providers.gateway.openAIResponsesStreamCompletionMode, "terminal-event");

	await writeFile(STATE_PATH, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
	const metadata = await readMetadataStateSnapshot();
	const nativeModels = {
		providers: {
			gateway: {
				name: "Gateway",
				api: "openai-responses",
				baseUrl: "https://gateway.example.test/v1",
				piModelManager: { managed: true },
				models: [{ id: "model" }],
			},
		},
	};
	const restored = await buildStateDocumentFromModelsJson(nativeModels, metadata.metadata, true);
	assert.equal(restored.providers.gateway!.openAIResponsesStreamCompletionMode, "terminal-event");
	assert.equal((nativeModels.providers.gateway as Record<string, unknown>).openAIResponsesStreamCompletionMode, undefined);
});


test("读回时剥离与接入级同名同值的继承请求头，保留模型独有头", async () => {
	const models = {
		providers: {
			stripme: {
				name: "Strip Me",
				api: "openai-completions",
				baseUrl: "https://strip.test/v1",
				headers: { "X-Shared": "1", "x-case-insensitive": "a" },
				models: [{
					id: "m1",
					headers: { "X-Shared": "1", "X-Model-Only": "2", "x-CASE-INSensitive": "a" },
				}],
			},
		},
	};
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = ["stripme"];
	const state = await buildStateDocumentFromModelsJson(models, metadata);
	const headers = state.providers.stripme!.models[0]!.headers!;
	assert.equal(headers["X-Shared"], undefined, "与接入级同名同值的头应被剥离");
	assert.equal(headers["x-case-insensitive"], undefined, "头名比对应大小写不敏感");
	assert.equal(headers["X-Model-Only"], "2", "模型独有头必须保留");
});

test("接入级请求头往返后重新写回模型条目（写回合并语义不变）", async () => {
	const { buildSynchronizedModelsDocument } = await import("../models-json-sync.ts");
	const models = {
		providers: {
			syncme: {
				name: "Sync Me",
				api: "openai-completions",
				baseUrl: "https://sync.test/v1",
				headers: { "X-Shared": "1" },
				models: [{
					id: "m1",
					headers: { "X-Shared": "1", "X-Model-Only": "2" },
				}],
			},
		},
	};
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = ["syncme"];
	const state = await buildStateDocumentFromModelsJson(models, metadata);
	// 读回后模型内部态已剥离继承头，但同步写回时必须重新合并，保证文件语义不丢失
	const synced = buildSynchronizedModelsDocument(state, models, [], []);
	const syncedModel = synced.providers.syncme!.models.find((m: { id: string }) => m.id === "m1")!;
	assert.equal(syncedModel.headers!["X-Shared"], "1");
	assert.equal(syncedModel.headers!["X-Model-Only"], "2");
});
