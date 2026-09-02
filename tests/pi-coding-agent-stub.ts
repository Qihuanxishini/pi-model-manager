import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), `pi-model-manager-stub-${process.pid}`);
}

export class ModelRuntime {
	static async create(): Promise<{ getModels(): never[] }> {
		return { getModels: () => [] };
	}
}

export class ModelRegistry {
	constructor(_runtime: unknown) {}
}

export class SettingsManager {
	static create(): never {
		throw new Error("当前测试不应访问 SettingsManager");
	}
}
