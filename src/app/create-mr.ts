import { selectMandatoryLabels, type LabelSelectionOptions } from "./mandatory-labels.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import type { CanonicalLabelChangeSet } from "../git/change-set.ts";
import { ToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import type { Candidate, ContextBinding, ResolvedContext } from "../context/types.ts";
import { renderDescription } from "../render/markdown.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import { transactionError } from "./compensate.ts";
import { buildWritePlan, type MergeRequestWritePlan } from "./write-plan.ts";
import { updateMergeRequest } from "./update-mr.ts";
import { validatePristineCreateResume } from "./resume-create.ts";
import type { MergeRequestVerificationExpectation, VerificationReceiptWriter } from "./verify-mr.ts";
import {
  isRemoteReadError,
  remoteFailureToolError,
} from "./remote-outcome.ts";
import type { RemoteMutationReceipt, RemoteValueReceipt } from "./remote-receipt.ts";
import {
  attachTransactionAudit,
  candidateSelectionDigest,
  TransactionJournal,
  type TransactionAudit,
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

export interface CreateMergeRequestInput {
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
  /** Retained for historical port compatibility; production adapters reject MR-only creation. */
  create(input: CreateMergeRequestInput): Promise<RemoteValueReceipt<{ readonly iid: number }>>;
  findOpen(input: CreateMergeRequestInput): Promise<RemoteValueReceipt<readonly RemoteMergeRequest[]>>;
  addLabels(iid: number, labelIds: readonly string[]): Promise<RemoteMutationReceipt>;
  removeLabels(iid: number, labelIds: readonly string[]): Promise<RemoteMutationReceipt>;
  writeManagedFields(iid: number, input: ManagedFieldsInput): Promise<RemoteMutationReceipt>;
  writeDescription(iid: number, description: string): Promise<RemoteMutationReceipt>;
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
  readonly gitlabOrigin: string;
  readonly verificationReceiptWriter: VerificationReceiptWriter;
  readonly upsert?: boolean;
  readonly resume?: {
    readonly iid: number;
    readonly originalRequest: Request;
    readonly originalContext: ResolvedContext;
    readonly binding: ContextBinding;
  };
  readonly labelDiff: CanonicalLabelChangeSet;
  readonly labelOptions?: LabelSelectionOptions;
}

export interface CreateMergeRequestResult {
  readonly iid: number;
  readonly webUrl: string;
  readonly writePlan: MergeRequestWritePlan;
  readonly completedWrites: readonly string[];
  readonly recoveredUnknownOutcome: boolean;
  readonly final: RemoteMergeRequest;
  readonly verification: MergeRequestVerificationExpectation;
  readonly transaction: TransactionAudit;
}

export async function createMergeRequest(
  inputs: CreateMergeRequestInputs,
): Promise<CreateMergeRequestResult> {
  const labels = selectMandatoryLabels({
    diff: inputs.labelDiff, binding: inputs.initialSnapshot, inventory: inputs.initialSnapshot.labelCandidates,
    ...(inputs.labelOptions === undefined ? {} : { options: inputs.labelOptions }),
  });
  inputs = { ...inputs, request: normalizeAndValidateRequest({
    ...inputs.request, title: { ...inputs.request.title, type: labels.titleType },
  }) };
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
    labelDiff: inputs.labelDiff,
    ...(inputs.labelOptions === undefined ? {} : { labelOptions: inputs.labelOptions }),
  });
  const journal = new TransactionJournal(
    "create",
    initialSnapshot.sourceHeadSha,
    candidateSelectionDigest(inputs.request, inputs.resolvedCandidates, inputs.initialSnapshot),
  );
  const provisionalDescription = renderDescription({
    request: inputs.request,
    snapshot: initialSnapshot,
    writePlan: plan.desired,
    bundle: inputs.bundle,
    releaseTag: inputs.releaseTag,
    cliVersion: inputs.cliVersion,
    renderPhase: "provisional",
  });
  const createInput: CreateMergeRequestInput = {
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
  try {
    const existing = await inputs.remote.findOpen(createInput);
    if (inputs.resume !== undefined && (existing.value.length !== 1 ||
        existing.value[0]?.iid !== inputs.resume.iid || inputs.upsert === true)) {
      throw new ToolError("INPUT_ERROR", "Resume requires the exact selected provisional merge request", {
        field: "--resume", expected: "one matching open merge request with the explicitly selected IID",
        actual: "the resume selection is absent, ambiguous, mismatched, or combined with --upsert",
        safeNextStep: "Preserve the original merge request and refresh its local context before retrying resume.",
      });
    }
    if (existing.value.length === 1 && (inputs.upsert === true || inputs.resume !== undefined)) {
      const resumeAuthorization = inputs.resume === undefined ? undefined : validatePristineCreateResume({
        ...inputs.resume,
        request: inputs.request,
        initialSnapshot,
        resolvedCandidates: inputs.resolvedCandidates,
        current: existing.value[0]!,
        bundle: inputs.bundle,
        releaseTag: inputs.releaseTag,
        labelDiff: inputs.labelDiff,
        ...(inputs.labelOptions === undefined ? {} : { labelOptions: inputs.labelOptions }),
      });
      return updateMergeRequest({
        labelDiff: inputs.labelDiff,
        ...(inputs.labelOptions === undefined ? {} : { labelOptions: inputs.labelOptions }),
        request: inputs.request,
        initial: existing.value[0]!,
        resolvedCandidates: inputs.resolvedCandidates,
        bundle: inputs.bundle,
        releaseTag: inputs.releaseTag,
        cliVersion: inputs.cliVersion,
        sourceBranch: inputs.sourceBranch,
        remote: inputs.remote,
        gitlabOrigin: inputs.gitlabOrigin,
        verificationReceiptWriter: inputs.verificationReceiptWriter,
        ...(resumeAuthorization === undefined ? {} : { resumeAuthorization }),
      });
    }
    if (existing.value.length > 0) {
      throw new ToolError("INPUT_ERROR", "An open merge request already exists for this source and target", {
        field: "mergeRequest.iid",
        expected: "no open merge request, or one explicitly selected for update",
        actual: existing.value.length,
        safeNextStep: existing.value.length === 1
          ? "Run update with the existing merge request IID."
          : "Specify the intended merge request IID and run update explicitly.",
      });
    }
  } catch (error) {
    const failure = isRemoteReadError(error) ? remoteFailureToolError(error) : error;
    journal.setFinalState("not-started");
    attachTransactionAudit(failure, journal.snapshot());
    throw failure;
  }
  const failure = new ToolError("INPUT_ERROR", "New merge requests require Issue-first submission", {
    field: "workItem", expected: "a successfully created Issue before a new merge request",
    actual: "legacy MR-only creation is disabled",
    safeNextStep: "Use create with workItem omitted or relation:new; use update for an existing merge request.",
  });
  journal.setFinalState("not-started");
  attachTransactionAudit(failure, journal.snapshot());
  throw failure;
}
