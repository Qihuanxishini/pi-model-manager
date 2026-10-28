import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
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
after(async () => { await rm(agentDir, { recursive: true, force: true }); });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function exitedPid(): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
		child.once("error", reject);
		child.once("exit", () => child.pid ? resolve(child.pid) : reject(new Error("子进程没有 PID")));
	});
}

async function seedLock(pid: number, token = "stale", startedAt = new Date().toISOString()): Promise<string> {
	await mkdir(lockPath);
	const path = join(lockPath, `owner-${token}.json`);
	await writeFile(path, JSON.stringify({ token, pid, hostname: hostname(), startedAt }));
	return path;
}

test("同一配置目录中的并发操作按独占锁串行执行", async () => {
	const events: string[] = [];
	const first = withConfigurationLock(async () => {
		events.push("first:start");
		await delay(150);
		events.push("first:end");
	});
	await delay(15);
	const second = withConfigurationLock(async () => { events.push("second:start", "second:end"); });
	await Promise.all([first, second]);
	assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
});

test("已退出的同主机进程锁可被回收", async () => {
	await seedLock(await exitedPid());
	let entered = false;
	await withConfigurationLock(async () => { entered = true; });
	assert.equal(entered, true);
	await assert.rejects(access(lockPath));
});

test("超过保护期的损坏标记可被回收", async () => {
	const marker = await seedLock(process.pid, "corrupt");
	await writeFile(marker, "incomplete");
	const old = new Date(Date.now() - 60_000);
	await utimes(marker, old, old);
	await withConfigurationLock(async () => undefined);
	await assert.rejects(access(lockPath));
});

test("超过十分钟但进程仍活跃的锁不被抢占", async () => {
	const marker = await seedLock(process.pid, "active", new Date(Date.now() - 605_000).toISOString());
	await assert.rejects(withConfigurationLock(async () => assert.fail("不得进入活跃事务")), /无法在限定时间内获取锁/);
	await access(marker);
});

test("旧版失效文件锁保留并提示人工核对，不再移动后恢复", async () => {
	await writeFile(lockPath, JSON.stringify({ token: "legacy", pid: await exitedPid(), hostname: hostname(), startedAt: new Date().toISOString() }));
	const before = await readFile(lockPath, "utf8");
	await assert.rejects(withConfigurationLock(async () => assert.fail("不得跨协议抢锁")), /旧版失效配置锁/);
	assert.equal(await readFile(lockPath, "utf8"), before);
	assert.deepEqual(await readdir(STATE_DIR), ["config.lock"]);
});

test("多个回收者竞争同一失效锁时仍保持事务互斥", async () => {
	await seedLock(await exitedPid(), "stale-race");
	let active = 0;
	const results = await Promise.allSettled(Array.from({ length: 12 }, () => withConfigurationLock(async () => {
		active += 1;
		try {
			assert.equal(active, 1, "配置事务不得同时进入");
			await delay(10);
		} finally { active -= 1; }
	})));
	assert.deepEqual(results.filter((result) => result.status === "rejected"), []);
	assert.deepEqual(await readdir(STATE_DIR), []);
});

test("不同 Pi 进程竞争失效目录锁后，文件事务仍完整串行", async () => {
	await seedLock(await exitedPid(), "cross-process");
	const eventsPath = join(agentDir, "events.txt");
	await writeFile(eventsPath, "");
	const source = `
		import { appendFile } from "node:fs/promises";
		const { withConfigurationLock } = await import(${JSON.stringify(new URL("../configuration-lock.ts", import.meta.url).href)});
		await withConfigurationLock(async () => {
			await appendFile(${JSON.stringify(eventsPath)}, "start:" + process.pid + "\\n");
			await new Promise((resolve) => setTimeout(resolve, 20));
			await appendFile(${JSON.stringify(eventsPath)}, "end:" + process.pid + "\\n");
		});`;
	await Promise.all(Array.from({ length: 3 }, () => new Promise<void>((resolve, reject) => {
		const child = spawn(process.execPath, ["--experimental-strip-types", "--import", new URL("./register-test-loader.mjs", import.meta.url).href, "--input-type=module", "-e", source], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (data) => { stderr += data; });
		child.once("error", reject);
		child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
	})));
	const events = (await readFile(eventsPath, "utf8")).trim().split("\n");
	assert.equal(events.length, 6);
	for (let index = 0; index < events.length; index += 2) {
		assert.match(events[index]!, /^start:\d+$/);
		assert.equal(events[index + 1], events[index]!.replace("start:", "end:"));
	}
	assert.deepEqual(await readdir(STATE_DIR), []);
});
