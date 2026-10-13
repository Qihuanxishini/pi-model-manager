import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import {
	CONTEXT_WINDOW_PRESETS,
	MAX_TOKENS_PRESETS,
	cycleNumericPreset,
	editModel,
	parsePositiveIntegerWithUnit,
} from "../tui/editor-model.ts";
import type { ModelDraft } from "../types.ts";

interface MenuComponent {
	handleInput(input: string): void;
	render(width: number): string[];
}

function createModelDraft(): ModelDraft {
	return {
		providerId: "openai",
		api: "openai-completions",
		baseUrl: "https://api.openai.com/v1",
		apiKey: "sk-test",
		authHeader: false,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "http://127.0.0.1:7890",
		modelId: "gpt-4o",
		modelName: "GPT-4o",
		inputKinds: ["text", "image"],
		reasoningMode: "disabled",
		contextWindow: 200_000,
		maxTokens: 64_000,
		selectedIndex: 0,
	};
}

test("cycleNumericPreset 上下文窗口按方向键在预设序列中步进并保留边界", () => {
	// 预设: [128000, 200000, 256000, 272000, 300000, 400000, 500000]
	assert.equal(cycleNumericPreset(200_000, CONTEXT_WINDOW_PRESETS, "left"), 128_000);
	assert.equal(cycleNumericPreset(128_000, CONTEXT_WINDOW_PRESETS, "left"), 128_000, "达到最小项时保持边界");

	assert.equal(cycleNumericPreset(200_000, CONTEXT_WINDOW_PRESETS, "right"), 256_000);
	assert.equal(cycleNumericPreset(256_000, CONTEXT_WINDOW_PRESETS, "right"), 272_000);
	assert.equal(cycleNumericPreset(272_000, CONTEXT_WINDOW_PRESETS, "right"), 300_000);
	assert.equal(cycleNumericPreset(300_000, CONTEXT_WINDOW_PRESETS, "right"), 400_000);
	assert.equal(cycleNumericPreset(400_000, CONTEXT_WINDOW_PRESETS, "right"), 500_000);
	assert.equal(cycleNumericPreset(500_000, CONTEXT_WINDOW_PRESETS, "right"), 500_000, "达到最大项时保持边界");

	// 从非预设值平滑步进到临近预设
	assert.equal(cycleNumericPreset(180_000, CONTEXT_WINDOW_PRESETS, "left"), 128_000);
	assert.equal(cycleNumericPreset(180_000, CONTEXT_WINDOW_PRESETS, "right"), 200_000);
	assert.equal(cycleNumericPreset(50_000, CONTEXT_WINDOW_PRESETS, "left"), 128_000);
	assert.equal(cycleNumericPreset(50_000, CONTEXT_WINDOW_PRESETS, "right"), 128_000);
	assert.equal(cycleNumericPreset(800_000, CONTEXT_WINDOW_PRESETS, "right"), 500_000);
	assert.equal(cycleNumericPreset(800_000, CONTEXT_WINDOW_PRESETS, "left"), 500_000);
});

test("cycleNumericPreset 输出上限按方向键在十进制预设中步进", () => {
	// 预设: [16000, 32000, 64000, 128000]
	assert.equal(cycleNumericPreset(64_000, MAX_TOKENS_PRESETS, "left"), 32_000);
	assert.equal(cycleNumericPreset(32_000, MAX_TOKENS_PRESETS, "left"), 16_000);
	assert.equal(cycleNumericPreset(16_000, MAX_TOKENS_PRESETS, "left"), 16_000, "左边界保持");

	assert.equal(cycleNumericPreset(64_000, MAX_TOKENS_PRESETS, "right"), 128_000);
	assert.equal(cycleNumericPreset(128_000, MAX_TOKENS_PRESETS, "right"), 128_000, "右边界保持");

	// 从旧二进制预设 65536 平滑吸附到相邻十进制档位
	assert.equal(cycleNumericPreset(65_536, MAX_TOKENS_PRESETS, "right"), 128_000);
	assert.equal(cycleNumericPreset(65_536, MAX_TOKENS_PRESETS, "left"), 64_000);
});

test("parsePositiveIntegerWithUnit 正确解析单位和习惯简写（全十进制）", () => {
	assert.equal(parsePositiveIntegerWithUnit("200k"), 200_000);
	assert.equal(parsePositiveIntegerWithUnit("128k"), 128_000);
	assert.equal(parsePositiveIntegerWithUnit("1m"), 1_000_000);
	assert.equal(parsePositiveIntegerWithUnit("200"), 200_000, "小于 1000 按 k 习惯换算");
	assert.equal(parsePositiveIntegerWithUnit("128000"), 128_000, "完整数字保真");

	assert.equal(parsePositiveIntegerWithUnit("64k"), 64_000);
	assert.equal(parsePositiveIntegerWithUnit("16k"), 16_000);
	assert.equal(parsePositiveIntegerWithUnit("32k"), 32_000);
	assert.equal(parsePositiveIntegerWithUnit("128k"), 128_000);
	assert.equal(parsePositiveIntegerWithUnit("64"), 64_000, "小于 1000 按千倍换算");
	assert.equal(parsePositiveIntegerWithUnit("16"), 16_000);
	assert.equal(parsePositiveIntegerWithUnit("64000"), 64_000, "完整数字保真");
	assert.equal(parsePositiveIntegerWithUnit("8192"), 8192, "大于 1000 完整数字保真");
	assert.equal(parsePositiveIntegerWithUnit("4096"), 4096);
	assert.equal(parsePositiveIntegerWithUnit("65536"), 65_536, "旧二进制值不迁移，原样保留");

	// 非法输入返回 undefined
	assert.equal(parsePositiveIntegerWithUnit(""), undefined);
	assert.equal(parsePositiveIntegerWithUnit("abc"), undefined);
	assert.equal(parsePositiveIntegerWithUnit("-10"), undefined);
});

test("editModel 支持在上下文窗口与最大输出行用左右键就地步进", async () => {
	const draft = createModelDraft();
	let component: MenuComponent | undefined;
	const ctx = {
		ui: {
			custom(factory: any) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {} },
						{
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						},
						{},
						resolve,
					);
				});
			},
		},
	} as any;

	const outcome = editModel(ctx, draft, "编辑模型");
	assert.ok(component, "模型编辑器应同步创建");
	const menu = component;

	// 初始行: modelId(0), fetch(1), modelName(2), visionInput(3), reasoning(4), contextWindow(5), maxTokens(6)
	for (let i = 0; i < 5; i++) menu.handleInput(Key.down);
	assert.match(menu.render(100).join("\n"), /上下文窗口\s+◀ 200000 ▶/, "adjustable 行渲染方向键标记");

	// 在上下文窗口行按左键 -> 128000
	menu.handleInput(Key.left);
	assert.equal(draft.contextWindow, 128_000);
	assert.match(menu.render(100).join("\n"), /上下文窗口\s+◀ 128000 ▶/);

	// 按右键 -> 200000 -> 256000
	menu.handleInput(Key.right);
	assert.equal(draft.contextWindow, 200_000);
	menu.handleInput(Key.right);
	assert.equal(draft.contextWindow, 256_000);

	// 移动到最大输出行 (index 6)
	menu.handleInput(Key.down);
	assert.match(menu.render(100).join("\n"), /最大输出\s+◀ 64000 ▶/);

	// 按左键 -> 32000
	menu.handleInput(Key.left);
	assert.equal(draft.maxTokens, 32_000);
	assert.match(menu.render(100).join("\n"), /最大输出\s+◀ 32000 ▶/);

	// 按右键 -> 64000 -> 128000
	menu.handleInput(Key.right);
	assert.equal(draft.maxTokens, 64_000);
	menu.handleInput(Key.right);
	assert.equal(draft.maxTokens, 128_000);

	// 保存并退出
	menu.handleInput(Key.ctrl("s"));
	assert.deepEqual(await outcome, { action: "save", draft });
});

test("createRequestHeaderProfileDraft 存在冲突时自增生成唯一 ID", async () => {
	const { createRequestHeaderProfileDraft } = await import("../state-document.ts");
	const draft1 = createRequestHeaderProfileDraft();
	assert.equal(draft1.profileId, "custom-headers");

	const draft2 = createRequestHeaderProfileDraft(["custom-headers"]);
	assert.equal(draft2.profileId, "custom-headers-1");

	const draft3 = createRequestHeaderProfileDraft(["custom-headers", "custom-headers-1"]);
	assert.equal(draft3.profileId, "custom-headers-2");
});

test("模型关闭 Thinking 时禁止残留写入 forceAdaptiveThinking", async () => {
	const { upsertModelInDocument } = await import("../state-document.ts");
	const draft = createModelDraft();
	draft.providerId = "test";
	draft.api = "anthropic-messages";
	draft.reasoningMode = "disabled";
	draft.anthropicThinkingProtocol = "adaptive";

	const dummyDocument = {
		metadata: { version: 5 },
		providers: {
			test: {
				name: "test",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				managed: true,
				clientHeaderProfile: "recommended",
				models: [],
			},
		},
		models: [],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	} as any;

	const nextDoc = upsertModelInDocument(dummyDocument, draft);
	const updatedModel = nextDoc.providers.test!.models[0]!;
	assert.equal(updatedModel.compat?.forceAdaptiveThinking, undefined, "关闭推理时不应写入 forceAdaptiveThinking 兼容标记");
});


test("接入级强制 adaptive 时关闭推理应写入显式 false 覆盖继承", async () => {
	const { upsertModelInDocument } = await import("../state-document.ts");
	const draft = createModelDraft();
	draft.providerId = "test";
	draft.api = "anthropic-messages";
	draft.reasoningMode = "disabled";
	draft.anthropicThinkingProtocol = "adaptive";

	const dummyDocument = {
		metadata: { version: 5 },
		providers: {
			test: {
				name: "test",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				managed: true,
				clientHeaderProfile: "recommended",
				compat: { forceAdaptiveThinking: true },
				models: [],
			},
		},
		models: [],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	} as any;

	const nextDoc = upsertModelInDocument(dummyDocument, draft);
	const updatedModel = nextDoc.providers.test!.models[0]!;
	assert.equal(updatedModel.compat?.forceAdaptiveThinking, false, "接入级强制 adaptive 时关闭推理必须显式写 false，否则合并后仍注入 beta 头");
});

test("开启推理且选择 legacy 时保留既有显式 false 覆盖", async () => {
	const { upsertModelInDocument } = await import("../state-document.ts");
	const draft = createModelDraft();
	draft.providerId = "test";
	draft.api = "anthropic-messages";
	draft.reasoningMode = "enabled";
	draft.anthropicThinkingProtocol = "legacy";

	const dummyDocument = {
		metadata: { version: 5 },
		providers: {
			test: {
				name: "test",
				api: "anthropic-messages",
				baseUrl: "https://api.anthropic.com",
				managed: true,
				clientHeaderProfile: "recommended",
				models: [{
				id: "gpt-4o",
				reasoning: true,
				input: ["text"],
				contextWindow: 128_000,
				maxTokens: 16_384,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				compat: { forceAdaptiveThinking: false },
			}],
			},
		},
		models: [],
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	} as any;

	const nextDoc = upsertModelInDocument(dummyDocument, draft);
	const updatedModel = nextDoc.providers.test!.models[0]!;
	assert.equal(updatedModel.compat?.forceAdaptiveThinking, false, "legacy 协议的显式 false 覆盖应在往返中保留");
});
