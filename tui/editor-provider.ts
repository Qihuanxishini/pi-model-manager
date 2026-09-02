// tui/editor-provider.ts
//
// 接入编辑器：问答式表单（custom menu + input/select 拼装）。
// 用户可以反复编辑字段；Ctrl+S 保存，Esc 返回。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { hasStringRecordEntries } from "../common.ts";
import { t } from "../i18n.ts";
import { switchProviderDraftApiPreset } from "../presets/providers.ts";
import { redactUrlForDisplay } from "../sensitive-redaction.ts";
import { resolveRuntimeBaseUrl } from "../runtime-base-url.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL, type OpenAIChatCompatibilityMode } from "../types.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, type HorizontalDirection, type MenuCursor } from "./persistent-menu.ts";
import {
	describeProfile,
	formatApiShort,
	getApiChoices,
	getBuiltInProfileChoices,
	maskSecret,
} from "./ui-helpers.ts";
import type { ClientHeaderProfileId, ProviderDraft, StoredRequestHeaderProfile } from "../types.ts";

interface FieldRow {
	id: string;
	label: string;
	value: string;
	// 开关类字段可用 ←→ 就地切换；其余字段需要 Enter 进入输入或选择器。
	adjustable?: boolean;
}

const OPENAI_CHAT_COMPATIBILITY_MODE_ORDER: readonly OpenAIChatCompatibilityMode[] = ["standard", "compatible"];

function getOpenAIChatCompatibilityMode(draft: ProviderDraft): OpenAIChatCompatibilityMode {
	return draft.openAIChatCompatibilityMode ?? "standard";
}

function describeOpenAIChatCompatibilityMode(mode: OpenAIChatCompatibilityMode): string {
	if (mode === "compatible") return t("兼容 · system");
	return t("标准 · Pi 默认");
}

function getOpenAIChatCompatibilityModeHint(mode: OpenAIChatCompatibilityMode): string {
	if (mode === "compatible") return t("兼容模式：系统提示词强制使用 system role，适合忽略 developer 的中转。");
	return t("标准模式：保持 Pi 默认兼容判断。");
}

function cycleOpenAIChatCompatibilityMode(
	mode: OpenAIChatCompatibilityMode,
	direction: HorizontalDirection,
): OpenAIChatCompatibilityMode {
	const index = OPENAI_CHAT_COMPATIBILITY_MODE_ORDER.indexOf(mode);
	const offset = direction === "right" ? 1 : -1;
	return OPENAI_CHAT_COMPATIBILITY_MODE_ORDER[(index + offset + OPENAI_CHAT_COMPATIBILITY_MODE_ORDER.length) % OPENAI_CHAT_COMPATIBILITY_MODE_ORDER.length]!;
}

function buildRows(
	draft: ProviderDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): FieldRow[] {
	const inlineCustomProfile = draft.clientHeaderProfile === "custom"
		&& !draft.requestHeaderProfileId
		&& hasStringRecordEntries(draft.customClientHeaders);
	const profileDisplay = inlineCustomProfile
		? t("内联自定义请求头（{count}项）", { count: Object.keys(draft.customClientHeaders).length })
		: describeProfile(draft.clientHeaderProfile, draft.api, draft.requestHeaderProfileId, requestHeaderProfiles);
	const rows: FieldRow[] = [
		{ id: "api", label: t("API 协议"), value: draft.api },
		{ id: "providerId", label: t("接入 ID（必填）"), value: draft.providerId || t("<必填>") },
		{ id: "providerName", label: t("名称"), value: draft.providerName || t("<空>") },
		{ id: "baseUrl", label: "Base URL", value: draft.baseUrl },
	];
	if (draft.api === "openai-completions") {
		rows.push({
			id: "openAIChatCompatibilityMode",
			label: t("协议兼容"),
			value: describeOpenAIChatCompatibilityMode(getOpenAIChatCompatibilityMode(draft)),
			adjustable: true,
		});
	}
	rows.push(
		{ id: "httpProxyEnabled", label: t("本机代理"), value: draft.httpProxyEnabled ? t("开启") : t("关闭"), adjustable: true },
		{ id: "httpProxyUrl", label: t("代理地址"), value: draft.httpProxyEnabled ? redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL) : t("关闭时不使用") },
		{ id: "apiKey", label: "API key", value: maskSecret(draft.apiKey) },
		{ id: "authHeader", label: t("认证头"), value: draft.authHeader ? "Bearer" : t("默认") },
		{ id: "clientHeaderProfile", label: t("请求头"), value: profileDisplay },
	);
	return rows;
}



// 二值开关的两个方向都取反。
function applyHorizontalToggle(draft: ProviderDraft, fieldId: string, direction: HorizontalDirection): boolean {
	if (fieldId === "openAIChatCompatibilityMode") {
		draft.openAIChatCompatibilityMode = cycleOpenAIChatCompatibilityMode(getOpenAIChatCompatibilityMode(draft), direction);
		return true;
	}
	if (fieldId !== "httpProxyEnabled") return false;
	draft.httpProxyEnabled = !draft.httpProxyEnabled;
	if (draft.httpProxyEnabled && !draft.httpProxyUrl.trim()) draft.httpProxyUrl = DEFAULT_PROVIDER_HTTP_PROXY_URL;
	return true;
}

async function editClientHeaderProfile(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Promise<void> {
	const choices = [
		...getBuiltInProfileChoices().map((choice) => ({ id: choice.id as string, label: choice.label })),
		...Object.entries(requestHeaderProfiles)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([profileId, profile]) => ({
				id: `custom:${profileId}`,
				label: t("自定义:{id} — {name}", { id: profileId, name: profile.name }),
			})),
	];
	const currentId = draft.clientHeaderProfile === "custom" && draft.requestHeaderProfileId
		? `custom:${draft.requestHeaderProfileId}`
		: draft.clientHeaderProfile;
	const choice = await showOptionPicker(ctx, t("请求头"), choices, currentId);
	if (!choice) return;
	if (choice.id.startsWith("custom:")) {
		draft.clientHeaderProfile = "custom";
		draft.requestHeaderProfileId = choice.id.slice("custom:".length);
		return;
	}
	draft.clientHeaderProfile = choice.id as ClientHeaderProfileId;
	delete draft.requestHeaderProfileId;
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Promise<void> {
	if (fieldId === "api") {
		const choice = await showOptionPicker(ctx, t("选择 API 协议"), getApiChoices(), draft.api);
		if (choice) switchProviderDraftApiPreset(draft, choice.id);
		return;
	}
	if (fieldId === "openAIChatCompatibilityMode") {
		const choice = await showOptionPicker(
			ctx,
			t("选择协议兼容"),
			[
				{ id: "standard", label: t("标准 — 保持 Pi 默认兼容判断") },
				{ id: "compatible", label: t("兼容 — 强制 system role，适合忽略 developer 的中转") },
			],
			getOpenAIChatCompatibilityMode(draft),
		);
		if (choice) draft.openAIChatCompatibilityMode = choice.id as OpenAIChatCompatibilityMode;
		return;
	}
	if (fieldId === "authHeader") {
		const choice = await showOptionPicker(
			ctx,
			t("认证头（API key 放在哪里）"),
			[
				{ id: "default", label: t("默认 — 交给协议 SDK / 接入默认行为") },
				{ id: "bearer", label: t("Bearer — 强制 Authorization: Bearer <apiKey>") },
			],
			draft.authHeader ? "bearer" : "default",
		);
		if (choice) draft.authHeader = choice.id === "bearer";
		return;
	}
	if (fieldId === "clientHeaderProfile") {
		await editClientHeaderProfile(ctx, draft, requestHeaderProfiles);
		return;
	}
	if (fieldId === "httpProxyEnabled") {
		const choice = await showOptionPicker(
			ctx,
			t("本机代理（仅当前接入点）"),
			[
				{ id: "disabled", label: t("关闭 — 请求直连上游") },
				{ id: "enabled", label: t("开启 — 通过 {url}", { url: redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL) }) },
			],
			draft.httpProxyEnabled ? "enabled" : "disabled",
		);
		if (!choice) return;
		draft.httpProxyEnabled = choice.id === "enabled";
		if (draft.httpProxyEnabled && !draft.httpProxyUrl.trim()) draft.httpProxyUrl = DEFAULT_PROVIDER_HTTP_PROXY_URL;
		return;
	}
	if (fieldId === "providerId") {
		const value = await ctx.ui.input(
			t("接入 ID（必填，最多 48 个字符；仅字母、数字、点、下划线和连字符；当前：{current}）", { current: draft.providerId || t("<空>") }),
			draft.providerId,
		);
		if (value !== undefined) draft.providerId = value.trim();
		return;
	}
	if (fieldId === "providerName") {
		const value = await ctx.ui.input(t("名称（显示用，可留空；当前：{current}）", { current: draft.providerName || t("<空>") }), draft.providerName);
		if (value !== undefined) draft.providerName = value.trim();
		return;
	}
	if (fieldId === "httpProxyUrl") {
		const currentLabel = redactUrlForDisplay(draft.httpProxyUrl || DEFAULT_PROVIDER_HTTP_PROXY_URL);
		const value = await ctx.ui.input(t("代理地址（http/https；当前：{current}，留空保持原值）", { current: currentLabel }), "");
		if (value?.trim()) draft.httpProxyUrl = value.trim();
		return;
	}
	if (fieldId === "apiKey") {
		const currentLabel = draft.apiKey ? maskSecret(draft.apiKey) : t("<空>");
		const value = await ctx.ui.input(t("API key（可选；明文 / $ENV_VAR / !command；当前：{current}，留空清除）", { current: currentLabel }), "");
		if (value === undefined) return;
		draft.apiKey = value.trim();
		return;
	}
	// [喵喵喵]: baseUrl 是唯一走通用文本输入的字段，显式列出才能保持 draft 的类型检查。
	if (fieldId !== "baseUrl") return;
	const value = await ctx.ui.input(t("Base URL（http/https）（当前：{current}，留空保持原值）", { current: draft.baseUrl || t("<空>") }), draft.baseUrl);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	// [喵喵喵]: 当场归一化成 SDK 可直接使用的根地址，让 models.json 存的就是最终请求地址；
	// 否则插件未加载时 pi 会用未补全的值直接请求，补全结果也无法在界面上核对。
	draft.baseUrl = resolveRuntimeBaseUrl(draft.api, trimmed);
}

export type ProviderEditOutcome =
	| { action: "save"; draft: ProviderDraft }
	| { action: "cancel" };

export async function editProvider(
	ctx: ExtensionCommandContext,
	draft: ProviderDraft,
	titlePrefix: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
): Promise<ProviderEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		// [喵喵喵]: 字段行的排版在开关切换后要原样重建，抽成函数避免两处写法飘移。
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.value}`,
			adjustable: row.adjustable,
		}));
		const rows = buildRows(draft, requestHeaderProfiles);
		const menuRows = toMenuRows(rows);
		const getSummaryLines = (): string[] => {
			const summaryLines = [
				`API ${formatApiShort(draft.api)} · ${t("请求头")} ${describeProfile(draft.clientHeaderProfile, draft.api, draft.requestHeaderProfileId, requestHeaderProfiles)}`,
				t("接入 ID 必填，且不能与已有或 pi 内置接入重复"),
				t("Ctrl+S 保存并同步 models.json；不切换当前会话模型"),
			];
			if (draft.api === "openai-completions") {
				summaryLines.push(getOpenAIChatCompatibilityModeHint(getOpenAIChatCompatibilityMode(draft)));
			}
			return summaryLines;
		};
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				getSummaryLines,
				onAdjust: (id, direction) => {
					if (!applyHorizontalToggle(draft, id, direction)) return undefined;
					return toMenuRows(buildRows(draft, requestHeaderProfiles));
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "←→", label: t("切换选项") },
					{ key: "Enter", label: t("编辑") },
					{ key: "Ctrl+S", label: t("保存并同步") },
					{ key: "Esc", label: t("返回") },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id, requestHeaderProfiles);
	}
}
