// 跨 Pi 进程的配置 mutation 锁。只约束遵守本锁的插件写入，外部编辑器冲突另由内容签名检测。

import { hostname } from "node:os";
import { open, mkdir, readFile, readdir, stat, unlink, rename, link, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { t } from "./i18n.ts";
import { STATE_DIR } from "./state-metadata-store.ts";

interface ConfigurationLockRecord {
	token: string;
	pid: number;
	hostname: string;
	startedAt: string;
}

interface HeldConfigurationLock {
	handle: FileHandle;
	record: ConfigurationLockRecord;
}

const LOCK_PATH = join(STATE_DIR, "config.lock");
const LOCK_RETRY_DELAYS_MS = [50, 100, 200, 400, 800] as const;
const INVALID_LOCK_STALE_MS = 30_000;
const STALE_LOCK_NAME_PREFIX = "config.lock.stale.";
// [喵喵喵]: 持有期上限需远大于任何合理单次事务耗时（本地文件 I/O），避免误抢活跃锁；仅作为 PID 复用死锁的兑底
const MAX_LOCK_HOLD_MS = 600_000;

function isLockExpired(record: ConfigurationLockRecord): boolean {
	const started = Date.parse(record.startedAt);
	return Number.isFinite(started) && Date.now() - started > MAX_LOCK_HOLD_MS;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function parseLockRecord(source: string): ConfigurationLockRecord | undefined {
	try {
		const parsed = JSON.parse(source) as Partial<ConfigurationLockRecord>;
		if (typeof parsed.token !== "string" || !parsed.token) return undefined;
		if (!Number.isInteger(parsed.pid) || (parsed.pid ?? 0) <= 0) return undefined;
		if (typeof parsed.hostname !== "string" || !parsed.hostname) return undefined;
		if (typeof parsed.startedAt !== "string" || !parsed.startedAt) return undefined;
		return parsed as ConfigurationLockRecord;
	} catch {
		return undefined;
	}
}

function isSameHostProcessRunning(record: ConfigurationLockRecord): boolean {
	if (record.hostname !== hostname()) return true;
	// [喵喵喵]: 超过最大持有期（10 分钟）视为僵死锁，防止 PID 被操作系统常驻后台进程复用导致永久死锁
	if (isLockExpired(record)) return false;
	try {
		process.kill(record.pid, 0);
		return true;
	} catch (error) {
		return getErrorCode(error) !== "ESRCH";
	}
}

async function removeInactiveLock(): Promise<boolean> {
	let source: string;
	try {
		source = await readFile(LOCK_PATH, "utf8");
	} catch (error) {
		return getErrorCode(error) === "ENOENT";
	}
	const record = parseLockRecord(source);
	if (record && isSameHostProcessRunning(record)) return false;
	if (!record) {
		try {
			const lockStats = await stat(LOCK_PATH);
			if (Date.now() - lockStats.mtimeMs < INVALID_LOCK_STALE_MS) return false;
		} catch (error) {
			return getErrorCode(error) === "ENOENT";
		}
	}

	// [喵喵喵]: 先原子重命名到临时路径再清理，防止 TOCTOU 竞态误删刚刚获取的新锁
	const stalePath = `${LOCK_PATH}.stale.${randomUUID()}`;
	try {
		await rename(LOCK_PATH, stalePath);
	} catch (error) {
		return getErrorCode(error) === "ENOENT";
	}

	try {
		const movedSource = await readFile(stalePath, "utf8");
		const movedRecord = parseLockRecord(movedSource);
		// [喵喵喵]: token 不一致说明读取后锁文件已被活跃进程替换，必须放回且不得覆盖新锁
		if (record && movedRecord?.token !== record.token) {
			await restoreMovedLock(stalePath);
			return false;
		}
		await unlink(stalePath);
		return true;
	} catch {
		// [喵喵喵]: 校验阶段异常时不能销毁内容未知的锁文件，尽力放回并交由下次获取重试判定
		await restoreMovedLock(stalePath);
		return false;
	}
}

// [喵喵喵]: 用 link 原子放回：目标已存在时以 EEXIST 失败，绝不覆盖他人在空窗期新建的锁
async function restoreMovedLock(stalePath: string): Promise<void> {
	try {
		await link(stalePath, LOCK_PATH);
	} catch (error) {
		if (getErrorCode(error) === "EEXIST") return;
		throw error;
	}
	await unlink(stalePath).catch(() => undefined);
}

// [喵喵喵]: 清理历史进程崩溃遗留的 config.lock.stale.* 残留（正常生命周期仅存在微秒级）
async function sweepAbandonedStaleLocks(): Promise<void> {
	let entries: string[];
	try {
		entries = await readdir(STATE_DIR);
	} catch {
		return;
	}
	await Promise.all(entries
		.filter((name) => name.startsWith(STALE_LOCK_NAME_PREFIX))
		.map(async (name) => {
			const stalePath = join(STATE_DIR, name);
			try {
				const stats = await stat(stalePath);
				if (Date.now() - stats.mtimeMs < INVALID_LOCK_STALE_MS) return;
				await unlink(stalePath);
			} catch {
				// 并发清理或文件已消失时静默跳过
			}
		}));
}

async function acquireConfigurationLock(): Promise<HeldConfigurationLock> {
	await mkdir(STATE_DIR, { recursive: true });
	await sweepAbandonedStaleLocks();
	const record: ConfigurationLockRecord = {
		token: randomUUID(),
		pid: process.pid,
		hostname: hostname(),
		startedAt: new Date().toISOString(),
	};

	for (let attempt = 0; attempt <= LOCK_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			const handle = await open(LOCK_PATH, "wx");
			try {
				await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
				await handle.sync();
				return { handle, record };
			} catch (error) {
				await handle.close().catch(() => undefined);
				await unlink(LOCK_PATH).catch(() => undefined);
				throw error;
			}
		} catch (error) {
			if (getErrorCode(error) !== "EEXIST") throw error;
			if (await removeInactiveLock()) continue;
			if (attempt === LOCK_RETRY_DELAYS_MS.length) break;
			await sleep(LOCK_RETRY_DELAYS_MS[attempt]!);
		}
	}
	throw new Error(t("另一个 Pi 进程正在保存模型配置；无法在限定时间内获取锁：{path}", { path: LOCK_PATH }));
}

async function releaseConfigurationLock(lock: HeldConfigurationLock): Promise<void> {
	await lock.handle.close();
	let current: ConfigurationLockRecord | undefined;
	try {
		current = parseLockRecord(await readFile(LOCK_PATH, "utf8"));
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return;
		throw error;
	}
	if (current?.token !== lock.record.token) {
		throw new Error(t("配置锁所有权在释放前发生变化，已保留锁文件供检查：{path}", { path: LOCK_PATH }));
	}
	await unlink(LOCK_PATH);
}

export async function withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
	const lock = await acquireConfigurationLock();
	try {
		return await operation();
	} finally {
		await releaseConfigurationLock(lock);
	}
}
