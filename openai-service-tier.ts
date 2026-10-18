// openai-service-tier.ts
//
// 模型级 OpenAI Responses service_tier 注入。

import type { StateDocument } from "./types.ts";

type ActiveModelRef = {
	provider: string;
	id: string;
	api: string;
};

type PayloadRecord = Record<string, unknown>;

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return typeof payload === "object" && payload !== null && !Array.isArray(payload);
}

export function injectOpenAIServiceTier(
	payload: unknown,
	model: ActiveModelRef | undefined,
	state: StateDocument,
): PayloadRecord | undefined {
	if (!model || model.api !== "openai-responses") return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== model.id) return undefined;
	// [喵喵喵]: 调用方的显式档位保持优先；默认档只是不注入，不强制改写上游策略。
	if ("service_tier" in payload) return undefined;

	const storedModel = state.providers[model.provider]?.models.find((candidate) => candidate.id === model.id);
	const tier = storedModel?.openAIServiceTier;
	if (tier !== "priority" && tier !== "ultrafast") return undefined;

	return {
		...payload,
		service_tier: tier,
	};
}
