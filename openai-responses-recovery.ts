// openai-responses-recovery.ts
//
// Responses 跨资源状态恢复：按失败请求隔离旧状态，正常请求及后续新状态不降级。

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
	const encryptedHashes = new Set<string>();
	for (const item of payload.input as unknown[]) {
		if (!isObjectRecord(item)) continue;
		// [喵喵喵]: msg_pi_* 是 Pi 本地生成的占位 ID；压缩后可能复用，不能当成上游资源 ID 隔离。
		if (typeof item.id === "string" && !item.id.startsWith("msg_pi_")) itemIds.add(item.id);
		for (const [key, value] of Object.entries(item)) {
			if (key.startsWith("encrypted") && value !== undefined) encryptedHashes.add(digest([key, value]));
		}
	}
	return {
		version: 1, scope, itemIds: [...itemIds], encryptedHashes: [...encryptedHashes],
		previousResponseIds: typeof payload.previous_response_id === "string" ? [payload.previous_response_id] : [],
	};
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

function stripQuarantinedState(
	payload: Record<string, unknown>,
	ctx: ExtensionContext,
	scope: string,
): Record<string, unknown> | undefined {
	const itemIds = new Set<string>();
	const encryptedHashes = new Set<string>();
	const previousResponseIds = new Set<string>();
	// [喵喵喵]: 只读当前分支的恢复记录，重载后继续隔离旧状态，不污染其它分支或其它模型。
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== RECOVERY_ENTRY_TYPE
			|| !isReplayState(entry.data) || entry.data.scope !== scope) continue;
		for (const id of entry.data.itemIds) itemIds.add(id);
		for (const hash of entry.data.encryptedHashes) encryptedHashes.add(hash);
		for (const id of entry.data.previousResponseIds) previousResponseIds.add(id);
	}
	if (!itemIds.size && !encryptedHashes.size && !previousResponseIds.size) return undefined;

	let changed = false;
	const input = (payload.input as unknown[]).flatMap((item) => {
		if (!isObjectRecord(item)) return [item];
		const encryptedKeys = Object.keys(item).filter((key) => key.startsWith("encrypted"));
		const quarantined = (typeof item.id === "string" && itemIds.has(item.id))
			|| encryptedKeys.some((key) => item[key] !== undefined && encryptedHashes.has(digest([key, item[key]])));
		if (!quarantined) return [item];
		changed = true;
		if (item.type === "reasoning") {
			// [喵喵喵]: 失效密文不能伪造新的 reasoning id；按 Pi 的摘要优先规则回放可读文本，不生成缺字段的 reasoning。
			const text = [item.summary, item.content].map((blocks) => Array.isArray(blocks)
				? blocks.filter(isObjectRecord).map((block) => typeof block.text === "string" ? block.text : "").filter(Boolean).join("\n\n")
				: "").find(Boolean);
			return text ? [{ type: "message", role: "assistant", content: text }] : [];
		}
		const next = { ...item };
		for (const key of encryptedKeys) delete next[key];
		if (item.type === "message" && item.role === "assistant") {
			// [喵喵喵]: output message 仍需 id；沿用 Pi 的本地占位 ID 方式，保留正文、拒答、状态与 phase。
			next.id = `msg_pi_recovery_${digest(item).slice(0, 32)}`;
		} else {
			delete next.id;
		}
		return [next];
	});
	const dropPrevious = typeof payload.previous_response_id === "string" && previousResponseIds.has(payload.previous_response_id);
	if (!changed && !dropPrevious) return undefined;
	const next: Record<string, unknown> = { ...payload, input };
	if (dropPrevious) delete next.previous_response_id;
	return next;
}

function isRecoverableError(message: string): boolean {
	return /created under a different Azure OpenAI resource/i.test(message)
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
			if (!model || !isObjectRecord(payload) || payload.model !== model.id || !Array.isArray(payload.input)) return undefined;
			// [喵喵喵]: 服务端引用、压缩项及未知资源项无法安全重建，不把不完整历史误当成完整回放。
			if (!payload.input.every(canReplayItem)) return undefined;
			const scope = scopeFor(model);
			const transformed = stripQuarantinedState(payload, ctx, scope);
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
			const { itemIds, encryptedHashes, previousResponseIds } = snapshot.state;
			if (!itemIds.length && !encryptedHashes.length && !previousResponseIds.length) return undefined;

			// [喵喵喵]: 报错通常不指明具体失效项，只能隔离该失败请求携带的旧状态；不触碰正文和 call_id。
			// [喵喵喵]: 原始历史保留，仅追加分支状态与失败回复的上下文省略；同一次用户运行最多恢复一次。
			// [喵喵喵]: 错误 assistant 尚在上下文时 canContinue 为 false；省略它后由宿主重新校验，不能提前据此拒绝恢复。
			attempted = true;
			pendingRecovery = snapshot;
			notify(ctx, "{model}：已隔离本次失败携带的旧状态，正在自动重试一次。", snapshot);
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
				notify(ctx, "{model}：跨资源自动恢复成功；后续新推理状态正常保留。", snapshot);
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
