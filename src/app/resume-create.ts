import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, copyJsonValue, sha256CanonicalJson, sha256Utf8 } from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";
import type { Candidate, ContextBinding, ResolvedContext } from "../context/types.ts";
import type { CanonicalLabelChangeSet } from "../git/change-set.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import { renderDescription } from "../render/markdown.ts";
import { validateExternalContextSnapshot, verifyDiagnosticMarker, type ExternalContextSnapshot } from "../render/marker.ts";
import type { CreateMergeRequestInput, RemoteMergeRequest } from "./create-mr.ts";
import { selectMandatoryLabels, type LabelSelectionOptions } from "./mandatory-labels.ts";
import { candidateSelectionDigest, remoteSnapshotDigest } from "./transaction-journal.ts";
import { buildWritePlan, type MergeRequestWritePlan } from "./write-plan.ts";

export interface PristineCreateResumeInputs {
  readonly iid: number;
  readonly originalRequest: Request;
  readonly originalContext: ResolvedContext;
  readonly request: Request;
  readonly binding: ContextBinding;
  readonly initialSnapshot: ExternalContextSnapshot;
  readonly resolvedCandidates: readonly Candidate[];
  readonly current: RemoteMergeRequest;
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly labelDiff: CanonicalLabelChangeSet;
  readonly labelOptions?: LabelSelectionOptions;
}

/** Only this module can authorize bypassing final-description ownership for resume. */
export interface PristineCreateResumeAuthorization {
  readonly iid: number;
  readonly createInput: CreateMergeRequestInput;
  readonly writePlan: MergeRequestWritePlan;
  readonly originalCandidateSelectionDigest: string;
  readonly currentSnapshotDigest: string;
}

export interface PristineResumeWriteIntent {
  readonly request: Request;
  readonly resolvedCandidates: readonly Candidate[];
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly labelDiff: CanonicalLabelChangeSet;
  readonly labelOptions?: LabelSelectionOptions;
}

const authorizations = new WeakMap<object, { readonly currentDigest: string; readonly intentDigest: string }>();

function writeIntentDigest(intent: PristineResumeWriteIntent): string {
  return sha256CanonicalJson(copyJsonValue({ request: normalizeAndValidateRequest(intent.request),
    candidates: intent.resolvedCandidates, bundleManifestHash: sha256Utf8(`${canonicalizeJson(intent.bundle.manifest)}\n`),
    releaseTag: intent.releaseTag, cliVersion: intent.cliVersion, sourceBranch: intent.sourceBranch,
    labelDiff: intent.labelDiff, labelOptions: intent.labelOptions ?? null }));
}

function denied(reason: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "The provisional merge request cannot be resumed safely", {
    field: "--resume",
    expected: "the original provisional description and a complete transaction prefix, with private proof and fresh equivalent candidate selections",
    actual: reason,
    safeNextStep: "Preserve the merge request and its original local evidence; refresh context and preview an equivalent request before resuming.",
  });
}

function same(left: unknown, right: unknown): boolean {
  return canonicalizeJson(copyJsonValue(left)) === canonicalizeJson(copyJsonValue(right));
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length &&
    same([...left].sort(), [...right].sort());
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function selectionIdentity(request: Request, candidates: readonly Candidate[]): unknown {
  const selections = [
    ...request.mergeRequest.labelCandidateTokens.map((token) => ({ token, kind: "label" })),
    ...(request.mergeRequest.assigneeCandidateToken === null ? []
      : [{ token: request.mergeRequest.assigneeCandidateToken, kind: "assignee" }]),
    ...request.review.reviewerCandidateTokens.map((token) => ({ token, kind: "reviewer" })),
  ];
  if (selections.length !== candidates.length ||
      selections.some((selection, index) => selection.kind !== candidates[index]?.kind) ||
      new Set(selections.map((selection) => selection.token)).size !== selections.length) {
    throw denied("candidate selections do not match their private context");
  }
  let index = 0;
  const labels = request.mergeRequest.labelCandidateTokens.map(() => candidates[index++]);
  const assignee = request.mergeRequest.assigneeCandidateToken === null ? null : candidates[index++];
  const reviewers = request.review.reviewerCandidateTokens.map(() => candidates[index++]);
  return {
    ...request, contextId: null,
    mergeRequest: { ...request.mergeRequest, labelCandidateTokens: labels, assigneeCandidateToken: assignee },
    review: { ...request.review, reviewerCandidateTokens: reviewers },
  };
}

function bindingScope(binding: ContextBinding): unknown {
  return { gitlabOrigin: binding.gitlabOrigin, sourceProject: binding.sourceProject,
    targetProject: binding.targetProject, sourceBranch: binding.sourceBranch,
    targetBranch: binding.targetBranch, sourceHeadSha: binding.sourceHeadSha,
    targetRefSha: binding.targetRefSha, bundle: binding.bundle, protocols: binding.protocols };
}

function snapshotScope(snapshot: ExternalContextSnapshot): unknown {
  return { sourceProject: snapshot.sourceProject, targetProject: snapshot.targetProject,
    sourceHeadSha: snapshot.sourceHeadSha, targetRefSha: snapshot.targetRefSha,
    mergeBaseSha: snapshot.mergeBaseSha, authorUserId: snapshot.mergeRequest.authorUserId };
}

function assertBindingSnapshot(binding: ContextBinding, snapshot: ExternalContextSnapshot): void {
  if (binding.operation !== "create" || binding.mrIid !== null ||
      snapshot.mergeRequest.lifecycle !== "new" || snapshot.mergeRequest.iid !== null ||
      binding.sourceHeadSha !== snapshot.sourceHeadSha || binding.targetRefSha !== snapshot.targetRefSha ||
      binding.sourceProject.id !== snapshot.sourceProject.id ||
      binding.sourceProject.fullPath !== snapshot.sourceProject.path ||
      binding.targetProject.id !== snapshot.targetProject.id ||
      binding.targetProject.fullPath !== snapshot.targetProject.path) {
    throw denied("original or fresh create context has a different repository identity");
  }
}

export function validatePristineCreateResume(inputs: PristineCreateResumeInputs): PristineCreateResumeAuthorization {
  try {
    const original = inputs.originalContext;
    const snapshot = validateExternalContextSnapshot(inputs.initialSnapshot);
    const oldSnapshot = validateExternalContextSnapshot(original.snapshot);
    const effectiveRequest = (raw: Request, binding: ExternalContextSnapshot): Request => {
      const normalized = normalizeAndValidateRequest(raw);
      const selection = selectMandatoryLabels({ diff: inputs.labelDiff, binding,
        inventory: binding.labelCandidates,
        ...(inputs.labelOptions === undefined ? {} : { options: inputs.labelOptions }) });
      return normalizeAndValidateRequest({ ...normalized,
        title: { ...normalized.title, type: selection.titleType } });
    };
    const request = effectiveRequest(inputs.request, snapshot);
    const originalRequest = effectiveRequest(inputs.originalRequest, oldSnapshot);
    const current = inputs.current;
    const marker = verifyDiagnosticMarker(current.description);
    assertBindingSnapshot(original.binding, oldSnapshot);
    assertBindingSnapshot(inputs.binding, snapshot);
    if (!Number.isSafeInteger(inputs.iid) || inputs.iid < 1 || current.iid !== inputs.iid ||
        original.contextId !== originalRequest.contextId || request.contextId === originalRequest.contextId ||
        original.externalSnapshotDigest !== sha256CanonicalJson(oldSnapshot) ||
        !same(bindingScope(original.binding), bindingScope(inputs.binding)) ||
        !same(snapshotScope(oldSnapshot), snapshotScope(snapshot)) ||
        !same(snapshotScope(snapshot), snapshotScope(validateExternalContextSnapshot(current.snapshot))) ||
        !same(selectionIdentity(originalRequest, original.candidates), selectionIdentity(request, inputs.resolvedCandidates))) {
      throw denied("request, candidate, snapshot, or project identity changed");
    }
    const manifestHash = sha256Utf8(`${canonicalizeJson(inputs.bundle.manifest)}\n`);
    if (original.binding.bundle.manifestHash !== manifestHash ||
        original.binding.bundle.id !== inputs.bundle.manifest.bundleId ||
        original.binding.bundle.version !== inputs.bundle.manifest.version ||
        original.binding.bundle.releaseTag !== inputs.releaseTag ||
        original.binding.protocols.policySchema !== inputs.bundle.manifest.policySchema ||
        marker.renderPhase !== "provisional" || marker.cliVersion !== original.binding.cliVersion ||
        marker.requestDigest !== sha256CanonicalJson(originalRequest) ||
        marker.snapshotDigest !== original.externalSnapshotDigest) {
      throw denied("original marker or pinned Bundle does not match the private proof");
    }
    const options = inputs.labelOptions === undefined ? {} : { labelOptions: inputs.labelOptions };
    const oldPlan = buildWritePlan({ request: originalRequest, snapshot: oldSnapshot,
      resolvedCandidates: original.candidates, bundle: inputs.bundle, labelDiff: inputs.labelDiff, ...options });
    const writePlan = buildWritePlan({ request, snapshot, resolvedCandidates: inputs.resolvedCandidates,
      bundle: inputs.bundle, labelDiff: inputs.labelDiff, ...options });
    if (!same(oldPlan, writePlan) || marker.writePlanDigest !== sha256CanonicalJson(oldPlan.desired)) {
      throw denied("original and fresh write plans differ");
    }
    const createInput: CreateMergeRequestInput = {
      title: oldPlan.provisional.title,
      description: renderDescription({ request: originalRequest, snapshot: oldSnapshot, writePlan: oldPlan.desired,
        bundle: inputs.bundle, releaseTag: inputs.releaseTag, cliVersion: original.binding.cliVersion,
        renderPhase: "provisional" }),
      sourceProjectId: original.binding.sourceProject.id, sourceBranch: original.binding.sourceBranch,
      targetProjectId: original.binding.targetProject.id, targetBranch: originalRequest.targetBranch,
      sourceHeadSha: oldSnapshot.sourceHeadSha, squash: oldPlan.provisional.squash,
      removeSourceBranch: oldPlan.provisional.removeSourceBranch,
    };
    const live = current.snapshot.mergeRequest;
    // Accepted prefixes of an interrupted create: nothing written yet; the full
    // planned label set without people; the full label set with all people.
    const emptyMetadata = current.assigneeUserId === null && current.reviewerUserIds.length === 0;
    const completeMetadata = current.assigneeUserId === oldPlan.desired.assigneeUserId &&
      sameIds(current.reviewerUserIds, oldPlan.desired.reviewerUserIds);
    const completeLabels = sameIds(current.labelIds, oldPlan.desired.labelIds);
    const completePrefix = (current.labelIds.length === 0 && emptyMetadata) ||
      (completeLabels && (emptyMetadata || completeMetadata));
    const expectedUrl = `${inputs.binding.gitlabOrigin}/${inputs.binding.targetProject.fullPath}/-/merge_requests/${String(inputs.iid)}`;
    if (current.webUrl !== expectedUrl || current.title !== createInput.title ||
        current.description !== createInput.description || current.state !== "opened" || current.draft ||
        current.sourceProjectId !== createInput.sourceProjectId || current.sourceBranch !== createInput.sourceBranch ||
        current.targetProjectId !== createInput.targetProjectId || current.targetBranch !== createInput.targetBranch ||
        current.targetBranch !== inputs.binding.targetBranch || current.sourceHeadSha !== createInput.sourceHeadSha ||
        current.squash !== createInput.squash || current.removeSourceBranch !== createInput.removeSourceBranch ||
        !completePrefix || live.iid !== inputs.iid || live.lifecycle !== "ready" ||
        !sameIds(current.labelIds, live.labelIds) || current.assigneeUserId !== live.assigneeUserId ||
        !sameIds(current.reviewerUserIds, live.reviewerUserIds)) {
      throw denied("the selected MR does not match a complete pre-description transaction prefix");
    }
    const authorization = freeze({ iid: inputs.iid, createInput, writePlan,
      originalCandidateSelectionDigest: candidateSelectionDigest(originalRequest, original.candidates, oldSnapshot),
      currentSnapshotDigest: remoteSnapshotDigest(current) });
    authorizations.set(authorization, { currentDigest: sha256CanonicalJson(copyJsonValue(current)),
      intentDigest: writeIntentDigest({ request, resolvedCandidates: inputs.resolvedCandidates,
        bundle: inputs.bundle, releaseTag: inputs.releaseTag, cliVersion: inputs.binding.cliVersion,
        sourceBranch: inputs.binding.sourceBranch, labelDiff: inputs.labelDiff, ...options }) });
    return authorization;
  } catch (error) {
    if (error instanceof ToolError && error.code === "INPUT_ERROR" && error.details.field === "--resume") throw error;
    throw denied("the original evidence or provisional merge request could not be verified");
  }
}

export function assertPristineResumeAuthorization(
  authorization: PristineCreateResumeAuthorization,
  current: RemoteMergeRequest,
  intent?: PristineResumeWriteIntent,
): void {
  try {
    const proof = authorization !== null && typeof authorization === "object"
      ? authorizations.get(authorization) : undefined;
    if (authorization === null || typeof authorization !== "object" ||
        proof?.currentDigest !== sha256CanonicalJson(copyJsonValue(current)) ||
        authorization.iid !== current.iid || authorization.currentSnapshotDigest !== remoteSnapshotDigest(current) ||
        (intent !== undefined && proof.intentDigest !== writeIntentDigest(intent))) {
      throw denied("the resume authorization is absent, forged, or bound to another MR state");
    }
  } catch (error) {
    if (error instanceof ToolError && error.code === "INPUT_ERROR") throw error;
    throw denied("the resume authorization could not be verified");
  }
}
