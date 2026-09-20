import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { constants } from "node:fs";
import { copyFile, lstat, readFile, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { withUpdateLock } from "../platform/lock.ts";
import type { ProcessLockLease } from "../platform/process-lock.ts";
import {
  systemProcessIdentityProvider,
  waitForProcessExit,
  type ProcessIdentity,
} from "../platform/process-identity.ts";
import { UpdateCache } from "./cache.ts";
import { createReleaseSetSnapshotVerifier } from "./release-set-verifier.ts";
import { decodeWindowsPersistenceDescriptor } from "./windows-persistence-descriptor.ts";
import {
  advanceInstallationJournalPhase,
  sealInstallationSettlement,
} from "./installation-journal-coordination.ts";
import { createInstallationJournalStore, type InstallationJournalStore } from "./installation-journal-store.ts";
import { tupleDigest } from "./journal.ts";
import {
  advanceWindowsLaunchInJournal,
  markWindowsExecutionPending,
  reserveWindowsLaunch,
} from "./windows-installation-transition.ts";
import {
  createWindowsLaunchReservationInput,
  createWindowsPersistenceDescriptor,
  observeWindowsPersistenceDescriptor,
  writeWindowsPersistenceDescriptor,
  WINDOWS_LAUNCH_DESCRIPTOR_FILENAME,
} from "./windows-persistence-handoff.ts";
import { validateInstallationJournal, type InstallationJournal, type InstallationProcessIdentity } from "./installation-journal.ts";
import {
  publishManagedWindowsCandidate,
  rehydrateAuthenticatedManagedWindowsCandidate,
  verifyManagedWindowsStage,
} from "./managed-installation-windows.ts";
import { validateWindowsInstallationRoot } from "./windows-inner-journal.ts";
import { verifyInstalledRelease } from "./installed-release-verification.ts";

const HELPER_PREFIX = ".harness-mrtool-helper-";
const READY_PREFIX = "READY\t";
const READY_TIMEOUT_MS = 10_000;
const MAX_READY_BYTES = 256;
const HELPER_CLOSE_TIMEOUT_MS = 5_000;

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Windows persistence helper is unsafe", {
    field: "update.windowsHelper",
    expected: "a verified detached helper bound to one admitted installation journal",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function absolute(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value) throw failure(`${field}-path-invalid`);
  return value;
}

function nonce(): string {
  return randomBytes(16).toString("hex");
}

function processIdentity(value: ProcessIdentity, launchNonce: string): InstallationProcessIdentity {
  return Object.freeze({ pid: value.pid, startKey: value.startKey, launchNonce });
}

function helperPath(installationDirectory: string, launchId: string): string {
  const root = absolute(installationDirectory, "installation");
  if (!/^[a-f0-9]{32}$/u.test(launchId)) throw failure("launch-id-invalid");
  return resolve(root, `${HELPER_PREFIX}${launchId}.exe`);
}

export type WindowsPersistenceRecoveryAction =
  | "settle-admitted"
  | "resume-publication"
  | "resume-commit"
  | "cleanup-committed";

function recoveryFailure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "windows persistence recovery is unsafe", {
    field: "update.windowsHelper.recovery",
    expected: "a bounded, contiguous recovery phase for one admitted Windows handoff",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

/**
 * Classify only durable, already-validated handoff states. This is a pure
 * decision point: it performs no I/O and grants no mutation authority. The
 * caller must still re-observe every bound before taking the returned step.
 */
export function classifyWindowsPersistenceRecovery(
  value: unknown,
): WindowsPersistenceRecoveryAction {
  try {
    const journal = validateInstallationJournal(value);
    if (journal.platform !== "windows-x64" || journal.windows === null || journal.windows.launch === null) {
      throw recoveryFailure("not-windows-handoff");
    }
    const launch = journal.windows.launch;
    if (journal.phase === "execution-pending") {
      if (launch.state === "admitted" && launch.settlement.state === "unsettled") return "settle-admitted";
      if (launch.state === "completed" && launch.settlement.state === "settled") return "resume-publication";
      throw recoveryFailure("execution-pending-launch-state");
    }
    if (["publish-intent", "canonical-published", "marker-published"].includes(journal.phase)) {
      if (launch.state !== "completed" || launch.settlement.state !== "settled") throw recoveryFailure("publication-launch-state");
      return "resume-publication";
    }
    if (journal.phase === "commit-intent") {
      if (launch.state !== "completed" || launch.settlement.state !== "settled") throw recoveryFailure("commit-launch-state");
      return "resume-commit";
    }
    if (journal.phase === "committed") {
      if (launch.state !== "completed" || launch.settlement.state !== "settled" || journal.outcome !== "next") {
        throw recoveryFailure("committed-launch-state");
      }
      return "cleanup-committed";
    }
    throw recoveryFailure(`phase:${journal.phase}`);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw recoveryFailure("malformed-journal");
  }
}

function childLaunchEvidence(
  journal: InstallationJournal,
  state: "registered" | "claimed" | "ack-issued" | "admitted",
  child: InstallationProcessIdentity,
  grantSha256: string | null,
): NonNullable<NonNullable<InstallationJournal["windows"]>["launch"]> {
  const launch = journal.windows?.launch;
  if (launch === null || launch === undefined) throw failure("launch-not-reserved");
  return Object.freeze({
    ...launch,
    authorityEpoch: journal.control.authorityEpoch + 1,
    expectedRevision: journal.revision + 1,
    child: Object.freeze({ ...child }),
    grantSha256,
    state,
    exitCode: null,
    settlement: Object.freeze({ state: "unsettled" as const }),
  });
}

type HelperChild = ChildProcessByStdio<null, Readable, null>;

async function terminateHelperProcess(child: HelperChild, closePromise: Promise<void>): Promise<void> {
  child.stdout.destroy();
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill();
    } catch {
      // The bounded close wait below remains the authoritative settlement check.
    }
  }
  await Promise.race([
    closePromise,
    new Promise<void>((resolvePromise) => setTimeout(resolvePromise, HELPER_CLOSE_TIMEOUT_MS)),
  ]);
}

async function waitReady(child: HelperChild): Promise<InstallationProcessIdentity> {
  return await new Promise<InstallationProcessIdentity>((resolvePromise, rejectPromise) => {
    let bytes = "";
    let settled = false;
    const timer = setTimeout(() => finish(new Error("helper-ready-timeout")), READY_TIMEOUT_MS);
    const finish = (error: Error | undefined, value?: InstallationProcessIdentity) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stdout.off("error", onError);
      child.off("error", onChildError);
      child.off("close", onClose);
      if (error === undefined && value !== undefined) resolvePromise(value);
      else rejectPromise(failure(error?.message ?? "helper-ready-invalid"));
    };
    const onData = (chunk: Buffer | string) => {
      bytes += chunk.toString("ascii");
      if (bytes.length > MAX_READY_BYTES) return finish(new Error("helper-ready-too-large"));
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      const line = bytes.slice(0, end);
      const fields = line.split("\t");
      const pidText = fields[1];
      const startKey = fields[2];
      const launchNonce = fields[3];
      if (fields.length !== 4 || fields[0] !== READY_PREFIX.slice(0, -1) ||
          pidText === undefined || startKey === undefined || launchNonce === undefined ||
          !/^\d+$/u.test(pidText) || !/^win:[1-9][0-9]{0,19}$/u.test(startKey) ||
          !/^[a-f0-9]{32}$/u.test(launchNonce)) {
        return finish(new Error("helper-ready-invalid"));
      }
      finish(undefined, Object.freeze({ pid: Number(pidText), startKey, launchNonce }));
    };
    const onError = () => finish(new Error("helper-ready-stream"));
    const onChildError = () => finish(new Error("helper-ready-process"));
    const onClose = () => finish(new Error("helper-exited-before-ready"));
    child.stdout.on("data", onData);
    child.stdout.once("error", onError);
    child.once("error", onChildError);
    child.once("close", onClose);
  });
}

async function verifyChildIdentity(child: InstallationProcessIdentity): Promise<void> {
  const status = await systemProcessIdentityProvider.inspect(child.pid);
  if (status.state !== "alive" || status.startKey !== child.startKey) throw failure("helper-identity-mismatch");
}

async function copyHelperExecutable(target: string, expectedSha256: string, expectedSize: number): Promise<void> {
  const source = absolute(process.execPath, "active-executable");
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) throw failure("helper-alias");
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL);
    const info = await lstat(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size !== BigInt(expectedSize)) throw failure("helper-copy-invalid");
    const copied = await readFile(target);
    if (createHash("sha256").update(copied).digest("hex") !== expectedSha256) throw failure("helper-copy-digest");
  } catch (error) {
    await rm(target, { force: true }).catch(() => undefined);
    throw error instanceof ToolError ? error : failure("helper-copy-failed");
  }
}

export interface WindowsPersistenceLaunchInput {
  readonly stateDirectory: string;
  readonly installationDirectory: string;
  readonly current: InstallationJournal;
  readonly persist: (journal: InstallationJournal) => Promise<void>;
}

export interface WindowsPersistenceLaunchResult {
  readonly journal: InstallationJournal;
  readonly child: InstallationProcessIdentity;
  readonly helperPath: string;
}

/**
 * Write one descriptor, launch the copied SEA helper, and durably admit it
 * before returning. The caller still owns the outer update lock and must let
 * the business process exit after returning a persistence-pending result.
 */
export async function launchWindowsPersistenceHelper(
  input: WindowsPersistenceLaunchInput,
): Promise<WindowsPersistenceLaunchResult> {
  if (process.platform !== "win32") throw failure("unsupported-platform");
  const stateDirectory = absolute(input.stateDirectory, "state");
  const installationDirectory = absolute(input.installationDirectory, "installation");
  const currentProcess = await systemProcessIdentityProvider.current();
  const parent = processIdentity(currentProcess, nonce());
  const draft = createWindowsPersistenceDescriptor(input.current, parent);
  await writeWindowsPersistenceDescriptor(installationDirectory, draft);
  const descriptor = await observeWindowsPersistenceDescriptor(installationDirectory);
  const reservationInput = createWindowsLaunchReservationInput(input.current, parent, draft, descriptor.identity);
  let journal = reserveWindowsLaunch(input.current, reservationInput);
  await input.persist(journal);

  const target = helperPath(installationDirectory, draft.launchId);
  await copyHelperExecutable(target, input.current.previousEvidence.native.sha256, input.current.previousEvidence.native.size);
  let childProcess: HelperChild | undefined;
  let childClosePromise: Promise<void> = Promise.resolve();
  try {
    childProcess = spawn(target, ["internal", "windows-persist", stateDirectory, installationDirectory, target], {
      shell: false,
      windowsHide: true,
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    }) as HelperChild;
    childClosePromise = new Promise<void>((resolvePromise) => {
      childProcess!.once("close", () => resolvePromise());
    });
    const child = await waitReady(childProcess);
    await verifyChildIdentity(child);
    journal = advanceWindowsLaunchInJournal(journal, childLaunchEvidence(journal, "registered", child, null));
    await input.persist(journal);
    journal = advanceWindowsLaunchInJournal(journal, childLaunchEvidence(journal, "claimed", child, null));
    await input.persist(journal);
    const grantSha256 = createHash("sha256").update(`grant:${draft.launchId}:${draft.reservationId}`).digest("hex");
    journal = advanceWindowsLaunchInJournal(journal, childLaunchEvidence(journal, "ack-issued", child, grantSha256));
    await input.persist(journal);
    journal = advanceWindowsLaunchInJournal(journal, childLaunchEvidence(journal, "admitted", child, grantSha256));
    await input.persist(journal);
    journal = markWindowsExecutionPending(journal);
    await input.persist(journal);
    childProcess.stdout.destroy();
    childProcess.unref();
    return Object.freeze({ journal, child, helperPath: target });
  } catch (error) {
    if (childProcess !== undefined) {
      await terminateHelperProcess(childProcess, childClosePromise);
    }
    throw error instanceof ToolError ? error : failure("helper-launch-failed");
  }
}

export interface WindowsPersistenceHelperInput {
  readonly stateDirectory: string;
  readonly installationDirectory: string;
  readonly helperPath: string;
}

function sameIdentity(left: { readonly dev: string; readonly ino: string }, right: { readonly dev: string; readonly ino: string }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameProcessIdentity(left: InstallationProcessIdentity, right: InstallationProcessIdentity): boolean {
  return left.pid === right.pid && left.startKey === right.startKey && left.launchNonce === right.launchNonce;
}

interface WindowsPersistenceSettlementInput {
  readonly stateDirectory: string;
  readonly installationDirectory: string;
  readonly descriptor: Awaited<ReturnType<typeof observeWindowsPersistenceDescriptor>>;
  readonly decoded: ReturnType<typeof decodeWindowsPersistenceDescriptor>;
  readonly child: InstallationProcessIdentity;
}

async function settleWindowsPersistence(input: WindowsPersistenceSettlementInput): Promise<void> {
  const { stateDirectory, installationDirectory, descriptor, decoded, child } = input;
  await withUpdateLock(stateDirectory, async (lease) => {
    const store = createInstallationJournalStore(stateDirectory, { lease });
    let journal = await store.read();
    if (journal === null) throw failure("helper-journal-missing");
    const action = classifyWindowsPersistenceRecovery(journal);
    const launch = journal.windows?.launch;
    const slot = journal.slots.find((item) => item.name === "launch-descriptor");
    if (launch === null || launch === undefined || slot === undefined || slot.state !== "created" ||
        launch.launchId !== decoded.launchId || launch.reservationId !== decoded.reservationId ||
        launch.attemptId !== decoded.attemptId || launch.transactionId !== decoded.transactionId ||
        launch.expectedRevision !== journal.revision || launch.parent.pid !== decoded.parent.pid ||
        launch.parent.startKey !== decoded.parent.startKey || launch.parent.launchNonce !== decoded.parent.launchNonce ||
        launch.descriptorSha256 !== descriptor.sha256 || !sameIdentity(slot.identity, descriptor.identity) ||
        launch.child === null || !sameProcessIdentity(launch.child, child)) {
      throw failure("helper-journal-mismatch");
    }
    const roots = await validateWindowsInstallationRoot(installationDirectory);
    if (String(roots.dev) !== journal.roots.installation.dev || String(roots.ino) !== journal.roots.installation.ino) {
      throw failure("helper-root-mismatch");
    }

    if (action === "cleanup-committed") {
      await cleanupCommittedPersistence(stateDirectory, installationDirectory, journal, store, lease, descriptor);
      return;
    }
    const verifier = createReleaseSetSnapshotVerifier({ platform: "windows-x64" });
    const cache = new UpdateCache({ stateDirectory, verifySnapshot: verifier });
    const staged = await cache.loadStagedReleaseSet(journal.next, lease);
    if (staged === null) throw failure("helper-staged-release-missing");

    if (action === "settle-admitted") {
      const stage = await rehydrateAuthenticatedManagedWindowsCandidate({
        installationDirectory,
        snapshot: staged,
        platform: "windows-x64",
        repairMissingStage: true,
      });
      await verifyManagedWindowsStage(stage);
      const completedLaunch = Object.freeze({
        ...launch,
        authorityEpoch: journal.control.authorityEpoch + 1,
        expectedRevision: journal.revision + 1,
        child: Object.freeze({ ...child }),
        state: "completed" as const,
        exitCode: 0,
        settlement: sealInstallationSettlement({
          state: "settled",
          launchId: launch.launchId,
          reservationId: launch.reservationId,
          descriptorSha256: launch.descriptorSha256,
          targetIdentity: launch.targetIdentity,
          parent: launch.parent,
          child,
        }),
      });
      journal = advanceWindowsLaunchInJournal(journal, completedLaunch);
      await store.write(journal);
    }

    if (journal.phase === "execution-pending") {
      journal = advanceInstallationJournalPhase(journal, "publish-intent", null);
      await store.write(journal);
    }

    if (["publish-intent", "canonical-published", "marker-published"].includes(journal.phase)) {
      const stage = await rehydrateAuthenticatedManagedWindowsCandidate({
        installationDirectory,
        snapshot: staged,
        platform: "windows-x64",
        repairMissingStage: true,
      });
      await verifyManagedWindowsStage(stage);
      await publishManagedWindowsCandidate(stage);
      if (journal.phase === "publish-intent") {
        journal = advanceInstallationJournalPhase(journal, "canonical-published", null);
        await store.write(journal);
      }
      if (journal.phase === "canonical-published") {
        journal = advanceInstallationJournalPhase(journal, "marker-published", null);
        await store.write(journal);
      }
      if (journal.phase === "marker-published") {
        journal = advanceInstallationJournalPhase(journal, "commit-intent", null);
        await store.write(journal);
      }
    }

    if (journal.phase === "commit-intent") {
      const committed = await cache.commitStagedReleaseSet(staged.record, lease);
      if (committed === null) throw failure("helper-cache-commit-missing");
      const observed = await verifyInstalledRelease(staged, { stateDirectory, installationDirectory, platform: "windows-x64" }, lease);
      if (observed.releaseSetId !== staged.record.releaseSetId || observed.cliVersion !== staged.record.cliVersion) {
        throw failure("helper-installed-observation-mismatch");
      }
      journal = advanceInstallationJournalPhase(journal, "committed", "next");
      await store.write(journal);
    }

    if (journal.phase === "committed") {
      await cleanupCommittedPersistence(stateDirectory, installationDirectory, journal, store, lease, descriptor);
    }
  });
}

async function descriptorExists(installationDirectory: string): Promise<boolean> {
  try {
    await lstat(resolve(installationDirectory, WINDOWS_LAUNCH_DESCRIPTOR_FILENAME));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw failure("repair-descriptor-unavailable");
  }
}

/** Keep the committed journal as recovery authority until cleanup is observed complete. */
async function cleanupCommittedPersistence(
  stateDirectory: string,
  installationDirectory: string,
  journal: InstallationJournal,
  store: InstallationJournalStore,
  lease: ProcessLockLease,
  descriptor: Awaited<ReturnType<typeof observeWindowsPersistenceDescriptor>> | null,
): Promise<void> {
  if (classifyWindowsPersistenceRecovery(journal) !== "cleanup-committed") throw failure("cleanup-not-committed");
  lease.assertHeld();
  const root = await validateWindowsInstallationRoot(installationDirectory);
  if (!sameIdentity(root, journal.roots.installation)) throw failure("helper-root-mismatch");
  const verifier = createReleaseSetSnapshotVerifier({ platform: "windows-x64" });
  const cache = new UpdateCache({ stateDirectory, verifySnapshot: verifier });
  const active = await cache.loadLastKnownGoodOrNull({}, lease);
  if (active === null || tupleDigest(active.record) !== journal.nextEvidence.tupleSha256) {
    throw failure("helper-committed-pointer-mismatch");
  }
  const observed = await verifyInstalledRelease(active, { stateDirectory, installationDirectory, platform: "windows-x64" }, lease);
  if (observed.releaseSetId !== journal.next.releaseSetId || observed.cliVersion !== journal.next.cliVersion ||
      observed.channelPayloadSha256 !== journal.nextEvidence.authorizationPayloadSha256) {
    throw failure("helper-committed-observation-mismatch");
  }
  if (descriptor !== null) {
    const current = await observeWindowsPersistenceDescriptor(installationDirectory);
    if (current.sha256 !== descriptor.sha256 || !sameIdentity(current.identity, descriptor.identity)) {
      throw failure("cleanup-descriptor-mismatch");
    }
    // Do not swallow observation/unlink failures: the terminal journal must
    // survive them. A restart may find the descriptor already removed below.
    await rm(resolve(installationDirectory, WINDOWS_LAUNCH_DESCRIPTOR_FILENAME));
  }
  if (await descriptorExists(installationDirectory)) throw failure("cleanup-descriptor-remains");
  if (!sameIdentity(await validateWindowsInstallationRoot(installationDirectory), root)) throw failure("helper-root-mismatch");
  lease.assertHeld();
  await store.remove();
}

async function assertRecoveryOwnerExited(parent: InstallationProcessIdentity, child: InstallationProcessIdentity): Promise<void> {
  const parentState = await systemProcessIdentityProvider.inspect(parent.pid);
  if (parentState.state === "alive" && parentState.startKey === parent.startKey) throw failure("repair-parent-live");
  if (parentState.state === "unknown") throw failure("repair-parent-unknown");
  const helper = await systemProcessIdentityProvider.inspect(child.pid);
  if (helper.state === "alive" && helper.startKey === child.startKey) throw failure("repair-helper-live");
  if (helper.state === "unknown") throw failure("repair-helper-unknown");
}

/** Run inside the copied SEA after the business parent has handed off. */
export async function runWindowsPersistenceHelper(input: WindowsPersistenceHelperInput): Promise<void> {
  if (process.platform !== "win32") throw failure("unsupported-platform");
  const stateDirectory = absolute(input.stateDirectory, "state");
  const installationDirectory = absolute(input.installationDirectory, "installation");
  const helper = absolute(input.helperPath, "helper");
  const descriptor = await observeWindowsPersistenceDescriptor(installationDirectory);
  const decoded = decodeWindowsPersistenceDescriptor(descriptor.bytes);
  const expectedHelper = helperPath(installationDirectory, decoded.launchId);
  if (resolve(helper).toLowerCase() !== resolve(expectedHelper).toLowerCase()) throw failure("helper-path-mismatch");
  if (decoded.parent.pid === process.pid) throw failure("parent-is-helper");
  const childCurrent = await systemProcessIdentityProvider.current();
  const child = processIdentity(childCurrent, nonce());
  process.stdout.write(`${READY_PREFIX}${child.pid}\t${child.startKey}\t${child.launchNonce}\n`);
  await waitForProcessExit(decoded.parent, { provider: systemProcessIdentityProvider });
  try {
    await settleWindowsPersistence({ stateDirectory, installationDirectory, descriptor, decoded, child });
    await rm(helper, { force: true }).catch(() => undefined);
  } catch (error) {
    throw error instanceof ToolError ? error : failure("helper-settlement-failed");
  }
}

/**
 * Take over a dead helper's admitted transaction during startup/repair. A live
 * parent or helper is never shadowed; the caller receives a typed failure and
 * can retry after the owner exits.
 */
export async function recoverWindowsPersistence(
  stateDirectoryInput: string,
  installationDirectoryInput: string,
): Promise<boolean> {
  if (process.platform !== "win32") throw failure("unsupported-platform");
  const stateDirectory = absolute(stateDirectoryInput, "state");
  const installationDirectory = absolute(installationDirectoryInput, "installation");
  await validateWindowsInstallationRoot(installationDirectory);
  const pending = await withUpdateLock(stateDirectory, async (lease) => {
    const store = createInstallationJournalStore(stateDirectory, { lease });
    const journal = await store.read();
    if (!await descriptorExists(installationDirectory)) {
      if (journal?.windows?.launch === null || journal?.windows?.launch === undefined) return null;
      if (classifyWindowsPersistenceRecovery(journal) !== "cleanup-committed") throw failure("repair-descriptor-missing");
      const launch = journal.windows.launch;
      if (launch.child === null) throw failure("repair-launch-missing");
      await assertRecoveryOwnerExited(launch.parent, launch.child);
      await cleanupCommittedPersistence(stateDirectory, installationDirectory, journal, store, lease, null);
      return { cleaned: true as const };
    }
    const descriptor = await observeWindowsPersistenceDescriptor(installationDirectory);
    const decoded = decodeWindowsPersistenceDescriptor(descriptor.bytes);
    // The descriptor is not signed and cannot authenticate its own transaction
    // or launch. Even a matching active release cannot replace a lost journal.
    if (journal === null) throw failure("repair-launch-missing");
    classifyWindowsPersistenceRecovery(journal);
    const launch = journal.windows?.launch;
    if (launch === null || launch === undefined || launch.launchId !== decoded.launchId ||
        launch.reservationId !== decoded.reservationId || launch.child === null) {
      throw failure("repair-descriptor-mismatch");
    }
    return { cleaned: false as const, descriptor, decoded, child: launch.child };
  });
  if (pending === null) return false;
  if (pending.cleaned) return true;
  await assertRecoveryOwnerExited(pending.decoded.parent, pending.child);
  await settleWindowsPersistence({
    stateDirectory,
    installationDirectory,
    descriptor: pending.descriptor,
    decoded: pending.decoded,
    child: pending.child,
  });
  return true;
}
