// ClaudeCode 客户端兼容增强：让选择 ClaudeCode 请求头 profile 的 Anthropic 接入
// 同时具备 Snow CLI/ClaudeCode 中转常见的 body metadata 信号。

import { createHash, randomUUID } from "node:crypto";
import { isObjectRecord } from "./common.ts";
import { resolveClientHeaderProfile } from "./presets/client-headers.ts";
import type { StateDocument } from "./types.ts";

type ActiveModelRef = {
	provider: string;
	id: string;
	api: string;
};

type PayloadRecord = Record<string, unknown>;

let currentClaudeCodeUserId = createClaudeCodeUserId();

function createClaudeCodeUserId(): string {
	const sessionId = randomUUID();
	const hash = createHash("sha256").update(`anthropic_user_${sessionId}`).digest("hex");
	// [喵喵喵]: 当前客户端将身份序列化为 JSON 字符串；仅生成匿名标识，不采集真实账户信息 (2026-10-25)。
	return JSON.stringify({ device_id: hash, account_uuid: "", session_id: sessionId });
}

export function resetClaudeCodeMetadataSession(): void {
	currentClaudeCodeUserId = createClaudeCodeUserId();
}

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
	return isObjectRecord(payload);
}

/** 从实际 payload 的身份信息提取可安全放入请求头的会话 UUID。 */
export function getClaudeCodeSessionId(payload: unknown): string | undefined {
	if (!isPayloadRecord(payload) || !isObjectRecord(payload.metadata)) return undefined;
	if (typeof payload.metadata.user_id !== "string") return undefined;
	try {
		const identity: unknown = JSON.parse(payload.metadata.user_id);
		if (!isObjectRecord(identity) || typeof identity.session_id !== "string") return undefined;
		return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity.session_id)
			? identity.session_id
			: undefined;
	} catch {
		return undefined;
	}
}

export function injectClaudeCodeMetadata(
	payload: unknown,
	model: ActiveModelRef | undefined,
	state: StateDocument,
): PayloadRecord | undefined {
	if (!model || model.api !== "anthropic-messages") return undefined;
	if (!isPayloadRecord(payload)) return undefined;
	if (payload.model !== model.id) return undefined;

	const provider = state.providers[model.provider];
	if (!provider) return undefined;
	if (resolveClientHeaderProfile(provider.clientHeaderProfile, "anthropic-messages") !== "claude-code") return undefined;

	const metadata = isObjectRecord(payload.metadata) ? payload.metadata : {};
	return {
		...payload,
		// ARN/new-api 的 ClaudeCode-only 限制会检查 body 信号；只补 metadata，
		// 不改写 system prompt，避免降低 Pi 系统提示词优先级。
		metadata: {
			...metadata,
			user_id: currentClaudeCodeUserId,
		},
	};
}
