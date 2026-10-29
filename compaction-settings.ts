// compaction-settings.ts
//
// Pi 的上下文压缩阈值来自 settings.json（不是 models.json）：
//   compaction.reserveTokens
//   compaction.modelOverrides["provider/modelId"].reserveTokens
// 自动压缩在 contextTokens > contextWindow - reserveTokens 时触发，所以"预留窗口"就是 reserveTokens。
//
// 本模块只写全局 settings.json 里 compaction.modelOverrides 的 reserveTokens，其余 compaction 设置
// （keepRecentTokens、enabled 等）与文件里的未知字段原样保留。

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import settingsFileLock from "proper-lockfile";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { atomicWriteText } from "./atomic-write.ts";
import { cloneJson, formatUnknownError, isObjectRecord, stringifyJson, stripJsonNoise } from "./common.ts";
import { readStableTextFileSnapshot } from "./file-snapshot.ts";
import { t } from "./i18n.ts";
import type { CompactionReserveChoice } from "./types.ts";

export const DEFAULT_COMPACTION_RESERVE_TOKENS = 16_384;

// [喵喵喵]: 新建模型默认按上下文窗口的 12% 给压缩预留，并保留一个不低于 16K 的下限。
// Pi 的默认预留是固定 16K，大窗口模型上要撑到 98% 才压缩；按比例给才不会随窗口漂移。
const AUTO_COMPACTION_RESERVE_RATIO = 0.12;
const AUTO_COMPACTION_RESERVE_FLOOR = 16_384;

export function resolveAutoCompactionReserve(contextWindow: number): number {
	return Math.max(AUTO_COMPACTION_RESERVE_FLOOR, Math.round(contextWindow * AUTO_COMPACTION_RESERVE_RATIO));
}

/** 把档位解析成要写进 settings.json 的 token；global 表示不写模型级覆盖。 */
export function resolveCompactionReserveChoice(
	choice: CompactionReserveChoice,
	contextWindow: number,
): number | undefined {
	if (choice === "global") return undefined;
	if (choice === "auto") return resolveAutoCompactionReserve(contextWindow);
	return choice;
}

export interface CompactionModelOverride {
	reserveTokens?: number;
}

export interface CompactionSettingsSnapshot {
	/** 生效的默认预留 token（全局设置，未配置时用 Pi 默认）。 */
	reserveTokens: number;
	/** 生效的模型级覆盖。 */
	modelOverrides: Record<string, CompactionModelOverride>;
	/** 读取阶段发现的问题；只用于提示，不阻止用户继续编辑。 */
	warnings: string[];
}

interface CompactionLayer {
	reserveTokens?: number;
	modelOverrides: Record<string, CompactionModelOverride>;
}

export function getGlobalSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

function readReserveTokens(
	raw: Record<string, unknown>,
	path: string,
	warnings: string[],
): number | undefined {
	const value = raw.reserveTokens;
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		warnings.push(t("{path} 的 compaction.reserveTokens 必须是非负整数", { path }));
		return undefined;
	}
	return value;
}

function readModelOverrides(
	raw: Record<string, unknown>,
	path: string,
	warnings: string[],
): Record<string, CompactionModelOverride> {
	const source = raw.modelOverrides;
	if (source === undefined) return {};
	if (!isObjectRecord(source)) {
		warnings.push(t("{path} 的 compaction.modelOverrides 必须是对象", { path }));
		return {};
	}
	const overrides: Record<string, CompactionModelOverride> = {};
	for (const [fullModelId, value] of Object.entries(source)) {
		if (!isObjectRecord(value)) {
			warnings.push(t("{path} 的 compaction.modelOverrides.{fullModelId} 必须是对象", { path, fullModelId }));
			continue;
		}
		const reserveTokens = readReserveTokens(value, path, warnings);
		if (reserveTokens !== undefined) overrides[fullModelId] = { reserveTokens };
	}
	return overrides;
}

async function readCompactionLayer(path: string, warnings: string[]): Promise<CompactionLayer> {
	const empty: CompactionLayer = { modelOverrides: {} };
	const snapshot = await readStableTextFileSnapshot(path);
	if (snapshot.source === undefined) return empty;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonNoise(snapshot.source));
	} catch (error) {
		warnings.push(t("{path} 不是有效的 JSON：{error}", { path, error: formatUnknownError(error) }));
		return empty;
	}
	if (!isObjectRecord(parsed)) {
		warnings.push(t("{path} 根节点必须是对象", { path }));
		return empty;
	}
	const raw = parsed.compaction;
	if (raw === undefined) return empty;
	if (!isObjectRecord(raw)) {
		warnings.push(t("{path} 的 compaction 必须是对象", { path }));
		return empty;
	}
	const layer: CompactionLayer = { modelOverrides: readModelOverrides(raw, path, warnings) };
	const reserveTokens = readReserveTokens(raw, path, warnings);
	if (reserveTokens !== undefined) layer.reserveTokens = reserveTokens;
	return layer;
}

// [喵喵喵]: 扩展只写全局 settings.json。项目 .pi/settings.json 声明了 compaction 时，
// Pi 的深合并会让项目设置盖住全局写入，这时得先提醒用户，否则改了像没生效。
async function warnIfProjectDeclaresCompaction(cwd: string, warnings: string[]): Promise<void> {
	const path = join(cwd, CONFIG_DIR_NAME, "settings.json");
	const snapshot = await readStableTextFileSnapshot(path);
	if (snapshot.source === undefined) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonNoise(snapshot.source));
	} catch {
		// 项目设置的解析错误由 Pi 自己报，与本次写入无关。
		return;
	}
	if (isObjectRecord(parsed) && Object.hasOwn(parsed, "compaction")) {
		warnings.push(t("项目 {path} 也声明了 compaction，Pi 会让项目设置盖住这里写入的压缩预留", { path }));
	}
}

export async function readCompactionSettings(cwd: string): Promise<CompactionSettingsSnapshot> {
	const warnings: string[] = [];
	const layer = await readCompactionLayer(getGlobalSettingsPath(), warnings);
	await warnIfProjectDeclaresCompaction(cwd, warnings);
	return {
		reserveTokens: layer.reserveTokens ?? DEFAULT_COMPACTION_RESERVE_TOKENS,
		modelOverrides: layer.modelOverrides,
		warnings,
	};
}

type CompactionMutation = (compaction: Record<string, unknown>) => boolean;

// [喵喵喵]: 与 models-json-sync 写 enabledModels 时使用同一把 Pi 设置锁，
// 两个入口对同一个 settings.json 的写入必须互斥，否则后写的一方会覆盖对方的改动。
const SETTINGS_LOCK_OPTIONS = {
	realpath: false,
	retries: { retries: 10, factor: 1, minTimeout: 20, maxTimeout: 20 },
};

/**
 * 在锁内重读 settings.json，只改动 compaction 节点。
 * mutate 返回 false 表示没有变化，此时不写盘。
 */
async function updateSettingsCompaction(path: string, mutate: CompactionMutation): Promise<boolean> {
	// proper-lockfile 用 <path>.lock 目录加锁，父目录必须先存在。
	await mkdir(dirname(path), { recursive: true });
	const release = await settingsFileLock.lock(path, SETTINGS_LOCK_OPTIONS);
	try {
		const snapshot = await readStableTextFileSnapshot(path);
		let settings: Record<string, unknown> = {};
		if (snapshot.source !== undefined) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(stripJsonNoise(snapshot.source));
			} catch (error) {
				throw new Error(t("{path} 不是有效的 JSON：{error}", { path, error: formatUnknownError(error) }));
			}
			if (!isObjectRecord(parsed)) throw new Error(t("{path} 根节点必须是对象", { path }));
			settings = parsed;
		}
		const existing = settings.compaction;
		if (existing !== undefined && !isObjectRecord(existing)) {
			throw new Error(t("{path} 的 compaction 必须是对象", { path }));
		}
		const compaction = existing === undefined ? {} : cloneJson(existing);
		if (!mutate(compaction)) return false;
		if (Object.keys(compaction).length === 0) delete settings.compaction;
		else settings.compaction = compaction;
		const current = await readStableTextFileSnapshot(path);
		if (current.contentHash !== snapshot.contentHash) {
			throw new Error(t("{path} 已被未遵守 Pi 文件锁的编辑器修改；已取消写入，请重试。", { path }));
		}
		await atomicWriteText(path, stringifyJson(settings));
		return true;
	} finally {
		await release();
	}
}

/** 修改 compaction.modelOverrides；每个条目里的其它字段（如 keepRecentTokens）原样保留。 */
async function updateModelOverrides(
	mutate: (overrides: Record<string, Record<string, unknown>>) => boolean,
): Promise<boolean> {
	const path = getGlobalSettingsPath();
	return updateSettingsCompaction(path, (compaction) => {
		const source = compaction.modelOverrides;
		if (source !== undefined && !isObjectRecord(source)) {
			throw new Error(t("{path} 的 compaction.modelOverrides 必须是对象", { path }));
		}
		const overrides: Record<string, Record<string, unknown>> = {};
		for (const [fullModelId, value] of Object.entries(source ?? {})) {
			overrides[fullModelId] = isObjectRecord(value) ? { ...value } : {};
		}
		if (!mutate(overrides)) return false;
		if (Object.keys(overrides).length === 0) delete compaction.modelOverrides;
		else compaction.modelOverrides = overrides;
		return true;
	});
}

function deleteOverrides(
	overrides: Record<string, Record<string, unknown>>,
	fullModelIds: readonly string[],
): boolean {
	let changed = false;
	for (const fullModelId of fullModelIds) {
		if (!Object.hasOwn(overrides, fullModelId)) continue;
		delete overrides[fullModelId];
		changed = true;
	}
	return changed;
}

/** 写入（或改写）一个模型的预留覆盖；条目为空时连条目一起删除。 */
function writeReserveOverride(
	overrides: Record<string, Record<string, unknown>>,
	fullModelId: string,
	reserveTokens: number | undefined,
): boolean {
	if (reserveTokens === undefined) {
		const entry = overrides[fullModelId];
		if (!entry || !Object.hasOwn(entry, "reserveTokens")) return false;
		delete entry.reserveTokens;
		if (Object.keys(entry).length === 0) delete overrides[fullModelId];
		return true;
	}
	const entry = overrides[fullModelId] ?? {};
	if (entry.reserveTokens === reserveTokens) return false;
	entry.reserveTokens = reserveTokens;
	overrides[fullModelId] = entry;
	return true;
}

function assertReserveTokens(value: number | undefined): void {
	if (value === undefined) return;
	if (!Number.isInteger(value) || value < 0) {
		throw new Error(t("压缩预留必须是非负整数"));
	}
}

export interface ModelCompactionWriteOptions {
	fullModelId: string;
	/** undefined 表示删除覆盖，回落到默认预留。 */
	reserveTokens: number | undefined;
	/** 重命名时需要一并清理的旧键。 */
	staleFullModelIds?: readonly string[];
}

/** 写入或删除一个模型的预留覆盖；返回是否真的改了文件。 */
export async function saveModelCompactionOverride(options: ModelCompactionWriteOptions): Promise<boolean> {
	assertReserveTokens(options.reserveTokens);
	const staleFullModelIds = [...new Set(options.staleFullModelIds ?? [])]
		.filter((fullModelId) => fullModelId !== options.fullModelId);
	return updateModelOverrides((overrides) => {
		const clearedStale = deleteOverrides(overrides, staleFullModelIds);
		const written = writeReserveOverride(overrides, options.fullModelId, options.reserveTokens);
		return clearedStale || written;
	});
}

export async function removeModelCompactionOverrides(fullModelIds: readonly string[]): Promise<boolean> {
	const targets = [...new Set(fullModelIds)];
	return updateModelOverrides((overrides) => deleteOverrides(overrides, targets));
}

/** 重命名模型时把整条覆盖搬到新键上（包括 reserveTokens 之外的字段）。 */
export async function moveModelCompactionOverrides(
	moves: readonly { from: string; to: string }[],
): Promise<boolean> {
	const pending = moves.filter((move) => move.from !== move.to);
	if (pending.length === 0) return false;
	return updateModelOverrides((overrides) => {
		let changed = false;
		for (const move of pending) {
			const entry = overrides[move.from];
			if (!entry) continue;
			overrides[move.to] = { ...overrides[move.to], ...entry };
			delete overrides[move.from];
			changed = true;
		}
		return changed;
	});
}
