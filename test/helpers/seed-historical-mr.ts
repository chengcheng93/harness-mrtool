import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { selectMandatoryLabels } from "../../src/app/mandatory-labels.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { buildVerificationReceipt } from "../../src/app/verify-mr.ts";
import type { CreateMergeRequestInputs, RemoteMergeRequest } from "../../src/app/create-mr.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";

/** Seed an MR written by an older release, without invoking a retired creation path. */
export function seedHistoricalMr(inputs: Pick<CreateMergeRequestInputs,
  "request" | "initialSnapshot" | "resolvedCandidates" | "bundle" | "releaseTag" |
  "cliVersion" | "sourceBranch" | "gitlabOrigin" | "labelDiff"> & {
    readonly iid?: number; readonly provisional?: boolean;
  }) {
  const labels = selectMandatoryLabels({ diff: inputs.labelDiff, binding: inputs.initialSnapshot,
    inventory: inputs.initialSnapshot.labelCandidates });
  const request = normalizeAndValidateRequest({ ...inputs.request,
    title: { ...inputs.request.title, type: labels.titleType } });
  const plan = buildWritePlan({ request, snapshot: inputs.initialSnapshot,
    resolvedCandidates: inputs.resolvedCandidates, bundle: inputs.bundle, labelDiff: inputs.labelDiff });
  const fields = inputs.provisional ? plan.provisional : plan.desired;
  const iid = inputs.iid ?? 88;
  const snapshot = validateExternalContextSnapshot({ ...inputs.initialSnapshot,
    mergeRequest: { ...inputs.initialSnapshot.mergeRequest, iid, lifecycle: "ready",
      labelIds: fields.labelIds, assigneeUserId: fields.assigneeUserId, reviewerUserIds: fields.reviewerUserIds } });
  // A provisional marker binds the original new-MR snapshot; a final marker binds the existing MR.
  const renderSnapshot = inputs.provisional ? inputs.initialSnapshot : snapshot;
  const description = renderDescription({ request, snapshot: renderSnapshot, writePlan: plan.desired,
    bundle: inputs.bundle, releaseTag: inputs.releaseTag, cliVersion: inputs.cliVersion,
    renderPhase: inputs.provisional ? "provisional" : "final" });
  const current: RemoteMergeRequest = { iid,
    webUrl: inputs.gitlabOrigin + "/" + snapshot.targetProject.path + "/-/merge_requests/" + iid,
    title: fields.title, description, draft: false, state: "opened",
    sourceProjectId: snapshot.sourceProject.id, sourceBranch: inputs.sourceBranch,
    targetProjectId: snapshot.targetProject.id, targetBranch: request.targetBranch,
    sourceHeadSha: snapshot.sourceHeadSha, labelIds: fields.labelIds,
    assigneeUserId: fields.assigneeUserId, reviewerUserIds: fields.reviewerUserIds,
    squash: fields.squash, removeSourceBranch: fields.removeSourceBranch, snapshot };
  const verification = { request, snapshot, writePlan: plan.desired, releaseTag: inputs.releaseTag,
    cliVersion: inputs.cliVersion, description, sourceBranch: inputs.sourceBranch };
  const receipt = inputs.provisional ? null : buildVerificationReceipt({ gitlabOrigin: inputs.gitlabOrigin,
    current, expected: verification, bundle: inputs.bundle });
  return { request, current, writePlan: plan, verification, receipt, iid, webUrl: current.webUrl, final: current };
}
