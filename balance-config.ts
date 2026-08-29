import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { parse, parseDocument, stringify } from "yaml";
import { atomicWriteText } from "./atomic-write.ts";
import { isObjectRecord } from "./common.ts";
import { withConfigurationLock } from "./configuration-lock.ts";
import { readStableTextFileSnapshot } from "./file-snapshot.ts";

export const BALANCE_CONFIG_PATH = join(getAgentDir(), "balance-config.yaml");

export type BalanceProfileId =
	| "newapi"
	| "sub2api"
	| "deepseek-official"
	| "openrouter"
	| "custom";

export interface BalanceProviderDraft {
	providerId: string;
	enabled: boolean;
	profile: BalanceProfileId;
	baseUrl: string;
	accessToken: string;
	userId: string;
	divideBy: string;
	multiplyBy: string;
	unit: string;
	selectedIndex: number;
}

type JsonObject = Record<string, unknown>;

interface BalanceConfigSnapshot {
	source: string | undefined;
	contentHash: string;
	value: JsonObject;
}

const DEFAULT_BALANCE_CONFIG = {
	refreshIntervalMinutes: 5,
	profiles: {
		newapi: {
			request: {
				url: "{{baseUrl}}/api/user/self",
				method: "GET",
				headers: {
					Accept: "application/json",
					Authorization: "Bearer {{accessToken}}",
					"New-Api-User": "{{userId}}",
				},
				timeoutSeconds: 10,
			},
			extractor: {
				remainingPath: "data.quota",
				usedPath: "data.used_quota",
				totalPath: null,
				validity: { allTruthy: ["success", "data"] },
				errorPath: "message",
				errorFallback: "Balance query failed",
			},
		},
		sub2api: {
			request: {
				url: "{{baseUrl}}/v1/usage",
				method: "GET",
				headers: { Accept: "application/json", Authorization: "Bearer {{apiKey}}" },
				timeoutSeconds: 10,
			},
			extractor: {
				remainingPath: "remaining",
				usedPath: "usage.total.actual_cost",
				totalPath: null,
				validity: { firstDefined: ["is_active", "isValid"], fallback: true },
				errorFallback: "Balance query failed",
			},
		},
		"deepseek-official": {
			request: {
				baseUrl: "https://api.deepseek.com",
				url: "{{baseUrl}}/user/balance",
				method: "GET",
				headers: { Accept: "application/json", Authorization: "Bearer {{apiKey}}" },
				timeoutSeconds: 10,
			},
			extractor: {
				remainingPath: "balance_infos.0.total_balance",
				usedPath: null,
				totalPath: "balance_infos.0.total_balance",
				unitPath: "balance_infos.0.currency",
				validity: { path: "is_available", fallback: true },
				errorFallback: "Insufficient balance",
			},
		},
		openrouter: {
			request: {
				baseUrl: "https://openrouter.ai",
				url: "{{baseUrl}}/api/v1/credits",
				method: "GET",
				headers: { Accept: "application/json", Authorization: "Bearer {{apiKey}}" },
				timeoutSeconds: 10,
			},
			extractor: {
				remainingPath: null,
				usedPath: "data.total_usage",
				totalPath: "data.total_credits",
				validity: { path: "data", fallback: false },
				errorFallback: "Balance query failed",
				unit: "$",
			},
		},
	},
	providers: {},
} satisfies JsonObject;

function objectValue(value: unknown): JsonObject | undefined {
	return isObjectRecord(value) ? value : undefined;
}

function numberText(value: unknown): string {
	return typeof value === "number" && Number.isFinite(value)
		? String(value)
		: "";
}

function parseBalanceConfig(source: string): JsonObject {
	const value = parse(source, { merge: true });
	if (!isObjectRecord(value))
		throw new Error(`${BALANCE_CONFIG_PATH} root must be an object`);
	return value;
}

async function readBalanceConfigSnapshot(): Promise<BalanceConfigSnapshot> {
	const snapshot = await readStableTextFileSnapshot(BALANCE_CONFIG_PATH);
	return {
		source: snapshot.source,
		contentHash: snapshot.contentHash,
		value:
			snapshot.source === undefined
				? structuredClone(DEFAULT_BALANCE_CONFIG)
				: parseBalanceConfig(snapshot.source),
	};
}

function profileIdForProvider(
	value: JsonObject,
	provider: JsonObject,
): BalanceProfileId {
	if (typeof provider.profile === "string") {
		return ["newapi", "sub2api", "deepseek-official", "openrouter"].includes(
			provider.profile,
		)
			? (provider.profile as BalanceProfileId)
			: "custom";
	}
	const profiles = objectValue(value.profiles) ?? {};
	for (const profileId of [
		"newapi",
		"sub2api",
		"deepseek-official",
		"openrouter",
	] as const) {
		if (provider.profile === profiles[profileId]) return profileId;
	}
	return "custom";
}

export async function readBalanceRefreshInterval(): Promise<number> {
	const snapshot = await readBalanceConfigSnapshot();
	const value = Number(snapshot.value.refreshIntervalMinutes);
	return Number.isFinite(value) && value >= 1 ? value : 5;
}

export async function readConfiguredBalanceProviderIds(): Promise<Set<string>> {
	const snapshot = await readBalanceConfigSnapshot();
	return new Set(Object.keys(objectValue(snapshot.value.providers) ?? {}));
}

export async function createBalanceProviderDraft(
	providerId: string,
): Promise<BalanceProviderDraft> {
	const snapshot = await readBalanceConfigSnapshot();
	const provider = objectValue(
		objectValue(snapshot.value.providers)?.[providerId],
	);
	const request = objectValue(provider?.request) ?? {};
	const credentials = objectValue(provider?.credentials) ?? {};
	const extractor = objectValue(provider?.extractor) ?? {};
	return {
		providerId,
		enabled: Boolean(provider),
		profile: provider
			? profileIdForProvider(snapshot.value, provider)
			: "sub2api",
		baseUrl: typeof request.baseUrl === "string" ? request.baseUrl : "",
		accessToken:
			typeof credentials.accessToken === "string" ? credentials.accessToken : "",
		userId: typeof credentials.userId === "string" ? credentials.userId : "",
		divideBy: numberText(extractor.divideBy),
		multiplyBy: numberText(extractor.multiplyBy),
		unit: typeof extractor.unit === "string" ? extractor.unit : "",
		selectedIndex: 0,
	};
}

function parseOptionalPositiveNumber(
	value: string,
	label: string,
): number | undefined {
	if (!value.trim()) return undefined;
	const result = Number(value);
	if (!Number.isFinite(result) || result <= 0)
		throw new Error(`${label} must be a positive number`);
	return result;
}

export function validateBalanceProviderDraft(
	draft: BalanceProviderDraft,
): string[] {
	if (!draft.enabled) return [];
	const errors: string[] = [];
	if (
		draft.profile === "newapi" &&
		(!draft.accessToken.trim() || !draft.userId.trim())
	) {
		errors.push("NewAPI requires access token and user ID");
	}
	for (const [label, value] of [
		["divideBy", draft.divideBy],
		["multiplyBy", draft.multiplyBy],
	] as const) {
		try {
			parseOptionalPositiveNumber(value, label);
		} catch (error) {
			errors.push(error instanceof Error ? error.message : String(error));
		}
	}
	if (draft.baseUrl.trim()) {
		try {
			const url = new URL(draft.baseUrl.trim());
			if (url.protocol !== "http:" && url.protocol !== "https:")
				errors.push("Balance Base URL must use http or https");
		} catch {
			errors.push("Balance Base URL is invalid");
		}
	}
	return errors;
}

function providerEntryFromDraft(
	draft: BalanceProviderDraft,
	existing: JsonObject | undefined,
): JsonObject {
	const entry: JsonObject = { ...existing };
	if (draft.profile === "custom") {
		if (existing?.profile !== undefined) entry.profile = existing.profile;
	} else {
		entry.profile = draft.profile;
	}
	if (draft.baseUrl.trim()) entry.request = { ...(objectValue(existing?.request) ?? {}), baseUrl: draft.baseUrl.trim() };
	if (draft.profile === "newapi") {
		entry.credentials = {
			...(objectValue(existing?.credentials) ?? {}),
			accessToken: draft.accessToken.trim(),
			userId: draft.userId.trim(),
		};
	}
	const extractor: JsonObject = {};
	const divideBy = parseOptionalPositiveNumber(draft.divideBy, "divideBy");
	const multiplyBy = parseOptionalPositiveNumber(draft.multiplyBy, "multiplyBy");
	if (divideBy !== undefined) extractor.divideBy = divideBy;
	if (multiplyBy !== undefined) extractor.multiplyBy = multiplyBy;
	if (draft.unit.trim()) extractor.unit = draft.unit.trim();
	if (Object.keys(extractor).length > 0) entry.extractor = extractor;
	return entry;
}

async function writeBalanceMutation(
	mutator: (
		document: ReturnType<typeof parseDocument>,
		current: JsonObject,
	) => void,
): Promise<void> {
	await withConfigurationLock(async () => {
		const snapshot = await readBalanceConfigSnapshot();
		const latest = await readStableTextFileSnapshot(BALANCE_CONFIG_PATH);
		if (latest.contentHash !== snapshot.contentHash)
			throw new Error(
				`${BALANCE_CONFIG_PATH} changed while editing; reopen /model-manager and retry`,
			);
		const source = snapshot.source ?? stringify(DEFAULT_BALANCE_CONFIG);
		const document = parseDocument(source);
		if (document.errors.length > 0) throw document.errors[0];
		mutator(document, snapshot.value);
		await atomicWriteText(BALANCE_CONFIG_PATH, document.toString());
	});
}

export async function saveBalanceRefreshInterval(
	minutes: number,
): Promise<void> {
	if (!Number.isFinite(minutes) || minutes < 1)
		throw new Error("Refresh interval must be at least 1 minute");
	await writeBalanceMutation((document) =>
		document.setIn(["refreshIntervalMinutes"], minutes),
	);
}

export async function saveBalanceProviderDraft(
	draft: BalanceProviderDraft,
): Promise<void> {
	const errors = validateBalanceProviderDraft(draft);
	if (errors.length > 0) throw new Error(errors.join("; "));
	await writeBalanceMutation((document, current) => {
		if (!draft.enabled) {
			document.deleteIn(["providers", draft.providerId]);
			return;
		}
		const existing = objectValue(
			objectValue(current.providers)?.[draft.providerId],
		);
		document.setIn(
			["providers", draft.providerId],
			providerEntryFromDraft(draft, existing),
		);
	});
}

export async function renameBalanceProvider(
	oldProviderId: string,
	newProviderId: string,
): Promise<void> {
	if (oldProviderId === newProviderId) return;
	await writeBalanceMutation((document, current) => {
		const existing = objectValue(objectValue(current.providers)?.[oldProviderId]);
		if (!existing) return;
		document.setIn(["providers", newProviderId], existing);
		document.deleteIn(["providers", oldProviderId]);
	});
}

export async function deleteBalanceProvider(providerId: string): Promise<void> {
	await writeBalanceMutation((document) =>
		document.deleteIn(["providers", providerId]),
	);
}
