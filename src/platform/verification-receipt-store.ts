import { constants, type BigIntStats } from "node:fs";
import {
  link,
  lstat,
  open,
  opendir,
  type FileHandle,
} from "node:fs/promises";
import { basename, resolve } from "node:path";

import {
  type TrustedVerificationReceiptLoad,
  type VerificationReceiptLoader,
  type VerificationReceiptLocator,
  type VerificationReceiptV1,
  type VerificationReceiptWriter,
  validateVerificationReceipt,
} from "../app/verify-mr.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "./state-path.ts";
import {
  systemProcessLockProvider,
  type ProcessLockLease,
  type ProcessLockProvider,
} from "./process-lock.ts";
import {
  systemWindowsWriteThroughMover,
  WindowsWriteThroughMoveError,
} from "./windows-write-through-move.ts";

const RECEIPT_DIRECTORY_NAME = "verification-receipts";
const LOCK_NAME = ".verification-receipts.lock";
const STORE_VERSION = 1;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_CORRUPT_EVIDENCE_FILES = 32;
const MAX_DIRECTORY_ENTRIES_SCANNED = 256;
const SHA256 = /^[a-f0-9]{64}$/u;
const CORRUPT_EVIDENCE_NAME = /^[a-f0-9]{64}\.json\.corrupt\.[a-f0-9]{64}\.json$/u;
const LOCATOR_FIELDS = new Set(["gitlabOrigin", "targetProjectId", "iid", "markerDigest"]);
const RECORD_FIELDS = new Set(["storeVersion", "locator", "receipt"]);
const CREDENTIAL_SHAPE = /(?:hmr[ctx]1_[A-Za-z0-9_-]{43}|glpat-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|(?:private|job)[_-]token\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}|authorization\s*[:=]\s*(?:bearer\s+)?[A-Za-z0-9._~+/=-]{8,}|bearer\s+[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;

export interface VerificationReceiptStoreOptions {
  readonly stateDirectory: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
  readonly processLockProvider?: ProcessLockProvider;
  readonly lockTimeoutMs?: number;
  readonly publisher?: VerificationReceiptPublisher;
  readonly faultInjector?: VerificationReceiptStoreFaultInjector;
}

export interface VerificationReceiptPublisher {
  readonly strategy: "hard-link" | "windows-write-through-move";
  publishNoReplace(sourcePath: string, destinationPath: string): Promise<void>;
}

export interface VerificationReceiptStoreFaultInjector {
  hit(
    point: "after-lock-acquired" | "after-evidence-create-open" | "after-pending-create-open" |
      "after-pending-open" | "after-pending-write-before-sync" | "after-publication-link" |
      "after-publication-directory-sync" | "after-read-open" | "before-corrupt-evidence" |
      "before-publication" | "after-idempotent-file-sync" |
      "after-idempotent-directory-sync" | "after-idempotent-final-revalidation",
  ): Promise<void> | void;
}

interface VerificationReceiptRecord {
  readonly storeVersion: 1;
  readonly locator: VerificationReceiptLocator;
  readonly receipt: VerificationReceiptV1;
}

interface DurableFileHooks {
  readonly afterCreate?: "after-evidence-create-open" | "after-pending-create-open";
  readonly afterOpen?: "after-pending-open";
  readonly beforeSync?: "after-pending-write-before-sync";
}

function unmanaged(): ToolError<"UNMANAGED_MR"> {
  return new ToolError("UNMANAGED_MR", "No exact durable verification receipt is available", {
    field: "verificationReceipt",
    expected: "a receipt bound to the GitLab origin, target project, MR IID, and final marker",
    actual: "unavailable",
    safeNextStep: "Recreate or update the merge request through harness-mrtool before verifying it.",
  });
}

function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "The durable verification receipt is not trustworthy", {
    field: "verificationReceipt",
    expected: "a canonical receipt in a private local state directory",
    actual: "invalid or unsafe local receipt state",
    safeNextStep: "Inspect any corruption evidence, repair the private state directory, and retry.",
  });
}

function persistenceFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "The durable verification receipt could not be persisted", {
    field: "verificationReceipt",
    expected: "an atomically durable receipt in the private state directory",
    actual: "local persistence failed",
    safeNextStep: "Repair the private local state directory and retry the merge request operation.",
  });
}

function credentialFailure(): ToolError<"POSTCONDITION_ERROR"> {
  return new ToolError("POSTCONDITION_ERROR", "The durable verification receipt contains forbidden credential material", {
    field: "verificationReceipt",
    expected: "credential-free canonical receipt bytes",
    actual: "credential-shaped content",
    safeNextStep: "Remove credentials from merge request metadata and retry without exposing the value.",
  });
}

function exactFields(value: JsonObject, expected: ReadonlySet<string>): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function recordValue(value: JsonValue): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw securityFailure();
  return value;
}

function normalizeLocator(value: unknown): VerificationReceiptLocator {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw unmanaged();
  }
  const input = recordValue(copied);
  if (!exactFields(input, LOCATOR_FIELDS) ||
      typeof input.gitlabOrigin !== "string" || typeof input.targetProjectId !== "string" ||
      !Number.isSafeInteger(input.iid) || (input.iid as number) < 1 ||
      typeof input.markerDigest !== "string" || !SHA256.test(input.markerDigest) ||
      input.targetProjectId === "" || input.targetProjectId !== input.targetProjectId.trim() ||
      input.targetProjectId.length > 512 || /[\r\n\u0000]/u.test(input.targetProjectId)) {
    throw unmanaged();
  }
  let origin: URL;
  try {
    origin = new URL(input.gitlabOrigin);
  } catch {
    throw unmanaged();
  }
  if (origin.protocol !== "https:" || origin.username !== "" || origin.password !== "" ||
      origin.search !== "" || origin.hash !== "" || origin.pathname !== "/" ||
      origin.origin !== input.gitlabOrigin || CREDENTIAL_SHAPE.test(canonicalizeJson(input))) {
    throw unmanaged();
  }
  return Object.freeze({
    gitlabOrigin: input.gitlabOrigin,
    targetProjectId: input.targetProjectId,
    iid: input.iid as number,
    markerDigest: input.markerDigest,
  });
}

function locatorFromReceipt(receiptValue: unknown): {
  readonly locator: VerificationReceiptLocator;
  readonly receipt: VerificationReceiptV1;
} {
  const receipt = validateVerificationReceipt(receiptValue);
  const locator = normalizeLocator({
    gitlabOrigin: receipt.gitlabOrigin,
    targetProjectId: receipt.targetProject.id,
    iid: receipt.iid,
    markerDigest: sha256CanonicalJson(receipt.marker as unknown as JsonValue),
  });
  return { locator, receipt };
}

function sameLocator(left: VerificationReceiptLocator, right: VerificationReceiptLocator): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function itemType(value: BigIntStats): string {
  if (value.isSymbolicLink()) return "symbolic-link";
  if (value.isFile()) return "file";
  if (value.isDirectory()) return "directory";
  if (value.isBlockDevice()) return "block-device";
  if (value.isCharacterDevice()) return "character-device";
  if (value.isFIFO()) return "fifo";
  if (value.isSocket()) return "socket";
  return "other";
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return itemType(left) === itemType(right) && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.nlink === right.nlink &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function sameMovedFile(left: BigIntStats, right: BigIntStats): boolean {
  return itemType(left) === itemType(right) && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs;
}

function serializeRecord(record: VerificationReceiptRecord): string {
  const serialized = `${canonicalizeJson(record)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_RECEIPT_BYTES) throw persistenceFailure();
  if (CREDENTIAL_SHAPE.test(serialized)) throw credentialFailure();
  return serialized;
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const hardLinkPublisher: VerificationReceiptPublisher = Object.freeze({
  strategy: "hard-link",
  publishNoReplace: link,
});

const windowsWriteThroughPublisher: VerificationReceiptPublisher = Object.freeze({
  strategy: "windows-write-through-move",
  publishNoReplace: (sourcePath: string, destinationPath: string) =>
    systemWindowsWriteThroughMover.moveNoReplace(sourcePath, destinationPath),
});

export class VerificationReceiptStore implements VerificationReceiptWriter, VerificationReceiptLoader {
  readonly receiptDirectory: string;
  private readonly stateDirectory: string;
  private readonly lockPath: string;
  private readonly windowsAclVerifier: WindowsAclVerifier | undefined;
  private readonly processLockProvider: ProcessLockProvider;
  private readonly lockTimeoutMs: number;
  private readonly publisher: VerificationReceiptPublisher;
  private readonly faultInjector: VerificationReceiptStoreFaultInjector | undefined;

  constructor(options: VerificationReceiptStoreOptions) {
    if (typeof options.stateDirectory !== "string" || options.stateDirectory.trim() === "") {
      throw new TypeError("stateDirectory must be a non-empty path");
    }
    this.stateDirectory = resolve(options.stateDirectory);
    this.receiptDirectory = resolve(this.stateDirectory, RECEIPT_DIRECTORY_NAME);
    this.lockPath = resolve(this.stateDirectory, LOCK_NAME);
    this.windowsAclVerifier = options.windowsAclVerifier;
    this.processLockProvider = options.processLockProvider ?? systemProcessLockProvider;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 30_000;
    const publisher = options.publisher ?? (process.platform === "win32"
      ? windowsWriteThroughPublisher
      : hardLinkPublisher);
    if ((publisher.strategy !== "hard-link" && publisher.strategy !== "windows-write-through-move") ||
        typeof publisher.publishNoReplace !== "function") {
      throw new TypeError("publisher must provide a supported no-replace strategy");
    }
    this.publisher = Object.freeze({
      strategy: publisher.strategy,
      publishNoReplace: (sourcePath: string, destinationPath: string) =>
        publisher.publishNoReplace(sourcePath, destinationPath),
    });
    this.faultInjector = options.faultInjector;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1 || this.lockTimeoutMs > 300_000) {
      throw new TypeError("lockTimeoutMs must be an integer between 1 and 300000");
    }
  }

  private async prepareDirectory(): Promise<void> {
    const aclOptions = this.windowsAclVerifier === undefined
      ? {}
      : { windowsAclVerifier: this.windowsAclVerifier };
    await ensurePrivateStateDirectory(this.stateDirectory, aclOptions);
    await ensurePrivateStateDirectory(this.receiptDirectory, aclOptions);
  }

  private pathFor(locator: VerificationReceiptLocator): string {
    return resolve(this.receiptDirectory, `${sha256CanonicalJson(locator)}.json`);
  }

  private pendingPathFor(locator: VerificationReceiptLocator): string {
    return resolve(this.receiptDirectory, `${sha256CanonicalJson(locator)}.pending.json`);
  }

  private async locked<T>(operation: (lease: ProcessLockLease) => Promise<T>): Promise<T> {
    await this.prepareDirectory();
    let lease: ProcessLockLease;
    try {
      lease = await this.processLockProvider.acquire(this.lockPath, this.lockTimeoutMs);
    } catch {
      throw persistenceFailure();
    }
    let failure: unknown;
    let result: T | undefined;
    try {
      lease.assertHeld();
      await this.faultInjector?.hit("after-lock-acquired");
      lease.assertHeld();
      result = await operation(lease);
      lease.assertHeld();
    } catch (error) {
      failure = error instanceof ToolError ? error : persistenceFailure();
    }
    try {
      await lease.release();
    } catch {
      failure ??= persistenceFailure();
    }
    if (failure !== undefined) throw failure;
    return result as T;
  }

  private async writeRecord(
    finalPath: string,
    pendingPath: string,
    record: VerificationReceiptRecord,
    serialized: string,
    lease: ProcessLockLease,
  ): Promise<void> {
    const expectedBytes = Buffer.from(serialized, "utf8");
    const existing = await this.readRecord(finalPath, pendingPath, record.locator, lease);
    if (existing !== null) {
      if (canonicalizeJson(existing) !== canonicalizeJson(record)) throw securityFailure();
      await this.refreshExistingDurability(finalPath, pendingPath, expectedBytes, lease);
      return;
    }
    const handle = await this.prepareDurableFile(pendingPath, expectedBytes, lease, {
      afterCreate: "after-pending-create-open",
      afterOpen: "after-pending-open",
      beforeSync: "after-pending-write-before-sync",
    });
    if (this.publisher.strategy === "hard-link") {
      await this.publishHardLink(handle, finalPath, pendingPath, expectedBytes, lease);
    } else {
      await this.publishWriteThroughMove(handle, finalPath, pendingPath, expectedBytes, lease);
    }
  }

  private async publishHardLink(
    handle: FileHandle,
    finalPath: string,
    pendingPath: string,
    expectedBytes: Buffer,
    lease: ProcessLockLease,
  ): Promise<void> {
    let linked = false;
    let failure: unknown;
    try {
      await this.faultInjector?.hit("before-publication");
      await this.requireExactLinkedIdentity(handle, [pendingPath], expectedBytes, 1n, lease);
      try {
        lease.assertHeld();
        await this.publisher.publishNoReplace(pendingPath, finalPath);
      } catch (error) {
        if (this.destinationExists(error)) {
          throw securityFailure();
        }
        throw persistenceFailure();
      }
      linked = true;
      await this.faultInjector?.hit("after-publication-link");
      await this.requireExactLinkedIdentity(handle, [pendingPath, finalPath], expectedBytes, 2n, lease);
      try {
        await syncDirectory(this.receiptDirectory);
      } catch {
        throw persistenceFailure();
      }
      await this.faultInjector?.hit("after-publication-directory-sync");
      await this.requireExactLinkedIdentity(handle, [pendingPath, finalPath], expectedBytes, 2n, lease);
    } catch (error) {
      failure = error instanceof ToolError
        ? error
        : linked ? securityFailure() : persistenceFailure();
    }
    try {
      await handle.close();
    } catch {
      failure ??= persistenceFailure();
    }
    if (failure !== undefined) throw failure;
  }

  private async publishWriteThroughMove(
    pendingHandle: FileHandle,
    finalPath: string,
    pendingPath: string,
    expectedBytes: Buffer,
    lease: ProcessLockLease,
  ): Promise<void> {
    let handle: FileHandle | undefined = pendingHandle;
    let publicationAttempted = false;
    let failure: unknown;
    try {
      await this.faultInjector?.hit("before-publication");
      const pendingIdentity = await this.requireExactLinkedIdentity(
        handle,
        [pendingPath],
        expectedBytes,
        1n,
        lease,
      );
      await this.requirePathAbsent(finalPath, lease);
      await handle.close();
      handle = undefined;
      lease.assertHeld();
      publicationAttempted = true;
      try {
        await this.publisher.publishNoReplace(pendingPath, finalPath);
      } catch {
        throw securityFailure();
      }
      await this.faultInjector?.hit("after-publication-link");
      handle = await this.openExactMovedFile(
        finalPath,
        pendingPath,
        pendingIdentity,
        expectedBytes,
        lease,
      );
      await handle.sync();
      await this.requireExactLinkedIdentity(handle, [finalPath], expectedBytes, 1n, lease);
      await this.requirePathAbsent(pendingPath, lease);
      await this.faultInjector?.hit("after-publication-directory-sync");
      await this.requireExactLinkedIdentity(handle, [finalPath], expectedBytes, 1n, lease);
      await this.requirePathAbsent(pendingPath, lease);
    } catch (error) {
      failure = error instanceof ToolError
        ? error
        : publicationAttempted ? securityFailure() : persistenceFailure();
    }
    try {
      await handle?.close();
    } catch {
      failure ??= publicationAttempted ? securityFailure() : persistenceFailure();
    }
    if (failure !== undefined) throw failure;
  }

  private async refreshExistingDurability(
    finalPath: string,
    pendingPath: string,
    expectedBytes: Buffer,
    lease: ProcessLockLease,
  ): Promise<void> {
    if (this.publisher.strategy === "hard-link") {
      await this.refreshHardLinkDurability(finalPath, pendingPath, expectedBytes, lease);
    } else {
      await this.refreshWriteThroughDurability(finalPath, pendingPath, expectedBytes, lease);
    }
  }

  private async refreshHardLinkDurability(
    finalPath: string,
    pendingPath: string,
    expectedBytes: Buffer,
    lease: ProcessLockLease,
  ): Promise<void> {
    let handle: FileHandle | undefined;
    let failure: unknown;
    try {
      lease.assertHeld();
      handle = await open(pendingPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      await this.requireExactLinkedIdentity(handle, [pendingPath, finalPath], expectedBytes, 2n, lease);
      await handle.sync();
      await this.faultInjector?.hit("after-idempotent-file-sync");
      await this.requireExactLinkedIdentity(handle, [pendingPath, finalPath], expectedBytes, 2n, lease);
      await syncDirectory(this.receiptDirectory);
      await this.faultInjector?.hit("after-idempotent-directory-sync");
      await this.requireExactLinkedIdentity(handle, [pendingPath, finalPath], expectedBytes, 2n, lease);
    } catch (error) {
      failure = error instanceof ToolError ? error : persistenceFailure();
    }
    try {
      await handle?.close();
    } catch {
      failure ??= persistenceFailure();
    }
    if (failure !== undefined) throw failure;
  }

  private async refreshWriteThroughDurability(
    finalPath: string,
    pendingPath: string,
    expectedBytes: Buffer,
    lease: ProcessLockLease,
  ): Promise<void> {
    let handle: FileHandle | undefined;
    let failure: unknown;
    try {
      await this.requirePathAbsent(pendingPath, lease);
      handle = await open(finalPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      await this.requireExactLinkedIdentity(
        handle,
        [finalPath],
        expectedBytes,
        1n,
        lease,
      );
      await handle.sync();
      await this.faultInjector?.hit("after-idempotent-file-sync");
      await this.requireExactLinkedIdentity(
        handle,
        [finalPath],
        expectedBytes,
        1n,
        lease,
      );
      await this.requirePathAbsent(pendingPath, lease);
      await this.faultInjector?.hit("after-idempotent-final-revalidation");
      await this.requireExactLinkedIdentity(handle, [finalPath], expectedBytes, 1n, lease);
      await this.requirePathAbsent(pendingPath, lease);
    } catch (error) {
      failure = error instanceof ToolError ? error : persistenceFailure();
    }
    try {
      await handle?.close();
    } catch {
      failure ??= persistenceFailure();
    }
    if (failure !== undefined) throw failure;
  }

  private destinationExists(error: unknown): boolean {
    return (typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST") ||
      (error instanceof WindowsWriteThroughMoveError && error.reason === "exists");
  }

  private async requirePathAbsent(path: string, lease: ProcessLockLease): Promise<void> {
    try {
      lease.assertHeld();
      await lstat(path, { bigint: true });
      throw securityFailure();
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw securityFailure();
    }
  }

  private async openExactMovedFile(
    path: string,
    absentPath: string,
    priorIdentity: BigIntStats,
    expected: Buffer,
    lease: ProcessLockLease,
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    try {
      lease.assertHeld();
      await this.requirePathAbsent(absentPath, lease);
      const pathBefore = await lstat(path, { bigint: true });
      if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1n ||
          !sameMovedFile(priorIdentity, pathBefore)) {
        throw securityFailure();
      }
      handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      await this.requireExactLinkedIdentity(handle, [path], expected, 1n, lease);
      await this.requirePathAbsent(absentPath, lease);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }

  private async prepareDurableFile(
    path: string,
    expected: Buffer,
    lease: ProcessLockLease,
    hooks: DurableFileHooks,
  ): Promise<FileHandle> {
    let handle: FileHandle | undefined;
    let created = false;
    try {
      lease.assertHeld();
      try {
        handle = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
          0o600,
        );
        created = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw persistenceFailure();
        let pathBefore: BigIntStats;
        try {
          pathBefore = await lstat(path, { bigint: true });
          if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1n ||
              pathBefore.size > BigInt(expected.length)) {
            throw securityFailure();
          }
          handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
          const opened = await handle.stat({ bigint: true });
          if (!sameIdentity(pathBefore, opened)) throw securityFailure();
        } catch (openError) {
          if (openError instanceof ToolError) throw openError;
          throw securityFailure();
        }
      }
      if (created) {
        const createdIdentity = await handle.stat({ bigint: true });
        if (!createdIdentity.isFile() || createdIdentity.isSymbolicLink() ||
            createdIdentity.nlink !== 1n || createdIdentity.size !== 0n) {
          throw securityFailure();
        }
        if (hooks.afterCreate !== undefined) await this.faultInjector?.hit(hooks.afterCreate);
      }
      if (hooks.afterOpen !== undefined) await this.faultInjector?.hit(hooks.afterOpen);
      lease.assertHeld();
      const before = await handle.stat({ bigint: true });
      const pathBefore = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n ||
          before.size > BigInt(expected.length) || pathBefore.isSymbolicLink() ||
          !sameIdentity(before, pathBefore)) {
        throw securityFailure();
      }
      const prefixSize = Number(before.size);
      const actual = Buffer.alloc(prefixSize + 1);
      let offset = 0;
      while (offset < actual.length) {
        const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      const pathAfter = await lstat(path, { bigint: true });
      if (offset !== prefixSize || !actual.subarray(0, offset).equals(expected.subarray(0, offset)) ||
          !sameIdentity(before, after) || pathAfter.isSymbolicLink() ||
          !sameIdentity(before, pathAfter)) {
        throw securityFailure();
      }
      let position = prefixSize;
      while (position < expected.length) {
        const { bytesWritten } = await handle.write(
          expected,
          position,
          expected.length - position,
          position,
        );
        if (bytesWritten < 1) throw persistenceFailure();
        position += bytesWritten;
      }
      if (hooks.beforeSync !== undefined) await this.faultInjector?.hit(hooks.beforeSync);
      lease.assertHeld();
      if (process.platform !== "win32") await handle.chmod(0o600);
      await handle.sync();
      await this.requireExactLinkedIdentity(handle, [path], expected, 1n, lease);
      return handle;
    } catch (error) {
      await handle?.close().catch(() => undefined);
      throw error;
    }
  }

  private async requireExactLinkedIdentity(
    handle: FileHandle,
    paths: readonly string[],
    expected: Buffer,
    expectedLinks: bigint,
    lease: ProcessLockLease,
  ): Promise<BigIntStats> {
    try {
      lease.assertHeld();
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks ||
          before.size !== BigInt(expected.length)) {
        throw securityFailure();
      }
      for (const path of paths) {
        const pathBefore = await lstat(path, { bigint: true });
        if (pathBefore.isSymbolicLink() || !sameIdentity(before, pathBefore)) throw securityFailure();
      }
      const actual = Buffer.alloc(expected.length + 1);
      let offset = 0;
      while (offset < actual.length) {
        const { bytesRead } = await handle.read(actual, offset, actual.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat({ bigint: true });
      if (offset !== expected.length || !actual.subarray(0, offset).equals(expected) ||
          !sameIdentity(before, after)) {
        throw securityFailure();
      }
      for (const path of paths) {
        const pathAfter = await lstat(path, { bigint: true });
        if (pathAfter.isSymbolicLink() || !sameIdentity(after, pathAfter)) throw securityFailure();
      }
      lease.assertHeld();
      return after;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }

  private async preserveCorruptEvidence(
    path: string,
    expected: BigIntStats,
    lease: ProcessLockLease,
  ): Promise<void> {
    lease.assertHeld();
    let current: BigIntStats;
    try {
      current = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    if (!sameIdentity(expected, current)) return;
    await this.faultInjector?.hit("before-corrupt-evidence");
    lease.assertHeld();
    try {
      current = await lstat(path, { bigint: true });
    } catch {
      return;
    }
    if (!sameIdentity(expected, current)) return;
    const evidence = Object.freeze({
      evidenceVersion: 1,
      sourceName: basename(path),
      reason: "receipt-state-invalid",
      observed: Object.freeze({
        type: itemType(expected),
        dev: expected.dev.toString(),
        ino: expected.ino.toString(),
        size: expected.size.toString(),
        nlink: expected.nlink.toString(),
        mtimeNs: expected.mtimeNs.toString(),
        ctimeNs: expected.ctimeNs.toString(),
      }),
    });
    const serialized = `${canonicalizeJson(evidence)}\n`;
    const evidenceName = `${basename(path)}.corrupt.${sha256CanonicalJson(evidence)}.json`;
    const evidencePath = resolve(
      this.receiptDirectory,
      evidenceName,
    );
    let evidenceExists: boolean;
    try {
      lease.assertHeld();
      await lstat(evidencePath, { bigint: true });
      evidenceExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw securityFailure();
      evidenceExists = false;
    }
    if (!evidenceExists && !await this.hasEvidenceCapacity(lease)) return;
    let handle: FileHandle | undefined;
    try {
      handle = await this.prepareDurableFile(
        evidencePath,
        Buffer.from(serialized, "utf8"),
        lease,
        { afterCreate: "after-evidence-create-open" },
      );
      await handle.close();
      handle = undefined;
      lease.assertHeld();
      await syncDirectory(this.receiptDirectory);
    } catch {
      await handle?.close().catch(() => undefined);
      throw securityFailure();
    }
  }

  private async hasEvidenceCapacity(
    lease: ProcessLockLease,
  ): Promise<boolean> {
    let scanned = 0;
    let evidenceCount = 0;
    try {
      lease.assertHeld();
      const directory = await opendir(this.receiptDirectory);
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_DIRECTORY_ENTRIES_SCANNED) throw securityFailure();
        if (CORRUPT_EVIDENCE_NAME.test(entry.name)) {
          evidenceCount += 1;
          if (evidenceCount >= MAX_CORRUPT_EVIDENCE_FILES) return false;
        }
        if (scanned % 32 === 0) lease.assertHeld();
      }
      lease.assertHeld();
      return true;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }

  private async readRecord(
    finalPath: string,
    pendingPath: string,
    expectedLocator: VerificationReceiptLocator,
    lease: ProcessLockLease,
  ): Promise<VerificationReceiptRecord | null> {
    lease.assertHeld();
    let finalBefore: BigIntStats;
    try {
      finalBefore = await lstat(finalPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw securityFailure();
    }
    const expectedLinks = this.publisher.strategy === "hard-link" ? 2n : 1n;
    let pendingBefore: BigIntStats | undefined;
    try {
      if (this.publisher.strategy === "hard-link") {
        pendingBefore = await lstat(pendingPath, { bigint: true });
      } else {
        await this.requirePathAbsent(pendingPath, lease);
      }
    } catch {
      await this.preserveCorruptEvidence(finalPath, finalBefore, lease);
      throw securityFailure();
    }
    if (finalBefore.isSymbolicLink() || !finalBefore.isFile() || finalBefore.nlink !== expectedLinks ||
        finalBefore.size < 1n || finalBefore.size > BigInt(MAX_RECEIPT_BYTES) ||
        (pendingBefore !== undefined &&
          (pendingBefore.isSymbolicLink() || !sameIdentity(finalBefore, pendingBefore)))) {
      await this.preserveCorruptEvidence(finalPath, finalBefore, lease);
      throw securityFailure();
    }
    let handle: FileHandle | undefined;
    let failure: unknown;
    let result: VerificationReceiptRecord | undefined;
    try {
      handle = await open(finalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      await this.faultInjector?.hit("after-read-open");
      lease.assertHeld();
      const before = await handle.stat({ bigint: true });
      const finalAtOpen = await lstat(finalPath, { bigint: true });
      let pendingAtOpen: BigIntStats | undefined;
      if (this.publisher.strategy === "hard-link") {
        pendingAtOpen = await lstat(pendingPath, { bigint: true });
      } else {
        await this.requirePathAbsent(pendingPath, lease);
      }
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== expectedLinks ||
          !sameIdentity(before, finalBefore) || finalAtOpen.isSymbolicLink() ||
          !sameIdentity(before, finalAtOpen) ||
          (pendingAtOpen !== undefined &&
            (pendingAtOpen.isSymbolicLink() || !sameIdentity(before, pendingAtOpen)))) {
        throw securityFailure();
      }
      const expectedSize = Number(before.size);
      const bytes = Buffer.alloc(expectedSize + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== expectedSize) throw securityFailure();
      const after = await handle.stat({ bigint: true });
      const finalAfter = await lstat(finalPath, { bigint: true });
      let pendingAfter: BigIntStats | undefined;
      if (this.publisher.strategy === "hard-link") {
        pendingAfter = await lstat(pendingPath, { bigint: true });
      } else {
        await this.requirePathAbsent(pendingPath, lease);
      }
      if (!after.isFile() || after.nlink !== expectedLinks || !sameIdentity(before, after) ||
          finalAfter.isSymbolicLink() || !sameIdentity(before, finalAfter) ||
          (pendingAfter !== undefined &&
            (pendingAfter.isSymbolicLink() || !sameIdentity(before, pendingAfter)))) {
        throw securityFailure();
      }
      let serialized: string;
      try {
        serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, expectedSize));
      } catch {
        throw securityFailure();
      }
      let parsed: JsonValue;
      try {
        parsed = parseStrictJson(serialized);
      } catch {
        throw securityFailure();
      }
      if (`${canonicalizeJson(parsed)}\n` !== serialized || CREDENTIAL_SHAPE.test(serialized)) {
        throw securityFailure();
      }
      const input = recordValue(parsed);
      if (!exactFields(input, RECORD_FIELDS) || input.storeVersion !== STORE_VERSION) throw securityFailure();
      const storedLocator = normalizeLocator(input.locator);
      const validated = locatorFromReceipt(input.receipt);
      if (!sameLocator(storedLocator, expectedLocator) || !sameLocator(validated.locator, expectedLocator)) {
        throw securityFailure();
      }
      result = Object.freeze({
        storeVersion: STORE_VERSION,
        locator: storedLocator,
        receipt: validated.receipt,
      });
    } catch (error) {
      failure = error;
    }
    try {
      await handle?.close();
      handle = undefined;
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      await this.preserveCorruptEvidence(finalPath, finalBefore, lease);
      throw securityFailure();
    }
    if (result === undefined) throw securityFailure();
    return result;
  }

  async stageAuthenticated(receiptValue: VerificationReceiptV1): Promise<void> {
    const { locator, receipt } = locatorFromReceipt(receiptValue);
    const record: VerificationReceiptRecord = Object.freeze({
      storeVersion: STORE_VERSION,
      locator,
      receipt,
    });
    const serialized = serializeRecord(record);
    await this.locked(async (lease) => this.writeRecord(
      this.pathFor(locator),
      this.pendingPathFor(locator),
      record,
      serialized,
      lease,
    ));
  }

  async loadVerified(locatorValue: VerificationReceiptLocator): Promise<TrustedVerificationReceiptLoad | null> {
    const locator = normalizeLocator(locatorValue);
    return this.locked(async (lease) => {
      const record = await this.readRecord(
        this.pathFor(locator),
        this.pendingPathFor(locator),
        locator,
        lease,
      );
      if (record === null) return null;
      return Object.freeze({ trusted: true, receipt: record.receipt });
    });
  }
}
