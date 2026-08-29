import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import { t } from "../i18n.ts";
import {
	createBalanceProviderDraft,
	saveBalanceProviderDraft,
	validateBalanceProviderDraft,
	type BalanceProviderDraft,
} from "../balance-config.ts";
import { showOptionPicker } from "./persistent-menu.ts";

function mask(value: string): string {
	if (!value) return t("<未配置>");
	return value.length <= 4
		? "••••"
		: `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

async function editBalanceDraft(
	ctx: ExtensionCommandContext,
	draft: BalanceProviderDraft,
): Promise<boolean> {
	while (true) {
		const action = await ctx.ui.select(
			t("余额配置 · {providerId}", { providerId: draft.providerId }),
			[
				`${t("启用")}: ${draft.enabled ? t("开启") : t("关闭")}`,
				`${t("协议模板")}: ${draft.profile}`,
				`Base URL: ${draft.baseUrl || t("自动使用模型接入")}`,
				`${t("访问令牌")}: ${mask(draft.accessToken)}`,
				`${t("用户 ID")}: ${draft.userId || t("<空>")}`,
				`divideBy: ${draft.divideBy || t("<空>")}`,
				`multiplyBy: ${draft.multiplyBy || t("<空>")}`,
				`${t("单位")}: ${draft.unit || t("<空>")}`,
				t("保存"),
				t("返回"),
			],
		);
		if (action === undefined || action === t("返回")) return false;
		const index = [
			"enabled",
			"profile",
			"baseUrl",
			"accessToken",
			"userId",
			"divideBy",
			"multiplyBy",
			"unit",
			"save",
			"back",
		][
			[
				`${t("启用")}: ${draft.enabled ? t("开启") : t("关闭")}`,
				`${t("协议模板")}: ${draft.profile}`,
				`Base URL: ${draft.baseUrl || t("自动使用模型接入")}`,
				`${t("访问令牌")}: ${mask(draft.accessToken)}`,
				`${t("用户 ID")}: ${draft.userId || t("<空>")}`,
				`divideBy: ${draft.divideBy || t("<空>")}`,
				`multiplyBy: ${draft.multiplyBy || t("<空>")}`,
				`${t("单位")}: ${draft.unit || t("<空>")}`,
				t("保存"),
				t("返回"),
			].indexOf(action)
		];
		if (index === "back") return false;
		if (index === "save") {
			const errors = validateBalanceProviderDraft(draft);
			if (errors.length) {
				ctx.ui.notify(errors.join("\n"), "warning");
				continue;
			}
			try {
				await saveBalanceProviderDraft(draft);
				ctx.ui.notify(t("余额配置已保存"), "info");
				return true;
			} catch (error) {
				ctx.ui.notify(
					t("余额配置保存失败：{error}", { error: formatUnknownError(error) }),
					"error",
				);
				continue;
			}
		}
		if (index === "enabled") {
			draft.enabled = !draft.enabled;
			continue;
		}
		if (index === "profile") {
			const choice = await showOptionPicker(
				ctx,
				t("余额协议模板"),
				[
					{ id: "sub2api", label: "Sub2API" },
					{ id: "newapi", label: "NewAPI" },
					{ id: "deepseek-official", label: "DeepSeek official" },
					{ id: "openrouter", label: "OpenRouter" },
					{ id: "custom", label: t("自定义（保留原模板）") },
				],
				draft.profile,
			);
			if (choice) draft.profile = choice.id as BalanceProviderDraft["profile"];
			continue;
		}
		const field = index as Exclude<
			keyof BalanceProviderDraft,
			"providerId" | "enabled" | "profile" | "selectedIndex"
		>;
		const value = await ctx.ui.input(
			`${field}（${draft[field] || t("<空>")}）`,
			String(draft[field]),
		);
		if (value !== undefined) draft[field] = value.trim() as never;
	}
}

export async function runBalancePanel(
	_pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
): Promise<void> {
	const draft = await createBalanceProviderDraft(providerId);
	await editBalanceDraft(ctx, draft);
}
