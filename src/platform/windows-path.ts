import { resolve, win32 } from "node:path";

/**
 * Compare a caller-controlled absolute path with a Windows realpath result.
 * Node may report the latter with the extended-length `\\?\\` prefix; this
 * normalizes only equivalent spelling differences and never resolves links.
 */
export function samePhysicalPath(left: string, right: string): boolean {
  if (process.platform !== "win32") return resolve(left) === resolve(right);
  return windowsPathKey(left) === windowsPathKey(right);
}

function windowsPathKey(value: string): string {
  let normalized = value.replaceAll("/", "\\");
  if (normalized.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
  else if (normalized.startsWith("\\\\?\\")) normalized = normalized.slice(4);
  return win32.normalize(normalized).toLowerCase();
}
