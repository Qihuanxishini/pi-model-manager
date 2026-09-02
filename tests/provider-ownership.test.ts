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
