// pi-model-manager 类型定义。
// 命名约定：
//   Stored*  → models.json 与 state.json metadata 合成后的运行时视图
//   *Draft   → TUI 编辑器中可变中间态
//   *Outcome → 异步流程结果联合类型

// ========== 基础枚举 ==========

export type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
export type ModelInputKind = "text" | "image";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
type ModelMetadataSource = "models.dev" | "openrouter" | "manual";
export type ReasoningMode = "enabled" | "disabled";
export type AnthropicThinkingProtocol = "adaptive" | "legacy";
export type BuiltInClientHeaderProfileId = "claude-code" | "codex-cli";
export type ClientHeaderProfileId = "recommended" | "disabled" | BuiltInClientHeaderProfileId | "custom";
export type CompatSettings = Record<string, unknown>;
export type OpenAIServiceTier = "priority";

export const DEFAULT_PROVIDER_HTTP_PROXY_URL = "http://127.0.0.1:7890";

// ========== 持久配置合成 schema ==========

export interface TokenCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: TokenCostTier[];
}

export interface StoredRequestHeaderProfile {
	name: string;
	headers: Record<string, string>;
}

export interface StoredClientHeaderCapture {
	capturedAt: string;
	headers: Record<string, string>;
}

export interface StoredModel {
	id: string;
	/** 仅保存相对 provider 默认值的显式模型级覆盖。 */
	api?: string;
	baseUrl?: string;
	/** 不含插件请求头 profile 所管理字段的原生模型请求头。 */
	headers?: Record<string, string>;
	name?: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ModelInputKind[];
	contextWindow: number;
	maxTokens: number;
	cost: TokenCost;
	/** 旧版模型级请求头字段，仅用于读取旧 state 后折叠到接入级。 */
	clientHeaderProfile?: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	openAIServiceTier?: OpenAIServiceTier;
	compat?: CompatSettings;
}

export interface StoredProvider {
	name: string;
	api: ApiKind;
	baseUrl: string;
	/** 运行时所有权，未接管的原生 Provider 不由插件生成请求头或动态注册。 */
	managed: boolean;
	/** 可省略；认证也可由 auth.json、/login 或 CLI --api-key 提供。 */
	apiKey?: string;
	/** models.json 中不由 TUI 编辑、但必须跨保存和重命名保真的原生字段。 */
	headers?: Record<string, string>;
	compat?: CompatSettings;
	modelOverrides?: Record<string, unknown>;
	authHeader?: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	httpProxyEnabled?: boolean;
	httpProxyUrl?: string;
	models: StoredModel[];
}

export interface StateDocument {
	version: 2;
	providers: Record<string, StoredProvider>;
	/** state.json 中明确由插件创建或接管的 Provider ID。 */
	managedProviderIds: string[];
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>;
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
}

// ========== TUI draft（可变中间态） ==========

export interface ProviderDraft {
	providerId: string;
	providerName: string;
	api: ApiKind;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	selectedIndex: number;
}

export interface ModelDraft {
	providerId: string;
	providerName: string;
	api: ApiKind;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	modelId: string;
	modelName: string;
	inputKinds: ModelInputKind[];
	metadataSource: ModelMetadataSource;
	reasoningMode: ReasoningMode;
	thinkingLevelMap?: ThinkingLevelMap;
	cost: TokenCost;
	anthropicThinkingProtocol?: AnthropicThinkingProtocol;
	contextWindow: number;
	maxTokens: number;
	openAIServiceTier?: OpenAIServiceTier;
	selectedIndex: number;
}

export interface RequestHeaderProfileDraft {
	profileId: string;
	profileName: string;
	headers: Record<string, string>;
	selectedIndex: number;
}

// ========== 异步流程结果 ==========

export type ModelListFetchOutcome =
	| { status: "loaded"; modelIds: string[] }
	| { status: "failed"; message: string }
	| { status: "cancelled" };

// ========== 常量 ==========

export const ZERO_COST: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
