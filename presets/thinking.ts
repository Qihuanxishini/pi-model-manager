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

// Google 的 xhigh/max 默认关闭，具体模型可通过显式映射启用。
const GOOGLE_GENERATIVE_AI_THINKING_LEVEL_MAP: ThinkingLevelMap = {
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: null,
	max: null,
};

function isLegacyShiftedMaxLadder(map: ThinkingLevelMap): boolean {
	return map.minimal === "low"
		&& map.low === "medium"
		&& map.medium === "high"
		&& map.high === "xhigh"
		&& map.xhigh === "max"
		&& map.max === undefined;
}

function buildThinkingLevelMap(api: ApiKind, reasoning: boolean): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	if (api === "google-generative-ai") return { ...GOOGLE_GENERATIVE_AI_THINKING_LEVEL_MAP };
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
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const defaultMap = buildThinkingLevelMap(api, true);
	if (storedMap && isLegacyShiftedMaxLadder(storedMap)) return defaultMap;
	return mergeThinkingLevelMap(defaultMap, storedMap);
}
