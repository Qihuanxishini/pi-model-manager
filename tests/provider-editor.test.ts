import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import { editProvider } from "../tui/editor-provider.ts";
import type { ProviderDraft } from "../types.ts";

interface MenuComponent {
	handleInput(input: string): void;
	render(width: number): string[];
}

function createChatDraft(): ProviderDraft {
	return {
		providerId: "gateway",
		providerName: "Gateway",
		api: "openai-completions",
		openAIChatCompatibilityMode: "standard",
		baseUrl: "https://gateway.example.test/v1",
		apiKey: "",
		authHeader: false,
		clientHeaderProfile: "recommended",
		customClientHeaders: {},
		httpProxyEnabled: false,
		httpProxyUrl: "http://127.0.0.1:7890",
		openAIResponsesStreamCompletionMode: "standard",
		selectedIndex: 0,
	};
}

test("Chat 接入的协议兼容支持左右键两态切换并显示说明", async () => {
	const draft = createChatDraft();
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

	const outcome = editProvider(ctx, draft, "编辑接入");
	assert.ok(component, "编辑器应同步创建");
	const menu = component;
	for (let index = 0; index < 4; index += 1) menu.handleInput(Key.down);
	assert.match(menu.render(100).join("\n"), /协议兼容\s+◀ 标准 · Pi 默认 ▶/);
	assert.match(menu.render(100).join("\n"), /标准模式：保持 Pi 默认兼容判断。/);

	menu.handleInput(Key.right);
	assert.equal(draft.openAIChatCompatibilityMode, "compatible");
	assert.match(menu.render(100).join("\n"), /兼容 · system/);
	assert.match(menu.render(100).join("\n"), /兼容模式：系统提示词强制使用 system role/);

	menu.handleInput(Key.left);
	assert.equal(draft.openAIChatCompatibilityMode, "standard");

	menu.handleInput(Key.ctrl("s"));
	assert.deepEqual(await outcome, { action: "save", draft });
});

test("Gemini 地址编辑立即回显版本转换，非法输入保留草稿并提示", { timeout: 5000 }, async () => {
	const realTui = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";
	const keys = realTui ? { down: "\x1b[B", enter: "\r", save: "\x13" } : { down: Key.down, enter: Key.enter, save: Key.ctrl("s") };
	const draft = { ...createChatDraft(), api: "google-generative-ai" as const };
	const originalUrl = draft.baseUrl;
	const expectedUrl = "https://gateway.example.test/tenant/v1beta";
	const inputs = ["https://[invalid", " https://gateway.example.test/tenant/v1/ "];
	const warnings: string[] = [];
	let menus = 0;
	const ctx = {
		ui: {
			input: async () => inputs.shift(),
			notify: (message: string, level: string) => { assert.equal(level, "warning"); warnings.push(message); },
			custom(factory: any) {
				return new Promise((resolve, reject) => {
					try {
						const menu: MenuComponent = factory({ requestRender() {} }, {
							fg: (_color: string, text: string) => text,
							bg: (_color: string, text: string) => text,
							bold: (text: string) => text,
						}, {}, resolve);
						menus++;
						if (menus <= 2) {
							assert.equal(draft.baseUrl, originalUrl, "打开编辑器或输入错误不改写存量地址");
							if (menus === 1) for (let i = 0; i < 3; i++) menu.handleInput(keys.down);
							menu.handleInput(keys.enter);
						} else {
							assert.equal(draft.baseUrl, expectedUrl);
							assert.ok(menu.render(120).join("\n").includes(expectedUrl));
							menu.handleInput(keys.save);
						}
					} catch (error) { reject(error); }
				});
			},
		},
	} as any;
	assert.deepEqual(await editProvider(ctx, draft, "编辑接入"), { action: "save", draft });
	assert.equal(menus, 3);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0]!, /Base URL 格式错误/);
});

function createResponsesDraft(): ProviderDraft {
	return {
		...createChatDraft(),
		api: "openai-responses",
		openAIResponsesStreamCompletionMode: "standard",
	};
}

test("Responses 接入的流结束兼容支持左右键切换并显示说明", async () => {
	const draft = createResponsesDraft();
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

	const outcome = editProvider(ctx, draft, "编辑接入");
	assert.ok(component, "编辑器应同步创建");
	const menu = component;
	for (let index = 0; index < 4; index += 1) menu.handleInput(Key.down);
	assert.match(menu.render(100).join("\n"), /流结束兼容\s+◀ 标准 · 等待连接关闭 ▶/);
	assert.match(menu.render(100).join("\n"), /标准模式：等待上游正常结束流/);

	menu.handleInput(Key.right);
	assert.equal(draft.openAIResponsesStreamCompletionMode, "terminal-event");
	assert.match(menu.render(100).join("\n"), /兼容 · 终态即结束/);
	assert.match(menu.render(100).join("\n"), /正式终态事件已转交后主动结束/);

	menu.handleInput(Key.ctrl("s"));
	assert.deepEqual(await outcome, { action: "save", draft });
});
