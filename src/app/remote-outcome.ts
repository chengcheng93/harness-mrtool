import { ToolError } from "../contracts/errors.ts";
import { safeRequestId } from "./remote-receipt.ts";

export type RemoteMutationOutcome = "rejected" | "unknown";
export type RemoteMutationFailureReason =
  | "auth"
  | "validation"
  | "conflict"
  | "server"
  | "network"
  | "timeout";

const OUTCOMES = new Set<RemoteMutationOutcome>(["rejected", "unknown"]);
const REASONS = new Set<RemoteMutationFailureReason>([
  "auth",
  "validation",
  "conflict",
  "server",
  "network",
  "timeout",
]);
const READ_REASONS = new Set<RemoteReadFailureReason>([
  "auth",
  "validation",
  "server",
  "network",
  "timeout",
]);
const remoteMutationErrors = new WeakSet<object>();
const remoteReadErrors = new WeakSet<object>();

function assertReasonForOutcome(
  outcome: RemoteMutationOutcome,
  reason: RemoteMutationFailureReason,
): void {
  const valid = outcome === "rejected"
    ? reason === "auth" || reason === "validation" || reason === "conflict"
    : reason === "server" || reason === "network" || reason === "timeout";
  if (!valid) throw new TypeError("Remote mutation outcome and reason are incompatible");
}

export class RemoteMutationError extends Error {
  readonly outcome: RemoteMutationOutcome;
  readonly reason: RemoteMutationFailureReason;
  readonly requestId: string | null;

  constructor(
    outcome: RemoteMutationOutcome,
    reason: RemoteMutationFailureReason,
    requestId: unknown = null,
  ) {
    if (!OUTCOMES.has(outcome)) throw new TypeError("Remote mutation outcome is invalid");
    if (!REASONS.has(reason)) throw new TypeError("Remote mutation failure reason is invalid");
    assertReasonForOutcome(outcome, reason);
    super(outcome === "unknown"
      ? "Remote mutation outcome is unknown"
      : "Remote mutation was rejected");
    this.name = "RemoteMutationError";
    this.outcome = outcome;
    this.reason = reason;
    this.requestId = safeRequestId(requestId);
    remoteMutationErrors.add(this);
  }
}

export function isRemoteMutationError(
  error: unknown,
  outcome?: RemoteMutationOutcome,
): error is RemoteMutationError {
  if ((typeof error !== "object" && typeof error !== "function") ||
      error === null || !remoteMutationErrors.has(error)) {
    return false;
  }
  return outcome === undefined || (error as RemoteMutationError).outcome === outcome;
}

export class UnknownRemoteOutcomeError extends RemoteMutationError {
  constructor(_message = "Remote write outcome is unknown", requestId: unknown = null) {
    super("unknown", "network", requestId);
    this.name = "UnknownRemoteOutcomeError";
  }
}

export type RemoteReadFailureReason = Exclude<RemoteMutationFailureReason, "conflict">;

export class RemoteReadError extends Error {
  readonly reason: RemoteReadFailureReason;
  readonly requestId: string | null;

  constructor(reason: RemoteReadFailureReason, requestId: unknown = null) {
    if (!READ_REASONS.has(reason)) {
      throw new TypeError("Remote read failure reason is invalid");
    }
    super("Remote read failed");
    this.name = "RemoteReadError";
    this.reason = reason;
    this.requestId = safeRequestId(requestId);
    remoteReadErrors.add(this);
  }
}

export function isRemoteReadError(error: unknown): error is RemoteReadError {
  return (typeof error === "object" || typeof error === "function") &&
    error !== null && remoteReadErrors.has(error);
}

export function remoteFailureToolError(
  error: RemoteMutationError | RemoteReadError,
): ToolError<"AUTH_ERROR" | "CONCURRENT_UPDATE" | "GITLAB_ERROR"> {
  const code = error.reason === "auth"
    ? "AUTH_ERROR"
    : error.reason === "conflict"
      ? "CONCURRENT_UPDATE"
      : "GITLAB_ERROR";
  return new ToolError(code, "GitLab operation failed", {
    field: "gitlab",
    expected: "an authorized GitLab operation with a deterministic remote outcome",
    actual: error.requestId === null
      ? `remote ${error.reason}`
      : `remote ${error.reason}; request-id ${error.requestId}`,
    safeNextStep: code === "AUTH_ERROR"
      ? "Refresh the GitLab credential and run doctor before retrying."
      : "Refresh GitLab context, inspect the current MR, and retry the operation safely.",
  });
}
