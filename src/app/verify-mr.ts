import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { ToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import { renderDescription } from "../render/markdown.ts";
import {
  parseDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type DesiredWritePlanSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import type { RemoteMergeRequest } from "./create-mr.ts";
import { assertManagedDescription } from "./description-ownership.ts";

export type VerificationLevel = "structure" | "ready" | "merge";

export interface MergeRequestVerificationExpectation {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly description: string;
  readonly sourceBranch: string;
}

export interface VerifyMergeRequestInputs {
  readonly level: VerificationLevel;
  readonly current: RemoteMergeRequest;
  readonly bundle: LoadedTemplateBundle;
  readonly expected: MergeRequestVerificationExpectation;
}

export interface MergeRequestVerificationResult {
  readonly valid: true;
  readonly level: VerificationLevel;
  readonly iid: number;
  readonly webUrl: string;
  readonly live: {
    readonly lifecycle: "draft" | "ready";
    readonly ciStatus: ExternalContextSnapshot["ci"]["status"];
    readonly unresolvedDiscussions: number | null;
    readonly qualifiedApprovals: number | null;
  };
}

export function assertTransactionStructure(
  current: RemoteMergeRequest,
  expectedDescription: string,
  bundle: LoadedTemplateBundle,
  releaseTag: string,
): void {
  assertManagedDescription(current.description, bundle, releaseTag);
  if (current.description !== expectedDescription ||
      parseDiagnosticMarker(current.description).renderPhase !== "final") {
    throw verificationError("description body or diagnostic marker drifted during the transaction");
  }
}

function verificationError(reason: string): ToolError<"POSTCONDITION_ERROR"> {
  return new ToolError("POSTCONDITION_ERROR", "Merge request verification failed", {
    field: "mergeRequest",
    expected: "canonical managed fields, a verified final marker, and live state satisfying the requested level",
    actual: reason,
    safeNextStep: "Refresh the MR and context, inspect the reported drift, and update it through harness-mrtool.",
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function reviewPolicy(bundle: LoadedTemplateBundle): {
  readonly ready: number;
  readonly highRisk: number;
  readonly mergeStatusName: string;
} {
  const review = bundle.policy.review;
  const labels = bundle.policy.labels;
  const lifecycle = labels !== null && typeof labels === "object" && !Array.isArray(labels)
    ? labels.lifecycle
    : null;
  const expectedNames = lifecycle !== null && typeof lifecycle === "object" && !Array.isArray(lifecycle)
    ? lifecycle.expectedNames
    : null;
  if (review === null || typeof review !== "object" || Array.isArray(review) ||
      !Number.isSafeInteger(review.readyMinimumReviewers) ||
      !Number.isSafeInteger(review.highRiskMinimumReviewers) ||
      (review.readyMinimumReviewers as number) < 0 ||
      (review.highRiskMinimumReviewers as number) < 0 ||
      expectedNames === null || typeof expectedNames !== "object" || Array.isArray(expectedNames) ||
      typeof expectedNames.merge !== "string" || expectedNames.merge === "") {
    throw verificationError("Bundle review Policy is invalid");
  }
  return {
    ready: review.readyMinimumReviewers as number,
    highRisk: review.highRiskMinimumReviewers as number,
    mergeStatusName: expectedNames.merge,
  };
}

export function assertReadyGate(
  snapshotValue: ExternalContextSnapshot,
  request: Request,
  writePlanValue: DesiredWritePlanSnapshot,
  bundle: LoadedTemplateBundle,
): void {
  validateTemplateBundle(bundle);
  const snapshot = validateExternalContextSnapshot(snapshotValue);
  const writePlan = validateDesiredWritePlan(writePlanValue);
  if (request.intent !== "ready") {
    throw verificationError("Ready gate requires a Ready-intent Request");
  }
  const policy = reviewPolicy(bundle);
  const minimum = request.risk.level === "high"
    ? Math.max(policy.ready, policy.highRisk)
    : policy.ready;
  const qualified = snapshot.review.qualifiedReviewerUserIds;
  const qualifiedReviewers = qualified === null
    ? null
    : writePlan.reviewerUserIds.filter((id) =>
        id !== snapshot.mergeRequest.authorUserId && qualified.includes(id)).length;
  if (qualifiedReviewers === null || qualifiedReviewers < minimum) {
    throw verificationError("the latest qualified reviewer selection does not satisfy Ready Policy");
  }
}

function assertStructure(inputs: VerifyMergeRequestInputs): {
  readonly currentSnapshot: ExternalContextSnapshot;
  readonly expectedSnapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
} {
  validateTemplateBundle(inputs.bundle);
  assertManagedDescription(
    inputs.current.description,
    inputs.bundle,
    inputs.expected.releaseTag,
  );
  if (!(["structure", "ready", "merge"] as const).includes(inputs.level)) {
    throw verificationError("verification level is invalid");
  }
  const currentSnapshot = validateExternalContextSnapshot(inputs.current.snapshot);
  const expectedSnapshot = validateExternalContextSnapshot(inputs.expected.snapshot);
  const writePlan = validateDesiredWritePlan(inputs.expected.writePlan);
  const expectedLifecycle = inputs.expected.request.intent;
  const currentLifecycle = inputs.current.draft ? "draft" : "ready";
  const regenerated = renderDescription({
    request: inputs.expected.request,
    snapshot: expectedSnapshot,
    writePlan,
    bundle: inputs.bundle,
    releaseTag: inputs.expected.releaseTag,
    cliVersion: inputs.expected.cliVersion,
    renderPhase: "final",
    ...(inputs.expected.request.intent === "ready" && expectedSnapshot.mergeRequest.lifecycle === "draft"
      ? { snapshotExpectation: "ready-transition-pending" as const }
      : {}),
  });
  if (inputs.current.description !== inputs.expected.description ||
      inputs.current.description !== regenerated ||
      parseDiagnosticMarker(inputs.current.description).renderPhase !== "final") {
    throw verificationError("description body or diagnostic marker drifted");
  }
  if (inputs.current.iid < 1 || inputs.current.webUrl === "" || inputs.current.state !== "opened" ||
      inputs.current.sourceProjectId !== expectedSnapshot.sourceProject.id ||
      inputs.current.targetProjectId !== expectedSnapshot.targetProject.id ||
      inputs.current.sourceBranch !== inputs.expected.sourceBranch ||
      inputs.current.targetBranch !== inputs.expected.request.targetBranch ||
      inputs.current.sourceHeadSha !== expectedSnapshot.sourceHeadSha ||
      inputs.current.title !== writePlan.title ||
      currentLifecycle !== expectedLifecycle ||
      !sameIds(inputs.current.labelIds, writePlan.labelIds) ||
      inputs.current.assigneeUserId !== writePlan.assigneeUserId ||
      !sameIds(inputs.current.reviewerUserIds, writePlan.reviewerUserIds) ||
      inputs.current.squash !== writePlan.squash ||
      inputs.current.removeSourceBranch !== writePlan.removeSourceBranch ||
      currentSnapshot.mergeRequest.iid !== inputs.current.iid ||
      currentSnapshot.mergeRequest.lifecycle !== currentLifecycle ||
      !sameIds(currentSnapshot.mergeRequest.labelIds, inputs.current.labelIds) ||
      currentSnapshot.mergeRequest.assigneeUserId !== inputs.current.assigneeUserId ||
      !sameIds(currentSnapshot.mergeRequest.reviewerUserIds, inputs.current.reviewerUserIds) ||
      currentSnapshot.sourceHeadSha !== expectedSnapshot.sourceHeadSha ||
      currentSnapshot.targetRefSha !== expectedSnapshot.targetRefSha) {
    throw verificationError("managed field, lifecycle, branch, or source SHA drifted");
  }
  return { currentSnapshot, expectedSnapshot, writePlan };
}

export function verifyMergeRequest(inputs: VerifyMergeRequestInputs): MergeRequestVerificationResult {
  const { currentSnapshot } = assertStructure(inputs);
  const policy = reviewPolicy(inputs.bundle);
  const qualified = currentSnapshot.review.qualifiedReviewerUserIds;
  const qualifiedReviewers = qualified === null
    ? null
    : inputs.current.reviewerUserIds.filter((id) => qualified.includes(id)).length;
  const minimum = inputs.expected.request.risk.level === "high"
    ? Math.max(policy.ready, policy.highRisk)
    : policy.ready;
  if (inputs.level !== "structure" && inputs.expected.request.intent !== "ready") {
    throw verificationError("ready and merge verification require a Ready-intent MR");
  }
  if (inputs.level === "ready" &&
      (qualifiedReviewers === null || qualifiedReviewers < minimum)) {
    throw verificationError("the current qualified reviewer selection does not satisfy Ready Policy");
  }
  const qualifiedApprovals = qualified === null
    ? null
    : currentSnapshot.review.approvedByUserIds.filter((id) =>
        id !== currentSnapshot.mergeRequest.authorUserId && qualified.includes(id)).length;
  const liveLabelNames = new Map(currentSnapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const hasMergeStatus = inputs.current.labelIds.some((id) => liveLabelNames.get(id) === policy.mergeStatusName);
  if (inputs.level === "merge" && (
    !hasMergeStatus ||
    currentSnapshot.ci.status !== "passed" ||
    currentSnapshot.review.unresolvedDiscussions !== 0 ||
    qualifiedApprovals === null || qualifiedApprovals < minimum
  )) {
    throw verificationError("live CI, approvals, or blocking discussions do not satisfy merge Policy");
  }
  return Object.freeze({
    valid: true,
    level: inputs.level,
    iid: inputs.current.iid,
    webUrl: inputs.current.webUrl,
    live: Object.freeze({
      lifecycle: inputs.current.draft ? "draft" : "ready",
      ciStatus: currentSnapshot.ci.status,
      unresolvedDiscussions: currentSnapshot.review.unresolvedDiscussions,
      qualifiedApprovals,
    }),
  });
}
