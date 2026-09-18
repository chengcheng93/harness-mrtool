import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { writeAnchoredFile } from "../platform/anchored-file-writer.ts";
import { openNativeMutationExecutor } from "../platform/native-mutation-executor.ts";

const EXECUTABLE_NAME = "harness-mrtool" as const;
const MARKER_NAME = ".harness-mrtool-install.json" as const;
const STAGE_PREFIX = ".harness-mrtool-stage-";
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_MARKER_BYTES = 8 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const MAX_IDENTITY = (1n << 64n) - 1n;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mode: bigint;
  readonly uid: bigint;
}

interface StageState {
  readonly publicValue: ManagedPosixStage;
  readonly rootIdentity: FileIdentity;
  readonly stageIdentity: FileIdentity;
  readonly executableIdentity: FileIdentity;
  readonly markerIdentity: FileIdentity;
  readonly executableSha256: string;
  readonly markerSha256: string;
  readonly executableSize: number;
  readonly markerSize: number;
}

const stageStates = new WeakMap<object, StageState>();

function failure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "managed Darwin staging is unsafe", {
    field: "update.managedInstallation",
    expected: "a private, identity-pinned staged executable and marker",
    actual: "staged installation evidence rejected",
    safeNextStep: "Keep the current installation and run self-update repair.",
  });
}

function absoluteRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value || resolve(value) === resolve(value, "/..")) {
    throw failure();
  }
  return value;
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw failure();
  return value;
}

function bytes(value: unknown, maximum: number): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > maximum) throw failure();
  return Uint8Array.from(value);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mode === right.mode && left.uid === right.uid;
}

function copyIdentity(info: BigIntStats): FileIdentity {
  return Object.freeze({ dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid });
}

function privateOwner(info: FileIdentity): boolean {
  return info.uid === BigInt(process.getuid!());
}

function assertIdentityRange(info: FileIdentity): void {
  if (info.dev < 0n || info.ino < 1n || info.dev > MAX_IDENTITY || info.ino > MAX_IDENTITY) throw failure();
}

async function directoryIdentity(path: string, expected?: FileIdentity): Promise<FileIdentity> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true });
    const physical = await realpath(path);
    const after = await lstat(path, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() ||
        before.dev !== after.dev || before.ino !== after.ino || physical !== path ||
        before.uid !== BigInt(process.getuid!()) || (before.mode & 0o7777n) !== 0o700n) throw failure();
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
  const result = copyIdentity(before);
  assertIdentityRange(result);
  if (expected !== undefined && !sameIdentity(result, expected)) throw failure();
  return result;
}

async function fileIdentity(path: string, expected?: FileIdentity, mode?: bigint): Promise<FileIdentity> {
  try {
    const info = await lstat(path, { bigint: true });
    const physical = await realpath(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || physical !== path ||
        info.uid !== BigInt(process.getuid!()) || (mode !== undefined && (info.mode & 0o7777n) !== mode)) throw failure();
    const result = copyIdentity(info);
    assertIdentityRange(result);
    if (expected !== undefined && !exactIdentity(result, expected)) throw failure();
    return result;
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}

async function sealExecutable(path: string, expected: FileIdentity): Promise<FileIdentity> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n ||
        opened.dev !== expected.dev || opened.ino !== expected.ino || (opened.mode & 0o7777n) !== 0o600n) throw failure();
    await handle.chmod(0o500);
    await handle.sync();
    const finished = await handle.stat({ bigint: true });
    if (!finished.isFile() || finished.dev !== expected.dev || finished.ino !== expected.ino ||
        (finished.mode & 0o7777n) !== 0o500n) throw failure();
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
  const result = await fileIdentity(path, undefined, 0o500n);
  if (result.dev !== expected.dev || result.ino !== expected.ino || result.size !== expected.size || result.uid !== expected.uid) throw failure();
  return result;
}

async function readDigest(path: string, expected: FileIdentity, mode: bigint, maximum: number): Promise<string> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, READ_FLAGS);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n ||
        !exactIdentity(copyIdentity(opened), expected) || opened.size < 1n || opened.size > BigInt(maximum) ||
        (opened.mode & 0o7777n) !== mode) throw failure();
    const digest = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Number(opened.size)));
    let offset = 0;
    while (offset < Number(opened.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - offset), offset);
      if (result.bytesRead <= 0) throw failure();
      digest.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, Number(opened.size))).bytesRead !== 0) throw failure();
    const finished = await handle.stat({ bigint: true });
    const named = await lstat(path, { bigint: true });
    if (!exactIdentity(copyIdentity(finished), expected) || !exactIdentity(copyIdentity(named), expected) ||
        (await realpath(path)) !== path) throw failure();
    return digest.digest("hex");
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function assertStage(value: unknown): StageState {
  if (value === null || typeof value !== "object") throw failure();
  const state = stageStates.get(value);
  if (state === undefined || state.publicValue !== value) throw failure();
  return state;
}

async function observeStage(state: StageState): Promise<ManagedPosixStageObservation> {
  const root = await directoryIdentity(state.publicValue.installationDirectory, state.rootIdentity);
  await directoryIdentity(state.publicValue.stageDirectory, state.stageIdentity);
  const executable = await fileIdentity(state.publicValue.executablePath, state.executableIdentity, 0o500n);
  const marker = await fileIdentity(state.publicValue.markerPath, state.markerIdentity, 0o600n);
  const executableSha256 = await readDigest(state.publicValue.executablePath, executable, 0o500n, MAX_EXECUTABLE_BYTES);
  const markerSha256 = await readDigest(state.publicValue.markerPath, marker, 0o600n, MAX_MARKER_BYTES);
  if (!privateOwner(root) || executableSha256 !== state.executableSha256 || markerSha256 !== state.markerSha256) throw failure();
  return Object.freeze({
    stageDirectory: state.publicValue.stageDirectory,
    executablePath: state.publicValue.executablePath,
    markerPath: state.publicValue.markerPath,
    executableSha256,
    markerSha256,
    executableIdentity: Object.freeze({ dev: String(executable.dev), ino: String(executable.ino), size: String(executable.size) }),
    markerIdentity: Object.freeze({ dev: String(marker.dev), ino: String(marker.ino), size: String(marker.size) }),
  });
}

async function removeCreatedFile(path: string, expected: FileIdentity | undefined): Promise<void> {
  if (expected === undefined) return;
  try {
    const current = await fileIdentity(path, expected);
    if (exactIdentity(current, expected)) await rm(path);
  } catch {
    // Preserve uncertain evidence; never delete through a raced pathname.
  }
}

export interface ManagedPosixStageInput {
  readonly installationDirectory: string;
  readonly executableBytes: Uint8Array;
  readonly markerBytes: Uint8Array;
  readonly executableSha256: string;
  readonly markerSha256: string;
}

export interface ManagedPosixStage {
  readonly installationDirectory: string;
  readonly stageDirectory: string;
  readonly executablePath: string;
  readonly markerPath: string;
  readonly executableSha256: string;
  readonly markerSha256: string;
}

export interface ManagedPosixStageObservation {
  readonly stageDirectory: string;
  readonly executablePath: string;
  readonly markerPath: string;
  readonly executableSha256: string;
  readonly markerSha256: string;
  readonly executableIdentity: { readonly dev: string; readonly ino: string; readonly size: string };
  readonly markerIdentity: { readonly dev: string; readonly ino: string; readonly size: string };
}

/**
 * Materializes authenticated bytes in an identity-pinned private stage. It
 * deliberately does not replace the canonical executable, marker or active
 * pointer; publication belongs to the outer installation transaction.
 */
export async function stageManagedPosixCandidate(input: ManagedPosixStageInput): Promise<ManagedPosixStage> {
  if (process.platform !== "darwin") throw failure();
  const root = absoluteRoot(input.installationDirectory);
  const executableBytes = bytes(input.executableBytes, MAX_EXECUTABLE_BYTES);
  const markerBytes = bytes(input.markerBytes, MAX_MARKER_BYTES);
  const executableSha256 = hash(input.executableSha256);
  const markerSha256 = hash(input.markerSha256);
  if (createHash("sha256").update(executableBytes).digest("hex") !== executableSha256 ||
      createHash("sha256").update(markerBytes).digest("hex") !== markerSha256) throw failure();

  const executor = await openNativeMutationExecutor(root);
  let stageDirectory: string | undefined;
  let rootIdentity: FileIdentity | undefined;
  let stageIdentity: FileIdentity | undefined;
  let executableIdentity: FileIdentity | undefined;
  let markerIdentity: FileIdentity | undefined;
  let result: ManagedPosixStage | undefined;
  let operationError: unknown;
  try {
    try {
      rootIdentity = await directoryIdentity(root);
      stageDirectory = resolve(root, `${STAGE_PREFIX}${randomUUID()}`);
      await mkdir(stageDirectory, { mode: 0o700 });
      stageIdentity = await directoryIdentity(stageDirectory);
      await writeAnchoredFile({ directory: stageDirectory, expectedIdentity: { dev: stageIdentity.dev, ino: stageIdentity.ino }, name: EXECUTABLE_NAME, bytes: executableBytes });
      executableIdentity = await fileIdentity(resolve(stageDirectory, EXECUTABLE_NAME), undefined, 0o600n);
      executableIdentity = await sealExecutable(resolve(stageDirectory, EXECUTABLE_NAME), executableIdentity);
      await writeAnchoredFile({ directory: stageDirectory, expectedIdentity: { dev: stageIdentity.dev, ino: stageIdentity.ino }, name: MARKER_NAME, bytes: markerBytes });
      markerIdentity = await fileIdentity(resolve(stageDirectory, MARKER_NAME), undefined, 0o600n);
      const publicValue = Object.freeze({
        installationDirectory: root,
        stageDirectory,
        executablePath: resolve(stageDirectory, EXECUTABLE_NAME),
        markerPath: resolve(stageDirectory, MARKER_NAME),
        executableSha256,
        markerSha256,
      });
      const state: StageState = {
        publicValue, rootIdentity, stageIdentity, executableIdentity, markerIdentity,
        executableSha256, markerSha256, executableSize: executableBytes.byteLength, markerSize: markerBytes.byteLength,
      };
      stageStates.set(publicValue, state);
      await observeStage(state);
      result = publicValue;
    } catch (error) {
      if (stageDirectory !== undefined && stageIdentity !== undefined) {
        await removeCreatedFile(resolve(stageDirectory, MARKER_NAME), markerIdentity);
        await removeCreatedFile(resolve(stageDirectory, EXECUTABLE_NAME), executableIdentity);
        try {
          const current = await directoryIdentity(stageDirectory, stageIdentity);
          if (sameIdentity(current, stageIdentity)) await rmdir(stageDirectory);
        } catch {
          // Preserve uncertain or non-empty evidence for explicit repair.
        }
      }
      operationError = error;
    }
  } finally {
    try {
      await executor.close();
    } catch (error) {
      if (operationError === undefined) operationError = error;
    }
  }
  if (operationError !== undefined) throw operationError instanceof ToolError ? operationError : failure();
  if (result === undefined) throw failure();
  return result;
}

export async function verifyManagedPosixStage(stage: ManagedPosixStage): Promise<ManagedPosixStageObservation> {
  if (process.platform !== "darwin") throw failure();
  const state = assertStage(stage);
  const executor = await openNativeMutationExecutor(state.publicValue.installationDirectory);
  let result: ManagedPosixStageObservation | undefined;
  let operationError: unknown;
  try {
    try {
      result = await observeStage(state);
    } catch (error) {
      operationError = error;
    }
  } finally {
    try {
      await executor.close();
    } catch (error) {
      if (operationError === undefined) operationError = error;
    }
  }
  if (operationError !== undefined) throw operationError instanceof ToolError ? operationError : failure();
  if (result === undefined) throw failure();
  return result;
}

export async function removeManagedPosixStage(stage: ManagedPosixStage): Promise<void> {
  if (process.platform !== "darwin") throw failure();
  const state = assertStage(stage);
  const executor = await openNativeMutationExecutor(state.publicValue.installationDirectory);
  let operationError: unknown;
  try {
    try {
      await observeStage(state);
      await rm(state.publicValue.markerPath);
      await rm(state.publicValue.executablePath);
      await directoryIdentity(state.publicValue.stageDirectory, state.stageIdentity);
      await rmdir(state.publicValue.stageDirectory);
    } catch (error) {
      operationError = error;
    }
  } finally {
    try {
      await executor.close();
    } catch (error) {
      if (operationError === undefined) operationError = error;
    }
  }
  if (operationError !== undefined) throw operationError instanceof ToolError ? operationError : failure();
}

