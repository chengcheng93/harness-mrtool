import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { ensurePrivateStateDirectory, type WindowsAclVerifier } from "../platform/state-path.ts";
import { assertUpdateLockLease } from "../platform/lock.ts";
import type { ProcessLockLease } from "../platform/process-lock.ts";
import { samePhysicalPath } from "../platform/windows-path.ts";
import { writeBoundedCanonicalFile } from "./journal.ts";
import {
  decodeInstallationControl,
  encodeInstallationControl,
  MAX_INSTALLATION_CONTROL_BYTES,
  type InstallationControl,
} from "./installation-control.ts";

export const INSTALLATION_CONTROL_FILE_NAME = "installation-control.json";

const NOFOLLOW = process.platform === "win32" ? 0 : ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
const MAX_IDENTITY = (1n << 64n) - 1n;

type ControlStat = Awaited<ReturnType<typeof lstat>> & {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
  readonly nlink: bigint;
};

function failure(actual = "installation-control:unsafe"): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "installation control store is unsafe", {
    field: "installationControlStore",
    expected: "a private bounded canonical control record under the fixed state root",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function validAbsoluteRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value) throw failure();
  return value;
}

function samePath(left: string, right: string): boolean {
  return samePhysicalPath(left, right);
}

function sameIdentity(left: ControlStat, right: ControlStat): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function decimalIdentity(value: { readonly dev: string; readonly ino: string }): { readonly dev: bigint; readonly ino: bigint } {
  if (!/^\d+$/.test(value.dev) || !/^\d+$/.test(value.ino)) throw failure();
  const dev = BigInt(value.dev);
  const ino = BigInt(value.ino);
  if (dev > MAX_IDENTITY || ino < 1n || ino > MAX_IDENTITY) throw failure();
  return { dev, ino };
}

function assertPrivateFile(info: ControlStat, expectedSize?: bigint): void {
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n ||
      (expectedSize !== undefined && info.size !== expectedSize)) throw failure();
  if (process.platform !== "win32" &&
      (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o600n)) throw failure();
}

async function rootStat(
  stateRoot: string,
  create: boolean,
  windowsAclVerifier?: WindowsAclVerifier,
): Promise<ControlStat | null> {
  if (create) await ensurePrivateStateDirectory(stateRoot, windowsAclVerifier === undefined ? {} : { windowsAclVerifier });
  try {
    const info = await lstat(stateRoot, { bigint: true }) as ControlStat;
    const physical = await realpath(stateRoot);
    if (info.isSymbolicLink() || !info.isDirectory() || !samePath(physical, stateRoot)) throw failure("installation-control:root");
    if (process.platform !== "win32" &&
        (info.uid !== BigInt(process.getuid!()) || (info.mode & 0o777n) !== 0o700n)) throw failure("installation-control:root-mode");
    return info;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error instanceof ToolError ? error : failure();
  }
}

async function readBounded(path: string): Promise<{ readonly bytes: Uint8Array; readonly stat: ControlStat } | null> {
  let before: ControlStat;
  try {
    before = await lstat(path, { bigint: true }) as ControlStat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure();
  }
  assertPrivateFile(before);
  if (before.size < 1n || before.size > BigInt(MAX_INSTALLATION_CONTROL_BYTES)) throw failure();

  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primary: unknown;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat({ bigint: true }) as ControlStat;
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
    const after = await handle.stat({ bigint: true }) as ControlStat;
    const current = await lstat(path, { bigint: true }) as ControlStat;
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
  if (process.platform === "win32") return;
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

async function currentTarget(path: string): Promise<ControlStat | null> {
  try {
    const info = await lstat(path, { bigint: true }) as ControlStat;
    assertPrivateFile(info);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error instanceof ToolError ? error : failure();
  }
}

function sameRootEvidence(control: InstallationControl, root: ControlStat): void {
  const expected = decimalIdentity(control.roots.state);
  if (expected.dev !== root.dev || expected.ino !== root.ino) throw failure("installation-control:root-evidence");
}

export interface InstallationControlStoreOptions {
  readonly lease?: ProcessLockLease;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export interface InstallationControlStore {
  readonly path: string;
  encode(value: unknown): Uint8Array;
  read(): Promise<InstallationControl | null>;
  write(value: unknown): Promise<InstallationControl>;
  remove(): Promise<void>;
}

export function createInstallationControlStore(
  stateDirectory: string,
  options: InstallationControlStoreOptions = {},
): InstallationControlStore {
  const stateRoot = validAbsoluteRoot(stateDirectory);
  const boundLease = options.lease;
  const windowsAclVerifier = options.windowsAclVerifier;
  let knownRoot: { readonly dev: bigint; readonly ino: bigint } | undefined;
  const path = resolve(stateRoot, INSTALLATION_CONTROL_FILE_NAME);

  function assertStableRoot(root: ControlStat): void {
    if (knownRoot === undefined) {
      knownRoot = Object.freeze({ dev: root.dev, ino: root.ino });
      return;
    }
    if (knownRoot.dev !== root.dev || knownRoot.ino !== root.ino) throw failure("installation-control:root-changed");
  }

  function assertBoundLease(): void {
    if (boundLease !== undefined) assertUpdateLockLease(boundLease, stateRoot);
  }

  async function read(): Promise<InstallationControl | null> {
    assertBoundLease();
    const root = await rootStat(stateRoot, false, windowsAclVerifier);
    if (root === null) {
      if (knownRoot !== undefined) throw failure("installation-control:root-missing");
      return null;
    }
    assertStableRoot(root);
    const file = await readBounded(path);
    if (file === null) return null;
    const control = decodeInstallationControl(file.bytes);
    sameRootEvidence(control, root);
    return control;
  }

  async function write(value: unknown): Promise<InstallationControl> {
    assertBoundLease();
    const control = decodeInstallationControl(encodeInstallationControl(value));
    const root = await rootStat(stateRoot, true, windowsAclVerifier);
    if (root === null) throw failure();
    assertStableRoot(root);
    sameRootEvidence(control, root);

    const existingBytes = await readBounded(path);
    const existing = existingBytes === null ? null : decodeInstallationControl(existingBytes.bytes);
    if (existing !== null) {
      sameRootEvidence(existing, root);
      if (existing.installationId !== control.installationId || existing.enrollmentId !== control.enrollmentId ||
          control.authorityEpoch <= existing.authorityEpoch) throw failure("installation-control:epoch");
    }

    const bytes = encodeInstallationControl(control);
    const rootBeforeWrite = await rootStat(stateRoot, false, windowsAclVerifier);
    if (rootBeforeWrite === null || !sameIdentity(root, rootBeforeWrite)) throw failure("installation-control:root-race");
    const currentBytes = await readBounded(path);
    if (existingBytes === null ? currentBytes !== null :
        currentBytes === null || !sameIdentity(existingBytes.stat, currentBytes.stat) ||
        !sameBytes(existingBytes.bytes, currentBytes.bytes)) throw failure("installation-control:concurrent");

    await writeBoundedCanonicalFile(path, bytes, MAX_INSTALLATION_CONTROL_BYTES, () => failure("installation-control:bounded-write"));
    const loaded = await read();
    if (loaded === null || loaded.authorityEpoch !== control.authorityEpoch || loaded.installationId !== control.installationId) {
      throw failure("installation-control:write-readback");
    }
    return loaded;
  }

  async function remove(): Promise<void> {
    assertBoundLease();
    const root = await rootStat(stateRoot, false, windowsAclVerifier);
    if (root === null) {
      if (knownRoot !== undefined) throw failure("installation-control:root-missing");
      return;
    }
    assertStableRoot(root);
    const currentBytes = await readBounded(path);
    if (currentBytes === null) return;
    const loaded = decodeInstallationControl(currentBytes.bytes);
    sameRootEvidence(loaded, root);
    const current = await currentTarget(path);
    if (current === null || !sameIdentity(currentBytes.stat, current)) throw failure("installation-control:remove-race");
    await rm(path);
    await syncDirectory(stateRoot);
  }

  return Object.freeze({ path, encode: encodeInstallationControl, read, write, remove });
}
