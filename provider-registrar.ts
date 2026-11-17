// 将配置交给 Pi 构造原生 Provider，插件仅包装其请求传输。

import { isDeepStrictEqual } from "node:util";
import { ModelRuntime, type ExtensionAPI, type ExtensionContext, type ProviderConfig } from "@earendil-works/pi-coding-agent";
import { lazyStream, type Provider } from "@earendil-works/pi-ai";
import { isBuiltinProviderId } from "./builtin-model-catalog.ts";
import { buildCodexClientHeaders } from "./presets/codex-client-headers.ts";
import { mergeCompatSettings } from "./compat-settings.ts";
import { formatUnknownError } from "./common.ts";
import { t } from "./i18n.ts";
import { removeProviderLocalProxyRoutes } from "./local-proxy-service.ts";
import { getClientHeadersForProfile, mergeModelRequestHeaders, resolveClientHeaderProfile, resolveProviderCustomHeaders } from "./presets/client-headers.ts";
import { createProviderTransport } from "./provider-transport.ts";
import { readCachedState } from "./state-cache.ts";
import { resolveRuntimeBaseUrl } from "./runtime-base-url.ts";
import type { ApiKind, BuiltInClientHeaderProfileId, StateDocument, StoredClientHeaderCapture, StoredModel, StoredProvider, StoredRequestHeaderProfile } from "./types.ts";

type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];
const REGISTERED_PROVIDERS = new Map<string, ProviderRegistration>();
const emptyCredentialStore = {
	async read() { return undefined; },
	async list() { return []; },
	async modify() { return undefined; },
	async delete() {},
};

function buildProviderConfig(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): ProviderConfig {
	const apiKey = provider.apiKey?.trim();
	return {
		name: provider.name,
		baseUrl: resolveRuntimeBaseUrl(provider.api, provider.baseUrl),
		...(apiKey ? { apiKey } : {}),
		api: provider.api,
		headers: mergeModelRequestHeaders(undefined, provider.headers),
		authHeader: provider.authHeader,
		models: provider.models.map((model) => buildModelConfig(provider, model, requestHeaderProfiles, clientHeaderCaptures)),
	};
}

interface ProviderRefreshSnapshot {
	provider: StoredProvider | undefined;
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>;
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
}

interface ProviderRegistration {
	provider: Provider;
	matchesSnapshot(snapshot: ProviderRefreshSnapshot): boolean;
}

function createProviderRefreshSnapshot(
	providerId: string,
	providers: Record<string, StoredProvider>,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): ProviderRefreshSnapshot {
	const provider = providers[providerId];
	const profileId = provider?.clientHeaderProfile === "custom" ? provider.requestHeaderProfileId : undefined;
	const profile = profileId ? requestHeaderProfiles[profileId] : undefined;
	return {
		provider,
		requestHeaderProfiles: profileId && profile ? { [profileId]: profile } : {},
		clientHeaderCaptures,
	};
}

async function buildNativeProvider(providerId: string, provider: StoredProvider, config: ProviderConfig, signal?: AbortSignal): Promise<Provider> {
	signal?.throwIfAborted();
	// [喵喵喵]: 复用 Pi 的认证解析与多协议分派；临时 runtime 不读取用户认证或模型文件，也不刷新网络目录。
	const runtime = await ModelRuntime.create({ credentials: emptyCredentialStore, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false, signal });
	signal?.throwIfAborted();
	runtime.registerProvider(providerId, config);
	const native = runtime.getProvider(providerId);
	if (!native) throw new Error(t("无法构建接入：{providerId}", { providerId }));
	return createProviderTransport(native, provider);
}

function createProviderRegistration(
	providerId: string,
	native: Provider,
	initialSnapshot: ProviderRefreshSnapshot,
): ProviderRegistration {
	let current: Provider | undefined = native;
	let refreshedSnapshot = initialSnapshot;
	// [喵喵喵]: Pi 合成层会捕获 apiKey 对象，认证方法也必须通过稳定入口委派，不能只用 auth getter 切换对象。
	const auth: Provider["auth"] = { apiKey: {
		name: native.auth.apiKey?.name ?? native.name,
		login: native.auth.apiKey?.login,
		check: async (input) => current?.auth.apiKey?.check?.(input),
		resolve: async (input) => current?.auth.apiKey?.resolve(input),
	} };
	const forward = (simple: boolean): Provider["streamSimple"] => (model, context, options) => {
		if (!current) {
			return lazyStream(model, async () => {
				throw new Error(t("接入已移除或不再由插件管理：{providerId}", { providerId }));
			}, undefined, options?.signal);
		}
		return simple ? current.streamSimple(model, context, options) : current.stream(model, context, options);
	};
	const refreshable: Provider = {
		id: providerId,
		get name() { return current?.name ?? native.name; },
		get baseUrl() { return current?.baseUrl; },
		get headers() { return current?.headers; },
		auth,
		getModels: () => current?.getModels() ?? [],
		refreshModelsAuth: "configured",
		async refreshModels(context) {
			if (context.allowNetwork || context.signal.aborted) return;
			const state = await readCachedState();
			if (context.signal.aborted) return;
			const snapshot = createProviderRefreshSnapshot(
				providerId,
				state.providers,
				state.requestHeaderProfiles,
				state.clientHeaderCaptures,
			);
			if (isDeepStrictEqual(snapshot, refreshedSnapshot)) return;
			const provider = snapshot.provider;
			const config = provider?.managed && provider.models.length > 0
				? buildProviderConfig(provider, snapshot.requestHeaderProfiles, snapshot.clientHeaderCaptures)
				: undefined;
			const next = provider && config
				? await buildNativeProvider(providerId, provider, config, context.signal)
				: undefined;
			if (context.signal.aborted) return;
			// [喵喵喵]: 原生刷新保留 provider 实例；目录、认证和传输必须经同一次 generation 校验后切换，不另写模型缓存。
			await context.publish({ update: () => { current = next; refreshedSnapshot = snapshot; } });
		},
		stream: forward(false) as Provider["stream"],
		streamSimple: forward(true),
	};
	return {
		provider: refreshable,
		matchesSnapshot: (snapshot) => current !== undefined && isDeepStrictEqual(snapshot, refreshedSnapshot),
	};
}

function asManagedApi(value: string | undefined, fallback: ApiKind): ApiKind {
	if (value === "openai-completions" || value === "openai-responses"
		|| value === "anthropic-messages" || value === "google-generative-ai") return value;
	return fallback;
}

function resolveModelRuntimeBaseUrl(provider: StoredProvider, model: StoredModel): string | undefined {
	if (!model.baseUrl) return undefined;
	return resolveRuntimeBaseUrl(asManagedApi(model.api, provider.api), model.baseUrl);
}

export function buildModelRequestHeaders(
	provider: Pick<StoredProvider, "api" | "managed" | "headers" | "compat" | "clientHeaderProfile" | "requestHeaderProfileId" | "customClientHeaders">,
	model: Pick<StoredModel, "api" | "headers" | "compat">,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Record<string, string> | undefined {
	if (!provider.managed) return model.headers ? { ...model.headers } : undefined;
	const customHeaders = provider.clientHeaderProfile === "custom"
		? resolveProviderCustomHeaders(provider, requestHeaderProfiles)
		: {};
	const effectiveApi = asManagedApi(model.api, provider.api);
	const profileHeaders = getClientHeadersForProfile(
		provider.clientHeaderProfile,
		effectiveApi,
		customHeaders,
		clientHeaderCaptures,
	);
	const explicitHeaders = mergeModelRequestHeaders(provider.headers, model.headers);
	if (resolveClientHeaderProfile(provider.clientHeaderProfile, effectiveApi) === "codex-cli") {
		return buildCodexClientHeaders(profileHeaders ?? {}, explicitHeaders);
	}
	return provider.clientHeaderProfile === "custom"
		? mergeModelRequestHeaders(explicitHeaders, profileHeaders)
		: mergeModelRequestHeaders(profileHeaders, explicitHeaders);
}

function buildModelConfig(
	provider: StoredProvider,
	model: StoredModel,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): ProviderModelConfig {
	return {
		id: model.id,
		name: model.name ?? model.id,
		api: model.api as ProviderModelConfig["api"],
		baseUrl: resolveModelRuntimeBaseUrl(provider, model),
		reasoning: model.reasoning,
		thinkingLevelMap: model.thinkingLevelMap,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		headers: buildModelRequestHeaders(provider, model, requestHeaderProfiles, clientHeaderCaptures),
		compat: mergeCompatSettings(provider.compat, model.compat) as ProviderModelConfig["compat"],
	};
}

/** 注销本扩展实际注册的动态 provider，并同步清理代理路由和回滚快照。 */
export function unregisterManagedProvider(pi: ExtensionAPI, providerId: string): void {
	removeProviderLocalProxyRoutes(providerId);
	const wasRegistered = REGISTERED_PROVIDERS.delete(providerId);
	if (wasRegistered) pi.unregisterProvider(providerId);
}

async function canRegisterManagedProvider(providerId: string, provider: StoredProvider): Promise<boolean> {
	return provider.managed && provider.models.length > 0 && !(await isBuiltinProviderId(providerId));
}

function replaceManagedProviderRegistration(
	pi: ExtensionAPI,
	providerId: string,
	next: ProviderRegistration,
): void {
	const previous = REGISTERED_PROVIDERS.get(providerId);
	try {
		if (previous) pi.unregisterProvider(providerId);
		pi.registerProvider(next.provider);
		REGISTERED_PROVIDERS.set(providerId, next);
	} catch (error) {
		let rollbackError: unknown;
		try {
			if (previous) {
				pi.unregisterProvider(providerId);
				pi.registerProvider(previous.provider);
				REGISTERED_PROVIDERS.set(providerId, previous);
			} else {
				REGISTERED_PROVIDERS.delete(providerId);
			}
		} catch (restoreError) {
			rollbackError = restoreError;
		}
		const rollbackNote = rollbackError
			? t("；恢复上一版 runtime 也失败：{error}", { error: formatUnknownError(rollbackError) })
			: previous
				? t("；已恢复上一版 runtime")
				: t("；新配置未注册到当前 runtime");
		throw new Error(`${formatUnknownError(error)}${rollbackNote}`);
	}
}

/** 同步一个 provider 到当前会话 transport。新配置会先完整构建；替换失败时恢复上一版动态配置。 */
export async function reconcileProvider(
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<void> {
	// registerProvider 的 models 会整体替换目录；内置 provider 必须保留 Pi 已合成的完整目录。
	if (!(await canRegisterManagedProvider(providerId, provider))) {
		unregisterManagedProvider(pi, providerId);
		return;
	}

	const config = buildProviderConfig(provider, requestHeaderProfiles, clientHeaderCaptures);
	const native = await buildNativeProvider(providerId, provider, config);
	const initialSnapshot = createProviderRefreshSnapshot(
		providerId,
		{ [providerId]: provider },
		requestHeaderProfiles,
		clientHeaderCaptures,
	);
	replaceManagedProviderRegistration(pi, providerId, createProviderRegistration(providerId, native, initialSnapshot));
}

async function reconcileAllFromState(
	pi: ExtensionAPI,
	document: StateDocument,
	context?: Pick<ExtensionContext, "modelRegistry" | "model">,
): Promise<string[]> {
	const warnings: string[] = [];
	const activeProviderIds = new Set(
		[...document.managedProviderIds].filter((providerId) => document.providers[providerId]?.managed),
	);
	for (const providerId of REGISTERED_PROVIDERS.keys()) {
		if (!activeProviderIds.has(providerId)) unregisterManagedProvider(pi, providerId);
	}
	for (const [providerId, provider] of Object.entries(document.providers)) {
		try {
			const registration = REGISTERED_PROVIDERS.get(providerId);
			if (context && registration?.matchesSnapshot(createProviderRefreshSnapshot(
				providerId,
				document.providers,
				document.requestHeaderProfiles,
				document.clientHeaderCaptures,
			))) {
				const currentModel = context.model;
				const catalogModel = currentModel && context.modelRegistry.find(currentModel.provider, currentModel.id);
				// [喵喵喵]: 重注册会更新宿主当前模型；字段变化时保留该行为，不用 setModel 额外写入选择记录。
				const needsModelRefresh = catalogModel !== undefined && !isDeepStrictEqual(currentModel, catalogModel);
				// [喵喵喵]: factory 仅排队注册，必须核对宿主登记的实例，不能因本地已有记录而漏掉补注册。
				if (context.modelRegistry.getRegisteredNativeProvider(providerId) !== registration.provider || needsModelRefresh) {
					replaceManagedProviderRegistration(pi, providerId, registration);
				}
				continue;
			}
			await reconcileProvider(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
		} catch (error) {
			warnings.push(`${providerId}: ${formatUnknownError(error)}`);
		}
	}
	return warnings;
}

/** factory 阶段注册完整 provider 供模型选择使用，本地代理按请求启动。 */
export async function registerCatalogFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document);
}

/** session_start 仅重建变化的 provider，并补齐缺失的注册或当前模型更新。 */
export async function registerAllFromState(
	pi: ExtensionAPI,
	document: StateDocument,
	context: Pick<ExtensionContext, "modelRegistry" | "model">,
): Promise<string[]> {
	return reconcileAllFromState(pi, document, context);
}
