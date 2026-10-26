// openai-responses-recovery.ts
//
// Responses 跨资源状态恢复：仅在指定错误后剥离失败历史的 item ID，完整保留推理内容。

import { createHash } from "node:crypto";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionContext,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isObjectRecord } from "./common.ts";
import { t, type MessageKey } from "./i18n.ts";
import { readCachedState } from "./state-cache.ts";
import type { StateDocument } from "./types.ts";

const RECOVERY_ENTRY_TYPE = "pi-model-manager:responses-state-recovery";

type ActiveModel = NonNullable<ExtensionContext["model"]>;
interface ReplayState {
	version: 1;
	scope: string;
	itemIds: string[];
	encryptedHashes: string[];
	previousResponseIds: string[];
}
interface RequestSnapshot {
	state: ReplayState;
	provider: string;
	model: string;
	sessionId: string;
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function scopeFor(model: ActiveModel): string {
	return digest([model.provider, model.id, model.baseUrl]);
}

function enabledModel(ctx: ExtensionContext, state: StateDocument): ActiveModel | undefined {
	const model = ctx.model;
	if (model?.api !== "openai-responses") return undefined;
	const provider = state.providers[model.provider];
	const storedModel = provider?.models.find((candidate) => candidate.id === model.id);
	if (!provider?.managed || !provider.openAIResponsesAutoRecoveryEnabled
		|| !storedModel || (storedModel.api ?? provider.api) !== model.api) return undefined;
	return model;
}

function isReplayState(value: unknown): value is ReplayState {
	return isObjectRecord(value) && value.version === 1 && typeof value.scope === "string"
		&& [value.itemIds, value.encryptedHashes, value.previousResponseIds]
			.every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"));
}

function collectState(payload: Record<string, unknown>, scope: string): ReplayState {
	const itemIds = new Set<string>();
	for (const item of payload.input as unknown[]) {
		if (!isObjectRecord(item)) continue;
		// [喵喵喵]: msg_pi_* 是 Pi 本地生成的占位 ID；压缩后可能复用，不能当成上游资源 ID 隔离。
		if (typeof item.id === "string" && !item.id.startsWith("msg_pi_")) itemIds.add(item.id);
	}
	// [喵喵喵]: 延用既有分支记录格式，但不再记录或清理密文哈希及 response 引用。
	return { version: 1, scope, itemIds: [...itemIds], encryptedHashes: [], previousResponseIds: [] };
}

function canReplayItem(item: unknown): boolean {
	if (!isObjectRecord(item)) return true;
	switch (item.type) {
		case "item_reference":
		case "compaction": return false;
		case "reasoning":
		case "message":
		case "function_call":
		case "function_call_output": return true;
		default:
			// [喵喵喵]: 未知资源项的 id 可能是必填或依赖服务端状态，不能套用工具调用的剥离规则。
			return typeof item.id !== "string" && !Object.keys(item).some((key) => key.startsWith("encrypted"));
	}
}

function stripQuarantinedItemIds(
	payload: Record<string, unknown>,
	ctx: ExtensionContext,
	scope: string,
): Record<string, unknown> | undefined {
	const itemIds = new Set<string>();
	// [喵喵喵]: 仅剥离当前分支已报错的历史 ID；重载后继续生效，其它分支及后续新 ID 不受影响。
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== RECOVERY_ENTRY_TYPE
			|| !isReplayState(entry.data) || entry.data.scope !== scope) continue;
		for (const id of entry.data.itemIds) itemIds.add(id);
	}
	if (!itemIds.size) return undefined;

	let changed = false;
	const input = (payload.input as unknown[]).map((item) => {
		if (!isObjectRecord(item) || typeof item.id !== "string" || !itemIds.has(item.id)) return item;
		// [喵喵喵]: reasoning、message 和 function_call 的旧 ID 必须一起剥离，避免残留关联校验；密文与 call_id 原样保留。
		const next = { ...item };
		delete next.id;
		changed = true;
		return next;
	});
	return changed ? { ...payload, input } : undefined;
}

function isRecoverableError(message: string): boolean {
	return /created under a different Azure OpenAI resource/i.test(message)
		|| /\bItem with id ['"][^'"\r\n]+['"] (?:was )?not found\b/i.test(message)
		|| /\bwas provided without its required ['"]reasoning['"] item\b/i.test(message)
		|| /\binvalid_encrypted_content\b/i.test(message)
		|| /\bencrypted content(?:\s+\S+)?(?:\s+for item\s+\S+)?\s+could not be (?:verified|decrypted)\b/i.test(message);
}

function notify(ctx: ExtensionContext, key: MessageKey, snapshot: RequestSnapshot, warning = false): void {
	if (ctx.hasUI) ctx.ui.notify(`[pi-model-manager] ${t(key, { model: `${snapshot.provider}/${snapshot.model}` })}`, warning ? "warning" : "info");
}

export function createOpenAIResponsesRecovery() {
	let lastRequest: RequestSnapshot | undefined;
	let pendingRecovery: RequestSnapshot | undefined;
	let attempted = false;

	return {
		beginActivity(): void {
			lastRequest = undefined;
			pendingRecovery = undefined;
			attempted = false;
		},

		transform(payload: unknown, ctx: ExtensionContext, state: StateDocument): unknown | undefined {
			lastRequest = undefined;
			const model = enabledModel(ctx, state);
			if (!model || !isObjectRecord(payload) || payload.model !== model.id || payload.store === true
				|| !Array.isArray(payload.input)) return undefined;
			// [喵喵喵]: 服务端引用、压缩项及未知资源项的 ID 可能不可省略，不对这些请求自动剥离重放。
			if (!payload.input.every(canReplayItem)) return undefined;
			const scope = scopeFor(model);
			const transformed = stripQuarantinedItemIds(payload, ctx, scope);
			lastRequest = {
				state: collectState(transformed ?? payload, scope), provider: model.provider,
				model: model.id, sessionId: ctx.sessionManager.getSessionId(),
			};
			return transformed;
		},

		async recover(event: AgentBeforeSettleEvent, ctx: ExtensionContext): Promise<BoundaryResult | undefined> {
			if (!lastRequest || attempted || event.outcome !== "error") return undefined;
			const snapshot = lastRequest;
			const model = enabledModel(ctx, await readCachedState());
			if (!model || scopeFor(model) !== snapshot.state.scope || ctx.sessionManager.getSessionId() !== snapshot.sessionId) return undefined;
			const failedEntry = event.context.contextEntries.findLast((entry) =>
				entry.messages.some((message) => message.role === "assistant"));
			const message = failedEntry?.messages.findLast((candidate) => candidate.role === "assistant");
			if (!failedEntry || !message || message.role !== "assistant" || message.stopReason !== "error"
				|| message.provider !== snapshot.provider || message.model !== snapshot.model || message.api !== "openai-responses"
				|| message.content.length > 0 || !isRecoverableError(message.errorMessage ?? "")) return undefined;
			if (!snapshot.state.itemIds.length) return undefined;

			// [喵喵喵]: 只记录失败请求携带的旧 item ID；无法定位具体失效项时成组剥离，不触碰推理密文、正文和 call_id。
			// [喵喵喵]: 原始历史保留，仅追加分支状态与失败回复的上下文省略；同一次用户运行最多恢复一次。
			// [喵喵喵]: 错误 assistant 尚在上下文时 canContinue 为 false；省略它后由宿主重新校验，不能提前据此拒绝恢复。
			attempted = true;
			pendingRecovery = snapshot;
			notify(ctx, "{model}：将剥离本次失败历史的 item ID，保留思维链并自动重试一次。", snapshot);
			return {
				entries: [
					// [喵喵喵]: 边界 entries 是整体替换，必须保留前序扩展的提案后再追加恢复记录。
					...event.entries,
					{ type: "custom", customType: RECOVERY_ENTRY_TYPE, data: snapshot.state },
					{ type: "context_edit", targetId: failedEntry.sourceEntry.id, replacement: null },
				],
				continue: true,
			};
		},

		observeResult(event: TurnEndEvent, ctx: ExtensionContext): void {
			const message = event.message;
			if (!pendingRecovery || message.role !== "assistant" || message.provider !== pendingRecovery.provider
				|| message.model !== pendingRecovery.model || message.api !== "openai-responses") return;
			const snapshot = pendingRecovery;
			pendingRecovery = undefined;
			if (message.stopReason === "error") {
				notify(ctx, "{model}：跨资源自动恢复重试失败，已停止自动重试。", snapshot, true);
			} else if (message.stopReason === "aborted") {
				notify(ctx, "{model}：跨资源自动恢复已取消，未继续重试。", snapshot, true);
			} else {
				notify(ctx, "{model}：跨资源自动恢复成功；思维链完整保留，后续新 item ID 正常保留。", snapshot);
			}
		},

		finishActivity(aborted: boolean, ctx: ExtensionContext): void {
			if (!pendingRecovery) return;
			notify(ctx, aborted ? "{model}：跨资源自动恢复已取消，未继续重试。"
				: "{model}：跨资源自动恢复重试失败，已停止自动重试。", pendingRecovery, true);
			pendingRecovery = undefined;
		},
	};
}
