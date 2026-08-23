import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, open, realpath, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";


import { canonicalizeJson } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";


export interface WindowsPersistenceResult {
  readonly businessExit: number;
  readonly persistencePending: boolean;
  readonly persistenceFailed: boolean;
  readonly errorCode: "none" | "recoverable" | "fatal";
}


export interface WindowsPersistenceOptions {
  readonly parentExit: () => Promise<number>;
  readonly rotate: () => Promise<void>;
  readonly commit: () => Promise<void>;
  readonly isRecoverable: (error: unknown) => boolean;
}


/**
 * The helper is intentionally one-shot: it waits for the already-finished
 * business process, then attempts persistence. It never receives or replays
 * the business stdin and never changes the business exit code.
 */
export async function runWindowsPersistence(
  options: WindowsPersistenceOptions,
): Promise<WindowsPersistenceResult> {
  const businessExit = await options.parentExit();
  try {
    await options.rotate();
    await options.commit();
    return Object.freeze({
      businessExit,
      persistencePending: false,
      persistenceFailed: false,
      errorCode: "none",
    });
  } catch (error) {
    if (options.isRecoverable(error)) {
      return Object.freeze({
        businessExit,
        persistencePending: true,
        persistenceFailed: false,
        errorCode: "recoverable",
      });
    }
    return Object.freeze({
      businessExit,
      persistencePending: false,
      persistenceFailed: true,
      errorCode: "fatal",
    });
  }
}


export interface WindowsExecutablePaths {
  readonly canonical: string;
  readonly staged: string;
  readonly old: string;
}


export const WINDOWS_EXECUTABLE_FAULT_POINTS = [
  "after-journal-prepared",
  "before-canonical-identity-check",
  "after-canonical-rename",
  "after-canonical-rotated",
  "before-staged-identity-check",
  "after-staged-rename",
  "after-staged-installed",
] as const;
export type WindowsExecutableFaultPoint = (typeof WINDOWS_EXECUTABLE_FAULT_POINTS)[number];


export interface WindowsExecutableFaultInjector {
  hit(point: WindowsExecutableFaultPoint): void | Promise<void>;
}


export interface WindowsExecutableRotationOptions {
  readonly faultInjector?: WindowsExecutableFaultInjector;
}


type JournalPhase = "prepared" | "canonical-rotated" | "staged-installed";


interface FileIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
}


interface WindowsExecutableJournal {
  readonly journalVersion: 1;
  readonly phase: JournalPhase;
  readonly canonical: string;
  readonly staged: string;
  readonly old: string;
  readonly canonicalIdentity: FileIdentity;
  readonly canonicalSha256: string;
  readonly stagedIdentity: FileIdentity;
  readonly stagedSha256: string;
}


const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 32 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_DECIMAL = /^-?(?:0|[1-9][0-9]*)$/u;
const READ_ONLY_FLAGS = constants.O_RDONLY |
  ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);


function windowsPathKey(path: string): string {
  return resolve(path).replaceAll("/", "\\").toLowerCase();
}


function validWindowsPathSyntax(path: string): boolean {
  const withoutDrive = path.replace(/^[A-Za-z]:[\\/]/u, "");
  const segments = withoutDrive.split(/[\\/]/u).filter((segment) => segment !== "");
  return !segments.some((segment) =>
    /[\u0000-\u001f<>:"|?*]/u.test(segment) || segment.endsWith(".") || segment.endsWith(" ") ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment)
  );
}


function validPath(path: string): boolean {
  return typeof path === "string" && path !== "" && !path.includes("\u0000") &&
    isAbsolute(path) && resolve(path) === path && validWindowsPathSyntax(path);
}


function validatePaths(paths: WindowsExecutablePaths): void {
  if (paths === null || typeof paths !== "object" ||
      !validPath(paths.canonical) || !validPath(paths.staged) || !validPath(paths.old)) {
    throw new Error("unsafe executable paths");
  }
  const directories = [paths.canonical, paths.staged, paths.old].map((path) => windowsPathKey(dirname(path)));
  const values = [paths.canonical, paths.staged, paths.old].map(windowsPathKey);
  const journal = windowsPathKey(`${paths.canonical}.update-journal.json`);
  if (new Set(directories).size !== 1 || new Set(values).size !== values.length || values.includes(journal)) {
    throw new Error("unsafe executable paths");
  }
}


function sameStats(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}


function identity(stats: BigIntStats): FileIdentity {
  return Object.freeze({
    dev: stats.dev.toString(),
    ino: stats.ino.toString(),
    size: stats.size.toString(),
    mtimeNs: stats.mtimeNs.toString(),
  });
}


function identityMatches(stats: BigIntStats, expected: FileIdentity): boolean {
  const actual = identity(stats);
  return actual.dev === expected.dev && actual.ino === expected.ino &&
    actual.size === expected.size && actual.mtimeNs === expected.mtimeNs;
}


async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


async function assertPlainDirectory(path: string): Promise<void> {
  let before: BigIntStats;
  let canonical: BigIntStats;
  let after: BigIntStats;
  try {
    before = await lstat(path, { bigint: true }) as BigIntStats;
    const physical = await realpath(path);
    canonical = await lstat(physical, { bigint: true }) as BigIntStats;
    after = await lstat(path, { bigint: true }) as BigIntStats;
  } catch {
    throw new Error("unsafe executable directory");
  }
  if (
    before.isSymbolicLink() ||
    !before.isDirectory() ||
    !sameStats(before, canonical) ||
    !sameStats(before, after)
  ) {
    throw new Error("unsafe executable directory");
  }
}

async function hashHandle(
  handle: Awaited<ReturnType<typeof open>>,
  expected: BigIntStats,
): Promise<string> {
  if (!expected.isFile() || expected.size < 1n || expected.size > BigInt(MAX_EXECUTABLE_BYTES)) {
    throw new Error("unsafe executable path");
  }
  const hash = createHash("sha256");
  const buffer = new Uint8Array(64 * 1024);
  let offset = 0;
  const length = Number(expected.size);
  while (offset < length) {
    const result = await handle.read(buffer, 0, Math.min(buffer.byteLength, length - offset), offset);
    if (result.bytesRead <= 0) throw new Error("unsafe executable path");
    hash.update(buffer.subarray(0, result.bytesRead));
    offset += result.bytesRead;
  }
  const extra = new Uint8Array(1);
  if ((await handle.read(extra, 0, 1, length)).bytesRead !== 0) {
    throw new Error("unsafe executable path");
  }
  const after = await handle.stat({ bigint: true }) as BigIntStats;
  if (!sameStats(expected, after)) throw new Error("unsafe executable identity");
  return hash.digest("hex");
}


interface VerifiedFile {
  readonly handle: Awaited<ReturnType<typeof open>>;
  readonly stats: BigIntStats;
  readonly sha256: string;
}


async function openVerifiedFile(path: string): Promise<VerifiedFile> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path, { bigint: true }) as BigIntStats;
    const physical = await realpath(path);
    const canonical = await lstat(physical, { bigint: true }) as BigIntStats;
    if (before.isSymbolicLink() || !before.isFile() || !sameStats(before, canonical)) {
      throw new Error("unsafe executable path");
    }
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    const current = await lstat(path, { bigint: true }) as BigIntStats;
    if (!opened.isFile() || current.isSymbolicLink() || !sameStats(before, opened) ||
        !sameStats(opened, current)) {
      throw new Error("unsafe executable identity");
    }
    const sha256 = await hashHandle(handle, opened);
    return { handle, stats: opened, sha256 };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

async function reverifyFile(path: string, file: VerifiedFile): Promise<void> {
  const current = await lstat(path, { bigint: true }) as BigIntStats;
  const physical = await realpath(path);
  const canonical = await lstat(physical, { bigint: true }) as BigIntStats;
  const opened = await file.handle.stat({ bigint: true }) as BigIntStats;
  if (current.isSymbolicLink() || !current.isFile() || !sameStats(file.stats, opened) ||
      !sameStats(opened, current) || !sameStats(current, canonical) ||
      await hashHandle(file.handle, opened) !== file.sha256) {
    throw new Error("unsafe executable identity");
  }
}

async function removeRegularIfPresent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const file = await openVerifiedFile(path);
  try {
    await reverifyFile(path, file);
    await rm(path);
  } finally {
    await file.handle.close().catch(() => undefined);
  }
}


function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
    throw new Error("unsafe executable journal");
  }
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("unsafe executable journal");
  }
  return value as Record<string, unknown>;
}


function validateIdentity(value: unknown): FileIdentity {
  const record = exactRecord(value, ["dev", "ino", "size", "mtimeNs"]);
  if (typeof record.dev !== "string" || !DECIMAL.test(record.dev) ||
      typeof record.ino !== "string" || !DECIMAL.test(record.ino) ||
      typeof record.size !== "string" || !DECIMAL.test(record.size) || record.size === "0" ||
      typeof record.mtimeNs !== "string" || !SIGNED_DECIMAL.test(record.mtimeNs)) {
    throw new Error("unsafe executable journal");
  }
  return Object.freeze({
    dev: record.dev,
    ino: record.ino,
    size: record.size,
    mtimeNs: record.mtimeNs,
  });
}


function validateJournal(value: unknown, paths: WindowsExecutablePaths): WindowsExecutableJournal {
  const record = exactRecord(value, [
    "journalVersion", "phase", "canonical", "staged", "old",
    "canonicalIdentity", "canonicalSha256", "stagedIdentity", "stagedSha256",
  ]);
  if (record.journalVersion !== 1 ||
      (record.phase !== "prepared" && record.phase !== "canonical-rotated" && record.phase !== "staged-installed") ||
      record.canonical !== paths.canonical || record.staged !== paths.staged || record.old !== paths.old ||
      typeof record.canonicalSha256 !== "string" || !SHA256.test(record.canonicalSha256) ||
      typeof record.stagedSha256 !== "string" || !SHA256.test(record.stagedSha256)) {
    throw new Error("unsafe executable journal");
  }
  return Object.freeze({
    journalVersion: 1,
    phase: record.phase,
    canonical: paths.canonical,
    staged: paths.staged,
    old: paths.old,
    canonicalIdentity: validateIdentity(record.canonicalIdentity),
    canonicalSha256: record.canonicalSha256,
    stagedIdentity: validateIdentity(record.stagedIdentity),
    stagedSha256: record.stagedSha256,
  });
}


function journalText(journal: WindowsExecutableJournal, paths: WindowsExecutablePaths): string {
  return `${canonicalizeJson(validateJournal(journal, paths))}\n`;
}


export function windowsExecutableJournalPath(paths: WindowsExecutablePaths): string {
  validatePaths(paths);
  return `${paths.canonical}.update-journal.json`;
}


async function writeJournal(
  paths: WindowsExecutablePaths,
  journal: WindowsExecutableJournal,
): Promise<void> {
  const path = windowsExecutableJournalPath(paths);
  const parent = dirname(path);
  await assertPlainDirectory(parent);
  const bytes = new TextEncoder().encode(journalText(journal, paths));
  if (bytes.byteLength > MAX_JOURNAL_BYTES) throw new Error("unsafe executable journal");
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("unsafe executable journal");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw new Error("unsafe executable journal");
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}


async function readJournal(paths: WindowsExecutablePaths): Promise<WindowsExecutableJournal | null> {
  const path = windowsExecutableJournalPath(paths);
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true }) as BigIntStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("unsafe executable journal");
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1n ||
      before.size > BigInt(MAX_JOURNAL_BYTES)) throw new Error("unsafe executable journal");
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!sameStats(before, opened)) throw new Error("unsafe executable journal");
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead <= 0) throw new Error("unsafe executable journal");
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) {
      throw new Error("unsafe executable journal");
    }
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const current = await lstat(path, { bigint: true }) as BigIntStats;
    if (current.isSymbolicLink() || !sameStats(opened, after) || !sameStats(opened, current)) {
      throw new Error("unsafe executable journal");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const journal = validateJournal(parseStrictJson(text), paths);
    if (text !== journalText(journal, paths)) throw new Error("unsafe executable journal");
    return journal;
  } catch {
    throw new Error("unsafe executable journal");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


async function removeJournal(paths: WindowsExecutablePaths): Promise<void> {
  const path = windowsExecutableJournalPath(paths);
  const item = await lstat(path);
  if (item.isSymbolicLink() || !item.isFile()) throw new Error("unsafe executable journal");
  await rm(path);
  await syncDirectory(dirname(path));
}


interface ClosedVerifiedFile {
  readonly stats: BigIntStats;
  readonly sha256: string;
}


async function inspectFileOrNull(path: string): Promise<ClosedVerifiedFile | null> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const file = await openVerifiedFile(path);
  try {
    return { stats: file.stats, sha256: file.sha256 };
  } finally {
    await file.handle.close();
  }
}


function fileMatches(
  file: ClosedVerifiedFile | null,
  expectedIdentity: FileIdentity,
  expectedSha256: string,
): boolean {
  return file !== null && identityMatches(file.stats, expectedIdentity) && file.sha256 === expectedSha256;
}


/** Repair a durable pending rotation without accepting an unjournaled executable. */
export async function recoverWindowsExecutable(paths: WindowsExecutablePaths): Promise<"old" | "new" | null> {
  validatePaths(paths);
  await assertPlainDirectory(dirname(paths.canonical));
  const journal = await readJournal(paths);
  if (journal === null) return null;
  const [canonical, staged, old] = await Promise.all([
    inspectFileOrNull(paths.canonical),
    inspectFileOrNull(paths.staged),
    inspectFileOrNull(paths.old),
  ]);


  if (fileMatches(canonical, journal.stagedIdentity, journal.stagedSha256) && staged === null &&
      fileMatches(old, journal.canonicalIdentity, journal.canonicalSha256)) {
    await chmod(paths.canonical, 0o755).catch(() => undefined);
    await removeJournal(paths);
    return "new";
  }
  if (fileMatches(canonical, journal.canonicalIdentity, journal.canonicalSha256) && old === null) {
    await removeJournal(paths);
    return "old";
  }
  if (canonical === null && fileMatches(old, journal.canonicalIdentity, journal.canonicalSha256)) {
    const oldFile = await openVerifiedFile(paths.old);
    try {
      await reverifyFile(paths.old, oldFile);
      await rename(paths.old, paths.canonical);
      await syncDirectory(dirname(paths.canonical));
    } finally {
      await oldFile.handle.close().catch(() => undefined);
    }
    await removeJournal(paths);
    return "old";
  }
  throw new Error("unsafe executable recovery state");
}


/** Rotate a staged executable, leaving a durable journal for startup repair. */
export async function rotateWindowsExecutable(
  paths: WindowsExecutablePaths,
  options: WindowsExecutableRotationOptions = {},
): Promise<void> {
  validatePaths(paths);
  const parent = dirname(paths.canonical);
  await assertPlainDirectory(parent);
  await recoverWindowsExecutable(paths);
  const staged = await openVerifiedFile(paths.staged);
  let canonical: VerifiedFile | undefined;
  try {
    canonical = await openVerifiedFile(paths.canonical);
    if (canonical.stats.dev === staged.stats.dev && canonical.stats.ino === staged.stats.ino) {
      throw new Error("unsafe executable identity");
    }
    await removeRegularIfPresent(paths.old);
    await syncDirectory(parent);
    const base = {
      journalVersion: 1 as const,
      canonical: paths.canonical,
      staged: paths.staged,
      old: paths.old,
      canonicalIdentity: identity(canonical.stats),
      canonicalSha256: canonical.sha256,
      stagedIdentity: identity(staged.stats),
      stagedSha256: staged.sha256,
    };
    await writeJournal(paths, { ...base, phase: "prepared" });
    await options.faultInjector?.hit("after-journal-prepared");
    await options.faultInjector?.hit("before-canonical-identity-check");
    await reverifyFile(paths.canonical, canonical);
    await rename(paths.canonical, paths.old);
    await options.faultInjector?.hit("after-canonical-rename");
    await canonical.handle.close();
    canonical = undefined;
    await syncDirectory(parent);
    await writeJournal(paths, { ...base, phase: "canonical-rotated" });
    await options.faultInjector?.hit("after-canonical-rotated");
    await options.faultInjector?.hit("before-staged-identity-check");
    await reverifyFile(paths.staged, staged);
    await rename(paths.staged, paths.canonical);
    await options.faultInjector?.hit("after-staged-rename");
    await staged.handle.close();
    await syncDirectory(parent);
    await writeJournal(paths, { ...base, phase: "staged-installed" });
    await options.faultInjector?.hit("after-staged-installed");
    await chmod(paths.canonical, 0o755).catch(() => undefined);
    await removeJournal(paths);
  } finally {
    await canonical?.handle.close().catch(() => undefined);
    await staged.handle.close().catch(() => undefined);
  }
}
