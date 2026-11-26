// thinkingLevelMap 的协议默认值与持久化归一化。

import type { ApiKind, ThinkingLevelMap } from "../types.ts";

const EXTENDED_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	xhigh: "xhigh",
	max: "max",
};

const OPENAI_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: null,
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

// 预算制模型保留原生档位与 token 预算规则。
const GOOGLE_BUDGET_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

export function usesGoogleThinkingLevel(modelId: string): boolean {
	const id = modelId.toLowerCase();
	const major = Number(id.match(/gemini(?:-live)?-(\d+)/)?.[1] ?? 0);
	// [喵喵喵]: 与 Pi 的 Google wire-format 分类一致；只区分等级制/预算制，不判断各模型支持哪些档位。
	return /gemini-3(?:\.\d+)?-(?:pro|flash)/.test(id)
		|| major >= 4
		|| id === "gemini-flash-latest"
		|| id === "gemini-flash-lite-latest"
		|| /gemma-?4/.test(id);
}

function isLegacyShiftedMaxLadder(map: ThinkingLevelMap): boolean {
	return map.minimal === "low"
		&& map.low === "medium"
		&& map.medium === "high"
		&& map.high === "xhigh"
		&& map.xhigh === "max"
		&& map.max === undefined;
}

function buildThinkingLevelMap(api: ApiKind, reasoning: boolean, modelId: string): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	if (api === "google-generative-ai") {
		return {
			...GOOGLE_BUDGET_THINKING_LEVEL_MAP,
			...(usesGoogleThinkingLevel(modelId) ? EXTENDED_THINKING_LEVEL_MAP : {}),
		};
	}
	if (api === "openai-completions" || api === "openai-responses") return { ...OPENAI_THINKING_LEVEL_MAP };
	return { ...EXTENDED_THINKING_LEVEL_MAP };
}

function mergeThinkingLevelMap(
	defaultMap: ThinkingLevelMap | undefined,
	storedMap: ThinkingLevelMap | undefined,
): ThinkingLevelMap | undefined {
	const merged = { ...(defaultMap ?? {}), ...(storedMap ?? {}) };
	return Object.keys(merged).length > 0 ? merged : undefined;
}

export function normalizeThinkingLevelMap(
	api: ApiKind,
	reasoning: boolean,
	storedMap: ThinkingLevelMap | undefined,
	modelId: string,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const defaultMap = buildThinkingLevelMap(api, true, modelId);
	if (storedMap && isLegacyShiftedMaxLadder(storedMap)) return defaultMap;
	return mergeThinkingLevelMap(defaultMap, storedMap);
}
