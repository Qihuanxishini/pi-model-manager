// tui/editor-model.ts
//
// 模型编辑器：与 editor-provider 同款问答式表单。
// 关键差异：
//   - 请求头已经收敛到接入级；模型编辑器只编辑模型自身能力
//   - 提供"从上游拉取模型 ID 列表"入口（OpenAI/Anthropic/Google）
//   - 视觉支持用开关式 select，保存时仍映射为 text / text,image

import { BorderedLoader, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, resolveAutoCompactionReserve, resolveCompactionReserveChoice } from "../compaction-settings.ts";
import { t } from "../i18n.ts";
import { resolveProviderCustomHeaders } from "../presets/client-headers.ts";
import type { AnthropicThinkingProtocol, BuiltInClientHeaderProfileId, CompactionReserveChoice, ModelDraft, ModelListFetchOutcome, ReasoningMode, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { fetchModelIds } from "./model-list-fetch.ts";
import { pickModelIdFromList } from "./model-picker.ts";
import { showOptionPicker, showPersistentFormMenu, padLabel, markAdjustableValue, type MenuCursor, type HorizontalDirection } from "./persistent-menu.ts";
import {
	describeVisionInput,
	formatApiShort,
	formatOpenAIServiceTier,
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

function getIntegerFieldLabel(field: "contextWindow" | "maxTokens"): string {
	return field === "contextWindow" ? t("上下文窗口") : t("最大输出");
}


// [喵喵喵]: 上下文窗口常用十进制档位 (128k ~ 500k)
export const CONTEXT_WINDOW_PRESETS: readonly number[] = [
	128_000,
	200_000,
	256_000,
	272_000,
	300_000,
	400_000,
	500_000,
];

// [喵喵喵]: 输出上限与上下文统一十进制档位 (16k ~ 128k)；宁小勿大——写小仅封顶略低，写超真实上限会被 API 直接拒绝
export const MAX_TOKENS_PRESETS: readonly number[] = [
	16_000,
	32_000,
	64_000,
	128_000,
];

// [喵喵喵]: 压缩预留的固定档位。预留越大，自动压缩越早发生。
export const COMPACTION_RESERVE_PRESETS: readonly number[] = [
	16_384,
	32_768,
	65_536,
	131_072,
	200_000,
];

// 档位序列：全局（不写模型级覆盖）→ auto（按上下文窗口算）→ 固定 token。
// auto 是档位而不是数值，所以改上下文窗口时预留天然跟着变，不需要额外重算。
const COMPACTION_RESERVE_STOPS: readonly CompactionReserveChoice[] = ["global", "auto", ...COMPACTION_RESERVE_PRESETS];

function cycleCompactionReserve(draft: ModelDraft, direction: HorizontalDirection): void {
	const current = draft.compactionReserve ?? "global";
	const index = COMPACTION_RESERVE_STOPS.indexOf(current);
	if (index >= 0) {
		const offset = direction === "left" ? -1 : 1;
		draft.compactionReserve = COMPACTION_RESERVE_STOPS[(index + offset + COMPACTION_RESERVE_STOPS.length) % COMPACTION_RESERVE_STOPS.length]!;
		return;
	}
	// 手填值不在档位上：按数值吸附到相邻固定档位，与上下文窗口/输出上限的手感一致。
	draft.compactionReserve = cycleNumericPreset(current as number, COMPACTION_RESERVE_PRESETS, direction);
}

export function cycleNumericPreset(
	current: number,
	presets: readonly number[],
	direction: HorizontalDirection,
): number {
	if (presets.length === 0) return current;
	if (direction === "left") {
		for (let i = presets.length - 1; i >= 0; i--) {
			if (presets[i] < current) return presets[i];
		}
		return presets[0];
	}
	for (let i = 0; i < presets.length; i++) {
		if (presets[i] > current) return presets[i];
	}
	return presets[presets.length - 1];
}

export function parsePositiveIntegerWithUnit(rawInput: string): number | undefined {
	const trimmed = rawInput.trim();
	if (!trimmed) return undefined;

	const match = /^([0-9]+(?:\.[0-9]+)?)\s*([kmKM])?$/i.exec(trimmed);
	if (!match) return undefined;

	const num = Number.parseFloat(match[1]);
	if (!Number.isFinite(num) || num <= 0) return undefined;

	const unit = match[2]?.toLowerCase();
	if (unit === "m") return Math.round(num * 1_000_000);
	if (unit === "k") return Math.round(num * 1_000);

	// 纯数字无单位时，若数值小于 1000（如输入 64、128、200），按习惯视作千倍处理
	if (num < 1000) return Math.round(num * 1_000);

	return Math.round(num);
}

// [喵喵喵]: Pi 允许 reserveTokens = 0（上下文写满就压缩），所以这里不能直接复用
// parsePositiveIntegerWithUnit 的 num > 0 限制。
export function parseNonNegativeTokenCount(rawInput: string): number | undefined {
	if (rawInput.trim() === "0") return 0;
	const parsed = parsePositiveIntegerWithUnit(rawInput);
	return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

// 开关字段在两个方向上取反；档位字段按 direction 在选项间步进。
function applyHorizontalToggle(draft: ModelDraft, fieldId: string, direction: HorizontalDirection): boolean {
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
		const tiers: readonly ModelDraft["openAIServiceTier"][] = [undefined, "priority", "ultrafast"];
		const currentIndex = tiers.indexOf(draft.openAIServiceTier);
		const step = direction === "left" ? -1 : 1;
		draft.openAIServiceTier = tiers[(currentIndex + step + tiers.length) % tiers.length];
		return true;
	}
	if (fieldId === "contextWindow") {
		draft.contextWindow = cycleNumericPreset(draft.contextWindow, CONTEXT_WINDOW_PRESETS, direction);
		return true;
	}
	if (fieldId === "maxTokens") {
		draft.maxTokens = cycleNumericPreset(draft.maxTokens, MAX_TOKENS_PRESETS, direction);
		return true;
	}
	if (fieldId === "compactionReserve") {
		cycleCompactionReserve(draft, direction);
		return true;
	}
	return false;
}

function describeCompactionReserve(draft: ModelDraft, inheritedCompactionReserve: number): string {
	const choice = draft.compactionReserve ?? "global";
	if (choice === "global") return t("{tokens} · 全局", { tokens: inheritedCompactionReserve });
	// auto 和固定值都可能算出同样的 token，标出档位才能区分。
	if (choice === "auto") return t("{tokens} · auto", { tokens: resolveAutoCompactionReserve(draft.contextWindow) });
	return String(choice);
}

function buildRows(draft: ModelDraft, inheritedCompactionReserve: number): FieldRow[] {
	const rows: FieldRow[] = [
		{ id: "modelId", label: t("模型 ID"), value: draft.modelId || t("<未填写>") },
		{ id: "fetch", label: t("重新拉取"), value: t("上游模型列表") },
		{ id: "modelName", label: t("显示名称"), value: draft.modelName || t("默认 = 模型 ID") },
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
		rows.push({ id: "openAIServiceTier", label: "Fast mode", value: formatOpenAIServiceTier(draft.openAIServiceTier), adjustable: true });
	}
	rows.push(
		{ id: "contextWindow", label: t("上下文窗口"), value: String(draft.contextWindow), adjustable: true },
		{ id: "maxTokens", label: t("最大输出"), value: String(draft.maxTokens), adjustable: true },
		{
			id: "compactionReserve",
			label: t("压缩预留"),
			value: describeCompactionReserve(draft, inheritedCompactionReserve),
			adjustable: true,
		},
	);
	return rows;
}

function getSelectedCustomHeaders(
	draft: ModelDraft,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
): Record<string, string> {
	return draft.clientHeaderProfile === "custom" ? resolveProviderCustomHeaders(draft, requestHeaderProfiles) : {};
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
	const parsed = parsePositiveIntegerWithUnit(trimmed);
	if (parsed === undefined || parsed <= 0) {
		ctx.ui.notify(t("{label} 必须是正整数", { label }), "warning");
		return;
	}
	draft[field] = parsed;
}

// [喵喵喵]: 压缩预留不属于 models.json，而是 Pi 的 settings.json；
// 这里只改草稿，保存时随模型一起写入。
async function editCompactionReserve(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	inheritedCompactionReserve: number,
): Promise<void> {
	const current = resolveCompactionReserveChoice(draft.compactionReserve ?? "global", draft.contextWindow)
		?? inheritedCompactionReserve;
	const label = t("压缩预留");
	const value = await ctx.ui.input(
		t("{label} token（当前：{current}，支持 200k / 1m 写法；留空跟随全局设置）", { label, current }),
		String(current),
	);
	if (value === undefined) return;
	const trimmed = value.trim();
	if (!trimmed) {
		draft.compactionReserve = "global";
		return;
	}
	const parsed = parseNonNegativeTokenCount(trimmed);
	if (parsed === undefined) {
		ctx.ui.notify(t("{label} 必须是非负整数", { label }), "warning");
		return;
	}
	draft.compactionReserve = parsed;
}

async function editField(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	fieldId: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>,
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>,
	inheritedCompactionReserve: number,
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
				{ id: "default", tier: undefined, label: t("标准 — 不发送 service_tier") },
				{ id: "priority", tier: "priority", label: t("Fast — service_tier=priority，可能产生额外费用") },
				{ id: "ultrafast", tier: "ultrafast", label: t("Ultrafast — service_tier=ultrafast，需上游支持且可能产生额外费用") },
			] as const satisfies readonly { id: string; tier: ModelDraft["openAIServiceTier"]; label: string }[],
			draft.openAIServiceTier ?? "default",
		);
		if (choice) draft.openAIServiceTier = choice.tier;
		return;
	}
	if (fieldId === "contextWindow" || fieldId === "maxTokens") {
		await editIntField(ctx, draft, fieldId);
		return;
	}
	if (fieldId === "compactionReserve") {
		await editCompactionReserve(ctx, draft, inheritedCompactionReserve);
	}
}

export type ModelEditOutcome =
	| { action: "save"; draft: ModelDraft }
	| { action: "cancel" };

function formatCompactionThreshold(draft: ModelDraft, inheritedCompactionReserve: number): string {
	const reserve = resolveCompactionReserveChoice(draft.compactionReserve ?? "global", draft.contextWindow)
		?? inheritedCompactionReserve;
	return t("压缩阈值 {threshold} = 上下文 {context} − 预留 {reserve}", {
		threshold: Math.max(0, draft.contextWindow - reserve),
		context: draft.contextWindow,
		reserve,
	});
}

export async function editModel(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	titlePrefix: string,
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile> = {},
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>> = {},
	// [喵喵喵]: 继承值由调用方（dashboard）读好传入，编辑器不在首帧前做文件 I/O，
	// 保证菜单在对话框打开的同一次微任务里就能压入屏幕宿主。
	inheritedCompactionReserve: number = DEFAULT_COMPACTION_RESERVE_TOKENS,
): Promise<ModelEditOutcome> {
	if (!draft.modelId.trim()) {
		await pickModelFromUpstream(ctx, draft, requestHeaderProfiles, clientHeaderCaptures);
	}
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		// [喵喵喵]: 字段行的排版在开关切换后要原样重建，抽成函数避免两处写法飘移。
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.adjustable ? markAdjustableValue(row.value) : row.value}`,
			adjustable: row.adjustable,
		}));
		const rows = buildRows(draft, inheritedCompactionReserve);
		const menuRows = toMenuRows(rows);
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				// [喵喵喵]: 压缩阈值随预留档位变化，必须每帧重算。
				getSummaryLines: () => [
					t("接入 {providerId} · API {api}", { providerId: draft.providerId, api: formatApiShort(draft.api) }),
					t("Ctrl+S 保存并启用模型；不切换当前会话模型"),
					formatCompactionThreshold(draft, inheritedCompactionReserve),
				],
				onAdjust: (id, direction) => {
					if (!applyHorizontalToggle(draft, id, direction)) return undefined;
					return toMenuRows(buildRows(draft, inheritedCompactionReserve));
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
		await editField(ctx, draft, action.id, requestHeaderProfiles, clientHeaderCaptures, inheritedCompactionReserve);
	}
}
