import { resolve } from "node:path";

/**
 * Windows `realpath` may expand an 8.3 alias (and may add an extended-length
 * prefix), so its spelling cannot be compared with the caller's path. Callers
 * must pair this with lstat/reparse and device+inode identity checks; on POSIX
 * the canonical spelling remains part of the fence.
 */
export function samePhysicalPath(left: string, right: string): boolean {
  if (process.platform === "win32") return true;
  return resolve(left) === resolve(right);
}
