// tui/editor-model.ts
//
// 模型编辑器：与 editor-provider 同款问答式表单。
// 关键差异：
//   - 请求头已经收敛到接入级；模型编辑器只编辑模型自身能力
//   - 提供"从上游拉取模型 ID 列表"入口（OpenAI/Anthropic/Google）
//   - 视觉支持用开关式 select，保存时仍映射为 text / text,image

import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.ts";
import type { AnthropicThinkingProtocol, BuiltInClientHeaderProfileId, ModelDraft, ModelListFetchOutcome, ReasoningMode, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { fetchModelIds } from "./model-list-fetch.ts";
import { pickModelIdFromList } from "./model-picker.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, type MenuCursor } from "./persistent-menu.ts";
import {
	describeVisionInput,
	formatApiShort,
	getVisionInputChoices,
	supportsVisionInput,
} from "./ui-helpers.ts";

interface FieldRow {
	id: string;
	label: string;
	value: string;
	// 开关类字段可用 ←→ 就地切换；其余字段需要 Enter 进入输入或选择器。
	adjustable?: boolean;
}


function shouldShowOpenAIServiceTier(draft: ModelDraft): boolean {
	return draft.api === "openai-responses";
}

function shouldShowAnthropicThinkingProtocol(draft: ModelDraft): boolean {
	return draft.reasoningMode === "enabled" && draft.anthropicThinkingProtocol !== undefined;
}


function describeReasoningMode(mode: ReasoningMode): string {
	return mode === "enabled" ? t("开启") : t("关闭");
}

function describeAnthropicThinkingProtocol(protocol: AnthropicThinkingProtocol): string {
	return protocol === "adaptive" ? t("开启 · 新版协议") : t("关闭 · Legacy");
}

function describeOpenAIServiceTier(draft: ModelDraft): string {
	return draft.openAIServiceTier === "priority" ? t("开启 · priority") : t("关闭");
}

function getIntegerFieldLabel(field: "contextWindow" | "maxTokens"): string {
	return field === "contextWindow" ? t("上下文窗口") : t("最大输出");
}


// 开关字段在两个方向上都是取反，因此不看 direction；返回是否真的切换了字段。
function applyHorizontalToggle(draft: ModelDraft, fieldId: string): boolean {
	if (fieldId === "visionInput") {
		draft.inputKinds = supportsVisionInput(draft.inputKinds) ? ["text"] : ["text", "image"];
		return true;
	}
	if (fieldId === "reasoning") {
		draft.reasoningMode = draft.reasoningMode === "enabled" ? "disabled" : "enabled";
		return true;
	}
	if (fieldId === "anthropicThinkingProtocol") {
		draft.anthropicThinkingProtocol = draft.anthropicThinkingProtocol === "adaptive" ? "legacy" : "adaptive";
		return true;
	}
	if (fieldId === "openAIServiceTier") {
		draft.openAIServiceTier = draft.openAIServiceTier === "priority" ? undefined : "priority";
		return true;
	}
	return false;
}

function buildRows(draft: ModelDraft): FieldRow[] {
	const rows: FieldRow[] = [
		{ id: "modelId", label: t("模型 ID"), value: draft.modelId || t("<未填写>") },
		{ id: "fetch", label: t("重新拉取"), value: t("上游模型列表") },
		{ id: "modelName", label: t("显示名称"), value: draft.modelName || t("默认 = 模型 ID") },
		{ id: "metadataSource", label: t("元数据源"), value: draft.metadataSource === "manual" ? t("关闭（保留手工值）") : draft.metadataSource },
		{ id: "visionInput", label: t("视觉支持"), value: describeVisionInput(draft.inputKinds), adjustable: true },
		{ id: "reasoning", label: "Thinking", value: describeReasoningMode(draft.reasoningMode), adjustable: true },
	];
	if (shouldShowAnthropicThinkingProtocol(draft)) {
		rows.push({
			id: "anthropicThinkingProtocol",
			label: "Adaptive",
			value: describeAnthropicThinkingProtocol(draft.anthropicThinkingProtocol!),
			adjustable: true,
		});
	}
	if (shouldShowOpenAIServiceTier(draft)) {
		rows.push({ id: "openAIServiceTier", label: "Fast mode", value: describeOpenAIServiceTier(draft), adjustable: true });
	}
	rows.push(
		{ id: "contextWindow", label: t("上下文窗口"), value: String(draft.contextWindow) },
		{ id: "maxTokens", label: t("最大输出"), value: String(draft.maxTokens) },
	);
	return rows;
}

function getSelectedCustomHeaders(
	draft: ModelDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Record<string, string> {
	if (draft.clientHeaderProfile !== "custom" || !draft.requestHeaderProfileId) return {};
	return requestHeaderProfiles[draft.requestHeaderProfileId]?.headers ?? {};
}

async function pickModelFromUpstream(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	const params = {
		providerId: draft.providerId,
		api: draft.api,
		baseUrl: draft.baseUrl,
		apiKey: draft.apiKey,
		authHeader: draft.authHeader,
		clientHeaderProfile: draft.clientHeaderProfile,
		customClientHeaders: getSelectedCustomHeaders(draft, requestHeaderProfiles),
		httpProxyEnabled: draft.httpProxyEnabled,
		httpProxyUrl: draft.httpProxyUrl,
		clientHeaderCaptures,
	};
	const outcome = await ctx.ui.custom<ModelListFetchOutcome>((tui, theme, _keybindings, done) => {
		const loader = new BorderedLoader(tui, theme, t("正在拉取模型列表，总计最多 10 秒…"), { cancellable: true });
		let settled = false;
		const finish = (result: ModelListFetchOutcome) => {
			if (settled) return;
			settled = true;
			done(result);
		};
		loader.onAbort = () => finish({ status: "cancelled" });
		fetchModelIds(params, loader.signal)
			.then(finish)
			.catch((error) => finish({ status: "failed", message: error instanceof Error ? error.message : String(error) }));
		return loader;
	});
	if (outcome.status === "cancelled") return;
	if (outcome.status === "failed") {
		ctx.ui.notify(t("拉取失败：{error}", { error: outcome.message }), "warning");
		const fallback = await ctx.ui.input(t("手动输入模型 ID（当前：{current}）", { current: draft.modelId || t("<空>") }), draft.modelId);
		if (fallback !== undefined) {
			draft.modelId = fallback.trim() || draft.modelId;
		}
		return;
	}
	if (outcome.modelIds.length === 0) {
		ctx.ui.notify(t("上游返回空列表"), "warning");
		return;
	}
	const picked = await pickModelIdFromList(
		ctx,
		t("选择模型 ID（共 {count} 个）", { count: outcome.modelIds.length }),
		outcome.modelIds,
		draft.modelId,
	);
	if (picked) {
		draft.modelId = picked;
	}
}

async function editIntField(ctx: ExtensionCommandContext, draft: ModelDraft, field: "contextWindow" | "maxTokens"): Promise<void> {
	const label = getIntegerFieldLabel(field);
	const current = String(draft[field]);
	const value = await ctx.ui.input(t("{label}（当前：{current}，留空保持原值）", { label, current }), current);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) return;
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify(t("{label} 必须是正整数", { label }), "warning");
		return;
	}
	draft[field] = parsed;
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
): Promise<void> {
	if (fieldId === "modelId") {
		const value = await ctx.ui.input(t("模型 ID（当前：{current}，传给上游 API 的模型字段）", { current: draft.modelId || t("<空>") }), draft.modelId);
		if (value !== undefined) {
			const trimmed = value.trim();
			if (trimmed) {
				draft.modelId = trimmed;
			}
		}
		return;
	}
	if (fieldId === "fetch") {
		await pickModelFromUpstream(ctx, draft, requestHeaderProfiles, clientHeaderCaptures);
		return;
	}
	if (fieldId === "modelName") {
		const value = await ctx.ui.input(t("显示名称（当前：{current}，可空默认用模型 ID；输入空格清空）", { current: draft.modelName || t("<空>") }), draft.modelName);
		if (value !== undefined) draft.modelName = value.trim();
		return;
	}
	if (fieldId === "metadataSource") {
		const choice = await showOptionPicker(ctx, t("选择模型元数据源"), [
			{ id: "models.dev", label: "models.dev" },
			{ id: "openrouter", label: "OpenRouter" },
			{ id: "manual", label: t("关闭（保留手工值）") },
		], draft.metadataSource);
		if (choice) draft.metadataSource = choice.id as ModelDraft["metadataSource"];
		return;
	}
	if (fieldId === "visionInput") {
		const choices = getVisionInputChoices().map((choice) => ({
			id: choice.enabled ? "enabled" : "disabled",
			label: choice.label,
			kinds: choice.kinds,
		}));
		const choice = await showOptionPicker(ctx, t("视觉支持"), choices, supportsVisionInput(draft.inputKinds) ? "enabled" : "disabled");
		if (choice) draft.inputKinds = [...choice.kinds];
		return;
	}
	if (fieldId === "reasoning") {
		const choice = await showOptionPicker(
			ctx,
			"Thinking",
			[
				{ id: "disabled" as ReasoningMode, label: t("关闭 — 不发送模型推理参数") },
				{ id: "enabled" as ReasoningMode, label: t("开启 — 启用模型推理参数") },
			],
			draft.reasoningMode,
		);
		if (choice) draft.reasoningMode = choice.id;
		return;
	}
	if (fieldId === "anthropicThinkingProtocol") {
		const choice = await showOptionPicker(
			ctx,
			"Adaptive",
			[
				{ id: "adaptive" as AnthropicThinkingProtocol, label: t("开启：新版模型，发送 thinking.type=adaptive 和 output_config.effort") },
				{ id: "legacy" as AnthropicThinkingProtocol, label: t("关闭：旧版接口，发送 thinking.type=enabled 和 budget_tokens") },
			],
			draft.anthropicThinkingProtocol ?? "legacy",
		);
		if (choice) draft.anthropicThinkingProtocol = choice.id;
		return;
	}
	if (fieldId === "openAIServiceTier") {
		const choice = await showOptionPicker(
			ctx,
			"Fast mode",
			[
				{ id: "disabled", tier: undefined, label: t("关闭 — 不发送 service_tier（默认）") },
				{ id: "priority", tier: "priority", label: t("开启 — service_tier=priority，可能消耗 Fast / priority 额度") },
			] as const satisfies readonly { id: string; tier: ModelDraft["openAIServiceTier"]; label: string }[],
			draft.openAIServiceTier === "priority" ? "priority" : "disabled",
		);
		if (choice) draft.openAIServiceTier = choice.tier;
		return;
	}
	if (fieldId === "contextWindow" || fieldId === "maxTokens") {
		await editIntField(ctx, draft, fieldId);
	}
}

export type ModelEditOutcome =
	| { action: "save"; draft: ModelDraft }
	| { action: "cancel" };

export async function editModel(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	titlePrefix: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
): Promise<ModelEditOutcome> {
	if (!draft.modelId.trim()) {
		await pickModelFromUpstream(ctx, draft, requestHeaderProfiles, clientHeaderCaptures);
	}
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		// [喵喵喵]: 字段行的排版在开关切换后要原样重建，抽成函数避免两处写法飘移。
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.value}`,
			adjustable: row.adjustable,
		}));
		const rows = buildRows(draft);
		const menuRows = toMenuRows(rows);
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				summaryLines: [
					t("接入 {providerId} · API {api}", { providerId: draft.providerId, api: formatApiShort(draft.api) }),
					t("Ctrl+S 保存并启用模型；不切换当前会话模型"),
				],
				onAdjust: (id) => {
					if (!applyHorizontalToggle(draft, id)) return undefined;
					return toMenuRows(buildRows(draft));
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "←→", label: t("切换选项") },
					{ key: "Enter", label: t("编辑") },
					{ key: "Ctrl+S", label: t("保存并启用") },
					{ key: "Esc", label: t("返回") },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id, requestHeaderProfiles, clientHeaderCaptures);
	}
}
