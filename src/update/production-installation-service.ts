import {createHash, randomBytes} from "node:crypto";
import {lstat} from "node:fs/promises";
import {isAbsolute, resolve} from "node:path";

import {canonicalizeJson, sha256Utf8} from "../contracts/jcs.ts";
import {ToolError} from "../contracts/errors.ts";
import {withUpdateLock} from "../platform/lock.ts";
import type {ProcessLockLease} from "../platform/process-lock.ts";
import type {AnchoredMoveFileIdentity} from "../platform/anchored-file-mover.ts";
import {
  UpdateCache,
  type ReleaseSetSnapshot,
  type StoredReleaseSet,
} from "./cache.ts";
import {
  createReleaseSetSnapshotVerifier,
  authenticateReleaseSnapshot,
  type AuthenticatedReleaseSnapshot,
  type SupportedReleasePlatform,
} from "./release-set-verifier.ts";
import {
  createProductionReleasePreparer,
  currentReleasePlatform,
  type PreparedReleaseCandidate,
} from "./production-release-preparation.ts";
import {
  createProductionChannelClient,
} from "./production-channel.ts";
import {
  createInstallationJournalStore,
  type InstallationJournalStore,
} from "./installation-journal-store.ts";
import {
  advanceInstallationJournal,
} from "./installation-journal-transition.ts";
import {
  validateInstallationJournal,
  type InstallationFileIdentity,
  type InstallationJournal,
  type InstallationReleaseEvidence,
  type InstallationSlot,
  type InstallationOperationEvidence,
} from "./installation-journal.ts";
import {tupleDigest} from "./journal.ts";
import {
  verifyInstalledRelease,
  type InstalledReleaseObservation,
} from "./installed-release-verification.ts";
import {
  stageAuthenticatedManagedPosixCandidate,
  verifyManagedPosixStage,
  publishManagedPosixCandidate,
  removeManagedPosixStage,
  type ManagedPosixStage,
} from "./managed-installation-posix.ts";
import {
  stageAuthenticatedManagedWindowsCandidate,
  verifyManagedWindowsStage,
  publishManagedWindowsCandidate,
  removeManagedWindowsStage,
  type ManagedWindowsStage,
} from "./managed-installation-windows.ts";
import type {
  InstallationResult,
  ProductionInstallationOptions,
  ProductionInstallationService,
} from "./managed-installation-types.ts";

const MARKER_NAME = ".harness-mrtool-install.json";
const randomId = (): string => randomBytes(16).toString("hex");
const digest = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function failure(actual: string, code: "UPDATE_SECURITY_ERROR" | "UPDATE_REQUIRED" | "CONCURRENT_UPDATE" = "UPDATE_SECURITY_ERROR"): ToolError<typeof code> {
  return new ToolError(code, code === "CONCURRENT_UPDATE" ? "Signed update authorization changed during installation" : "Managed installation is not coherent", {
    field: "update.installation",
    expected: code === "UPDATE_REQUIRED" ? "an authenticated release candidate newer than the installed release" : "a stable, identity-pinned managed installation",
    actual,
    safeNextStep: code === "UPDATE_REQUIRED" ? "Keep the installed release and retry after the official channel publishes an applicable release." : "Preserve the installation journal and run self-update repair.",
  });
}

function absoluteRoot(value: string): string {
  if (!isAbsolute(value) || resolve(value) !== value || value.includes("\0")) throw failure("unsafe-root");
  return value;
}

function fileIdentity(value: {readonly dev: bigint; readonly ino: bigint}): InstallationFileIdentity {
  return Object.freeze({dev: String(value.dev), ino: String(value.ino)});
}

function identityFromObserved(value: {readonly dev: string; readonly ino: string}): InstallationFileIdentity {
  return Object.freeze({dev: value.dev, ino: value.ino});
}

async function directoryIdentity(path: string): Promise<{readonly dev: bigint; readonly ino: bigint}> {
  const info = await lstat(path, {bigint: true});
  if (!info.isDirectory() || info.isSymbolicLink()) throw failure("installation-root-is-not-a-directory");
  return Object.freeze({dev: info.dev, ino: info.ino});
}

async function privateFileIdentity(path: string): Promise<AnchoredMoveFileIdentity> {
  const info = await lstat(path, {bigint: true});
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) throw failure("private-file-is-invalid");
  return Object.freeze({dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid});
}

function markerBytes(snapshot: ReleaseSetSnapshot, authenticated: AuthenticatedReleaseSnapshot): Uint8Array {
  const manifest = authenticated.verified.manifest;
  return new TextEncoder().encode(`${canonicalizeJson({
    schemaVersion: 1,
    repository: `${manifest.repository.owner}/${manifest.repository.name}`,
    tag: manifest.components.cli.tag,
    archiveSha256: snapshot.record.cliSha256,
    executableSha256: digest(authenticated.executableBytes),
  })}\n`);
}

function releaseEvidence(snapshot: ReleaseSetSnapshot, authenticated: AuthenticatedReleaseSnapshot): InstallationReleaseEvidence {
  const marker = markerBytes(snapshot, authenticated);
  return Object.freeze({
    tupleSha256: tupleDigest(snapshot.record),
    authorizationPayloadSha256: authenticated.verified.payloadSha256,
    native: Object.freeze({sha256: digest(authenticated.executableBytes), size: authenticated.executableBytes.length}),
    marker: Object.freeze({
      fields: Object.freeze({
        schemaVersion: 1 as const,
        repository: `${authenticated.verified.manifest.repository.owner}/${authenticated.verified.manifest.repository.name}`,
        tag: authenticated.verified.manifest.components.cli.tag,
        archiveSha256: snapshot.record.cliSha256,
        executableSha256: digest(authenticated.executableBytes),
      }),
      sha256: digest(marker),
      size: marker.length,
    }),
    snapshotId: snapshot.record.transactionId,
  });
}

function operationEvidence(journal: Pick<InstallationJournal, "attemptId" | "transactionId" | "previousEvidence" | "nextEvidence">, revision: number, epoch: number): InstallationOperationEvidence {
  const binding = {
    authorityEpoch: epoch,
    workerId: randomId(),
    operationId: randomId(),
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    expectedRevision: revision,
    previousTupleSha256: journal.previousEvidence.tupleSha256,
    nextTupleSha256: journal.nextEvidence.tupleSha256,
    admittedSlots: ["staged-executable", "staged-marker", "previous-executable", "previous-marker", "canonical-executable", "canonical-marker", "active-pointer", "installation-journal"] as const,
    status: "drained" as const,
  };
  return Object.freeze({...binding, receiptSha256: sha256Utf8(canonicalizeJson(binding))});
}

function terminalDigest(journal: InstallationJournal): string {
  const {phase: _phase, revision: _revision, terminalEvidenceSha256: _digest, ...evidence} = journal;
  return sha256Utf8(canonicalizeJson(evidence));
}

function transition(current: InstallationJournal, phase: InstallationJournal["phase"], outcome: InstallationJournal["outcome"], slots: readonly InstallationSlot[]): InstallationJournal {
  const revision = current.revision + 1;
  const operation = operationEvidence(current, revision, current.control.authorityEpoch + 1);
  const candidate: InstallationJournal = {
    ...current,
    revision,
    phase,
    outcome,
    slots: Object.freeze([...slots]),
    control: Object.freeze({authorityEpoch: operation.authorityEpoch, operations: Object.freeze([...current.control.operations, operation])}),
    terminalEvidenceSha256: null,
  };
  const withTerminal = ["committed", "aborted", "retention-transfer"].includes(phase)
    ? {...candidate, terminalEvidenceSha256: terminalDigest(candidate)}
    : candidate;
  return validateInstallationJournal(advanceInstallationJournal(current, withTerminal));
}

function stableId(seed: string): string {
  return digest(seed).slice(0, 32);
}

function initialJournal(
  platform: SupportedReleasePlatform,
  operation: "apply" | "rollback",
  installationId: string,
  enrollmentId: string,
  roots: {readonly installation: InstallationFileIdentity; readonly state: InstallationFileIdentity},
  previous: StoredReleaseSet,
  previousAuth: AuthenticatedReleaseSnapshot,
  next: ReleaseSetSnapshot,
  nextAuth: AuthenticatedReleaseSnapshot,
): InstallationJournal {
  const previousEvidence = releaseEvidence(previous, previousAuth);
  const nextEvidence = releaseEvidence(next, nextAuth);
  const attemptId = randomId();
  const record = {
    journalVersion: 1 as const,
    attemptId,
    transactionId: next.record.transactionId,
    operation,
    platform,
    installationId,
    enrollmentId,
    roots,
    revision: 1,
    phase: "preparing" as const,
    outcome: null,
    previous: previous.record,
    next: next.record,
    previousEvidence,
    nextEvidence,
    authorization: {
      sequence: next.record.manifestSequence,
      payloadSha256: nextEvidence.authorizationPayloadSha256,
      trustStateSha256: digest(canonicalizeJson(nextAuth.verified.nextTrustState)),
    },
    slots: [
      {name: "staged-executable", state: "intent", expectedSha256: nextEvidence.native.sha256, expectedSize: nextEvidence.native.size},
      {name: "staged-marker", state: "intent", expectedSha256: nextEvidence.marker.sha256, expectedSize: nextEvidence.marker.size},
      {name: "previous-executable", state: "intent", expectedSha256: previousEvidence.native.sha256, expectedSize: previousEvidence.native.size},
      {name: "previous-marker", state: "intent", expectedSha256: previousEvidence.marker.sha256, expectedSize: previousEvidence.marker.size},
    ] satisfies readonly InstallationSlot[],
    control: {authorityEpoch: 1, operations: [] as readonly InstallationOperationEvidence[]},
    windows: platform === "windows-x64" ? {inner: null, launch: null} : null,
    terminalEvidenceSha256: null,
  } satisfies InstallationJournal;
  const op = operationEvidence(record, 1, 1);
  return validateInstallationJournal({...record, control: {authorityEpoch: 1, operations: [op]}});
}

function slotsWithCreatedIdentities(journal: InstallationJournal, stagedExecutable: InstallationFileIdentity, stagedMarker: InstallationFileIdentity, previousExecutable: InstallationFileIdentity, previousMarker: InstallationFileIdentity): readonly InstallationSlot[] {
  return Object.freeze(journal.slots.map(slot => {
    if (slot.name === "staged-executable") return {...slot, state: "created" as const, identity: stagedExecutable};
    if (slot.name === "staged-marker") return {...slot, state: "created" as const, identity: stagedMarker};
    if (slot.name === "previous-executable") return {...slot, state: "created" as const, identity: previousExecutable};
    if (slot.name === "previous-marker") return {...slot, state: "created" as const, identity: previousMarker};
    return slot;
  }));
}

function installedResult(active: StoredReleaseSet, observed: InstalledReleaseObservation): InstallationResult {
  return Object.freeze({status: "installed" as const, active: active.record, observed});
}

export function createProductionInstallationService(options: ProductionInstallationOptions): ProductionInstallationService {
  if (options === null || typeof options !== "object") throw failure("invalid-options");
  const stateDirectory = absoluteRoot(options.stateDirectory);
  const installationDirectory = absoluteRoot(options.installationDirectory);
  const platform = options.platform ?? currentReleasePlatform();
  const trustConfig = options.trustConfig;
  const verifier = createReleaseSetSnapshotVerifier({platform, ...(trustConfig === undefined ? {} : {trustConfig})});
  const cache = new UpdateCache({stateDirectory, verifySnapshot: verifier, ...(options.windowsAclVerifier === undefined ? {} : {windowsAclVerifier: options.windowsAclVerifier})});
  const preparer = createProductionReleasePreparer({...options, stateDirectory, platform});
  const channel = createProductionChannelClient({...options, stateDirectory, ...(trustConfig === undefined ? {} : {trustConfig})});

  async function recoverTerminal(lease: ProcessLockLease, store: InstallationJournalStore): Promise<void> {
    const journal = await store.read();
    if (journal === null) return;
    if (journal.phase !== "committed" && journal.phase !== "aborted" && journal.phase !== "retention-transfer") throw failure(`unresolved-journal:${journal.phase}`);
    const record = journal.outcome === "next" ? journal.next : journal.previous;
    const loaded = await cache.loadLastKnownGoodOrNull({}, lease);
    if (loaded === null || loaded.record.transactionId !== record.transactionId) throw failure("terminal-journal-pointer-mismatch");
    const observed = await verifyInstalledRelease(loaded, {stateDirectory, installationDirectory, platform, ...(trustConfig === undefined ? {} : {trustConfig})}, lease);
    if (observed.releaseSetId !== record.releaseSetId || observed.cliVersion !== record.cliVersion) throw failure("terminal-journal-installation-mismatch");
    await store.remove();
  }

  async function currentInstalled(lease: ProcessLockLease): Promise<{
    readonly active: StoredReleaseSet;
    readonly observed: InstalledReleaseObservation;
    readonly executable: AnchoredMoveFileIdentity;
    readonly marker: AnchoredMoveFileIdentity;
  }> {
    const active = await cache.loadLastKnownGoodOrNull({}, lease);
    if (active === null) throw failure("no-authenticated-active-release", "UPDATE_REQUIRED");
    if (active.writesBlocked) throw failure(`active-release-blocked:${active.writeBlockReasons.join(",")}`);
    const observed = await verifyInstalledRelease(active, {stateDirectory, installationDirectory, platform, ...(trustConfig === undefined ? {} : {trustConfig})}, lease);
    if (observed.releaseSetId !== active.record.releaseSetId || observed.cliVersion !== active.record.cliVersion) throw failure("active-pointer-does-not-match-installed-bytes");
    return Object.freeze({
      active,
      observed,
      executable: await privateFileIdentity(resolve(installationDirectory, platform === "darwin-arm64" ? "harness-mrtool" : "harness-mrtool.exe")),
      marker: await privateFileIdentity(resolve(installationDirectory, MARKER_NAME)),
    });
  }

  async function applyCandidate(candidate: PreparedReleaseCandidate, operation: "apply" | "rollback"): Promise<InstallationResult> {
    return withUpdateLock(stateDirectory, async lease => {
      const store = createInstallationJournalStore(stateDirectory, {lease, ...(options.windowsAclVerifier === undefined ? {} : {windowsAclVerifier: options.windowsAclVerifier})});
      await recoverTerminal(lease, store);
      const current = await currentInstalled(lease);
      const previous = current.active;
      const candidateAuth = await authenticateReleaseSnapshot(candidate.snapshot, {platform, ...(trustConfig === undefined ? {} : {trustConfig})});
      if (candidate.snapshot.record.transactionId === previous.record.transactionId) {
        const observed = await verifyInstalledRelease(previous, {stateDirectory, installationDirectory, platform, ...(trustConfig === undefined ? {} : {trustConfig})}, lease);
        return Object.freeze({status: "unchanged" as const, active: previous.record, observed});
      }
      if (candidate.snapshot.record.manifestSequence <= previous.record.manifestSequence) throw failure("candidate-sequence-is-not-newer", "UPDATE_REQUIRED");
      const finalChannel = await channel.check(false, lease);
      if (!finalChannel.latestVersionConfirmed || finalChannel.verified.payloadSha256 !== candidateAuth.verified.payloadSha256) throw failure("candidate-channel-payload-changed", "CONCURRENT_UPDATE");
      const stagedCache = await cache.stageVerifiedReleaseSet(candidate.snapshot, lease);
      const stateRoot = await directoryIdentity(stateDirectory);
      const installRoot = await directoryIdentity(installationDirectory);
            const previousAuth = await authenticateReleaseSnapshot(previous, {platform, ...(trustConfig === undefined ? {} : {trustConfig})});
      const installationId = stableId(`installation:${fileIdentity(installRoot).dev}:${fileIdentity(installRoot).ino}:${platform}`);
      const enrollmentId = stableId(`enrollment:${fileIdentity(stateRoot).dev}:${fileIdentity(stateRoot).ino}:${installationId}`);
      const journal = initialJournal(platform, operation, installationId, enrollmentId, {installation: fileIdentity(installRoot), state: fileIdentity(stateRoot)}, previous, previousAuth, candidate.snapshot, candidateAuth);
      await store.write(journal);

      let stage: ManagedPosixStage | ManagedWindowsStage | undefined;
      try {
        if (platform === "darwin-arm64") {
          const posixStage = await stageAuthenticatedManagedPosixCandidate({installationDirectory, snapshot: candidate.snapshot, platform, ...(trustConfig === undefined ? {} : {trustConfig})});
          stage = posixStage;
          const observation = await verifyManagedPosixStage(posixStage);
          const prepared = transition(journal, "prepared", null, slotsWithCreatedIdentities(journal, identityFromObserved(observation.executableIdentity), identityFromObserved(observation.markerIdentity), fileIdentity(current.executable), fileIdentity(current.marker)));
          await store.write(prepared);
          const publishIntent = transition(prepared, "publish-intent", null, prepared.slots);
          await store.write(publishIntent);
          const previousExecutable = current.executable;
          const previousMarkerIdentity = current.marker;
          const publication = await publishManagedPosixCandidate({stage: posixStage, attemptId: journal.attemptId, previous: {executable: previousExecutable, marker: previousMarkerIdentity}});
          const published = transition(publishIntent, "canonical-published", null, slotsWithCreatedIdentities(publishIntent, identityFromObserved(observation.executableIdentity), identityFromObserved(observation.markerIdentity), fileIdentity(publication.previous?.executable ?? previousExecutable), fileIdentity(publication.previous?.marker ?? previousMarkerIdentity)));
          await store.write(published);
          await store.write(transition(published, "marker-published", null, published.slots));
        } else {
          const windowsStage = await stageAuthenticatedManagedWindowsCandidate({installationDirectory, snapshot: candidate.snapshot, platform, ...(trustConfig === undefined ? {} : {trustConfig}), ...(options.windowsAclVerifier === undefined ? {} : {windowsAclVerifier: options.windowsAclVerifier})});
          stage = windowsStage;
          const observation = await verifyManagedWindowsStage(windowsStage);
          const prepared = transition(journal, "prepared", null, slotsWithCreatedIdentities(journal, identityFromObserved(observation.executableIdentity), identityFromObserved(observation.markerIdentity), fileIdentity(current.executable), fileIdentity(current.marker)));
          await store.write(prepared);
          const publishIntent = transition(prepared, "publish-intent", null, prepared.slots);
          await store.write(publishIntent);
          await publishManagedWindowsCandidate(windowsStage);
          await store.write(transition(publishIntent, "canonical-published", null, publishIntent.slots));
          await store.write(transition(await store.read() as InstallationJournal, "marker-published", null, publishIntent.slots));
        }
        const markerPublished = await store.read();
        if (markerPublished === null) throw failure("journal-disappeared");
        const commitIntent = transition(markerPublished, "commit-intent", null, markerPublished.slots);
        await store.write(commitIntent);
        const committedCache = await cache.commitStagedReleaseSet(stagedCache.record, lease);
        if (committedCache === null) throw failure("candidate-cache-commit-missing");
        const observed = await verifyInstalledRelease(candidate.snapshot, {stateDirectory, installationDirectory, platform, ...(trustConfig === undefined ? {} : {trustConfig})}, lease);
        const committed = transition(commitIntent, "committed", "next", commitIntent.slots);
        await store.write(committed);
        await store.remove();
        return installedResult(committedCache, observed);
      } catch (error) {
        throw error instanceof ToolError ? error : failure("installation-mutation-failed");
      } finally {
        if (stage !== undefined) {
          if (platform === "darwin-arm64") await removeManagedPosixStage(stage as ManagedPosixStage).catch(() => undefined);
          else await removeManagedWindowsStage(stage as ManagedWindowsStage).catch(() => undefined);
        }
      }
    });
  }

  return Object.freeze({
    async apply(force: boolean): Promise<InstallationResult> {
      if (typeof force !== "boolean") throw new TypeError("Update force flag is invalid");
      return applyCandidate(await preparer.prepare(force), "apply");
    },
    async rollback(): Promise<InstallationResult> {
      return applyCandidate(await preparer.prepare(true), "rollback");
    },
    async recover(): Promise<void> {
      await withUpdateLock(stateDirectory, async lease => {
        const store = createInstallationJournalStore(stateDirectory, {lease, ...(options.windowsAclVerifier === undefined ? {} : {windowsAclVerifier: options.windowsAclVerifier})});
        await recoverTerminal(lease, store);
        await currentInstalled(lease);
      });
    },
  });
}

