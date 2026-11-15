import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import test, { after, beforeEach } from "node:test";

const agentDir = await mkdtemp(resolve(".test-state-cache-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { STATE_DIR, STATE_PATH } = await import("../state-metadata-store.ts");
const { MODELS_JSON_PATH } = await import("../models-json-manager.ts");
const { invalidateStateCache, readCachedState } = await import("../state-cache.ts");

beforeEach(async () => {
	invalidateStateCache();
	await mkdir(STATE_DIR, { recursive: true });
	await writeFile(MODELS_JSON_PATH, JSON.stringify({ providers: {} }));
	await writeFile(STATE_PATH, JSON.stringify({ version: 5, managedProviderIds: [], providers: {}, models: {}, requestHeaderProfiles: {}, clientHeaderCaptures: {} }));
});
after(async () => { await rm(agentDir, { recursive: true, force: true }); });

test("并发冷读共享同一份配置读取结果", async () => {
	const states = await Promise.all(Array.from({ length: 32 }, () => readCachedState()));
	for (const state of states) assert.equal(state, states[0]);
	assert.equal(await readCachedState(), states[0]);
});

test("失效前的读取不能回填缓存或清除新一轮共享读取", { timeout: 5_000 }, async (t) => {
	const oldEntered = Promise.withResolvers<void>();
	const newEntered = Promise.withResolvers<void>();
	const releaseOld = Promise.withResolvers<void>();
	const releaseNew = Promise.withResolvers<void>();
	const failure = new Error("fixture read failed");
	const originalReadFile = fs.readFile;
	let modelReads = 0;
	const readFileMock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
		const source = await originalReadFile(...args);
		if (args[0] === MODELS_JSON_PATH) {
			modelReads += 1;
			if (modelReads === 1) {
				oldEntered.resolve();
				await releaseOld.promise;
			} else if (modelReads === 2) {
				newEntered.resolve();
				await releaseNew.promise;
				throw failure;
			}
		}
		return source;
	});
	syncBuiltinESMExports();
	t.after(() => {
		releaseOld.resolve();
		releaseNew.resolve();
		readFileMock.mock.restore();
		syncBuiltinESMExports();
	});

	const oldRead = readCachedState();
	await oldEntered.promise;
	invalidateStateCache();
	const newRead = readCachedState();
	const rejected = assert.rejects(newRead, (error) => error === failure);
	await newEntered.promise;
	releaseOld.resolve();
	const oldState = await oldRead;
	const joinedRead = readCachedState();
	const joinedResult = joinedRead.then(() => "fulfilled", (error) => error);
	releaseNew.resolve();
	await rejected;
	assert.equal(await joinedResult, failure, "旧读取结束后，新调用仍应加入尚未完成的新一轮读取");
	assert.notEqual(await readCachedState(), oldState, "新一轮失败后，不得命中失效前的旧读取结果");
});

test("共享读取失败后，后续调用可以读取修正后的配置", async () => {
	await writeFile(MODELS_JSON_PATH, "{");
	const results = await Promise.allSettled(Array.from({ length: 8 }, () => readCachedState()));
	assert.ok(results.every((result) => result.status === "rejected"));
	await writeFile(MODELS_JSON_PATH, JSON.stringify({ providers: {} }));
	assert.deepEqual((await readCachedState()).providers, {});
});
