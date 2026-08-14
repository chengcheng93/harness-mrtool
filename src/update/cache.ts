import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  opendir,
  realpath,
  rename,
  rm,
  lstat,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { lt } from "semver";

import { canonicalizeJson, copyJsonValue } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import {
  assertUpdateLockLease,
  withUpdateLock,
} from "../platform/lock.ts";
import type { ProcessLockLease, ProcessLockProvider } from "../platform/process-lock.ts";
import { isVerifiedChannelManifest, type VerifiedChannelManifest } from "./manifest.ts";
import { requireCanonicalSemVer, updateSecurityError } from "./envelope.ts";

/** Maximum canonical active-pointer bytes accepted from disk. */
export const MAX_CACHE_POINTER_BYTES = 64 * 1024;
/** The CLI asset cap is shared with the signed channel contract. */
export const MAX_CACHE_CLI_BYTES = 256 * 1024 * 1024;
/** The template bundle cap is shared with the signed channel contract. */
export const MAX_CACHE_TEMPLATE_BYTES = 32 * 1024 * 1024;
/** Signed receipt envelopes are bounded by the channel envelope cap. */
export const MAX_CACHE_RECEIPT_BYTES = 256 * 1024;

const CACHE_VERSION = 1 as const;
const RECORD_TYPE = "active-release-set" as const;
const ACTIVE_POINTER_NAME = "active-release-set.json";
const RELEASE_ROOT_NAME = "releases";
const CLI_NAME = "cli.bin";
const TEMPLATE_NAME = "template.bundle";
const RECEIPT_NAME = "bundle-receipt.envelope";
const STAGING_NAME = /^\.staging-[a-f0-9]{24}$/u;
const STALE_NAME = /^\.stale-[a-f0-9]{24}$/u;
const MAX_RELEASE_ROOT_ENTRIES = 4_096;
const SHA256 = /^[a-f0-9]{64}$/u;
const RELEASE_SET_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,126}[A-Za-z0-9])?$/u;
const TRANSACTION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/iu;

const RECORD_FIELDS = [
  "cacheVersion",
  "recordType",
  "releaseSetId",
  "cliVersion",
  "cliSha256",
  "templateVersion",
  "templateSha256",
  "manifestVersion",
  "inputSchema",
  "policySchema",
  "manifestSequence",
  "transactionId",
  "receiptSha256",
] as const;

const SNAPSHOT_FIELDS = ["record", "cliBytes", "templateBytes", "receiptBytes"] as const;
const RELEASE_FILES = [CLI_NAME, TEMPLATE_NAME, RECEIPT_NAME] as const;
const SORTED_RELEASE_FILES = [...RELEASE_FILES].sort();
const MAX_POLICY_ITEMS = 1_024;
const READ_ONLY_FLAGS = constants.O_RDONLY | ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
const verifiedSecurityViews = new WeakSet<object>();

type ReleaseFileName = (typeof RELEASE_FILES)[number];

export interface ReleaseSetRecord {
  readonly cacheVersion: 1;
  readonly recordType: "active-release-set";
  readonly releaseSetId: string;
  readonly cliVersion: string;
  readonly cliSha256: string;
  readonly templateVersion: string;
  readonly templateSha256: string;
  readonly manifestVersion: 1;
  readonly inputSchema: number;
  readonly policySchema: number;
  readonly manifestSequence: number;
  readonly transactionId: string;
  readonly receiptSha256: string;
}

export interface ReleaseSetSnapshot {
  readonly record: ReleaseSetRecord;
  readonly cliBytes: Uint8Array;
  readonly templateBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
}

export interface CacheFaultInjector {
  hit(point: string): void | Promise<void>;
}

export interface UpdateCacheOptions {
  readonly stateDirectory: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
  readonly faultInjector?: CacheFaultInjector;
  /** Required for any write; cryptographic verification belongs to the caller. */
  readonly verifySnapshot?: ReleaseSetSnapshotVerifier;
  /** Optional test/platform injection; production uses the system provider. */
  readonly lockProvider?: ProcessLockProvider;
  readonly lockTimeoutMs?: number;
}

export interface ReleaseSetSnapshotVerifier {
  verify(snapshot: ReleaseSetSnapshot): void | Promise<void>;
}

export interface VerifiedManifestSecurityView {
  readonly manifest: {
    readonly manifestVersion: 1;
    readonly sequence: number;
    readonly releaseSet: {
      readonly id: string;
      readonly cli: string;
      readonly templates: string;
    };
    readonly security: {
      readonly minimumAllowedCliVersion: string;
      readonly revokedCliVersions: readonly string[];
      readonly revokedReleaseSetIds: readonly string[];
    };
  };
}

export type VerifiedManifestInput = VerifiedChannelManifest | VerifiedManifestSecurityView;

export type WriteBlockReason =
  | "active-cli-version-below-minimum"
  | "active-cli-version-revoked"
  | "active-release-set-revoked";

export interface LoadedReleaseSet extends ReleaseSetSnapshot {
  readonly releaseDirectory: string;
  readonly cliPath: string;
  readonly templatePath: string;
  readonly receiptPath: string;
  readonly writesBlocked: boolean;
  readonly writeBlockReasons: readonly WriteBlockReason[];
}

export interface StoredReleaseSet extends LoadedReleaseSet {}

function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return updateSecurityError("envelope is invalid");
}

function fail(): never {
  throw securityFailure();
}

function hasExactOwnFields(value: object, fields: readonly string[]): boolean {
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return false;
  }
  return keys.every((key) => {
    const descriptor = descriptors[key];
    return descriptor !== undefined && descriptor.enumerable && "value" in descriptor &&
      descriptor.get === undefined && descriptor.set === undefined;
  });
}

function plainRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !hasExactOwnFields(value, fields)
  ) {
    return fail();
  }
  return value as Record<string, unknown>;
}

function boundedInteger(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail();
  }
  return value as number;
}

function strictSemver(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) return fail();
  try {
    return requireCanonicalSemVer(value);
  } catch {
    return fail();
  }
}

function safeDirectoryIdentifier(value: string): boolean {
  return !/[. ]$/u.test(value) && !WINDOWS_DEVICE_NAME.test(value);
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function bytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength === 0 || value.byteLength > maximum) {
    return fail();
  }
  return Uint8Array.from(value);
}

function verifierSnapshot(value: ReleaseSetSnapshot): ReleaseSetSnapshot {
  // Keep the verifier contract independent from cache implementation paths and
  // give it fresh byte views so a verifier cannot mutate the loaded result.
  return Object.freeze({
    record: value.record,
    cliBytes: Uint8Array.from(value.cliBytes),
    templateBytes: Uint8Array.from(value.templateBytes),
    receiptBytes: Uint8Array.from(value.receiptBytes),
  });
}

export function validateReleaseSetRecord(value: unknown): ReleaseSetRecord {
  const item = plainRecord(value, RECORD_FIELDS);
  if (
    item.cacheVersion !== CACHE_VERSION ||
    item.recordType !== RECORD_TYPE ||
    typeof item.releaseSetId !== "string" ||
    !RELEASE_SET_ID.test(item.releaseSetId) ||
    !safeDirectoryIdentifier(item.releaseSetId) ||
    typeof item.transactionId !== "string" ||
    !TRANSACTION_ID.test(item.transactionId) ||
    !safeDirectoryIdentifier(item.transactionId) ||
    typeof item.cliSha256 !== "string" ||
    !SHA256.test(item.cliSha256) ||
    typeof item.templateSha256 !== "string" ||
    !SHA256.test(item.templateSha256) ||
    typeof item.receiptSha256 !== "string" ||
    !SHA256.test(item.receiptSha256) ||
    item.manifestVersion !== 1
  ) {
    return fail();
  }
  const cliVersion = strictSemver(item.cliVersion);
  const templateVersion = strictSemver(item.templateVersion);
  const inputSchema = boundedInteger(item.inputSchema, 1, 1_024);
  const policySchema = boundedInteger(item.policySchema, 1, 1_024);
  const manifestSequence = boundedInteger(item.manifestSequence, 1, Number.MAX_SAFE_INTEGER);
  return Object.freeze({
    cacheVersion: CACHE_VERSION,
    recordType: RECORD_TYPE,
    releaseSetId: item.releaseSetId,
    cliVersion,
    cliSha256: item.cliSha256,
    templateVersion,
    templateSha256: item.templateSha256,
    manifestVersion: 1,
    inputSchema,
    policySchema,
    manifestSequence,
    transactionId: item.transactionId,
    receiptSha256: item.receiptSha256,
  });
}

function validateSnapshot(value: unknown): ReleaseSetSnapshot {
  const item = plainRecord(value, SNAPSHOT_FIELDS);
  const record = validateReleaseSetRecord(item.record);
  const cliBytes = bytes(item.cliBytes, MAX_CACHE_CLI_BYTES);
  const templateBytes = bytes(item.templateBytes, MAX_CACHE_TEMPLATE_BYTES);
  const receiptBytes = bytes(item.receiptBytes, MAX_CACHE_RECEIPT_BYTES);
  if (
    sha(cliBytes) !== record.cliSha256 ||
    sha(templateBytes) !== record.templateSha256 ||
    sha(receiptBytes) !== record.receiptSha256
  ) {
    return fail();
  }
  return Object.freeze({ record, cliBytes, templateBytes, receiptBytes });
}

function canonicalRecord(record: ReleaseSetRecord): string {
  try {
    return `${canonicalizeJson(record)}\n`;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return fail();
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath));
}

function safeChild(root: string, child: string): string {
  const path = resolve(root, child);
  if (!isWithin(root, path) || path === root) return fail();
  return path;
}

function randomSuffix(): string {
  return randomBytes(12).toString("hex");
}

function identityEqual(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function ignoreUnsupportedDirectorySync(handle: Awaited<ReturnType<typeof open>>): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP") throw error;
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await ignoreUnsupportedDirectorySync(handle);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EISDIR") throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readBounded(
  path: string,
  maximum: number,
  faultInjector: CacheFaultInjector | undefined,
  point: string,
): Promise<Uint8Array> {
  let before: BigIntStats;
  let canonical: string;
  try {
    before = await lstat(path, { bigint: true }) as BigIntStats;
    canonical = await realpath(path);
  } catch {
    return fail();
  }
  if (before.isSymbolicLink() || !before.isFile() || !samePath(canonical, path)) return fail();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // O_NOFOLLOW closes the lstat/open race on POSIX. Windows additionally
    // gets the realpath and identity checks below because Node does not expose
    // FILE_FLAG_OPEN_REPARSE_POINT through fs.open.
    handle = await open(path, READ_ONLY_FLAGS);
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!opened.isFile() || opened.size > BigInt(maximum) || opened.size < 1n ||
      !identityEqual(before, opened)) return fail();
    await faultInjector?.hit(point);
    const length = Number(opened.size);
    const result = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const chunk = await handle.read(result, offset, length - offset, offset);
      if (chunk.bytesRead <= 0) return fail();
      offset += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const current = await lstat(path, { bigint: true }) as BigIntStats;
    if (!identityEqual(opened, after) || !identityEqual(opened, current) || current.isSymbolicLink()) return fail();
    return result;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return fail();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertPlainDirectory(path: string): Promise<BigIntStats> {
  let metadata: BigIntStats;
  let canonical: string;
  try {
    metadata = await lstat(path, { bigint: true }) as BigIntStats;
    canonical = await realpath(path);
  } catch {
    return fail();
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory() || !samePath(canonical, path)) return fail();
  return metadata;
}

async function assertReadOnly(path: string, directory: boolean): Promise<void> {
  const metadata = await assertPlainDirectory(path).catch(async () => {
    try {
      const item = await lstat(path, { bigint: true }) as BigIntStats;
      const canonical = await realpath(path);
      if (item.isSymbolicLink() || !item.isFile() || !samePath(canonical, path)) return fail();
      return item;
    } catch {
      return fail();
    }
  });
  if (directory && !metadata.isDirectory()) return fail();
  if (!directory && !metadata.isFile()) return fail();
  if ((Number(metadata.mode) & 0o222) !== 0) return fail();
}

async function boundedReleaseEntries(path: string): Promise<string[]> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  const entries: string[] = [];
  try {
    directory = await opendir(path);
    for await (const entry of directory) {
      if (entries.length >= RELEASE_FILES.length) return fail();
      entries.push(entry.name);
    }
    return entries.sort();
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return fail();
  } finally {
    await directory?.close().catch(() => undefined);
  }
}

async function atomicWrite(
  path: string,
  content: Uint8Array,
  mode: number,
  faultInjector: CacheFaultInjector | undefined,
  point: string,
): Promise<void> {
  const parent = dirname(path);
  await assertPlainDirectory(parent);
  const temporary = `${path}.tmp.${randomSuffix()}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", mode);
    let offset = 0;
    while (offset < content.byteLength) {
      const written = await handle.write(content, offset, content.byteLength - offset, offset);
      if (written.bytesWritten <= 0) return fail();
      offset += written.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await faultInjector?.hit(point);
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    if (error instanceof ToolError) throw error;
    return fail();
  }
}

async function quarantine(path: string, parent: string): Promise<string> {
  await assertPlainDirectory(parent);
  const destination = `${path}.corrupt.${randomSuffix()}`;
  try {
    await rename(path, destination);
    await syncDirectory(parent);
    return destination;
  } catch {
    return fail();
  }
}

function normalizeSecurityView(manifest: Record<string, unknown>): VerifiedManifestSecurityView {
  const releaseSet = manifest.releaseSet;
  const security = manifest.security;
  if (
    manifest.manifestVersion !== 1 ||
    !Number.isSafeInteger(manifest.sequence) ||
    (manifest.sequence as number) < 1
  ) return fail();
  const release = plainRecord(releaseSet, ["id", "cli", "templates"]);
  const policy = plainRecord(
    security,
    ["minimumAllowedCliVersion", "revokedCliVersions", "revokedReleaseSetIds"],
  );
  if (
    typeof release.id !== "string" || !RELEASE_SET_ID.test(release.id) ||
    typeof release.cli !== "string" || typeof release.templates !== "string" ||
    typeof policy.minimumAllowedCliVersion !== "string"
  ) return fail();

  // Keep the security projection on the same canonical SemVer grammar as the
  // signed channel and release record validators (numeric prerelease labels
  // such as `-01` are intentionally rejected).
  const cli = strictSemver(release.cli);
  const templates = strictSemver(release.templates);
  const minimumAllowedCliVersion = strictSemver(policy.minimumAllowedCliVersion);

  const revokedCliVersions = securityStringArray(policy.revokedCliVersions, (item) => {
    try {
      strictSemver(item);
      return true;
    } catch {
      return false;
    }
  });
  const revokedReleaseSetIds = securityStringArray(policy.revokedReleaseSetIds, (item) => RELEASE_SET_ID.test(item));
  const frozenSecurity = Object.freeze({
    minimumAllowedCliVersion,
    revokedCliVersions,
    revokedReleaseSetIds,
  });
  const frozenReleaseSet = Object.freeze({
    id: release.id,
    cli,
    templates,
  });
  const frozenManifest = Object.freeze({
    manifestVersion: 1 as const,
    sequence: manifest.sequence as number,
    releaseSet: frozenReleaseSet,
    security: frozenSecurity,
  });
  return Object.freeze({ manifest: frozenManifest });
}

function securityStringArray(value: unknown, validator: (item: string) => boolean): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_POLICY_ITEMS || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail();
  }
  let copy;
  try {
    copy = copyJsonValue(value);
  } catch {
    return fail();
  }
  if (!Array.isArray(copy) || copy.some((item) => typeof item !== "string" || !validator(item))) {
    return fail();
  }
  return Object.freeze([...copy] as string[]);
}

function securityView(input: VerifiedManifestInput): VerifiedManifestSecurityView {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return fail();
  if (verifiedSecurityViews.has(input)) {
    const candidate = input as { readonly manifest?: unknown };
    if (
      candidate.manifest === null || typeof candidate.manifest !== "object" ||
      Array.isArray(candidate.manifest) || Object.getPrototypeOf(candidate.manifest) !== Object.prototype
    ) return fail();
    return normalizeSecurityView(candidate.manifest as Record<string, unknown>);
  }

  // A full VerifiedChannelManifest is produced by verifyChannelEnvelope. Its
  // private runtime brand is the trust boundary; shape checks alone are forgeable.
  if (!isVerifiedChannelManifest(input)) return fail();
  const candidate = input as unknown as Record<string, unknown>;
  if (
    Object.getPrototypeOf(candidate) !== Object.prototype ||
    !Object.isFrozen(candidate) ||
    !hasExactOwnFields(candidate, ["manifest", "payloadSha256", "signingKeyIds", "nextTrustState"]) ||
    typeof candidate.payloadSha256 !== "string" || !SHA256.test(candidate.payloadSha256) ||
    !Array.isArray(candidate.signingKeyIds) || candidate.signingKeyIds.length === 0 ||
    candidate.signingKeyIds.some((keyId) => typeof keyId !== "string" || keyId.length === 0) ||
    candidate.nextTrustState === null || typeof candidate.nextTrustState !== "object" ||
    Array.isArray(candidate.nextTrustState) || Object.getPrototypeOf(candidate.nextTrustState) !== Object.prototype
  ) return fail();
  const manifest = candidate.manifest;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest) ||
    Object.getPrototypeOf(manifest) !== Object.prototype) return fail();
  return normalizeSecurityView(manifest as Record<string, unknown>);
}

function writeBlocks(
  record: ReleaseSetRecord,
  manifest: VerifiedManifestSecurityView | undefined,
): readonly WriteBlockReason[] {
  if (manifest === undefined) return [];
  const policy = manifest.manifest.security;
  const reasons: WriteBlockReason[] = [];
  if (lt(record.cliVersion, policy.minimumAllowedCliVersion)) {
    reasons.push("active-cli-version-below-minimum");
  }
  if (policy.revokedCliVersions.includes(record.cliVersion)) {
    reasons.push("active-cli-version-revoked");
  }
  if (policy.revokedReleaseSetIds.includes(record.releaseSetId)) {
    reasons.push("active-release-set-revoked");
  }
  return Object.freeze(reasons);
}

export class UpdateCache {
  readonly cacheDirectory!: string;
  readonly releaseRoot!: string;
  readonly activeRecordPath!: string;

  private readonly windowsAclVerifier: WindowsAclVerifier | undefined;
  private readonly faultInjector: CacheFaultInjector | undefined;
  private readonly verifySnapshot: ReleaseSetSnapshotVerifier | undefined;
  private readonly lockProvider: ProcessLockProvider | undefined;
  private readonly lockTimeoutMs: number | undefined;
  private ready: Promise<void> | undefined;

  constructor(options: UpdateCacheOptions) {
    if (typeof options.stateDirectory !== "string" || options.stateDirectory.trim() === "") return fail();
    const stateDirectory = resolve(options.stateDirectory);
    this.cacheDirectory = stateDirectory;
    this.releaseRoot = safeChild(stateDirectory, RELEASE_ROOT_NAME);
    this.activeRecordPath = safeChild(stateDirectory, ACTIVE_POINTER_NAME);
    this.windowsAclVerifier = options.windowsAclVerifier;
    this.faultInjector = options.faultInjector;
    this.verifySnapshot = options.verifySnapshot;
    this.lockProvider = options.lockProvider;
    this.lockTimeoutMs = options.lockTimeoutMs;
  }

  private async withOperationLock<T>(
    lease: ProcessLockLease | undefined,
    callback: (heldLease: ProcessLockLease) => Promise<T>,
  ): Promise<T> {
    if (lease !== undefined) {
      assertUpdateLockLease(lease, this.cacheDirectory);
      return callback(lease);
    }
    return withUpdateLock(this.cacheDirectory, callback, {
      ...(this.lockProvider === undefined ? {} : { provider: this.lockProvider }),
      ...(this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs }),
    });
  }

  private async ensureReady(): Promise<void> {
    if (this.ready === undefined) {
      this.ready = (async () => {
      const stateOptions = this.windowsAclVerifier === undefined
          ? {}
          : { windowsAclVerifier: this.windowsAclVerifier };
        await ensurePrivateStateDirectory(this.cacheDirectory, stateOptions);
        // Check before recursive creation as well as after it: a pre-existing
        // junction/reparse point must never become a write target.
        try {
          const existing = await lstat(this.releaseRoot);
          if (existing.isSymbolicLink() || !existing.isDirectory()) return fail();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
        }
        await mkdir(this.releaseRoot, { recursive: true, mode: 0o700 });
        await assertPlainDirectory(this.releaseRoot);
        if (process.platform !== "win32") {
          await chmod(this.cacheDirectory, 0o700);
          await chmod(this.releaseRoot, 0o700);
        }
      })().catch((error) => {
        this.ready = undefined;
        if (error instanceof ToolError) throw error;
        return fail();
      });
    }
    await this.ready;
    // Re-check on every operation. The state path may have been replaced
    // after the initial setup; a cached readiness promise must not authorize
    // writes through a newly introduced junction or directory replacement.
    await assertPlainDirectory(this.cacheDirectory);
    await assertPlainDirectory(this.releaseRoot);
  }

  private releaseDirectory(record: ReleaseSetRecord): string {
    return safeChild(this.releaseRoot, record.transactionId);
  }

  private async readRecord(): Promise<ReleaseSetRecord> {
    let bytes: Uint8Array;
    try {
      bytes = await readBounded(
        this.activeRecordPath,
        MAX_CACHE_POINTER_BYTES,
        this.faultInjector,
        "after-active-open",
      );
    } catch (error) {
      if (error instanceof ToolError && error.code !== "UPDATE_SECURITY_ERROR") throw error;
      await quarantine(this.activeRecordPath, this.cacheDirectory).catch(() => undefined);
      return fail();
    }
    let text: string;
    let parsed: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parsed = parseStrictJson(text);
    } catch {
      await quarantine(this.activeRecordPath, this.cacheDirectory).catch(() => undefined);
      return fail();
    }
    let record: ReleaseSetRecord;
    try {
      record = validateReleaseSetRecord(parsed);
      if (text !== canonicalRecord(record)) return fail();
    } catch {
      await quarantine(this.activeRecordPath, this.cacheDirectory).catch(() => undefined);
      return fail();
    }
    return record;
  }

  private async readRelease(record: ReleaseSetRecord): Promise<ReleaseSetSnapshot & {
    readonly releaseDirectory: string;
    readonly cliPath: string;
    readonly templatePath: string;
    readonly receiptPath: string;
  }> {
    const releaseDirectory = this.releaseDirectory(record);
    try {
      await assertReadOnly(releaseDirectory, true);
      const entries = await boundedReleaseEntries(releaseDirectory);
      if (entries.length !== SORTED_RELEASE_FILES.length ||
        entries.some((entry, index) => entry !== SORTED_RELEASE_FILES[index])) {
        return fail();
      }
      for (const name of RELEASE_FILES) await assertReadOnly(safeChild(releaseDirectory, name), false);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      return fail();
    }
    const cliPath = safeChild(releaseDirectory, CLI_NAME);
    const templatePath = safeChild(releaseDirectory, TEMPLATE_NAME);
    const receiptPath = safeChild(releaseDirectory, RECEIPT_NAME);
    const [cliBytes, templateBytes, receiptBytes] = await Promise.all([
      readBounded(cliPath, MAX_CACHE_CLI_BYTES, this.faultInjector, "after-cli-open"),
      readBounded(templatePath, MAX_CACHE_TEMPLATE_BYTES, this.faultInjector, "after-template-open"),
      readBounded(receiptPath, MAX_CACHE_RECEIPT_BYTES, this.faultInjector, "after-receipt-open"),
    ]);
    if (
      sha(cliBytes) !== record.cliSha256 ||
      sha(templateBytes) !== record.templateSha256 ||
      sha(receiptBytes) !== record.receiptSha256
    ) return fail();
    return {
      record,
      cliBytes,
      templateBytes,
      receiptBytes,
      releaseDirectory,
      cliPath,
      templatePath,
      receiptPath,
    };
  }

  /** Remove only tool-owned staging directories while the activation lock is held. */
  private async cleanupStaleStagingDirectoriesUnlocked(): Promise<void> {
    await this.ensureReady();
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    let count = 0;
    try {
      directory = await opendir(this.releaseRoot);
      for await (const entry of directory) {
        count += 1;
        if (count > MAX_RELEASE_ROOT_ENTRIES) return fail();
        const isStaging = entry.name.startsWith(".staging-");
        const isStale = entry.name.startsWith(".stale-");
        if (!isStaging && !isStale) continue;
        if ((isStaging && !STAGING_NAME.test(entry.name)) ||
            (isStale && !STALE_NAME.test(entry.name))) return fail();
        const source = safeChild(this.releaseRoot, entry.name);
        await assertPlainDirectory(source);
        const isolated = isStale ? source : safeChild(this.releaseRoot, `.stale-${randomSuffix()}`);
        if (!isStale) {
          await rename(source, isolated);
          await assertPlainDirectory(isolated);
        }
        await rm(isolated, { recursive: true, maxRetries: 3, retryDelay: 10 });
        await syncDirectory(this.releaseRoot);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      return fail();
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }

  async cleanupStaleStagingDirectories(lease?: ProcessLockLease): Promise<void> {
    await this.withOperationLock(lease, async (heldLease) => {
      await this.cleanupStaleStagingDirectoriesUnlocked();
      heldLease.assertHeld();
    });
  }

  private async storeVerifiedReleaseSetUnlocked(input: ReleaseSetSnapshot): Promise<StoredReleaseSet> {
    await this.ensureReady();
    const snapshot = validateSnapshot(input);
    if (this.verifySnapshot === undefined || typeof this.verifySnapshot.verify !== "function") return fail();
    await this.verifySnapshot.verify(verifierSnapshot(snapshot));
    const releaseDirectory = this.releaseDirectory(snapshot.record);
    try {
      await lstat(releaseDirectory);
      return fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail();
    }
    const stagingDirectory = safeChild(this.releaseRoot, `.staging-${randomSuffix()}`);
    try {
      await mkdir(stagingDirectory, { mode: 0o700 });
      await assertPlainDirectory(stagingDirectory);
      const paths: Record<ReleaseFileName, string> = {
        [CLI_NAME]: safeChild(stagingDirectory, CLI_NAME),
        [TEMPLATE_NAME]: safeChild(stagingDirectory, TEMPLATE_NAME),
        [RECEIPT_NAME]: safeChild(stagingDirectory, RECEIPT_NAME),
      };
      await atomicWrite(paths[CLI_NAME], snapshot.cliBytes, 0o600, this.faultInjector, "before-cli-replace");
      await atomicWrite(paths[TEMPLATE_NAME], snapshot.templateBytes, 0o600, this.faultInjector, "before-template-replace");
      await atomicWrite(paths[RECEIPT_NAME], snapshot.receiptBytes, 0o600, this.faultInjector, "before-receipt-replace");
      for (const name of RELEASE_FILES) {
        await chmod(paths[name], 0o400);
      }
      await chmod(stagingDirectory, 0o500);
      await syncDirectory(stagingDirectory);
      await rename(stagingDirectory, releaseDirectory);
      await syncDirectory(this.releaseRoot);
      await atomicWrite(
        this.activeRecordPath,
        new TextEncoder().encode(canonicalRecord(snapshot.record)),
        0o600,
        this.faultInjector,
        "before-active-replace",
      );
    } catch (error) {
      await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
      if (error instanceof ToolError) throw error;
      return fail();
    }
    const loaded = await this.readRelease(snapshot.record);
    const result: StoredReleaseSet = {
      ...loaded,
      writesBlocked: false,
      writeBlockReasons: [],
    };
    return Object.freeze(result);
  }

  async storeVerifiedReleaseSet(
    input: ReleaseSetSnapshot,
    lease?: ProcessLockLease,
  ): Promise<StoredReleaseSet> {
    return this.withOperationLock(lease, async (heldLease) => {
      const result = await this.storeVerifiedReleaseSetUnlocked(input);
      heldLease.assertHeld();
      return result;
    });
  }

  /** Commit a release directory previously published by a verified store attempt. */
  private async commitStagedReleaseSetUnlocked(input: ReleaseSetRecord): Promise<StoredReleaseSet | null> {
    await this.ensureReady();
    const record = validateReleaseSetRecord(input);
    const releaseDirectory = this.releaseDirectory(record);
    try {
      const existing = await lstat(releaseDirectory);
      if (existing.isSymbolicLink() || !existing.isDirectory()) return fail();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof ToolError) throw error;
      return fail();
    }
    const loaded = await this.readRelease(record);
    if (this.verifySnapshot === undefined || typeof this.verifySnapshot.verify !== "function") return fail();
    await this.verifySnapshot.verify(verifierSnapshot(loaded));
    await atomicWrite(
      this.activeRecordPath,
      new TextEncoder().encode(canonicalRecord(record)),
      0o600,
      this.faultInjector,
      "before-active-replace",
    );
    return Object.freeze({
      ...loaded,
      writesBlocked: false,
      writeBlockReasons: [],
    });
  }

  async commitStagedReleaseSet(
    input: ReleaseSetRecord,
    lease?: ProcessLockLease,
  ): Promise<StoredReleaseSet | null> {
    return this.withOperationLock(lease, async (heldLease) => {
      const result = await this.commitStagedReleaseSetUnlocked(input);
      heldLease.assertHeld();
      return result;
    });
  }

  private async loadLastKnownGoodOrNullUnlocked(
    options: { readonly verifiedManifest?: VerifiedManifestInput } = {},
  ): Promise<LoadedReleaseSet | null> {
    await this.ensureReady();
    try {
      await lstat(this.activeRecordPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      return fail();
    }
    return this.loadLastKnownGoodUnlocked(options);
  }

  async loadLastKnownGoodOrNull(
    options: { readonly verifiedManifest?: VerifiedManifestInput } = {},
    lease?: ProcessLockLease,
  ): Promise<LoadedReleaseSet | null> {
    return this.withOperationLock(lease, async (heldLease) => {
      const result = await this.loadLastKnownGoodOrNullUnlocked(options);
      heldLease.assertHeld();
      return result;
    });
  }

  private async loadLastKnownGoodUnlocked(
    options: { readonly verifiedManifest?: VerifiedManifestInput } = {},
  ): Promise<LoadedReleaseSet> {
    await this.ensureReady();
    let record: ReleaseSetRecord;
    try {
      record = await this.readRecord();
    } catch (error) {
      if (error instanceof ToolError) throw error;
      return fail();
    }
    // Validate caller-supplied security state before entering the disk-corruption
    // quarantine path. An unverified argument must not destroy a valid LKG.
    const manifest = options.verifiedManifest === undefined
      ? undefined
      : securityView(options.verifiedManifest);
    let loaded: ReleaseSetSnapshot & {
      readonly releaseDirectory: string;
      readonly cliPath: string;
      readonly templatePath: string;
      readonly receiptPath: string;
    };
    try {
      loaded = await this.readRelease(record);
    } catch (error) {
      // Only a branded security failure proves on-disk corruption. Preserve
      // the active pointer for transient I/O/ACL failures so LKG recovery can
      // retry instead of destroying the only known-good release.
      if (error instanceof ToolError && error.code !== "UPDATE_SECURITY_ERROR") {
        throw error;
      }
      await quarantine(this.releaseDirectory(record), this.releaseRoot).catch(() => undefined);
      await quarantine(this.activeRecordPath, this.cacheDirectory).catch(() => undefined);
      if (error instanceof ToolError) throw error;
      return fail();
    }
    // A hash-consistent tuple proves only local file integrity.  Reads are
    // trusted only after the same application verifier used for publication
    // authenticates the complete snapshot.
    if (this.verifySnapshot === undefined || typeof this.verifySnapshot.verify !== "function") {
      return fail();
    }
    await this.verifySnapshot.verify(verifierSnapshot(loaded));
    const reasons = writeBlocks(record, manifest);
    return Object.freeze({
      ...loaded,
      writesBlocked: reasons.length > 0,
      writeBlockReasons: reasons,
    });
  }

  async loadLastKnownGood(
    options: { readonly verifiedManifest?: VerifiedManifestInput } = {},
    lease?: ProcessLockLease,
  ): Promise<LoadedReleaseSet> {
    return this.withOperationLock(lease, async (heldLease) => {
      const result = await this.loadLastKnownGoodUnlocked(options);
      heldLease.assertHeld();
      return result;
    });
  }
}

export function releaseSetRecordJson(record: ReleaseSetRecord): string {
  return canonicalRecord(validateReleaseSetRecord(record));
}

export function releaseSetRecordSha256(record: ReleaseSetRecord): string {
  return sha(new TextEncoder().encode(releaseSetRecordJson(record)));
}

export function projectVerifiedManifestSecurity(
  verified: VerifiedChannelManifest,
): VerifiedManifestSecurityView {
  // Re-run the structural boundary here instead of trusting the caller's
  // TypeScript annotation. The returned object is then branded in-memory so
  // loadLastKnownGood can accept only this projection or a full verified value.
  const projection = Object.freeze(securityView(verified));
  verifiedSecurityViews.add(projection);
  return projection;
}
