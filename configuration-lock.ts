// 跨 Pi 进程的配置 mutation 锁。只约束遵守本锁的插件写入，外部编辑器冲突另由内容签名检测。

import { hostname } from "node:os";
import { mkdir, readFile, readdir, lstat, unlink, rmdir, writeFile, link } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { t } from "./i18n.ts";
import { STATE_DIR } from "./state-metadata-store.ts";

interface ConfigurationLockRecord {
	token: string;
	pid: number;
	hostname: string;
	startedAt: string;
	processStartedAt?: string;
}

interface HeldConfigurationLock {
	record: ConfigurationLockRecord;
	ownerFileName: string;
	recordSourcePath: string;
}

const LOCK_PATH = join(STATE_DIR, "config.lock");
const LOCK_WAIT_MS = 1_600;
const LOCK_RETRY_MS = 25;
const INVALID_LOCK_STALE_MS = 30_000;
const OWNER_FILE_PATTERN = /^owner-([a-z0-9-]+)\.json$/i;
const execFileAsync = promisify(execFile);
let ownProcessStartedAt: Promise<string> | undefined;

async function readProcessStartedAt(pid: number): Promise<string> {
	if (process.platform === "linux") {
		const [stat, bootId] = await Promise.all([
			readFile(`/proc/${pid}/stat`, "utf8"),
			readFile("/proc/sys/kernel/random/boot_id", "utf8"),
		]);
		// [喵喵喵]: comm 可以包含空格和括号，须从最后一个右括号后定位第 22 字段；boot ID 区分重启。
		const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
		if (!ticks || !/^\d+$/.test(ticks) || !bootId.trim()) throw new Error("Invalid process start identity");
		return `linux:${bootId.trim()}:${ticks}`;
	}
	if (process.platform === "win32") {
		const { stdout } = await execFileAsync("pwsh", ["-NoProfile", "-NonInteractive", "-Command",
			`$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)`,
		], { timeout: 1_500, maxBuffer: 8_192, windowsHide: true });
		const ticks = stdout.trim();
		if (!/^\d+$/.test(ticks)) throw new Error("Invalid process start identity");
		return `win32:${ticks}`;
	}
	if (process.platform === "darwin") {
		const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
			timeout: 1_500, maxBuffer: 8_192, env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
		});
		if (!stdout.trim()) throw new Error("Missing process start identity");
		return `darwin:${stdout.trim()}`;
	}
	throw new Error(`Unsupported platform: ${process.platform}`);
}

function getOwnProcessStartedAt(): Promise<string> {
	return ownProcessStartedAt ??= readProcessStartedAt(process.pid).catch(() => {
		ownProcessStartedAt = undefined;
		throw new Error(t("无法确认当前进程的创建时间，未获取配置锁；请检查系统进程查询权限（Windows 需要 PowerShell 7 / pwsh）。"));
	});
}

function lockPublicationError(error: unknown): Error {
	return new Error(t("无法发布配置锁的硬链接（{code}）：{path}；请检查目录权限、文件系统硬链接支持或目录占用。", {
		code: getErrorCode(error) ?? "UNKNOWN", path: LOCK_PATH,
	}), { cause: error });
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function isWindowsDirectoryBusy(error: unknown): boolean {
	return process.platform === "win32" && ["EPERM", "EBUSY"].includes(getErrorCode(error) ?? "");
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

async function isSameHostProcessRunning(record: ConfigurationLockRecord, identities: Map<string, Promise<string | undefined>>): Promise<boolean> {
	if (record.hostname !== hostname()) return true;
	// [喵喵喵]: 不按持有时长抢占活跃进程；暂停或慢磁盘不能使尚未结束的事务失去互斥。
	try {
		process.kill(record.pid, 0);
	} catch (error) {
		return getErrorCode(error) !== "ESRCH";
	}
	if (typeof record.processStartedAt !== "string" || !record.processStartedAt) return true;
	let identity = identities.get(record.token);
	if (!identity) {
		identity = (record.pid === process.pid ? getOwnProcessStartedAt() : readProcessStartedAt(record.pid)).catch(() => undefined);
		identities.set(record.token, identity);
	}
	const current = await identity;
	return current === undefined || current === record.processStartedAt;
}

async function removeEmptyDirectory(path: string): Promise<boolean> {
	try {
		await rmdir(path);
		return true;
	} catch (error) {
		const code = getErrorCode(error);
		if (code === "ENOENT") return true;
		// [喵喵喵]: Windows 同路径删除竞争可能返回 EPERM/EBUSY；视为未回收，由获取流程有界等待，不能当作删除成功。
		if (code === "ENOTEMPTY" || code === "EEXIST" || code === "ENOTDIR" || code === "EBUSY"
			|| isWindowsDirectoryBusy(error)) return false;
		throw error;
	}
}

async function removeInactiveLock(identities: Map<string, Promise<string | undefined>>): Promise<boolean> {
	try {
		const stats = await lstat(LOCK_PATH);
		if (!stats.isDirectory()) {
			if (!stats.isFile()) return false;
			const record = parseLockRecord(await readFile(LOCK_PATH, "utf8"));
			if (record ? await isSameHostProcessRunning(record, identities) : Date.now() - stats.mtimeMs < INVALID_LOCK_STALE_MS) return false;
			// [喵喵喵]: 旧进程不认识目录协议；自动搬走旧文件仍会重现抢锁竞态，必须人工核对后处理。
			throw new Error(t("检测到旧版失效配置锁；请确认没有旧版 Pi 正在保存，再手动移除：{path}", { path: LOCK_PATH }));
		}
		const entries = await readdir(LOCK_PATH);
		if (entries.length === 0) {
			return Date.now() - stats.mtimeMs >= INVALID_LOCK_STALE_MS && await removeEmptyDirectory(LOCK_PATH);
		}
		if (entries.length !== 1) return false;
		const name = entries[0]!;
		const match = OWNER_FILE_PATTERN.exec(name);
		if (!match) return false;
		const ownerPath = join(LOCK_PATH, name);
		const record = parseLockRecord(await readFile(ownerPath, "utf8"));
		if (record) {
			if (record.token !== match[1] || await isSameHostProcessRunning(record, identities)) return false;
		} else if (Date.now() - (await lstat(ownerPath)).mtimeMs < INVALID_LOCK_STALE_MS) {
			return false;
		}
		// [喵喵喵]: 只删读到的唯一旧标记。若另一回收者已完成且新锁已发布，新 token 会使 rmdir 以非空失败。
		await unlink(ownerPath).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") throw error;
		});
		return removeEmptyDirectory(LOCK_PATH);
	} catch (error) {
		if (getErrorCode(error) === "ENOENT") return true;
		if (isWindowsDirectoryBusy(error)) return false;
		throw error;
	}
}

async function discardOwnClaim(ownerFileName: string): Promise<void> {
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			await unlink(join(LOCK_PATH, ownerFileName));
			break;
		} catch (error) {
			if (["ENOENT", "ENOTDIR"].includes(getErrorCode(error) ?? "")) break;
			if (!isWindowsDirectoryBusy(error) || Date.now() >= deadline) throw error;
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	await removeEmptyDirectory(LOCK_PATH);
}

async function acquireConfigurationLock(): Promise<HeldConfigurationLock> {
	await mkdir(STATE_DIR, { recursive: true });
	const record: ConfigurationLockRecord = {
		token: randomUUID(), pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString(),
		processStartedAt: await getOwnProcessStartedAt(),
	};
	const ownerFileName = `owner-${record.token}.json`;
	const recordSourcePath = join(STATE_DIR, `config.lock.source.${record.token}`);
	await writeFile(recordSourcePath, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
	let acquired = false;
	let lastLinkError: unknown;
	const identities = new Map<string, Promise<string | undefined>>();
	try {
		const deadline = Date.now() + LOCK_WAIT_MS;
		while (true) {
			let created = false;
			try {
				await mkdir(LOCK_PATH, { mode: 0o700 });
				created = true;
			} catch (error) {
				if (getErrorCode(error) !== "EEXIST" && !isWindowsDirectoryBusy(error)) throw error;
			}
			if (created) {
				try {
					// [喵喵喵]: 完整记录以硬链接原子发布后不再修改，避免半写记录在暂停后被判为损坏旧锁、却又恢复为活跃锁。
					try {
						await link(recordSourcePath, join(LOCK_PATH, ownerFileName));
						lastLinkError = undefined;
					} catch (error) {
						lastLinkError = error;
						throw error;
					}
					// [喵喵喵]: 空目录被回收后，旧初始化者可能把标记发布到新目录；只有独占自身标记才允许进入事务。
					const entries = await readdir(LOCK_PATH);
					if (entries.length === 1 && entries[0] === ownerFileName) {
						acquired = true;
						return { record, ownerFileName, recordSourcePath };
					}
				} catch (error) {
					// [喵喵喵]: 删除挂起在 Windows 上也会令后续 mkdir/link/readdir 返回忙；只有完成发布并确认独占才算成功。
					if (!["ENOENT", "ENOTDIR"].includes(getErrorCode(error) ?? "") && !isWindowsDirectoryBusy(error)) {
						await discardOwnClaim(ownerFileName);
						throw error === lastLinkError ? lockPublicationError(error) : error;
					}
				}
				await discardOwnClaim(ownerFileName);
			} else if (await removeInactiveLock(identities)) {
				if (Date.now() < deadline) continue;
			}
			if (Date.now() >= deadline) break;
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
		if (lastLinkError) throw lockPublicationError(lastLinkError);
		throw new Error(t("无法在限定时间内获取锁：{path}；持有者仍在运行或身份无法确认，请核对锁记录后重试。", { path: LOCK_PATH }));
	} finally {
		if (!acquired) await unlink(recordSourcePath);
	}
}

async function releaseConfigurationLock(lock: HeldConfigurationLock): Promise<void> {
	try {
		const ownerPath = join(LOCK_PATH, lock.ownerFileName);
		const current = await readFile(ownerPath, "utf8").then(parseLockRecord).catch((error: unknown) => {
			if (getErrorCode(error) !== "ENOENT") throw error;
			return undefined;
		});
		if (current?.token !== lock.record.token) {
			throw new Error(t("配置锁所有权在释放前发生变化，已保留锁文件供检查：{path}", { path: LOCK_PATH }));
		}
		await unlink(ownerPath);
		await removeEmptyDirectory(LOCK_PATH);
	} finally {
		await unlink(lock.recordSourcePath);
	}
}

export async function withConfigurationLock<T>(operation: () => Promise<T>): Promise<T> {
	const lock = await acquireConfigurationLock();
	try {
		return await operation();
	} finally {
		await releaseConfigurationLock(lock);
	}
}
