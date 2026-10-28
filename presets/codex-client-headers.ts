// Codex 稳定身份画像；插件与私有捕获同步工具共用，避免刷新后把生成版本误当成显式配置。

export function codexIdentityFromUserAgent(userAgent: string | null | undefined): Record<string, string> {
	const match = userAgent?.match(/^(codex[-_a-z0-9]*)\/(\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?)(?:\s|$)/i);
	return match ? { originator: match[1]!, version: match[2]! } : {};
}

/** 用同一份 UA 补全身份画像；显式字段仍可覆盖生成值。 */
export function buildCodexClientHeaders(
	headers: Record<string, string>,
	overrides: Record<string, string> = {},
): Record<string, string> {
	const base = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
	const explicit = Object.fromEntries(Object.entries(overrides).map(([name, value]) => [name.toLowerCase(), value]));
	// [喵喵喵]: 旧抓包只有三头；版本取自该份 UA，不能拼入另一个内置版本。
	return { ...base, ...codexIdentityFromUserAgent(explicit["user-agent"] ?? base["user-agent"]), ...explicit };
}

/** 记录自动生成的字段和值；显式覆盖即使恰好等于模板，也不能被归入生成值。 */
export function getGeneratedCodexClientHeaders(
	headers: Record<string, string>,
	overrides: Record<string, string> = {},
): Record<string, string> {
	const explicitNames = new Set(Object.keys(overrides).map((name) => name.toLowerCase()));
	return Object.fromEntries(Object.entries(buildCodexClientHeaders(headers, overrides))
		.filter(([name]) => !explicitNames.has(name)));
}
