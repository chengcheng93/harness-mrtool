import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import type { Candidate } from "../context/types.ts";
import { renderDescription } from "../render/markdown.ts";
import type { ExternalContextSnapshot } from "../render/marker.ts";
import {
  type CreateMergeRequestResult,
  type MergeRequestRemote,
  type RemoteMergeRequest,
} from "./create-mr.ts";
import {
  assertManagedFields,
  assertRemoteIdentity,
  compensateReadyFailure,
  managedFields,
  readVerified,
  syncLabels,
  transactionError,
  writeAndRead,
  type ManagedTransactionContext,
} from "./compensate.ts";
import { assertManagedDescription } from "./description-ownership.ts";
import { isRemoteReadError, remoteFailureToolError } from "./remote-outcome.ts";
import {
  attachTransactionAudit,
  attachTransactionFailure,
  candidateSelectionDigest,
  remoteSnapshotDigest,
  TransactionJournal,
  type TransactionAuditV1,
} from "./transaction-journal.ts";
import {
  assertReadyGate,
  assertTransactionStructure,
  isVerificationReceiptStageError,
  stageVerificationReceipt,
  type VerificationReceiptWriter,
} from "./verify-mr.ts";
import { buildWritePlan, type MergeRequestWritePlan } from "./write-plan.ts";

function concurrentUpdateError(): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError("CONCURRENT_UPDATE", "The merge request changed after context discovery", {
    field: "mergeRequest",
    expected: "the exact pre-write MR snapshot used to build the update plan",
    actual: "remote state drifted before the first write",
    safeNextStep: "Refresh context, preserve any human changes, and preview the update again.",
  });
}

export interface UpdateMergeRequestInputs {
  readonly request: Request;
  readonly initial: RemoteMergeRequest;
  readonly resolvedCandidates: readonly Candidate[];
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly remote: MergeRequestRemote;
  readonly gitlabOrigin: string;
  readonly verificationReceiptWriter: VerificationReceiptWriter;
  readonly forceReplaceDescription?: boolean;
}

export interface UpdateMergeRequestResult extends CreateMergeRequestResult {
  readonly forcedDescriptionReplacement: boolean;
}

function updateResult(
  current: RemoteMergeRequest,
  plan: MergeRequestWritePlan,
  completed: string[],
  recoveredUnknownOutcome: boolean,
  renderSnapshot: ExternalContextSnapshot,
  description: string,
  inputs: UpdateMergeRequestInputs,
  forcedDescriptionReplacement: boolean,
  transaction: TransactionAuditV1,
): UpdateMergeRequestResult {
  return Object.freeze({
    iid: current.iid,
    webUrl: current.webUrl,
    writePlan: plan,
    completedWrites: Object.freeze([...completed]),
    recoveredUnknownOutcome,
    final: current,
    forcedDescriptionReplacement,
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

function hasPossibleWrite(journal: TransactionJournal): boolean {
  return journal.snapshot().steps.some((step) =>
    step.mutation?.outcome === "confirmed" || step.mutation?.outcome === "unknown");
}

export async function updateMergeRequest(
  inputs: UpdateMergeRequestInputs,
): Promise<UpdateMergeRequestResult> {
  const forcedDescriptionReplacement = assertManagedDescription(
    inputs.initial.description,
    inputs.bundle,
    inputs.releaseTag,
    inputs.forceReplaceDescription === true,
  ).manuallyChanged;
  if (inputs.initial.snapshot.mergeRequest.lifecycle === "new" ||
      inputs.initial.snapshot.mergeRequest.iid !== inputs.initial.iid) {
    throw transactionError("POSTCONDITION_ERROR", "Update requires an existing managed MR", "new MR snapshot");
  }
  const plan = buildWritePlan({
    request: inputs.request,
    snapshot: inputs.initial.snapshot,
    resolvedCandidates: inputs.resolvedCandidates,
    bundle: inputs.bundle,
  });
  const journal = new TransactionJournal(
    "update",
    inputs.initial.snapshot.sourceHeadSha,
    candidateSelectionDigest(inputs.request, inputs.resolvedCandidates, inputs.initial.snapshot),
  );
  const context: ManagedTransactionContext = {
    request: inputs.request,
    initialSnapshot: inputs.initial.snapshot,
    bundle: inputs.bundle,
    releaseTag: inputs.releaseTag,
    cliVersion: inputs.cliVersion,
    sourceBranch: inputs.sourceBranch,
    remote: inputs.remote,
    writePlan: plan,
    journal,
    gitlabOrigin: inputs.gitlabOrigin,
    verificationReceiptWriter: inputs.verificationReceiptWriter,
  };
  assertRemoteIdentity(inputs.initial, context);

  let current: RemoteMergeRequest;
  try {
    const liveReceipt = await inputs.remote.read(inputs.initial.iid);
    current = liveReceipt.value;
    if (remoteSnapshotDigest(current) !== remoteSnapshotDigest(inputs.initial)) {
      throw concurrentUpdateError();
    }
    assertRemoteIdentity(current, context);
    assertManagedDescription(
      current.description,
      inputs.bundle,
      inputs.releaseTag,
      inputs.forceReplaceDescription === true,
    );
  } catch (error) {
    journal.setFinalState("not-started");
    const failure = isRemoteReadError(error) ? remoteFailureToolError(error) : error;
    attachTransactionAudit(failure, journal.snapshot());
    throw failure;
  }

  const completed: string[] = [];
  let readyTransitionStarted = false;
  let recoveredUnknownOutcome = false;
  let renderSnapshot: ExternalContextSnapshot | null = null;
  let finalDescription: string | null = null;

  try {
    if (!current.draft) {
      current = await writeAndRead(
        context,
        current,
        "mark-draft",
        "normal",
        completed,
        () => inputs.remote.markDraft(current.iid, plan.draft.title),
        () => { recoveredUnknownOutcome = true; },
        (value) => {
          if (!value.draft || value.title !== plan.draft.title) {
            throw transactionError(
              "POSTCONDITION_ERROR",
              "The update could not prove that the MR returned to Draft",
              value.webUrl,
            );
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
      () => { recoveredUnknownOutcome = true; },
    );
    current = await writeAndRead(
      context,
      current,
      "fields-write",
      "normal",
      completed,
      () => inputs.remote.writeManagedFields(
        current.iid,
        managedFields(plan, inputs.request.targetBranch, true),
      ),
      () => { recoveredUnknownOutcome = true; },
      (value) => assertManagedFields(value, plan, inputs.request, true),
    );

    renderSnapshot = current.snapshot;
    finalDescription = renderDescription({
      request: inputs.request,
      snapshot: renderSnapshot,
      writePlan: plan.desired,
      bundle: inputs.bundle,
      releaseTag: inputs.releaseTag,
      cliVersion: inputs.cliVersion,
      renderPhase: "final",
      ...(plan.intent === "ready" ? { snapshotExpectation: "ready-transition-pending" as const } : {}),
    });
    await stageVerificationReceipt(inputs.verificationReceiptWriter, {
      gitlabOrigin: inputs.gitlabOrigin,
      current,
      expected: {
        request: inputs.request,
        snapshot: renderSnapshot,
        writePlan: plan.desired,
        releaseTag: inputs.releaseTag,
        cliVersion: inputs.cliVersion,
        description: finalDescription,
        sourceBranch: inputs.sourceBranch,
      },
      bundle: inputs.bundle,
    });
    current = await writeAndRead(
      context,
      current,
      "description-write",
      "normal",
      completed,
      () => inputs.remote.writeDescription(current.iid, finalDescription!),
      () => { recoveredUnknownOutcome = true; },
      (value) => {
        assertManagedFields(value, plan, inputs.request, true);
        assertTransactionStructure(value, finalDescription!, inputs.bundle, inputs.releaseTag);
      },
    );

    if (plan.intent === "draft") {
      journal.setFinalState("draft-proven");
      return updateResult(
        current,
        plan,
        completed,
        recoveredUnknownOutcome,
        renderSnapshot,
        finalDescription,
        inputs,
        forcedDescriptionReplacement,
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
      () => inputs.remote.markReady(current.iid, plan.desired.title),
      () => { recoveredUnknownOutcome = true; },
      (value) => {
        assertManagedFields(value, plan, inputs.request, false);
        assertTransactionStructure(value, finalDescription!, inputs.bundle, inputs.releaseTag);
        assertReadyGate(value.snapshot, inputs.request, plan.desired, inputs.bundle);
      },
    );
    journal.setFinalState("ready-proven");
    return updateResult(
      current,
      plan,
      completed,
      recoveredUnknownOutcome,
      renderSnapshot,
      finalDescription,
      inputs,
      forcedDescriptionReplacement,
      journal.snapshot(),
    );
  } catch (error) {
    let failure: unknown = error;
    if (readyTransitionStarted && hasPossibleWrite(journal)) {
      try {
        current = await compensateReadyFailure(context, plan, current.iid, completed);
        failure = transactionError(
          isToolError(error, "PARTIAL_REMOTE_STATE") ? "PARTIAL_REMOTE_STATE" : "PARTIAL_DRAFT",
          "The Ready update failed and the MR was compensated to Draft",
          current.webUrl,
          error,
        );
      } catch (compensationError) {
        journal.setFinalState("unknown");
        failure = transactionError(
          "PARTIAL_REMOTE_STATE",
          "The update failed and its Draft compensation could not be proven",
          current.webUrl,
          compensationError,
        );
      }
    } else if (isToolError(error, "PARTIAL_REMOTE_STATE")) {
      journal.setFinalState("unknown");
    } else if (hasPossibleWrite(journal)) {
      try {
        current = await readVerified(context, current.iid);
        if (!current.draft || current.state !== "opened") throw new Error("MR is not an open Draft");
        journal.setFinalState("draft-proven");
        failure = transactionError(
          "PARTIAL_DRAFT",
          "The merge request update did not complete and remains a verified Draft",
          current.webUrl,
          error,
        );
      } catch (readError) {
        journal.setFinalState("unknown");
        failure = transactionError(
          "PARTIAL_REMOTE_STATE",
          "The update failed and its Draft state could not be proven",
          current.webUrl,
          readError,
        );
      }
    } else {
      journal.setFinalState("not-started");
    }
    const audit = journal.snapshot();
    attachTransactionAudit(failure, audit);
    if (hasPossibleWrite(journal)) {
      attachTransactionFailure(failure, {
        audit,
        iid: current.iid,
        webUrl: current.webUrl,
        completedSteps: completed,
        retry: "update",
        ...(isVerificationReceiptStageError(error)
          ? {
              failedOperation: "verification-receipt-stage" as const,
              failedField: "verificationReceipt",
            }
          : readyTransitionStarted && audit.steps.every((step) =>
              step.postcondition === "matched" || step.postcondition === "not-applicable")
          ? { failedOperation: "ready-gate" as const }
          : {}),
      });
    }
    throw failure;
  }
}
