import assert from "node:assert/strict";
import test from "node:test";
import { synchronizeModelMetadata } from "../model-metadata.ts";
import { createModelDraftFromStoredModel } from "../state-document.ts";
import type { StoredModel, StoredProvider } from "../types.ts";

function createDraft() {
	const model: StoredModel = {
		id: "gpt-5.4",
		reasoning: false,
		input: ["text"],
		contextWindow: 1_000,
		maxTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	const provider: StoredProvider = {
		name: "OpenAI",
		api: "openai-responses",
		baseUrl: "https://api.openai.com/v1",
		managed: true,
		clientHeaderProfile: "recommended",
		models: [model],
	};
	return createModelDraftFromStoredModel("openai", provider, model);
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

test("models.dev 同步上下文、输出、输入、推理等级和每百万 token 费用", async () => {
	const draft = createDraft();
	assert.equal(draft.metadataSource, "models.dev");
	await synchronizeModelMetadata(draft, async (input) => {
		assert.equal(String(input), "https://models.dev/api.json");
		return jsonResponse({
			openai: {
				models: {
					"gpt-5.4": {
						id: "gpt-5.4",
						reasoning: true,
						reasoning_options: [
							{ type: "effort", values: ["low", "medium", "high", "xhigh"] },
						],
						modalities: { input: ["text", "image"] },
						limit: { context: 1_050_000, output: 128_000 },
						cost: { input: 2.5, output: 15, cache_read: 0.25, cache_write: 3 },
					},
				},
			},
		});
	});

	assert.deepEqual(draft.inputKinds, ["text", "image"]);
	assert.equal(draft.reasoningMode, "enabled");
	assert.equal(draft.contextWindow, 1_050_000);
	assert.equal(draft.maxTokens, 128_000);
	assert.deepEqual(draft.cost, {
		input: 2.5,
		output: 15,
		cacheRead: 0.25,
		cacheWrite: 3,
	});
	assert.equal(draft.thinkingLevelMap?.low, "low");
	assert.equal(draft.thinkingLevelMap?.xhigh, "xhigh");
	assert.equal(draft.thinkingLevelMap?.max, null);
});

test("OpenRouter 将每 token 价格换算成每百万 token，并保留缺失的输出上限", async () => {
	const draft = createDraft();
	draft.modelId = "openai/gpt-5.4";
	draft.metadataSource = "openrouter";
	await synchronizeModelMetadata(draft, async (input) => {
		assert.equal(String(input), "https://openrouter.ai/api/v1/models");
		return jsonResponse({
			data: [
				{
					id: "openai/gpt-5.4",
					context_length: 400_000,
					top_provider: {},
					architecture: { input_modalities: ["text"] },
					reasoning: { supported_efforts: ["low", "high"], mandatory: false },
					pricing: {
						prompt: "0.000002",
						completion: "0.00001",
						input_cache_read: "0.0000002",
					},
				},
			],
		});
	});

	assert.equal(draft.contextWindow, 400_000);
	assert.equal(draft.maxTokens, 100);
	assert.deepEqual(draft.cost, {
		input: 2,
		output: 10,
		cacheRead: 0.2,
		cacheWrite: 0,
	});
	assert.equal(draft.thinkingLevelMap?.off, "none");
	assert.equal(draft.thinkingLevelMap?.high, "high");
});

test("手工模式不请求远端且保留全部字段", async () => {
	const draft = createDraft();
	draft.metadataSource = "manual";
	const before = structuredClone(draft);
	await synchronizeModelMetadata(draft, async () => {
		throw new Error("should not fetch");
	});
	assert.deepEqual(draft, before);
});
