// tui/dashboard.ts
//
// 主 dashboard：列出 state 中所有接入/模型，操作通过快捷键触发。
//
// 流程：
//   dashboard → n → 接入编辑器 → 模型编辑器 → save & register
//   dashboard → [接入行] → 接入菜单 → Enter 编辑模型 / a 添加模型 / e 编辑接入
//   dashboard → h → 请求头面板
//
// 保存/删除事务委托给 model-mutations.ts，dashboard 只保留交互与校验流程。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import { getUiLanguage, setUiLanguage, t, type UiLanguage } from "../i18n.ts";
import { writeUiLanguage } from "../ui-language-settings.ts";
import { synchronizeModelMetadata } from "../model-metadata.ts";
import {
	deleteModelConfiguration,
	deleteProviderConfiguration,
	saveModelConfiguration,
	saveNewProviderWithModelConfiguration,
	saveProviderConfiguration,
} from "../model-mutations.ts";
import {
	createModelDraftForStoredProvider,
	createModelDraftFromStoredModel,
	createProviderDraft,
	createProviderDraftFromStored,
	getModelFullId,
	getProviderChangeWarnings,
	getProviderDisplayName,
	upsertProviderInDocument,
	validateModelDraft,
	validateProviderDraft,
} from "../state-document.ts";
import { readState } from "../state-store.ts";
import { getBuiltinProviderIds } from "../builtin-model-catalog.ts";
import type { StateDocument, StoredModel, StoredProvider } from "../types.ts";
import { editModel } from "./editor-model.ts";
import { editProvider } from "./editor-provider.ts";
import { showOptionPicker, showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import {
	formatModelListHeader,
	formatModelListRow,
	formatProviderConsoleHeader,
	formatProviderConsoleRow,
	formatProviderDetailLines,
	formatProviderEndpointLine,
	formatProviderSummaryLine,
	getModelColumnWidths,
	getProviderDisplayLabel,
	getProviderNameColumnWidth,
} from "./ui-helpers.ts";
import { runHeaderProfilesPanel } from "./header-profiles-panel.ts";

interface DashboardRow {
	providerId: string;
	label: string;
	searchText: string;
}

interface ProviderMenuRow {
	modelId: string;
	model: StoredModel;
	label: string;
	searchText: string;
}

function buildRows(document: StateDocument, builtInProviderIds: ReadonlySet<string>): DashboardRow[] {
	return Object.keys(document.providers)
		.filter((providerId) => !builtInProviderIds.has(providerId))
		.sort((a, b) => a.localeCompare(b))
		.map((providerId) => {
			const provider = document.providers[providerId]!;
			const label = formatProviderConsoleRow(providerId, provider, 81, { requestHeaderProfiles: document.requestHeaderProfiles });
			// [喵喵喵]: label 已被列宽截断，搜索需要补上完整的接入 ID 与名称。
			return { providerId, label, searchText: `${providerId} ${getProviderDisplayName(providerId, provider)} ${label}` };
		});
}

function buildProviderMenuRows(provider: StoredProvider): ProviderMenuRow[] {
	return [...provider.models]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((model) => {
			const label = formatModelListRow(provider, model);
			return { modelId: model.id, model, label, searchText: `${model.id} ${model.name ?? ""} ${label}` };
		});
}

function notifyValidationErrors(ctx: ExtensionCommandContext, title: string, errors: string[]): void {
	ctx.ui.notify(t("{title}：\n{errors}", { title, errors: errors.map((error) => `- ${error}`).join("\n") }), "warning");
}

async function confirmWarnings(ctx: ExtensionCommandContext, warnings: string[]): Promise<boolean> {
	if (warnings.length === 0) return true;
	return ctx.ui.confirm(t("请确认改动"), t("{warnings}\n\n继续保存？", { warnings: warnings.join("\n") }));
}

async function selectUiLanguage(ctx: ExtensionCommandContext): Promise<void> {
	const currentLanguage = getUiLanguage();
	const choice = await showOptionPicker<{ id: UiLanguage; label: string }>(
		ctx,
		"语言 / Language",
		[
			{ id: "zh-CN", label: "简体中文 / Simplified Chinese" },
			{ id: "en", label: "English" },
		],
		currentLanguage,
	);
	if (!choice || choice.id === currentLanguage) return;
	try {
		await writeUiLanguage(choice.id);
		setUiLanguage(choice.id);
		ctx.ui.notify(t("语言已切换为 {language}", { language: choice.id === "en" ? "English" : "简体中文" }), "info");
	} catch (error) {
		ctx.ui.notify(t("语言设置保存失败：{error}", { error: formatUnknownError(error) }), "error");
	}
}


// ========== save 流程 ==========

async function synchronizeModelDraft(
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createModelDraftForStoredProvider>,
): Promise<boolean> {
	if (draft.metadataSource === "manual") return true;
	try {
		ctx.ui.notify(t("正在从 {source} 同步模型元数据…", { source: draft.metadataSource }), "info");
		await synchronizeModelMetadata(draft);
		return true;
	} catch (error) {
		ctx.ui.notify(t("模型元数据同步失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function saveProviderDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createProviderDraft>,
	oldProviderId: string | undefined,
): Promise<boolean> {
	const state = await readState();
	const builtInIds = await getBuiltinProviderIds();
	const errors = validateProviderDraft(draft, state, builtInIds, oldProviderId);
	if (errors.length > 0) {
		notifyValidationErrors(ctx, t("接入配置无效"), errors);
		return false;
	}
	const current = oldProviderId ? state.providers[oldProviderId] : state.providers[draft.providerId];
	if (!(await confirmWarnings(ctx, getProviderChangeWarnings(current, draft)))) return false;

	try {
		await saveProviderConfiguration(pi, ctx, state, draft, oldProviderId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function saveModelDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createModelDraftForStoredProvider>,
	replacedModelId: string | undefined,
): Promise<boolean> {
	if (!(await synchronizeModelDraft(ctx, draft))) return false;
	const state = await readState();
	const errors = validateModelDraft(draft, state, replacedModelId);
	if (errors.length > 0) {
		notifyValidationErrors(ctx, t("模型配置无效"), errors);
		return false;
	}
	try {
		await saveModelConfiguration(pi, ctx, state, draft, replacedModelId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function saveNewProviderAndModelDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerDraft: ReturnType<typeof createProviderDraft>,
	modelDraft: ReturnType<typeof createModelDraftForStoredProvider>,
): Promise<boolean> {
	if (!(await synchronizeModelDraft(ctx, modelDraft))) return false;
	const state = await readState();
	const builtInIds = await getBuiltinProviderIds();
	const providerErrors = validateProviderDraft(providerDraft, state, builtInIds, undefined);
	if (providerErrors.length > 0) {
		notifyValidationErrors(ctx, t("接入配置无效"), providerErrors);
		return false;
	}
	const providerState = upsertProviderInDocument(state, undefined, providerDraft);
	const modelErrors = validateModelDraft(modelDraft, providerState, undefined);
	if (modelErrors.length > 0) {
		notifyValidationErrors(ctx, t("模型配置无效"), modelErrors);
		return false;
	}
	try {
		await saveNewProviderWithModelConfiguration(pi, ctx, providerState, providerDraft, modelDraft);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

// ========== delete 流程 ==========

async function deleteProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string, provider: StoredProvider): Promise<boolean> {
	const ok = await ctx.ui.confirm(
		t("删除接入 {providerId}", { providerId }),
		t("将删除 {name} 下全部 {count} 个模型。", { name: getProviderDisplayName(providerId, provider), count: provider.models.length }),
	);
	if (!ok) return false;
	try {
		await deleteProviderConfiguration(pi, ctx, providerId, provider);
		return true;
	} catch (error) {
		ctx.ui.notify(t("删除失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function deleteModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string, modelId: string): Promise<boolean> {
	const fullId = getModelFullId(providerId, modelId);
	const stateForPrompt = await readState();
	const currentProvider = stateForPrompt.providers[providerId];
	const removesLastModel = (currentProvider?.models.length ?? 0) <= 1;
	const ok = await ctx.ui.confirm(
		t("删除模型 {fullId}", { fullId }),
		removesLastModel ? t("这是该接入下最后一个模型；删除后接入也会从 models.json 中移除。") : t("只删除该模型，接入保留。"),
	);
	if (!ok) return false;
	try {
		await deleteModelConfiguration(pi, ctx, providerId, modelId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("删除失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

// ========== 子菜单 ==========

type ProviderShortcut = "add-model" | "edit-provider" | "delete-model";

async function editStoredModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	provider: StoredProvider,
	modelId: string,
	requestHeaderProfiles: StateDocument["requestHeaderProfiles"],
	clientHeaderCaptures: StateDocument["clientHeaderCaptures"],
): Promise<boolean> {
	const model = provider.models.find((m) => m.id === modelId);
	if (!model) {
		ctx.ui.notify(t("模型不存在：{fullId}", { fullId: getModelFullId(providerId, modelId) }), "error");
		return false;
	}
	const draft = createModelDraftFromStoredModel(providerId, provider, model);
	const outcome = await editModel(ctx, draft, t("编辑模型 {fullId}", { fullId: getModelFullId(providerId, modelId) }), requestHeaderProfiles, clientHeaderCaptures);
	if (outcome.action !== "save") return false;
	return saveModelDraft(pi, ctx, outcome.draft, modelId);
}

async function showProviderMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string): Promise<boolean> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const currentProvider = state.providers[providerId];
		if (!currentProvider) {
			ctx.ui.notify(t("接入配置已不存在：{providerId}", { providerId }), "warning");
			return true;
		}
		const rows = buildProviderMenuRows(currentProvider);
		const modelColumns = getModelColumnWidths(currentProvider.models);
		const action = await showPersistentShortcutMenu<ProviderShortcut>(
			ctx,
			`/model-manager / ${getProviderDisplayName(providerId, currentProvider)}`,
			"",
			rows.map((row, index) => ({ id: `${index}`, label: row.label, searchText: row.searchText })),
			cursor,
			[
				{ input: "a", shortcut: "add-model" },
				{ input: "e", shortcut: "edit-provider" },
				{ input: "d", shortcut: "delete-model" },
			],
			{
				summaryLines: [
					formatProviderSummaryLine(currentProvider, state.requestHeaderProfiles),
					formatProviderEndpointLine(currentProvider),
				],
				tableHeader: (width) => formatModelListHeader(currentProvider, width, modelColumns),
				formatRow: (menuRow, width, theme) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					return row ? formatModelListRow(currentProvider, row.model, width, { ...modelColumns, theme }) : menuRow.label;
				},
				visibleRows: Math.min(12, Math.max(1, rows.length)),
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("编辑模型") },
					{ key: "A", label: t("添加模型") },
					{ key: "E", label: t("编辑接入") },
					{ key: "D", label: t("删除模型") },
					{ key: "Esc", label: t("返回") },
				],
				emptyLabel: t("暂无模型；按 a 添加第一个模型"),
			},
		);
		if (action.type === "cancel") return false;
		if (action.type === "shortcut") {
			if (action.shortcut === "add-model") {
				const draft = createModelDraftForStoredProvider(providerId, currentProvider);
				const outcome = await editModel(ctx, draft, t("添加模型到 {providerId}", { providerId }), state.requestHeaderProfiles, state.clientHeaderCaptures);
				if (outcome.action === "save") await saveModelDraft(pi, ctx, outcome.draft, undefined);
				continue;
			}
			if (action.shortcut === "edit-provider") {
				const draft = createProviderDraftFromStored(providerId, currentProvider);
				const outcome = await editProvider(ctx, draft, t("编辑接入 {providerId}", { providerId }), state.requestHeaderProfiles);
				if (outcome.action === "save") {
					await saveProviderDraft(pi, ctx, outcome.draft, providerId);
					if (outcome.draft.providerId !== providerId) return true;
				}
				continue;
			}
			const selectedModelId = rows[cursor.index]?.modelId;
			if (!selectedModelId) {
				ctx.ui.notify(t("没有可删除的模型；删除接入请返回上一级按 d。"), "info");
				continue;
			}
			await deleteModel(pi, ctx, providerId, selectedModelId);
			continue;
		}
		const row = rows[Number.parseInt(action.id, 10)];
		if (!row) return false;
		await editStoredModel(pi, ctx, providerId, currentProvider, row.modelId, state.requestHeaderProfiles, state.clientHeaderCaptures);
	}
}

async function createProviderAndModel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const stateBeforeEdit = await readState();
	const builtInIds = await getBuiltinProviderIds();
	const providerDraft = createProviderDraft();
	providerDraft.providerName = "";
	while (true) {
		const providerOutcome = await editProvider(
			ctx,
			providerDraft,
			t("新建接入配置"),
			stateBeforeEdit.requestHeaderProfiles,
		);
		if (providerOutcome.action !== "save") return false;
		const providerErrors = validateProviderDraft(providerOutcome.draft, stateBeforeEdit, builtInIds, undefined);
		if (providerErrors.length > 0) {
			notifyValidationErrors(ctx, t("接入配置无效"), providerErrors);
			continue;
		}

		const stagedState = upsertProviderInDocument(stateBeforeEdit, undefined, providerOutcome.draft);
		const stored = stagedState.providers[providerOutcome.draft.providerId]!;
		ctx.ui.notify(t("请继续添加第一个模型；取消模型编辑则不会创建该接入。"), "info");
		const modelDraft = createModelDraftForStoredProvider(providerOutcome.draft.providerId, stored);
		const modelOutcome = await editModel(ctx, modelDraft, t("添加模型到 {providerId}", { providerId: providerOutcome.draft.providerId }), stagedState.requestHeaderProfiles, stagedState.clientHeaderCaptures);
		if (modelOutcome.action !== "save") return false;
		return saveNewProviderAndModelDraft(pi, ctx, providerOutcome.draft, modelOutcome.draft);
	}
}

// ========== 入口 ==========

type DashboardShortcut = "new-provider" | "header-profiles" | "delete-provider" | "language";

export async function runDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const builtInProviderIds = await getBuiltinProviderIds();
		const rows = buildRows(state, builtInProviderIds);
		const nameWidth = getProviderNameColumnWidth(
			rows.map((row) => getProviderDisplayLabel(row.providerId, state.providers[row.providerId]!)),
		);
		const modelCount = rows.reduce((sum, row) => sum + (state.providers[row.providerId]?.models.length ?? 0), 0);
		const profileCount = Object.keys(state.requestHeaderProfiles).length;
		const captureCount = Object.keys(state.clientHeaderCaptures).length;
		const menuRows = rows.map((r, index) => ({ id: `${index}`, label: r.label, searchText: r.searchText }));
		const action = await showPersistentShortcutMenu<DashboardShortcut>(
			ctx,
			"/model-manager",
			"",
			menuRows,
			cursor,
			[
				{ input: "n", shortcut: "new-provider" },
				{ input: "h", shortcut: "header-profiles" },
				{ input: "d", shortcut: "delete-provider" },
				{ input: "l", shortcut: "language" },
			],
			{
				summaryLines: [t("{providers} 接入 · {models} 模型 · {captures} 内置抓包 · {profiles} 自定义请求头", {
					providers: rows.length,
					models: modelCount,
					captures: captureCount,
					profiles: profileCount,
				})],
				tableHeader: (width) => formatProviderConsoleHeader(width, { nameWidth }),
				formatRow: (menuRow, width, theme) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					const provider = row ? state.providers[row.providerId] : undefined;
					return row && provider
						? formatProviderConsoleRow(row.providerId, provider, width, { requestHeaderProfiles: state.requestHeaderProfiles, theme, nameWidth })
						: menuRow.label;
				},
				getDetailLines: (selectedRow, theme) => {
					const row = rows[Number.parseInt(selectedRow?.id ?? "", 10)];
					const provider = row ? state.providers[row.providerId] : undefined;
					return row && provider
						? formatProviderDetailLines(row.providerId, provider, { requestHeaderProfiles: state.requestHeaderProfiles, theme })
						: [];
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("进入") },
					{ key: "N", label: t("新建接入") },
					{ key: "D", label: t("删除接入") },
					{ key: "H", label: t("请求头管理") },
					{ key: "L", label: "语言 / Language" },
					{ key: "Esc", label: t("退出") },
				],
				emptyLabel: t("暂无自定义接入；按 n 新建"),
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			if (action.shortcut === "new-provider") await createProviderAndModel(pi, ctx);
			if (action.shortcut === "header-profiles") await runHeaderProfilesPanel(pi, ctx);
			if (action.shortcut === "language") await selectUiLanguage(ctx);
			if (action.shortcut === "delete-provider") {
				const selectedProviderId = rows[cursor.index]?.providerId;
				const selectedProvider = selectedProviderId ? state.providers[selectedProviderId] : undefined;
				if (selectedProviderId && selectedProvider) await deleteProvider(pi, ctx, selectedProviderId, selectedProvider);
				else ctx.ui.notify(t("没有可删除的接入。"), "info");
			}
			continue;
		}
		const index = Number.parseInt(action.id, 10);
		if (!Number.isFinite(index) || index < 0 || index >= rows.length) continue;
		const row = rows[index]!;
		const provider = state.providers[row.providerId];
		if (!provider) {
			ctx.ui.notify(t("接入配置已不存在：{providerId}", { providerId: row.providerId }), "warning");
			continue;
		}
		await showProviderMenu(pi, ctx, row.providerId);
	}
}
