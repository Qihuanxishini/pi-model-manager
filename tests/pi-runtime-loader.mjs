// 仅供真实宿主协议测试：适配 Pi 的打包发行形态，不参与生产模块解析。
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

let agentUrl;
let aiUrl;
let tuiUrl;
export async function initialize({ root }) {
	agentUrl = pathToFileURL(join(root, "dist/bundle/index.js")).href;
	tuiUrl = pathToFileURL(createRequire(join(root, "package.json")).resolve("@earendil-works/pi-tui")).href;
	const directory = join(root, "dist/bundle/chunks");
	for (const name of await readdir(directory)) {
		if (!name.endsWith(".js")) continue;
		const path = join(directory, name);
		if ((await readFile(path, "utf8")).includes("function lazyStream(")) {
			aiUrl = pathToFileURL(path).href;
			break;
		}
	}
	if (!aiUrl) throw new Error("Cannot locate the installed Pi lazyStream export");
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "@earendil-works/pi-coding-agent") return { url: agentUrl, shortCircuit: true };
	if (specifier === "@earendil-works/pi-ai") return { url: aiUrl, shortCircuit: true };
	if (specifier === "@earendil-works/pi-tui") return { url: tuiUrl, shortCircuit: true };
	return nextResolve(specifier, context);
}
