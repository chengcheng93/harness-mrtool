import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  validateInstallationLaunchEvidence,
  type InstallationLaunchEvidence,
  type InstallationLaunchState,
} from "./installation-journal.ts";

const NEXT_STATES: Readonly<Record<InstallationLaunchState, readonly InstallationLaunchState[]>> = Object.freeze({
  reserved: ["reserved", "registered", "revoked"],
  registered: ["registered", "claimed", "revoked"],
  claimed: ["claimed", "ack-issued", "revoked"],
  "ack-issued": ["ack-issued", "admitted", "outcome-unknown", "revoked"],
  admitted: ["admitted", "completed", "outcome-unknown"],
  completed: ["completed"],
  "outcome-unknown": ["outcome-unknown"],
  revoked: ["revoked"],
});

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "windows launch transition is unsafe", {
    field: "windowsLaunch",
    expected: "a contiguous one-shot launch lifecycle with monotonic authority and revision",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function immutableBinding(value: InstallationLaunchEvidence): string {
  return canonicalizeJson({
    launchId: value.launchId,
    reservationId: value.reservationId,
    installationId: value.installationId,
    enrollmentId: value.enrollmentId,
    attemptId: value.attemptId,
    transactionId: value.transactionId,
    nextTupleSha256: value.nextTupleSha256,
    nextNativeSha256: value.nextNativeSha256,
    targetIdentity: value.targetIdentity,
    descriptorSha256: value.descriptorSha256,
    parent: value.parent,
  });
}

function mutableBinding(value: InstallationLaunchEvidence): string {
  return canonicalizeJson({
    child: value.child,
    grantSha256: value.grantSha256,
    state: value.state,
    exitCode: value.exitCode,
  });
}

function settlementBinding(value: InstallationLaunchEvidence): string {
  return canonicalizeJson(value.settlement);
}

function terminal(state: InstallationLaunchState): boolean {
  return state === "completed" || state === "outcome-unknown" || state === "revoked";
}

export interface WindowsLaunchTransition {
  readonly from: InstallationLaunchEvidence;
  readonly to: InstallationLaunchEvidence;
}

/**
 * Pure lifecycle guard for the private Windows launch evidence. It does not
 * spawn, wait, acquire a lease, or grant mutation authority. The caller must
 * persist the returned evidence through the outer journal while holding U.
 */
export function advanceWindowsLaunchEvidence(
  current: unknown,
  next: unknown,
): InstallationLaunchEvidence {
  try {
    const from = validateInstallationLaunchEvidence(current);
    const to = validateInstallationLaunchEvidence(next);
    if (immutableBinding(from) !== immutableBinding(to)) throw failure("immutable-binding-changed");
    if (to.authorityEpoch <= from.authorityEpoch || to.expectedRevision <= from.expectedRevision) {
      throw failure("authority-or-revision-not-monotonic");
    }
    if (!(NEXT_STATES[from.state] as readonly string[]).includes(to.state)) throw failure(`${from.state}->${to.state}`);
    if (from.settlement.state === "settled") {
      if (to.state !== from.state || settlementBinding(from) !== settlementBinding(to)) throw failure("settled-launch-changed");
    } else if (to.settlement.state === "settled" && !terminal(to.state)) {
      throw failure("settled-before-terminal");
    }
    if (from.state === to.state && mutableBinding(from) !== mutableBinding(to)) throw failure("same-state-evidence-changed");
    if (from.state !== to.state && to.state === "registered" && to.grantSha256 !== null) throw failure("registered-grant");
    return to;
  } catch (error) {
    if (error instanceof ToolError && error.message === "windows launch transition is unsafe") throw error;
    throw failure("malformed-launch-evidence");
  }
}
