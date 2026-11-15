// state-cache.ts
//
// 请求路径上的轻量 StateDocument 缓存。外部改动由文件签名检测，插件自身 mutation 还会主动失效。

import { readFileSignature, sameFileSignature, type FileSignature } from "./file-snapshot.ts";
import { getModelsJsonPath } from "./models-json-manager.ts";
import { readState, getStatePath } from "./state-store.ts";
import type { StateDocument } from "./types.ts";


interface StateSignature {
	modelsJson: FileSignature;
	metadataState: FileSignature;
}

let cachedState: { signature: StateSignature; state: StateDocument } | undefined;
let pendingRead: Promise<StateDocument> | undefined;
let cacheGeneration = 0;


async function readStateSignature(): Promise<StateSignature> {
	const [modelsJson, metadataState] = await Promise.all([
		readFileSignature(getModelsJsonPath()),
		readFileSignature(getStatePath()),
	]);
	return { modelsJson, metadataState };
}


function sameStateSignature(a: StateSignature, b: StateSignature): boolean {
	return sameFileSignature(a.modelsJson, b.modelsJson)
		&& sameFileSignature(a.metadataState, b.metadataState);
}

export function invalidateStateCache(): void {
	cachedState = undefined;
	pendingRead = undefined;
	cacheGeneration += 1;
}

export function readCachedState(): Promise<StateDocument> {
	if (!pendingRead) {
		const generation = cacheGeneration;
		pendingRead = loadCachedState(generation).finally(() => {
			if (generation === cacheGeneration) pendingRead = undefined;
		});
	}
	return pendingRead;
}

async function loadCachedState(generation: number): Promise<StateDocument> {
	const signature = await readStateSignature();
	if (cachedState && sameStateSignature(cachedState.signature, signature)) {
		return cachedState.state;
	}

	// StateDocument 横跨两个文件；只缓存同一稳定读取窗口内得到的组合。
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const before = await readStateSignature();
		const state = await readState();
		const after = await readStateSignature();
		if (sameStateSignature(before, after)) {
			// [喵喵喵]: 失效前的读取可完成原调用，但不能重新填充当前缓存。
			if (generation === cacheGeneration) cachedState = { signature: after, state };
			return state;
		}
	}

	// 文件持续变化时返回最后一次读取结果但不缓存，下一请求会重新尝试。
	return readState();
}
