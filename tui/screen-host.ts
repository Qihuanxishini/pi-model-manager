// tui/screen-host.ts
//
// 单对话框屏幕宿主：/model-manager 的整条交互流程只占用一个 ctx.ui.custom 对话框，
// 页面切换时在宿主内部替换屏幕，而不是结束对话框再开一个新的。
//
// [喵喵喵]: pi 的 ctx.ui.custom 每次 done() 都会把主输入框放回编辑区并请求渲染，
// 下一个页面再重新压入对话框。两帧之间终端会画出一次输入框（可能还有编辑器文本恢复），
// 在用户看来就是"切页面闪一下"。把整条流程放进同一个对话框后，切换只是同一帧内换渲染内容。
//
// 对外只暴露 runScreenFlow：调用方传入一段普通 async 流程，流程里照常 await ctx.ui.custom，
// 宿主会把它们变成压栈/出栈。

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

type ScreenComponent = Component & { dispose?(): void };

type ScreenFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => ScreenComponent | Promise<ScreenComponent>;

interface HostScreen {
	component: ScreenComponent;
	resolve: (value: unknown) => void;
	settled: boolean;
}

function isFocusableComponent(component: ScreenComponent): component is ScreenComponent & Focusable {
	return typeof (component as Partial<Focusable>).focused === "boolean";
}

function isPromiseLike<T>(value: ScreenComponent | Promise<ScreenComponent>): value is Promise<ScreenComponent> {
	return typeof (value as Promise<ScreenComponent>).then === "function";
}

/**
 * 面板会话的宿主组件。一次只显示一屏，把输入与焦点转发给当前屏幕。
 *
 * 屏幕结束后仍保留渲染，直到下一个屏幕压入为止：流程在页面之间还要读配置，
 * 期间保留上一屏比闪回输入框或空白更像正常的页面切换。
 */
class ScreenHost implements Component, Focusable {
	private current: HostScreen | undefined;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private focusedValue = false;

	constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
	}

	get focused(): boolean {
		return this.focusedValue;
	}

	set focused(value: boolean) {
		if (this.focusedValue === value) return;
		this.focusedValue = value;
		this.propagateFocus();
	}

	/** 压入一个子屏幕；屏幕调用 done() 时解析返回值。 */
	open<T>(factory: ScreenFactory<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			let screen: HostScreen | undefined;
			let earlyResult: { value: T } | undefined;
			const done = (result: T): void => {
				// 工厂同步调用 done 时屏幕对象还没建好，先记下来，压栈后立即结算。
				if (!screen) {
					earlyResult = { value: result };
					return;
				}
				this.settle(screen, result);
			};
			const created = factory(this.tui, this.theme, this.keybindings, done);
			const attach = (component: ScreenComponent): void => {
				screen = { component, resolve: resolve as (value: unknown) => void, settled: false };
				this.show(screen);
				if (earlyResult) this.settle(screen, earlyResult.value);
			};
			if (isPromiseLike(created)) {
				void created.then(attach, reject);
				return;
			}
			attach(created);
		});
	}

	private show(screen: HostScreen): void {
		const previous = this.current;
		if (previous) {
			// 流程是串行的：上一屏结束后才会开下一屏。否则它的返回值永远等不到，直接报错而不是静默挂起。
			if (!previous.settled) throw new Error("screen-host: 上一个屏幕尚未结束");
			this.disposeScreen(previous);
		}
		this.current = screen;
		this.propagateFocus();
		this.tui.requestRender();
	}

	private settle(screen: HostScreen, value: unknown): void {
		if (screen.settled) return;
		screen.settled = true;
		screen.resolve(value);
	}

	private disposeScreen(screen: HostScreen): void {
		try {
			screen.component.dispose?.();
		} catch {
			// 释放失败不影响页面切换
		}
	}

	private propagateFocus(): void {
		const component = this.current?.component;
		if (component && isFocusableComponent(component)) component.focused = this.focusedValue;
	}

	handleInput(data: string): void {
		const current = this.current;
		// [喵喵喵]: 已结束的屏幕不再接受按键，避免流程读配置期间按键被旧页面重复消费。
		if (!current || current.settled) return;
		current.component.handleInput?.(data);
	}

	render(width: number): string[] {
		return this.current?.component.render(width) ?? [];
	}

	invalidate(): void {
		this.current?.component.invalidate();
	}

	dispose(): void {
		if (this.current) this.disposeScreen(this.current);
		this.current = undefined;
	}
}

function createHostUi(ui: ExtensionCommandContext["ui"], host: ScreenHost): ExtensionCommandContext["ui"] {
	return new Proxy(ui, {
		get(target, property, receiver) {
			// 只有占编辑区的对话框需要换成宿主内的屏幕；input/select/confirm/editor 由 pi 叠在宿主之上，
			// 关闭后直接回到宿主，同样不会闪出主输入框。
			if (property === "custom") {
				return <T>(factory: ScreenFactory<T>, options?: { overlay?: boolean }): Promise<T> =>
					// overlay 是叠在内容之上的另一套生命周期，交给 pi 处理，不能塞进编辑区宿主。
					options?.overlay ? target.custom(factory, options) : host.open(factory);
			}
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function createHostContext(ctx: ExtensionCommandContext, host: ScreenHost): ExtensionCommandContext {
	const ui = createHostUi(ctx.ui, host);
	return new Proxy(ctx, {
		get(target, property, receiver) {
			if (property === "ui") return ui;
			const value = Reflect.get(target, property, receiver) as unknown;
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

/**
 * 在同一个对话框里运行整条面板流程。
 *
 * flow 里对 ctx.ui.custom 的调用会变成宿主内压栈，页面切换不再销毁对话框。
 */
export async function runScreenFlow<T>(
	ctx: ExtensionCommandContext,
	flow: (hostCtx: ExtensionCommandContext) => Promise<T>,
): Promise<T> {
	let failure: { error: unknown } | undefined;
	const result = await ctx.ui.custom<T>((tui, theme, keybindings, done) => {
		const host = new ScreenHost(tui, theme, keybindings);
		void Promise.resolve()
			.then(() => flow(createHostContext(ctx, host)))
			.then(
				(value) => done(value),
				(error: unknown) => {
					failure = { error };
					done(undefined as T);
				},
			);
		return host;
	});
	if (failure) throw failure.error;
	return result;
}
