import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { ensurePrivateStateDirectory, type WindowsAclVerifier } from "../platform/state-path.ts";
import { assertUpdateLockLease } from "../platform/lock.ts";
import type { ProcessLockLease } from "../platform/process-lock.ts";
import {
  encodeInstallationJournal,
  MAX_INSTALLATION_JOURNAL_BYTES,
  parseInstallationJournal,
  type InstallationFileIdentity,
  type InstallationJournal,
} from "./installation-journal.ts";
import { writeBoundedCanonicalFile } from "./journal.ts";

export const INSTALLATION_JOURNAL_FILE_NAME = "installation-journal.json";

const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_IDENTITY = (1n << 64n) - 1n;

type JournalStat = Awaited<ReturnType<typeof lstat>> & {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
};

function failure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "installation journal store is unsafe", {
    field: "installationJournalStore",
    expected: "a private bounded canonical journal under the fixed state root",
    actual: "unsafe",
    safeNextStep: "Preserve installation evidence and run self-update repair.",
  });
}

function validAbsoluteRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value) throw failure();
  return value;
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  return resolve(left) === resolve(right);
}

function sameIdentity(left: JournalStat, right: JournalStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function decimalIdentity(value: InstallationFileIdentity): { readonly dev: bigint; readonly ino: bigint } {
  if (!/^\d+$/u.test(value.dev) || !/^\d+$/u.test(value.ino)) throw failure();
  const dev = BigInt(value.dev);
  const ino = BigInt(value.ino);
  if (dev > MAX_IDENTITY || ino < 1n || ino > MAX_IDENTITY) throw failure();
  return { dev, ino };
}

function assertPrivateFile(info: JournalStat, expectedSize?: bigint): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n ||
      (expectedSize !== undefined && info.size !== expectedSize)) throw failure();
  if (process.platform !== "win32" &&
      (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o600n)) throw failure();
}

async function rootStat(
  stateRoot: string,
  create: boolean,
  windowsAclVerifier?: WindowsAclVerifier,
): Promise<JournalStat | null> {
  if (create) {
    await ensurePrivateStateDirectory(stateRoot, windowsAclVerifier === undefined ? {} : { windowsAclVerifier });
  }
  try {
    const info = await lstat(stateRoot, { bigint: true }) as JournalStat;
    const physical = await realpath(stateRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || !samePath(physical, stateRoot) ||
        (process.platform !== "win32" &&
          (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n))) {
      throw failure();
    }
    return info;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error instanceof ToolError ? error : failure();
  }
}

async function readBounded(path: string): Promise<{ readonly bytes: Uint8Array; readonly stat: JournalStat } | null> {
  let before: JournalStat;
  try {
    before = await lstat(path, { bigint: true }) as JournalStat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure();
  }
  assertPrivateFile(before);
  if (before.size < 1n || before.size > 64n * 1024n) throw failure();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primary: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat({ bigint: true }) as JournalStat;
    if (!sameIdentity(before, opened)) throw failure();
    assertPrivateFile(opened, before.size);
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) throw failure();
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) throw failure();
    const after = await handle.stat({ bigint: true }) as JournalStat;
    const current = await lstat(path, { bigint: true }) as JournalStat;
    if (!sameIdentity(opened, after) || !sameIdentity(opened, current)) throw failure();
    assertPrivateFile(current, BigInt(bytes.length));
    return { bytes, stat: current };
  } catch (error) {
    primary = error;
    throw error instanceof ToolError ? error : failure();
  } finally {
    try {
      await handle?.close();
    } catch {
      if (primary === undefined) throw failure();
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NOFOLLOW);
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
    }
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function currentTarget(path: string): Promise<JournalStat | null> {
  try {
    const info = await lstat(path, { bigint: true }) as JournalStat;
    assertPrivateFile(info);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error instanceof ToolError ? error : failure();
  }
}

function sameRootEvidence(journal: InstallationJournal, root: JournalStat): void {
  const expected = decimalIdentity(journal.roots.state);
  if (expected.dev !== root.dev || expected.ino !== root.ino) throw failure();
}


export interface InstallationJournalStoreOptions {
  readonly lease?: ProcessLockLease;
  /** In-process test/embedding seam; production defaults retain the system verifier. */
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export interface InstallationJournalStore {
  readonly path: string;
  encode(value: unknown): Uint8Array;
  read(): Promise<InstallationJournal | null>;
  write(value: unknown): Promise<InstallationJournal>;
  remove(): Promise<void>;
}

/**
 * A bounded, canonical journal store. The only writable pathname is derived
 * from the fixed state root at construction; journal data never supplies a
 * target path or mutation authority.
 */
export function createInstallationJournalStore(
  stateDirectory: string,
  options: InstallationJournalStoreOptions = {},
): InstallationJournalStore {
  const stateRoot = validAbsoluteRoot(stateDirectory);
  const boundLease = options.lease;
  const windowsAclVerifier = options.windowsAclVerifier;
  let knownRoot: { readonly dev: bigint; readonly ino: bigint } | undefined;

  function assertStableRoot(root: JournalStat): void {
    if (knownRoot === undefined) {
      knownRoot = Object.freeze({ dev: root.dev, ino: root.ino });
      return;
    }
    if (knownRoot.dev !== root.dev || knownRoot.ino !== root.ino) throw failure();
  }

  function assertBoundLease(): void {
    if (boundLease !== undefined) assertUpdateLockLease(boundLease, stateRoot);
  }
  const path = resolve(stateRoot, INSTALLATION_JOURNAL_FILE_NAME);

  async function read(): Promise<InstallationJournal | null> {
    assertBoundLease();
    const root = await rootStat(stateRoot, false, windowsAclVerifier);
    if (root === null) {
      if (knownRoot !== undefined) throw failure();
      return null;
    }
    assertStableRoot(root);
    const file = await readBounded(path);
    if (file === null) return null;
    const journal = parseInstallationJournal(file.bytes);
    sameRootEvidence(journal, root);
    return journal;
  }

  async function write(value: unknown): Promise<InstallationJournal> {
    assertBoundLease();
    const journal = parseInstallationJournal(encodeInstallationJournal(value));
    const root = await rootStat(stateRoot, true, windowsAclVerifier);
    if (root === null) throw failure();
    assertStableRoot(root);
    sameRootEvidence(journal, root);

    const existingBytes = await readBounded(path);
    const existing = existingBytes === null ? null : parseInstallationJournal(existingBytes.bytes);
    if (existing !== null) {
      sameRootEvidence(existing, root);
      if (existing.transactionId !== journal.transactionId || journal.revision <= existing.revision) {
        throw failure();
      }
    }

    const bytes = encodeInstallationJournal(journal);
    const rootBeforeWrite = await rootStat(stateRoot, false, windowsAclVerifier);
    if (rootBeforeWrite === null || !sameIdentity(root, rootBeforeWrite)) throw failure();
    const currentBytes = await readBounded(path);
    if (existingBytes === null ? currentBytes !== null :
        currentBytes === null || !sameIdentity(existingBytes.stat, currentBytes.stat) ||
        !sameBytes(existingBytes.bytes, currentBytes.bytes)) throw failure();

    await writeBoundedCanonicalFile(path, bytes, MAX_INSTALLATION_JOURNAL_BYTES, failure);
    const loaded = await read();
    if (loaded === null || loaded.revision !== journal.revision || loaded.transactionId !== journal.transactionId) throw failure();
    return loaded;
  }

  async function remove(): Promise<void> {
    assertBoundLease();
    const root = await rootStat(stateRoot, false, windowsAclVerifier);
    if (root === null) {
      if (knownRoot !== undefined) throw failure();
      return;
    }
    assertStableRoot(root);
    const currentBytes = await readBounded(path);
    if (currentBytes === null) return;
    const loaded = parseInstallationJournal(currentBytes.bytes);
    sameRootEvidence(loaded, root);
    const current = await currentTarget(path);
    if (current === null || !sameIdentity(currentBytes.stat, current)) throw failure();
    await rm(path);
    await syncDirectory(stateRoot);
  }

  return Object.freeze({ path, encode: encodeInstallationJournal, read, write, remove });
}
