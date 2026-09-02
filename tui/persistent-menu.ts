// tui/persistent-menu.ts
//
// 共享的"光标记忆"菜单组件，用 ctx.ui.custom 实现。
// 调用方在循环间持有 cursor: { index } 引用，菜单进出时光标位置不丢。
//
// 设计：列表页保留 KISS 的键盘模型，同时支持摘要、列头、详情区、底部快捷键。
// 表单页另有 Ctrl+S 保存；列表页可注册单键快捷操作，并用 / 做轻量过滤。

import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { t } from "../i18n.ts";

export interface MenuRow {
	id: string;
	label: string;
	// [喵喵喵]: label 是按列宽截断后的表格文本，长 ID 的后半段不在其中；
	// 需要按真实标识搜索的调用方必须显式提供未截断的 searchText。
	searchText?: string;
	// [喵喵喵]: 可调整性属于行自身；开关切换会让字段集变化（如开 Thinking 后才出现 Adaptive 行），
	// 放在外部集合里就会在行重建后与实际行脱节，新出现的开关行按 ←→ 没反应。
	adjustable?: boolean;
}

// 底部快捷键提示；key 与说明分开才能分别着色，并在窄终端按项折行而不是被截掉。
export interface MenuHint {
	key: string;
	label: string;
}

export interface PersistentMenuOptions {
	summaryLines?: readonly string[];
	// [喵喵喵]: 就地切换字段时，摘要也可能依赖草稿状态；渲染时取值才能同步刷新。
	getSummaryLines?: () => readonly string[];
	// [喵喵喵]: 渲染回调拿到 theme 才能给列与详情上语义色；theme 只存在于 custom 回调作用域。
	tableHeader?: string | ((width: number, theme: Theme) => string);
	formatRow?: (row: MenuRow, width: number, theme: Theme) => string;
	getDetailLines?: (selectedRow: MenuRow | undefined, theme: Theme) => readonly string[];
	hints?: readonly MenuHint[];
	emptyLabel?: string;
	visibleRows?: number;
	searchable?: boolean;
}

export interface PersistentFormMenuOptions extends PersistentMenuOptions {
	// 就地切换该字段并返回重建后的行；返回 undefined 则忽略本次按键。
	onAdjust?: (id: string, direction: HorizontalDirection) => MenuRow[] | undefined;
}

export type MenuAction =
	| { type: "pick"; id: string }
	| { type: "cancel" };

export type HorizontalDirection = "left" | "right";
// 横向切换已改为组件内处理，不再作为外部动作返回。
export type FormMenuAction = MenuAction | { type: "save" };

export type ShortcutMenuAction<TShortcut extends string = string> = MenuAction | { type: "shortcut"; shortcut: TShortcut };

export interface MenuShortcut<TShortcut extends string = string> {
	input: string;
	shortcut: TShortcut;
}

export interface MenuCursor {
	index: number;
}

function clampIndex(index: number, length: number): number {
	if (length <= 0) return 0;
	return Math.min(Math.max(0, index), length - 1);
}

function padToVisibleWidth(text: string, targetWidth: number): string {
	const pad = Math.max(0, targetWidth - visibleWidth(text));
	return text + " ".repeat(pad);
}

export function padLabel(label: string, columns: number): string {
	return padToVisibleWidth(label, columns);
}

function getSearchText(row: MenuRow): string {
	return (row.searchText ?? `${row.id}\n${row.label}`).toLocaleLowerCase();
}

const HINT_GAP = "   ";

// 按项贪心排版：单行装不下就换行，保证窄终端下 Esc 等尾部提示不会被 truncate 丢失。
function layoutHintLines(hints: readonly MenuHint[], theme: Theme, width: number): string[] {
	const lines: string[] = [];
	let currentText = "";
	let currentWidth = 0;
	for (const hint of hints) {
		const hintWidth = visibleWidth(`${hint.key} ${hint.label}`);
		const styled = `${theme.fg("accent", hint.key)} ${theme.fg("dim", hint.label)}`;
		if (!currentText) {
			currentText = styled;
			currentWidth = hintWidth;
			continue;
		}
		if (currentWidth + HINT_GAP.length + hintWidth > width) {
			lines.push(currentText);
			currentText = styled;
			currentWidth = hintWidth;
			continue;
		}
		currentText += `${HINT_GAP}${styled}`;
		currentWidth += HINT_GAP.length + hintWidth;
	}
	if (currentText) lines.push(currentText);
	return lines;
}

// 滚动条字符在不同终端的宽度属于 ambiguous，因此固定预留 2 列，宁可多一个空格也不让行溢出。
const SCROLLBAR_WIDTH = 2;

// pi 在菜单下方还要渲染输入框与状态行，不预留就会把菜单底部的快捷键提示顶出屏幕。
const RESERVED_TERMINAL_ROWS = 3;
// 小于这个高度就无法同时容纳边框、标题、提示和列表，此时宁可溢出也不再继续压缩。
const MIN_MENU_ROWS = 8;
const MIN_LIST_ROWS = 1;

function getScrollbarGlyph(rowOffset: number, viewportRows: number, windowStart: number, totalRows: number): string {
	const thumbRows = Math.max(1, Math.round((viewportRows * viewportRows) / totalRows));
	const maxWindowStart = Math.max(1, totalRows - viewportRows);
	const thumbStart = Math.round((windowStart / maxWindowStart) * (viewportRows - thumbRows));
	return rowOffset >= thumbStart && rowOffset < thumbStart + thumbRows ? "█" : "│";
}

function filterRows(rows: MenuRow[], query: string): MenuRow[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return rows;
	return rows.filter((row) => getSearchText(row).includes(needle));
}

function isSearchTextInput(data: string): boolean {
	return data.length > 0 && !data.startsWith("\x1b") && !/[\u0000-\u001f\u007f]/.test(data);
}

function fitSearchQueryAroundCursor(query: string, cursor: number, cursorGlyph: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const characters = Array.from(query);
	const cursorWidth = visibleWidth(cursorGlyph);
	const textBudget = Math.max(0, maxWidth - cursorWidth);
	let beforeCursor = "";
	let beforeWidth = 0;
	for (let index = Math.min(cursor, characters.length) - 1; index >= 0; index -= 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + characterWidth > textBudget) break;
		beforeCursor = character + beforeCursor;
		beforeWidth += characterWidth;
	}
	let afterCursor = "";
	let afterWidth = 0;
	for (let index = Math.min(cursor, characters.length); index < characters.length; index += 1) {
		const character = characters[index]!;
		const characterWidth = visibleWidth(character);
		if (beforeWidth + afterWidth + characterWidth > textBudget) break;
		afterCursor += character;
		afterWidth += characterWidth;
	}
	return `${beforeCursor}${cursorGlyph}${afterCursor}`;
}

function createPersistentMenu<TAction extends MenuAction | FormMenuAction | ShortcutMenuAction>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	createSaveAction: (() => TAction) | undefined,
	shortcuts: MenuShortcut[],
	// [喵喵喵]: 横向切换是纯本地状态变更，必须在组件内完成。早期实现用 done() 结束组件再由
	// 调用方重开，每按一次方向键都会销毁重建整个 TUI，在终端上表现为闪烁。
	// 回调就地改写草稿并返回新行，返回 undefined 表示本次不可调整。
	onAdjust: ((id: string, direction: HorizontalDirection) => MenuRow[] | undefined) | undefined = undefined,
	options: PersistentMenuOptions = {},
): Promise<TAction> {
	cursor.index = clampIndex(cursor.index, rows.length);
	return ctx.ui.custom<TAction>((tui, theme, _keybindings, done) => {
		let selectedIndex = clampIndex(cursor.index, rows.length);
		let searchActive = false;
		let searchQuery = "";
		let searchCursor = 0;
		let focused = false;
		const configuredVisibleRows = options.visibleRows ?? 18;
		// [喵喵喵]: 真实可见行数要减去本帧的标题/摘要/详情/提示，每帧在 render 里重算，
		// 翻页也必须用同一个值，否则矮终端上 PgUp/PgDn 会跳过看不见的行。
		let viewportRows = configuredVisibleRows;
		const searchable = options.searchable ?? false;

		// onAdjust 会整批替换行数据，因此不能直接闭包参数 rows。
		let currentRows = rows;
		const getActiveRows = (): MenuRow[] => searchable ? filterRows(currentRows, searchQuery) : currentRows;

		const syncCursor = (activeRows: MenuRow[]): void => {
			const row = activeRows[selectedIndex];
			if (row) cursor.index = currentRows.indexOf(row);
		};

		const requestRender = (): void => {
			const activeRows = getActiveRows();
			selectedIndex = clampIndex(selectedIndex, activeRows.length);
			syncCursor(activeRows);
			tui.requestRender();
		};

		const clearSearch = (): boolean => {
			if (!searchable || (!searchActive && !searchQuery)) return false;
			searchActive = false;
			searchQuery = "";
			searchCursor = 0;
			selectedIndex = clampIndex(cursor.index, currentRows.length);
			requestRender();
			return true;
		};

		const replaceSearchQuery = (nextQuery: string, nextCursor: number): void => {
			const selectedRow = getActiveRows()[selectedIndex];
			searchQuery = nextQuery;
			searchCursor = clampIndex(nextCursor, Array.from(searchQuery).length + 1);
			const nextRows = getActiveRows();
			const retainedIndex = selectedRow ? nextRows.indexOf(selectedRow) : -1;
			selectedIndex = retainedIndex >= 0 ? retainedIndex : 0;
			requestRender();
		};

		const pickSelected = (): void => {
			const activeRows = getActiveRows();
			const row = activeRows[selectedIndex];
			if (!row) return;
			syncCursor(activeRows);
			done({ type: "pick", id: row.id } as TAction);
		};

		const moveSelection = (nextIndex: number): void => {
			selectedIndex = nextIndex;
			requestRender();
		};
		// 输入态显示带光标的搜索行；Tab 退出后仍需告知用户过滤仍生效。
		const renderQueryLine = (width: number): string => {
			if (!searchActive) {
				return truncateToWidth(`${theme.fg("dim", t("过滤："))}${searchQuery}`, width, "");
			}
			const cursorGlyph = focused ? `${CURSOR_MARKER}${theme.fg("accent", "▌")}` : "";
			const searchPrefix = theme.fg("accent", t("搜索："));
			const queryWidth = Math.max(0, width - visibleWidth(searchPrefix));
			const queryDisplay = searchQuery
				? fitSearchQueryAroundCursor(searchQuery, searchCursor, cursorGlyph, queryWidth)
				: `${cursorGlyph}${theme.fg("dim", t("<输入关键词>"))}`;
			return truncateToWidth(`${searchPrefix}${queryDisplay}`, width, "");
		};

		const getHints = (): MenuHint[] => {
			const hints: MenuHint[] = [...(options.hints ?? [])];
			if (!searchable) return hints;
			if (searchActive) hints.push({ key: "Tab", label: t("保留过滤") }, { key: "Esc", label: t("清空搜索") });
			else if (searchQuery) hints.push({ key: "Tab", label: t("继续输入") }, { key: "Esc", label: t("清空过滤") });
			else hints.push({ key: "/", label: t("搜索") });
			return hints;
		};

		// 终端高度未知（如测试环境）时不限制总行数，交由调用方配置的 visibleRows 控制。
		const getRowBudget = (): number => {
			const terminalRows = tui.terminal?.rows ?? 0;
			if (terminalRows <= 0) return Number.POSITIVE_INFINITY;
			return Math.max(MIN_MENU_ROWS, terminalRows - RESERVED_TERMINAL_ROWS);
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
				if (createSaveAction && matchesKey(data, Key.ctrl("s"))) {
					syncCursor(getActiveRows());
					done(createSaveAction());
					return;
				}
				const horizontalDirection: HorizontalDirection | undefined = matchesKey(data, Key.left)
					? "left"
					: matchesKey(data, Key.right)
						? "right"
						: undefined;
				if (horizontalDirection && onAdjust) {
					const row = getActiveRows()[selectedIndex];
					if (row?.adjustable) {
						syncCursor(getActiveRows());
						const nextRows = onAdjust(row.id, horizontalDirection);
						if (nextRows) {
							currentRows = nextRows;
							requestRender();
						}
					}
					return;
				}

				if (searchable && (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")))) {
					if (clearSearch()) return;
					done({ type: "cancel" } as TAction);
					return;
				}

				if (searchable && searchActive) {
					const queryCharacters = Array.from(searchQuery);
					if (matchesKey(data, Key.backspace)) {
						if (searchCursor > 0) {
							queryCharacters.splice(searchCursor - 1, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor - 1);
						}
						return;
					}
					if (matchesKey(data, Key.delete)) {
						if (searchCursor < queryCharacters.length) {
							queryCharacters.splice(searchCursor, 1);
							replaceSearchQuery(queryCharacters.join(""), searchCursor);
						}
						return;
					}
					if (matchesKey(data, Key.left)) {
						searchCursor = Math.max(0, searchCursor - 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.right)) {
						searchCursor = Math.min(queryCharacters.length, searchCursor + 1);
						requestRender();
						return;
					}
					if (matchesKey(data, Key.home)) {
						searchCursor = 0;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.end)) {
						searchCursor = queryCharacters.length;
						requestRender();
						return;
					}
					// [喵喵喵]: Tab 只退出输入态并保留过滤结果，让用户搜到目标后还能按单字母快捷键；Esc 才清空。
					if (matchesKey(data, Key.tab)) {
						searchActive = false;
						requestRender();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						pickSelected();
						return;
					}
					if (isSearchTextInput(data)) {
						queryCharacters.splice(searchCursor, 0, ...Array.from(data));
						replaceSearchQuery(queryCharacters.join(""), searchCursor + Array.from(data).length);
						return;
					}
				}

				// [喵喵喵]: 提示里快捷键显示为大写，因此 Shift 组合也必须命中同一个动作。
				const shortcut = shortcuts.find((candidate) => candidate.input.toLowerCase() === data.toLowerCase());
				if (shortcut) {
					syncCursor(getActiveRows());
					done({ type: "shortcut", shortcut: shortcut.shortcut } as TAction);
					return;
				}
				if (searchable && searchQuery && matchesKey(data, Key.tab)) {
					searchActive = true;
					searchCursor = Array.from(searchQuery).length;
					requestRender();
					return;
				}
				if (searchable && data === "/") {
					searchActive = true;
					searchCursor = Array.from(searchQuery).length;
					requestRender();
					return;
				}

				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
					done({ type: "cancel" } as TAction);
					return;
				}
				if (matchesKey(data, Key.enter)) {
					pickSelected();
					return;
				}

				const activeRows = getActiveRows();
				if (matchesKey(data, Key.up)) {
					moveSelection(Math.max(0, selectedIndex - 1));
					return;
				}
				if (matchesKey(data, Key.down)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + 1));
					return;
				}
				if (matchesKey(data, Key.pageUp)) {
					moveSelection(Math.max(0, selectedIndex - viewportRows));
					return;
				}
				if (matchesKey(data, Key.pageDown)) {
					moveSelection(Math.min(activeRows.length - 1, selectedIndex + viewportRows));
					return;
				}
				if (matchesKey(data, Key.home)) {
					moveSelection(0);
					return;
				}
				if (matchesKey(data, Key.end)) {
					moveSelection(activeRows.length - 1);
					return;
				}
			},
			render(width: number): string[] {
				const activeRows = getActiveRows();
				selectedIndex = clampIndex(selectedIndex, activeRows.length);
				syncCursor(activeRows);

				const border = theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
				const hintLines = layoutHintLines(getHints(), theme, width);
				const summarySource = options.getSummaryLines?.()
					?? options.summaryLines
					?? (help ? help.split("\n") : []);
				const summaryLines = summarySource
					.map((line) => truncateToWidth(theme.fg("dim", line), width));
				const searchLine = searchable && (searchActive || searchQuery) ? renderQueryLine(width) : undefined;
				const tableHeaderText = typeof options.tableHeader === "function"
					? options.tableHeader(width, theme)
					: options.tableHeader;
				// [喵喵喵]: 详情文本由调用方按语义着色，这里只负责裁剪，避免外层样式与内层 reset 互相打断。
				const detailLines = (options.getDetailLines?.(activeRows[selectedIndex], theme) ?? [])
					.map((line) => truncateToWidth(line, width));

				// [喵喵喵]: 矮终端下按优先级降级：上下边框、标题、快捷键提示和最小列表必须保留，
				// 剩余空间才依次发给搜索行、表头、摘要、详情；否则总行数超过终端高度时底部提示会被裁掉。
				const budget = getRowBudget();
				const essentialRows = 2 + 1 + 1 + (hintLines.length > 0 ? hintLines.length + 1 : 0);
				// [喵喵喵]: 列表装不下时底部会多一行位置提示，先按最坏情况预留；
				// 放到算出 viewportRows 之后再扣，在列表已压到最小时就无处可扣了。
				const scrollHintRows = activeRows.length > MIN_LIST_ROWS ? 1 : 0;
				let spare = budget - essentialRows - MIN_LIST_ROWS - scrollHintRows;

				const showSearchLine = searchLine !== undefined && spare >= 1;
				if (showSearchLine) spare -= 1;
				const showTableHeader = Boolean(tableHeaderText) && spare >= 1;
				if (showTableHeader) spare -= 1;
				const showSummary = summaryLines.length > 0 && spare >= summaryLines.length;
				if (showSummary) spare -= summaryLines.length;
				const detailBlockRows = detailLines.length > 0 ? detailLines.length + 2 : 0;
				const showDetail = detailBlockRows > 0 && spare >= detailBlockRows;
				if (showDetail) spare -= detailBlockRows;

				viewportRows = Math.min(configuredVisibleRows, MIN_LIST_ROWS + Math.max(0, spare));

				const headLines: string[] = [
					border,
					truncateToWidth(theme.fg("accent", theme.bold(title)), width),
				];
				if (showSummary) headLines.push(...summaryLines);
				if (showSearchLine) headLines.push(searchLine!);
				headLines.push("");
				if (showTableHeader) headLines.push(truncateToWidth(theme.fg("dim", tableHeaderText!), width));

				const tailLines: string[] = [];
				if (showDetail) tailLines.push("", border, ...detailLines);
				if (hintLines.length > 0) tailLines.push("", ...hintLines.map((line) => truncateToWidth(line, width)));
				tailLines.push(border);

				const windowStart = Math.max(
					0,
					Math.min(selectedIndex - Math.floor(viewportRows / 2), Math.max(0, activeRows.length - viewportRows)),
				);
				const shownRows = activeRows.slice(windowStart, windowStart + viewportRows);
				const scrolling = activeRows.length > viewportRows;
				const contentWidth = Math.max(0, scrolling ? width - SCROLLBAR_WIDTH : width);

				const bodyLines: string[] = [];
				if (shownRows.length === 0) {
					const emptyLabel = searchQuery ? t("无匹配项：{query}", { query: searchQuery }) : options.emptyLabel ?? t("暂无条目");
					bodyLines.push(truncateToWidth(theme.fg("dim", `  ${emptyLabel}`), width));
				} else {
					for (let offset = 0; offset < shownRows.length; offset += 1) {
						const row = shownRows[offset]!;
						const selected = windowStart + offset === selectedIndex;
						const prefix = selected ? "❯ " : "  ";
						const rowLabel = options.formatRow?.(row, Math.max(0, contentWidth - visibleWidth(prefix)), theme) ?? row.label;
						const rowText = truncateToWidth(`${prefix}${rowLabel}`, contentWidth);
						// [喵喵喵]: 选中行用背景色而不是整行前景色，列内的语义色才不会被抹平。
						const styledRow = selected ? theme.bg("selectedBg", padToVisibleWidth(rowText, contentWidth)) : rowText;
						bodyLines.push(scrolling
							? `${styledRow} ${theme.fg("borderMuted", getScrollbarGlyph(offset, viewportRows, windowStart, activeRows.length))}`
							: styledRow);
					}
					if (scrolling) {
						const position = `${windowStart + 1}-${windowStart + shownRows.length} / ${activeRows.length}`;
						bodyLines.push(theme.fg("dim", padToVisibleWidth("", Math.max(0, contentWidth - visibleWidth(position))) + position));
					}
				}

				return [...headLines, ...bodyLines, ...tailLines].map((line) => truncateToWidth(line, width));
			},
		};
	});
}

// 内部基础菜单：对外只暴露 showOptionPicker / showPersistentFormMenu / showPersistentShortcutMenu 三个语义入口。
async function showPersistentMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentMenuOptions = {},
): Promise<MenuAction> {
	return createPersistentMenu<MenuAction>(ctx, title, help, rows, cursor, undefined, [], undefined, options);
}
// 单选弹窗：两个编辑器的所有枚举字段都走这里，避免同一表单里出现两种选择器外观。
export async function showOptionPicker<TChoice extends { id: string; label: string }>(
	ctx: ExtensionCommandContext,
	title: string,
	choices: readonly TChoice[],
	currentId: string,
): Promise<TChoice | undefined> {
	const cursor: MenuCursor = { index: Math.max(0, choices.findIndex((choice) => choice.id === currentId)) };
	const action = await showPersistentMenu(
		ctx,
		title,
		"",
		choices.map((choice) => ({
			id: choice.id,
			label: choice.id === currentId ? `${choice.label}  ${t("← 当前")}` : choice.label,
		})),
		cursor,
		{
			hints: [
				{ key: "↑↓", label: t("移动") },
				{ key: "Enter", label: t("选择") },
				{ key: "Esc", label: t("返回") },
			],
		},
	);
	if (action.type === "cancel") return undefined;
	return choices.find((choice) => choice.id === action.id);
}

export async function showPersistentFormMenu(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	options: PersistentFormMenuOptions = {},
): Promise<FormMenuAction> {
	return createPersistentMenu<FormMenuAction>(
		ctx,
		title,
		help,
		rows,
		cursor,
		() => ({ type: "save" }),
		[],
		options.onAdjust,
		options,
	);
}

export async function showPersistentShortcutMenu<TShortcut extends string>(
	ctx: ExtensionCommandContext,
	title: string,
	help: string,
	rows: MenuRow[],
	cursor: MenuCursor,
	shortcuts: MenuShortcut<TShortcut>[],
	options: PersistentMenuOptions = {},
): Promise<ShortcutMenuAction<TShortcut>> {
	return createPersistentMenu<ShortcutMenuAction<TShortcut>>(ctx, title, help, rows, cursor, undefined, shortcuts, undefined, { searchable: true, ...options });
}
