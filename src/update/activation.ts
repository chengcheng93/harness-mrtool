import { resolve } from "node:path";

import {
  ensurePrivateStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import { withUpdateLock } from "../platform/lock.ts";
import type { ProcessLockLease } from "../platform/process-lock.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  UpdateCache,
  type LoadedReleaseSet,
  type ReleaseSetRecord,
  type ReleaseSetSnapshotVerifier,
  type ReleaseSetSnapshot,
  type StoredReleaseSet,
} from "./cache.ts";
import {
  readActivationJournal,
  removeActivationJournal,
  tupleDigest,
  validateActivationJournal,
  writeActivationJournal,
  type ActivationJournal,
} from "./journal.ts";

export type ReleaseSetTuple = ReleaseSetRecord;

export const ACTIVATION_CRASH_POINTS = Object.freeze([
  "after-journal-staging",
  "before-cli-replace",
  "before-template-replace",
  "before-receipt-replace",
  "before-active-replace",
  "after-cache-commit",
  "after-journal-commit",
] as const);
export type ActivationCrashPoint = (typeof ACTIVATION_CRASH_POINTS)[number];

export interface ActivationFaultInjector {
  hit(point: ActivationCrashPoint): void | Promise<void>;
}

export interface ReleaseSetActivationCache {
  loadLastKnownGoodOrNull(options?: { readonly verifiedManifest?: never }, lease?: ProcessLockLease): Promise<LoadedReleaseSet | null>;
  storeVerifiedReleaseSet(snapshot: ReleaseSetSnapshot, lease?: ProcessLockLease): Promise<StoredReleaseSet>;
  commitStagedReleaseSet(record: ReleaseSetRecord, lease?: ProcessLockLease): Promise<StoredReleaseSet | null>;
  cleanupStaleStagingDirectories(lease?: ProcessLockLease): Promise<void>;
}

export interface ActivateReleaseSetOptions {
  readonly stateDirectory: string;
  readonly next: ReleaseSetSnapshot;
  /** Cryptographic/application boundary; self-consistent bytes are not enough. */
  readonly verifySnapshot: ReleaseSetSnapshotVerifier;
  readonly cache?: ReleaseSetActivationCache;
  readonly windowsAclVerifier?: WindowsAclVerifier;
  readonly faultInjector?: ActivationFaultInjector;
}

export interface RecoverReleaseSetOptions {
  /** Required whenever recovery may observe an active release set. */
  readonly verifySnapshot: ReleaseSetSnapshotVerifier;
  readonly cache?: Pick<
    ReleaseSetActivationCache,
    "loadLastKnownGoodOrNull" | "commitStagedReleaseSet" | "cleanupStaleStagingDirectories"
  >;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

function sameRecord(left: ReleaseSetRecord | null, right: ReleaseSetRecord | null): boolean {
  if (left === null || right === null) return left === right;
  return tupleDigest(left) === tupleDigest(right);
}

function journalPath(stateDirectory: string): string {
  return resolve(stateDirectory, "activation-journal.json");
}

function securityFailure(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "activation journal does not match the active release set", {
    field: "activationJournal",
    expected: "a recoverable release-set transition",
    actual: "inconsistent",
    safeNextStep: "Run self-update repair before any side-effecting command.",
  });
}

async function prepareStateDirectory(
  stateDirectory: string,
  windowsAclVerifier: WindowsAclVerifier | undefined,
): Promise<string> {
  const root = resolve(stateDirectory);
  await ensurePrivateStateDirectory(root, windowsAclVerifier === undefined ? {} : { windowsAclVerifier });
  return root;
}

function makeCache(options: ActivateReleaseSetOptions): ReleaseSetActivationCache {
  if (options.cache !== undefined) return options.cache;
  const cacheOptions = {
    stateDirectory: options.stateDirectory,
    ...(options.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: options.windowsAclVerifier }),
    ...(options.faultInjector === undefined ? {} : {
      faultInjector: {
        hit(point: string): void | Promise<void> {
          if ((ACTIVATION_CRASH_POINTS as readonly string[]).includes(point)) {
            return options.faultInjector?.hit(point as ActivationCrashPoint);
          }
        },
      },
    }),
    verifySnapshot: options.verifySnapshot,
  };
  return new UpdateCache(cacheOptions);
}

function makeRecoveryCache(
  stateDirectory: string,
  options: RecoverReleaseSetOptions,
): Pick<
  ReleaseSetActivationCache,
  "loadLastKnownGoodOrNull" | "commitStagedReleaseSet" | "cleanupStaleStagingDirectories"
> {
  if (options.cache !== undefined) return options.cache;
  return new UpdateCache({
    stateDirectory,
    verifySnapshot: options.verifySnapshot,
    ...(options.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: options.windowsAclVerifier }),
  });
}

function stagedJournal(previous: ReleaseSetRecord | null, next: ReleaseSetRecord): ActivationJournal {
  return validateActivationJournal({
    journalVersion: 1,
    phase: "staging",
    transactionId: next.transactionId,
    previous,
    next,
  });
}

function committedJournal(previous: ReleaseSetRecord | null, next: ReleaseSetRecord): ActivationJournal {
  return validateActivationJournal({
    journalVersion: 1,
    phase: "committed",
    transactionId: next.transactionId,
    previous,
    next,
  });
}

function assertForwardJournalSequence(journal: ActivationJournal): void {
  // The active record is either `previous` (staging not yet committed) or
  // `next` (the pointer was committed before a crash). Compare only with the
  // journal's explicit predecessor so replaying the latter remains valid.
  const predecessor = journal.previous;
  if (predecessor !== null && journal.next.manifestSequence <= predecessor.manifestSequence) {
    throw securityFailure();
  }
}

async function recoverUnderLock(
  path: string,
  cache: Pick<ReleaseSetActivationCache, "loadLastKnownGoodOrNull" | "commitStagedReleaseSet">,
  lease: ProcessLockLease,
): Promise<LoadedReleaseSet | null> {
  const [journal, active] = await Promise.all([
    readActivationJournal(path),
    cache.loadLastKnownGoodOrNull({}, lease),
  ]);
  if (journal === null) return active;
  const record = active?.record ?? null;
  assertForwardJournalSequence(journal);
  if (journal.phase === "committed") {
    if (!sameRecord(record, journal.next)) throw securityFailure();
    await removeActivationJournal(path);
    return active;
  }
  if (sameRecord(record, journal.next)) {
    await removeActivationJournal(path);
    return active;
  }
  if (!sameRecord(record, journal.previous)) throw securityFailure();
  const recovered = await cache.commitStagedReleaseSet(journal.next, lease);
  if (recovered === null) {
    // A missing staged directory is an unprovable transaction outcome, not a
    // clean rollback. Keep the journal so repair/diagnostics can recover it.
    throw securityFailure();
  }
  await removeActivationJournal(path);
  return recovered;
}

export async function recoverReleaseSet(
  stateDirectory: string,
  options: RecoverReleaseSetOptions,
): Promise<LoadedReleaseSet | null> {
  if (options.verifySnapshot === undefined || typeof options.verifySnapshot.verify !== "function") {
    throw securityFailure();
  }
  const root = await prepareStateDirectory(stateDirectory, options.windowsAclVerifier);
  const cache = makeRecoveryCache(root, options);
  const path = journalPath(root);
  return withUpdateLock(root, async (lease) => {
    lease.assertHeld();
    const active = await recoverUnderLock(path, cache, lease);
    lease.assertHeld();
    // Recovery owns any journal-referenced release directory.  Only after the
    // journal is resolved may unrelated staging directories be reclaimed.
    await cache.cleanupStaleStagingDirectories(lease);
    if (active !== null) await options.verifySnapshot.verify(active);
    lease.assertHeld();
    return active;
  });
}

export async function activateReleaseSet(options: ActivateReleaseSetOptions): Promise<StoredReleaseSet> {
  if (options.verifySnapshot === undefined || typeof options.verifySnapshot.verify !== "function") {
    throw securityFailure();
  }
  const root = await prepareStateDirectory(options.stateDirectory, options.windowsAclVerifier);
  const normalizedOptions = { ...options, stateDirectory: root };
  const cache = makeCache(normalizedOptions);
  const path = journalPath(root);
  return withUpdateLock(root, async (lease) => {
    lease.assertHeld();
    const current = await recoverUnderLock(path, cache, lease);
    lease.assertHeld();
    await cache.cleanupStaleStagingDirectories(lease);
    if (current !== null) await options.verifySnapshot.verify(current);
    await options.verifySnapshot.verify(options.next);
    if (sameRecord(current?.record ?? null, options.next.record)) {
      return current as StoredReleaseSet;
    }
    if (current !== null && options.next.record.manifestSequence <= current.record.manifestSequence) {
      throw securityFailure();
    }
    await writeActivationJournal(path, stagedJournal(current?.record ?? null, options.next.record));
    await options.faultInjector?.hit("after-journal-staging");
    lease.assertHeld();
    const staged = await cache.commitStagedReleaseSet(options.next.record, lease);
    const stored = staged ?? await cache.storeVerifiedReleaseSet(options.next, lease);
    await options.faultInjector?.hit("after-cache-commit");
    lease.assertHeld();
    await writeActivationJournal(path, committedJournal(current?.record ?? null, stored.record));
    await options.faultInjector?.hit("after-journal-commit");
    lease.assertHeld();
    await removeActivationJournal(path);
    lease.assertHeld();
    return stored;
  });
}
