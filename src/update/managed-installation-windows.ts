import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { writeAnchoredFile } from "../platform/anchored-file-writer.ts";
import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import {
  recoverWindowsExecutable,
  rotateWindowsExecutable,
  type WindowsExecutablePaths,
} from "./windows-helper.ts";
import { validateReleaseSetSnapshot, type ReleaseSetSnapshot } from "./cache.ts";
import { authenticateReleaseSnapshot, type ReleaseSnapshotOptions } from "./release-set-verifier.ts";

const EXECUTABLE_NAME = "harness-mrtool.exe" as const;
const STAGED_EXECUTABLE_NAME = "harness-mrtool.exe.new" as const;
const OLD_EXECUTABLE_NAME = "harness-mrtool.exe.old" as const;
const MARKER_NAME = ".harness-mrtool-install.json" as const;
const STAGED_MARKER_NAME = ".harness-mrtool-install.json.new" as const;
const OLD_MARKER_NAME = ".harness-mrtool-install.json.old" as const;
const MAX_EXECUTABLE_BYTES = 256 * 1024 * 1024;
const MAX_MARKER_BYTES = 8 * 1024;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
}

interface WindowsStageState {
  readonly publicValue: ManagedWindowsStage;
  readonly rootIdentity: FileIdentity;
  readonly stagedExecutableIdentity: FileIdentity;
  readonly stagedMarkerIdentity: FileIdentity;
}

const stageStates = new WeakMap<object, WindowsStageState>();

function failure(actual = "managed-installation:stage"): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "managed Windows staging is unsafe", {
    field: "update.managedInstallation",
    expected: "a private, identity-pinned staged Windows executable and marker",
    actual,
    safeNextStep: "Keep the current installation and run self-update repair.",
  });
}

function absoluteRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value || dirname(value) === value) throw failure();
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function copyIdentity(info: BigIntStats): FileIdentity {
  return Object.freeze({ dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs });
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeNs === right.mtimeNs;
}

async function directoryIdentity(path: string, expected?: FileIdentity): Promise<FileIdentity> {
  try {
    const before = await lstat(path, { bigint: true }) as BigIntStats;
    const physical = await realpath(path);
    const after = await lstat(path, { bigint: true }) as BigIntStats;
    if (!before.isDirectory() || before.isSymbolicLink() || !after.isDirectory() || after.isSymbolicLink() ||
        !samePath(physical, path) || before.dev !== after.dev || before.ino !== after.ino) throw failure();
    const result = copyIdentity(before);
    if (expected !== undefined && (result.dev !== expected.dev || result.ino !== expected.ino)) throw failure();
    return result;
  } catch (error) {
    throw error instanceof ToolError ? error : failure("managed-installation:directory");
  }
}

async function fileIdentity(path: string, expected?: FileIdentity): Promise<FileIdentity> {
  try {
    const before = await lstat(path, { bigint: true }) as BigIntStats;
    const physical = await realpath(path);
    const after = await lstat(path, { bigint: true }) as BigIntStats;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || !samePath(physical, path) ||
        before.dev !== after.dev || before.ino !== after.ino) throw failure();
    const result = copyIdentity(before);
    if (expected !== undefined && !sameIdentity(result, expected)) throw failure();
    return result;
  } catch (error) {
    throw error instanceof ToolError ? error : failure("managed-installation:file");
  }
}

async function readDigest(path: string, expected: FileIdentity, maximum: number): Promise<string> {
  if (expected.size < 1n || expected.size > BigInt(maximum)) throw failure();
  const handle = await open(path, READ_FLAGS);
  try {
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || !sameIdentity(copyIdentity(opened), expected)) {
      throw failure();
    }
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(Math.min(64 * 1024, Number(expected.size)));
    let offset = 0;
    while (offset < Number(expected.size)) {
      const result = await handle.read(buffer, 0, Math.min(buffer.length, Number(expected.size) - offset), offset);
      if (result.bytesRead <= 0) throw failure();
      hash.update(buffer.subarray(0, result.bytesRead));
      offset += result.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, Number(expected.size))).bytesRead !== 0) throw failure();
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const named = await lstat(path, { bigint: true }) as BigIntStats;
    if (!sameIdentity(copyIdentity(after), expected) || !sameIdentity(copyIdentity(named), expected)) throw failure();
    return hash.digest("hex");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function markerBytes(
  snapshot: ReleaseSetSnapshot,
  authenticated: Awaited<ReturnType<typeof authenticateReleaseSnapshot>>,
  executableSha256: string,
): Uint8Array {
  const manifest = authenticated.verified.manifest;
  return new TextEncoder().encode(`${canonicalizeJson({
    schemaVersion: 1,
    repository: `${manifest.repository.owner}/${manifest.repository.name}`,
    tag: manifest.components.cli.tag,
    archiveSha256: snapshot.record.cliSha256,
    executableSha256,
  })}\n`);
}

function executablePaths(root: string): WindowsExecutablePaths {
  return Object.freeze({
    canonical: resolve(root, EXECUTABLE_NAME),
    staged: resolve(root, STAGED_EXECUTABLE_NAME),
    old: resolve(root, OLD_EXECUTABLE_NAME),
  });
}

function markerPaths(root: string): WindowsExecutablePaths {
  return Object.freeze({
    canonical: resolve(root, MARKER_NAME),
    staged: resolve(root, STAGED_MARKER_NAME),
    old: resolve(root, OLD_MARKER_NAME),
  });
}

export interface AuthenticatedManagedWindowsStageInput extends ReleaseSnapshotOptions {
  readonly installationDirectory: string;
  readonly snapshot: ReleaseSetSnapshot;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export interface ManagedWindowsStage {
  readonly installationDirectory: string;
  readonly executablePath: string;
  readonly stagedExecutablePath: string;
  readonly markerPath: string;
  readonly stagedMarkerPath: string;
  readonly executableSha256: string;
  readonly markerSha256: string;
}

export interface ManagedWindowsStageObservation {
  readonly executableSha256: string;
  readonly markerSha256: string;
  readonly executableIdentity: { readonly dev: string; readonly ino: string; readonly size: string };
  readonly markerIdentity: { readonly dev: string; readonly ino: string; readonly size: string };
}

export interface ManagedWindowsPublication {
  readonly executablePath: string;
  readonly markerPath: string;
  readonly executableSha256: string;
  readonly markerSha256: string;
}

async function assertStage(stage: ManagedWindowsStage): Promise<WindowsStageState> {
  if (process.platform !== "win32" || stage === null || typeof stage !== "object") throw failure();
  const state = stageStates.get(stage as object);
  if (state === undefined || state.publicValue !== stage) throw failure();
  await directoryIdentity(stage.installationDirectory, state.rootIdentity);
  await fileIdentity(stage.stagedExecutablePath, state.stagedExecutableIdentity);
  await fileIdentity(stage.stagedMarkerPath, state.stagedMarkerIdentity);
  return state;
}

export async function stageAuthenticatedManagedWindowsCandidate(
  input: AuthenticatedManagedWindowsStageInput,
): Promise<ManagedWindowsStage> {
  if (process.platform !== "win32") throw failure();
  try {
    const root = absoluteRoot(input.installationDirectory);
    const owned = validateReleaseSetSnapshot({
      record: input.snapshot.record,
      cliBytes: input.snapshot.cliBytes,
      templateBytes: input.snapshot.templateBytes,
      receiptBytes: input.snapshot.receiptBytes,
    });
    const authenticated = await authenticateReleaseSnapshot(owned, input);
    const executableBytes = authenticated.executableBytes;
    const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
    const marker = markerBytes(owned, authenticated, executableSha256);
    const markerSha256 = createHash("sha256").update(marker).digest("hex");
    await ensurePrivateStateDirectory(root, input.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: input.windowsAclVerifier });
    const rootIdentity = await directoryIdentity(root);
    await writeAnchoredFile({ directory: root, expectedIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino }, name: STAGED_EXECUTABLE_NAME, bytes: executableBytes });
    await writeAnchoredFile({ directory: root, expectedIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino }, name: STAGED_MARKER_NAME, bytes: marker });
    const stagedExecutableIdentity = await fileIdentity(resolve(root, STAGED_EXECUTABLE_NAME));
    const stagedMarkerIdentity = await fileIdentity(resolve(root, STAGED_MARKER_NAME));
    const publicValue = Object.freeze({
      installationDirectory: root,
      executablePath: resolve(root, EXECUTABLE_NAME),
      stagedExecutablePath: resolve(root, STAGED_EXECUTABLE_NAME),
      markerPath: resolve(root, MARKER_NAME),
      stagedMarkerPath: resolve(root, STAGED_MARKER_NAME),
      executableSha256,
      markerSha256,
    });
    stageStates.set(publicValue, Object.freeze({ publicValue, rootIdentity, stagedExecutableIdentity, stagedMarkerIdentity }));
    return publicValue;
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}

export async function verifyManagedWindowsStage(stage: ManagedWindowsStage): Promise<ManagedWindowsStageObservation> {
  try {
    const state = await assertStage(stage);
    const executable = await fileIdentity(stage.stagedExecutablePath, state.stagedExecutableIdentity);
    const marker = await fileIdentity(stage.stagedMarkerPath, state.stagedMarkerIdentity);
    const executableSha256 = await readDigest(stage.stagedExecutablePath, executable, MAX_EXECUTABLE_BYTES);
    const markerSha256 = await readDigest(stage.stagedMarkerPath, marker, MAX_MARKER_BYTES);
    if (executableSha256 !== stage.executableSha256 || markerSha256 !== stage.markerSha256) throw failure();
    return Object.freeze({
      executableSha256,
      markerSha256,
      executableIdentity: { dev: String(executable.dev), ino: String(executable.ino), size: String(executable.size) },
      markerIdentity: { dev: String(marker.dev), ino: String(marker.ino), size: String(marker.size) },
    });
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}

export async function publishManagedWindowsCandidate(stage: ManagedWindowsStage): Promise<ManagedWindowsPublication> {
  try {
    await assertStage(stage);
    await recoverWindowsExecutable(executablePaths(stage.installationDirectory), { canonicalMode: 0o755 });
    await recoverWindowsExecutable(markerPaths(stage.installationDirectory), { canonicalMode: 0o600 });
    await rotateWindowsExecutable(executablePaths(stage.installationDirectory), { canonicalMode: 0o755 });
    await rotateWindowsExecutable(markerPaths(stage.installationDirectory), { canonicalMode: 0o600 });
    const executable = await fileIdentity(stage.executablePath);
    const marker = await fileIdentity(stage.markerPath);
    if (await readDigest(stage.executablePath, executable, MAX_EXECUTABLE_BYTES) !== stage.executableSha256 ||
        await readDigest(stage.markerPath, marker, MAX_MARKER_BYTES) !== stage.markerSha256) throw failure();
    return Object.freeze({
      executablePath: stage.executablePath,
      markerPath: stage.markerPath,
      executableSha256: stage.executableSha256,
      markerSha256: stage.markerSha256,
    });
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}

export async function removeManagedWindowsStage(stage: ManagedWindowsStage): Promise<void> {
  try {
    const state = await assertStage(stage);
    for (const [path, identity] of [[stage.stagedExecutablePath, state.stagedExecutableIdentity], [stage.stagedMarkerPath, state.stagedMarkerIdentity]] as const) {
      try {
        const current = await fileIdentity(path, identity);
        if (sameIdentity(current, identity)) await rm(path);
      } catch {
        // Preserve uncertain evidence; a raced path is never removed by name.
      }
    }
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}
