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
