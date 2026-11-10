// local-proxy-service.ts
//
// 插件内置的按接入点代理转发层。
// 不修改 pi 本体：开启代理的接入点在运行时注册为 127.0.0.1 本地地址，
// 本服务再通过用户配置的 HTTP/HTTPS 代理转发到真实上游。

import { randomUUID } from "node:crypto";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";
import { t } from "./i18n.ts";
import { redactSensitiveText, redactUrlForDisplay } from "./sensitive-redaction.ts";
import type { StoredProvider } from "./types.ts";
import { DEFAULT_PROVIDER_HTTP_PROXY_URL } from "./types.ts";

export interface ProviderProxyRoute {
	providerId: string;
	upstreamOrigin: string;
	proxyUrl: string;
}

export interface TemporaryLocalProxyRoute {
	url: string;
	close(): void;
}

interface ProxyAgentPool {
	key: string;
	agent: http.Agent;
	activeRequests: number;
	idleTimer?: ReturnType<typeof setTimeout>;
}

interface ProxyRequestOptions extends http.RequestOptions {
	proxyAbortSignal: AbortSignal;
}

const AGENT_POOL_IDLE_MS = 30_000;
const AGENT_POOLS = new Map<string, ProxyAgentPool>();
const UPSTREAM_REQUESTS = new Map<http.ClientRequest, AbortController>();
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

function ensureNativeProxySupport(): void {
	if (process.versions.bun) {
		throw new Error(t("接入代理不支持 Bun {version}；请使用 Node.js 22.21.0（22.x）或 24.5.0 及以上运行 Pi。", {
			version: process.versions.bun,
		}));
	}
	const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
	if ((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major > 24) return;
	// [喵喵喵]: 旧 Node 会忽略 proxyEnv；必须拒绝请求，不能让已开启的代理静默变成直连。
	throw new Error(t("接入代理要求 Node.js 22.21.0（22.x）或 24.5.0 及以上；当前版本为 {version}", {
		version: process.versions.node,
	}));
}

function createProxyAgent(protocol: string, proxyUrl: string): http.Agent {
	const proxyEnv = { HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, NO_PROXY: "" };
	const Agent = protocol === "https:" ? https.Agent : http.Agent;
	const agent = new Agent({ keepAlive: true, maxFreeSockets: 2, proxyEnv });
	const proxy = new URL(proxyUrl);
	const proxyHost = proxy.hostname.replace(/^\[|\]$/g, "");
	const proxyServername = proxy.protocol === "https:" && !isIP(proxyHost) ? proxyHost : undefined;
	const createConnection = agent.createConnection.bind(agent);
	// [喵喵喵]: CONNECT 完成前 socket 尚未入原生池；单独销毁 ClientRequest 无法取消这一段建连。
	agent.createConnection = (options, callback) => {
		const { proxyAbortSignal: signal, ...connectionOptions } = options as ProxyRequestOptions;
		let pending = true;
		let socket: ReturnType<typeof createConnection>;
		const abort = () => socket?.destroy(signal?.reason instanceof Error ? signal.reason : undefined);
		const cleanup = () => {
			pending = false;
			signal?.removeEventListener("abort", abort);
			socket?.off("close", cleanup);
		};
		socket = createConnection(connectionOptions, (error, connectedSocket) => {
			cleanup();
			callback?.(error, connectedSocket);
		});
		// [喵喵喵]: 原生代理 TLS 不自动发送 SNI；握手前设置代理域名，不能误用上游目标域名。
		if (proxyServername && socket instanceof TLSSocket) socket.setServername(proxyServername);
		if (pending && socket && signal) {
			signal.addEventListener("abort", abort, { once: true });
			socket.once("close", cleanup);
			if (signal.aborted) abort();
		}
		return socket;
	};
	return agent;
}

function acquireAgentPool(route: ProviderProxyRoute, protocol: string): ProxyAgentPool {
	const proxyUrl = parseHttpProxyUrl(route.proxyUrl).toString();
	const key = JSON.stringify([route.providerId, proxyUrl, protocol]);
	let pool = AGENT_POOLS.get(key);
	if (!pool) {
		pool = {
			key,
			agent: createProxyAgent(protocol, proxyUrl),
			activeRequests: 0,
		};
		AGENT_POOLS.set(key, pool);
	}
	if (pool.idleTimer) {
		clearTimeout(pool.idleTimer);
		pool.idleTimer = undefined;
	}
	pool.activeRequests += 1;
	return pool;
}

function releaseAgentPool(pool: ProxyAgentPool): void {
	pool.activeRequests -= 1;
	if (pool.activeRequests !== 0 || AGENT_POOLS.get(pool.key) !== pool) return;
	// [喵喵喵]: 只回收没有在途请求的整个池；临时路由可能在 SSE 响应头到达时就已删除。
	pool.idleTimer = setTimeout(() => {
		if (AGENT_POOLS.get(pool.key) !== pool || pool.activeRequests !== 0) return;
		AGENT_POOLS.delete(pool.key);
		pool.agent.destroy();
	}, AGENT_POOL_IDLE_MS);
	pool.idleTimer.unref();
}

function destroyProxyAgentPools(): void {
	for (const pool of AGENT_POOLS.values()) {
		if (pool.idleTimer) clearTimeout(pool.idleTimer);
		pool.agent.destroy();
	}
	AGENT_POOLS.clear();
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
	// [喵喵喵]: 同源绝对 Location 也可能让 SDK 离开本地代理直连上游；所有带 Location 的重定向均在代理层拒绝。
	if (statusCode >= 300 && statusCode < 400 && upstreamResponse.headers.location) {
		let target = "[invalid Location]";
		try {
			target = new URL(upstreamResponse.headers.location, route.upstreamOrigin).origin;
		} catch {
			// [喵喵喵]: 非法 Location 同样拒绝，不把未知跳转交给客户端。
		}
		const message = t("代理安全拦截：上游返回了重定向至 {target}，已拒绝跟随", { target });
		response.writeHead(502, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
		response.end(message);
		upstreamResponse.destroy();
		return;
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

function bindClientAbort(
	request: IncomingMessage,
	response: ServerResponse,
	upstreamRequest: http.ClientRequest,
	abortController: AbortController,
): void {
	const destroyUpstream = () => {
		abortController.abort();
		if (!upstreamRequest.destroyed) upstreamRequest.destroy();
	};
	const destroyUpstreamWithError = (error: Error) => {
		abortController.abort(error);
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

function forwardRequest(route: ProviderProxyRoute, request: IncomingMessage, response: ServerResponse, routePath: string): void {
	const target = new URL(routePath, route.upstreamOrigin);
	// [喵喵喵]: 强制校验解析后的 target.origin 严格等于受管的 upstreamOrigin，阻断 SSRF 任意上游转发
	if (target.origin !== route.upstreamOrigin) {
		throw new Error(t("拒绝转发：目标 Origin {actual} 与注册路由 {expected} 不一致", {
			actual: target.origin,
			expected: route.upstreamOrigin,
		}));
	}
	if (target.protocol !== "http:" && target.protocol !== "https:") {
		throw new Error(t("不支持的上游协议：{protocol}", { protocol: target.protocol }));
	}
	const headers = buildForwardRequestHeaders(target, request);
	const abortController = new AbortController();
	const pool = acquireAgentPool(route, target.protocol);
	const transport = target.protocol === "https:" ? https : http;
	const options: ProxyRequestOptions = {
		method: request.method,
		headers,
		agent: pool.agent,
		signal: abortController.signal,
		proxyAbortSignal: abortController.signal,
	};
	let upstreamRequest: http.ClientRequest;
	try {
		upstreamRequest = transport.request(target, options, (upstreamResponse) => pipeResponse(upstreamResponse, response, route));
	} catch (error) {
		releaseAgentPool(pool);
		throw error;
	}
	UPSTREAM_REQUESTS.set(upstreamRequest, abortController);
	upstreamRequest.once("close", () => {
		UPSTREAM_REQUESTS.delete(upstreamRequest);
		releaseAgentPool(pool);
	});
	bindClientAbort(request, response, upstreamRequest, abortController);
	upstreamRequest.on("error", (error) => writeUpstreamRequestError(response, error));
	// [喵喵喵]: 请求体直接流向上游，避免图像等大 payload 在本地代理中形成完整内存副本 (2026-07-17)
	upstreamRequest.once("socket", () => request.pipe(upstreamRequest));
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
	ensureNativeProxySupport();
	const port = await ensureServer();
	if (closingPromise) throw new Error(t("本地代理服务正在关闭，请稍后重试"));
	return port;
}

export async function getLocalProxyBaseUrl(routeId: string, upstreamRuntimeBaseUrl: string, proxyUrl: string): Promise<string> {
	const upstream = new URL(upstreamRuntimeBaseUrl);
	const proxy = parseHttpProxyUrl(proxyUrl);
	const port = await ensureServerForRoute();
	ROUTES.set(routeId, {
		providerId: routeId,
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
	const route = { providerId, upstreamOrigin: upstream.origin, proxyUrl: proxy.toString() };
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
	const pendingClose = current?.listening
		? new Promise<void>((resolve, reject) => {
			current.close((error) => error ? reject(error) : resolve());
		})
		: undefined;
	current?.closeAllConnections();
	for (const [upstreamRequest, abortController] of UPSTREAM_REQUESTS) {
		abortController.abort();
		upstreamRequest.destroy();
	}
	UPSTREAM_REQUESTS.clear();
	destroyProxyAgentPools();
	try {
		await pendingClose;
	} finally {
		if (current) clearServerState(current);
	}
}

export async function closeLocalProxyServer(): Promise<void> {
	if (closingPromise) return closingPromise;
	const operation = Promise.resolve().then(closeServerLifecycle);
	closingPromise = operation;
	try {
		await operation;
	} finally {
		if (closingPromise === operation) closingPromise = undefined;
	}
}
