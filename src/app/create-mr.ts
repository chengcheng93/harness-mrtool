import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { isToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import type { Candidate } from "../context/types.ts";
import { renderDescription } from "../render/markdown.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import {
  assertManagedFields,
  assertRemoteIdentity,
  compensateReadyFailure,
  managedFields,
  readVerified,
  readVerifiedReceipt,
  syncLabels,
  transactionError,
  writeAndRead,
  type ManagedTransactionContext,
} from "./compensate.ts";
import { buildWritePlan, type MergeRequestWritePlan } from "./write-plan.ts";
import {
  assertReadyGate,
  assertTransactionStructure,
  type MergeRequestVerificationExpectation,
} from "./verify-mr.ts";
import { UnknownRemoteOutcomeError } from "./remote-outcome.ts";
import {
  isRemoteMutationError,
  isRemoteReadError,
  remoteFailureToolError,
} from "./remote-outcome.ts";
import type { RemoteMutationReceipt, RemoteValueReceipt } from "./remote-receipt.ts";
import {
  attachTransactionAudit,
  candidateSelectionDigest,
  getTransactionAudit,
  TransactionJournal,
  type TransactionAuditV1,
} from "./transaction-journal.ts";
export { UnknownRemoteOutcomeError } from "./remote-outcome.ts";

export interface RemoteMergeRequest {
  readonly iid: number;
  readonly webUrl: string;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
  readonly state: "opened" | "closed" | "merged" | "locked";
  readonly sourceProjectId: string;
  readonly sourceBranch: string;
  readonly targetProjectId: string;
  readonly targetBranch: string;
  readonly sourceHeadSha: string;
  readonly labelIds: readonly string[];
  readonly assigneeUserId: string | null;
  readonly reviewerUserIds: readonly string[];
  readonly squash: boolean;
  readonly removeSourceBranch: boolean;
  readonly snapshot: ExternalContextSnapshot;
}

export interface CreateDraftInput {
  readonly title: string;
  readonly description: string;
  readonly sourceProjectId: string;
  readonly sourceBranch: string;
  readonly targetProjectId: string;
  readonly targetBranch: string;
  readonly sourceHeadSha: string;
  readonly squash: boolean;
  readonly removeSourceBranch: boolean;
}

export interface ManagedFieldsInput {
  readonly title: string;
  readonly targetBranch: string;
  readonly assigneeUserId: string | null;
  readonly reviewerUserIds: readonly string[];
  readonly squash: boolean;
  readonly removeSourceBranch: boolean;
}

export interface MergeRequestRemote {
  createDraft(input: CreateDraftInput): Promise<RemoteValueReceipt<RemoteMergeRequest>>;
  findOpen(input: CreateDraftInput): Promise<RemoteValueReceipt<readonly RemoteMergeRequest[]>>;
  addLabels(iid: number, labelIds: readonly string[]): Promise<RemoteMutationReceipt>;
  removeLabels(iid: number, labelIds: readonly string[]): Promise<RemoteMutationReceipt>;
  writeManagedFields(iid: number, input: ManagedFieldsInput): Promise<RemoteMutationReceipt>;
  writeDescription(iid: number, description: string): Promise<RemoteMutationReceipt>;
  markReady(iid: number, title: string): Promise<RemoteMutationReceipt>;
  markDraft(iid: number, title: string): Promise<RemoteMutationReceipt>;
  read(iid: number): Promise<RemoteValueReceipt<RemoteMergeRequest>>;
}

export interface CreateMergeRequestInputs {
  readonly request: Request;
  readonly initialSnapshot: ExternalContextSnapshot;
  readonly resolvedCandidates: readonly Candidate[];
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly remote: MergeRequestRemote;
}

export interface CreateMergeRequestResult {
  readonly iid: number;
  readonly webUrl: string;
  readonly writePlan: MergeRequestWritePlan;
  readonly completedWrites: readonly string[];
  readonly recoveredUnknownOutcome: boolean;
  readonly final: RemoteMergeRequest;
  readonly verification: MergeRequestVerificationExpectation;
  readonly transaction: TransactionAuditV1;
}

export async function createMergeRequest(
  inputs: CreateMergeRequestInputs,
): Promise<CreateMergeRequestResult> {
  const initialSnapshot = validateExternalContextSnapshot(inputs.initialSnapshot);
  if (initialSnapshot.mergeRequest.lifecycle !== "new" ||
      typeof inputs.sourceBranch !== "string" || inputs.sourceBranch === "" ||
      inputs.sourceBranch !== inputs.sourceBranch.trim() || /[\r\n\u0000]/u.test(inputs.sourceBranch)) {
    throw transactionError("POSTCONDITION_ERROR", "Create requires a new-MR context", "existing MR snapshot");
  }
  const plan = buildWritePlan({
    request: inputs.request,
    snapshot: initialSnapshot,
    resolvedCandidates: inputs.resolvedCandidates,
    bundle: inputs.bundle,
  });
  const journal = new TransactionJournal(
    "create",
    initialSnapshot.sourceHeadSha,
    candidateSelectionDigest(inputs.request, inputs.resolvedCandidates, inputs.initialSnapshot),
  );
  const context: ManagedTransactionContext = { ...inputs, writePlan: plan, journal };
  const completed: string[] = [];
  const provisionalDescription = renderDescription({
    request: inputs.request,
    snapshot: initialSnapshot,
    writePlan: plan.desired,
    bundle: inputs.bundle,
    releaseTag: inputs.releaseTag,
    cliVersion: inputs.cliVersion,
    renderPhase: "provisional",
  });
  const createInput: CreateDraftInput = {
    title: plan.provisional.title,
    description: provisionalDescription,
    sourceProjectId: initialSnapshot.sourceProject.id,
    sourceBranch: inputs.sourceBranch,
    targetProjectId: initialSnapshot.targetProject.id,
    targetBranch: inputs.request.targetBranch,
    sourceHeadSha: initialSnapshot.sourceHeadSha,
    squash: plan.desired.squash,
    removeSourceBranch: plan.desired.removeSourceBranch,
  };
  let current: RemoteMergeRequest | null = null;
  let recoveredUnknownOutcome = false;
  const createStep = journal.start("normal", "create-draft", null);
  let createMutationRecorded = false;
  try {
    const created = await inputs.remote.createDraft(createInput);
    createStep.mutation("confirmed", created.requestId);
    createMutationRecorded = true;
    let readback: RemoteValueReceipt<RemoteMergeRequest>;
    try {
      readback = await readVerifiedReceipt(context, created.value.iid);
      createStep.readSucceeded(readback.requestId, readback.value);
    } catch (error) {
      createStep.readFailed(isRemoteReadError(error) ? error.requestId : null);
      const failure = transactionError(
        "PARTIAL_REMOTE_STATE",
        "The Draft was created but its independent readback failed",
        "create-draft readback is unavailable",
        error,
      );
      journal.setFinalState("unknown");
      attachTransactionAudit(failure, journal.snapshot());
      throw failure;
    }
    current = readback.value;
    assertExactProvisionalDraft(current, createInput);
    createStep.postcondition("matched");
    completed.push("create-draft");
  } catch (error) {
    if (createMutationRecorded) {
      const failure = error;
      if (getTransactionAudit(failure) === null) {
        journal.setFinalState("unknown");
        attachTransactionAudit(failure, journal.snapshot());
      }
      throw failure;
    }
    if (isRemoteMutationError(error, "rejected")) {
      createStep.mutation("rejected", error.requestId);
      const failure = remoteFailureToolError(error);
      journal.setFinalState("not-started");
      attachTransactionAudit(failure, journal.snapshot());
      throw failure;
    }
    createStep.mutation("unknown", isRemoteMutationError(error, "unknown") ? error.requestId : null);
    createMutationRecorded = true;
    let matches: readonly RemoteMergeRequest[];
    const recoveryStep = journal.start("recovery", "create-outcome-query", null);
    try {
      const found = await inputs.remote.findOpen(createInput);
      matches = found.value;
      recoveryStep.readResultSucceeded(found.requestId, matches);
    } catch (readError) {
      recoveryStep.readFailed();
      recoveryStep.postcondition("unavailable");
      const failure = transactionError(
        "PARTIAL_REMOTE_STATE",
        "Draft creation outcome is unknown and could not be queried",
        "create outcome unavailable",
        readError,
      );
      journal.setFinalState("unknown");
      attachTransactionAudit(failure, journal.snapshot());
      throw failure;
    }
    const match = matches[0];
    try {
      if (matches.length !== 1 || match === undefined) {
        throw new Error("The create query did not return exactly one Draft");
      }
      assertRemoteIdentity(match, context);
      assertExactProvisionalDraft(match, createInput);
      recoveryStep.postcondition("matched");
    } catch (recoveryError) {
      recoveryStep.postcondition("mismatched");
      const failure = transactionError(
        "PARTIAL_REMOTE_STATE",
        "Draft creation outcome is unknown and no exact unique MR could be proven",
        "create query did not return one byte-equivalent provisional Draft",
        recoveryError,
      );
      journal.setFinalState("unknown");
      attachTransactionAudit(failure, journal.snapshot());
      throw failure;
    }
    current = match;
    recoveredUnknownOutcome = true;
    journal.markRecoveredUnknown();
    completed.push("create-draft.recovered");
  }

  if (current === null) {
    const failure = transactionError(
      "PARTIAL_REMOTE_STATE",
      "The Draft creation state could not be established",
      "create-draft produced no readable MR",
    );
    journal.setFinalState("unknown");
    attachTransactionAudit(failure, journal.snapshot());
    throw failure;
  }

  let readyTransitionStarted = false;
  try {
    assertRemoteIdentity(current, context);
    current = await syncLabels(
      context,
      current,
      plan.draft.labelIds,
      plan.managedLabelIds,
      completed,
      () => { recoveredUnknownOutcome = true; },
    );
    current = await writeAndRead(
      context,
      current,
      "fields-write",
      "normal",
      completed,
      () => inputs.remote.writeManagedFields(
        current!.iid,
        managedFields(plan, inputs.request.targetBranch, true),
      ),
      () => { recoveredUnknownOutcome = true; },
      (value) => assertManagedFields(value, plan, inputs.request, true),
    );

    const finalRenderSnapshot = current.snapshot;
    const finalDescription = renderDescription({
      request: inputs.request,
      snapshot: finalRenderSnapshot,
      writePlan: plan.desired,
      bundle: inputs.bundle,
      releaseTag: inputs.releaseTag,
      cliVersion: inputs.cliVersion,
      renderPhase: "final",
      ...(plan.intent === "ready" ? { snapshotExpectation: "ready-transition-pending" as const } : {}),
    });
    current = await writeAndRead(
      context,
      current,
      "description-write",
      "normal",
      completed,
      () => inputs.remote.writeDescription(current!.iid, finalDescription),
      () => { recoveredUnknownOutcome = true; },
      (value) => {
        assertManagedFields(value, plan, inputs.request, true);
        assertTransactionStructure(value, finalDescription, inputs.bundle, inputs.releaseTag);
      },
    );

    if (plan.intent === "draft") {
      journal.setFinalState("draft-proven");
      return transactionResult(
        current,
        plan,
        completed,
        recoveredUnknownOutcome,
        finalRenderSnapshot,
        finalDescription,
        inputs,
        journal.snapshot(),
      );
    }

    readyTransitionStarted = true;
    assertReadyGate(current.snapshot, inputs.request, plan.desired, inputs.bundle);
    current = await syncLabels(
      context,
      current,
      plan.desired.labelIds,
      plan.managedLabelIds,
      completed,
      () => { recoveredUnknownOutcome = true; },
      "normal",
      true,
    );
    assertReadyGate(current.snapshot, inputs.request, plan.desired, inputs.bundle);
    current = await writeAndRead(
      context,
      current,
      "mark-ready",
      "normal",
      completed,
      () => inputs.remote.markReady(current!.iid, plan.desired.title),
      () => { recoveredUnknownOutcome = true; },
      (value) => {
        assertManagedFields(value, plan, inputs.request, false);
        assertTransactionStructure(value, finalDescription, inputs.bundle, inputs.releaseTag);
        assertReadyGate(value.snapshot, inputs.request, plan.desired, inputs.bundle);
      },
    );
    journal.setFinalState("ready-proven");
    return transactionResult(
      current,
      plan,
      completed,
      recoveredUnknownOutcome,
      finalRenderSnapshot,
      finalDescription,
      inputs,
      journal.snapshot(),
    );
  } catch (error) {
    let failure: unknown = error;
    if (readyTransitionStarted) {
      try {
        current = await compensateReadyFailure(context, plan, current.iid, completed);
        failure = transactionError(
          isToolError(error, "PARTIAL_REMOTE_STATE") ? "PARTIAL_REMOTE_STATE" : "PARTIAL_DRAFT",
          "The Ready transaction failed and the MR was compensated to Draft",
          current.webUrl,
          error,
        );
      } catch (compensationError) {
        journal.setFinalState("unknown");
        failure = transactionError(
          "PARTIAL_REMOTE_STATE",
          "The MR transaction failed and Draft compensation could not be proven",
          current.webUrl,
          compensationError,
        );
      }
    } else if (!isToolError(error, "PARTIAL_REMOTE_STATE")) {
      try {
        current = await readVerified(context, current.iid);
        if (!current.draft || current.state !== "opened") throw new Error("MR is not an open Draft");
        journal.setFinalState("draft-proven");
        failure = transactionError(
          "PARTIAL_DRAFT",
          "The Draft MR was created but the transaction did not complete",
          current.webUrl,
          error,
        );
      } catch (readError) {
        journal.setFinalState("unknown");
        failure = transactionError(
          "PARTIAL_REMOTE_STATE",
          "The Draft was created but its current remote state could not be proven",
          current.webUrl,
          readError,
        );
      }
    } else {
      journal.setFinalState("unknown");
    }
    attachTransactionAudit(failure, journal.snapshot());
    throw failure;
  }
}

function assertExactProvisionalDraft(current: RemoteMergeRequest, input: CreateDraftInput): void {
  if (current.title !== input.title || current.description !== input.description ||
      !current.draft || current.state !== "opened" ||
      current.sourceProjectId !== input.sourceProjectId || current.sourceBranch !== input.sourceBranch ||
      current.targetProjectId !== input.targetProjectId || current.targetBranch !== input.targetBranch ||
      current.sourceHeadSha !== input.sourceHeadSha || current.labelIds.length !== 0 ||
      current.assigneeUserId !== null || current.reviewerUserIds.length !== 0 ||
      current.squash !== input.squash || current.removeSourceBranch !== input.removeSourceBranch) {
    throw transactionError(
      "PARTIAL_REMOTE_STATE",
      "The provisional Draft did not match the create request",
      "create-draft postcondition mismatch",
    );
  }
}

function transactionResult(
  current: RemoteMergeRequest,
  plan: MergeRequestWritePlan,
  completed: string[],
  recoveredUnknownOutcome: boolean,
  renderSnapshot: ExternalContextSnapshot,
  description: string,
  inputs: CreateMergeRequestInputs,
  transaction: TransactionAuditV1,
): CreateMergeRequestResult {
  return Object.freeze({
    iid: current.iid,
    webUrl: current.webUrl,
    writePlan: plan,
    completedWrites: Object.freeze([...completed]),
    recoveredUnknownOutcome,
    final: current,
    verification: Object.freeze({
      request: inputs.request,
      snapshot: renderSnapshot,
      writePlan: plan.desired,
      releaseTag: inputs.releaseTag,
      cliVersion: inputs.cliVersion,
      description,
      sourceBranch: inputs.sourceBranch,
    }),
    transaction,
  });
}
