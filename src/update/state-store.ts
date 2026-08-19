import { randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";




import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import {
  ProcessLockError,
  type ProcessLockLease,
  type ProcessLockProvider,
} from "../platform/process-lock.ts";
import { withUpdateLock } from "../platform/lock.ts";
import {
  copyTrustState,
  createTrustState,
  type TrustedSigningKey,
  type UpdateTrustState,
} from "./envelope.ts";
import type { ChannelValidators } from "./http.ts";




export const MAX_UPDATE_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_UPDATE_STATE_TEMP_FILES = 32;
export const MAX_UPDATE_STATE_DIRECTORY_ENTRIES_SCANNED = 4_096;




const STATE_VERSION = 1;
const STATE_NAME = "update-state.json";
const SHA256 = /^[a-f0-9]{64}$/u;
const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const TEMP_NAME = /^update-state\.json\.tmp\.[a-f0-9]{24}$/u;
const RECORD_FIELDS = new Set([
  "stateVersion",
  "trustConfigSha256",
  "trustState",
  "validators",
]);
const VALUE_FIELDS = new Set(["trustState", "validators"]);
const VALIDATOR_FIELDS = new Set(["etag", "lastModified"]);




export interface UpdateStateValue {
  readonly trustState: UpdateTrustState;
  readonly validators: ChannelValidators;
}




export interface StoredUpdateState extends UpdateStateValue {
  readonly stateVersion: 1;
  readonly trustConfigSha256: string;
}




export interface UpdateStateStoreOptions {
  readonly stateDirectory: string;
  readonly trustConfigSha256: string;
  readonly bootstrapKeys: readonly TrustedSigningKey[];
  readonly windowsAclVerifier?: WindowsAclVerifier;
  readonly lockProvider?: ProcessLockProvider;
  readonly lockTimeoutMs?: number;
  readonly faultInjector?: UpdateStateStoreFaultInjector;
}




export interface UpdateStateStoreFaultInjector {
  hit(
    point: "after-lock-acquired" | "after-current-state-load" | "after-read-open" |
      "after-temp-open" | "after-file-sync" | "before-publish" | "after-publish" |
      "after-directory-sync",
  ): Promise<void> | void;
}




interface ReadStateSnapshot {
  readonly state: StoredUpdateState | null;
  readonly identity: BigIntStats | null;
}




function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError(
    "UPDATE_SECURITY_ERROR",
    "The persisted update state is not trustworthy",
    {
      field: "updateState",
      expected: "canonical state bound to the built-in update trust configuration",
      actual: "invalid or unsafe local update state",
      safeNextStep: "Repair the private update state and retry.",
    },
  );
}




function persistenceFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError(
    "INTERNAL_ERROR",
    "The update state could not be persisted",
    {
      field: "updateState",
      expected: "an atomically durable private update state",
      actual: "local persistence failed",
      safeNextStep: "Repair the private update state directory and retry.",
    },
  );
}




function exactFields(value: JsonObject, expected: ReadonlySet<string>): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length &&
    actual.every((field, index) => field === wanted[index]);
}




function plainRecord(value: unknown, fields: ReadonlySet<string>): JsonObject {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !exactFields(value as JsonObject, fields)
  ) {
    throw securityFailure();
  }
  return value as JsonObject;
}




function header(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    /[\r\n\u0000]/u.test(value)
  ) {
    throw securityFailure();
  }
  return value;
}




function normalizeValidators(value: unknown): ChannelValidators {
  const record = plainRecord(value, VALIDATOR_FIELDS);
  return Object.freeze({
    etag: header(record.etag),
    lastModified: header(record.lastModified),
  });
}




function samePath(left: string, right: string): boolean {
  if (process.platform === "win32") return true;
  return resolve(left) === resolve(right);
}


function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.nlink === right.nlink && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}




function sameMovedIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.nlink === right.nlink && left.mtimeNs === right.mtimeNs &&
    left.birthtimeNs === right.birthtimeNs;
}




function sameDirectoryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}




function sameJson(left: unknown, right: unknown): boolean {
  return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
}




async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EISDIR") {
      throw error;
    }
  } finally {
    await handle?.close().catch(() => undefined);
  }
}




export class UpdateStateStore {
  readonly statePath: string;




  private readonly stateDirectory: string;
  private readonly trustConfigSha256: string;
  private readonly bootstrapKeys: readonly TrustedSigningKey[];
  private readonly windowsAclVerifier: WindowsAclVerifier | undefined;
  private readonly lockProvider: ProcessLockProvider | undefined;
  private readonly lockTimeoutMs: number | undefined;
  private readonly faultInjector: UpdateStateStoreFaultInjector | undefined;




  constructor(options: UpdateStateStoreOptions) {
    if (
      typeof options.stateDirectory !== "string" ||
      options.stateDirectory.trim() === "" ||
      typeof options.trustConfigSha256 !== "string" ||
      !SHA256.test(options.trustConfigSha256)
    ) {
      throw new TypeError("UpdateStateStore requires a state directory and trust config SHA-256");
    }
    this.stateDirectory = resolve(options.stateDirectory);
    this.statePath = resolve(this.stateDirectory, STATE_NAME);
    this.trustConfigSha256 = options.trustConfigSha256;
    this.bootstrapKeys = createTrustState(options.bootstrapKeys).bootstrapKeys;
    this.windowsAclVerifier = options.windowsAclVerifier;
    this.lockProvider = options.lockProvider;
    this.lockTimeoutMs = options.lockTimeoutMs;
    this.faultInjector = options.faultInjector;
  }




  private async prepareDirectory(): Promise<void> {
    await ensurePrivateStateDirectory(
      this.stateDirectory,
      this.windowsAclVerifier === undefined
        ? {}
        : { windowsAclVerifier: this.windowsAclVerifier },
    );
  }




  private async stateDirectoryIdentity(expected?: BigIntStats): Promise<BigIntStats> {
    try {
      const metadata = await lstat(this.stateDirectory, { bigint: true }) as BigIntStats;
      const canonical = await realpath(this.stateDirectory);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        !samePath(canonical, this.stateDirectory) ||
        (expected !== undefined && !sameDirectoryIdentity(expected, metadata))
      ) {
        throw securityFailure();
      }
      return metadata;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }




  private async locked<T>(
    operation: (lease: ProcessLockLease, rootIdentity: BigIntStats) => Promise<T>,
  ): Promise<T> {
    await this.prepareDirectory();
    const rootIdentity = await this.stateDirectoryIdentity();
    try {
      return await withUpdateLock(
        this.stateDirectory,
        async (lease) => {
          lease.assertHeld();
          await this.faultInjector?.hit("after-lock-acquired");
          lease.assertHeld();
          await this.stateDirectoryIdentity(rootIdentity);
          await this.cleanStaleTemporaryFiles(lease, rootIdentity);
          lease.assertHeld();
          await this.stateDirectoryIdentity(rootIdentity);
          const result = await operation(lease, rootIdentity);
          lease.assertHeld();
          await this.stateDirectoryIdentity(rootIdentity);
          return result;
        },
        {
          ...(this.lockProvider === undefined ? {} : { provider: this.lockProvider }),
          ...(this.lockTimeoutMs === undefined ? {} : { timeoutMs: this.lockTimeoutMs }),
        },
      );
    } catch (error) {
      if (error instanceof ToolError) throw error;
      if (error instanceof ProcessLockError && error.reason === "unsafe") throw securityFailure();
      throw persistenceFailure();
    }
  }




  private async cleanStaleTemporaryFiles(
    lease: ProcessLockLease,
    rootIdentity: BigIntStats,
  ): Promise<void> {
    let directory: Awaited<ReturnType<typeof opendir>> | undefined;
    const temporaryPaths: string[] = [];
    let scanned = 0;
    try {
      lease.assertHeld();
      await this.stateDirectoryIdentity(rootIdentity);
      directory = await opendir(this.stateDirectory);
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_UPDATE_STATE_DIRECTORY_ENTRIES_SCANNED) throw securityFailure();
        if (!entry.name.startsWith(`${STATE_NAME}.tmp.`)) continue;
        if (!TEMP_NAME.test(entry.name)) throw securityFailure();
        temporaryPaths.push(resolve(this.stateDirectory, entry.name));
        if (temporaryPaths.length > MAX_UPDATE_STATE_TEMP_FILES) throw securityFailure();
        if (scanned % 32 === 0) lease.assertHeld();
      }
      directory = undefined;
      for (const path of temporaryPaths) {
        lease.assertHeld();
        await this.stateDirectoryIdentity(rootIdentity);
        const metadata = await lstat(path, { bigint: true }) as BigIntStats;
        const canonical = await realpath(path);
        if (
          metadata.isSymbolicLink() ||
          !metadata.isFile() ||
          metadata.nlink !== 1n ||
          !samePath(canonical, path)
        ) {
          throw securityFailure();
        }
        await this.stateDirectoryIdentity(rootIdentity);
        await rm(path);
      }
      if (temporaryPaths.length > 0) {
        await syncDirectory(this.stateDirectory);
        await this.stateDirectoryIdentity(rootIdentity);
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    } finally {
      await directory?.close().catch(() => undefined);
    }
  }




  private normalize(value: unknown): StoredUpdateState {
    const input = plainRecord(value, VALUE_FIELDS);
    let trustState: UpdateTrustState;
    try {
      trustState = copyTrustState(
        input.trustState as unknown as UpdateTrustState,
        this.bootstrapKeys,
      );
    } catch {
      throw securityFailure();
    }
    return Object.freeze({
      stateVersion: STATE_VERSION,
      trustConfigSha256: this.trustConfigSha256,
      trustState,
      validators: normalizeValidators(input.validators),
    });
  }




  private validateRecord(value: unknown): StoredUpdateState {
    const record = plainRecord(value, RECORD_FIELDS);
    if (
      record.stateVersion !== STATE_VERSION ||
      record.trustConfigSha256 !== this.trustConfigSha256
    ) {
      throw securityFailure();
    }
    return this.normalize({
      trustState: record.trustState,
      validators: record.validators,
    });
  }




  private assertPermittedTransition(
    previous: StoredUpdateState | null,
    next: StoredUpdateState,
  ): void {
    if (previous === null) return;
    const prior = previous.trustState;
    const candidate = next.trustState;
    if (candidate.highestSequence < prior.highestSequence) throw securityFailure();
    if (candidate.highestSequence === prior.highestSequence) {
      if (!sameJson(candidate, prior)) throw securityFailure();
      return;
    }
    const transition = candidate.acceptedTransition;
    if (
      transition === null ||
      transition.priorHighestSequence !== prior.highestSequence ||
      transition.priorAcceptedPayloadSha256 !== prior.acceptedPayloadSha256 ||
      !sameJson(transition.priorKeys, prior.keys) ||
      !sameJson(transition.priorBundleReceiptAnchors, prior.bundleReceiptAnchors) ||
      candidate.keyRotationProofs.length < prior.keyRotationProofs.length ||
      !candidate.keyRotationProofs.every((proof, index) =>
        index >= prior.keyRotationProofs.length || proof === prior.keyRotationProofs[index])
    ) {
      throw securityFailure();
    }
  }




  private async readState(
    lease: ProcessLockLease,
    rootIdentity: BigIntStats,
  ): Promise<ReadStateSnapshot> {
    lease.assertHeld();
    await this.stateDirectoryIdentity(rootIdentity);
    let before: BigIntStats;
    let canonical: string;
    try {
      before = await lstat(this.statePath, { bigint: true }) as BigIntStats;
      canonical = await realpath(this.statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        await this.stateDirectoryIdentity(rootIdentity);
        return Object.freeze({ state: null, identity: null });
      }
      throw securityFailure();
    }
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size < 1n ||
      before.size > BigInt(MAX_UPDATE_STATE_BYTES) ||
      !samePath(canonical, this.statePath)
    ) {
      throw securityFailure();
    }




    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(this.statePath, constants.O_RDONLY | NOFOLLOW);
      await this.faultInjector?.hit("after-read-open");
      lease.assertHeld();
      const opened = await handle.stat({ bigint: true }) as BigIntStats;
      const atOpen = await lstat(this.statePath, { bigint: true }) as BigIntStats;
      if (
        !opened.isFile() ||
        atOpen.isSymbolicLink() ||
        !sameIdentity(before, opened) ||
        !sameIdentity(opened, atOpen)
      ) {
        throw securityFailure();
      }
      const expectedLength = Number(opened.size);
      const bytes = Buffer.alloc(expectedLength + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      lease.assertHeld();
      const after = await handle.stat({ bigint: true }) as BigIntStats;
      const current = await lstat(this.statePath, { bigint: true }) as BigIntStats;
      if (
        offset !== expectedLength ||
        current.isSymbolicLink() ||
        !sameIdentity(opened, after) ||
        !sameIdentity(opened, current)
      ) {
        throw securityFailure();
      }
      let serialized: string;
      let parsed: JsonValue;
      try {
        serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, offset));
        parsed = parseStrictJson(serialized);
      } catch {
        throw securityFailure();
      }
      if (`${canonicalizeJson(parsed)}\n` !== serialized) throw securityFailure();
      const result = this.validateRecord(parsed);
      lease.assertHeld();
      await this.stateDirectoryIdentity(rootIdentity);
      return Object.freeze({ state: result, identity: current });
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }




  async load(): Promise<StoredUpdateState | null> {
    return this.locked(async (lease, rootIdentity) =>
      (await this.readState(lease, rootIdentity)).state);
  }




  private async assertDestinationIdentity(
    expected: BigIntStats | null,
    lease: ProcessLockLease,
    rootIdentity: BigIntStats,
  ): Promise<void> {
    lease.assertHeld();
    await this.stateDirectoryIdentity(rootIdentity);
    if (expected === null) {
      try {
        await lstat(this.statePath, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw securityFailure();
      }
      throw securityFailure();
    }
    try {
      const current = await lstat(this.statePath, { bigint: true }) as BigIntStats;
      const canonical = await realpath(this.statePath);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1n ||
        !sameIdentity(expected, current) ||
        !samePath(canonical, this.statePath)
      ) {
        throw securityFailure();
      }
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }




  private async assertPublishedIdentity(
    expected: BigIntStats,
    moved: boolean,
    lease: ProcessLockLease,
    rootIdentity: BigIntStats,
  ): Promise<BigIntStats> {
    lease.assertHeld();
    await this.stateDirectoryIdentity(rootIdentity);
    try {
      const current = await lstat(this.statePath, { bigint: true }) as BigIntStats;
      const canonical = await realpath(this.statePath);
      if (
        current.isSymbolicLink() ||
        !current.isFile() ||
        current.nlink !== 1n ||
        !(moved ? sameMovedIdentity(expected, current) : sameIdentity(expected, current)) ||
        !samePath(canonical, this.statePath)
      ) {
        throw securityFailure();
      }
      return current;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw securityFailure();
    }
  }




  async save(value: UpdateStateValue): Promise<StoredUpdateState> {
    const record = this.normalize(value);
    const serialized = `${canonicalizeJson(record as unknown as JsonValue)}\n`;
    const bytes = Buffer.from(serialized, "utf8");
    if (bytes.byteLength > MAX_UPDATE_STATE_BYTES) throw securityFailure();
    return this.locked(async (lease, rootIdentity) => {
      const current = await this.readState(lease, rootIdentity);
      await this.faultInjector?.hit("after-current-state-load");
      lease.assertHeld();
      this.assertPermittedTransition(current.state, record);
      await this.stateDirectoryIdentity(rootIdentity);
      const temporary = `${this.statePath}.tmp.${randomBytes(12).toString("hex")}`;
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      let temporaryIdentity: BigIntStats | undefined;
      try {
        handle = await open(
          temporary,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW,
          0o600,
        );
        await this.faultInjector?.hit("after-temp-open");
        lease.assertHeld();
        await this.stateDirectoryIdentity(rootIdentity);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
          if (bytesWritten < 1) throw persistenceFailure();
          offset += bytesWritten;
        }
        if (process.platform !== "win32") await handle.chmod(0o600);
        await handle.sync();
        temporaryIdentity = await handle.stat({ bigint: true }) as BigIntStats;
        if (
          !temporaryIdentity.isFile() ||
          temporaryIdentity.isSymbolicLink() ||
          temporaryIdentity.nlink !== 1n ||
          temporaryIdentity.size !== BigInt(bytes.byteLength)
        ) {
          throw securityFailure();
        }
        await this.faultInjector?.hit("after-file-sync");
        lease.assertHeld();
        await handle.close();
        handle = undefined;
        await this.faultInjector?.hit("before-publish");
        lease.assertHeld();
        let currentTemporary: BigIntStats;
        let canonicalTemporary: string;
        try {
          currentTemporary = await lstat(temporary, { bigint: true }) as BigIntStats;
          canonicalTemporary = await realpath(temporary);
        } catch {
          throw securityFailure();
        }
        if (
          temporaryIdentity === undefined ||
          currentTemporary.isSymbolicLink() ||
          !currentTemporary.isFile() ||
          currentTemporary.nlink !== 1n ||
          !sameIdentity(temporaryIdentity, currentTemporary) ||
          !samePath(canonicalTemporary, temporary)
        ) {
          throw securityFailure();
        }
        await this.assertDestinationIdentity(current.identity, lease, rootIdentity);
        await rename(temporary, this.statePath);
        let publishedIdentity = await this.assertPublishedIdentity(
          temporaryIdentity,
          true,
          lease,
          rootIdentity,
        );
        await this.faultInjector?.hit("after-publish");
        lease.assertHeld();
        publishedIdentity = await this.assertPublishedIdentity(
          publishedIdentity,
          false,
          lease,
          rootIdentity,
        );
        await syncDirectory(dirname(this.statePath));
        await this.faultInjector?.hit("after-directory-sync");
        lease.assertHeld();
        await this.assertPublishedIdentity(publishedIdentity, false, lease, rootIdentity);
        return this.validateRecord(record);
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(temporary, { force: true }).catch(() => undefined);
        if (error instanceof ToolError) throw error;
        throw persistenceFailure();
      }
    });
  }
}
