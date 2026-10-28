// header-profile-mutations.ts
//
// 自定义请求头 profile 的事务层：集中处理 state/models.json 持久化和 runtime provider 刷新。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { persistManagedConfiguration } from "./configuration-persistence.ts";
import { t } from "./i18n.ts";
import { formatUnknownError } from "./common.ts";
import { reconcileProvider } from "./provider-registrar.ts";
import { deleteRequestHeaderProfileFromDocument, upsertRequestHeaderProfileInDocument, validateRequestHeaderProfileDraft } from "./state-document.ts";
import type { RequestHeaderProfileDraft, StateDocument, StoredProvider } from "./types.ts";

function providerReferencesProfile(provider: StoredProvider, profileId: string): boolean {
	return provider.requestHeaderProfileId === profileId
		|| provider.models.some((model) => model.requestHeaderProfileId === profileId);
}

function findProfileProviderIds(
	document: StateDocument,
	profileIds: string[],
): string[] {
	const ids = new Set(profileIds);
	return Object.entries(document.providers)
		.filter(([, provider]) => provider.managed && [...ids].some((profileId) => providerReferencesProfile(provider, profileId)))
		.map(([providerId]) => providerId);
}

async function refreshProfileProviders(pi: ExtensionAPI, document: StateDocument, providerIds: string[]): Promise<string[]> {
	const warnings: string[] = [];
	for (const providerId of providerIds) {
		const provider = document.providers[providerId];
		if (!provider) continue;
		try {
			await reconcileProvider(pi, providerId, provider, document.requestHeaderProfiles, document.clientHeaderCaptures);
		} catch (error) {
			warnings.push(`${providerId}: ${formatUnknownError(error)}`);
		}
	}
	return warnings;
}

function notifyHeaderProfileRefresh(
	ctx: ExtensionCommandContext,
	successMessage: string,
	warnings: string[],
): void {
	if (warnings.length === 0) {
		ctx.ui.notify(successMessage, "info");
		return;
	}
	ctx.ui.notify(t("{successMessage}，但以下接入未能刷新，已保留上一版 runtime：\n- {warnings}", { successMessage, warnings: warnings.join("\n- ") }), "warning");
}

export async function saveRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	draft: RequestHeaderProfileDraft,
	oldProfileId: string | undefined,
): Promise<void> {
	const profileId = draft.profileId.trim();
	let affectedProviderIds: string[] = [];
	const nextState = await persistManagedConfiguration(ctx, (latest) => {
		if (oldProfileId && !latest.requestHeaderProfiles[oldProfileId]) {
			throw new Error(t("请求头不存在：{profileId}", { profileId: oldProfileId }));
		}
		const errors = validateRequestHeaderProfileDraft(draft, latest, oldProfileId);
		if (errors.length > 0) throw new Error(errors.join("\n"));
		affectedProviderIds = findProfileProviderIds(latest, [profileId, ...(oldProfileId ? [oldProfileId] : [])]);
		return {
			document: upsertRequestHeaderProfileInDocument(latest, oldProfileId, draft),
			changedProviderIds: affectedProviderIds,
			removedProviderIds: [],
		};
	});
	const warnings = await refreshProfileProviders(pi, nextState, affectedProviderIds);
	notifyHeaderProfileRefresh(ctx, t("已保存请求头 {profileId}", { profileId: draft.profileId.trim() }), warnings);
}

export async function deleteRequestHeaderProfileConfiguration(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	_state: StateDocument,
	profileId: string,
): Promise<void> {
	let affectedProviderIds: string[] = [];
	const nextState = await persistManagedConfiguration(ctx, (latest) => {
		affectedProviderIds = findProfileProviderIds(latest, [profileId]);
		return {
			document: deleteRequestHeaderProfileFromDocument(latest, profileId),
			changedProviderIds: affectedProviderIds,
			removedProviderIds: [],
		};
	});
	const warnings = await refreshProfileProviders(pi, nextState, affectedProviderIds);
	notifyHeaderProfileRefresh(ctx, t("已删除请求头 {profileId}", { profileId }), warnings);
}
