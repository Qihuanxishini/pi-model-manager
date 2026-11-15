// 将配置交给 Pi 构造原生 Provider，插件仅包装其请求传输。

import { ModelRuntime, type ExtensionAPI, type ProviderConfig } from "@earendil-works/pi-coding-agent";
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
const REGISTERED_PROVIDER_CONFIGS = new Map<string, Provider>();
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

async function buildNativeProvider(providerId: string, provider: StoredProvider, config: ProviderConfig): Promise<Provider> {
	// [喵喵喵]: 复用 Pi 的认证解析与多协议分派；临时 runtime 不读取用户认证或模型文件，也不刷新网络目录。
	const runtime = await ModelRuntime.create({ credentials: emptyCredentialStore, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	runtime.registerProvider(providerId, config);
	const native = runtime.getProvider(providerId);
	if (!native) throw new Error(t("无法构建接入：{providerId}", { providerId }));
	return createProviderTransport(native, provider);
}

function createRefreshableProvider(providerId: string, native: Provider): Provider {
	let current: Provider | undefined = native;
	let refreshedState: StateDocument | undefined;
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
	return {
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
			if (state === refreshedState) return;
			const provider = state.providers[providerId];
			const next = provider?.managed && provider.models.length > 0
				? await buildNativeProvider(providerId, provider, buildProviderConfig(provider, state.requestHeaderProfiles, state.clientHeaderCaptures))
				: undefined;
			// [喵喵喵]: 原生刷新保留 provider 实例；目录、认证和传输必须经同一次 generation 校验后切换，不另写模型缓存。
			await context.publish({ update: () => { current = next; refreshedState = state; } });
		},
		stream: forward(false) as Provider["stream"],
		streamSimple: forward(true),
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
	const effectiveCompat = mergeCompatSettings(provider.compat, model.compat);
	const profileHeaders = getClientHeadersForProfile(
		provider.clientHeaderProfile,
		effectiveApi,
		customHeaders,
		clientHeaderCaptures,
		effectiveCompat,
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
	const wasRegistered = REGISTERED_PROVIDER_CONFIGS.delete(providerId);
	if (wasRegistered) pi.unregisterProvider(providerId);
}

async function canRegisterManagedProvider(providerId: string, provider: StoredProvider): Promise<boolean> {
	return provider.managed && provider.models.length > 0 && !(await isBuiltinProviderId(providerId));
}

function replaceManagedProviderConfig(
	pi: ExtensionAPI,
	providerId: string,
	nextConfig: Provider,
): void {
	const previousConfig = REGISTERED_PROVIDER_CONFIGS.get(providerId);
	try {
		if (previousConfig) pi.unregisterProvider(providerId);
		pi.registerProvider(nextConfig);
		REGISTERED_PROVIDER_CONFIGS.set(providerId, nextConfig);
	} catch (error) {
		let rollbackError: unknown;
		try {
			if (previousConfig) {
				pi.unregisterProvider(providerId);
				pi.registerProvider(previousConfig);
				REGISTERED_PROVIDER_CONFIGS.set(providerId, previousConfig);
			} else {
				REGISTERED_PROVIDER_CONFIGS.delete(providerId);
			}
		} catch (restoreError) {
			rollbackError = restoreError;
		}
		const rollbackNote = rollbackError
			? t("；恢复上一版 runtime 也失败：{error}", { error: formatUnknownError(rollbackError) })
			: previousConfig
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
	replaceManagedProviderConfig(pi, providerId, createRefreshableProvider(providerId, native));
}

async function reconcileAllFromState(
	pi: ExtensionAPI,
	document: StateDocument,
): Promise<string[]> {
	const warnings: string[] = [];
	const activeProviderIds = new Set(
		[...document.managedProviderIds].filter((providerId) => document.providers[providerId]?.managed),
	);
	for (const providerId of REGISTERED_PROVIDER_CONFIGS.keys()) {
		if (!activeProviderIds.has(providerId)) unregisterManagedProvider(pi, providerId);
	}
	for (const [providerId, provider] of Object.entries(document.providers)) {
		try {
			await reconcileProvider(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
		} catch (error) {
			warnings.push(`${providerId}: ${formatUnknownError(error)}`);
		}
	}
	return warnings;
}

/** factory 阶段仅注册模型 catalog，不启动长生命周期本地代理。 */
export async function registerCatalogFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document);
}

/** session_start 激活当前 state 的完整 provider transport。 */
export async function registerAllFromState(pi: ExtensionAPI, document: StateDocument): Promise<string[]> {
	return reconcileAllFromState(pi, document);
}
