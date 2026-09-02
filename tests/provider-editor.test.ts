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
	assert.match(menu.render(100).join("\n"), /协议兼容\s+标准 · Pi 默认/);
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
