// model-mutations.ts
//
// /model-manager 的模型配置事务层。这里集中处理 models.json/state.json 持久化、
// Pi runtime provider 注册同步、enabledModels 同步和模型救援；TUI 只负责收集用户意图。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "./common.ts";
import { isBuiltinProviderId } from "./builtin-model-catalog.ts";
import { t } from "./i18n.ts";
import {
	persistManagedConfiguration,
	persistModelConfiguration,
	persistModelDeletionConfiguration,
	persistModelRenameConfiguration,
	persistProviderRenameConfiguration,
} from "./configuration-persistence.ts";
import {
	enableModelForNextPiStart,
	removeModelFromNextPiStart,
	removeProviderFromNextPiStart,
	replaceProviderInEnabledModelsForNextPiStart,
	verifyNativeModelAvailable,
} from "./models-json-sync.ts";
import { reconcileProvider, unregisterManagedProvider } from "./provider-registrar.ts";
import { withModelRescue } from "./rescue.ts";
import { deleteModelFromDocument, deleteProviderFromDocument, getModelFullId, upsertModelInDocument, upsertProviderInDocument, validateModelDraft, validateProviderDraft } from "./state-document.ts";
import type { StateDocument, StoredProvider } from "./types.ts";
import type { createModelDraftForStoredProvider, createProviderDraft } from "./state-document.ts";

type ProviderDraft = ReturnType<typeof createProviderDraft>;
type ModelDraft = ReturnType<typeof createModelDraftForStoredProvider>;

async function assertProviderIsEditable(providerId: string): Promise<void> {
	if (await isBuiltinProviderId(providerId)) {
		throw new Error(t("内置接入 {providerId} 不允许通过 /model-manager 编辑或删除。", { providerId }));
	}
}

function formatEnableNote(mode: "all-enabled" | "updated" | "unchanged", scope?: "global" | "project"): string {
	if (mode === "all-enabled") return t("当前未限制 enabledModels，重启后默认可选");
	if (mode === "updated") return scope === "project" ? t("已写入项目 enabledModels") : t("已写入全局 enabledModels");
	return t("已在 enabledModels 中");
}

async function notifyModelAvailability(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
	replacedFullId?: string,
	messagePrefix = t("已保存并启用模型"),
): Promise<void> {
	const fullId = getModelFullId(providerId, modelId);
	try {
		const enableOutcome = await enableModelForNextPiStart(ctx.cwd, fullId, replacedFullId);
		const verification = await verifyNativeModelAvailable(ctx, providerId, modelId);
		const enableNote = formatEnableNote(enableOutcome.mode, enableOutcome.scope);
		if (verification.ok) {
			ctx.ui.notify(t("{messagePrefix} {fullId}（{availability}）", { messagePrefix, fullId, availability: enableNote }), "info");
		} else {
			ctx.ui.notify(t("已保存模型 {fullId}，但启用校验有警告：\n- {warnings}", { fullId, warnings: verification.warnings.join("\n- ") }), "warning");
		}
	} catch (error) {
		ctx.ui.notify(t("已保存模型 {fullId}，但启用同步/校验失败：{error}", { fullId, error: formatUnknownError(error) }), "warning");
	}
}

async function reconcilePersistedProviderRuntime(
	pi: ExtensionAPI,
	providerId: string,
	provider: StoredProvider,
	document: StateDocument,
): Promise<void> {
	try {
		await reconcileProvider(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
	} catch (error) {
		throw new Error(t("models.json/state.json 已保存，但当前会话接入刷新失败：{error}。可执行 /reload 重试。", { error: formatUnknownError(error) }));
	}
}

export async function saveProviderConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	draft: ProviderDraft,
	oldProviderId: string | undefined,
): Promise<void> {
	await assertProviderIsEditable(draft.providerId);
	if (oldProviderId) await assertProviderIsEditable(oldProviderId);
	const prepare = (latest: StateDocument) => {
		if (oldProviderId && !latest.providers[oldProviderId]) {
			throw new Error(t("接入配置已不存在：{providerId}", { providerId: oldProviderId }));
		}
		// [喵喵喵]: UI 校验之后可能有其它进程保存；必须在锁内针对最新状态重验创建和重命名前提。
		const errors = validateProviderDraft(draft, latest, new Set(), oldProviderId);
		if (errors.length > 0) throw new Error(errors.join("\n"));
		const document = upsertProviderInDocument(latest, oldProviderId, draft);
		return { document, changedProviderIds: [draft.providerId], removedProviderIds: [] };
	};
	const nextState = oldProviderId && oldProviderId !== draft.providerId
		? await persistProviderRenameConfiguration(ctx, prepare, oldProviderId, draft.providerId)
		: await persistManagedConfiguration(ctx, prepare);
	const stored = nextState.providers[draft.providerId]!;
	const renamedCurrentModelId = oldProviderId
		&& oldProviderId !== draft.providerId
		&& ctx.model?.provider === oldProviderId
		&& stored.models.some((model) => model.id === ctx.model?.id)
		? ctx.model.id
		: undefined;
	await reconcilePersistedProviderRuntime(pi, draft.providerId, stored, nextState);
	if (oldProviderId && oldProviderId !== draft.providerId) unregisterManagedProvider(pi, oldProviderId);

	ctx.ui.notify(t("已保存接入 {providerId}", { providerId: draft.providerId }), "info");

	if (oldProviderId && oldProviderId !== draft.providerId) {
		try {
			const outcome = await replaceProviderInEnabledModelsForNextPiStart(
				ctx.cwd,
				oldProviderId,
				draft.providerId,
			);
			if (outcome.mode === "updated") {
				ctx.ui.notify(outcome.scope === "project"
					? t("已同步项目 enabledModels 中的接入重命名")
					: t("已同步全局 enabledModels 中的接入重命名"), "info");
			}
		} catch (error) {
			ctx.ui.notify(t("接入已保存，但 enabledModels 同步失败：{error}", { error: formatUnknownError(error) }), "warning");
		}
		await withModelRescue(ctx, pi, { providerId: oldProviderId }, {
			reason: t("接入 {oldProviderId} 已重命名为 {providerId}", { oldProviderId, providerId: draft.providerId }),
			preferred: renamedCurrentModelId
				? { providerId: draft.providerId, modelId: renamedCurrentModelId }
				: undefined,
		});
	}
}

export async function saveModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	draft: ModelDraft,
	replacedModelId: string | undefined,
): Promise<void> {
	await assertProviderIsEditable(draft.providerId);
	const newModelId = draft.modelId.trim();
	const prepare = (latest: StateDocument) => {
		if (replacedModelId && !latest.providers[draft.providerId]?.models.some((model) => model.id === replacedModelId)) {
			throw new Error(t("模型不存在：{fullId}", { fullId: getModelFullId(draft.providerId, replacedModelId) }));
		}
		const errors = validateModelDraft(draft, latest, replacedModelId);
		if (errors.length > 0) throw new Error(errors.join("\n"));
		const document = upsertModelInDocument(latest, draft, { replacedModelId });
		return { document, changedProviderIds: [draft.providerId], removedProviderIds: [] };
	};
	const oldFullId = replacedModelId && replacedModelId !== newModelId
		? getModelFullId(draft.providerId, replacedModelId)
		: undefined;
	const nextState = oldFullId && replacedModelId
		? await persistModelRenameConfiguration(ctx, prepare, draft.providerId, replacedModelId, newModelId)
		: await persistModelConfiguration(ctx, prepare, draft.providerId, newModelId);
	const stored = nextState.providers[draft.providerId]!;
	await reconcilePersistedProviderRuntime(pi, draft.providerId, stored, nextState);
	const newFullId = getModelFullId(draft.providerId, newModelId);
	await notifyModelAvailability(ctx, draft.providerId, newModelId, oldFullId);

	if (oldFullId && replacedModelId) {
		await withModelRescue(
			ctx,
			pi,
			{ providerId: draft.providerId, modelId: replacedModelId },
			{
				reason: t("模型 {oldFullId} 已重命名为 {newFullId}", { oldFullId, newFullId }),
				preferred: { providerId: draft.providerId, modelId: draft.modelId.trim() },
			},
		);
	}
}

export async function saveNewProviderWithModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_providerState: StateDocument,
	providerDraft: ProviderDraft,
	modelDraft: ModelDraft,
): Promise<void> {
	await assertProviderIsEditable(providerDraft.providerId);
	const prepare = (latest: StateDocument) => {
		const providerErrors = validateProviderDraft(providerDraft, latest, new Set());
		if (providerErrors.length > 0) throw new Error(providerErrors.join("\n"));
		const withProvider = upsertProviderInDocument(latest, undefined, providerDraft);
		const modelErrors = validateModelDraft(modelDraft, withProvider);
		if (modelErrors.length > 0) throw new Error(modelErrors.join("\n"));
		const document = upsertModelInDocument(withProvider, modelDraft);
		return { document, changedProviderIds: [providerDraft.providerId], removedProviderIds: [] };
	};
	const nextState = await persistManagedConfiguration(ctx, prepare);
	const stored = nextState.providers[providerDraft.providerId]!;
	await reconcilePersistedProviderRuntime(pi, providerDraft.providerId, stored, nextState);
	await notifyModelAvailability(ctx, providerDraft.providerId, modelDraft.modelId.trim(), undefined, t("已创建并启用模型"));
}

export async function deleteProviderConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	_provider: StoredProvider,
): Promise<void> {
	await assertProviderIsEditable(providerId);
	await persistManagedConfiguration(ctx, (latest) => ({
		document: deleteProviderFromDocument(latest, providerId),
		changedProviderIds: [],
		removedProviderIds: [providerId],
	}));
	try {
		await removeProviderFromNextPiStart(ctx.cwd, providerId);
	} catch (error) {
		ctx.ui.notify(t("接入已删除，但 enabledModels 清理失败：{error}", { error: formatUnknownError(error) }), "warning");
	}
	unregisterManagedProvider(pi, providerId);
	ctx.ui.notify(t("已删除接入 {providerId}", { providerId }), "info");
	await withModelRescue(ctx, pi, { providerId }, { reason: t("接入 {providerId} 已删除", { providerId }) });
}

export async function deleteModelConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<void> {
	await assertProviderIsEditable(providerId);
	const fullId = getModelFullId(providerId, modelId);
	const nextState = await persistModelDeletionConfiguration(ctx, (latest) => {
		let document = deleteModelFromDocument(latest, providerId, modelId);
		if ((document.providers[providerId]?.models.length ?? 0) === 0) {
			document = deleteProviderFromDocument(document, providerId);
		}
		return {
			document,
			changedProviderIds: document.providers[providerId] ? [providerId] : [],
			removedProviderIds: document.providers[providerId] ? [] : [providerId],
		};
	}, providerId, modelId);
	const stored = nextState.providers[providerId];
	try {
		await removeModelFromNextPiStart(ctx.cwd, fullId);
	} catch (error) {
		ctx.ui.notify(t("模型已删除，但 enabledModels 清理失败：{error}", { error: formatUnknownError(error) }), "warning");
	}
	if (stored) await reconcilePersistedProviderRuntime(pi, providerId, stored, nextState);
	else unregisterManagedProvider(pi, providerId);
	ctx.ui.notify(t("已删除模型 {fullId}", { fullId }), "info");
	await withModelRescue(ctx, pi, { providerId, modelId }, { reason: t("模型 {fullId} 已删除", { fullId }) });
}
