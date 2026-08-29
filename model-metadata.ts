import { isObjectRecord } from "./common.ts";
import type { ModelDraft, ModelInputKind, ThinkingLevelMap } from "./types.ts";

const MODELS_DEV_URL = "https://models.dev/api.json";
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const METADATA_TIMEOUT_MS = 15_000;

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | undefined {
	return isObjectRecord(value) ? value : undefined;
}

function positiveIntegerOrCurrent(value: unknown, current: number): number {
	return Number.isInteger(value) && (value as number) > 0
		? (value as number)
		: current;
}

function perMillion(value: unknown, field: string, modelId: string): number {
	if (value === undefined || value === null || value === "") return 0;
	const amount = Number(value);
	if (!Number.isFinite(amount) || amount < 0)
		throw new Error(`Invalid ${field} price for ${modelId}: ${String(value)}`);
	return Number(amount.toPrecision(12));
}

function perTokenMillion(
	value: unknown,
	field: string,
	modelId: string,
): number {
	if (value === undefined || value === null || value === "") return 0;
	return perMillion(Number(value) * 1_000_000, field, modelId);
}

function supportedInput(value: unknown): ModelInputKind[] {
	const modalities = Array.isArray(value) ? value : [];
	const result = (["text", "image"] as const).filter((kind) =>
		modalities.includes(kind),
	);
	return result.length > 0 ? result : ["text"];
}

function thinkingLevelMap(
	reasoning: boolean,
	options: unknown,
	reasoningInfo?: JsonObject,
): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const entries = Array.isArray(options)
		? options
				.map(objectValue)
				.filter((entry): entry is JsonObject => Boolean(entry))
		: [];
	const effort = entries.find((entry) => entry.type === "effort");
	const supportedValues = Array.isArray(effort?.values)
		? effort.values
		: Array.isArray(reasoningInfo?.supported_efforts)
			? reasoningInfo.supported_efforts
			: [];
	const supported = new Set(
		supportedValues.filter((value): value is string => typeof value === "string"),
	);
	const levels = [
		"off",
		"minimal",
		"low",
		"medium",
		"high",
		"xhigh",
		"max",
	] as const;
	const map: ThinkingLevelMap = {};
	for (const level of levels) {
		if (level === "off") {
			const hasToggle = entries.some((entry) => entry.type === "toggle");
			map.off = reasoningInfo
				? reasoningInfo.mandatory === true
					? null
					: "none"
				: supported.has("none") || hasToggle
					? "none"
					: null;
		} else {
			map[level] = supported.has(level) ? level : null;
		}
	}
	if (!effort && entries.some((entry) => entry.type === "toggle")) {
		for (const level of levels) if (level !== "off") map[level] = "low";
		if (reasoningInfo?.mandatory === true) map.off = null;
	}
	return map;
}

function isOpenRouterProvider(draft: ModelDraft): boolean {
	const value =
		`${draft.providerId} ${draft.providerName} ${draft.baseUrl}`.toLowerCase();
	return value.includes("openrouter") || value.includes("openrouter.ai");
}

function providerCandidates(draft: ModelDraft): string[] {
	const key = `${draft.providerId} ${draft.providerName}`.toLowerCase();
	const baseUrl = draft.baseUrl.toLowerCase();
	const aliases: Record<string, string> = {
		"botcf-claude": "anthropic",
		"gpteam-claude": "anthropic",
		deepseek: "deepseek",
	};
	const candidates: string[] = [];
	const providerAlias = aliases[key.split(" ")[0] ?? ""];
	if (providerAlias) candidates.push(providerAlias);
	if (isOpenRouterProvider(draft)) candidates.push("openrouter");
	else if (key.includes("deepseek") || baseUrl.includes("deepseek.com"))
		candidates.push("deepseek");
	else if (
		key.includes("claude") ||
		key.includes("anthropic") ||
		baseUrl.includes("botcf.com")
	)
		candidates.push("anthropic");
	else if (
		key.includes("codex") ||
		key.includes("openai") ||
		baseUrl.includes("openai.com")
	)
		candidates.push("openai");
	const prefix = draft.modelId.includes("/")
		? draft.modelId.slice(0, draft.modelId.indexOf("/"))
		: "";
	if (prefix) candidates.push(prefix === "x-ai" ? "xai" : prefix);
	return [...new Set(candidates)];
}

async function fetchJson(
	url: string,
	fetchImpl: typeof globalThis.fetch,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
	});
	if (!response.ok) throw new Error(`Metadata API error (${response.status})`);
	return response.json();
}

function applyModelsDev(draft: ModelDraft, root: unknown): void {
	if (!isObjectRecord(root))
		throw new Error("models.dev response is not a provider object");
	const shortId = draft.modelId.includes("/")
		? draft.modelId.slice(draft.modelId.indexOf("/") + 1)
		: draft.modelId;
	const ids = [
		...new Set([draft.modelId, shortId, shortId.replace(/(\d)\.(\d)/g, "$1-$2")]),
	];
	let remote: JsonObject | undefined;
	for (const providerId of providerCandidates(draft)) {
		const models = objectValue(objectValue(root[providerId])?.models);
		for (const modelId of ids) {
			remote = objectValue(models?.[modelId]);
			if (remote) break;
		}
		if (remote) break;
	}
	if (!remote)
		throw new Error(
			`models.dev did not find ${draft.providerId}/${draft.modelId}`,
		);
	const modalities = objectValue(remote.modalities);
	const limit = objectValue(remote.limit);
	const pricing = objectValue(remote.cost) ?? {};
	const reasoning = remote.reasoning === true;
	draft.inputKinds = supportedInput(modalities?.input);
	draft.reasoningMode = reasoning ? "enabled" : "disabled";
	draft.thinkingLevelMap = thinkingLevelMap(reasoning, remote.reasoning_options);
	draft.contextWindow = positiveIntegerOrCurrent(
		limit?.context,
		draft.contextWindow,
	);
	draft.maxTokens = positiveIntegerOrCurrent(limit?.output, draft.maxTokens);
	draft.cost = {
		input: perMillion(pricing.input, "input", draft.modelId),
		output: perMillion(pricing.output, "output", draft.modelId),
		cacheRead: perMillion(pricing.cache_read, "cacheRead", draft.modelId),
		cacheWrite: perMillion(pricing.cache_write, "cacheWrite", draft.modelId),
	};
}

function applyOpenRouter(draft: ModelDraft, root: unknown): void {
	const data = objectValue(root)?.data;
	if (!Array.isArray(data))
		throw new Error("OpenRouter response is missing the data array");
	const remote = data
		.map(objectValue)
		.find((entry) => entry?.id === draft.modelId);
	if (!remote) throw new Error(`OpenRouter did not find ${draft.modelId}`);
	const pricing = objectValue(remote.pricing) ?? {};
	const architecture = objectValue(remote.architecture);
	const topProvider = objectValue(remote.top_provider);
	const reasoningInfo = objectValue(remote.reasoning);
	const supportedParameters = Array.isArray(remote.supported_parameters)
		? remote.supported_parameters
		: [];
	const reasoning =
		Boolean(remote.reasoning) || supportedParameters.includes("reasoning");
	const efforts = Array.isArray(reasoningInfo?.supported_efforts)
		? reasoningInfo.supported_efforts
		: [];
	const options =
		efforts.length > 0
			? [{ type: "effort", values: efforts }]
			: reasoning
				? [{ type: "toggle" }]
				: [];
	draft.inputKinds = supportedInput(architecture?.input_modalities);
	draft.reasoningMode = reasoning ? "enabled" : "disabled";
	draft.thinkingLevelMap = thinkingLevelMap(reasoning, options, reasoningInfo);
	draft.contextWindow = positiveIntegerOrCurrent(
		remote.context_length,
		draft.contextWindow,
	);
	draft.maxTokens = positiveIntegerOrCurrent(
		topProvider?.max_completion_tokens,
		draft.maxTokens,
	);
	draft.cost = {
		input: perTokenMillion(pricing.prompt, "input", draft.modelId),
		output: perTokenMillion(pricing.completion, "output", draft.modelId),
		cacheRead: perTokenMillion(
			pricing.input_cache_read,
			"cacheRead",
			draft.modelId,
		),
		cacheWrite: perTokenMillion(
			pricing.input_cache_write,
			"cacheWrite",
			draft.modelId,
		),
	};
}

export async function synchronizeModelMetadata(
	draft: ModelDraft,
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
	if (draft.metadataSource === "manual") return;
	if (draft.metadataSource === "models.dev") {
		applyModelsDev(draft, await fetchJson(MODELS_DEV_URL, fetchImpl));
		return;
	}
	applyOpenRouter(draft, await fetchJson(OPENROUTER_MODELS_URL, fetchImpl));
}
