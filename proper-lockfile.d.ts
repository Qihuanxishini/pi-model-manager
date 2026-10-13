// proper-lockfile 4.x 不自带类型声明；这里仅为本仓库实际用到的 API 提供最小签名。
declare module "proper-lockfile" {
	export interface LockOptions {
		realpath?: boolean | null;
		retries?: number | { retries: number; factor: number; minTimeout: number; maxTimeout: number };
	}

	export function lock(path: string, options?: LockOptions): Promise<() => Promise<void>>;
	export function unlock(path: string, options?: LockOptions): Promise<void>;
	export function check(path: string, options?: LockOptions): Promise<boolean>;

	const properLockfile: {
		lock: typeof lock;
		unlock: typeof unlock;
		check: typeof check;
	};
	export default properLockfile;
}
