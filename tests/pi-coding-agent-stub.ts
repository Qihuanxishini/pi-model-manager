import { tmpdir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi";
export const BALANCE_PROFILE_IDS = ["newapi", "sub2api", "deepseek-official", "openrouter"] as const;
export type BalanceProfileId = (typeof BALANCE_PROFILE_IDS)[number];

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(tmpdir(), `pi-model-manager-stub-${process.pid}`);
}

export function createDefaultBalanceConfig(): Record<string, unknown> {
	return {
		refreshIntervalMinutes: 5,
		profiles: Object.fromEntries(BALANCE_PROFILE_IDS.map((profileId) => [profileId, {}])),
		providers: {},
	};
}

export function getBalanceConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "balance-config.yaml");
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
