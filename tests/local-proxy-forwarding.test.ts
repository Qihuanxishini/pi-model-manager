import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { closeLocalProxyServer, openTemporaryLocalProxyRoute } from "../local-proxy-service.ts";
import { getUiLanguage, setUiLanguage } from "../i18n.ts";

interface RecordingProxy {
	port: number;
	requests: { method: string; url: string }[];
	close: () => Promise<void>;
}

// 起一个会记录请求目标的迷你 HTTP 代理：http 上游经 HttpProxyAgent 会以绝对 URI 形式到达这里
async function startRecordingProxy(handler: (response: http.ServerResponse) => void): Promise<RecordingProxy> {
	const requests: RecordingProxy["requests"] = [];
	const proxyServer = http.createServer((request, response) => {
		requests.push({ method: request.method ?? "", url: request.url ?? "" });
		handler(response);
	});
	await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", resolve));
	const { port } = proxyServer.address() as AddressInfo;
	return {
		port,
		requests,
		close: () => new Promise<void>((resolve, reject) => {
			proxyServer.closeAllConnections();
			proxyServer.close((error) => (error ? reject(error) : resolve()));
		}),
	};
}

// 用非 keep-alive 的原生 http 客户端请求本地代理，避免连接池拖慢 server.close()
function requestText(url: string): Promise<{ status: number; location: string | null; body: string }> {
	return new Promise((resolve, reject) => {
		const request = http.get(url, { agent: new http.Agent({ keepAlive: false }) }, (response) => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.on("end", () => resolve({
				status: response.statusCode ?? 0,
				location: response.headers.location ?? null,
				body: Buffer.concat(chunks).toString("utf8"),
			}));
		});
		request.once("error", reject);
	});
}

test("本地代理将 //host 形态的路径归一化为上游路径，绝不协议相对跳转到任意 Origin", async () => {
	const proxy = await startRecordingProxy((response) => {
		response.writeHead(200, { "content-type": "text/plain" });
		response.end("ok");
	});
	try {
		const route = await openTemporaryLocalProxyRoute(
			"ssrf-provider",
			"http://upstream.invalid/v1",
			`http://127.0.0.1:${proxy.port}`,
		);
		const result = await requestText(`${route.url}//evil.example.com/x`);
		assert.equal(result.status, 200);
		assert.equal(result.body, "ok");
		assert.equal(proxy.requests.length, 1);
		// 请求必须发往受管上游 Origin；evil.example.com 只允许作为路径段出现
		assert.match(proxy.requests[0]!.url, /^http:\/\/upstream\.invalid\//);
		route.close();
	} finally {
		await proxy.close();
	}
	await closeLocalProxyServer();
});

test("本地代理拦截跨域 3xx 重定向并返回 502", async () => {
	const proxy = await startRecordingProxy((response) => {
		response.writeHead(302, { location: "https://evil-redirect.example.com/next" });
		response.end();
	});
	try {
		const route = await openTemporaryLocalProxyRoute(
			"redirect-provider",
			"http://upstream.invalid/v1",
			`http://127.0.0.1:${proxy.port}`,
		);
		const blocked = await requestText(`${route.url}/models`);
		assert.equal(blocked.status, 502);
		assert.equal(blocked.location, null, "拦截响应不得透传跨域 Location");
		route.close();
	} finally {
		await proxy.close();
	}
	await closeLocalProxyServer();
});

test("默认跟随重定向的客户端也不能经同源绝对 Location 绕过代理，英文错误正常返回", async () => {
	let directRequests = 0;
	const upstream = http.createServer((_request, response) => {
		directRequests += 1;
		response.end("unexpected direct request");
	});
	await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
	const upstreamOrigin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
	const proxy = await startRecordingProxy((response) => {
		response.writeHead(302, { location: `${upstreamOrigin}/v1/next` });
		response.end();
	});
	const previousLanguage = getUiLanguage();
	try {
		setUiLanguage("en");
		const route = await openTemporaryLocalProxyRoute("absolute-redirect-provider", `${upstreamOrigin}/v1`, `http://127.0.0.1:${proxy.port}`);
		try {
			const blocked = await fetch(`${route.url}/models`);
			assert.equal(blocked.status, 502);
			assert.equal(blocked.headers.get("location"), null);
			assert.match(await blocked.text(), /Proxy security block/);
			assert.equal(directRequests, 0);
			assert.equal(proxy.requests.length, 1);
		} finally { route.close(); }
	} finally {
		setUiLanguage(previousLanguage);
		await proxy.close();
		await closeLocalProxyServer();
		upstream.closeAllConnections();
		await new Promise<void>((resolve) => upstream.close(() => resolve()));
	}
});

test("模型发现经本地代理时禁止跟随 3xx 重定向（redirect: manual）", async () => {
	const { fetchModelIds } = await import("../tui/model-list-fetch.ts");
	const proxy = await startRecordingProxy((response) => {
		response.writeHead(302, { location: "/v1/next" });
		response.end();
	});
	try {
		const outcome = await fetchModelIds({
			providerId: "manual-redirect-provider",
			api: "openai-completions",
			baseUrl: "http://upstream.invalid/v1",
			apiKey: "fake-key",
			authHeader: true,
			clientHeaderProfile: "disabled",
			customClientHeaders: {},
			httpProxyEnabled: true,
			httpProxyUrl: `http://127.0.0.1:${proxy.port}`,
		});
		assert.equal(outcome.status, "failed");
		if (outcome.status === "failed") assert.match(outcome.message ?? "", /502/);
		// 同域重定向在代理层拒绝，发现客户端不能反复回打代理。
		assert.ok(proxy.requests.length <= 2, `客户端不应跟随重定向（实际请求数：${proxy.requests.length}）`);
	} finally {
		await proxy.close();
	}
	await closeLocalProxyServer();
});
