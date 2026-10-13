import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

// [喵喵喵]: 入口可达性门禁——此前 dashboard.ts 的语法错误逃过全部用例（无测试 import 它），
// 导致插件加载即崩；本文件保证 TUI 入口与插件入口的整条依赖图可被解析加载。
const agentDir = join(tmpdir(), `pi-model-manager-integrity-${process.pid}`);
process.env.PI_CODING_AGENT_DIR = agentDir;

test("TUI 入口模块可被解析加载（防语法回归）", async () => {
	await import("../tui/dashboard.ts");
});

test("插件入口与其完整依赖图可被解析加载（防语法回归）", async () => {
	await import("../index.ts");
});
