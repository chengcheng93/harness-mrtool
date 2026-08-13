import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import { ensurePrivateStateDirectory } from "../platform/state-path.ts";
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
const RAW_CANDIDATE_TOKEN = /^hmrc1_[A-Za-z0-9_-]{43}$/u;
const LOCK_LEASE_MS = 10_000;

interface LockLease {
  readonly nonce: string;
  release(): Promise<void>;
}

export interface ContextStoreFaultInjector {
  hit(point: "before-replace"): Promise<void> | void;
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
    if (typeof current === "string" && RAW_CANDIDATE_TOKEN.test(current)) {
      throw contextInputError("External context must be a tokenless snapshot", "snapshot");
    }
    if (Array.isArray(current)) {
      pending.push(...current);
    } else if (current !== null && typeof current === "object") {
      pending.push(...Object.values(current));
    }
  }
}

function digestMatches(left: string, right: string): boolean {
  if (!SHA256.test(left) || !SHA256.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateDocument(value: JsonValue): ContextStoreDocument {
  const root = record(value);
  if (root === undefined || !exactFields(root, ["storeVersion", "contexts"]) ||
      root.storeVersion !== CONTEXT_STORE_VERSION || !Array.isArray(root.contexts)) {
    throw internalError("Candidate context store is corrupt");
  }
  const contextIds = new Set<string>();
  const tokenDigests = new Set<string>();
  const contexts: PersistedContext[] = [];
  for (const contextValue of root.contexts) {
    const context = record(contextValue);
    if (context === undefined || !exactFields(context, [
      "contextId", "createdAtMs", "expiresAtMs", "binding", "externalSnapshotDigest",
      "snapshot", "candidates",
    ]) || !nonEmpty(context.contextId) || !Number.isSafeInteger(context.createdAtMs) ||
        !Number.isSafeInteger(context.expiresAtMs) ||
        (context.expiresAtMs as number) - (context.createdAtMs as number) !== CANDIDATE_CONTEXT_TTL_MS ||
        !SHA256.test(context.externalSnapshotDigest as string) || !Array.isArray(context.candidates)) {
      throw internalError("Candidate context store is corrupt");
    }
    try {
      assertContextId(context.contextId);
    } catch {
      throw internalError("Candidate context store is corrupt");
    }
    if (contextIds.has(context.contextId)) {
      throw internalError("Candidate context store is corrupt");
    }
    contextIds.add(context.contextId);
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
      contextId: context.contextId,
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

  constructor(options: CandidateContextStoreOptions) {
    this.path = resolve(options.stateDirectory, STORE_NAME);
    this.lockPath = resolve(options.stateDirectory, LOCK_NAME);
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemTokenRandomSource;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 2_000;
    this.faultInjector = options.faultInjector;
    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 1) {
      throw new TypeError("lockTimeoutMs must be a positive integer");
    }
  }

  private lockOwnerPath(): string {
    return resolve(this.lockPath, "owner.json");
  }

  private async readLockOwner(): Promise<{ readonly nonce: string; readonly expiresAtMs: number } | undefined> {
    try {
      const value = JSON.parse(await readFile(this.lockOwnerPath(), "utf8")) as unknown;
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        return undefined;
      }
      const owner = value as Record<string, unknown>;
      if (Object.keys(owner).sort().join(",") !== "expiresAtMs,lockVersion,nonce" ||
          owner.lockVersion !== 1 || typeof owner.nonce !== "string" ||
          !/^[A-Za-z0-9_-]+$/u.test(owner.nonce) || !Number.isSafeInteger(owner.expiresAtMs)) {
        return undefined;
      }
      return { nonce: owner.nonce, expiresAtMs: owner.expiresAtMs as number };
    } catch {
      return undefined;
    }
  }

  private async assertLockOwner(lease: LockLease): Promise<void> {
    const owner = await this.readLockOwner();
    if (owner === undefined || owner.nonce !== lease.nonce || owner.expiresAtMs <= Date.now()) {
      throw internalError("Candidate context lock ownership was lost; fenced writer cannot persist");
    }
  }

  private async acquireLock(): Promise<LockLease> {
    await ensurePrivateStateDirectory(resolve(this.path, ".."));
    const started = Date.now();
    for (;;) {
      const nonce = randomBytes(24).toString("base64url");
      try {
        await mkdir(this.lockPath, { mode: 0o700 });
        await writeFile(this.lockOwnerPath(), JSON.stringify({
          lockVersion: 1,
          nonce,
          expiresAtMs: Date.now() + LOCK_LEASE_MS,
        }), { encoding: "utf8", flag: "wx", mode: 0o600 });
        return {
          nonce,
          release: async () => {
            const owner = await this.readLockOwner();
            if (owner?.nonce === nonce) {
              await rm(this.lockPath, { recursive: true, force: true });
            }
          },
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          await rm(this.lockPath, { recursive: true, force: true }).catch(() => undefined);
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
        if (owner !== undefined && owner.expiresAtMs <= Date.now()) {
          const stalePath = `${this.lockPath}.stale.${process.pid}.${nonce}`;
          try {
            await rename(this.lockPath, stalePath);
            await rm(stalePath, { recursive: true, force: true });
            continue;
          } catch (takeoverError) {
            if (["ENOENT", "EEXIST", "EPERM"].includes((takeoverError as NodeJS.ErrnoException).code ?? "")) {
              await sleep(5);
              continue;
            }
            throw internalError("Expired candidate context lock cannot be safely recovered");
          }
        }
        if (Date.now() - started >= this.lockTimeoutMs) {
          throw internalError("Candidate context lock timed out");
        }
        await sleep(5);
      }
    }
  }

  private async quarantine(): Promise<void> {
    const name = `${basename(this.path)}.corrupt.${String(this.clock.now())}.${process.pid}`;
    try {
      await rename(this.path, resolve(this.path, "..", name));
    } catch {
      throw internalError("Candidate context store is corrupt and cannot be quarantined");
    }
  }

  private async readDocument(): Promise<ContextStoreDocument> {
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_STORE_BYTES) {
        await this.quarantine();
        throw internalError("Candidate context store is corrupt");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { storeVersion: CONTEXT_STORE_VERSION, contexts: [] };
      }
      if (error instanceof ToolError) {
        throw error;
      }
      throw internalError("Candidate context store cannot be inspected");
    }
    try {
      const text = await readFile(this.path, { encoding: "utf8", flag: "r" });
      return validateDocument(parseStrictJson(text));
    } catch {
      await this.quarantine();
      throw internalError("Candidate context store is corrupt");
    }
  }

  private async writeDocument(document: ContextStoreDocument, lease: LockLease): Promise<void> {
    const serialized = `${canonicalizeJson(document)}\n`;
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
      if (!document.contexts.some((context) => context.contextId === contextId)) {
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

  async issue(inputValue: IssueContextInput): Promise<IssuedContext> {
    const input: IssueContextInput = {
      binding: normalizeBinding(inputValue.binding),
      snapshot: copyJsonValue(inputValue.snapshot),
      candidates: inputValue.candidates.map(validCandidate),
    };
    assertTokenlessSnapshot(input.snapshot);
    return this.locked(async (lease) => {
      const document = await this.readDocument();
      const now = this.clock.now();
      if (!Number.isSafeInteger(now) || now < 0) {
        throw internalError("Candidate context clock is invalid");
      }
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
        contextId,
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
    const expectedBinding = normalizeBinding(input.expectedBinding);
    const selections = input.selections.map((selection) => ({
      kind: selection.kind,
      digest: candidateTokenDigest(selection.token),
    }));
    if (new Set(selections.map((selection) => selection.digest)).size !== selections.length) {
      throw contextInputError("Candidate selection contains duplicates", "candidateTokens");
    }
    return this.locked(async (lease) => {
      const document = await this.readDocument();
      const now = this.clock.now();
      const index = document.contexts.findIndex((context) => context.contextId === input.contextId);
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
          throw contextInputError("Unknown candidate token", "candidateTokens");
        }
        if (candidate.kind !== selection.kind) {
          throw contextInputError("Candidate kind does not match the request", "candidateTokens");
        }
        if (candidate.consumedAtMs !== null) {
          throw contextInputError("Candidate token has already been consumed", "candidateTokens");
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
        contextId: context.contextId,
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
      const now = this.clock.now();
      const active = document.contexts.filter((context) => context.expiresAtMs > now);
      const removed = document.contexts.length - active.length;
      if (removed > 0) {
        await this.writeDocument({ storeVersion: CONTEXT_STORE_VERSION, contexts: active }, lease);
      }
      return removed;
    });
  }
}
