import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { assertUpdateLockLease } from "../platform/lock.ts";
import type { ProcessLockLease } from "../platform/process-lock.ts";
import {
  decideInstallationRecovery,
  type InstallationRecoveryState,
  type RecoveryDecision,
  type RecoveryFacts,
} from "./installation-recovery.ts";
import type { InstallationJournal } from "./installation-journal.ts";
import type { InstallationJournalStore } from "./installation-journal-store.ts";

const DEFAULT_MAX_STEPS = 8;
const MAX_STEPS = 16;

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "installation recovery is blocked", {
    field: "installationRecovery",
    expected: "a bounded recovery that reaches a stable verified installation",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function stateOf(journal: InstallationJournal): InstallationRecoveryState {
  return Object.freeze({
    phase: journal.phase as InstallationRecoveryState["phase"],
    outcome: journal.outcome,
    platform: journal.platform,
  });
}

function journalKey(journal: InstallationJournal): string {
  return [journal.attemptId, String(journal.revision), journal.phase, journal.outcome ?? "",
    journal.terminalEvidenceSha256 ?? ""].join("\u0000");
}

function validRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value) throw failure("unsafe-state-root");
  return value;
}

function validSteps(value: unknown): number {
  if (value === undefined) return DEFAULT_MAX_STEPS;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_STEPS) {
    throw failure("invalid-step-bound");
  }
  return value as number;
}

function validDriver(value: unknown): asserts value is InstallationRecoveryDriver {
  if (value === null || typeof value !== "object" ||
      typeof (value as { readonly observe?: unknown }).observe !== "function" ||
      typeof (value as { readonly apply?: unknown }).apply !== "function") {
    throw failure("missing-recovery-driver");
  }
}

function validStore(value: unknown): asserts value is InstallationJournalStore {
  if (value === null || typeof value !== "object" ||
      typeof (value as { readonly read?: unknown }).read !== "function") {
    throw failure("missing-journal-store");
  }
}

export interface InstallationRecoveryDriver {
  /** Re-observe canonical bytes, marker, active pointer, policy and launch state. */
  observe(journal: InstallationJournal): Promise<RecoveryFacts>;
  /** Apply exactly one bounded recovery step and persist its progress. */
  apply(decision: RecoveryDecision, journal: InstallationJournal): Promise<void>;
}

export interface InstallationRecoveryCoordinatorOptions {
  readonly stateDirectory: string;
  readonly store: InstallationJournalStore;
  readonly lease: ProcessLockLease;
  readonly driver: InstallationRecoveryDriver;
  readonly maxSteps?: number;
}

/**
 * Resolve the durable outer journal before ordinary business work. This
 * coordinator owns no filesystem mutation authority: the driver must perform
 * every native observation/mutation and must persist progress through the
 * shared journal store. It never replays the business command.
 */
export async function recoverInstallationJournal(
  options: InstallationRecoveryCoordinatorOptions,
): Promise<void> {
  try {
    const stateDirectory = validRoot(options.stateDirectory);
    validStore(options.store);
    validDriver(options.driver);
    if (options.lease === null || typeof options.lease !== "object") throw failure("missing-update-lease");
    assertUpdateLockLease(options.lease, stateDirectory);
    const maxSteps = validSteps(options.maxSteps);
    let previousKey: string | undefined;

    for (let step = 0; step < maxSteps; step += 1) {
      options.lease.assertHeld();
      const journal = await options.store.read();
      if (journal === null) return;
      const currentKey = journalKey(journal);
      if (currentKey === previousKey) throw failure("recovery-made-no-durable-progress");
      previousKey = currentKey;

      const facts = await options.driver.observe(journal);
      const decision = decideInstallationRecovery(stateOf(journal), facts);
      if (decision === "block" || decision === "wait-owner" ||
          decision === "verify-stable-previous" || decision === "verify-stable-next") {
        throw failure(decision);
      }
      await options.driver.apply(decision, journal);
      options.lease.assertHeld();
    }
    throw failure("recovery-step-bound-exceeded");
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("recovery-observation-failed");
  }
}
