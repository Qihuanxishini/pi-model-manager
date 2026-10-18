// state-metadata-store.ts
//
// state.json 持久层：负责插件私有元数据的原子读写和 schema 边界校验。
// 模型定义的唯一权威源是 Pi 原生 models.json；这里仅保存请求头 profile、
// profile 库、抓包缓存和 OpenAI Responses service_tier 等原生字段无法表达的元数据。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { cloneJson, isObjectRecord, stringifyJson, stripJsonNoise } from "./common.ts";
import { readStableTextFileSnapshot, type FileSignature } from "./file-snapshot.ts";
import { t } from "./i18n.ts";
import { fromNativeBaseUrl, toNativeBaseUrl } from "./runtime-base-url.ts";
import type {
	ApiKind,
	BuiltInClientHeaderProfileId,
	ClientHeaderProfileId,
	CompatSettings,
	ModelInputKind,
	OpenAIServiceTier,
	StateDocument,
	StoredClientHeaderCapture,
	StoredModel,
	StoredProvider,
	StoredRequestHeaderProfile,
	OpenAIResponsesStreamCompletionMode,
	ThinkingLevelMap,
	TokenCost,
} from "./types.ts";

export const STATE_DIR = join(getAgentDir(), "extensions", "pi-model-manager");
export const STATE_PATH = join(STATE_DIR, "state.json");
export const CONFIGURATION_TRANSACTION_PATH = join(STATE_DIR, "config-transaction.json");

const API_KINDS = new Set<ApiKind>(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"]);
const CLIENT_HEADER_PROFILE_IDS = new Set<ClientHeaderProfileId>(["recommended", "disabled", "claude-code", "codex-cli", "custom"]);
const BUILT_IN_CLIENT_HEADER_PROFILE_IDS = new Set<BuiltInClientHeaderProfileId>(["claude-code", "codex-cli"]);
const RESERVED_REQUEST_HEADER_PROFILE_IDS = new Set(["claude-code", "codex-cli", "claude-code-live", "codex-cli-live"]);
const INPUT_KINDS = new Set<ModelInputKind>(["text", "image"]);
const THINKING_LEVELS = new Set(Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]));
const OPENAI_SERVICE_TIERS = new Set<OpenAIServiceTier>(["priority", "ultrafast"]);

interface ProviderMetadata {
	clientHeaderProfile?: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	httpProxyEnabled?: boolean;
	httpProxyUrl?: string;
	openAIResponsesStreamCompletionMode?: OpenAIResponsesStreamCompletionMode;
	anthropicApiRoot?: boolean;
}

interface ModelMetadata {
	openAIServiceTier?: OpenAIServiceTier;
	anthropicApiRoot?: boolean;
}

export interface MetadataDocument {
	version: 4 | 5;
	/** 明确由插件创建或接管的 Provider ID。 */
	managedProviderIds: string[];
	providers: Record<string, ProviderMetadata>;
	models: Record<string, ModelMetadata>;
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>;
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
}

export interface ParsedMetadataStateFile {
	metadata: MetadataDocument;
	legacyProviders: StateDocument["providers"];
	requirePluginManagedProviderMarker: boolean;
}

export interface MetadataStateSnapshot extends ParsedMetadataStateFile {
	source: string | undefined;
	signature: FileSignature;
	contentHash: string;
}

export function createEmptyMetadata(): MetadataDocument {
	return { version: 5, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} };
}
function fail(path: string, message: string): never {
	throw new Error(t("state.json {path}: {message}", { path, message }));
}

function readRequiredString(record: Record<string, unknown>, key: string, path: string): string {
	const value = record[key];
	if (typeof value !== "string" || !value.trim()) fail(`${path}.${key}`, t("必须是非空字符串"));
	return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, path: string): string | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "string") fail(`${path}.${key}`, t("必须是字符串"));
	return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string, path: string): boolean | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") fail(`${path}.${key}`, t("必须是 boolean"));
	return value;
}

function readPositiveInteger(record: Record<string, unknown>, key: string, path: string): number {
	const value = record[key];
	if (!Number.isInteger(value) || (value as number) <= 0) fail(`${path}.${key}`, t("必须是正整数"));
	return value as number;
}

function readStringRecord(value: unknown, path: string): Record<string, string> {
	if (!isObjectRecord(value)) fail(path, t("必须是对象"));
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") fail(`${path}.${key}`, t("值必须是字符串"));
		record[key] = entry;
	}
	return record;
}

function readOptionalStringRecord(record: Record<string, unknown>, key: string, path: string): Record<string, string> | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	return readStringRecord(value, `${path}.${key}`);
}

function readProviderIdList(value: unknown, path: string): string[] {
	if (!Array.isArray(value)) fail(path, t("必须是字符串数组"));
	return [...new Set(value.map((item, index) => {
		if (typeof item !== "string" || !item.trim()) fail(`${path}[${index}]`, t("必须是非空字符串"));
		return item;
	}))];
}

function readObjectRecord(record: Record<string, unknown>, key: string, path: string): Record<string, unknown> | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!isObjectRecord(value)) fail(`${path}.${key}`, t("必须是对象"));
	return cloneJson(value);
}

function readApiKind(record: Record<string, unknown>, key: string, path: string): ApiKind {
	const value = readRequiredString(record, key, path);
	if (!API_KINDS.has(value as ApiKind)) fail(`${path}.${key}`, t("未知 API 协议：{value}", { value }));
	return value as ApiKind;
}

function readOptionalClientHeaderProfile(record: Record<string, unknown>, key: string, path: string): ClientHeaderProfileId | undefined {
	const value = readOptionalString(record, key, path);
	if (value === undefined) return undefined;
	if (!CLIENT_HEADER_PROFILE_IDS.has(value as ClientHeaderProfileId)) fail(`${path}.${key}`, t("未知请求头：{value}", { value }));
	return value as ClientHeaderProfileId;
}

function readOptionalOpenAIServiceTier(record: Record<string, unknown>, key: string, path: string): OpenAIServiceTier | undefined {
	const value = readOptionalString(record, key, path);
	if (value === undefined) return undefined;
	if (!OPENAI_SERVICE_TIERS.has(value as OpenAIServiceTier)) fail(`${path}.${key}`, t("未知 OpenAI service tier：{value}", { value }));
	return value as OpenAIServiceTier;
}

function readOptionalOpenAIResponsesStreamCompletionMode(
	record: Record<string, unknown>,
	key: string,
	path: string,
): OpenAIResponsesStreamCompletionMode | undefined {
	const value = readOptionalString(record, key, path);
	if (value === undefined) return undefined;
	if (value !== "standard" && value !== "terminal-event") {
		fail(`${path}.${key}`, t("未知 Responses 流结束模式：{value}", { value }));
	}
	return value;
}

function readInputKinds(record: Record<string, unknown>, key: string, path: string): ModelInputKind[] {
	const value = record[key];
	if (!Array.isArray(value) || value.length === 0) fail(`${path}.${key}`, t("必须是非空数组"));
	const kinds = value.map((item, index) => {
		if (typeof item !== "string" || !INPUT_KINDS.has(item as ModelInputKind)) fail(`${path}.${key}[${index}]`, t("必须是 text 或 image"));
		return item as ModelInputKind;
	});
	return [...new Set(kinds)];
}

function readCost(record: Record<string, unknown>, key: string, path: string): TokenCost {
	const value = record[key];
	if (!isObjectRecord(value)) fail(`${path}.${key}`, t("必须是对象"));
	const cost: Partial<TokenCost> = {};
	for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
		const amount = value[field];
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) fail(`${path}.${key}.${field}`, t("必须是非负数字"));
		cost[field] = amount;
	}
	return cost as TokenCost;
}

function readThinkingLevelMap(record: Record<string, unknown>, key: string, path: string): ThinkingLevelMap | undefined {
	const value = record[key];
	if (value === undefined) return undefined;
	if (!isObjectRecord(value)) fail(`${path}.${key}`, t("必须是对象"));
	const map: ThinkingLevelMap = {};
	for (const [level, mapped] of Object.entries(value)) {
		if (!THINKING_LEVELS.has(level)) fail(`${path}.${key}.${level}`, t("未知 thinking level"));
		if (typeof mapped !== "string" && mapped !== null) fail(`${path}.${key}.${level}`, t("必须是字符串或 null"));
		map[level as keyof ThinkingLevelMap] = mapped;
	}
	return map;
}

function readStoredModel(raw: unknown, path: string): StoredModel {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	const reasoning = raw.reasoning;
	if (typeof reasoning !== "boolean") fail(`${path}.reasoning`, t("必须是 boolean"));

	const model: StoredModel = {
		id: readRequiredString(raw, "id", path),
		reasoning,
		input: readInputKinds(raw, "input", path),
		contextWindow: readPositiveInteger(raw, "contextWindow", path),
		maxTokens: readPositiveInteger(raw, "maxTokens", path),
		cost: readCost(raw, "cost", path),
	};

	const name = readOptionalString(raw, "name", path);
	if (name !== undefined) model.name = name;
	const thinkingLevelMap = readThinkingLevelMap(raw, "thinkingLevelMap", path);
	if (thinkingLevelMap) model.thinkingLevelMap = thinkingLevelMap;
	const clientHeaderProfile = readOptionalClientHeaderProfile(raw, "clientHeaderProfile", path);
	if (clientHeaderProfile) model.clientHeaderProfile = clientHeaderProfile;
	const requestHeaderProfileId = readOptionalString(raw, "requestHeaderProfileId", path);
	if (requestHeaderProfileId !== undefined) model.requestHeaderProfileId = requestHeaderProfileId;
	const customClientHeaders = readOptionalStringRecord(raw, "customClientHeaders", path);
	if (customClientHeaders) model.customClientHeaders = customClientHeaders;
	const openAIServiceTier = readOptionalOpenAIServiceTier(raw, "openAIServiceTier", path);
	if (openAIServiceTier) model.openAIServiceTier = openAIServiceTier;
	const compat = readObjectRecord(raw, "compat", path) as CompatSettings | undefined;
	if (compat) model.compat = compat;
	return model;
}

function readProviderMetadata(raw: unknown, path: string): ProviderMetadata {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	const metadata: ProviderMetadata = {};
	const anthropicApiRoot = readOptionalBoolean(raw, "anthropicApiRoot", path);
	if (anthropicApiRoot) metadata.anthropicApiRoot = true;
	const clientHeaderProfile = readOptionalClientHeaderProfile(raw, "clientHeaderProfile", path);
	if (clientHeaderProfile) metadata.clientHeaderProfile = clientHeaderProfile;
	const requestHeaderProfileId = readOptionalString(raw, "requestHeaderProfileId", path);
	if (requestHeaderProfileId !== undefined) metadata.requestHeaderProfileId = requestHeaderProfileId;
	const customClientHeaders = readOptionalStringRecord(raw, "customClientHeaders", path);
	if (customClientHeaders) metadata.customClientHeaders = customClientHeaders;
	const httpProxyEnabled = readOptionalBoolean(raw, "httpProxyEnabled", path);
	if (httpProxyEnabled !== undefined) metadata.httpProxyEnabled = httpProxyEnabled;
	const httpProxyUrl = readOptionalString(raw, "httpProxyUrl", path);
	if (httpProxyUrl !== undefined) metadata.httpProxyUrl = httpProxyUrl;
	const streamCompletionMode = readOptionalOpenAIResponsesStreamCompletionMode(raw, "openAIResponsesStreamCompletionMode", path);
	if (streamCompletionMode !== undefined) metadata.openAIResponsesStreamCompletionMode = streamCompletionMode;
	return metadata;
}

function readModelMetadata(raw: unknown, path: string): ModelMetadata {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	const metadata: ModelMetadata = {};
	const anthropicApiRoot = readOptionalBoolean(raw, "anthropicApiRoot", path);
	if (anthropicApiRoot) metadata.anthropicApiRoot = true;
	const openAIServiceTier = readOptionalOpenAIServiceTier(raw, "openAIServiceTier", path);
	if (openAIServiceTier) metadata.openAIServiceTier = openAIServiceTier;
	return metadata;
}

interface HeaderProfileSelection {
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
}

function inferProviderHeaderProfile(models: StoredModel[]): HeaderProfileSelection {
	const selections = models
		.map((model): HeaderProfileSelection | undefined => {
			const legacy = model as StoredModel & ProviderMetadata;
			if (!legacy.clientHeaderProfile) return undefined;
			return {
				clientHeaderProfile: legacy.clientHeaderProfile,
				requestHeaderProfileId: legacy.requestHeaderProfileId,
				customClientHeaders: legacy.customClientHeaders ? cloneJson(legacy.customClientHeaders) : undefined,
			};
		})
		.filter((selection): selection is HeaderProfileSelection => Boolean(selection));
	return selections.find((selection) =>
		selection.clientHeaderProfile !== "recommended"
		|| Boolean(selection.requestHeaderProfileId)
		|| Boolean(selection.customClientHeaders && Object.keys(selection.customClientHeaders).length > 0)
	) ?? selections[0] ?? { clientHeaderProfile: "recommended" };
}

function readStoredProvider(raw: unknown, path: string, managed: boolean): StoredProvider {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	const models = raw.models;
	if (!Array.isArray(models)) fail(`${path}.models`, t("必须是数组"));
	const storedModels = models.map((model, index) => readStoredModel(model, `${path}.models[${index}]`));
	const inferredProfile = inferProviderHeaderProfile(storedModels);
	const clientHeaderProfile = managed
		? readOptionalClientHeaderProfile(raw, "clientHeaderProfile", path) ?? inferredProfile.clientHeaderProfile
		: "disabled";

	const provider: StoredProvider = {
		name: readRequiredString(raw, "name", path),
		api: readApiKind(raw, "api", path),
		baseUrl: readRequiredString(raw, "baseUrl", path),
		managed,
		clientHeaderProfile,
		models: storedModels,
	};
	const apiKey = readOptionalString(raw, "apiKey", path);
	if (apiKey) provider.apiKey = apiKey;

	const authHeader = readOptionalBoolean(raw, "authHeader", path);
	if (authHeader !== undefined) provider.authHeader = authHeader;
	const requestHeaderProfileId = readOptionalString(raw, "requestHeaderProfileId", path) ?? inferredProfile.requestHeaderProfileId;
	if (managed && clientHeaderProfile === "custom" && requestHeaderProfileId !== undefined) provider.requestHeaderProfileId = requestHeaderProfileId;
	const customClientHeaders = readOptionalStringRecord(raw, "customClientHeaders", path) ?? inferredProfile.customClientHeaders;
	if (managed && clientHeaderProfile === "custom" && customClientHeaders) provider.customClientHeaders = customClientHeaders;
	const httpProxyEnabled = readOptionalBoolean(raw, "httpProxyEnabled", path);
	if (httpProxyEnabled !== undefined) provider.httpProxyEnabled = httpProxyEnabled;
	const httpProxyUrl = readOptionalString(raw, "httpProxyUrl", path);
	if (httpProxyUrl !== undefined) provider.httpProxyUrl = httpProxyUrl;
	const streamCompletionMode = readOptionalOpenAIResponsesStreamCompletionMode(raw, "openAIResponsesStreamCompletionMode", path);
	if (streamCompletionMode !== undefined) provider.openAIResponsesStreamCompletionMode = streamCompletionMode;
	return provider;
}

function readRequestHeaderProfile(raw: unknown, path: string): StoredRequestHeaderProfile {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	return {
		name: readRequiredString(raw, "name", path),
		headers: readStringRecord(raw.headers, `${path}.headers`),
	};
}

function readClientHeaderCapture(raw: unknown, path: string): StoredClientHeaderCapture {
	if (!isObjectRecord(raw)) fail(path, t("必须是对象"));
	return {
		capturedAt: readRequiredString(raw, "capturedAt", path),
		headers: readStringRecord(raw.headers, `${path}.headers`),
	};
}

function readCommonMetadataFields(parsed: Record<string, unknown>, base: MetadataDocument): MetadataDocument {
	const requestHeaderProfiles: MetadataDocument["requestHeaderProfiles"] = {};
	const rawProfiles = parsed.requestHeaderProfiles;
	if (rawProfiles !== undefined) {
		if (!isObjectRecord(rawProfiles)) fail(".requestHeaderProfiles", t("必须是对象"));
		for (const [profileId, profile] of Object.entries(rawProfiles)) {
			if (RESERVED_REQUEST_HEADER_PROFILE_IDS.has(profileId)) {
				fail(`.requestHeaderProfiles.${profileId}`, t("不能使用插件内置请求头保留名"));
			}
			requestHeaderProfiles[profileId] = readRequestHeaderProfile(profile, `.requestHeaderProfiles.${profileId}`);
		}
	}

	const clientHeaderCaptures: MetadataDocument["clientHeaderCaptures"] = {};
	const rawCaptures = parsed.clientHeaderCaptures;
	if (rawCaptures !== undefined) {
		if (!isObjectRecord(rawCaptures)) fail(".clientHeaderCaptures", t("必须是对象"));
		for (const [profileId, capture] of Object.entries(rawCaptures)) {
			if (!BUILT_IN_CLIENT_HEADER_PROFILE_IDS.has(profileId as BuiltInClientHeaderProfileId)) {
				fail(`.clientHeaderCaptures.${profileId}`, t("只能保存 ClaudeCode/Codex 内置 profile 的抓包数据"));
			}
			clientHeaderCaptures[profileId as BuiltInClientHeaderProfileId] = readClientHeaderCapture(
				capture,
				`.clientHeaderCaptures.${profileId}`,
			);
		}
	}

	return {
		...base,
		requestHeaderProfiles,
		clientHeaderCaptures,
	};
}

function getFullModelId(providerId: string, modelId: string): string {
	return `${providerId}/${modelId}`;
}

function extractProviderMetadata(provider: StoredProvider): ProviderMetadata {
	const metadata: ProviderMetadata = {};
	if (toNativeBaseUrl(provider.api, provider.baseUrl).anthropicApiRoot) metadata.anthropicApiRoot = true;
	if (provider.clientHeaderProfile !== "recommended") metadata.clientHeaderProfile = provider.clientHeaderProfile;
	if (provider.clientHeaderProfile === "custom" && provider.requestHeaderProfileId) {
		metadata.clientHeaderProfile = "custom";
		metadata.requestHeaderProfileId = provider.requestHeaderProfileId;
	}
	if (provider.clientHeaderProfile === "custom" && provider.customClientHeaders && Object.keys(provider.customClientHeaders).length > 0) {
		metadata.clientHeaderProfile = "custom";
		metadata.customClientHeaders = cloneJson(provider.customClientHeaders);
	}
	if (provider.httpProxyEnabled) metadata.httpProxyEnabled = true;
	const httpProxyUrl = provider.httpProxyUrl?.trim();
	if (httpProxyUrl) metadata.httpProxyUrl = httpProxyUrl;
	if (provider.openAIResponsesStreamCompletionMode === "terminal-event") {
		metadata.openAIResponsesStreamCompletionMode = "terminal-event";
	}
	return metadata;
}

function extractModelMetadata(model: StoredModel, provider: StoredProvider): ModelMetadata {
	const metadata: ModelMetadata = {};
	if (toNativeBaseUrl(model.api ?? provider.api, model.baseUrl ?? provider.baseUrl).anthropicApiRoot) metadata.anthropicApiRoot = true;
	if (model.openAIServiceTier) metadata.openAIServiceTier = model.openAIServiceTier;
	return metadata;
}

function extractMetadataFromLegacyState(legacy: StateDocument): MetadataDocument {
	const metadata = createEmptyMetadata();
	metadata.version = 4;
	metadata.managedProviderIds = Object.keys(legacy.providers);
	metadata.requestHeaderProfiles = cloneJson(legacy.requestHeaderProfiles);
	metadata.clientHeaderCaptures = cloneJson(legacy.clientHeaderCaptures);
	for (const [providerId, provider] of Object.entries(legacy.providers)) {
		metadata.providers[providerId] = extractProviderMetadata(provider);
		for (const model of provider.models) {
			const modelMetadata = extractModelMetadata(model, provider);
			if (Object.keys(modelMetadata).length > 0) metadata.models[getFullModelId(providerId, model.id)] = modelMetadata;
		}
	}
	return metadata;
}

function parseLegacyState(parsed: Record<string, unknown>): ParsedMetadataStateFile {
	const providers: StateDocument["providers"] = {};
	const rawProviders = parsed.providers;
	if (rawProviders !== undefined) {
		if (!isObjectRecord(rawProviders)) fail(".providers", t("必须是对象"));
		for (const [providerId, provider] of Object.entries(rawProviders)) {
			providers[providerId] = readStoredProvider(provider, `.providers.${providerId}`, true);
		}
	}
	const common = readCommonMetadataFields(parsed, createEmptyMetadata());
	const legacy = { version: 2, providers, managedProviderIds: Object.keys(providers), requestHeaderProfiles: common.requestHeaderProfiles, clientHeaderCaptures: common.clientHeaderCaptures } satisfies StateDocument;
	for (const provider of Object.values(providers)) {
		provider.baseUrl = fromNativeBaseUrl(provider.api, provider.baseUrl, false, true);
	}
	return {
		metadata: extractMetadataFromLegacyState(legacy),
		legacyProviders: providers,
		requirePluginManagedProviderMarker: false,
	};
}

function parseMetadataState(parsed: Record<string, unknown>): ParsedMetadataStateFile {
	const metadata = readCommonMetadataFields(parsed, createEmptyMetadata());
	metadata.version = parsed.version === 5 ? 5 : 4;
	const rawProviders = parsed.providers;
	if (rawProviders !== undefined) {
		if (!isObjectRecord(rawProviders)) fail(".providers", t("必须是对象"));
		for (const [providerId, provider] of Object.entries(rawProviders)) {
			metadata.providers[providerId] = readProviderMetadata(provider, `.providers.${providerId}`);
		}
	}
	const rawModels = parsed.models;
	if (rawModels !== undefined) {
		if (!isObjectRecord(rawModels)) fail(".models", t("必须是对象"));
		for (const [fullModelId, model] of Object.entries(rawModels)) {
			metadata.models[fullModelId] = readModelMetadata(model, `.models.${fullModelId}`);
		}
	}
	metadata.managedProviderIds = parsed.managedProviderIds === undefined
		? [...new Set([
			...Object.keys(metadata.providers),
			...Object.keys(metadata.models).flatMap((fullModelId) => {
				const separatorIndex = fullModelId.indexOf("/");
				return separatorIndex > 0 ? [fullModelId.slice(0, separatorIndex)] : [];
			}),
		])]
		: readProviderIdList(parsed.managedProviderIds, ".managedProviderIds");
	return {
		metadata,
		legacyProviders: {},
		requirePluginManagedProviderMarker: parsed.version === 4 || parsed.version === 5,
	};
}

function parseStateFile(source: string): ParsedMetadataStateFile {
	const parsed = JSON.parse(stripJsonNoise(source));
	if (!isObjectRecord(parsed)) fail("", t("根节点必须是对象"));
	if (parsed.version === 5 || parsed.version === 4 || parsed.version === 3 || parsed.version === 2) return parseMetadataState(parsed);
	if (parsed.version === undefined || parsed.version === 1) return parseLegacyState(parsed);
	fail(".version", t("不支持的版本：{version}", { version: String(parsed.version) }));
}

export async function readMetadataStateSnapshot(): Promise<MetadataStateSnapshot> {
	const snapshot = await readStableTextFileSnapshot(STATE_PATH);
	const parsed = snapshot.source === undefined
		? { metadata: createEmptyMetadata(), legacyProviders: {}, requirePluginManagedProviderMarker: true }
		: parseStateFile(snapshot.source);
	return { ...parsed, source: snapshot.source, signature: snapshot.signature, contentHash: snapshot.contentHash };
}

function extractMetadata(state: StateDocument): MetadataDocument {
	const metadata = createEmptyMetadata();
	metadata.managedProviderIds = Object.entries(state.providers)
		.filter(([, provider]) => provider.managed)
		.map(([providerId]) => providerId);
	metadata.requestHeaderProfiles = cloneJson(state.requestHeaderProfiles);
	metadata.clientHeaderCaptures = cloneJson(state.clientHeaderCaptures);
	for (const [providerId, provider] of Object.entries(state.providers)) {
		if (!provider.managed) continue;
		const providerMetadata = extractProviderMetadata(provider);
		if (Object.keys(providerMetadata).length > 0) metadata.providers[providerId] = providerMetadata;
		for (const model of provider.models) {
			const modelMetadata = extractModelMetadata(model, provider);
			if (Object.keys(modelMetadata).length > 0) metadata.models[getFullModelId(providerId, model.id)] = modelMetadata;
		}
	}
	return metadata;
}

export function serializeMetadataState(state: StateDocument): string {
	return stringifyJson(extractMetadata(state));
}
export function getStatePath(): string {
	return STATE_PATH;
}
