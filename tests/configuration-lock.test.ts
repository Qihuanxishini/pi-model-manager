import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const agentDir = join(tmpdir(), `pi-model-manager-lock-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { STATE_DIR } = await import("../state-metadata-store.ts");
const { withConfigurationLock } = await import("../configuration-lock.ts");
const lockPath = join(STATE_DIR, "config.lock");

beforeEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(STATE_DIR, { recursive: true });
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("同一配置目录中的并发操作按独占锁串行执行", async () => {
	const events: string[] = [];
	const first = withConfigurationLock(async () => {
		events.push("first:start");
		await delay(150);
		events.push("first:end");
	});
	await delay(15);
	const second = withConfigurationLock(async () => {
		events.push("second:start");
		events.push("second:end");
	});

	await Promise.all([first, second]);
	assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("已退出的同主机进程锁可被回收", async () => {
	const deadPid = await new Promise<number>((resolve, reject) => {
		const processHandle = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		const pid = processHandle.pid;
		processHandle.once("error", reject);
		processHandle.once("exit", () => pid ? resolve(pid) : reject(new Error("子进程没有 PID")));
	});
	await writeFile(lockPath, `${JSON.stringify({
		token: "stale",
		pid: deadPid,
		hostname: hostname(),
		startedAt: new Date().toISOString(),
	})}\n`, "utf8");

	let entered = false;
	await withConfigurationLock(async () => {
		entered = true;
	});
	assert.equal(entered, true);
});

test("超过保护期的损坏锁文件可被回收", async () => {
	await writeFile(lockPath, "incomplete", "utf8");
	const old = new Date(Date.now() - 60_000);
	await utimes(lockPath, old, old);

	let entered = false;
	await withConfigurationLock(async () => {
		entered = true;
	});
	assert.equal(entered, true);
});


test("超过最大持有期的活跃进程锁会被 TTL 兑底回收", async () => {
	await writeFile(lockPath, `${JSON.stringify({
		token: "expired",
		pid: process.pid,
		hostname: hostname(),
		startedAt: new Date(Date.now() - 605_000).toISOString(),
	})}\n`, "utf8");

	let entered = false;
	await withConfigurationLock(async () => {
		entered = true;
	});
	assert.equal(entered, true);
});

test("遗留的 config.lock.stale.* 残留会在下次获取锁时被清理", async () => {
	const stalePath = join(STATE_DIR, "config.lock.stale.orphan");
	await writeFile(stalePath, "orphan", "utf8");
	const old = new Date(Date.now() - 60_000);
	await utimes(stalePath, old, old);

	let entered = false;
	await withConfigurationLock(async () => {
		entered = true;
	});
	assert.equal(entered, true);
	await assert.rejects(access(stalePath), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
});

test("新鲜的 config.lock.stale.* 不会被误删，留给其创建进程自行处理", async () => {
	const stalePath = join(STATE_DIR, "config.lock.stale.fresh");
	await writeFile(stalePath, "in-flight", "utf8");

	let entered = false;
	await withConfigurationLock(async () => {
		entered = true;
	});
	assert.equal(entered, true);
	await access(stalePath);
});
