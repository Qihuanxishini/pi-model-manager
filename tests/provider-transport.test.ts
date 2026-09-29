import assert from "node:assert/strict";
import test from "node:test";
import { createProviderTransport } from "../provider-transport.ts";
import type { StoredProvider } from "../types.ts";

const provider: StoredProvider = {
	name: "Transport fixture", api: "openai-responses", baseUrl: "http://gateway.invalid/v1",
	managed: true, models: [{ id: "gpt-5.2" }],
};

function splitResponsesSse(): string[] {
	const item = { id: "msg_test", type: "message", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] };
	return [
		{ type: "response.created", response: { id: "resp_test", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
		{ type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { id: "resp_test", status: "completed", output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
	].map((value) => `data: ${JSON.stringify(value)}\n\n`);
}

// [喵喵喵]: 这里只检查传输层的响应体寿命，consume 返回文本并依赖测试替身的 lazyStream；真实协议测试独立运行。
test("Responses 兼容模式在正式终态事件后完成并取消未关闭上游", { timeout: 5_000 }, async () => {
	const upstreamCancelled = Promise.withResolvers<void>();
	const frames = splitResponsesSse();
	let index = 0;
	const upstream = new Response(new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index < frames.length) controller.enqueue(new TextEncoder().encode(frames[index++]));
		},
		cancel() {
			upstreamCancelled.resolve();
		},
	}), { headers: { "content-type": "text/event-stream" } });
	const consume = (_model: unknown, _context: unknown, options: any) => ({
		result: async () => (await options.fetch("http://gateway.invalid/v1/responses")).text(),
	});
	const native = { id: "terminal-wire", name: "Wire fixture", api: "openai-responses", models: [], stream: consume, streamSimple: consume } as any;
	const runtime = { getAuth: async () => ({ auth: { headers: {} } }) } as any;
	const compatible = { ...provider, openAIResponsesStreamCompletionMode: "terminal-event" as const };
	const transport = createProviderTransport(runtime, native, compatible);
	const output = await transport.streamSimple({ ...compatible.models[0], api: "openai-responses", baseUrl: compatible.baseUrl } as any, {} as any, { fetch: async () => upstream }).result();
	assert.equal(output, frames.join(""));
	await upstreamCancelled.promise;
});

test("Responses 标准模式仍等待上游流结束", { timeout: 5_000 }, async () => {
	const release = Promise.withResolvers<void>();
	const terminalSent = Promise.withResolvers<void>();
	const frames = splitResponsesSse();
	let index = 0;
	const upstream = new Response(new ReadableStream<Uint8Array>({
		async pull(controller) {
			if (index < frames.length) {
				controller.enqueue(new TextEncoder().encode(frames[index++]));
				if (index === frames.length) terminalSent.resolve();
				return;
			}
			await release.promise;
			controller.close();
		},
	}), { headers: { "content-type": "text/event-stream" } });
	const consume = (_model: unknown, _context: unknown, options: any) => ({
		result: async () => (await options.fetch("http://gateway.invalid/v1/responses")).text(),
	});
	const native = { id: "standard-wire", name: "Wire fixture", api: "openai-responses", models: [], stream: consume, streamSimple: consume } as any;
	const runtime = { getAuth: async () => ({ auth: { headers: {} } }) } as any;
	const transport = createProviderTransport(runtime, native, provider);
	const pending = transport.streamSimple({ ...provider.models[0], api: "openai-responses", baseUrl: provider.baseUrl } as any, {} as any, { fetch: async () => upstream }).result();
	await terminalSent.promise;
	assert.equal(await Promise.race([pending.then(() => "done"), new Promise((resolve) => setTimeout(() => resolve("waiting"), 50))]), "waiting");
	release.resolve();
	assert.equal(await pending, frames.join(""));
});
