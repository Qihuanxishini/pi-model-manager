// local-proxy-service.ts
//
// 插件内置的按接入点代理转发层。
// 不修改 pi 本体：开启代理的接入点在运行时注册为 127.0.0.1 本地地址，
// 本服务再通过用户配置的 HTTP/HTTPS 代理转发到真实上游。

import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { t } from "./i18n.ts";
import { redactSensitiveText, redactUrlForDisplay } from "./sensitive-redaction.ts";
import type { StoredProvider } from "./types.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL } from "./types.ts";

export interface ProviderProxyRoute {
	upstreamOrigin: string;
	proxyUrl: string;
}

export interface TemporaryLocalProxyRoute {
	url: string;
	close(): void;
}

const ROUTES = new Map<string, ProviderProxyRoute>();
let server: http.Server | undefined;
let listenPromise: Promise<number> | undefined;
let listenPort: number | undefined;
let closingPromise: Promise<void> | undefined;

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/, "");
}

function normalizeHttpProxyUrl(proxyUrl: string | undefined): string {
	return proxyUrl?.trim() || DEFAULT_PROVIDER_HTTP_PROXY_URL;
}

function parseHttpProxyUrl(proxyUrl: string | undefined): URL {
	const normalized = normalizeHttpProxyUrl(proxyUrl);
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(t("代理地址无效：{url}", { url: redactUrlForDisplay(normalized) }));
	}
	ensureSupportedProxyProtocol(parsed);
	return parsed;
}

export function isProviderHttpProxyEnabled(provider: StoredProvider): boolean {
	return provider.httpProxyEnabled === true;
}

export function getProviderHttpProxyUrl(provider: StoredProvider): string {
	return normalizeHttpProxyUrl(provider.httpProxyUrl);
}

function stripHopByHopHeaders(headers: IncomingHttpHeaders): Record<string, string | string[]> {
	const next: Record<string, string | string[]> = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
		next[name] = value;
	}
	return next;
}

function getUrlPort(url: URL): number {
	if (url.port) return Number.parseInt(url.port, 10);
	return url.protocol === "https:" ? 443 : 80;
}

function getHostHeader(url: URL): string {
	return url.host;
}

function ensureSupportedProxyProtocol(proxy: URL): void {
	if (proxy.protocol !== "http:" && proxy.protocol !== "https:") {
		throw new Error(t("代理地址目前只支持 http:// 或 https:// 代理"));
	}
}

function pipeResponse(upstreamResponse: IncomingMessage, response: ServerResponse, route: ProviderProxyRoute): void {
	const statusCode = upstreamResponse.statusCode ?? 502;
	// [喵喵喵]: 上游返回 3xx 重定向时，若重定向目标跨域，直接在代理层拦截，防止客户端在跟随重定向时泄露真实 IP
	if (statusCode >= 300 && statusCode < 400 && upstreamResponse.headers.location) {
		try {
			const target = new URL(upstreamResponse.headers.location, route.upstreamOrigin);
			if (target.origin !== route.upstreamOrigin) {
				response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
				response.end(t("代理安全拦截：上游返回了跨域重定向至 {target}，已拒绝跟随", { target: target.origin }));
				// [喵喵喵]: 拦截后主动销毁上游响应，避免未消费的 body 占用 socket 直到超时
				upstreamResponse.destroy();
				return;
			}
		} catch {
			// 非法 location 则继续透传交由客户端处理
		}
	}
	const headers = stripHopByHopHeaders(upstreamResponse.headers);
	response.writeHead(statusCode, upstreamResponse.statusMessage, headers);
	// 尽快把 SSE 响应头交给本地客户端，后续 body 由 Node 的 HTTP 栈处理 chunked/backpressure。
	response.flushHeaders();
	upstreamResponse.on("error", (error) => {
		if (!response.destroyed) response.destroy(error);
	});
	upstreamResponse.pipe(response);
}


function formatProxyError(error: unknown): string {
	let message: string;
	if (error instanceof Error) {
		message = error.message.trim();
		if (!message) {
			const code = (error as Error & { code?: string }).code;
			message = code
				? t("代理请求失败：{code}", { code })
				: error.stack?.trim().split("\n", 1)[0] ?? `${error.name || "Error"} (${t("无错误消息")})`;
		}
	} else {
		message = String(error).trim() || t("未知代理错误");
	}
	return redactSensitiveText(message);
}

function writeProxyError(response: ServerResponse, error: unknown): void {
	if (response.headersSent) {
		response.destroy(error instanceof Error ? error : undefined);
		return;
	}
	response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
	response.end(`[pi-model-manager proxy] ${formatProxyError(error)}`);
}

function buildForwardRequestHeaders(target: URL, request: IncomingMessage): Record<string, string | string[]> {
	const headers = stripHopByHopHeaders(request.headers);
	headers.host = getHostHeader(target);
	return headers;
}

function bindClientAbort(request: IncomingMessage, response: ServerResponse, upstreamRequest: http.ClientRequest): void {
	const destroyUpstream = () => {
		if (!upstreamRequest.destroyed) upstreamRequest.destroy();
	};
	const destroyUpstreamWithError = (error: Error) => {
		if (!upstreamRequest.destroyed) upstreamRequest.destroy(error);
	};
	const onResponseClose = () => {
		if (!response.writableEnded) destroyUpstream();
	};
	const cleanup = () => {
		request.off("aborted", destroyUpstream);
		request.off("error", destroyUpstreamWithError);
		response.off("close", onResponseClose);
	};
	request.once("aborted", destroyUpstream);
	request.once("error", destroyUpstreamWithError);
	response.once("close", onResponseClose);
	upstreamRequest.once("close", cleanup);
}

function writeUpstreamRequestError(response: ServerResponse, error: Error): void {
	if (response.destroyed || response.writableEnded) return;
	writeProxyError(response, error);
}

function forwardPlainHttp(target: URL, proxy: URL, request: IncomingMessage, response: ServerResponse, route: ProviderProxyRoute): void {
	ensureSupportedProxyProtocol(proxy);
	const headers = buildForwardRequestHeaders(target, request);
	const agent = new HttpProxyAgent(proxy);
	const upstreamRequest = http.request({
		hostname: target.hostname,
		port: getUrlPort(target),
		method: request.method,
		path: `${target.pathname}${target.search}`,
		headers,
		agent,
	}, (upstreamResponse) => pipeResponse(upstreamResponse, response, route));
	upstreamRequest.once("close", () => agent.destroy());
	bindClientAbort(request, response, upstreamRequest);
	upstreamRequest.on("error", (error) => writeUpstreamRequestError(response, error));
	// [喵喵喵]: 请求体直接流向上游，避免图像等大 payload 在本地代理中形成完整内存副本 (2026-07-17)
	// [喵喵喵]: 等代理完成请求头重建后再流式读取 body，避免 chunked 请求在异步建连期间重复写入 HTTP 头。
	upstreamRequest.once("socket", () => request.pipe(upstreamRequest));
}

function forwardHttps(target: URL, proxy: URL, request: IncomingMessage, response: ServerResponse, route: ProviderProxyRoute): void {
	ensureSupportedProxyProtocol(proxy);
	const headers = buildForwardRequestHeaders(target, request);
	const agent = new HttpsProxyAgent(proxy);
	const upstreamRequest = https.request({
		hostname: target.hostname,
		port: getUrlPort(target),
		method: request.method,
		path: `${target.pathname}${target.search}`,
		headers,
		agent,
	}, (upstreamResponse) => pipeResponse(upstreamResponse, response, route));
	upstreamRequest.once("close", () => agent.destroy());
	bindClientAbort(request, response, upstreamRequest);
	upstreamRequest.on("error", (error) => writeUpstreamRequestError(response, error));
	upstreamRequest.once("socket", () => request.pipe(upstreamRequest));
}

function forwardRequest(route: ProviderProxyRoute, request: IncomingMessage, response: ServerResponse, routePath: string): void {
	const target = new URL(routePath, route.upstreamOrigin);
	// [喵喵喵]: 强制校验解析后的 target.origin 严格等于受管的 upstreamOrigin，阻断 SSRF 任意上游转发
	if (target.origin !== route.upstreamOrigin) {
		throw new Error(t("拒绝转发：目标 Origin {actual} 与注册路由 {expected} 不一致", {
			actual: target.origin,
			expected: route.upstreamOrigin,
		}));
	}
	const proxy = new URL(route.proxyUrl);
	if (target.protocol === "http:") {
		forwardPlainHttp(target, proxy, request, response, route);
		return;
	}
	if (target.protocol === "https:") {
		forwardHttps(target, proxy, request, response, route);
		return;
	}
	throw new Error(t("不支持的上游协议：{protocol}", { protocol: target.protocol }));
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
	void (async () => {
		try {
			const localUrl = new URL(request.url ?? "/", "http://127.0.0.1");
			const [, encodedProviderId, ...rest] = localUrl.pathname.split("/");
			if (!encodedProviderId) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
				response.end("missing provider id");
				return;
			}
			let providerId: string;
			try {
				providerId = decodeURIComponent(encodedProviderId);
			} catch {
				response.writeHead(400, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
				response.end("malformed provider id");
				return;
			}
			const route = ROUTES.get(providerId);
			if (!route) {
				response.writeHead(404, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
				response.end(`unknown provider: ${providerId}`);
				return;
			}
			// [喵喵喵]: 清除多余连续斜杠，防止 //evil.com 协议相对路径逃逸
			const normalizedRemaining = rest.join("/").replace(/^\/+/, "");
			const path = `/${normalizedRemaining}${localUrl.search}`;
			await forwardRequest(route, request, response, path);
		} catch (error) {
			writeProxyError(response, error);
		}
	})();
}

function clearServerState(expected: http.Server): void {
	if (server !== expected) return;
	server = undefined;
	listenPromise = undefined;
	listenPort = undefined;
}

async function ensureServer(): Promise<number> {
	if (closingPromise) throw new Error(t("本地代理服务正在关闭，请稍后重试"));
	if (listenPort !== undefined) return listenPort;
	if (listenPromise) return listenPromise;

	const nextServer = http.createServer(handleRequest);
	const pendingListen = new Promise<number>((resolve, reject) => {
		const rejectListen = (error: Error) => reject(error);
		nextServer.once("error", rejectListen);
		nextServer.listen(0, "127.0.0.1", () => {
			const address = nextServer.address();
			if (!address || typeof address === "string") {
				nextServer.off("error", rejectListen);
				reject(new Error(t("本地代理转发服务监听地址异常")));
				return;
			}
			nextServer.off("error", rejectListen);
			nextServer.unref();
			resolve(address.port);
		});
	});
	server = nextServer;
	listenPromise = pendingListen;
	try {
		const port = await pendingListen;
		if (server === nextServer) listenPort = port;
		return port;
	} catch (error) {
		clearServerState(nextServer);
		if (nextServer.listening) nextServer.close();
		throw error;
	}
}

async function ensureServerForRoute(): Promise<number> {
	const port = await ensureServer();
	if (closingPromise) throw new Error(t("本地代理服务正在关闭，请稍后重试"));
	return port;
}

export async function getLocalProxyBaseUrl(routeId: string, upstreamRuntimeBaseUrl: string, proxyUrl: string): Promise<string> {
	const upstream = new URL(upstreamRuntimeBaseUrl);
	const proxy = parseHttpProxyUrl(proxyUrl);
	const port = await ensureServerForRoute();
	ROUTES.set(routeId, {
		upstreamOrigin: upstream.origin,
		proxyUrl: proxy.toString(),
	});
	const basePath = trimTrailingSlashes(upstream.pathname || "");
	return `http://127.0.0.1:${port}/${encodeURIComponent(routeId)}${basePath}${upstream.search}`;
}

export async function openTemporaryLocalProxyRoute(
	providerId: string,
	upstreamUrl: string,
	proxyUrl: string,
): Promise<TemporaryLocalProxyRoute> {
	const upstream = new URL(upstreamUrl);
	const proxy = parseHttpProxyUrl(proxyUrl);
	const port = await ensureServerForRoute();
	const routeId = `${providerId}/model-list/${randomUUID()}`;
	const route = { upstreamOrigin: upstream.origin, proxyUrl: proxy.toString() };
	ROUTES.set(routeId, route);
	const basePath = trimTrailingSlashes(upstream.pathname || "");
	return {
		url: `http://127.0.0.1:${port}/${encodeURIComponent(routeId)}${basePath}${upstream.search}`,
		close(): void {
			if (ROUTES.get(routeId) === route) ROUTES.delete(routeId);
		},
	};
}

function isProviderRouteId(routeId: string, providerId: string): boolean {
	return routeId === providerId || routeId.startsWith(`${providerId}/`);
}

export function snapshotProviderLocalProxyRoutes(providerId: string): Map<string, ProviderProxyRoute> {
	return new Map(
		[...ROUTES.entries()]
			.filter(([routeId]) => isProviderRouteId(routeId, providerId))
			.map(([routeId, route]): [string, ProviderProxyRoute] => [routeId, { ...route }]),
	);
}

export function restoreProviderLocalProxyRoutes(
	providerId: string,
	snapshot: ReadonlyMap<string, ProviderProxyRoute>,
): void {
	removeProviderLocalProxyRoutes(providerId);
	for (const [routeId, route] of snapshot) ROUTES.set(routeId, { ...route });
}

export function removeProviderLocalProxyRoutes(providerId: string): void {
	for (const routeId of ROUTES.keys()) {
		if (isProviderRouteId(routeId, providerId)) ROUTES.delete(routeId);
	}
}

async function closeServerLifecycle(): Promise<void> {
	ROUTES.clear();
	const pendingListen = listenPromise;
	if (pendingListen) {
		try {
			await pendingListen;
		} catch {
			// 启动失败路径已经清理对应 server 状态。
		}
	}
	const current = server;
	if (!current) return;
	try {
		if (current.listening) {
			await new Promise<void>((resolve, reject) => {
				current.close((error) => error ? reject(error) : resolve());
			});
		}
	} finally {
		clearServerState(current);
	}
}

export async function closeLocalProxyServer(): Promise<void> {
	if (closingPromise) return closingPromise;
	const operation = closeServerLifecycle();
	closingPromise = operation;
	try {
		await operation;
	} finally {
		if (closingPromise === operation) closingPromise = undefined;
	}
}
