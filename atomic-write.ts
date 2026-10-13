// Windows 友好的配置文件持久化写入。
//
// 目标文件可能被正在运行的 pi、编辑器、杀软或索引器短暂占用。
// 直接 rename(tmp, target) 在 Windows 上可能因短暂占用失败；这里只进行有限重试，
// 不以非原子的 copy 覆盖冒充成功，最终失败时保留完整临时文件供恢复。

import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { t } from "./i18n.ts";

const REPLACE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800] as const;
const TRANSIENT_REPLACE_ERROR_CODES = new Set(["EACCES", "EPERM", "EBUSY", "ENOTEMPTY"]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function isTransientReplaceError(error: unknown): boolean {
	const code = getErrorCode(error);
	return code !== undefined && TRANSIENT_REPLACE_ERROR_CODES.has(code);
}

function formatError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function removeTempFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch {
		// 清理失败不应掩盖真实保存结果；失败场景会把 tmp 路径报告给用户用于恢复。
	}
}

async function renameWithRetry(sourcePath: string, targetPath: string): Promise<void> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= REPLACE_RETRY_DELAYS_MS.length; attempt += 1) {
		try {
			await rename(sourcePath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			if (!isTransientReplaceError(error) || attempt === REPLACE_RETRY_DELAYS_MS.length) break;
			await sleep(REPLACE_RETRY_DELAYS_MS[attempt]!);
		}
	}
	throw lastError;
}



// [喵喵喵]: 含明文 API Key 的配置文件应显式传入 0o600；默认不强制 mode，避免波及 Pi 核心等共享配置文件的权限
export const SECURE_FILE_MODE = 0o600;

export async function atomicWriteText(targetPath: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(targetPath), { recursive: true });
	const tempPath = `${targetPath}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
	let tempHasCompleteContent = false;

	try {
		await writeFile(tempPath, content, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
		tempHasCompleteContent = true;
		await renameWithRetry(tempPath, targetPath);
	} catch (error) {
		if (!tempHasCompleteContent) await removeTempFile(tempPath);
		throw new Error(tempHasCompleteContent
			? t("写入 {targetPath} 失败；完整内容已保留在临时文件：{tempPath}：{error}", { targetPath, tempPath, error: formatError(error) })
			: t("写入 {targetPath} 失败：{error}", { targetPath, error: formatError(error) }));
	}
}
