import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rm, rmdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson } from "../contracts/jcs.ts";
import { moveAnchoredFile, type AnchoredMoveFileIdentity } from "../platform/anchored-file-mover.ts";
import { writeAnchoredFile } from "../platform/anchored-file-writer.ts";
import { openNativeMutationExecutor } from "../platform/native-mutation-executor.ts";
import { validateReleaseSetSnapshot, type ReleaseSetSnapshot } from "./cache.ts";
import { authenticateReleaseSnapshot, type ReleaseSnapshotOptions } from "./release-set-verifier.ts";
import type {InstallationJournal} from "./installation-journal.ts";

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
      !isAbsolute(value) || resolve(value) !== value || resolve(value) === "/") {
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

export interface AuthenticatedManagedPosixStageInput extends ReleaseSnapshotOptions {
  readonly installationDirectory: string;
  readonly snapshot: ReleaseSetSnapshot;
}

export interface ManagedPosixStage {
  readonly installationDirectory: string;
  readonly stageDirectory: string;
  readonly executablePath: string;
  readonly markerPath: string;
  readonly executableSha256: string;
  readonly markerSha256: string;
}

export interface ManagedPosixPreviousEvidence {
  readonly executable: AnchoredMoveFileIdentity;
  readonly marker: AnchoredMoveFileIdentity;
}

export interface ManagedPosixPublicationInput {
  readonly stage: ManagedPosixStage;
  readonly attemptId: string;
  readonly previous: { readonly executable: AnchoredMoveFileIdentity | null; readonly marker: AnchoredMoveFileIdentity | null };
}

export interface ManagedPosixPublication {
  readonly attemptId: string;
  readonly canonicalExecutableIdentity: AnchoredMoveFileIdentity;
  readonly canonicalMarkerIdentity: AnchoredMoveFileIdentity;
  readonly previous: ManagedPosixPreviousEvidence | null;
  readonly stagedDirectory: string;
}

export interface ManagedPosixRollbackInput {
  readonly installationDirectory: string;
  readonly publishedAttemptId: string;
  readonly rollbackAttemptId: string;
  readonly current: ManagedPosixPreviousEvidence;
  readonly previous: ManagedPosixPreviousEvidence;
}

export interface ManagedPosixRollback {
  readonly rollbackAttemptId: string;
  readonly retainedCurrent: ManagedPosixPreviousEvidence;
  readonly restoredPrevious: ManagedPosixPreviousEvidence;
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
export async function stageAuthenticatedManagedPosixCandidate(
  input: AuthenticatedManagedPosixStageInput,
): Promise<ManagedPosixStage> {
  if (process.platform !== "darwin") throw failure();
  try {
    const owned = validateReleaseSetSnapshot({
      record: input.snapshot.record,
      cliBytes: input.snapshot.cliBytes,
      templateBytes: input.snapshot.templateBytes,
      receiptBytes: input.snapshot.receiptBytes,
    });
    const authenticated = await authenticateReleaseSnapshot(owned, input);
    const executableBytes = authenticated.executableBytes;
    const executableSha256 = createHash("sha256").update(executableBytes).digest("hex");
    const manifest = authenticated.verified.manifest;
    const marker = new TextEncoder().encode(`${canonicalizeJson({
      schemaVersion: 1,
      repository: `${manifest.repository.owner}/${manifest.repository.name}`,
      tag: manifest.components.cli.tag,
      archiveSha256: owned.record.cliSha256,
      executableSha256,
    })}
`);
    const markerSha256 = createHash("sha256").update(marker).digest("hex");
    return stageManagedPosixCandidate({
      installationDirectory: input.installationDirectory,
      executableBytes,
      markerBytes: marker,
      executableSha256,
      markerSha256,
    });
  } catch (error) {
    throw error instanceof ToolError ? error : failure();
  }
}

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
        executableSha256, markerSha256,
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

async function optionalFileIdentity(path: string, mode: bigint): Promise<FileIdentity | null> {
  try {
    await lstat(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw failure();
  }
  return fileIdentity(path, undefined, mode);
}

function sameExpectedPair(
  actual: { readonly executable: FileIdentity | null; readonly marker: FileIdentity | null },
  expected: { readonly executable: AnchoredMoveFileIdentity | null; readonly marker: AnchoredMoveFileIdentity | null },
): boolean {
  if ((actual.executable === null) !== (expected.executable === null) ||
      (actual.marker === null) !== (expected.marker === null)) return false;
  if (actual.executable !== null && expected.executable !== null && !exactIdentity(actual.executable, expected.executable)) return false;
  if (actual.marker !== null && expected.marker !== null && !exactIdentity(actual.marker, expected.marker)) return false;
  return true;
}

function publicationNames(attemptId: string): { readonly executable: string; readonly marker: string } {
  if (typeof attemptId !== "string" || !/^[a-f0-9]{32}$/u.test(attemptId)) throw failure();
  return Object.freeze({
    executable: `harness-mrtool.previous-${attemptId}`,
    marker: `.harness-mrtool-install.previous-${attemptId}`,
  });
}

/** Re-observe the durable predecessor pair before recovering an uncommitted publication. */
export async function verifyManagedPosixPublicationBackups(rootDirectory: string, journal: InstallationJournal): Promise<void> {
  if (process.platform !== "darwin" || journal.platform !== "darwin-arm64") throw failure();
  const root = absoluteRoot(rootDirectory);
  const executor = await openNativeMutationExecutor(root);
  try {
    const pinnedRoot = await directoryIdentity(root);
    if (String(pinnedRoot.dev) !== journal.roots.installation.dev || String(pinnedRoot.ino) !== journal.roots.installation.ino) throw failure();
    const names = publicationNames(journal.attemptId);
    for (const [slotName, name, mode, maximum] of [
      ["previous-executable", names.executable, 0o500n, MAX_EXECUTABLE_BYTES],
      ["previous-marker", names.marker, 0o600n, MAX_MARKER_BYTES],
    ] as const) {
      const slot = journal.slots.find(value => value.name === slotName);
      const path = resolve(root, name);
      const identity = await fileIdentity(path, undefined, mode);
      if (slot?.state !== "created" || String(identity.dev) !== slot.identity.dev || String(identity.ino) !== slot.identity.ino ||
          identity.size !== BigInt(slot.expectedSize) || await readDigest(path, identity, mode, maximum) !== slot.expectedSha256) throw failure();
    }
    await directoryIdentity(root, pinnedRoot);
  } finally { await executor.close(); }
}

/**
 * Publishes only the canonical executable/marker pair. It has no active-pointer
 * or cache authority. A failure deliberately leaves the exact stage/backup
 * evidence for the outer journal and recovery coordinator.
 */
export async function publishManagedPosixCandidate(input: ManagedPosixPublicationInput): Promise<ManagedPosixPublication> {
  if (process.platform !== "darwin") throw failure();
  const state = assertStage(input.stage);
  const names = publicationNames(input.attemptId);
  const executor = await openNativeMutationExecutor(state.publicValue.installationDirectory);
  let result: ManagedPosixPublication | undefined;
  let operationError: unknown;
  try {
    try {
      const root = await directoryIdentity(state.publicValue.installationDirectory, state.rootIdentity);
      await observeStage(state);
      const current = {
        executable: await optionalFileIdentity(resolve(state.publicValue.installationDirectory, EXECUTABLE_NAME), 0o500n),
        marker: await optionalFileIdentity(resolve(state.publicValue.installationDirectory, MARKER_NAME), 0o600n),
      };
      if (!sameExpectedPair(current, input.previous)) throw failure();
      const previous = current.executable === null || current.marker === null ? null : Object.freeze({
        executable: current.executable,
        marker: current.marker,
      });
      if (previous !== null) {
        await moveAnchoredFile({
          rootDirectory: state.publicValue.installationDirectory,
          rootIdentity: { dev: root.dev, ino: root.ino },
          sourceDirectory: state.publicValue.installationDirectory,
          sourceDirectoryIdentity: { dev: root.dev, ino: root.ino },
          sourceName: EXECUTABLE_NAME,
          sourceIdentity: current.executable!,
          destinationName: names.executable,
          destination: { kind: "absent" },
        });
        await moveAnchoredFile({
          rootDirectory: state.publicValue.installationDirectory,
          rootIdentity: { dev: root.dev, ino: root.ino },
          sourceDirectory: state.publicValue.installationDirectory,
          sourceDirectoryIdentity: { dev: root.dev, ino: root.ino },
          sourceName: MARKER_NAME,
          sourceIdentity: current.marker!,
          destinationName: names.marker,
          destination: { kind: "absent" },
        });
      }
      await moveAnchoredFile({
        rootDirectory: state.publicValue.installationDirectory,
        rootIdentity: { dev: root.dev, ino: root.ino },
        sourceDirectory: state.publicValue.stageDirectory,
        sourceDirectoryIdentity: { dev: state.stageIdentity.dev, ino: state.stageIdentity.ino },
        sourceName: EXECUTABLE_NAME,
        sourceIdentity: state.executableIdentity,
        destinationName: EXECUTABLE_NAME,
        destination: { kind: "absent" },
      });
      await moveAnchoredFile({
        rootDirectory: state.publicValue.installationDirectory,
        rootIdentity: { dev: root.dev, ino: root.ino },
        sourceDirectory: state.publicValue.stageDirectory,
        sourceDirectoryIdentity: { dev: state.stageIdentity.dev, ino: state.stageIdentity.ino },
        sourceName: MARKER_NAME,
        sourceIdentity: state.markerIdentity,
        destinationName: MARKER_NAME,
        destination: { kind: "absent" },
      });
      const canonicalExecutable = await fileIdentity(resolve(state.publicValue.installationDirectory, EXECUTABLE_NAME), undefined, 0o500n);
      const canonicalMarker = await fileIdentity(resolve(state.publicValue.installationDirectory, MARKER_NAME), undefined, 0o600n);
      if (await readDigest(resolve(state.publicValue.installationDirectory, EXECUTABLE_NAME), canonicalExecutable, 0o500n, MAX_EXECUTABLE_BYTES) !== state.executableSha256 ||
          await readDigest(resolve(state.publicValue.installationDirectory, MARKER_NAME), canonicalMarker, 0o600n, MAX_MARKER_BYTES) !== state.markerSha256 ||
          !privateOwner(root)) throw failure();
      result = Object.freeze({
        attemptId: input.attemptId,
        canonicalExecutableIdentity: canonicalExecutable,
        canonicalMarkerIdentity: canonicalMarker,
        previous,
        stagedDirectory: state.publicValue.stageDirectory,
      });
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

/**
 * Restores the identity-pinned previous backup pair. Authorization and active
 * pointer publication remain outside this primitive; a failure preserves every
 * surviving pair for Journal recovery.
 */
export async function restoreManagedPosixPrevious(input: ManagedPosixRollbackInput): Promise<ManagedPosixRollback> {
  if (process.platform !== "darwin") throw failure();
  const root = absoluteRoot(input.installationDirectory);
  const publishedNames = publicationNames(input.publishedAttemptId);
  const rollbackNames = publicationNames(input.rollbackAttemptId);
  if (input.publishedAttemptId === input.rollbackAttemptId) throw failure();
  const executor = await openNativeMutationExecutor(root);
  let result: ManagedPosixRollback | undefined;
  let operationError: unknown;
  try {
    try {
      const rootIdentity = await directoryIdentity(root);
      const currentExecutable = await fileIdentity(resolve(root, EXECUTABLE_NAME), input.current.executable, 0o500n);
      const currentMarker = await fileIdentity(resolve(root, MARKER_NAME), input.current.marker, 0o600n);
      const previousExecutable = await fileIdentity(resolve(root, publishedNames.executable), input.previous.executable, 0o500n);
      const previousMarker = await fileIdentity(resolve(root, publishedNames.marker), input.previous.marker, 0o600n);
      await moveAnchoredFile({
        rootDirectory: root,
        rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceDirectory: root,
        sourceDirectoryIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceName: EXECUTABLE_NAME,
        sourceIdentity: currentExecutable,
        destinationName: rollbackNames.executable,
        destination: { kind: "absent" },
      });
      await moveAnchoredFile({
        rootDirectory: root,
        rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceDirectory: root,
        sourceDirectoryIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceName: MARKER_NAME,
        sourceIdentity: currentMarker,
        destinationName: rollbackNames.marker,
        destination: { kind: "absent" },
      });
      await moveAnchoredFile({
        rootDirectory: root,
        rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceDirectory: root,
        sourceDirectoryIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceName: publishedNames.executable,
        sourceIdentity: previousExecutable,
        destinationName: EXECUTABLE_NAME,
        destination: { kind: "absent" },
      });
      await moveAnchoredFile({
        rootDirectory: root,
        rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceDirectory: root,
        sourceDirectoryIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino },
        sourceName: publishedNames.marker,
        sourceIdentity: previousMarker,
        destinationName: MARKER_NAME,
        destination: { kind: "absent" },
      });
      const restoredExecutable = await fileIdentity(resolve(root, EXECUTABLE_NAME), undefined, 0o500n);
      const restoredMarker = await fileIdentity(resolve(root, MARKER_NAME), undefined, 0o600n);
      if (!exactIdentity(restoredExecutable, previousExecutable) || !exactIdentity(restoredMarker, previousMarker)) throw failure();
      result = Object.freeze({
        rollbackAttemptId: input.rollbackAttemptId,
        retainedCurrent: Object.freeze({ executable: currentExecutable, marker: currentMarker }),
        restoredPrevious: Object.freeze({ executable: restoredExecutable, marker: restoredMarker }),
      });
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
      await directoryIdentity(state.publicValue.installationDirectory, state.rootIdentity);
      const present = await lstat(state.publicValue.stageDirectory).catch(error => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      });
      if (present !== null) {
        await directoryIdentity(state.publicValue.stageDirectory, state.stageIdentity);
        // Publication moves either leaf out. Missing leaves are not damage, but
        // a remaining leaf must still have the original identity AND bytes.
        const executable = await optionalFileIdentity(state.publicValue.executablePath, 0o500n);
        const marker = await optionalFileIdentity(state.publicValue.markerPath, 0o600n);
        if (executable !== null && (!exactIdentity(executable, state.executableIdentity) ||
            await readDigest(state.publicValue.executablePath, executable, 0o500n, MAX_EXECUTABLE_BYTES) !== state.executableSha256)) throw failure();
        if (marker !== null && (!exactIdentity(marker, state.markerIdentity) ||
            await readDigest(state.publicValue.markerPath, marker, 0o600n, MAX_MARKER_BYTES) !== state.markerSha256)) throw failure();
        await directoryIdentity(state.publicValue.stageDirectory, state.stageIdentity);
        if (marker !== null) await rm(state.publicValue.markerPath);
        if (executable !== null) await rm(state.publicValue.executablePath);
        await directoryIdentity(state.publicValue.stageDirectory, state.stageIdentity);
        await rmdir(state.publicValue.stageDirectory);
      }
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

