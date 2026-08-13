import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";
import type { BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

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
} from "../platform/state-path.ts";
import {
  CANDIDATE_CONTEXT_TTL_MS,
  CONTEXT_STORE_VERSION,
  type Candidate,
  type CandidateKind,
  type ContextBinding,
  type ContextStoreDocument,
  type IssueContextInput,
  type IssuedContext,
  type PersistedCandidate,
  type PersistedContext,
  type ResolveContextInput,
  type ResolvedContext,
} from "./types.ts";
import {
  assertContextId,
  candidateTokenDigest,
  contextIdDigest,
  issueCandidateToken,
  issueContextId,
  systemTokenRandomSource,
  type TokenRandomSource,
} from "./tokens.ts";

const STORE_NAME = "candidate-contexts-v1.json";
const LOCK_NAME = "candidate-contexts-v1.lock";
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const MAX_STORE_BYTES = 16 * 1024 * 1024;
const MAX_COLLISION_ATTEMPTS = 8;
const RAW_BEARER = /(?:hmrc1_|hmrx1_)[A-Za-z0-9_-]{43}/u;
const INCOMPLETE_LOCK_GRACE_MS = 1_000;

interface LockLease {
  readonly nonce: string;
  readonly pid: number;
  release(): Promise<void>;
}

export interface ContextStoreFaultInjector {
  hit(
    point: "after-lock-directory-create" | "before-replace" | "after-lock-release-rename" |
      "before-incomplete-lock-isolation" | "after-store-open" | "before-store-quarantine" |
      "after-parent-sync",
  ): Promise<void> | void;
}

export interface ContextClock {
  now(): number;
}

export interface ContextRandomSource extends TokenRandomSource {}

export interface CandidateContextStoreOptions {
  readonly stateDirectory: string;
  readonly clock?: ContextClock;
  readonly random?: ContextRandomSource;
  readonly lockTimeoutMs?: number;
  readonly faultInjector?: ContextStoreFaultInjector;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

const systemClock: ContextClock = { now: () => Date.now() };

function contextInputError(reason: string, field = "contextId"): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", reason, {
    field,
    expected: "an unexpired CLI-issued context with matching scope",
    actual: "context or candidate validation failed",
    safeNextStep: "Run context again and retry with the newly issued values.",
  });
}

function internalError(reason: string): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", reason, {
    field: null,
    expected: "a locked, valid, private candidate context store",
    actual: "local context state is unavailable",
    safeNextStep: "Retry the command; inspect the quarantined state file if the problem persists.",
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function exactFields(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((field, index) => field === sorted[index]);
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function nonEmpty(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() && !/[\r\n\u2028\u2029]/u.test(value);
}

function validPositiveInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function normalizeBinding(bindingValue: ContextBinding): ContextBinding {
  const binding = copyJsonValue(bindingValue) as unknown as ContextBinding;
  const bindingRecord = binding as unknown as JsonObject;
  const projectRecord = binding.targetProject as unknown as JsonObject;
  const bundleRecord = binding.bundle as unknown as JsonObject;
  const protocolsRecord = binding.protocols as unknown as JsonObject;
  if (!exactFields(bindingRecord, [
    "operation", "gitlabOrigin", "targetProject", "targetBranch", "sourceHeadSha",
    "mrIid", "releaseSetId", "cliVersion", "bundle", "protocols",
  ]) || !exactFields(projectRecord, ["id", "fullPath"]) ||
      !exactFields(bundleRecord, ["id", "version", "releaseTag", "manifestHash"]) ||
      !exactFields(protocolsRecord, ["inputSchema", "policySchema", "skillProtocol"])) {
    throw contextInputError("Candidate context scope is invalid");
  }
  let origin: URL;
  try {
    origin = new URL(binding.gitlabOrigin);
  } catch {
    throw contextInputError("Candidate context scope is invalid", "gitlabOrigin");
  }
  if (
    !["https:", "http:"].includes(origin.protocol) ||
    origin.username !== "" || origin.password !== "" ||
    origin.pathname !== "/" || origin.search !== "" || origin.hash !== ""
  ) {
    throw contextInputError("Candidate context scope is invalid", "gitlabOrigin");
  }
  if (!["create", "update", "migrate"].includes(binding.operation) ||
      !nonEmpty(binding.targetProject.id) || !nonEmpty(binding.targetProject.fullPath) ||
      !nonEmpty(binding.targetBranch) || !SHA.test(binding.sourceHeadSha) ||
      !nonEmpty(binding.releaseSetId) || !nonEmpty(binding.cliVersion) ||
      !nonEmpty(binding.bundle.id) || !nonEmpty(binding.bundle.version) ||
      !nonEmpty(binding.bundle.releaseTag) || !SHA256.test(binding.bundle.manifestHash) ||
      !validPositiveInteger(binding.protocols.inputSchema) ||
      !validPositiveInteger(binding.protocols.policySchema) ||
      (binding.protocols.skillProtocol !== null && !validPositiveInteger(binding.protocols.skillProtocol)) ||
      (binding.operation === "create" ? binding.mrIid !== null : !validPositiveInteger(binding.mrIid))) {
    throw contextInputError("Candidate context scope is invalid");
  }
  return { ...binding, gitlabOrigin: origin.origin };
}

function validCandidate(candidateValue: Candidate): Candidate {
  const candidate = copyJsonValue(candidateValue) as unknown as Candidate;
  if (candidate.kind === "label") {
    if (!exactFields(candidate as unknown as JsonObject, [
      "kind", "restId", "globalId", "name", "description", "color", "scopeKind",
      "scopeId", "scopePath", "policyCategory",
    ]) || !validPositiveInteger(candidate.restId) || !nonEmpty(candidate.globalId) ||
        !nonEmpty(candidate.name) || typeof candidate.description !== "string" ||
        !nonEmpty(candidate.color) || !["project", "group"].includes(candidate.scopeKind) ||
        !nonEmpty(candidate.scopeId) || !nonEmpty(candidate.scopePath) ||
        !nonEmpty(candidate.policyCategory)) {
      throw contextInputError("Candidate metadata is invalid", "candidates");
    }
  } else if (candidate.kind === "assignee" || candidate.kind === "reviewer") {
    if (!exactFields(candidate as unknown as JsonObject, [
      "kind", "userId", "globalId", "username", "displayName",
    ]) || !nonEmpty(candidate.userId) ||
        (candidate.globalId !== null && !nonEmpty(candidate.globalId)) ||
        !nonEmpty(candidate.username) || !nonEmpty(candidate.displayName)) {
      throw contextInputError("Candidate metadata is invalid", "candidates");
    }
  } else {
    throw contextInputError("Candidate metadata is invalid", "candidates");
  }
  return candidate;
}

function assertTokenlessSnapshot(value: JsonValue): void {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string" && RAW_BEARER.test(current)) {
      throw contextInputError("External context must be a tokenless snapshot", "snapshot");
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      pending.push(...Object.keys(current), ...Object.values(current));
    }
  }
}

function containsRawBearer(value: JsonValue): boolean {
  const pending: JsonValue[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === "string" && RAW_BEARER.test(current)) {
      return true;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      pending.push(...Object.keys(current), ...Object.values(current));
    }
  }
  return false;
}

function digestMatches(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateDocument(value: JsonValue): ContextStoreDocument {
  if (containsRawBearer(value)) {
    throw internalError("Candidate context store is corrupt");
  }
  const root = record(value);
  if (root === undefined || !exactFields(root, ["storeVersion", "contexts"]) ||
      root.storeVersion !== CONTEXT_STORE_VERSION || !Array.isArray(root.contexts)) {
    throw internalError("Candidate context store is corrupt");
  }
  const contextIdDigests = new Set<string>();
  const tokenDigests = new Set<string>();
  const contexts: PersistedContext[] = [];
  for (const contextValue of root.contexts) {
    const context = record(contextValue);
    if (context === undefined || !exactFields(context, [
      "contextIdDigest", "createdAtMs", "expiresAtMs", "binding", "externalSnapshotDigest",
      "snapshot", "candidates",
    ]) || !SHA256.test(context.contextIdDigest as string) || !Number.isSafeInteger(context.createdAtMs) ||
        !Number.isSafeInteger(context.expiresAtMs) ||
        (context.expiresAtMs as number) - (context.createdAtMs as number) !== CANDIDATE_CONTEXT_TTL_MS ||
        !SHA256.test(context.externalSnapshotDigest as string) || !Array.isArray(context.candidates)) {
      throw internalError("Candidate context store is corrupt");
    }
    if (contextIdDigests.has(context.contextIdDigest as string)) {
      throw internalError("Candidate context store is corrupt");
    }
    contextIdDigests.add(context.contextIdDigest as string);
    let binding: ContextBinding;
    try {
      binding = normalizeBinding(context.binding as unknown as ContextBinding);
    } catch {
      throw internalError("Candidate context store is corrupt");
    }
    const snapshot = copyJsonValue(context.snapshot);
    if (!digestMatches(context.externalSnapshotDigest as string, sha256CanonicalJson(snapshot))) {
      throw internalError("Candidate context store is corrupt");
    }
    const candidates: PersistedCandidate[] = [];
    for (const candidateValue of context.candidates) {
      const candidate = record(candidateValue);
      if (candidate === undefined || !exactFields(candidate, ["tokenDigest", "kind", "consumedAtMs", "metadata"]) ||
          !SHA256.test(candidate.tokenDigest as string) ||
          !["label", "assignee", "reviewer"].includes(candidate.kind as string) ||
          (candidate.consumedAtMs !== null && !Number.isSafeInteger(candidate.consumedAtMs))) {
        throw internalError("Candidate context store is corrupt");
      }
      if (tokenDigests.has(candidate.tokenDigest as string)) {
        throw internalError("Candidate context store is corrupt");
      }
      tokenDigests.add(candidate.tokenDigest as string);
      let metadata: Candidate;
      try {
        metadata = validCandidate(candidate.metadata as unknown as Candidate);
      } catch {
        throw internalError("Candidate context store is corrupt");
      }
      if (metadata.kind !== candidate.kind) {
        throw internalError("Candidate context store is corrupt");
      }
      candidates.push({
        tokenDigest: candidate.tokenDigest as string,
        kind: candidate.kind as CandidateKind,
        consumedAtMs: candidate.consumedAtMs as number | null,
        metadata,
      });
    }
    contexts.push({
      contextIdDigest: context.contextIdDigest as string,
      createdAtMs: context.createdAtMs as number,
      expiresAtMs: context.expiresAtMs as number,
      binding,
      externalSnapshotDigest: context.externalSnapshotDigest as string,
      snapshot,
      candidates,
    });
  }
  return { storeVersion: CONTEXT_STORE_VERSION, contexts };
}

export class CandidateContextStore {
  readonly path: string;
  private readonly lockPath: string;
  private readonly clock: ContextClock;
  private readonly random: ContextRandomSource;
  private readonly lockTimeoutMs: number;
  private readonly faultInjector: ContextStoreFaultInjector | undefined;
  private readonly windowsAclVerifier: WindowsAclVerifier | undefined;

  constructor(options: CandidateContextStoreOptions) {
    this.path = resolve(options.stateDirectory, STORE_NAME);
    this.lockPath = resolve(options.stateDirectory, LOCK_NAME);
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemTokenRandomSource;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.faultInjector = options.faultInjector;
    this.windowsAclVerifier = options.windowsAclVerifier;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new TypeError("lockTimeoutMs must be a positive integer");
    }
  }

  private lockOwnerPath(): string {
    return resolve(this.lockPath, "owner.json");
  }

  private async readLockOwnerAt(lockPath: string): Promise<{ readonly nonce: string; readonly pid: number } | undefined> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(resolve(lockPath, "owner.json"), "r");
      const value = JSON.parse(await handle.readFile("utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const owner = value as Record<string, unknown>;
      if (Object.keys(owner).sort().join(",") !== "lockVersion,nonce,pid" ||
          owner.lockVersion !== 1 || typeof owner.nonce !== "string" ||
          !/^[A-Za-z0-9_-]+$/u.test(owner.nonce) ||
          !Number.isSafeInteger(owner.pid) || (owner.pid as number) < 1) {
        return undefined;
      }
      return { nonce: owner.nonce, pid: owner.pid as number };
    } catch {
      return undefined;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private readLockOwner(): Promise<{ readonly nonce: string; readonly pid: number } | undefined> {
    return this.readLockOwnerAt(this.lockPath);
  }

  private processIsAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  }

  private sameLockOwner(
    left: { readonly nonce: string; readonly pid: number } | undefined,
    right: { readonly nonce: string; readonly pid: number },
  ): boolean {
    return left?.nonce === right.nonce && left.pid === right.pid;
  }

  private async isolateLock(
    suffix: string,
    expectedOwner: { readonly nonce: string; readonly pid: number },
  ): Promise<string | undefined> {
    const isolatedPath = `${this.lockPath}.${suffix}.${process.pid}.${randomBytes(12).toString("base64url")}`;
    try {
      await rename(this.lockPath, isolatedPath);
    } catch (error) {
      if (["ENOENT", "EEXIST", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        return undefined;
      }
      throw error;
    }
    if (this.sameLockOwner(await this.readLockOwnerAt(isolatedPath), expectedOwner)) {
      return isolatedPath;
    }
    await rename(isolatedPath, this.lockPath).catch(() => undefined);
    return undefined;
  }

  private async assertLockOwner(lease: LockLease): Promise<void> {
    const owner = await this.readLockOwner();
    if (owner === undefined || owner.nonce !== lease.nonce || owner.pid !== lease.pid) {
      throw internalError("Candidate context lock ownership was lost; fenced writer cannot persist");
    }
  }

  private async acquireLock(): Promise<LockLease> {
    await ensurePrivateStateDirectory(resolve(this.path, ".."), {
      ...(this.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: this.windowsAclVerifier }),
    });
    const started = Date.now();
    for (;;) {
      const nonce = randomBytes(24).toString("base64url");
      let createdLockDirectory = false;
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        createdLockDirectory = true;
        await this.faultInjector?.hit("after-lock-directory-create");
        await writeFile(this.lockOwnerPath(), JSON.stringify({
          lockVersion: 1,
          nonce,
          pid: process.pid,
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        return {
          nonce,
          pid: process.pid,
          release: async () => {
            const expectedOwner = { nonce, pid: process.pid };
            for (;;) {
              const owner = await this.readLockOwner();
              if (!this.sameLockOwner(owner, expectedOwner)) return;
              const isolatedPath = await this.isolateLock("released", expectedOwner);
              if (isolatedPath !== undefined) {
                await this.faultInjector?.hit("after-lock-release-rename");
                await rm(isolatedPath, { recursive: true, force: true });
                return;
              }
              await sleep(5);
            }
          },
        };
      } catch (error) {
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (createdLockDirectory) {
          // Leave an incomplete lock for grace-based atomic recovery; the stable path may have been replaced.
          throw internalError("Candidate context lock cannot be acquired");
        }
        if (errorCode !== "EEXIST") {
          if (process.platform === "win32" && ["EACCES", "ENOENT", "EPERM"].includes(errorCode ?? "") &&
              Date.now() - started < this.lockTimeoutMs) {
            await sleep(5);
            continue;
          }
          throw internalError("Candidate context lock cannot be acquired");
        }
        let lockInfo;
        try {
          lockInfo = await lstat(this.lockPath);
        } catch {
          continue;
        }
        if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
          throw internalError("Candidate context lock is unsafe");
        }
        const owner = await this.readLockOwner();
        if (owner !== undefined && !this.processIsAlive(owner.pid)) {
          try {
            const stalePath = await this.isolateLock("stale", owner);
            if (stalePath === undefined) {
              await sleep(5);
              continue;
            }
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (takeoverError) {
            if (["ENOENT", "EEXIST", "EPERM"].includes((takeoverError as NodeJS.ErrnoException).code ?? "")) {
              await sleep(5);
              continue;
            }
            throw internalError("Orphaned candidate context lock cannot be safely recovered");
          }
        }
        if (owner === undefined && Date.now() - lockInfo.mtimeMs >= INCOMPLETE_LOCK_GRACE_MS) {
          try {
            const stalePath = `${this.lockPath}.stale.${process.pid}.${nonce}`;
            await this.faultInjector?.hit("before-incomplete-lock-isolation");
            await rename(this.lockPath, stalePath);
            if (await this.readLockOwnerAt(stalePath) !== undefined) {
              await rename(stalePath, this.lockPath).catch(() => undefined);
              await sleep(5);
              continue;
            }
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (takeoverError) {
            if (["ENOENT", "EEXIST", "EPERM"].includes((takeoverError as NodeJS.ErrnoException).code ?? "")) {
              await sleep(5);
              continue;
            }
            throw internalError("Incomplete candidate context lock cannot be safely recovered");
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw internalError("Candidate context lock timed out");
        }
        await sleep(5);
      }
    }
  }

  private sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
    return left.dev === right.dev && left.ino === right.ino;
  }

  private async quarantine(expected?: BigIntStats): Promise<void> {
    const name = `${basename(this.path)}.corrupt.${String(Date.now())}.${process.pid}`;
    const quarantinePath = resolve(this.path, "..", name);
    try {
      await this.faultInjector?.hit("before-store-quarantine");
      await rename(this.path, quarantinePath);
      if (expected !== undefined) {
        const current = await lstat(quarantinePath, { bigint: true });
        if (!this.sameFileIdentity(expected, current)) {
          await rename(quarantinePath, this.path).catch(() => undefined);
          throw internalError("Candidate context store changed before quarantine");
        }
      }
    } catch {
      throw internalError("Candidate context store is corrupt and cannot be quarantined");
    }
  }

  private async readDocument(): Promise<ContextStoreDocument> {
    let handle: FileHandle | undefined;
    let openedIdentity: BigIntStats | undefined;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { storeVersion: CONTEXT_STORE_VERSION, contexts: [] };
      }
      throw internalError("Candidate context store cannot be opened");
    }
    let failure: unknown;
    let document: ContextStoreDocument | undefined;
    try {
      const before = await handle.stat({ bigint: true });
      openedIdentity = before;
      if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_STORE_BYTES)) {
        throw internalError("Candidate context store is corrupt");
      }
      await this.faultInjector?.hit("after-store-open");
      const expectedSize = Number(before.size);
      const bytes = Buffer.alloc(expectedSize);
      let offset = 0;
      while (offset < expectedSize) {
        const result = await handle.read(bytes, offset, expectedSize - offset, offset);
        if (result.bytesRead < 1 || result.bytesRead > expectedSize - offset) {
          throw internalError("Candidate context store changed size while reading");
        }
        offset += result.bytesRead;
      }
      const extra = Buffer.alloc(1);
      if ((await handle.read(extra, 0, 1, offset)).bytesRead !== 0) {
        throw internalError("Candidate context store changed size while reading");
      }
      const after = await handle.stat({ bigint: true });
      if (!after.isFile() || after.size !== before.size || !this.sameFileIdentity(before, after)) {
        throw internalError("Candidate context store changed identity while reading");
      }
      const pathInfo = await lstat(this.path, { bigint: true });
      if (pathInfo.isSymbolicLink() || !this.sameFileIdentity(before, pathInfo)) {
        throw internalError("Candidate context store path changed while reading");
      }
      document = validateDocument(parseStrictJson(bytes.toString("utf8")));
    } catch (error) {
      failure = error;
    }
    try {
      await handle.close();
      handle = undefined;
    } catch {
      failure ??= internalError("Candidate context store handle cannot be closed safely");
    }
    if (failure !== undefined) {
      await this.quarantine(openedIdentity);
      throw internalError("Candidate context store is corrupt");
    }
    if (document === undefined) {
      throw internalError("Candidate context store could not be read safely");
    }
    return document;
  }

  private assertDocumentHasNoRawBearer(document: ContextStoreDocument): void {
    if (containsRawBearer(document as unknown as JsonValue)) {
      throw contextInputError("Candidate context document contains a raw bearer value", "context");
    }
  }

  private async writeDocument(document: ContextStoreDocument, lease: LockLease): Promise<void> {
    this.assertDocumentHasNoRawBearer(document);
    const serialized = `${canonicalizeJson(document)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_STORE_BYTES) {
      throw internalError("Candidate context store exceeds its size limit");
    }
    const temporaryPath = `${this.path}.tmp.${process.pid}.${Date.now().toString(36)}`;
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (process.platform !== "win32") {
        await chmod(temporaryPath, 0o600);
      }
      await this.faultInjector?.hit("before-replace");
      await this.assertLockOwner(lease);
      await rename(temporaryPath, this.path);
      if (process.platform !== "win32") {
        const parent = await open(resolve(this.path, ".."), "r");
        let parentFailure: unknown;
        try {
          await parent.sync();
          await this.faultInjector?.hit("after-parent-sync");
        } catch (error) {
          parentFailure = error;
        }
        try {
          await parent.close();
        } catch (error) {
          parentFailure ??= error;
        }
        if (parentFailure !== undefined) throw parentFailure;
      }
    } catch {
      if (handle !== undefined) {
        await handle.close().catch(() => undefined);
      }
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw internalError("Candidate context store cannot be atomically persisted");
    }
  }

  private async locked<T>(operation: (lease: LockLease) => Promise<T>): Promise<T> {
    const lease = await this.acquireLock();
    try {
      return await operation(lease);
    } finally {
      await lease.release().catch(() => undefined);
    }
  }

  private uniqueContextId(document: ContextStoreDocument): string {
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const contextId = issueContextId(this.random);
      const digest = contextIdDigest(contextId);
      if (!document.contexts.some((context) => digestMatches(context.contextIdDigest, digest))) {
        return contextId;
      }
    }
    throw internalError("Secure random context ID collision limit exceeded");
  }

  private uniqueCandidateToken(document: ContextStoreDocument, pending: ReadonlySet<string>): string {
    const existing = new Set(document.contexts.flatMap((context) => context.candidates.map((candidate) => candidate.tokenDigest)));
    for (let attempt = 0; attempt < MAX_COLLISION_ATTEMPTS; attempt += 1) {
      const token = issueCandidateToken(this.random);
      const digest = candidateTokenDigest(token);
      if (!existing.has(digest) && !pending.has(digest)) {
        return token;
      }
    }
    throw internalError("Secure random candidate token collision limit exceeded");
  }

  private now(requiredFutureMs = 0): number {
    const now = this.clock.now();
    if (!Number.isSafeInteger(now) || now < 0 ||
        !Number.isSafeInteger(requiredFutureMs) || requiredFutureMs < 0 ||
        now > Number.MAX_SAFE_INTEGER - requiredFutureMs) {
      throw internalError("Candidate context clock is invalid");
    }
    return now;
  }

  private selectionError(kind: CandidateKind, reason: string): ToolError<"LABEL_ERROR" | "INPUT_ERROR"> {
    if (kind === "label") {
      return new ToolError("LABEL_ERROR", reason, {
        field: "mergeRequest.labelCandidateTokens",
        expected: "an unexpired label candidate from the matching context",
        actual: "label candidate validation failed",
        safeNextStep: "Run context again and select a current label candidate.",
      });
    }
    return contextInputError(reason, kind === "assignee"
      ? "mergeRequest.assigneeCandidateToken"
      : "review.reviewerCandidateTokens");
  }

  async issue(inputValue: IssueContextInput): Promise<IssuedContext> {
    const input: IssueContextInput = {
      binding: normalizeBinding(inputValue.binding),
      snapshot: copyJsonValue(inputValue.snapshot),
      candidates: inputValue.candidates.map(validCandidate),
    };
    assertTokenlessSnapshot(input.snapshot);
    return this.locked(async (lease) => {
      const document = await this.readDocument();
      const now = this.now(CANDIDATE_CONTEXT_TTL_MS);
      const active = document.contexts.filter((context) => context.expiresAtMs > now);
      const activeDocument: ContextStoreDocument = { storeVersion: CONTEXT_STORE_VERSION, contexts: active };
      const contextId = this.uniqueContextId(activeDocument);
      const pendingDigests = new Set<string>();
      const issued = input.candidates.map((metadata) => {
        const token = this.uniqueCandidateToken(activeDocument, pendingDigests);
        pendingDigests.add(candidateTokenDigest(token));
        return { token, kind: metadata.kind, metadata };
      });
      const externalSnapshotDigest = sha256CanonicalJson(input.snapshot);
      const persisted: PersistedContext = {
        contextIdDigest: contextIdDigest(contextId),
        createdAtMs: now,
        expiresAtMs: now + CANDIDATE_CONTEXT_TTL_MS,
        binding: input.binding,
        externalSnapshotDigest,
        snapshot: input.snapshot,
        candidates: issued.map(({ token, kind, metadata }) => ({
          tokenDigest: candidateTokenDigest(token),
          kind,
          consumedAtMs: null,
          metadata,
        })),
      };
      await this.writeDocument({ storeVersion: CONTEXT_STORE_VERSION, contexts: [...active, persisted] }, lease);
      return {
        contextId,
        createdAtMs: now,
        expiresAtMs: now + CANDIDATE_CONTEXT_TTL_MS,
        externalSnapshotDigest,
        candidates: issued,
      };
    });
  }

  async resolve(input: ResolveContextInput): Promise<ResolvedContext> {
    assertContextId(input.contextId);
    const requestedContextDigest = contextIdDigest(input.contextId);
    const expectedBinding = normalizeBinding(input.expectedBinding);
    const selections = input.selections.map((selection) => {
      try {
        return { kind: selection.kind, digest: candidateTokenDigest(selection.token) };
      } catch {
        throw this.selectionError(selection.kind, "Invalid candidate token");
      }
    });
    if (new Set(selections.map((selection) => selection.digest)).size !== selections.length) {
      throw contextInputError("Candidate selection contains duplicates", "candidateTokens");
    }
    return this.locked(async (lease) => {
      const document = await this.readDocument();
      const now = this.now();
      const index = document.contexts.findIndex((context) =>
        digestMatches(context.contextIdDigest, requestedContextDigest));
      if (index < 0) {
        const active = document.contexts.filter((context) => context.expiresAtMs > now);
        if (active.length !== document.contexts.length) {
          await this.writeDocument({ storeVersion: CONTEXT_STORE_VERSION, contexts: active }, lease);
        }
        throw contextInputError("Candidate context is unknown");
      }
      const context = document.contexts[index];
      if (context === undefined) {
        throw internalError("Candidate context store lookup failed");
      }
      if (now < context.createdAtMs) {
        throw internalError("Candidate context clock moved backwards");
      }
      if (now >= context.expiresAtMs) {
        await this.writeDocument({
          storeVersion: CONTEXT_STORE_VERSION,
          contexts: document.contexts.filter((_, contextIndex) => contextIndex !== index && document.contexts[contextIndex]!.expiresAtMs > now),
        }, lease);
        throw contextInputError("Candidate context has expired");
      }
      if (canonicalizeJson(context.binding) !== canonicalizeJson(expectedBinding)) {
        throw contextInputError("Candidate context scope does not match the request");
      }
      const resolved: PersistedCandidate[] = [];
      for (const selection of selections) {
        const candidate = context.candidates.find((entry) => digestMatches(entry.tokenDigest, selection.digest));
        if (candidate === undefined) {
          throw this.selectionError(selection.kind, "Unknown candidate token");
        }
        if (candidate.kind !== selection.kind) {
          throw this.selectionError(selection.kind, "Candidate kind does not match the request");
        }
        if (candidate.consumedAtMs !== null) {
          throw this.selectionError(selection.kind, "Candidate token has already been consumed");
        }
        resolved.push(candidate);
      }
      if (input.consume === true && resolved.length > 0) {
        const selectedDigests = new Set(resolved.map((candidate) => candidate.tokenDigest));
        const updatedContext: PersistedContext = {
          ...context,
          candidates: context.candidates.map((candidate) => selectedDigests.has(candidate.tokenDigest)
            ? { ...candidate, consumedAtMs: now }
            : candidate),
        };
        await this.writeDocument({
          storeVersion: CONTEXT_STORE_VERSION,
          contexts: document.contexts.map((entry, contextIndex) => contextIndex === index ? updatedContext : entry),
        }, lease);
      }
      return {
        contextId: input.contextId,
        createdAtMs: context.createdAtMs,
        expiresAtMs: context.expiresAtMs,
        binding: context.binding,
        externalSnapshotDigest: context.externalSnapshotDigest,
        snapshot: copyJsonValue(context.snapshot),
        candidates: resolved.map((candidate) => copyJsonValue(candidate.metadata) as unknown as Candidate),
      };
    });
  }

  async cleanup(): Promise<number> {
    return this.locked(async (lease) => {
      const document = await this.readDocument();
      const now = this.now();
      const active = document.contexts.filter((context) => context.expiresAtMs > now);
      const removed = document.contexts.length - active.length;
      if (removed > 0) {
        await this.writeDocument({ storeVersion: CONTEXT_STORE_VERSION, contexts: active }, lease);
      }
      return removed;
    });
  }
}
