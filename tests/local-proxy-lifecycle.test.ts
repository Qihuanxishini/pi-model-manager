import assert from "node:assert/strict";
import test from "node:test";
import { closeLocalProxyServer, openTemporaryLocalProxyRoute } from "../local-proxy-service.ts";

test("本地代理可幂等关闭并在关闭完成后重新启动", async () => {
	const first = await openTemporaryLocalProxyRoute(
		"test-provider",
		"https://upstream.example/v1/models?tenant=a",
		"http://127.0.0.1:7890",
	);
	assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\//);
	await Promise.all([closeLocalProxyServer(), closeLocalProxyServer()]);

	const second = await openTemporaryLocalProxyRoute(
		"test-provider",
		"https://upstream.example/v1/models?tenant=a",
		"http://127.0.0.1:7890",
	);
	assert.match(second.url, /^http:\/\/127\.0\.0\.1:\d+\//);
	second.close();
	await closeLocalProxyServer();
});

test("无效代理 URL 的错误不暴露 userinfo", async () => {
	await assert.rejects(
		openTemporaryLocalProxyRoute("test-provider", "https://upstream.example", "http://alice:password@"),
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			assert.doesNotMatch(message, /alice|password/);
			return true;
		},
	);
});

test("openTemporaryLocalProxyRoute 对根路径修整尾斜杠防止双斜杠与解析错误", async () => {
	const route = await openTemporaryLocalProxyRoute(
		"google-provider",
		"https://gemini.example.com/",
		"http://127.0.0.1:7890",
	);
	// 验证生成的 URL 不以双斜杠结尾
	assert.doesNotMatch(route.url, /\/\/$/);
	assert.match(route.url, /google-provider%2Fmodel-list%2F[0-9a-f-]{36}$/i);
	route.close();
	await closeLocalProxyServer();
});
