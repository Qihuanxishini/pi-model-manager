import assert from "node:assert/strict";
import test from "node:test";
import { renameModelInDoc, type ModelsJsonDocument } from "../models-json-manager.ts";
import { buildModelFromDraft, createModelDraftFromStoredModel } from "../state-document.ts";
import { createEmptyMetadata } from "../state-metadata-store.ts";
import { buildStateDocumentFromModelsJson } from "../state-store.ts";
import {
	buildModelsDocumentWithSynchronizedModel,
	buildModelsDocumentWithoutModel,
	buildSynchronizedModelsDocument,
} from "../models-json-sync.ts";
import type { StateDocument, StoredModel, StoredProvider } from "../types.ts";

function createModel(id: string, name = id): StoredModel {
	return {
		id,
		name,
		reasoning: false,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 16_384,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function createProvider(models: StoredModel[], managed = true): StoredProvider {
	return {
		name: "Managed",
		api: "openai-responses",
		baseUrl: "https://example.test/v1",
		managed,
		clientHeaderProfile: managed ? "recommended" : "disabled",
		models,
	};
}

function createState(provider: StoredProvider): StateDocument {
	return {
		version: 2,
		providers: { managed: provider },
		managedProviderIds: provider.managed ? ["managed"] : [],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
}

function createSource(): ModelsJsonDocument {
	return {
		rootExtension: { keep: true },
		providers: {
			managed: {
				name: "Raw provider name",
				baseUrl: "https://example.test/v1",
				api: "openai-responses",
				providerExtension: "keep-provider",
				models: [
					{ id: "untouched", modelExtension: { keep: "exact" } },
					{ id: "edited", name: "Before", modelExtension: "keep-model" },
				],
			},
			external: {
				baseUrl: "https://external.test/custom",
				api: "openai-completions",
				externalExtension: [1, 2, 3],
				models: [{ id: "external-model", externalModelField: "keep" }],
			},
		},
	};
}

test("Model 保存只替换目标节点并保留顺序与未知字段", () => {
	const source = createSource();
	const untouchedBefore = structuredClone(source.providers.managed!.models![0]);
	const externalBefore = structuredClone(source.providers.external);
	const state = createState(createProvider([
		createModel("untouched"),
		createModel("edited", "After"),
	]));

	const next = buildModelsDocumentWithSynchronizedModel(state, source, "managed", "edited");

	assert.deepEqual(next.providers.managed!.models![0], untouchedBefore);
	assert.equal(next.providers.managed!.models![1]!.name, "After");
	assert.equal(next.providers.managed!.models![1]!.modelExtension, "keep-model");
	assert.equal(next.providers.managed!.providerExtension, "keep-provider");
	assert.deepEqual(next.providers.external, externalBefore);
});

test("Model 重命名保留原节点未知字段且不移动列表位置", () => {
	const source = createSource();
	const renamedSource = renameModelInDoc(source, "managed", "edited", "renamed");
	const state = createState(createProvider([
		createModel("untouched"),
		createModel("renamed", "Renamed"),
	]));

	const next = buildModelsDocumentWithSynchronizedModel(
		state,
		renamedSource,
		"managed",
		"renamed",
		"edited",
	);

	assert.deepEqual(next.providers.managed!.models!.map((model) => model.id), ["untouched", "renamed"]);
	assert.equal(next.providers.managed!.models![1]!.modelExtension, "keep-model");
	assert.equal(next.providers.managed!.models![1]!.name, "Renamed");
});

test("Model 重命名保留自定义 thinkingLevelMap", () => {
	const existing: StoredModel = {
		...createModel("edited"),
		reasoning: true,
		thinkingLevelMap: { high: "custom-high", xhigh: null },
	};
	const provider = createProvider([existing]);
	const draft = createModelDraftFromStoredModel("managed", provider, existing);
	draft.modelId = "renamed";

	const renamed = buildModelFromDraft(existing, draft, provider.compat);
	assert.deepEqual(renamed.thinkingLevelMap, {
		minimal: null,
		low: "low",
		medium: "medium",
		high: "custom-high",
		xhigh: null,
		max: "max",
	});
});

test("Google 模型读取、编辑和保存保留显式 thinkingLevelMap，仅补缺项", async () => {
	const source: ModelsJsonDocument = {
		providers: {
			managed: {
				api: "google-generative-ai",
				baseUrl: "https://generativelanguage.googleapis.com/v1beta",
				models: [{ ...createModel("edited"), reasoning: true, thinkingLevelMap: { minimal: null, high: "medium", xhigh: "xhigh" } }],
			},
		},
	};
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = ["managed"];
	const expected = { minimal: null, low: "low", medium: "medium", high: "medium", xhigh: "xhigh", max: null };
	const state = await buildStateDocumentFromModelsJson(source, metadata);
	const provider = state.providers.managed!;
	const existing = provider.models[0]!;
	assert.deepEqual(existing.thinkingLevelMap, expected);

	const draft = createModelDraftFromStoredModel("managed", provider, existing);
	draft.modelName = "Edited";
	provider.models[0] = buildModelFromDraft(existing, draft, provider.compat);
	const saved = buildModelsDocumentWithSynchronizedModel(state, source, "managed", "edited");
	assert.deepEqual(saved.providers.managed!.models![0]!.thinkingLevelMap, expected);
	const reloaded = await buildStateDocumentFromModelsJson(JSON.parse(JSON.stringify(saved)), metadata);
	assert.deepEqual(reloaded.providers.managed!.models[0]!.thinkingLevelMap, expected);
});

test("Google 等级制模型的新默认开放全档位，预算制及已存显式限制保持不变", async () => {
	const { normalizeThinkingLevelMap } = await import("../presets/thinking.ts");
	const budgetMap = { minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: null, max: null };
	const levelMap = { ...budgetMap, xhigh: "xhigh", max: "max" };
	for (const id of ["gemini-3-pro-preview", "gemini-3.1-flash", "gemini-4-neon", "vendor/gemini-5-next", "gemini-flash-latest", "gemma-4-model"]) {
		assert.deepEqual(normalizeThinkingLevelMap("google-generative-ai", true, undefined, id), levelMap, id);
		assert.deepEqual(normalizeThinkingLevelMap("google-generative-ai", true, budgetMap, id), budgetMap, "不自动迁移存量限制");
	}
	for (const id of ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite", "custom-model"]) {
		assert.deepEqual(normalizeThinkingLevelMap("google-generative-ai", true, undefined, id), budgetMap, id);
	}
	const source: ModelsJsonDocument = { providers: { managed: {
		api: "google-generative-ai", baseUrl: "https://gateway.invalid/v1beta",
		models: [{ ...createModel("gemini-4-neon"), reasoning: true }],
	} } };
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = ["managed"];
	const state = await buildStateDocumentFromModelsJson(source, metadata);
	const provider = state.providers.managed!;
	const draft = createModelDraftFromStoredModel("managed", provider, provider.models[0]!);
	provider.models[0] = buildModelFromDraft(provider.models[0], draft, provider.compat);
	const saved = buildModelsDocumentWithSynchronizedModel(state, source, "managed", draft.modelId);
	assert.deepEqual(saved.providers.managed!.models![0]!.thinkingLevelMap, levelMap);
	const reloaded = await buildStateDocumentFromModelsJson(saved, metadata);
	assert.deepEqual(reloaded.providers.managed!.models[0]!.thinkingLevelMap, levelMap);
});

test("Model 删除只删除目标节点，最后一个 Model 删除时才移除 Provider", () => {
	const source = createSource();
	const stateWithProvider = createState(createProvider([createModel("untouched")]));
	const withOneModel = buildModelsDocumentWithoutModel(stateWithProvider, source, "managed", "edited");
	assert.deepEqual(withOneModel.providers.managed!.models, [source.providers.managed!.models![0]]);
	assert.ok(withOneModel.providers.managed);

	const stateWithoutProvider: StateDocument = {
		...stateWithProvider,
		providers: {},
		managedProviderIds: [],
	};
	const withoutProvider = buildModelsDocumentWithoutModel(stateWithoutProvider, source, "managed", "edited");
	assert.equal(withoutProvider.providers.managed, undefined);
	assert.deepEqual(withoutProvider.providers.external, source.providers.external);
});

test("Provider 级同步不改写未列入目标集合的原生 Provider", () => {
	const source = createSource();
	const externalBefore = structuredClone(source.providers.external);
	const state = createState(createProvider([
		createModel("untouched"),
		createModel("edited", "After"),
	]));

	const next = buildSynchronizedModelsDocument(state, source, [], ["managed"]);
	assert.deepEqual(next.providers.external, externalBefore);
});
