// 模型列表响应的资源与终端安全边界。

import { isObjectRecord } from "../common.ts";
import { t } from "../i18n.ts";
import type { ApiKind } from "../types.ts";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_MODEL_COUNT = 5_000;
const MAX_MODEL_ID_LENGTH = 256;
const UNSAFE_TERMINAL_TEXT_PATTERN = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function waitWithSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error(t("模型发现已取消")));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

function validateModelId(id: string): string {
	if (!id || id.length > MAX_MODEL_ID_LENGTH) {
		throw new Error(t("上游模型 ID 长度必须为 1-{maxLength} 个字符", { maxLength: MAX_MODEL_ID_LENGTH }));
	}
	if (UNSAFE_TERMINAL_TEXT_PATTERN.test(id)) {
		throw new Error(t("上游模型 ID 包含控制字符或终端转义序列，已拒绝显示"));
	}
	return id;
}

export function extractValidatedModelIds(envelope: unknown, api: ApiKind): string[] {
	if (!isObjectRecord(envelope)) return [];
	const rawModels = api === "google-generative-ai" ? envelope.models : envelope.data;
	if (!Array.isArray(rawModels)) return [];
	if (rawModels.length > MAX_MODEL_COUNT) {
		throw new Error(t("上游返回 {count} 个模型，超过上限 {maxCount}", { count: rawModels.length, maxCount: MAX_MODEL_COUNT }));
	}
	const ids = new Set<string>();
	for (const model of rawModels) {
		if (!isObjectRecord(model)) continue;
		const rawId = api === "google-generative-ai" ? model.name : model.id;
		if (typeof rawId !== "string") continue;
		const id = api === "google-generative-ai" ? rawId.replace(/^models\//, "") : rawId;
		ids.add(validateModelId(id));
	}
	return [...ids].sort((left, right) => left.localeCompare(right));
}

export async function readBoundedResponseText(response: Response, signal: AbortSignal): Promise<string> {
	const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
		if (response.body) await waitWithSignal(response.body.cancel("response too large"), signal).catch(() => {});
		throw new Error(t("模型列表响应体超过 {maxBytes} 字节上限", { maxBytes: MAX_RESPONSE_BYTES }));
	}
	if (!response.body) {
		const text = await waitWithSignal(response.text(), signal);
		if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error(t("模型列表响应体超过 {maxBytes} 字节上限", { maxBytes: MAX_RESPONSE_BYTES }));
		return text;
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let totalBytes = 0;
	let text = "";
	try {
		while (true) {
			const chunk = await waitWithSignal(reader.read(), signal);
			if (chunk.done) break;
			totalBytes += chunk.value.byteLength;
			if (totalBytes > MAX_RESPONSE_BYTES) {
				await reader.cancel("response too large");
				throw new Error(t("模型列表响应体超过 {maxBytes} 字节上限", { maxBytes: MAX_RESPONSE_BYTES }));
			}
			text += decoder.decode(chunk.value, { stream: true });
		}
		text += decoder.decode();
		return text;
	} finally {
		reader.releaseLock();
	}
}
