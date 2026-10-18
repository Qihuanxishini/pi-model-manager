// tui/ui-helpers.ts
//
// 共用展示助手：把 stored / draft 数据格式化成 UI 字符串。
//
// dashboard 行设计准则：信息密度千万不要满。
//   - 主列表使用固定列 + 选中详情；行内只放扫描所需信息
//   - api 用短标签（Responses / Claude），详情区再显示完整上下文
//   - auth 状态文本化为 key/env/cmd/auth?，避免把可选的外部认证误报成缺失
//   - contextWindow 用 K/M 简写

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n.ts";
import { getApiKeyEnvVarName, getAuthStatusText, getProviderDisplayName } from "../state-document.ts";
import { getClientHeaderProfileDisplay, getClientHeaderProfileLabel, resolveClientHeaderProfile } from "../presets/client-headers.ts";
import { redactUrlForDisplay } from "../sensitive-redaction.ts";
import type {
	ApiKind,
	ClientHeaderProfileId,
	ModelInputKind,
	OpenAIServiceTier,
	StoredModel,
	StoredProvider,
	StoredRequestHeaderProfile,
} from "../types.ts";
import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";

export function maskSecret(value: string | undefined): string {
	if (!value) return t("<未填写>");
	if (getApiKeyEnvVarName(value) || value.startsWith("!")) return value;
	return "********";
}
function formatContextWindow(contextWindow: number): string {
	if (contextWindow >= 1_000_000) return `${(contextWindow / 1_000_000).toFixed(contextWindow % 1_000_000 === 0 ? 0 : 1)}M`;
	if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}K`;
	return String(contextWindow);
}


type ColumnAlign = "left" | "right";

interface FixedColumn {
	text: string;
	width: number;
	align?: ColumnAlign;
	color?: ThemeColor;
}

export function fitColumn(text: string, columns: number, align: ColumnAlign = "left"): string {
	const clipped = truncateToWidth(text, columns, "…");
	const pad = " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
	return align === "right" ? pad + clipped : clipped + pad;
}

// [喵喵喵]: 先按纯文本对齐再着色；反过来会让列宽计算受 ANSI 序列干扰。
function joinFixedColumns(columns: readonly FixedColumn[], theme?: Theme, gap = "  "): string {
	return columns
		.map((column) => {
			const cell = fitColumn(column.text, column.width, column.align);
			return theme && column.color ? theme.fg(column.color, cell) : cell;
		})
		.join(gap)
		.trimEnd();
}

function formatTableHeader(line: string): string {
	return `  ${line}`;
}

export function formatApiShort(api: ApiKind): string {
	if (api === "openai-responses") return "Responses";
	if (api === "openai-completions") return "Chat";
	if (api === "anthropic-messages") return "Claude";
	if (api === "google-generative-ai") return "Gemini";
	return api;
}

function getAuthKind(apiKey: string | undefined): string {
	const status = getAuthStatusText(apiKey);
	if (status === "no apiKey") return "auth?";
	if (status === "command apiKey") return "cmd";
	if (status.startsWith("env missing:")) return "miss";
	if (status.startsWith("env ")) return "env";
	return "key";
}

function getProviderStatus(provider: StoredProvider): string {
	const auth = getAuthKind(provider.apiKey);
	return auth === "miss" || auth === "auth?" ? "check" : "ready";
}

function getProviderProxyText(provider: StoredProvider): string {
	return provider.httpProxyEnabled ? "proxy" : "direct";
}

function formatProviderHeaderProfile(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	if (provider.clientHeaderProfile === "recommended") {
		const resolved = resolveClientHeaderProfile(provider.clientHeaderProfile, provider.api);
		return `Auto→${getClientHeaderProfileLabel(resolved)}`;
	}
	if (provider.clientHeaderProfile === "disabled") return "Off";
	if (provider.clientHeaderProfile === "custom") {
		if (provider.requestHeaderProfileId) {
			const profile = requestHeaderProfiles[provider.requestHeaderProfileId];
			return profile ? `Custom:${profile.name}` : `Custom:${provider.requestHeaderProfileId}`;
		}
		const inlineCount = Object.keys(provider.customClientHeaders ?? {}).length;
		return inlineCount > 0 ? `Inline(${inlineCount})` : "Custom?";
	}
	return getClientHeaderProfileLabel(provider.clientHeaderProfile);
}

interface ProviderConsoleCells {
	provider: string;
	api: string;
	models: string;
	headers: string;
	proxy: string;
	auth: string;
	status: string;
}

export interface ProviderTableOptions {
	requestHeaderProfiles?: Record<string, StoredRequestHeaderProfile>;
	theme?: Theme;
	// 按当前数据收敛后的接入列宽；表头与数据行必须传同一个值才能对齐。
	nameWidth?: number;
}

const PROVIDER_NAME_COLUMN_LIMIT = 22;
const PROVIDER_NAME_COLUMN_MIN = 12;

export function getProviderDisplayLabel(providerId: string, provider: StoredProvider): string {
	const name = getProviderDisplayName(providerId, provider);
	return name === providerId ? providerId : `${name} (${providerId})`;
}

export function getProviderNameColumnWidth(displayLabels: readonly string[]): number {
	const longest = displayLabels.reduce((max, label) => Math.max(max, visibleWidth(label)), 0);
	return Math.min(PROVIDER_NAME_COLUMN_LIMIT, Math.max(PROVIDER_NAME_COLUMN_MIN, longest));
}

function getAuthColor(auth: string): ThemeColor | undefined {
	return auth === "miss" || auth === "auth?" ? "warning" : undefined;
}

function getProviderConsoleColumns(cells: ProviderConsoleCells, availableWidth: number, nameWidth: number): FixedColumn[] {
	const provider: FixedColumn = { text: cells.provider, width: Math.min(nameWidth, PROVIDER_NAME_COLUMN_LIMIT) };
	const api: FixedColumn = { text: cells.api, width: 9 };
	const models: FixedColumn = { text: cells.models, width: 6, align: "right" };
	const headers: FixedColumn = { text: cells.headers, width: 15, color: cells.headers === "Off" ? "dim" : undefined };
	const proxy: FixedColumn = { text: cells.proxy, width: 6, color: cells.proxy === "proxy" ? "accent" : "dim" };
	const auth: FixedColumn = { text: cells.auth, width: 6, color: getAuthColor(cells.auth) };
	const status: FixedColumn = { text: cells.status, width: 5, color: cells.status === "ready" ? "success" : "warning" };
	if (availableWidth >= 81) return [provider, api, models, headers, proxy, auth, status];
	if (availableWidth >= 64) return [provider, api, models, proxy, auth, status];
	if (availableWidth >= 48) return [provider, api, models, status];
	return [{ ...provider, width: Math.max(10, availableWidth - 26) }, api, models, status];
}

export function formatProviderConsoleHeader(menuWidth: number, options: ProviderTableOptions = {}): string {
	return formatTableHeader(joinFixedColumns(getProviderConsoleColumns({
		provider: t("接入"),
		api: "API",
		models: t("模型"),
		headers: t("请求头"),
		proxy: t("代理"),
		auth: t("认证"),
		status: t("状态"),
	}, Math.max(0, menuWidth - 2), options.nameWidth ?? PROVIDER_NAME_COLUMN_LIMIT)));
}

export function formatProviderConsoleRow(
	providerId: string,
	provider: StoredProvider,
	availableWidth = 81,
	options: ProviderTableOptions = {},
): string {
	return joinFixedColumns(getProviderConsoleColumns({
		provider: getProviderDisplayLabel(providerId, provider),
		api: formatApiShort(provider.api),
		models: String(provider.models.length),
		headers: formatProviderHeaderProfile(provider, options.requestHeaderProfiles ?? {}),
		proxy: getProviderProxyText(provider),
		auth: getAuthKind(provider.apiKey),
		status: getProviderStatus(provider),
	}, availableWidth, options.nameWidth ?? PROVIDER_NAME_COLUMN_LIMIT), options.theme);
}

// [喵喵喵]: 详情区分三级（标题/字段名/值），否则整块同一灰度无法扫读；
// 缩进与标签列宽必须在所有面板一致，否则切面板时详情区会跳动。
const DETAIL_LABEL_WIDTH = 10;

export function formatDetailTitle(title: string, theme?: Theme): string {
	return theme ? theme.fg("text", title) : title;
}

export function formatDetailField(label: string, value: string, theme?: Theme): string {
	const labelCell = `  ${fitColumn(label, DETAIL_LABEL_WIDTH)}`;
	return theme ? `${theme.fg("dim", labelCell)}${theme.fg("text", value)}` : `${labelCell}${value}`;
}

export function formatProviderDetailLines(
	providerId: string,
	provider: StoredProvider,
	options: ProviderTableOptions = {},
): string[] {
	const { theme, requestHeaderProfiles = {} } = options;
	const modelIds = provider.models.map((model) => model.id).join(", ") || t("<无模型>");
	return [
		formatDetailTitle(getProviderDisplayLabel(providerId, provider), theme),
		formatDetailField("endpoint", redactUrlForDisplay(provider.baseUrl), theme),
		formatDetailField("proxy", provider.httpProxyEnabled ? redactUrlForDisplay(provider.httpProxyUrl ?? "http://127.0.0.1:7890") : "direct", theme),
		formatDetailField("api", `${formatApiShort(provider.api)} · headers ${formatProviderHeaderProfile(provider, requestHeaderProfiles)} · auth ${getAuthKind(provider.apiKey)}`, theme),
		formatDetailField("models", modelIds, theme),
	];
}

export function formatProviderSummaryLine(
	provider: StoredProvider,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	return `${formatApiShort(provider.api)} · ${provider.models.length} ${t("模型")} · headers ${formatProviderHeaderProfile(provider, requestHeaderProfiles)} · proxy ${getProviderProxyText(provider)} · auth ${getAuthKind(provider.apiKey)}`;
}

export function formatProviderEndpointLine(provider: StoredProvider): string {
	const proxy = provider.httpProxyEnabled ? ` · proxy ${redactUrlForDisplay(provider.httpProxyUrl ?? "http://127.0.0.1:7890")}` : "";
	return `endpoint  ${redactUrlForDisplay(provider.baseUrl)}${proxy}`;
}

function formatModelNameCell(model: StoredModel): string {
	return model.name && model.name !== model.id ? model.name : t("默认");
}

function formatModelInputCell(model: StoredModel): string {
	return model.input.includes("image") ? t("文本,视觉") : t("文本");
}

function formatModelThinkingCell(model: StoredModel): string {
	return model.reasoning ? t("开") : t("关");
}

export function formatOpenAIServiceTier(tier: OpenAIServiceTier | undefined): string {
	if (tier === "priority") return "Fast";
	if (tier === "ultrafast") return "Ultrafast";
	return t("标准");
}

interface ModelListCells {
	modelId: string;
	name: string;
	input: string;
	thinking: string;
	context: string;
	output: string;
	fast: string;
}

export interface ModelTableOptions {
	theme?: Theme;
	// 按当前数据收敛后的列宽；表头与数据行必须传同一组值才能对齐。
	modelIdWidth?: number;
	nameWidth?: number;
}

const MODEL_ID_COLUMN_LIMIT = 30;
const MODEL_ID_COLUMN_MIN = 14;
const MODEL_NAME_COLUMN_LIMIT = 16;
const MODEL_NAME_COLUMN_MIN = 8;

export function getModelColumnWidths(models: readonly StoredModel[]): Required<Pick<ModelTableOptions, "modelIdWidth" | "nameWidth">> {
	let longestId = 0;
	let longestName = 0;
	for (const model of models) {
		longestId = Math.max(longestId, visibleWidth(model.id));
		longestName = Math.max(longestName, visibleWidth(formatModelNameCell(model)));
	}
	return {
		modelIdWidth: Math.min(MODEL_ID_COLUMN_LIMIT, Math.max(MODEL_ID_COLUMN_MIN, longestId)),
		nameWidth: Math.min(MODEL_NAME_COLUMN_LIMIT, Math.max(MODEL_NAME_COLUMN_MIN, longestName)),
	};
}

function getModelListColumns(
	provider: StoredProvider,
	cells: ModelListCells,
	availableWidth: number,
	options: ModelTableOptions,
): FixedColumn[] {
	const modelIdWidth = options.modelIdWidth ?? MODEL_ID_COLUMN_LIMIT;
	const nameWidth = options.nameWidth ?? MODEL_NAME_COLUMN_LIMIT;
	const name: FixedColumn = { text: cells.name, width: nameWidth, color: cells.name === t("默认") ? "dim" : undefined };
	const input: FixedColumn = { text: cells.input, width: 10, color: cells.input === t("文本,视觉") ? "accent" : undefined };
	const thinking: FixedColumn = { text: cells.thinking, width: 8, color: cells.thinking === t("开") ? "accent" : cells.thinking === t("关") ? "dim" : undefined };
	const context: FixedColumn = { text: cells.context, width: 7, align: "right" };
	const output: FixedColumn = { text: cells.output, width: 7, align: "right" };
	// [喵喵喵]: priority / ultrafast 都可能额外计费，用 warning 提醒而不是当普通开关。
	const fast: FixedColumn = { text: cells.fast, width: 8, color: cells.fast === "Fast" || cells.fast === "Ultrafast" ? "warning" : cells.fast === t("标准") ? "dim" : undefined };

	const fullWidth = provider.api === "openai-responses" ? 98 : 88;
	if (availableWidth >= fullWidth) {
		const columns: FixedColumn[] = [
			{ text: cells.modelId, width: Math.min(modelIdWidth, 30) },
			{ ...name, width: Math.min(nameWidth, 16) },
			input,
			thinking,
			context,
			output,
		];
		if (provider.api === "openai-responses") columns.push(fast);
		return columns;
	}
	if (availableWidth >= 75) {
		return [
			{ text: cells.modelId, width: Math.min(modelIdWidth, 28) },
			{ ...name, width: Math.min(nameWidth, 14) },
			input,
			thinking,
			context,
		];
	}
	if (availableWidth >= 57) {
		return [{ text: cells.modelId, width: Math.min(modelIdWidth, 26) }, input, thinking, context];
	}
	return [{ text: cells.modelId, width: Math.max(10, availableWidth - 22) }, input, thinking];
}

function getModelListCells(model?: StoredModel): ModelListCells {
	return model
		? {
			modelId: model.id,
			name: formatModelNameCell(model),
			input: formatModelInputCell(model),
			thinking: formatModelThinkingCell(model),
			context: formatContextWindow(model.contextWindow),
			output: formatContextWindow(model.maxTokens),
			fast: formatOpenAIServiceTier(model.openAIServiceTier),
		}
		: {
			modelId: t("模型 ID"),
			name: t("显示名"),
			input: t("输入"),
			thinking: "Thinking",
			context: t("上下文"),
			output: t("输出"),
			fast: "Fast",
		};
}

export function formatModelListHeader(provider: StoredProvider, menuWidth = 100, options: ModelTableOptions = {}): string {
	return formatTableHeader(joinFixedColumns(getModelListColumns(provider, getModelListCells(), Math.max(0, menuWidth - 2), options)));
}

export function formatModelListRow(
	provider: StoredProvider,
	model: StoredModel,
	availableWidth = 98,
	options: ModelTableOptions = {},
): string {
	return joinFixedColumns(getModelListColumns(provider, getModelListCells(model), availableWidth, options), options.theme);
}

export function getApiChoices(): { id: ApiKind; label: string }[] {
	return [
		{ id: "openai-responses", label: t("OpenAI Responses · 标准 instructions/input wire") },
		{ id: "openai-completions", label: t("OpenAI Chat · 传统 chat/completions 兼容") },
		{ id: "anthropic-messages", label: t("Anthropic Messages · Claude / Claude Code 兼容") },
		{ id: "google-generative-ai", label: t("Google Gemini · Gemini 原生 API") },
	];
}

export function getBuiltInProfileChoices(): { id: Exclude<ClientHeaderProfileId, "custom">; label: string }[] {
	return [
		{ id: "recommended", label: t("自动推荐") },
		{ id: "disabled", label: t("不添加") },
		{ id: "claude-code", label: "ClaudeCode" },
		{ id: "codex-cli", label: "Codex" },
	];
}

export function describeProfile(
	profile: ClientHeaderProfileId,
	api: ApiKind,
	requestHeaderProfileId?: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): string {
	if (profile !== "custom") return getClientHeaderProfileDisplay(profile, api);
	if (!requestHeaderProfileId) return t("自定义请求头（未选择）");
	const selected = requestHeaderProfiles[requestHeaderProfileId];
	return selected ? `${selected.name} (${requestHeaderProfileId})` : t("自定义请求头缺失：{id}", { id: requestHeaderProfileId });
}

export function getVisionInputChoices(): { enabled: boolean; kinds: ModelInputKind[]; label: string }[] {
	return [
		{ enabled: false, kinds: ["text"], label: t("关闭 — 仅文本输入") },
		{ enabled: true, kinds: ["text", "image"], label: t("开启 — 文本 + 图片输入") },
	];
}

export function supportsVisionInput(kinds: ModelInputKind[]): boolean {
	return kinds.includes("image");
}

// 字段名已经说明了含义，值只需要跟 Thinking / Fast mode 一样给出开关状态。
export function describeVisionInput(kinds: ModelInputKind[]): string {
	return supportsVisionInput(kinds) ? t("开启") : t("关闭");
}
