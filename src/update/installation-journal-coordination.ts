import { randomBytes } from "node:crypto";

import { ToolError } from "../contracts/errors.ts";

import { canonicalizeJson } from "../contracts/jcs.ts";
import { sha256Utf8 } from "../contracts/jcs.ts";
import { advanceInstallationJournal } from "./installation-journal-transition.ts";
import {
  validateInstallationJournal,
  type InstallationJournal,
  type InstallationJournalPhase,
  type InstallationOperationEvidence,
  type InstallationSlot,
} from "./installation-journal.ts";

function randomId(): string {
  return randomBytes(16).toString("hex");
}

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "installation journal transition is unsafe", {
    field: "installationJournal",
    expected: "a contiguous phase transition with a settled Windows handoff",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function terminalDigest(journal: InstallationJournal): string {
  const { phase: _phase, revision: _revision, terminalEvidenceSha256: _digest, ...evidence } = journal;
  return sha256Utf8(canonicalizeJson(evidence));
}

export function createInstallationOperationEvidence(
  journal: InstallationJournal,
  revision: number,
  epoch: number,
): InstallationOperationEvidence {
  const binding = {
    authorityEpoch: epoch,
    workerId: randomId(),
    operationId: randomId(),
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    expectedRevision: revision,
    previousTupleSha256: journal.previousEvidence.tupleSha256,
    nextTupleSha256: journal.nextEvidence.tupleSha256,
    admittedSlots: [
      "staged-executable", "staged-marker", "previous-executable", "previous-marker",
      "canonical-executable", "canonical-marker", "active-pointer", "installation-journal",
    ] as const,
    status: "drained" as const,
  };
  return Object.freeze({ ...binding, receiptSha256: sha256Utf8(canonicalizeJson(binding)) });
}

/**
 * Advance one durable outer installation phase. This is deliberately data-only:
 * callers must perform and re-observe native mutations before invoking it.
 */
export function advanceInstallationJournalPhase(
  current: unknown,
  phase: InstallationJournalPhase,
  outcome: InstallationJournal["outcome"],
  slots?: readonly InstallationSlot[],
): InstallationJournal {
  const journal = validateInstallationJournal(current);
  const revision = journal.revision + 1;
  const operation = createInstallationOperationEvidence(journal, revision, journal.control.authorityEpoch + 1);
  const currentLaunch = journal.windows?.launch ?? null;
  if (currentLaunch !== null &&
      ["publish-intent", "canonical-published", "marker-published", "commit-intent", "committed"].includes(phase) &&
      (currentLaunch.state !== "completed" || currentLaunch.settlement.state !== "settled")) {
    throw failure("windows persistence launch is not settled");
  }
  const windows = journal.windows === null || currentLaunch === null
    ? journal.windows
    : Object.freeze({
        ...journal.windows,
        launch: Object.freeze({
          ...currentLaunch,
          authorityEpoch: operation.authorityEpoch,
          expectedRevision: revision,
        }),
      });
  const candidate: InstallationJournal = {
    ...journal,
    revision,
    phase,
    outcome,
    slots: Object.freeze([...(slots ?? journal.slots)]),
    control: Object.freeze({
      authorityEpoch: operation.authorityEpoch,
      operations: Object.freeze([...journal.control.operations, operation]),
    }),
    windows,
    terminalEvidenceSha256: null,
  };
  const withTerminal = ["committed", "aborted", "retention-transfer"].includes(phase)
    ? { ...candidate, terminalEvidenceSha256: terminalDigest(candidate) }
    : candidate;
  return validateInstallationJournal(advanceInstallationJournal(journal, withTerminal));
}

export function sealInstallationSettlement(value: {
  readonly state: "settled";
  readonly launchId: string;
  readonly reservationId: string;
  readonly descriptorSha256: string;
  readonly targetIdentity: { readonly dev: string; readonly ino: string };
  readonly parent: { readonly pid: number; readonly startKey: string; readonly launchNonce: string };
  readonly child: { readonly pid: number; readonly startKey: string; readonly launchNonce: string } | null;
}): {
  readonly state: "settled";
  readonly launchId: string;
  readonly reservationId: string;
  readonly descriptorSha256: string;
  readonly targetIdentity: { readonly dev: string; readonly ino: string };
  readonly parent: { readonly pid: number; readonly startKey: string; readonly launchNonce: string };
  readonly child: { readonly pid: number; readonly startKey: string; readonly launchNonce: string } | null;
  readonly receiptSha256: string;
} {
  const binding = Object.freeze({ ...value });
  return Object.freeze({ ...binding, receiptSha256: sha256Utf8(canonicalizeJson(binding)) });
}
