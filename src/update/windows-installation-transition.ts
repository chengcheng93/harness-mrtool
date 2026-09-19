import { randomBytes } from "node:crypto";

import { canonicalizeJson, sha256Utf8 } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { advanceInstallationJournal } from "./installation-journal-transition.ts";
import type {
  InstallationJournal,
  InstallationFileIdentity,
  InstallationInnerEvidence,
  InstallationJournalRoots,
  InstallationProcessIdentity,
  InstallationMutationSlot,
  InstallationLaunchEvidence,
} from "./installation-journal.ts";
import { validateInstallationJournal, validateInstallationLaunchEvidence } from "./installation-journal.ts";
import { advanceWindowsLaunchEvidence } from "./windows-launch-transition.ts";
import type { WindowsMutationPlan } from "./windows-mutation-plan.ts";

export interface WindowsInnerJournalObservation {
  readonly identity: InstallationFileIdentity;
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsLaunchDescriptorObservation {
  readonly identity: InstallationFileIdentity;
  readonly sha256: string;
  readonly size: number;
}

export interface WindowsLaunchReservationInput {
  readonly launchId: string;
  readonly reservationId: string;
  readonly descriptor: WindowsLaunchDescriptorObservation;
  readonly parent: InstallationProcessIdentity;
}

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "windows installation transition is unsafe", {
    field: "update.windowsInstallation",
    expected: "a contiguous identity-bound Windows inner journal and launch reservation",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function createdSlot(journal: InstallationJournal, name: "staged-executable" | "windows-inner-journal" | "launch-descriptor") {
  const slot = journal.slots.find((item) => item.name === name);
  if (slot === undefined || slot.state !== "created") throw failure(`missing-${name}`);
  return slot;
}

function validIdentity(value: unknown): value is InstallationFileIdentity {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { readonly dev?: unknown; readonly ino?: unknown };
  return typeof candidate.dev === "string" && /^(?:0|[1-9][0-9]{0,19})$/u.test(candidate.dev) &&
    typeof candidate.ino === "string" && /^[1-9][0-9]{0,19}$/u.test(candidate.ino) &&
    BigInt(candidate.dev) <= 0xffffffffffffffffn && BigInt(candidate.ino) <= 0xffffffffffffffffn;
}

function checkPlan(journal: InstallationJournal, plan: WindowsMutationPlan): void {
  if (journal.platform !== "windows-x64" || journal.windows === null) throw failure("not-windows");
  if (journal.windows.inner !== null || journal.slots.some((slot) => slot.name === "windows-inner-journal")) {
    throw failure("inner-journal-already-bound");
  }
  if (plan.operation !== journal.operation || plan.installationId !== journal.installationId ||
      plan.enrollmentId !== journal.enrollmentId || plan.attemptId !== journal.attemptId ||
      plan.transactionId !== journal.transactionId || plan.journalRevision !== journal.revision ||
      plan.authorityEpoch !== journal.control.authorityEpoch + 1) {
    throw failure("plan-binding-mismatch");
  }
  if (plan.previous.executableSha256 !== journal.previousEvidence.native.sha256 ||
      plan.previous.executableSize !== journal.previousEvidence.native.size ||
      plan.previous.markerSha256 !== journal.previousEvidence.marker.sha256 ||
      plan.previous.markerSize !== journal.previousEvidence.marker.size ||
      plan.next.executableSha256 !== journal.nextEvidence.native.sha256 ||
      plan.next.executableSize !== journal.nextEvidence.native.size ||
      plan.next.markerSha256 !== journal.nextEvidence.marker.sha256 ||
      plan.next.markerSize !== journal.nextEvidence.marker.size) {
    throw failure("plan-evidence-mismatch");
  }
}

function randomId(): string {
  return randomBytes(16).toString("hex");
}

function operationEvidence(
  current: InstallationJournal,
  expectedRevision: number,
  authorityEpoch: number,
  admittedSlots: readonly InstallationMutationSlot[],
): InstallationJournal["control"]["operations"][number] {
  const binding = {
    authorityEpoch,
    workerId: randomId(),
    operationId: randomId(),
    attemptId: current.attemptId,
    transactionId: current.transactionId,
    expectedRevision,
    previousTupleSha256: current.previousEvidence.tupleSha256,
    nextTupleSha256: current.nextEvidence.tupleSha256,
    admittedSlots,
    status: "drained" as const,
  };
  return Object.freeze({ ...binding, receiptSha256: sha256Utf8(canonicalizeJson(binding)) });
}

function candidateWith(
  current: InstallationJournal,
  slots: InstallationJournal["slots"],
  windows: NonNullable<InstallationJournal["windows"]>,
  admittedSlots: readonly InstallationMutationSlot[],
  controlEpoch = current.control.authorityEpoch + 1,
  phase: InstallationJournal["phase"] = current.phase,
  outcome: InstallationJournal["outcome"] = current.outcome,
): InstallationJournal {
  const revision = current.revision + 1;
  const operation = operationEvidence(current, revision, controlEpoch, admittedSlots);
  return advanceInstallationJournal(current, validateInstallationJournal({
    ...current,
    revision,
    phase,
    outcome,
    slots,
    control: { authorityEpoch: controlEpoch, operations: Object.freeze([...current.control.operations, operation]) },
    windows,
    terminalEvidenceSha256: null,
  }));
}

/** Attach observed fixed-slot evidence to a prepared Windows outer journal. */
export function attachWindowsInnerJournal(
  current: unknown,
  plan: WindowsMutationPlan,
  observation: WindowsInnerJournalObservation,
): InstallationJournal {
  try {
    const journal = validateInstallationJournal(current);
    checkPlan(journal, plan);
    if (observation === null || typeof observation !== "object" ||
        !/^[0-9a-f]{64}$/u.test(observation.sha256) ||
        !Number.isSafeInteger(observation.size) || observation.size < 1 || observation.size > 32 * 1024 ||
        !validIdentity(observation.identity)) throw failure("invalid-inner-observation");
    const slots = Object.freeze([
      ...journal.slots,
      Object.freeze({
        name: "windows-inner-journal" as const,
        state: "created" as const,
        expectedSha256: observation.sha256,
        expectedSize: observation.size,
        identity: Object.freeze({ ...observation.identity }),
      }),
    ]);
    const inner: InstallationInnerEvidence = Object.freeze({
      attemptId: journal.attemptId,
      transactionId: journal.transactionId,
      roots: journal.roots as InstallationJournalRoots,
      previousTupleSha256: journal.previousEvidence.tupleSha256,
      nextTupleSha256: journal.nextEvidence.tupleSha256,
      previousNativeSha256: journal.previousEvidence.native.sha256,
      nextNativeSha256: journal.nextEvidence.native.sha256,
      slot: "windows-inner-journal",
      identity: Object.freeze({ ...observation.identity }),
      sha256: observation.sha256,
      size: observation.size,
    });
    return candidateWith(journal, slots, Object.freeze({ inner, launch: journal.windows!.launch }), ["windows-inner-journal", "installation-journal"]);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("malformed-inner-transition");
  }
}

/**
 * Persist one guarded Windows launch lifecycle step in the outer journal.
 * The caller supplies evidence from the native child/descriptor boundary; this
 * function only binds it to the current transaction and records a new receipt.
 */
export function advanceWindowsLaunchInJournal(
  current: unknown,
  nextLaunch: InstallationLaunchEvidence,
): InstallationJournal {
  try {
    const journal = validateInstallationJournal(current);
    if (journal.platform !== "windows-x64" || journal.windows === null || journal.windows.launch === null) {
      throw failure("launch-required");
    }
    const next = validateInstallationLaunchEvidence(nextLaunch);
    if (next.authorityEpoch !== journal.control.authorityEpoch + 1 ||
        next.expectedRevision !== journal.revision + 1) {
      throw failure("launch-revision-binding-mismatch");
    }
    const checked = advanceWindowsLaunchEvidence(journal.windows.launch, next);
    return candidateWith(
      journal,
      journal.slots,
      Object.freeze({ inner: journal.windows.inner, launch: checked }),
      ["installation-journal"],
      next.authorityEpoch,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("malformed-launch-transition");
  }
}

/** Enter the Windows deferred-execution phase only after launch admission is durable. */
export function markWindowsExecutionPending(current: unknown): InstallationJournal {
  try {
    const journal = validateInstallationJournal(current);
    if (journal.platform !== "windows-x64" || journal.windows === null || journal.windows.launch === null ||
        journal.windows.launch.state !== "admitted" || journal.phase !== "prepared") {
      throw failure("admitted-launch-and-prepared-journal-required");
    }
    const launch = Object.freeze({
      ...journal.windows.launch,
      authorityEpoch: journal.control.authorityEpoch + 1,
      expectedRevision: journal.revision + 1,
    });
    const checked = advanceWindowsLaunchEvidence(journal.windows.launch, launch);
    return candidateWith(
      journal,
      journal.slots,
      Object.freeze({ inner: journal.windows.inner, launch: checked }),
      ["installation-journal"],
      launch.authorityEpoch,
      "execution-pending",
      null,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("malformed-execution-pending-transition");
  }
}

/** Reserve a one-shot Windows launch after the inner journal is durably observed. */
export function reserveWindowsLaunch(
  current: unknown,
  input: WindowsLaunchReservationInput,
): InstallationJournal {
  try {
    const journal = validateInstallationJournal(current);
    if (journal.platform !== "windows-x64" || journal.windows === null || journal.windows.inner === null) throw failure("inner-journal-required");
    if (journal.windows.launch !== null || journal.slots.some((slot) => slot.name === "launch-descriptor")) throw failure("launch-already-bound");
    const staged = createdSlot(journal, "staged-executable");
    if (input === null || typeof input !== "object" || !/^[a-f0-9]{32}$/u.test(input.launchId) ||
        !/^[a-f0-9]{32}$/u.test(input.reservationId) || input.descriptor === null ||
        !/^[a-f0-9]{64}$/u.test(input.descriptor.sha256) || !validIdentity(input.descriptor.identity) ||
        !Number.isSafeInteger(input.descriptor.size) || input.descriptor.size < 1 || input.descriptor.size > 8 * 1024 || input.parent === null ||
        !Number.isSafeInteger(input.parent.pid) || input.parent.pid < 1 || input.parent.pid > 0xffffffff ||
        !/^win:[1-9][0-9]{0,19}$/u.test(input.parent.startKey) || !/^[a-f0-9]{32}$/u.test(input.parent.launchNonce)) {
      throw failure("invalid-launch-reservation");
    }
    const authorityEpoch = journal.control.authorityEpoch + 1;
    const revision = journal.revision + 1;
    const descriptorSlot = Object.freeze({
      name: "launch-descriptor" as const,
      state: "created" as const,
      expectedSha256: input.descriptor.sha256,
      expectedSize: input.descriptor.size,
      identity: Object.freeze({ ...input.descriptor.identity }),
    });
    const launch = Object.freeze({
      launchId: input.launchId,
      reservationId: input.reservationId,
      installationId: journal.installationId,
      enrollmentId: journal.enrollmentId,
      attemptId: journal.attemptId,
      transactionId: journal.transactionId,
      authorityEpoch,
      expectedRevision: revision,
      nextTupleSha256: journal.nextEvidence.tupleSha256,
      nextNativeSha256: journal.nextEvidence.native.sha256,
      targetIdentity: Object.freeze({ ...staged.identity }),
      descriptorSha256: input.descriptor.sha256,
      grantSha256: null,
      parent: Object.freeze({ ...input.parent }),
      child: null,
      state: "reserved" as const,
      exitCode: null,
      settlement: Object.freeze({ state: "unsettled" as const }),
    });
    return candidateWith(
      journal,
      Object.freeze([...journal.slots, descriptorSlot]),
      Object.freeze({ inner: journal.windows.inner, launch }),
      ["launch-descriptor", "installation-journal"],
      authorityEpoch,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("malformed-launch-reservation");
  }
}
