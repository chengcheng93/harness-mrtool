import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  validateInstallationJournal,
  type InstallationJournal,
  type InstallationJournalPhase,
} from "./installation-journal.ts";
import { advanceWindowsLaunchEvidence } from "./windows-launch-transition.ts";

export type InstallationJournalTransition = InstallationJournal;

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "installation journal transition is unsafe", {
    field: "installationJournal",
    expected: "a validated contiguous transition for one installation attempt",
    actual,
    safeNextStep: "Preserve the journal and run self-update repair.",
  });
}

const nextPhases: Readonly<Record<InstallationJournalPhase, readonly InstallationJournalPhase[]>> = Object.freeze({
  preparing: ["preparing", "prepared", "aborted", "blocked"],
  prepared: ["prepared", "execution-pending", "publish-intent", "aborted", "blocked"],
  "execution-pending": ["execution-pending", "publish-intent", "compensating", "blocked"],
  "publish-intent": ["publish-intent", "canonical-published", "compensating", "blocked"],
  "canonical-published": ["canonical-published", "marker-published", "compensating", "blocked"],
  "marker-published": ["marker-published", "commit-intent", "compensating", "blocked"],
  "commit-intent": ["commit-intent", "committed", "compensating", "blocked"],
  committed: ["committed", "retention-transfer", "blocked"],
  compensating: ["compensating", "aborted", "blocked"],
  aborted: ["aborted", "retention-transfer", "blocked"],
  blocked: [],
  "retention-transfer": [],
});

function checkWindowsLaunchTransition(previous: InstallationJournal, candidate: InstallationJournal): void {
  const from = previous.windows?.launch ?? null;
  const to = candidate.windows?.launch ?? null;
  if (from === null && to === null) return;
  if (from === null) {
    if (to === null || to.state !== "reserved" || to.settlement.state !== "unsettled") {
      throw failure("launch-must-start-reserved");
    }
    return;
  }
  if (to === null) throw failure("launch-cannot-disappear");
  advanceWindowsLaunchEvidence(from, to);
}

function immutableBinding(journal: InstallationJournal): string {
  return canonicalizeJson({
    journalVersion: journal.journalVersion,
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    operation: journal.operation,
    platform: journal.platform,
    installationId: journal.installationId,
    enrollmentId: journal.enrollmentId,
    roots: journal.roots,
    previous: journal.previous,
    next: journal.next,
    previousEvidence: journal.previousEvidence,
    nextEvidence: journal.nextEvidence,
    authorization: journal.authorization,
  });
}

/**
 * Pure write-ahead transition guard. It validates and detaches both inputs,
 * then permits only a contiguous revision for the same immutable transaction
 * binding. It grants no filesystem, lease, launch, or publication authority.
 */
export function advanceInstallationJournal(current: unknown, next: unknown): InstallationJournal {
  try {
    const previous = validateInstallationJournal(current);
    const candidate = validateInstallationJournal(next);
    if (immutableBinding(previous) !== immutableBinding(candidate)) throw failure("immutable-binding-changed");
    if (candidate.revision !== previous.revision + 1) throw failure("revision-not-contiguous");
    if (!(nextPhases[previous.phase] as readonly string[]).includes(candidate.phase)) {
      throw failure(`${previous.phase}->${candidate.phase}`);
    }
    if (previous.phase === "blocked" || previous.phase === "retention-transfer") {
      throw failure("terminal-journal-cannot-advance");
    }
    checkWindowsLaunchTransition(previous, candidate);
    return candidate;
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("malformed-transition");
  }
}
