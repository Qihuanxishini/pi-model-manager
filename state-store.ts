// state-store.ts
//
// StateDocument 合成层：从 Pi 原生 models.json 读取模型定义，再叠加
// state.json 中的插件私有元数据，提供 TUI 与运行时注册使用的统一视图。

import { setTimeout as delay } from "node:timers/promises";
import { getBuiltinProviderDefaults } from "./builtin-model-catalog.ts";
import { mergeCompatSettings } from "./compat-settings.ts";
import { cloneJson, cloneStringRecord, hasStringRecordEntries, isObjectRecord } from "./common.ts";
import { readStableTextFileSnapshot } from "./file-snapshot.ts";
import { t } from "./i18n.ts";
import {
	getModelsJsonPath,
	hasPluginManagedProviderMarker,
	readModelsJsonSnapshot,
	type ModelsJsonDocument,
	type ModelsJsonModelEntry,
	type ModelsJsonProviderEntry,
} from "./models-json-manager.ts";
import {
	getClientHeadersForProfile,
	stripManagedClientHeaders,
} from "./presets/client-headers.ts";
import { normalizeThinkingLevelMap } from "./presets/thinking.ts";
import { fromNativeBaseUrl, resolveRuntimeBaseUrl, toNativeBaseUrl } from "./runtime-base-url.ts";
import {
	CONFIGURATION_TRANSACTION_PATH,
	getStatePath as getMetadataStatePath,
	readMetadataStateSnapshot,
	type MetadataDocument,
	type ParsedMetadataStateFile,
} from "./state-metadata-store.ts";
import type {
	ApiKind,
	CompatSettings,
	ModelInputKind,
	StateDocument,
	StoredModel,
	StoredProvider,
	ThinkingLevelMap,
	TokenCost,
	TokenCostTier,
} from "./types.ts";
import { ZERO_COST } from "./types.ts";

const API_KINDS = new Set<ApiKind>(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const INPUT_KINDS = new Set<ModelInputKind>(["text", "image"]);

function createEmptyStateDocument(): StateDocument {
	return { version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} };
}

function asApiKind(value: unknown): ApiKind | undefined {
	return typeof value === "string" && API_KINDS.has(value as ApiKind) ? value as ApiKind : undefined;
}

function getFullModelId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function readNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function readCostTier(value: unknown): TokenCostTier | undefined {
	if (!isObjectRecord(value)) return undefined;
	const inputTokensAbove = value.inputTokensAbove;
	if (typeof inputTokensAbove !== "number" || !Number.isFinite(inputTokensAbove) || inputTokensAbove < 0) return undefined;
	return {
		inputTokensAbove,
		input: readNonNegativeNumber(value.input),
		output: readNonNegativeNumber(value.output),
		cacheRead: readNonNegativeNumber(value.cacheRead),
		cacheWrite: readNonNegativeNumber(value.cacheWrite),
	};
}

function readModelCost(model: ModelsJsonModelEntry): TokenCost {
	const cost = model.cost;
	if (!cost) return { ...ZERO_COST };
	const stored: TokenCost = {
		input: readNonNegativeNumber(cost.input),
		output: readNonNegativeNumber(cost.output),
		cacheRead: readNonNegativeNumber(cost.cacheRead),
		cacheWrite: readNonNegativeNumber(cost.cacheWrite),
	};
	const tiers = cost.tiers?.map(readCostTier).filter((tier): tier is TokenCostTier => Boolean(tier));
	if (tiers && tiers.length > 0) stored.tiers = tiers;
	return stored;
}

function readModelInput(model: ModelsJsonModelEntry): ModelInputKind[] {
	const input = model.input?.filter((item): item is ModelInputKind => INPUT_KINDS.has(item as ModelInputKind));
	return input && input.length > 0 ? [...new Set(input)] : ["text"];
}

function resolveProviderCustomHeaders(
	providerMetadata: MetadataDocument["providers"][string] | undefined,
	metadata: MetadataDocument,
): Record<string, string> {
	const profileId = providerMetadata?.requestHeaderProfileId;
	if (profileId && metadata.requestHeaderProfiles[profileId]) return metadata.requestHeaderProfiles[profileId].headers;
	return providerMetadata?.customClientHeaders ?? {};
}

function stripProviderInheritedHeaders(
	modelHeaders: Record<string, string> | undefined,
	providerHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!modelHeaders || !providerHeaders) return modelHeaders;
	const result = cloneStringRecord(modelHeaders);
	for (const [pName, pValue] of Object.entries(providerHeaders)) {
		for (const [mName, mValue] of Object.entries(result)) {
			if (mName.toLowerCase() === pName.toLowerCase() && mValue === pValue) {
				delete result[mName];
			}
		}
	}
	return hasStringRecordEntries(result) ? result : undefined;
}

function buildStoredModelFromModelsJson(
	providerId: string,
	providerApi: ApiKind,
	providerBaseUrl: string,
	providerNativeBaseUrl: string,
	providerCompat: CompatSettings | undefined,
	providerHeaders: Record<string, string> | undefined,
	managed: boolean,
	clientHeaderProfile: StoredProvider["clientHeaderProfile"],
	customClientHeaders: Record<string, string>,
	model: ModelsJsonModelEntry,
	metadata: MetadataDocument,
): StoredModel | undefined {
	if (!model.id || typeof model.id !== "string") return undefined;
	const explicitApi = typeof model.api === "string" && model.api ? model.api : undefined;
	const effectiveApi = asApiKind(explicitApi) ?? providerApi;
	const modelCompat = model.compat ? cloneJson(model.compat) : undefined;
	const effectiveCompat = mergeCompatSettings(providerCompat, modelCompat);
	const profileHeaders = managed
		? getClientHeadersForProfile(
			clientHeaderProfile,
			effectiveApi,
			customClientHeaders,
			metadata.clientHeaderCaptures,
			effectiveCompat,
		)
		: undefined;
	const nativeHeaders = managed
		? stripProviderInheritedHeaders(stripManagedClientHeaders(model.headers, profileHeaders), providerHeaders)
		: cloneStringRecord(model.headers);
	const stored: StoredModel = {
		id: model.id,
		reasoning: model.reasoning ?? false,
		input: readModelInput(model),
		contextWindow: model.contextWindow && model.contextWindow > 0 ? model.contextWindow : 128000,
		maxTokens: model.maxTokens && model.maxTokens > 0 ? model.maxTokens : 16000,
		cost: readModelCost(model),
	};
	if (explicitApi && explicitApi !== providerApi) stored.api = explicitApi;
	const modelMetadata = metadata.models[getFullModelId(providerId, model.id)];
	let modelBaseUrl = model.baseUrl ?? providerBaseUrl;
	if (managed && model.baseUrl) {
		modelBaseUrl = fromNativeBaseUrl(effectiveApi, model.baseUrl, modelMetadata?.anthropicApiRoot, metadata.version < 5);
	} else if (managed && effectiveApi !== providerApi) {
		const inheritedBaseUrl = metadata.version < 5
			? (providerApi === "anthropic-messages"
				? toNativeBaseUrl(providerApi, providerBaseUrl).baseUrl
				: resolveRuntimeBaseUrl(providerApi, providerNativeBaseUrl))
			: providerNativeBaseUrl;
		modelBaseUrl = fromNativeBaseUrl(effectiveApi, inheritedBaseUrl, modelMetadata?.anthropicApiRoot);
	}
	if (modelBaseUrl !== providerBaseUrl) stored.baseUrl = modelBaseUrl;
	if (nativeHeaders) stored.headers = nativeHeaders;
	if (model.name) stored.name = model.name;
	const storedThinkingLevelMap = model.thinkingLevelMap ? cloneJson(model.thinkingLevelMap) as ThinkingLevelMap : undefined;
	const thinkingLevelMap = normalizeThinkingLevelMap(effectiveApi, stored.reasoning, storedThinkingLevelMap);
	if (thinkingLevelMap) stored.thinkingLevelMap = thinkingLevelMap;
	if (modelCompat) stored.compat = modelCompat;
	if (effectiveApi === "openai-responses" && modelMetadata?.openAIServiceTier) {
		stored.openAIServiceTier = modelMetadata.openAIServiceTier;
	}
	return stored;
}

async function buildStoredProviderFromModelsJson(
	providerId: string,
	entry: ModelsJsonProviderEntry,
	metadata: MetadataDocument,
	requirePluginManagedProviderMarker: boolean,
): Promise<StoredProvider | undefined> {
	const rawModels = entry.models ?? [];
	if (rawModels.length === 0) return undefined;

	const firstModel = rawModels[0];
	const builtInDefaults = await getBuiltinProviderDefaults(providerId);
	const api = asApiKind(entry.api) ?? asApiKind(firstModel?.api) ?? asApiKind(builtInDefaults?.api);
	const nativeBaseUrl = entry.baseUrl ?? firstModel?.baseUrl ?? builtInDefaults?.baseUrl;
	if (!api || !nativeBaseUrl) return undefined;

	const providerMetadata = metadata.providers[providerId];
	const managed = metadata.managedProviderIds.includes(providerId)
		&& (!requirePluginManagedProviderMarker || hasPluginManagedProviderMarker(entry));
	const baseUrl = managed
		? fromNativeBaseUrl(api, nativeBaseUrl, providerMetadata?.anthropicApiRoot, metadata.version < 5)
		: nativeBaseUrl;
	const clientHeaderProfile = managed ? providerMetadata?.clientHeaderProfile ?? "recommended" : "disabled";
	const customClientHeaders = managed && clientHeaderProfile === "custom"
		? resolveProviderCustomHeaders(providerMetadata, metadata)
		: {};
	const providerCompat = entry.compat ? cloneJson(entry.compat) : undefined;
	const models = rawModels
		.map((model) => buildStoredModelFromModelsJson(
			providerId,
			api,
			baseUrl,
			nativeBaseUrl,
			providerCompat,
			entry.headers,
			managed,
			clientHeaderProfile,
			customClientHeaders,
			model,
			metadata,
		))
		.filter((model): model is StoredModel => Boolean(model));
	if (models.length === 0) return undefined;

	const provider: StoredProvider = {
		name: entry.name || providerId,
		api,
		baseUrl,
		managed,
		clientHeaderProfile,
		models,
	};
	if (entry.apiKey) provider.apiKey = entry.apiKey;
	if (entry.authHeader !== undefined) provider.authHeader = entry.authHeader;
	if (entry.headers !== undefined) provider.headers = cloneJson(entry.headers);
	if (providerCompat) provider.compat = providerCompat;
	if (entry.modelOverrides !== undefined) provider.modelOverrides = cloneJson(entry.modelOverrides);
	if (managed && provider.clientHeaderProfile === "custom" && providerMetadata?.requestHeaderProfileId) {
		provider.requestHeaderProfileId = providerMetadata.requestHeaderProfileId;
	}
	if (managed && provider.clientHeaderProfile === "custom" && hasStringRecordEntries(providerMetadata?.customClientHeaders)) {
		provider.customClientHeaders = cloneJson(providerMetadata!.customClientHeaders!);
	}
	if (managed && providerMetadata?.httpProxyEnabled !== undefined) provider.httpProxyEnabled = providerMetadata.httpProxyEnabled;
	if (managed && providerMetadata?.httpProxyUrl !== undefined) provider.httpProxyUrl = providerMetadata.httpProxyUrl;
	if (managed && providerMetadata?.openAIResponsesStreamCompletionMode !== undefined) {
		provider.openAIResponsesStreamCompletionMode = providerMetadata.openAIResponsesStreamCompletionMode;
	}
	if (managed && providerMetadata?.openAIResponsesAutoRecoveryEnabled !== undefined) {
		provider.openAIResponsesAutoRecoveryEnabled = providerMetadata.openAIResponsesAutoRecoveryEnabled;
	}
	return provider;
}

export async function buildStateDocumentFromModelsJson(
	document: ModelsJsonDocument,
	metadata: MetadataDocument,
	requirePluginManagedProviderMarker = false,
): Promise<StateDocument> {
	const providers: StateDocument["providers"] = {};
	for (const [providerId, entry] of Object.entries(document.providers)) {
		const provider = await buildStoredProviderFromModelsJson(
			providerId,
			entry,
			metadata,
			requirePluginManagedProviderMarker,
		);
		if (provider) providers[providerId] = provider;
	}
	return {
		version: 2,
		providers,
		managedProviderIds: Object.entries(providers)
			.filter(([, provider]) => provider.managed)
			.map(([providerId]) => providerId),
		requestHeaderProfiles: metadata.requestHeaderProfiles,
		clientHeaderCaptures: metadata.clientHeaderCaptures,
	};
}

export async function buildStateDocumentFromSources(
	modelsDocument: ModelsJsonDocument,
	metadataFile: ParsedMetadataStateFile,
): Promise<StateDocument> {
	const state = await buildStateDocumentFromModelsJson(
		modelsDocument,
		metadataFile.metadata,
		metadataFile.requirePluginManagedProviderMarker,
	);
	for (const [providerId, provider] of Object.entries(metadataFile.legacyProviders)) {
		if (!state.providers[providerId]) state.providers[providerId] = provider;
		if (!state.managedProviderIds.includes(providerId)) state.managedProviderIds.push(providerId);
	}
	return state;
}

export async function readState(): Promise<StateDocument> {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const journalBefore = await readStableTextFileSnapshot(CONFIGURATION_TRANSACTION_PATH);
		if (journalBefore.source !== undefined) {
			if (attempt < 2) await delay(10);
			continue;
		}
		const [modelsSnapshot, metadataSnapshot] = await Promise.all([
			readModelsJsonSnapshot(),
			readMetadataStateSnapshot(),
		]);
		const [modelsAfter, metadataAfter, journalAfter] = await Promise.all([
			readStableTextFileSnapshot(getModelsJsonPath()),
			readStableTextFileSnapshot(getMetadataStatePath()),
			readStableTextFileSnapshot(CONFIGURATION_TRANSACTION_PATH),
		]);
		if (
			journalAfter.source === undefined
			&& modelsAfter.contentHash === modelsSnapshot.contentHash
			&& metadataAfter.contentHash === metadataSnapshot.contentHash
		) {
			return buildStateDocumentFromSources(modelsSnapshot.document, metadataSnapshot);
		}
		if (attempt < 2) await delay(10);
	}
	throw new Error(t("models.json/state.json 正在事务更新或持续变化；请稍后重试。"));
}
export function getStatePath(): string {
	return getMetadataStatePath();
}

export function createEmptyState(): StateDocument {
	return createEmptyStateDocument();
}
