import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";
import type { ModelsChangedPayload } from "../models-change-events.ts";

const agentDir = join(tmpdir(), `pi-model-manager-change-events-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { STATE_DIR, STATE_PATH } = await import("../state-metadata-store.ts");
const { persistProviderRenameConfiguration, persistManagedConfiguration } = await import("../configuration-persistence.ts");
const { setModelsChangeNotifier } = await import("../models-change-events.ts");

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

async function seedFiles(models: unknown, metadata: unknown): Promise<void> {
	await writeFile(MODELS_JSON_PATH, jsonSource(models), "utf8");
	await writeFile(STATE_PATH, jsonSource(metadata), "utf8");
}

const emptyMetadata = {
	version: 3,
	managedProviderIds: [],
	providers: {},
	models: {},
	requestHeaderProfiles: {},
	clientHeaderCaptures: {},
};

test("Provider 重命名保存后广播无 secret 的 rename 事件", async () => {
	await seedFiles({ providers: { old: { api: "openai-completions", baseUrl: "https://old.test/v1", models: [{ id: "m" }] } } }, emptyMetadata);
	const payloads: ModelsChangedPayload[] = [];
	setModelsChangeNotifier((payload) => payloads.push(payload));
	const ctx = { modelRegistry: { refresh: async () => undefined } } as any;

	await persistProviderRenameConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.providers.new = document.providers.old!;
		delete document.providers.old;
		return { document, changedProviderIds: ["new"], removedProviderIds: [] };
	}, "old", "new");

	assert.equal(payloads.length, 1);
	assert.equal(payloads[0].version, 1);
	assert.deepEqual(payloads[0].events, [{ type: "provider-rename", oldId: "old", newId: "new" }]);
	const saved = JSON.parse(await readFile(MODELS_JSON_PATH, "utf8"));
	assert.equal(saved.providers.new.baseUrl, "https://old.test/v1");
});

test("Provider 删除保存后广播 provider-delete 事件，事件负载不含配置内容", async () => {
	await seedFiles({ providers: { gone: { api: "openai-completions", baseUrl: "https://gone.test/v1", models: [] } } }, emptyMetadata);
	const payloads: ModelsChangedPayload[] = [];
	setModelsChangeNotifier((payload) => payloads.push(payload));
	const ctx = { modelRegistry: { refresh: async () => undefined } } as any;

	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		delete document.providers.gone;
		return { document, changedProviderIds: [], removedProviderIds: ["gone"] };
	});

	assert.equal(payloads.length, 1);
	assert.deepEqual(payloads[0].events, [{ type: "provider-delete", providerId: "gone" }]);
	assert.equal(JSON.stringify(payloads[0]).includes("https://gone.test"), false);
});

test("无变更事件时不广播，订阅者抛错不影响保存", async () => {
	await seedFiles({ providers: {} }, emptyMetadata);
	const payloads: ModelsChangedPayload[] = [];
	setModelsChangeNotifier(() => {
		throw new Error("subscriber failure");
	});
	const ctx = { modelRegistry: { refresh: async () => undefined } } as any;

	await persistManagedConfiguration(ctx, (latest) => {
		const document = structuredClone(latest);
		document.requestHeaderProfiles.example = { name: "Example", headers: { "x-client": "test" } };
		return { document, changedProviderIds: [], removedProviderIds: [] };
	});

	assert.equal(payloads.length, 0);
	assert.equal(JSON.parse(await readFile(STATE_PATH, "utf8")).requestHeaderProfiles.example.name, "Example");
});
