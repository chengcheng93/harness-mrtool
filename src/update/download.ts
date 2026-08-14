import { performance } from "node:perf_hooks";
import type { BigIntStats } from "node:fs";
import { lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";

/** Ordinary channel manifest requests are deliberately short and single-shot. */
export const MANIFEST_UPDATE_BUDGET_MS = 2_000;
/** Asset staging has a separate wall-clock budget from the manifest request. */
export const ASSET_UPDATE_BUDGET_MS = 5 * 60 * 1_000;
export const MAX_ARCHIVE_ENTRIES = 16_384;
const ITERATOR_CLOSE_BUDGET_MS = 250;

export interface DownloadOptions {
  readonly maxBytes: number;
  readonly budgetMs: number;
  readonly clock?: () => number;
  readonly allowEmpty?: boolean;
}

export interface ArchiveEntry {
  readonly name: string;
  readonly kind: "file" | "directory" | "symlink";
}

function securityFailure(message: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError(
    "UPDATE_SECURITY_ERROR",
    message,
    {
      field: "update",
      expected: "a bounded, canonical update asset",
      actual: "asset rejected",
      safeNextStep: "Keep the last-known-good release and retry the update later.",
    },
  );
}

function validLimit(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function nowValue(clock: (() => number) | undefined): number {
  const value = clock === undefined ? performance.now() : clock();
  if (!Number.isFinite(value) || value < 0) throw securityFailure("update clock is invalid");
  return value;
}

async function nextWithinBudget<T>(
  iterator: AsyncIterator<T>,
  deadline: number,
  clock: () => number,
): Promise<IteratorResult<T>> {
  const current = clock();
  if (current > deadline) throw securityFailure("update asset budget exceeded");
  const remaining = Math.max(1, Math.ceil(deadline - current));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(securityFailure("update asset budget exceeded")),
        remaining,
      );
    });
    return await Promise.race([
      iterator.next(),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeIterator(iterator: AsyncIterator<unknown>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const closing = iterator.return?.();
    if (closing === undefined) return;
    await Promise.race([
      Promise.resolve(closing),
      new Promise<void>((resolvePromise) => {
        timer = setTimeout(resolvePromise, ITERATOR_CLOSE_BUDGET_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    // Preserve the original bounded-read failure; cleanup is best effort.
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Read an async byte stream without ever buffering beyond the declared cap. */
export async function downloadBounded(
  source: AsyncIterable<Uint8Array>,
  options: DownloadOptions,
): Promise<Uint8Array> {
  if (options === null || typeof options !== "object" ||
      !validLimit(options.maxBytes) || !validLimit(options.budgetMs)) {
    throw securityFailure("update limits are invalid");
  }
  const clock = options.clock;
  const start = nowValue(clock);
  const deadline = start + options.budgetMs;
  if (!Number.isSafeInteger(Math.ceil(deadline)) || deadline < start) {
    throw securityFailure("update budget overflows");
  }
  const iterator = source?.[Symbol.asyncIterator]?.();
  if (iterator === undefined) throw securityFailure("update body is not a byte stream");
  let lastClock = start;
  const monotonicClock = (): number => {
    const current = nowValue(clock);
    if (current < lastClock) throw securityFailure("update clock moved backwards");
    lastClock = current;
    return current;
  };
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const step = await nextWithinBudget(iterator, deadline, monotonicClock);
      if (step.done === true) break;
      const chunk = step.value;
      if (!(chunk instanceof Uint8Array)) throw securityFailure("update body contains a non-byte chunk");
      if (chunk.byteLength === 0) continue;
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > options.maxBytes) {
        throw securityFailure("update asset size exceeded");
      }
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error) {
    await closeIterator(iterator);
    throw error instanceof ToolError ? error : securityFailure("update asset stream failed");
  }
  if (!options.allowEmpty && total === 0) throw securityFailure("update asset is empty");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function canonicalEntryName(name: string): string {
  if (typeof name !== "string") throw securityFailure("archive path is unsafe");
  const pathBody = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = pathBody.split("/");
  if (
    pathBody === "" || name.length > 1_024 || /[\u0000-\u001f<>:"|?*]/u.test(name) ||
    name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/u.test(name) ||
    segments.some((segment) =>
      segment === "" || segment === "." || segment === ".." ||
      segment.endsWith(".") || segment.endsWith(" ") ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
    )
  ) throw securityFailure("archive path is unsafe");
  return name;
}

/** Validate archive metadata before extraction; no symlink or hardlink is accepted. */
export function validateArchiveEntries(entries: readonly ArchiveEntry[]): readonly ArchiveEntry[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw securityFailure("archive entry count exceeded");
  }
  const seen = new Map<string, ArchiveEntry["kind"]>();
  const result: ArchiveEntry[] = [];
  for (const entry of entries) {
    const descriptors = entry === null || typeof entry !== "object"
      ? undefined
      : Object.getOwnPropertyDescriptors(entry);
    if (
      entry === null || typeof entry !== "object" ||
      Object.getPrototypeOf(entry) !== Object.prototype ||
      Object.getOwnPropertySymbols(entry).length !== 0 || descriptors === undefined ||
      Object.keys(descriptors).sort().join(",") !== "kind,name" ||
      Object.values(descriptors).some((descriptor) =>
        !descriptor.enumerable || !("value" in descriptor) ||
        descriptor.get !== undefined || descriptor.set !== undefined
      )
    ) throw securityFailure("archive entry is malformed");
    const name = canonicalEntryName(entry.name);
    if (entry.kind !== "file" && entry.kind !== "directory" && entry.kind !== "symlink") {
      throw securityFailure("archive entry kind is unsupported");
    }
    if (entry.kind === "symlink") throw securityFailure("archive symlink is not allowed");
    const key = (name.endsWith("/") ? name.slice(0, -1) : name).toLowerCase();
    if (seen.has(key)) throw securityFailure("archive contains duplicate paths");
    seen.set(key, entry.kind);
    if (entry.kind === "directory" && !name.endsWith("/")) {
      throw securityFailure("archive directory path is not canonical");
    }
    if (entry.kind === "file" && name.endsWith("/")) {
      throw securityFailure("archive file path is not canonical");
    }
    result.push(Object.freeze({ name, kind: entry.kind }));
  }
  for (const path of seen.keys()) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/");
      if (seen.get(ancestor) === "file") {
        throw securityFailure("archive path hierarchy is unsafe");
      }
    }
  }
  result.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  return Object.freeze(result);
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

function filesystemPathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathKey(left) === filesystemPathKey(right);
}

function expectedExtractedEntries(entries: readonly ArchiveEntry[]): Map<string, ArchiveEntry["kind"]> {
  const expected = new Map<string, ArchiveEntry["kind"]>();
  for (const entry of entries) {
    const body = entry.name.endsWith("/") ? entry.name.slice(0, -1) : entry.name;
    const segments = body.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const ancestor = segments.slice(0, index).join("/").toLowerCase();
      const current = expected.get(ancestor);
      if (current !== undefined && current !== "directory") {
        throw securityFailure("archive path hierarchy is unsafe");
      }
      expected.set(ancestor, "directory");
    }
    const key = body.toLowerCase();
    const current = expected.get(key);
    if (current !== undefined && current !== entry.kind) {
      throw securityFailure("archive path hierarchy is unsafe");
    }
    expected.set(key, entry.kind);
  }
  return expected;
}

async function verifiedRealPath(path: string, root: string, before: BigIntStats): Promise<void> {
  let physical: string;
  let after: BigIntStats;
  try {
    physical = await realpath(path);
    after = await lstat(path, { bigint: true }) as BigIntStats;
  } catch {
    throw securityFailure("archive extraction changed during validation");
  }
  if (!sameIdentity(before, after) || after.isSymbolicLink() ||
      !sameFilesystemPath(physical, path)) {
    throw securityFailure("archive extraction contains a link or reparse point");
  }
  const relation = relative(root, physical);
  if (relation === ".." || relation.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(relation)) {
    throw securityFailure("archive extraction escapes its root");
  }
}

/** Verify the exact extracted tree without following links or reparse points. */
export async function validateExtractedArchive(
  root: string,
  entries: readonly ArchiveEntry[],
): Promise<void> {
  if (typeof root !== "string" || root === "" || !isAbsolute(root) || resolve(root) !== root) {
    throw securityFailure("archive extraction root is unsafe");
  }
  const validated = validateArchiveEntries(entries);
  const expected = expectedExtractedEntries(validated);
  const actual = new Map<string, ArchiveEntry["kind"]>();
  let rootInfo: BigIntStats;
  try {
    rootInfo = await lstat(root, { bigint: true }) as BigIntStats;
  } catch {
    throw securityFailure("archive extraction root is unavailable");
  }
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw securityFailure("archive extraction root is unsafe");
  }
  await verifiedRealPath(root, root, rootInfo);

  async function walk(directory: string, prefix: string): Promise<void> {
    let directoryInfo: BigIntStats;
    try {
      directoryInfo = await lstat(directory, { bigint: true }) as BigIntStats;
    } catch {
      throw securityFailure("archive extraction changed during validation");
    }
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
      throw securityFailure("archive extraction contains an unsafe directory");
    }
    await verifiedRealPath(directory, root, directoryInfo);
    let opened: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      opened = await opendir(directory);
      for await (const entry of opened) {
        const portable = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const path = resolve(directory, entry.name);
        let info: BigIntStats;
        try {
          info = await lstat(path, { bigint: true }) as BigIntStats;
        } catch {
          throw securityFailure("archive extraction changed during validation");
        }
        if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) {
          throw securityFailure("archive extraction contains a link or unsupported entry");
        }
        const kind: ArchiveEntry["kind"] = info.isDirectory() ? "directory" : "file";
        const canonical = canonicalEntryName(kind === "directory" ? `${portable}/` : portable);
        const key = (canonical.endsWith("/") ? canonical.slice(0, -1) : canonical).toLowerCase();
        if (actual.has(key)) throw securityFailure("archive extraction contains duplicate paths");
        if (kind === "file" && info.nlink !== 1n) {
          throw securityFailure("archive extraction contains a hard link");
        }
        await verifiedRealPath(path, root, info);
        actual.set(key, kind);
        if (actual.size > MAX_ARCHIVE_ENTRIES) {
          throw securityFailure("archive extraction entry count exceeded");
        }
        if (kind === "directory") await walk(path, portable);
      }
      opened = undefined;
    } catch (error) {
      throw error instanceof ToolError ? error : securityFailure("archive extraction could not be inspected");
    } finally {
      await opened?.close().catch(() => undefined);
    }
    const after = await lstat(directory, { bigint: true }) as BigIntStats;
    if (!sameIdentity(directoryInfo, after) || after.isSymbolicLink()) {
      throw securityFailure("archive extraction changed during validation");
    }
  }

  await walk(root, "");
  if (actual.size !== expected.size ||
      [...expected].some(([path, kind]) => actual.get(path) !== kind)) {
    throw securityFailure("archive extraction entry set does not match metadata");
  }
}
