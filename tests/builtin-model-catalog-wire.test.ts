import assert from "node:assert/strict";
import test from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getBuiltinProviderDefaults, getBuiltinProviderIds, isBuiltinProviderId } from "../builtin-model-catalog.ts";
import { createProviderDraft, validateProviderDraft } from "../state-document.ts";
import { reconcileProvider } from "../provider-registrar.ts";
import type { StateDocument } from "../types.ts";

const realRuntime = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";

test("真实 Pi：完整接入目录保护仅有分类器的接入，聊天默认值仍来自聊天模型", { skip: !realRuntime, timeout: 15_000 }, async () => {
	const runtime = await ModelRuntime.create({
		credentials: { async read() {}, async list() { return []; }, async modify() {}, async delete() {} },
		modelsPath: null,
		allowModelNetwork: false,
	});
	assert.ok(runtime.getProvider("typesafe"));
	assert.equal(runtime.getModels("typesafe").length, 0);
	const ids = await getBuiltinProviderIds();
	assert.deepEqual(ids, new Set(runtime.getProviders().map((provider) => provider.id)));
	assert.equal(await isBuiltinProviderId("typesafe"), true);
	assert.equal(await getBuiltinProviderDefaults("typesafe"), undefined);
	const chatModel = runtime.getModels("anthropic")[0]!;
	assert.ok(chatModel);
	assert.deepEqual(await getBuiltinProviderDefaults("anthropic"), { api: chatModel.api, baseUrl: chatModel.baseUrl });
	assert.equal(await isBuiltinProviderId("catalog-fixture"), false);

	const state: StateDocument = { version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} };
	const draft = createProviderDraft();
	draft.providerId = "catalog-fixture";
	assert.deepEqual(validateProviderDraft(draft, state, ids), []);
	draft.providerId = "typesafe";
	assert.equal(validateProviderDraft(draft, state, ids).length, 1);

	await reconcileProvider({
		registerProvider() { assert.fail("内置接入不应被动态注册覆盖"); },
		unregisterProvider() { assert.fail("内置接入不应被注销"); },
	} as any, "typesafe", {
		name: "Catalog fixture", api: "openai-responses", baseUrl: "https://gateway.invalid/v1",
		managed: true, clientHeaderProfile: "disabled", models: [{ id: "fixture" }],
	});
});
