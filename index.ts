// pi-model-manager 主入口
//
// factory 阶段（pi 会等待）读取配置并注册模型 catalog，但不启动长生命周期本地代理。
// session_start 再激活完整 provider transport，session_shutdown 幂等关闭代理服务。
//
// models.json 是模型定义唯一来源；state.json 只保存请求头 profile、抓包缓存、service_tier 等插件私有元数据。
// 启动期通知用 session_start 事件 + ctx.ui.notify（factory 期没有 ctx）。
//
// 命令：/model-manager → TUI 面板

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "./common.ts";
import { DEFAULT_UI_LANGUAGE, joinLocalizedList, setUiLanguage, t } from "./i18n.ts";
import { readUiLanguage } from "./ui-language-settings.ts";
import { persistManagedConfiguration, recoverPendingConfigurationTransaction } from "./configuration-persistence.ts";
import { MODELS_CHANGED_EVENT, setModelsChangeNotifier } from "./models-change-events.ts";
import { resetClaudeCodeMetadataSession } from "./claude-code-compat.ts";
import { findProvidersNeedingBaseUrlNormalization, normalizeProviderBaseUrlsInDocument } from "./state-document.ts";
import { closeLocalProxyServer } from "./local-proxy-service.ts";
import { registerAllFromState, registerCatalogFromState } from "./provider-registrar.ts";
import { createRequestPipeline } from "./request-pipeline.ts";
import { createEmptyState, readState } from "./state-store.ts";
import { runDashboard } from "./tui/dashboard.ts";

interface StartupSummary {
	startupErrors: string[];
}

export default async function modelManagerExtension(pi: ExtensionAPI): Promise<void> {
	const summary: StartupSummary = { startupErrors: [] };
	setUiLanguage(DEFAULT_UI_LANGUAGE);
	// 保存成功后广播无 secret 的 models.json 变更事件；消费者（如余额对账）自行订阅。
	setModelsChangeNotifier((payload) => pi.events.emit(MODELS_CHANGED_EVENT, payload));
	try {
		setUiLanguage(await readUiLanguage());
	} catch (error) {
		summary.startupErrors.push(t("读取语言设置失败，已使用简体中文：{error}", { error: formatUnknownError(error) }));
	}

	let configurationBlocked = false;
	try {
		await recoverPendingConfigurationTransaction();
	} catch (error) {
		configurationBlocked = true;
		summary.startupErrors.push(t("恢复未完成配置事务失败：{error}（为避免读取半完成配置，本次暂不注册模型）", { error: formatUnknownError(error) }));
	}
	if (!configurationBlocked) {
		try {
			const stateForStartup = await readState().catch((error) => {
				summary.startupErrors.push(t("读取 models.json/state.json 失败：{error}（本次启动仅使用内存空配置，不覆盖原文件）", { error: formatUnknownError(error) }));
				return createEmptyState();
			});
			for (const warning of await registerCatalogFromState(pi, stateForStartup)) {
				summary.startupErrors.push(t("注册模型目录失败：{warning}", { warning }));
			}
		} catch (error) {
			summary.startupErrors.push(t("读取/注册模型配置失败：{error}", { error: formatUnknownError(error) }));
		}
	}

	// ---- 2. session_start 激活 transport 并汇报 ----
	let notified = false;
	const requestPipeline = createRequestPipeline();
	pi.on("session_start", async (event, ctx) => {
		resetClaudeCodeMetadataSession();
		const transportErrors: string[] = [];
		let migratedBaseUrlProviderIds: string[] = [];
		try {
			if (configurationBlocked) {
				await recoverPendingConfigurationTransaction();
				configurationBlocked = false;
			}
			const currentState = await readState();
			for (const warning of await registerAllFromState(pi, currentState)) {
				transportErrors.push(t("激活模型接入失败：{warning}", { warning }));
			}
			// [喵喵喵]: 一次性补齐早期版本留在 models.json 里的半成品 baseUrl；
			// 归一化幂等，写完后后续启动检测不到差异，不会重复写盘。
			const staleBaseUrlProviderIds = findProvidersNeedingBaseUrlNormalization(currentState);
			if (staleBaseUrlProviderIds.length > 0) {
				await persistManagedConfiguration(ctx, (latest) => ({
					document: normalizeProviderBaseUrlsInDocument(latest, staleBaseUrlProviderIds),
					changedProviderIds: [...staleBaseUrlProviderIds],
					removedProviderIds: [],
				}));
				migratedBaseUrlProviderIds = staleBaseUrlProviderIds;
			}
		} catch (error) {
			configurationBlocked = true;
			transportErrors.push(t("恢复、读取或激活模型配置失败：{error}", { error: formatUnknownError(error) }));
		}

		if (event.reason === "startup" && !notified) {
			notified = true;
			for (const error of summary.startupErrors) {
				ctx.ui.notify(`[pi-model-manager] ${error}`, "error");
			}
		}
		for (const error of transportErrors) {
			ctx.ui.notify(`[pi-model-manager] ${error}`, "error");
		}
		if (migratedBaseUrlProviderIds.length > 0) {
			ctx.ui.notify(
				t("[pi-model-manager] 已补全 {count} 个接入的请求地址（{providerIds}），现在 models.json 存的就是实际请求根地址", {
					count: migratedBaseUrlProviderIds.length,
					providerIds: joinLocalizedList(migratedBaseUrlProviderIds),
				}),
				"info",
			);
		}
	});

	pi.on("before_provider_request", async (event, ctx) => requestPipeline.transform(event.payload, ctx));
	pi.on("session_shutdown", async () => {
		await closeLocalProxyServer();
	});

	// ---- 3. 命令：/model-manager → TUI 面板 ----
	pi.registerCommand("model-manager", {
		description: t("模型接入与请求配置 / Model and provider settings"),
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify(t("/model-manager 需要 TUI 交互模式"), "error");
				return;
			}
			await runDashboard(pi, ctx);
		},
	});
}
