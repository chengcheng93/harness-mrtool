import type { NativeMutationExecutor, NativeMutationReceipt } from "../platform/native-mutation-executor.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  attachWindowsInnerJournal,
  validateWindowsMutationPlanForJournal,
} from "./windows-installation-transition.ts";
import type { InstallationJournal } from "./installation-journal.ts";
import { observeWindowsInnerJournal, validateWindowsInstallationRoot, type WindowsInnerJournalObservation } from "./windows-inner-journal.ts";
import { admitWindowsMutationPlan } from "./windows-mutation-authority.ts";
import type { WindowsMutationPlan } from "./windows-mutation-plan.ts";

export interface WindowsInnerJournalCoordinationInput {
  readonly current: unknown;
  readonly installationDirectory: string;
  readonly executor: NativeMutationExecutor;
  readonly plan: WindowsMutationPlan;
}

export interface WindowsInnerJournalCoordinationResult {
  readonly journal: InstallationJournal;
  readonly observation: WindowsInnerJournalObservation;
  readonly receipt: NativeMutationReceipt;
}

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Windows installation coordination is unsafe", {
    field: "update.windowsCoordinator",
    expected: "native plan admission, exact inner observation, and one outer journal binding",
    actual,
    safeNextStep: "Preserve the native and outer journals and run self-update repair.",
  });
}

/**
 * Performs the bounded Windows inner-journal handoff only. The caller owns the
 * live executor and must persist the returned outer journal before releasing it.
 * No canonical executable/marker, active pointer, child launch, or installed
 * result is created by this helper.
 */
export async function coordinateWindowsInnerJournal(
  input: WindowsInnerJournalCoordinationInput,
): Promise<WindowsInnerJournalCoordinationResult> {
  try {
    const current = validateWindowsMutationPlanForJournal(input.current, input.plan);
    const root = await validateWindowsInstallationRoot(input.installationDirectory);
    if (root.dev !== current.roots.installation.dev || root.ino !== current.roots.installation.ino) {
      throw failure("installation-root-identity-mismatch");
    }
    const admitted = await admitWindowsMutationPlan(input.executor, input.plan);
    const observation = await observeWindowsInnerJournal(input.installationDirectory, admitted.plan);
    const journal = attachWindowsInnerJournal(current, admitted.plan, observation);
    return Object.freeze({ journal, observation, receipt: admitted.receipt });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("inner-journal-coordination-failed");
  }
}
