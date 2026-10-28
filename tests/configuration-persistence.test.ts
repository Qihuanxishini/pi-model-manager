import assert from "node:assert/strict";
import { access, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { StateDocument } from "../types.ts";

const agentDir = join(tmpdir(), `pi-model-manager-persistence-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { hashTextContent } = await import("../file-snapshot.ts");
const {
	persistManagedConfiguration,
	persistModelConfiguration,
	recoverPendingConfigurationTransaction,
} = await import("../configuration-persistence.ts");
const { STATE_DIR, STATE_PATH } = await import("../state-metadata-store.ts");
const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { readState } = await import("../state-store.ts");
const { findProvidersNeedingBaseUrlNormalization, normalizeProviderBaseUrlsInDocument } = await import("../state-document.ts");

const transactionPath = join(STATE_DIR, "config-transaction.json");

beforeEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(STATE_DIR, { recursive: true });
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

function jsonSource(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function transition(oldSource: string, targetSource: string) {
	return {
		oldSource,
		oldHash: hashTextContent(oldSource),
		targetSource,
		targetHash: hashTextContent(targetSource),
	};
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

test("未完成双文件事务会补齐旧版本一端并删除意图文件", async () => {
	const oldModels = jsonSource({ providers: { managed: { models: [{ id: "old" }] } } });
	const targetModels = jsonSource({ providers: { managed: { models: [{ id: "new" }] } } });
	const oldState = jsonSource({ version: 3, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const targetState = jsonSource({ version: 3, managedProviderIds: ["managed"], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const journal = {
		version: 1,
		createdAt: new Date().toISOString(),
		modelsJson: transition(oldModels, targetModels),
		metadataState: transition(oldState, targetState),
	};
	await writeFile(MODELS_JSON_PATH, targetModels, "utf8");
	await writeFile(STATE_PATH, oldState, "utf8");
	await writeFile(transactionPath, jsonSource(journal), "utf8");

	await assert.rejects(readState(), /正在事务更新/);
	assert.equal(await recoverPendingConfigurationTransaction(), true);
	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), targetModels);
	assert.equal(await readFile(STATE_PATH, "utf8"), targetState);
	assert.equal(await pathExists(transactionPath), false);
});

test("恢复遇到事务外部内容时不覆盖任一文件并保留意图", async () => {
	const expectedOldModels = jsonSource({ providers: {} });
	const externalModels = jsonSource({ providers: { external: { models: [{ id: "external" }] } } });
	const targetModels = jsonSource({ providers: { managed: { models: [{ id: "new" }] } } });
	const oldState = jsonSource({ version: 3, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const targetState = jsonSource({ version: 3, managedProviderIds: ["managed"], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	const journal = {
		version: 1,
		createdAt: new Date().toISOString(),
		modelsJson: transition(expectedOldModels, targetModels),
		metadataState: transition(oldState, targetState),
	};
	await writeFile(MODELS_JSON_PATH, externalModels, "utf8");
	await writeFile(STATE_PATH, oldState, "utf8");
	await writeFile(transactionPath, jsonSource(journal), "utf8");

	await assert.rejects(recoverPendingConfigurationTransaction(), /既不是事务旧版本，也不是目标版本/);
	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), externalModels);
	assert.equal(await readFile(STATE_PATH, "utf8"), oldState);
	assert.equal(await pathExists(transactionPath), true);
});

test("真实 Model 持久化事务只更新目标节点并刷新 registry", async () => {
	const untouchedModel = { id: "untouched", untouchedExtension: { preserve: true } };
	const models = {
		rootExtension: "preserve-root",
		providers: {
			managed: {
				name: "Managed",
				api: "openai-responses",
				baseUrl: "https://example.test/v1",
				providerExtension: "preserve-provider",
				models: [
					untouchedModel,
					{ id: "edited", name: "Before", editedExtension: "preserve-model" },
				],
			},
			external: {
				api: "openai-completions",
				baseUrl: "https://external.test/custom",
				externalExtension: true,
				models: [{ id: "external", headers: { "x-native": "keep" } }],
			},
		},
	};
	const metadata = {
		version: 3,
		managedProviderIds: ["managed"],
		providers: {},
		models: {},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	await writeFile(MODELS_JSON_PATH, jsonSource(models), "utf8");
	await writeFile(STATE_PATH, jsonSource(metadata), "utf8");

	let refreshCount = 0;
	const ctx = {
		modelRegistry: {
			refresh: async () => {
				refreshCount += 1;
			},
		},
	} as any;
	await persistModelConfiguration(ctx, (latest) => {
		assert.equal(latest.providers.managed!.managed, true);
		assert.equal(latest.providers.external!.managed, false);
		const document = structuredClone(latest);
		const edited = document.providers.managed!.models.find((model) => model.id === "edited")!;
		edited.name = "After";
		return { document, changedProviderIds: ["managed"], removedProviderIds: [] };
	}, "managed", "edited");

	const saved = JSON.parse(await readFile(MODELS_JSON_PATH, "utf8"));
	assert.deepEqual(saved.providers.managed.models[0], untouchedModel);
	assert.equal(saved.providers.managed.models[1].name, "After");
	assert.equal(saved.providers.managed.models[1].editedExtension, "preserve-model");
	assert.equal(saved.providers.managed.piModelManager.managed, true);
	assert.deepEqual(saved.providers.external, models.providers.external);
	assert.equal(saved.rootExtension, "preserve-root");
	assert.equal(refreshCount, 1);
	assert.equal(await pathExists(transactionPath), false);
});

test("仅保存 Metadata 时保持 models.json 原始文本不变", async () => {
	const modelsSource = '{"providers":{"external":{"api":"openai-completions","baseUrl":"https://external.test/v1","models":[{"id":"external"}]}}}\n\n';
	const metadata = {
		version: 3,
		managedProviderIds: [],
		providers: {},
		models: {},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	await writeFile(MODELS_JSON_PATH, modelsSource, "utf8");
	await writeFile(STATE_PATH, jsonSource(metadata), "utf8");
	const ctx = { modelRegistry: { refresh: async () => undefined } } as any;

	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.requestHeaderProfiles.example = { name: "Example", headers: { "x-client": "test" } };
		return { document, changedProviderIds: [], removedProviderIds: [] };
	});

	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), modelsSource);
});

test("v1 legacy Provider 会在任意配置保存时迁入 models.json", async () => {
	const legacyState = {
		version: 1,
		providers: {
			legacy: {
				name: "Legacy",
				api: "openai-completions",
				baseUrl: "https://legacy.test/v1",
				clientHeaderProfile: "recommended",
				models: [{
					id: "legacy-model",
					reasoning: false,
					input: ["text"],
					contextWindow: 16_000,
					maxTokens: 4_000,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				}],
			},
		},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	};
	await writeFile(MODELS_JSON_PATH, jsonSource({ providers: {} }), "utf8");
	await writeFile(STATE_PATH, jsonSource(legacyState), "utf8");
	const ctx = { modelRegistry: { refresh: async () => undefined } } as any;

	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.requestHeaderProfiles.example = { name: "Example", headers: { "x-client": "test" } };
		return { document, changedProviderIds: [], removedProviderIds: [] };
	});

	const models = JSON.parse(await readFile(MODELS_JSON_PATH, "utf8"));
	assert.equal(models.providers.legacy.models[0].id, "legacy-model");
	assert.equal(models.providers.legacy.piModelManager.managed, true);
	assert.equal(JSON.parse(await readFile(STATE_PATH, "utf8")).version, 5);
	const state = await readState();
	assert.equal(state.providers.legacy?.managed, true);
	assert.equal(state.providers.legacy?.models[0]?.id, "legacy-model");
});

test("baseUrl 迁移只挑受管理且确实需要归一化的接入", () => {
	const document = {
		providers: {
			managedStale: { api: "openai-responses", baseUrl: "https://api.deepseek.com", managed: true, models: [] },
			managedOk: { api: "openai-responses", baseUrl: "https://api.deepseek.com/v1", managed: true, models: [] },
			managedAnthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", managed: true, models: [] },
			nativeStale: { api: "openai-responses", baseUrl: "https://native.example.com", managed: false, models: [] },
		},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	} as unknown as StateDocument;

	const targets = findProvidersNeedingBaseUrlNormalization(document);
	assert.deepEqual(targets, ["managedStale", "managedAnthropic"], "只补齐受管理接入的默认 API 版本");

	const next = normalizeProviderBaseUrlsInDocument(document, targets);
	assert.equal(next.providers.managedStale!.baseUrl, "https://api.deepseek.com/v1");
	assert.equal(next.providers.managedAnthropic!.baseUrl, "https://api.anthropic.com/v1");
	assert.equal(next.providers.nativeStale!.baseUrl, "https://native.example.com", "原生接入的 baseUrl 不是本插件写的，不能代改");
	assert.equal(document.providers.managedStale!.baseUrl, "https://api.deepseek.com", "原文档必须保持不可变");

	// 迁移后重跑检测必须为空，保证不会每次启动都写盘
	assert.deepEqual(findProvidersNeedingBaseUrlNormalization(next), []);
});

test("atomicWriteText 显式传入 SECURE_FILE_MODE 时配置文件落地 0o600", async () => {
	const { atomicWriteText, SECURE_FILE_MODE } = await import("../atomic-write.ts");
	assert.equal(SECURE_FILE_MODE, 0o600);
	const testFile = join(agentDir, "secure-test.json");
	await atomicWriteText(testFile, '{"secure":true}', SECURE_FILE_MODE);
	const content = await readFile(testFile, "utf8");
	assert.equal(content, '{"secure":true}');
	if (process.platform === "win32") return;
	assert.equal((await stat(testFile)).mode & 0o777, 0o600);
});

test("atomicWriteText 未传 mode 时不强制权限，共享配置文件保持默认 umask", async () => {
	const { atomicWriteText } = await import("../atomic-write.ts");
	const testFile = join(agentDir, "shared-test.json");
	const controlFile = join(agentDir, "shared-control.json");
	await atomicWriteText(testFile, "{}");
	await writeFile(controlFile, "{}", "utf8");
	if (process.platform === "win32") return;
	const [testStats, controlStats] = await Promise.all([stat(testFile), stat(controlFile)]);
	assert.equal(testStats.mode & 0o777, controlStats.mode & 0o777);
});

test("Codex 派生字段保存回读后仍为生成值，显式同值覆盖保留且禁用时不残留身份", async () => {
	const { getClientHeadersForProfile } = await import("../presets/client-headers.ts");
	const explicitVersion = getClientHeadersForProfile("codex-cli", "openai-responses", {})!.version!;
	await writeFile(MODELS_JSON_PATH, jsonSource({ providers: { codex: {
		api: "openai-responses", baseUrl: "https://fixture.test/v1", piModelManager: { managed: true },
		models: [{ id: "provider-ua" }, { id: "model-ua" }, { id: "explicit-version" }],
	} } }));
	await writeFile(STATE_PATH, jsonSource({ version: 5, managedProviderIds: ["codex"], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} }));
	const ctx = { modelRegistry: { async refresh() {} } } as any;
	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		const provider = document.providers.codex!;
		provider.headers = { "User-Agent": "codex_exec/0.166.0" };
		provider.models[1]!.headers = { "user-agent": "codex-tui/0.167.0" };
		provider.models[2]!.headers = { Version: explicitVersion };
		return { document, changedProviderIds: ["codex"], removedProviderIds: [] };
	});
	const reloaded = (await readState()).providers.codex!;
	assert.equal(reloaded.models[0]!.headers, undefined);
	assert.deepEqual(reloaded.models[1]!.headers, { "user-agent": "codex-tui/0.167.0" });
	assert.deepEqual(reloaded.models[2]!.headers, { version: explicitVersion });
	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.providers.codex!.headers = { "user-agent": "codex_exec/0.168.0" };
		document.providers.codex!.models[1]!.headers = { "user-agent": "codex-tui/0.169.0" };
		return { document, changedProviderIds: ["codex"], removedProviderIds: [] };
	});
	const raw = JSON.parse(await readFile(MODELS_JSON_PATH, "utf8")).providers.codex.models;
	assert.equal(raw[0].headers.version, "0.168.0");
	assert.equal(raw[0].headers.originator, "codex_exec");
	assert.equal(raw[1].headers.version, "0.169.0");
	assert.equal(raw[1].headers.originator, "codex-tui");
	assert.equal(raw[2].headers.version, explicitVersion, "与旧模板同值的显式版本不能被剥离");
	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.providers.codex!.clientHeaderProfile = "disabled";
		return { document, changedProviderIds: ["codex"], removedProviderIds: [] };
	});
	const disabled = JSON.parse(await readFile(MODELS_JSON_PATH, "utf8")).providers.codex.models;
	assert.equal(disabled[0].headers.version, undefined);
	assert.equal(disabled[0].headers.originator, undefined);
	assert.equal(disabled[1].headers.version, undefined);
	assert.equal(disabled[1].headers.originator, undefined);
	assert.equal(disabled[2].headers.version, explicitVersion);
});

test("过期编辑器创建和重命名发生重名时，锁内拒绝且不覆盖双文件", async () => {
	const { createEmptyState } = await import("../state-store.ts");
	const { createProviderDraft, createModelDraftForStoredProvider } = await import("../state-document.ts");
	const { saveProviderConfiguration, saveModelConfiguration, saveNewProviderWithModelConfiguration } = await import("../model-mutations.ts");
	const { saveRequestHeaderProfileConfiguration } = await import("../header-profile-mutations.ts");
	const modelsSource = jsonSource({ providers: {
		taken: { api: "openai-responses", baseUrl: "https://fixture.test/v1", piModelManager: { managed: true }, models: [{ id: "kept" }, { id: "other" }] },
		source: { api: "openai-responses", baseUrl: "https://source.test/v1", piModelManager: { managed: true }, models: [{ id: "source-model" }] },
	} });
	const metadataSource = jsonSource({ version: 5, managedProviderIds: ["taken", "source"], providers: {}, models: {},
		requestHeaderProfiles: { taken: { name: "Kept", headers: { "x-tenant": "kept" } }, source: { name: "Source", headers: { "x-tenant": "source" } } }, clientHeaderCaptures: {} });
	await writeFile(MODELS_JSON_PATH, modelsSource);
	await writeFile(STATE_PATH, metadataSource);
	const stale = createEmptyState();
	const latest = await readState();
	const providerDraft = { ...createProviderDraft(), providerId: "taken", providerName: "Must not overwrite" };
	const modelDraft = { ...createModelDraftForStoredProvider("taken", latest.providers.taken!), modelId: "kept", modelName: "Must not overwrite" };
	const ctx = { modelRegistry: { async refresh() { assert.fail("失败保存不得刷新 registry"); } } } as any;
	const pi = { registerProvider() { assert.fail("失败保存不得注册 provider"); } } as any;
	for (const oldId of [undefined, "source"]) {
		await assert.rejects(saveProviderConfiguration(pi, ctx, stale, providerDraft, oldId), /接入 ID 已存在/);
		await assert.rejects(saveRequestHeaderProfileConfiguration(pi, ctx, stale,
			{ profileId: "taken", profileName: "Must not overwrite", headers: { "x-tenant": "changed" }, selectedIndex: 0 }, oldId), /请求头 ID 已存在/);
	}
	for (const oldId of [undefined, "other"]) {
		await assert.rejects(saveModelConfiguration(pi, ctx, stale, modelDraft, oldId), /模型已存在/);
	}
	await assert.rejects(saveNewProviderWithModelConfiguration(pi, ctx, stale, providerDraft, modelDraft), /接入 ID 已存在/);
	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), modelsSource);
	assert.equal(await readFile(STATE_PATH, "utf8"), metadataSource);
	assert.equal(await pathExists(transactionPath), false);
});

test("未列 models 的原生接入仍占用 ID，新建两种入口均拒写", async () => {
	const { createEmptyState } = await import("../state-store.ts");
	const { createProviderDraft, createModelDraftForStoredProvider } = await import("../state-document.ts");
	const { saveProviderConfiguration, saveNewProviderWithModelConfiguration } = await import("../model-mutations.ts");
	const modelsSource = jsonSource({ providers: { reserved: { headers: { "x-existing": "keep" }, modelOverrides: { original: { contextWindow: 32000 } } } } });
	const metadataSource = jsonSource({ version: 5, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	await writeFile(MODELS_JSON_PATH, modelsSource);
	await writeFile(STATE_PATH, metadataSource);
	const latest = await readState();
	assert.equal(latest.providers.reserved, undefined, "原生覆盖节点不会出现在可编辑目录");
	const draft = { ...createProviderDraft(), providerId: "reserved", baseUrl: "https://fixture.test/v1", apiKey: "fixture-key" };
	const model = { ...createModelDraftForStoredProvider("reserved", { api: draft.api, baseUrl: draft.baseUrl, managed: true, models: [] }), modelId: "new-model" };
	const ctx = { modelRegistry: { async refresh() { assert.fail("拒写不得刷新 registry"); } } } as any;
	await assert.rejects(saveProviderConfiguration({} as any, ctx, createEmptyState(), draft, undefined), /models.json 中已存在接入/);
	await assert.rejects(saveNewProviderWithModelConfiguration({} as any, ctx, createEmptyState(), draft, model), /models.json 中已存在接入/);
	assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), modelsSource);
	assert.equal(await readFile(STATE_PATH, "utf8"), metadataSource);
	assert.equal(await pathExists(transactionPath), false);
});

test("providers 类型损坏拒绝事务且保留原文，字段缺失仍允许初始化", async () => {
	const metadataSource = jsonSource({ version: 5, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} });
	await writeFile(STATE_PATH, metadataSource);
	const ctx = { modelRegistry: { async refresh() {} } } as any;
	for (const providers of [null, [{ id: "keep" }], "keep", false, 7]) {
		const source = jsonSource({ providers, rootExtension: "keep" });
		await writeFile(MODELS_JSON_PATH, source);
		await assert.rejects(persistManagedConfiguration(ctx, () => assert.fail("损坏配置不得进入 mutation")), /models.json.providers.*对象/);
		assert.equal(await readFile(MODELS_JSON_PATH, "utf8"), source);
		assert.equal(await readFile(STATE_PATH, "utf8"), metadataSource);
		assert.equal(await pathExists(transactionPath), false);
	}
	await writeFile(MODELS_JSON_PATH, jsonSource({ rootExtension: "keep" }));
	await persistManagedConfiguration(ctx, (latest) => ({ document: latest, changedProviderIds: [], removedProviderIds: [] }));
	assert.deepEqual((await readState()).providers, {});
	assert.equal(JSON.parse(await readFile(MODELS_JSON_PATH, "utf8")).rootExtension, "keep");
});
