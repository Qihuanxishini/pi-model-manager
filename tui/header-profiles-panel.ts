// tui/header-profiles-panel.ts
//
// 管理可复用的客户端请求头。接入编辑器只选择已存在的请求头，
// 不在模型内部新增一次性 JSON，避免配置分散。

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { formatUnknownError, parseStringRecordJson } from "../common.ts";
import { t } from "../i18n.ts";
import { deleteRequestHeaderProfileConfiguration, saveRequestHeaderProfileConfiguration } from "../header-profile-mutations.ts";
import { CLAUDE_CODE_CLIENT_HEADERS, CODEX_CLI_CLIENT_HEADERS } from "../presets/builtin-client-headers.ts";
import {
	countModelsUsingRequestHeaderProfile,
	createRequestHeaderProfileDraft,
	createRequestHeaderProfileDraftFromStored,
	validateRequestHeaderProfileDraft,
} from "../state-document.ts";
import { readState } from "../state-store.ts";
import type { RequestHeaderProfileDraft, StateDocument, StoredClientHeaderCapture, StoredRequestHeaderProfile } from "../types.ts";
import { padLabel, showPersistentFormMenu, showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import { fitColumn, formatDetailField, formatDetailTitle } from "./ui-helpers.ts";

interface ProfileRow {
	profileId: string;
	label: string;
	searchText: string;
	// [喵喵喵]: 引用计数要遍历全部 Provider，每帧重算浪费；构造行时算一次即可。
	usedCount: number;
}

interface FieldRow {
	id: string;
	label: string;
	value: string;
}

interface HeaderTemplate {
	id: string;
	label: string;
	description: string;
	headers: Record<string, string>;
}

function getHeaderTemplates(): HeaderTemplate[] {
	return [
		{
			id: "codex-cli",
			label: "Codex",
			description: t("OpenAI 兼容端点使用的终端 Codex TUI 请求头。"),
			headers: CODEX_CLI_CLIENT_HEADERS,
		},
		{
			id: "claude-code",
			label: "ClaudeCode",
			description: t("Anthropic 兼容端点常用的 ClaudeCode 请求头。"),
			headers: CLAUDE_CODE_CLIENT_HEADERS,
		},
		{
			id: "empty",
			label: t("清空"),
			description: t("清空当前请求头，重新手动填写。"),
			headers: {},
		},
	];
}

function buildProfileRows(document: StateDocument, profileIds: string[]): ProfileRow[] {
	return profileIds.map((profileId) => {
		const profile = document.requestHeaderProfiles[profileId]!;
		const usedCount = countModelsUsingRequestHeaderProfile(document, profileId);
		const label = formatProfileRow(profileId, profile, usedCount);
		return { profileId, label, usedCount, searchText: `${profileId} ${profile.name} ${label}` };
	});
}

function formatCapturedAt(capturedAt: string): string {
	return capturedAt.replace("T", " ").replace(/\.\d{3}Z$/, "Z").slice(0, 19);
}

function formatCaptureLine(label: string, capture: StoredClientHeaderCapture | undefined): string {
	if (!capture) return `  ${padLabel(label, 12)} ${t("未抓包")}`;
	return `  ${padLabel(label, 12)} ${t("已抓包 {time} · {count} headers", { time: formatCapturedAt(capture.capturedAt), count: Object.keys(capture.headers).length })}`;
}

interface ProfileTableCells {
	profileId: string;
	headers: string;
	used: string;
	name: string;
}

function formatProfileTableRow(cells: ProfileTableCells, availableWidth: number): string {
	if (availableWidth >= 64) {
		return [
			fitColumn(cells.profileId, 22),
			fitColumn(cells.headers, 12),
			fitColumn(cells.used, 10),
			fitColumn(cells.name, Math.max(10, availableWidth - 47)),
		].join(" ");
	}
	if (availableWidth >= 46) {
		return [fitColumn(cells.profileId, 22), fitColumn(cells.headers, 12), fitColumn(cells.used, 10)].join(" ");
	}
	if (availableWidth >= 33) {
		return [fitColumn(cells.profileId, 20), fitColumn(cells.headers, 12)].join(" ");
	}
	return [
		fitColumn(cells.profileId, Math.max(8, availableWidth - 11)),
		fitColumn(cells.headers, 10),
	].join(" ");
}

function formatProfileRow(
	profileId: string,
	profile: StoredRequestHeaderProfile,
	usedCount: number,
	availableWidth = 78,
): string {
	return formatProfileTableRow({
		profileId,
		headers: `${Object.keys(profile.headers).length} headers`,
		used: `${usedCount} models`,
		name: profile.name,
	}, availableWidth);
}

function formatProfileTableHeader(menuWidth: number): string {
	return `  ${formatProfileTableRow({
		profileId: t("自定义 ID"),
		headers: "Headers",
		used: "Used",
		name: t("名称"),
	}, Math.max(0, menuWidth - 2))}`;
}

function formatProfileDetailLines(
	profileId: string,
	profile: StoredRequestHeaderProfile,
	usedCount: number,
	theme?: Theme,
): string[] {
	const headerNames = Object.keys(profile.headers);
	const preview = headerNames.length > 0
		? headerNames.slice(0, 6).join(", ") + (headerNames.length > 6 ? ", ..." : "")
		: "<empty>";
	return [
		formatDetailTitle(`${profile.name} (${profileId})`, theme),
		formatDetailField("usage", `${usedCount} models`, theme),
		formatDetailField("headers", preview, theme),
	];
}

function buildEditorRows(draft: RequestHeaderProfileDraft): FieldRow[] {
	return [
		{ id: "profileId", label: t("请求头 ID"), value: draft.profileId || t("<未填写>") },
		{ id: "profileName", label: t("请求头名称"), value: draft.profileName || t("<未填写>") },
		{ id: "template", label: t("快速模板"), value: t("选择后填充") },
		{ id: "headers", label: t("请求头 JSON"), value: Object.keys(draft.headers).length > 0 ? t("{count}项", { count: Object.keys(draft.headers).length }) : t("未配置") },
	];
}

function notifyValidationErrors(ctx: ExtensionCommandContext, errors: string[]): void {
	ctx.ui.notify(t("请求头无效：\n{errors}", { errors: errors.map((error) => `- ${error}`).join("\n") }), "warning");
}

function formatHeadersEditorText(headers: Record<string, string>): string {
	if (Object.keys(headers).length > 0) return JSON.stringify(headers, null, 2);
	return `{
  // ${t("可先返回上一级选择“快速模板”，也可在这里填写：")}
  // "user-agent": "custom-client/1.0"
}
`;
}

async function editHeaders(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft): Promise<void> {
	ctx.ui.notify(t("结构：JSON 对象；key 是客户端 header 名，value 是字符串。复杂示例请用“快速模板”。"), "info");
	while (true) {
		const answer = await ctx.ui.editor(t("请求头 JSON"), formatHeadersEditorText(draft.headers));
		if (answer === undefined) return;
		try {
			draft.headers = parseStringRecordJson(answer, t("请求头"));
			return;
		} catch (error) {
			ctx.ui.notify(t("请求头 JSON 无效：{error}", { error: formatUnknownError(error) }), "warning");
		}
	}
}

async function applyTemplate(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft): Promise<void> {
	const templates = getHeaderTemplates();
	const labels = templates.map((template) => `${template.label} — ${template.description}`);
	const picked = await ctx.ui.select(t("选择请求头模板"), labels);
	if (!picked) return;
	const index = labels.indexOf(picked);
	if (index < 0) return;
	const template = templates[index]!;
	draft.headers = { ...template.headers };
	ctx.ui.notify(
		template.id === "empty"
			? t("已清空请求头")
			: t("已填充模板：{template}，可继续进入“请求头 JSON”微调。", { template: template.label }),
		"info",
	);
}

async function editField(ctx: ExtensionCommandContext, draft: RequestHeaderProfileDraft, fieldId: string): Promise<void> {
	if (fieldId === "profileId") {
		const value = await ctx.ui.input(t("请求头 ID（接入引用这个 ID；字母/数字/._-）"), draft.profileId);
		if (value !== undefined) draft.profileId = value.trim();
		return;
	}
	if (fieldId === "profileName") {
		const value = await ctx.ui.input(t("请求头名称（显示用）"), draft.profileName);
		if (value !== undefined) draft.profileName = value.trim();
		return;
	}
	if (fieldId === "template") {
		await applyTemplate(ctx, draft);
		return;
	}
	if (fieldId === "headers") {
		await editHeaders(ctx, draft);
		return;
	}
}

async function editProfile(
	ctx: ExtensionCommandContext,
	draft: RequestHeaderProfileDraft,
	titlePrefix: string,
): Promise<{ action: "save"; draft: RequestHeaderProfileDraft } | { action: "cancel" }> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const rows = buildEditorRows(draft);
		const menuRows = rows.map((row) => ({ id: row.id, label: `${padLabel(row.label, 16)}${row.value}` }));
		const action = await showPersistentFormMenu(
			ctx,
			titlePrefix,
			"",
			menuRows,
			cursor,
			{
				summaryLines: [
					t("认证类敏感 header 会被拒绝；API key 请放在接入配置中"),
				],
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("编辑") },
					{ key: "Ctrl+S", label: t("保存并同步") },
					{ key: "Esc", label: t("返回") },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		await editField(ctx, draft, action.id);
	}
}

async function saveProfile(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: RequestHeaderProfileDraft,
	oldProfileId: string | undefined,
): Promise<boolean> {
	const state = await readState();
	const errors = validateRequestHeaderProfileDraft(draft, state, oldProfileId);
	if (errors.length > 0) {
		notifyValidationErrors(ctx, errors);
		return false;
	}
	try {
		await saveRequestHeaderProfileConfiguration(pi, ctx, state, draft, oldProfileId);
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
	// [喵喵喵]: 保存后重新计数——重命名场景下引用已改指向新 ID，用保存前状态会误判 (issue #1)；
	// 提示属于锦上添花，读取失败不能反向误导成保存失败
	try {
		const savedState = await readState();
		if (countModelsUsingRequestHeaderProfile(savedState, draft.profileId.trim()) === 0) {
			ctx.ui.notify(t("请求头 {profileId} 尚未被任何接入使用；在接入编辑器的「请求头」行选择后才会生效。", { profileId: draft.profileId.trim() }), "info");
		}
	} catch {
		// 计数提示失败时静默跳过，保存结果不受影响
	}
	return true;
}

async function deleteProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<boolean> {
	const state = await readState();
	const profile = state.requestHeaderProfiles[profileId];
	if (!profile) {
		ctx.ui.notify(t("请求头不存在：{profileId}", { profileId }), "warning");
		return true;
	}
	const affected = countModelsUsingRequestHeaderProfile(state, profileId);
	const ok = await ctx.ui.confirm(
		t("删除请求头 {profileId}", { profileId }),
		t("将删除 {name}。{affected}", {
			name: profile.name,
			affected: affected > 0 ? t("\n{count} 个模型会自动改回“自动推荐”。", { count: affected }) : "",
		}),
	);
	if (!ok) return false;
	try {
		await deleteRequestHeaderProfileConfiguration(pi, ctx, state, profileId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("删除失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function editStoredProfile(pi: ExtensionAPI, ctx: ExtensionCommandContext, profileId: string): Promise<boolean> {
	const state = await readState();
	const profile = state.requestHeaderProfiles[profileId];
	if (!profile) {
		ctx.ui.notify(t("请求头不存在：{profileId}", { profileId }), "warning");
		return true;
	}
	const draft = createRequestHeaderProfileDraftFromStored(profileId, profile);
	// [喵喵喵]: 保存失败时保留当前草稿重试，防止用户输入的头信息与名称被强制退出丢弃
	while (true) {
		const outcome = await editProfile(ctx, draft, t("编辑请求头 {profileId}", { profileId }));
		if (outcome.action !== "save") return false;
		const saved = await saveProfile(pi, ctx, outcome.draft, profileId);
		if (saved) return true;
	}
}

type HeaderProfileShortcut = "new-profile" | "delete-profile";

export async function runHeaderProfilesPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const profileIds = Object.keys(state.requestHeaderProfiles).sort((a, b) => a.localeCompare(b));
		const rows = buildProfileRows(state, profileIds);
		const action = await showPersistentShortcutMenu<HeaderProfileShortcut>(
			ctx,
			t("/model-manager / 请求头"),
			"",
			rows.map((row, index) => ({ id: `${index}`, label: row.label, searchText: row.searchText })),
			cursor,
			[
				{ input: "n", shortcut: "new-profile" },
				{ input: "d", shortcut: "delete-profile" },
			],
			{
				summaryLines: [
					"Built-in captures",
					formatCaptureLine("ClaudeCode", state.clientHeaderCaptures["claude-code"]),
					formatCaptureLine("Codex", state.clientHeaderCaptures["codex-cli"]),
					`Custom profiles: ${rows.length}`,
				],
				tableHeader: formatProfileTableHeader,
				formatRow: (menuRow, width) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					const profile = row ? state.requestHeaderProfiles[row.profileId] : undefined;
					return row && profile
						? formatProfileRow(row.profileId, profile, row.usedCount, width)
						: menuRow.label;
				},
				getDetailLines: (selectedRow, theme) => {
					const row = rows[Number.parseInt(selectedRow?.id ?? "", 10)];
					const profile = row ? state.requestHeaderProfiles[row.profileId] : undefined;
					return row && profile
						? formatProfileDetailLines(row.profileId, profile, row.usedCount, theme)
						: [];
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("编辑请求头") },
					{ key: "N", label: t("新建自定义") },
					{ key: "D", label: t("删除") },
					{ key: "Esc", label: t("返回") },
				],
				emptyLabel: t("暂无自定义请求头；按 n 新建"),
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			if (action.shortcut === "new-profile") {
				const draft = createRequestHeaderProfileDraft(profileIds);
				// [喵喵喵]: 新建保存失败时保留已输入的草稿继续编辑
				while (true) {
					const outcome = await editProfile(ctx, draft, t("新建请求头"));
					if (outcome.action !== "save") break;
					const saved = await saveProfile(pi, ctx, outcome.draft, undefined);
					if (saved) break;
				}
				continue;
			}
			const selectedProfileId = rows[cursor.index]?.profileId;
			if (!selectedProfileId) {
				ctx.ui.notify(t("没有可删除的请求头。"), "info");
				continue;
			}
			await deleteProfile(pi, ctx, selectedProfileId);
			continue;
		}
		const row = rows[Number.parseInt(action.id, 10)];
		if (!row) return;
		await editStoredProfile(pi, ctx, row.profileId);
	}
}
