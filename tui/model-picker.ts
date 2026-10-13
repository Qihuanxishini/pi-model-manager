// tui/model-picker.ts
//
// 已拉取模型列表的本地选择器：8 行分页 + 直接输入搜索 + 匹配排序。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n.ts";
import { padLabel } from "./persistent-menu.ts";

const MODEL_PAGE_SIZE = 8;
const EXACT_MATCH_SCORE = 50_000;
const PREFIX_MATCH_SCORE = 40_000;
const SEGMENT_PREFIX_MATCH_SCORE = 30_000;
const SUBSTRING_MATCH_SCORE = 20_000;
const FUZZY_MATCH_SCORE = 10_000;

interface RankedModelId {
	modelId: string;
	score: number;
}

function clampSelectedIndex(index: number, modelCount: number): number {
	if (modelCount <= 0) return 0;
	return Math.min(Math.max(0, index), modelCount - 1);
}

function getPageCount(modelCount: number): number {
	if (modelCount <= 0) return 0;
	return Math.ceil(modelCount / MODEL_PAGE_SIZE);
}

function getPageStart(selectedIndex: number): number {
	return Math.floor(selectedIndex / MODEL_PAGE_SIZE) * MODEL_PAGE_SIZE;
}

function normalizeSearchText(text: string): string {
	return text.trim().toLowerCase();
}

function splitSearchTokens(searchText: string): string[] {
	const normalized = normalizeSearchText(searchText);
	if (!normalized) return [];
	return normalized.split(/\s+/).filter(Boolean);
}

function splitModelSegments(normalizedModelId: string): string[] {
	return normalizedModelId.split(/[\s/:._-]+/).filter(Boolean);
}

function getFuzzySpan(normalizedModelId: string, token: string): number | undefined {
	let searchStart = 0;
	let firstMatchIndex = -1;
	let lastMatchIndex = -1;
	for (const character of token) {
		const matchIndex = normalizedModelId.indexOf(character, searchStart);
		if (matchIndex < 0) return undefined;
		if (firstMatchIndex < 0) firstMatchIndex = matchIndex;
		lastMatchIndex = matchIndex;
		searchStart = matchIndex + character.length;
	}
	return lastMatchIndex - firstMatchIndex + 1;
}

function rankTokenWithinModel(normalizedModelId: string, token: string): number | undefined {
	if (normalizedModelId === token) return EXACT_MATCH_SCORE;
	if (normalizedModelId.startsWith(token)) return PREFIX_MATCH_SCORE - normalizedModelId.length;

	const segmentIndex = splitModelSegments(normalizedModelId).findIndex((segment) => segment.startsWith(token));
	if (segmentIndex >= 0) {
		return SEGMENT_PREFIX_MATCH_SCORE - segmentIndex * 100 - normalizedModelId.length;
	}

	const substringIndex = normalizedModelId.indexOf(token);
	if (substringIndex >= 0) {
		return SUBSTRING_MATCH_SCORE - substringIndex * 100 - normalizedModelId.length;
	}

	const fuzzySpan = getFuzzySpan(normalizedModelId, token);
	if (fuzzySpan === undefined) return undefined;
	return FUZZY_MATCH_SCORE - fuzzySpan * 10 - normalizedModelId.length;
}

function rankModelId(modelId: string, searchText: string): number | undefined {
	const tokens = splitSearchTokens(searchText);
	if (tokens.length === 0) return 0;

	const normalizedModelId = modelId.toLowerCase();
	let combinedScore = 0;
	for (const token of tokens) {
		const tokenScore = rankTokenWithinModel(normalizedModelId, token);
		if (tokenScore === undefined) return undefined;
		combinedScore += tokenScore;
	}
	return combinedScore - normalizedModelId.length;
}

function sortModelIdsForSearch(modelIds: string[], searchText: string): string[] {
	const tokens = splitSearchTokens(searchText);
	if (tokens.length === 0) return [...modelIds].sort((a, b) => a.localeCompare(b));

	const rankedModelIds: RankedModelId[] = [];
	for (const modelId of modelIds) {
		const score = rankModelId(modelId, searchText);
		if (score !== undefined) rankedModelIds.push({ modelId, score });
	}

	rankedModelIds.sort((a, b) => {
		const scoreOrder = b.score - a.score;
		if (scoreOrder !== 0) return scoreOrder;
		const lengthOrder = a.modelId.length - b.modelId.length;
		if (lengthOrder !== 0) return lengthOrder;
		return a.modelId.localeCompare(b.modelId);
	});
	return rankedModelIds.map((model) => model.modelId);
}

function isPlainTextInput(data: string): boolean {
	if (!data) return false;
	for (const character of data) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined || codePoint < 32 || codePoint === 127) return false;
	}
	return !data.includes("\x1b");
}

function formatPageText(modelCount: number, selectedIndex: number): string {
	const pageCount = getPageCount(modelCount);
	if (pageCount === 0) return t("页码 0 / 0");
	return t("页码 {page} / {pages}", { page: Math.floor(selectedIndex / MODEL_PAGE_SIZE) + 1, pages: pageCount });
}

export async function pickModelIdFromList(
	ctx: ExtensionCommandContext,
	title: string,
	modelIds: string[],
	currentModelId: string,
): Promise<string | undefined> {
	const sortedModelIds = [...new Set(modelIds)].sort((a, b) => a.localeCompare(b));
	const normalizedCurrentModelId = currentModelId.trim();

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		let searchText = "";
		let matchedModelIds = sortModelIdsForSearch(sortedModelIds, searchText);
		let selectedIndex = clampSelectedIndex(matchedModelIds.indexOf(normalizedCurrentModelId), matchedModelIds.length);
		let focused = false;

		const requestRender = (): void => {
			selectedIndex = clampSelectedIndex(selectedIndex, matchedModelIds.length);
			tui.requestRender();
		};

		const replaceSearchText = (nextSearchText: string): void => {
			searchText = nextSearchText;
			matchedModelIds = sortModelIdsForSearch(sortedModelIds, searchText);
			const selectedModelId = normalizeSearchText(searchText) ? undefined : normalizedCurrentModelId;
			const selectedModelIndex = selectedModelId ? matchedModelIds.indexOf(selectedModelId) : -1;
			selectedIndex = clampSelectedIndex(selectedModelIndex >= 0 ? selectedModelIndex : 0, matchedModelIds.length);
			requestRender();
		};

		const moveSelection = (delta: number): void => {
			selectedIndex = clampSelectedIndex(selectedIndex + delta, matchedModelIds.length);
			requestRender();
		};

		const movePage = (delta: number): void => {
			if (matchedModelIds.length === 0) return;
			const pageCount = getPageCount(matchedModelIds.length);
			const currentPageIndex = Math.floor(selectedIndex / MODEL_PAGE_SIZE);
			const rowOffset = selectedIndex % MODEL_PAGE_SIZE;
			const nextPageIndex = Math.min(Math.max(0, currentPageIndex + delta), pageCount - 1);
			selectedIndex = clampSelectedIndex(nextPageIndex * MODEL_PAGE_SIZE + rowOffset, matchedModelIds.length);
			requestRender();
		};

		return {
			get focused(): boolean {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
			},
			invalidate(): void {},
			handleInput(data: string): void {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done(undefined);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					const selectedModelId = matchedModelIds[selectedIndex];
					if (selectedModelId) done(selectedModelId);
					return;
				}
				if (matchesKey(data, Key.backspace)) {
					if (searchText.length > 0) replaceSearchText(Array.from(searchText).slice(0, -1).join(""));
					return;
				}
				if (matchesKey(data, Key.up)) {
					moveSelection(-1);
					return;
				}
				if (matchesKey(data, Key.down)) {
					moveSelection(1);
					return;
				}
				if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.left)) {
					movePage(-1);
					return;
				}
				if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.right)) {
					movePage(1);
					return;
				}
				if (matchesKey(data, Key.home)) {
					selectedIndex = 0;
					requestRender();
					return;
				}
				if (matchesKey(data, Key.end)) {
					selectedIndex = Math.max(0, matchedModelIds.length - 1);
					requestRender();
					return;
				}
				if (isPlainTextInput(data)) {
					replaceSearchText(searchText + data);
				}
			},
			render(width: number): string[] {
				selectedIndex = clampSelectedIndex(selectedIndex, matchedModelIds.length);
				const pageStart = getPageStart(selectedIndex);
				const visibleModelIds = matchedModelIds.slice(pageStart, pageStart + MODEL_PAGE_SIZE);
				const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
				const queryCursor = focused ? `${CURSOR_MARKER}${theme.fg("accent", "▌")}` : "";
				const searchLine = searchText
					? `${theme.fg("muted", t("搜索: "))}${searchText}${queryCursor}`
					: `${theme.fg("muted", t("搜索: "))}${queryCursor}${theme.fg("dim", t("<直接输入搜索>"))}`;
				const lines: string[] = [
					border,
					theme.fg("accent", theme.bold(title)),
					searchLine,
					theme.fg("dim", t("匹配 {matched} / {total} · {page}", {
						matched: matchedModelIds.length,
						total: sortedModelIds.length,
						page: formatPageText(matchedModelIds.length, selectedIndex),
					})),
					"",
				];

				if (visibleModelIds.length === 0) {
					lines.push(theme.fg("warning", t("没有匹配模型；Backspace 删除搜索词，Esc 返回后可手动输入。")));
				} else {
					for (let rowIndex = 0; rowIndex < visibleModelIds.length; rowIndex += 1) {
						const absoluteIndex = pageStart + rowIndex;
						const modelId = visibleModelIds[rowIndex]!;
						const selected = absoluteIndex === selectedIndex;
						const currentSuffix = modelId === normalizedCurrentModelId ? theme.fg("dim", t("  ● 当前")) : "";
						const prefix = selected ? "❯ " : "  ";
						const rowText = truncateToWidth(`${prefix}${modelId}${currentSuffix}`, width);
						// [喵喵喵]: 与列表菜单用同一种选中表现（背景色），避免两套选择器手感不一致。
						lines.push(selected ? theme.bg("selectedBg", padLabel(rowText, width)) : rowText);
					}
				}

				lines.push(
					"",
					theme.fg("dim", t("↑↓ 选择 · ←→/PgUp/PgDn 翻页 · 输入搜索 · Backspace 删除 · Enter 确认 · Esc 取消")),
					border,
				);
				return lines.map((line) => truncateToWidth(line, width));
			},
		};
	});
}
