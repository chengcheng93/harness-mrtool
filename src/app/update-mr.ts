import { selectMandatoryLabels, type LabelSelectionOptions } from "./mandatory-labels.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { canonicalizeJson, sha256Utf8 } from "../contracts/jcs.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import type { CanonicalLabelChangeSet } from "../git/change-set.ts";
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
  type TransactionAudit,
} from "./transaction-journal.ts";
import {
  assertTransactionStructure,
  isVerificationReceiptStageError,
  stageVerificationReceipt,
  type VerificationReceiptWriter,
} from "./verify-mr.ts";
import { buildWritePlan, type MergeRequestWritePlan } from "./write-plan.ts";
import { assertPristineResumeAuthorization, type PristineCreateResumeAuthorization } from "./resume-create.ts";

function concurrentUpdateError(): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError("CONCURRENT_UPDATE", "The merge request changed after context discovery", {
    field: "mergeRequest",
    expected: "the exact pre-write MR snapshot used to build the update plan",
    actual: "remote state drifted before the first write",
    safeNextStep: "Refresh context, preserve any human changes, and preview the update again.",
  });
}

/** Prior Bundle/tag must come from authenticated historical lookup, not MR metadata alone. */
export interface UpdateMergeRequestMigration {
  readonly previousBundle: LoadedTemplateBundle;
  readonly previousReleaseTag: string;
  readonly confirmation: string;
  readonly oldHash: string;
  readonly newHash: string;
}

/** Shared by the immutable adapter boundary and the direct transaction entry point. */
export function validateUpdateMigration(
  migration: UpdateMergeRequestMigration,
  bundle: LoadedTemplateBundle,
  releaseTag: string,
): void {
  validateTemplateBundle(migration.previousBundle);
  validateTemplateBundle(bundle);
  const oldHash = sha256Utf8(`${canonicalizeJson(migration.previousBundle.manifest)}\n`);
  const newHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  if (migration.oldHash !== oldHash || migration.newHash !== newHash ||
      migration.confirmation !== `${oldHash}:${newHash}`) {
    throw new ToolError("INPUT_ERROR", "Migration confirmation does not match the exact old and new Bundles", {
      field: "migration.confirmation", expected: `${oldHash}:${newHash}`, actual: "stale or mismatched migration confirmation",
      safeNextStep: "Refresh migration context and explicitly confirm the exact old:new Bundle hashes.",
    });
  }
  if (migration.previousReleaseTag !== `templates-v${migration.previousBundle.manifest.version}` ||
      releaseTag !== `templates-v${bundle.manifest.version}`) {
    throw new ToolError("TEMPLATE_ERROR", "Migration release tags do not match the verified Bundles", {
      field: "migration", expected: "canonical release tags for the verified old and new Bundle versions",
      actual: "release tag mismatch", safeNextStep: "Reload the exact authenticated historical and destination Bundles.",
    });
  }
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
  readonly migration?: UpdateMergeRequestMigration;
  readonly resumeAuthorization?: PristineCreateResumeAuthorization;
  readonly labelDiff: CanonicalLabelChangeSet;
  readonly labelOptions?: LabelSelectionOptions;
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
  transaction: TransactionAudit,
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
  if (inputs.migration !== undefined) validateUpdateMigration(inputs.migration, inputs.bundle, inputs.releaseTag);
  const ownershipBundle = inputs.migration?.previousBundle ?? inputs.bundle;
  const ownershipReleaseTag = inputs.migration?.previousReleaseTag ?? inputs.releaseTag;
  const labels = selectMandatoryLabels({
    diff: inputs.labelDiff, binding: inputs.initial.snapshot, inventory: inputs.initial.snapshot.labelCandidates,
    ...(inputs.labelOptions === undefined ? {} : { options: inputs.labelOptions }),
  });
  inputs = { ...inputs, request: normalizeAndValidateRequest({
    ...inputs.request, title: { ...inputs.request.title, type: labels.titleType },
  }) };
  let forcedDescriptionReplacement = false;
  if (inputs.resumeAuthorization !== undefined) {
    if (inputs.migration !== undefined || inputs.forceReplaceDescription === true) {
      throw new ToolError("INPUT_ERROR", "Resume requires a verified provisional transaction prefix", {
        field: "--resume", expected: "resume without migration or description replacement overrides",
        actual: "conflicting update overrides",
        safeNextStep: "Refresh context and resume the original provisional merge request without overrides.",
      });
    }
    assertPristineResumeAuthorization(inputs.resumeAuthorization, inputs.initial, inputs);
  } else {
    forcedDescriptionReplacement = assertManagedDescription(
      inputs.initial.description,
      ownershipBundle,
      ownershipReleaseTag,
      inputs.forceReplaceDescription === true,
    ).manuallyChanged;
  }
  if (inputs.initial.snapshot.mergeRequest.lifecycle === "new" ||
      inputs.initial.snapshot.mergeRequest.iid !== inputs.initial.iid) {
    throw transactionError("POSTCONDITION_ERROR", "Update requires an existing managed MR", "new MR snapshot");
  }
  const plan = buildWritePlan({
    request: inputs.request,
    snapshot: inputs.initial.snapshot,
    resolvedCandidates: inputs.resolvedCandidates,
    bundle: inputs.bundle,
    labelDiff: inputs.labelDiff,
    ...(inputs.labelOptions === undefined ? {} : { labelOptions: inputs.labelOptions }),
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
    if (inputs.resumeAuthorization !== undefined) {
      assertPristineResumeAuthorization(inputs.resumeAuthorization, current, inputs);
    } else {
      assertManagedDescription(
        current.description,
        ownershipBundle,
        ownershipReleaseTag,
        inputs.forceReplaceDescription === true,
      );
    }
  } catch (error) {
    journal.setFinalState("not-started");
    const failure = isRemoteReadError(error) ? remoteFailureToolError(error) : error;
    attachTransactionAudit(failure, journal.snapshot());
    throw failure;
  }

  const completed: string[] = [];
  let recoveredUnknownOutcome = false;
  let renderSnapshot: ExternalContextSnapshot | null = null;
  let finalDescription: string | null = null;

  try {
    current = await syncLabels(
      context,
      current,
      plan.desired.labelIds,
      plan.managedLabelIds,
      completed,
      () => { recoveredUnknownOutcome = true; },
    );
    // A legacy Draft merge request is normalized here: writing the canonical
    // title (without a Draft prefix) is what makes GitLab mark it ready.
    const resumeFieldsAlreadyWritten = inputs.resumeAuthorization !== undefined && !current.draft &&
      current.title === plan.desired.title && current.targetBranch === inputs.request.targetBranch &&
      current.assigneeUserId === plan.desired.assigneeUserId &&
      canonicalizeJson([...current.reviewerUserIds].sort()) === canonicalizeJson([...plan.desired.reviewerUserIds].sort()) &&
      current.squash === plan.desired.squash && current.removeSourceBranch === plan.desired.removeSourceBranch;
    if (resumeFieldsAlreadyWritten) {
      assertManagedFields(current, plan, inputs.request);
    } else {
      current = await writeAndRead(
        context,
        current,
        "fields-write",
        "normal",
        completed,
        () => inputs.remote.writeManagedFields(
          current.iid,
          managedFields(plan, inputs.request.targetBranch),
        ),
        () => { recoveredUnknownOutcome = true; },
        (value) => assertManagedFields(value, plan, inputs.request),
      );
    }

    renderSnapshot = current.snapshot;
    finalDescription = renderDescription({
      request: inputs.request,
      snapshot: renderSnapshot,
      writePlan: plan.desired,
      bundle: inputs.bundle,
      releaseTag: inputs.releaseTag,
      cliVersion: inputs.cliVersion,
      renderPhase: "final",
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
    // The final description write is the last remote write of the transaction.
    current = await writeAndRead(
      context,
      current,
      "description-write",
      "normal",
      completed,
      () => inputs.remote.writeDescription(current.iid, finalDescription!),
      () => { recoveredUnknownOutcome = true; },
      (value) => {
        assertManagedFields(value, plan, inputs.request);
        assertTransactionStructure(value, finalDescription!, inputs.bundle, inputs.releaseTag);
      },
    );
    journal.setFinalState("complete");
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
    const verificationReceiptStageFailed = isVerificationReceiptStageError(error);
    if (isToolError(error, "PARTIAL_REMOTE_STATE")) {
      journal.setFinalState("unknown");
    } else if (hasPossibleWrite(journal)) {
      try {
        current = await readVerified(context, current.iid);
        if (current.state !== "opened") throw new Error("MR is not open");
        journal.setFinalState("partial");
        failure = transactionError(
          "PARTIAL_WRITE",
          "The merge request update did not complete; its current state was read back",
          current.webUrl,
          error,
        );
      } catch (readError) {
        journal.setFinalState("unknown");
        failure = transactionError(
          "PARTIAL_REMOTE_STATE",
          "The update failed and the current remote state could not be proven",
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
        ...(verificationReceiptStageFailed
          ? {
              failedOperation: "verification-receipt-stage" as const,
              failedField: "verificationReceipt",
            }
          : {}),
      });
    }
    throw failure;
  }
}
