import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach } from "node:test";

const agentDir = join(tmpdir(), `pi-model-manager-balance-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

const { BALANCE_CONFIG_PATH, createBalanceProviderDraft } = await import("../balance-config.ts");

beforeEach(async () => {
	await rm(agentDir, { recursive: true, force: true });
	await mkdir(agentDir, { recursive: true });
});

after(async () => {
	await rm(agentDir, { recursive: true, force: true });
});

test("uses Pi defaults when no balance configuration exists", async () => {
	const draft = await createBalanceProviderDraft("example");

	assert.equal(BALANCE_CONFIG_PATH, join(agentDir, "balance-config.yaml"));
	assert.equal(draft.profile, "sub2api");
	assert.equal(draft.enabled, false);
});

test("recognizes profile IDs supplied by Pi", async () => {
	await writeFile(
		BALANCE_CONFIG_PATH,
		"profiles: {}\nproviders:\n  example:\n    profile: openrouter\n",
		"utf8",
	);

	const draft = await createBalanceProviderDraft("example");

	assert.equal(draft.profile, "openrouter");
	assert.equal(draft.enabled, true);
});
