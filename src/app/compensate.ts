import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { ToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import { renderDescription } from "../render/markdown.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import type {
  ManagedFieldsInput,
  MergeRequestRemote,
  RemoteMergeRequest,
} from "./create-mr.ts";
import type { MergeRequestWritePlan } from "./write-plan.ts";
import {
  isRemoteMutationError,
  isRemoteReadError,
  remoteFailureToolError,
} from "./remote-outcome.ts";
import type { RemoteMutationReceipt, RemoteValueReceipt } from "./remote-receipt.ts";
import {
  stageVerificationReceipt,
  type VerificationReceiptWriter,
} from "./verify-mr.ts";
import {
  remoteSnapshotDigest,
  type TransactionJournal,
  type TransactionPhase,
  type TransactionStepOperation,
} from "./transaction-journal.ts";

export interface ManagedTransactionContext {
  readonly request: Request;
  readonly initialSnapshot: ExternalContextSnapshot;
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly remote: MergeRequestRemote;
  readonly writePlan: MergeRequestWritePlan;
  readonly journal: TransactionJournal;
  readonly gitlabOrigin: string;
  readonly verificationReceiptWriter: VerificationReceiptWriter;
}

export function transactionError(
  code: "POSTCONDITION_ERROR" | "PARTIAL_DRAFT" | "PARTIAL_REMOTE_STATE",
  message: string,
  actual: string,
  cause?: unknown,
): ToolError {
  return new ToolError(code, message, {
    field: "mergeRequest",
    expected: "a fully read-back Draft or Ready merge request matching the verified write plan",
    actual,
    safeNextStep: "Inspect the reported merge request, refresh context, and retry without deleting the Draft.",
  }, cause);
}

function hasRecordedRemoteWrite(journal: TransactionJournal): boolean {
  return journal.snapshot().steps.some((step) =>
    step.mutation?.outcome === "confirmed" || step.mutation?.outcome === "unknown");
}

function concurrentPreReadError(operation: TransactionStepOperation): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError("CONCURRENT_UPDATE", "GitLab changed before the planned write", {
    field: "mergeRequest",
    expected: "the exact remote snapshot used to plan the next mutation",
    actual: `${operation} pre-read drifted before mutation`,
    safeNextStep: "Refresh context, preserve any human changes, and preview the operation again.",
  });
}

export function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

export function assertRemoteIdentity(
  current: RemoteMergeRequest,
  context: ManagedTransactionContext,
): ExternalContextSnapshot {
  const { initialSnapshot, request, sourceBranch } = context;
  const snapshot = validateExternalContextSnapshot(current.snapshot);
  const expectedLifecycle = current.draft ? "draft" : "ready";
  const relevantLabelIds = new Set([
    ...context.writePlan.managedLabelIds,
    ...context.writePlan.draft.labelIds,
    ...context.writePlan.desired.labelIds,
  ]);
  const initialLabels = new Map(initialSnapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const currentLabels = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const labelBindingChanged = [...relevantLabelIds].some((id) =>
    initialLabels.get(id) === undefined || initialLabels.get(id) !== currentLabels.get(id));
  const relevantUserIds = new Set([
    initialSnapshot.mergeRequest.authorUserId,
    ...(context.writePlan.desired.assigneeUserId === null ? [] : [context.writePlan.desired.assigneeUserId]),
    ...context.writePlan.desired.reviewerUserIds,
  ]);
  const initialUsers = new Map(initialSnapshot.userCandidates.map((user) => [user.id, user] as const));
  const currentUsers = new Map(snapshot.userCandidates.map((user) => [user.id, user] as const));
  const userBindingChanged = [...relevantUserIds].some((id) => {
    const initial = initialUsers.get(id);
    const live = currentUsers.get(id);
    return initial === undefined || live === undefined ||
      initial.username !== live.username || initial.displayName !== live.displayName;
  });
  if (!Number.isSafeInteger(current.iid) || current.iid < 1 || current.webUrl === "" ||
      current.state !== "opened" ||
      current.sourceProjectId !== initialSnapshot.sourceProject.id ||
      current.sourceBranch !== sourceBranch ||
      current.targetProjectId !== initialSnapshot.targetProject.id ||
      current.targetBranch !== request.targetBranch ||
      current.sourceHeadSha !== initialSnapshot.sourceHeadSha ||
      snapshot.targetProject.id !== initialSnapshot.targetProject.id ||
      snapshot.targetProject.path !== initialSnapshot.targetProject.path ||
      snapshot.sourceProject.id !== initialSnapshot.sourceProject.id ||
      snapshot.sourceProject.path !== initialSnapshot.sourceProject.path ||
      snapshot.targetRefSha !== initialSnapshot.targetRefSha ||
      snapshot.mergeBaseSha !== initialSnapshot.mergeBaseSha ||
      snapshot.sourceHeadSha !== initialSnapshot.sourceHeadSha ||
      snapshot.mergeRequest.iid !== current.iid ||
      snapshot.mergeRequest.authorUserId !== initialSnapshot.mergeRequest.authorUserId ||
      snapshot.mergeRequest.lifecycle !== expectedLifecycle ||
      !sameIds(snapshot.mergeRequest.labelIds, current.labelIds) ||
      snapshot.mergeRequest.assigneeUserId !== current.assigneeUserId ||
      !sameIds(snapshot.mergeRequest.reviewerUserIds, current.reviewerUserIds) ||
      labelBindingChanged || userBindingChanged) {
    throw transactionError(
      "POSTCONDITION_ERROR",
      "GitLab merge request identity or readback changed during the transaction",
      "remote identity mismatch",
    );
  }
  return snapshot;
}

export async function readVerified(
  context: ManagedTransactionContext,
  iid: number,
): Promise<RemoteMergeRequest> {
  return (await readVerifiedReceipt(context, iid)).value;
}

export async function readVerifiedReceipt(
  context: ManagedTransactionContext,
  iid: number,
): Promise<RemoteValueReceipt<RemoteMergeRequest>> {
  const receipt = await context.remote.read(iid);
  assertRemoteIdentity(receipt.value, context);
  return receipt;
}

export async function syncLabels(
  context: ManagedTransactionContext,
  currentValue: RemoteMergeRequest,
  targetIds: readonly string[],
  managedIds: readonly string[],
  completed: string[],
  onRecoveredUnknown?: () => void,
  phase: TransactionPhase = "normal",
  lifecycleTransition = false,
): Promise<RemoteMergeRequest> {
  let current = currentValue;
  const target = new Set(targetIds);
  const additions = targetIds.filter((id) => !current.labelIds.includes(id));
  if (additions.length > 0) {
    current = await writeAndRead(
      context,
      current,
      phase === "compensation" ? "compensation-labels-add"
        : lifecycleTransition ? "lifecycle-status-ready-add" : "labels-add",
      phase,
      completed,
      () => context.remote.addLabels(current.iid, additions),
      onRecoveredUnknown,
      (value) => {
        if (additions.some((id) => !value.labelIds.includes(id))) {
          throw transactionError("POSTCONDITION_ERROR", "Added labels were not read back", "label add mismatch");
        }
      },
    );
  }
  const managed = new Set(managedIds);
  const removals = current.labelIds.filter((id) => managed.has(id) && !target.has(id));
  if (removals.length > 0) {
    current = await writeAndRead(
      context,
      current,
      phase === "compensation" ? "compensation-labels-remove"
        : lifecycleTransition ? "lifecycle-status-ready-remove" : "labels-remove",
      phase,
      completed,
      () => context.remote.removeLabels(current.iid, removals),
      onRecoveredUnknown,
      (value) => {
        if (removals.some((id) => value.labelIds.includes(id))) {
          throw transactionError("POSTCONDITION_ERROR", "Removed labels were still present", "label remove mismatch");
        }
      },
    );
  }
  if (!sameIds(current.labelIds, targetIds)) {
    throw transactionError(
      "POSTCONDITION_ERROR",
      "GitLab labels do not match the verified write plan",
      "label readback mismatch",
    );
  }
  return current;
}

export async function writeAndRead(
  context: ManagedTransactionContext,
  currentValue: RemoteMergeRequest,
  operation: TransactionStepOperation,
  phase: TransactionPhase,
  completed: string[],
  write: () => Promise<RemoteMutationReceipt>,
  onRecoveredUnknown?: () => void,
  postcondition?: (current: RemoteMergeRequest) => void,
): Promise<RemoteMergeRequest> {
  const step = context.journal.start(phase, operation, currentValue);
  let preRead: RemoteValueReceipt<RemoteMergeRequest>;
  try {
    preRead = await readVerifiedReceipt(context, currentValue.iid);
  } catch (error) {
    step.preReadFailed(isRemoteReadError(error) ? error.requestId : null);
    throw isRemoteReadError(error)
      ? remoteFailureToolError(error)
      : transactionError(
          "PARTIAL_REMOTE_STATE",
          "The immediate GitLab pre-read could not be proven",
          `${operation} pre-read is unavailable or inconsistent`,
          error,
        );
  }
  step.preReadSucceeded(preRead.requestId, preRead.value);
  if (remoteSnapshotDigest(preRead.value) !== remoteSnapshotDigest(currentValue)) {
    throw hasRecordedRemoteWrite(context.journal)
      ? transactionError(
          "PARTIAL_REMOTE_STATE",
          "GitLab changed after an earlier transaction write",
          `${operation} pre-read drifted before mutation`,
        )
      : concurrentPreReadError(operation);
  }
  let recovered = false;
  try {
    const receipt = await write();
    step.mutation("confirmed", receipt.requestId);
  } catch (error) {
    if (isRemoteMutationError(error, "rejected")) {
      step.mutation("rejected", error.requestId);
      throw remoteFailureToolError(error);
    }
    step.mutation("unknown", isRemoteMutationError(error, "unknown") ? error.requestId : null);
    recovered = true;
  }
  let receipt: RemoteValueReceipt<RemoteMergeRequest>;
  try {
    receipt = await readVerifiedReceipt(context, currentValue.iid);
    step.readSucceeded(receipt.requestId, receipt.value);
  } catch (error) {
    step.readFailed(isRemoteReadError(error) ? error.requestId : null);
    throw transactionError(
      "PARTIAL_REMOTE_STATE",
      "A GitLab write may have completed but its readback could not be proven",
      `${operation} readback is unavailable or inconsistent`,
      error,
    );
  }
  try {
    postcondition?.(receipt.value);
    step.postcondition("matched");
  } catch (error) {
    step.postcondition("mismatched");
    throw transactionError(
      "PARTIAL_REMOTE_STATE",
      "A GitLab write completed but its postcondition did not match",
      `${operation} postcondition mismatch`,
      error,
    );
  }
  if (recovered) {
    context.journal.markRecoveredUnknown();
    onRecoveredUnknown?.();
  }
  completed.push(recovered ? `${operation}.recovered` : operation);
  return receipt.value;
}

export function managedFields(
  plan: MergeRequestWritePlan,
  targetBranch: string,
  draft: boolean,
): ManagedFieldsInput {
  const selected = draft ? plan.draft : plan.desired;
  return {
    title: selected.title,
    targetBranch,
    assigneeUserId: selected.assigneeUserId,
    reviewerUserIds: selected.reviewerUserIds,
    squash: selected.squash,
    removeSourceBranch: selected.removeSourceBranch,
  };
}

export function assertManagedFields(
  current: RemoteMergeRequest,
  plan: MergeRequestWritePlan,
  request: Request,
  draft: boolean,
): void {
  const expected = draft ? plan.draft : plan.desired;
  if (current.title !== expected.title || current.targetBranch !== request.targetBranch ||
      current.assigneeUserId !== expected.assigneeUserId ||
      !sameIds(current.reviewerUserIds, expected.reviewerUserIds) ||
      current.squash !== expected.squash ||
      current.removeSourceBranch !== expected.removeSourceBranch ||
      !sameIds(current.labelIds, expected.labelIds) ||
      current.draft !== draft) {
    throw transactionError(
      "POSTCONDITION_ERROR",
      "GitLab managed fields do not match the verified write plan",
      "managed-field readback mismatch",
    );
  }
}

export async function compensateReadyFailure(
  context: ManagedTransactionContext,
  plan: MergeRequestWritePlan,
  iid: number,
  completed: string[],
): Promise<RemoteMergeRequest> {
  let current = await readVerified(context, iid);
  if (!current.draft) {
    current = await writeAndRead(
      context,
      current,
      "mark-draft",
      "compensation",
      completed,
      () => context.remote.markDraft(iid, plan.draft.title),
      undefined,
      (value) => {
        if (!value.draft || value.title !== plan.draft.title) {
          throw transactionError("POSTCONDITION_ERROR", "Draft compensation did not mark Draft", value.webUrl);
        }
      },
    );
  }
  current = await syncLabels(
    context,
    current,
    plan.draft.labelIds,
    plan.managedLabelIds,
    completed,
    undefined,
    "compensation",
  );
  current = await writeAndRead(
    context,
    current,
    "compensation-fields",
    "compensation",
    completed,
    () => context.remote.writeManagedFields(iid, managedFields(plan, context.request.targetBranch, true)),
    undefined,
    (value) => assertManagedFields(value, plan, context.request, true),
  );
  const draftRequest = { ...context.request, intent: "draft" as const };
  const draftDescription = renderDescription({
    request: draftRequest,
    snapshot: current.snapshot,
    writePlan: plan.draft,
    bundle: context.bundle,
    releaseTag: context.releaseTag,
    cliVersion: context.cliVersion,
    renderPhase: "final",
  });
  await stageVerificationReceipt(context.verificationReceiptWriter, {
    gitlabOrigin: context.gitlabOrigin,
    current,
    expected: {
      request: draftRequest,
      snapshot: current.snapshot,
      writePlan: plan.draft,
      releaseTag: context.releaseTag,
      cliVersion: context.cliVersion,
      description: draftDescription,
      sourceBranch: context.sourceBranch,
    },
    bundle: context.bundle,
  });
  current = await writeAndRead(
    context,
    current,
    "compensation-description",
    "compensation",
    completed,
    () => context.remote.writeDescription(iid, draftDescription),
    undefined,
    (value) => {
      if (value.description !== draftDescription) {
        throw transactionError("POSTCONDITION_ERROR", "Draft compensation description readback failed", value.webUrl);
      }
    },
  );
  assertManagedFields(current, plan, context.request, true);
  if (current.description !== draftDescription) {
    throw transactionError("PARTIAL_REMOTE_STATE", "Draft compensation description readback failed", current.webUrl);
  }
  context.journal.setFinalState("compensated-draft");
  return current;
}
