import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { ToolError } from "../contracts/errors.ts";
import type { RemoteWrite } from "../contracts/exit-codes.ts";
import { copyJsonValue, type JsonObject } from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";
import type { GitLabClient } from "../gitlab/client.ts";
import type { GitLabCreatedIssue, GitLabSubmittedMergeRequest, GitLabMilestone } from "../gitlab/types.ts";
import { renderIssue, chinaDate } from "../render/issue.ts";
import { renderDescription } from "../render/markdown.ts";
import { validateExternalContextSnapshot, type ExternalContextSnapshot } from "../render/marker.ts";
import { appendSubmissionMarker } from "../render/submission.ts";
import { isRemoteMutationError } from "./remote-outcome.ts";
import { selectSubmissionMilestone, type SubmissionMilestoneSelection } from "./select-submission-milestone.ts";
import type { MergeRequestWritePlan } from "./write-plan.ts";

export interface CreateSubmissionInputs {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly plan: MergeRequestWritePlan;
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly remote: Pick<GitLabClient, "createIssue" | "createMergeRequestSubmission">;
  readonly now?: Date;
  readonly milestones?: readonly GitLabMilestone[];
  readonly assertNoCredentialExposure?: (value: unknown) => void;
}

export interface CreateSubmissionResult {
  readonly issue: GitLabCreatedIssue;
  readonly mergeRequest: GitLabSubmittedMergeRequest;
  readonly verification: "creation-response";
  readonly milestoneSelection: SubmissionMilestoneSelection;
  readonly operations: readonly string[];
}

interface SubmissionFailure {
  readonly remoteWrite: RemoteWrite;
  readonly data: JsonObject;
}
const failures = new WeakMap<object, SubmissionFailure>();

export function getSubmissionFailure(error: unknown): SubmissionFailure | null {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return null;
  const failure = failures.get(error);
  // A caller cannot alter the stored failure receipt through this projection.
  return failure === undefined ? null : copyJsonValue(failure) as unknown as SubmissionFailure;
}

function invalidInput(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Issue-first submission inputs are invalid", {
    field: null, expected: "a new Issue request, new MR snapshot and complete planned metadata",
    actual: "submission precondition mismatch",
    safeNextStep: "Correct the submission inputs before creating a new Issue.",
  });
}

function numericId(value: string): number {
  if (!/^[1-9][0-9]*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw invalidInput();
  return Number(value);
}
function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}
function safeUrl(value: unknown, path: string, kind: "issues" | "merge_requests", iid: number): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" && decodeURIComponent(url.pathname) === "/" + path + "/-/" + kind + "/" + String(iid);
  } catch { return false; }
}
function issueFromReceipt(value: unknown, projectId: number, projectPath: string): GitLabCreatedIssue {
  const copied = copyJsonValue(value) as unknown as GitLabCreatedIssue;
  if (copied === null || typeof copied !== "object" || !positive(copied.id) || !positive(copied.iid) ||
      copied.projectId !== projectId || !safeUrl(copied.webUrl, projectPath, "issues", copied.iid)) {
    throw new TypeError("Issue creation response identity is invalid");
  }
  return { id: copied.id, iid: copied.iid, projectId: copied.projectId, webUrl: copied.webUrl };
}
function mrFromReceipt(value: unknown, sourceProjectId: number, targetProjectId: number, targetPath: string): GitLabSubmittedMergeRequest {
  const copied = copyJsonValue(value) as unknown as GitLabSubmittedMergeRequest;
  if (copied === null || typeof copied !== "object" || !positive(copied.iid) || copied.sourceProjectId !== sourceProjectId ||
      copied.targetProjectId !== targetProjectId || !safeUrl(copied.webUrl, targetPath, "merge_requests", copied.iid)) {
    throw new TypeError("MR creation response identity is invalid");
  }
  return { iid: copied.iid, webUrl: copied.webUrl, sourceProjectId: copied.sourceProjectId, targetProjectId: copied.targetProjectId };
}

/** Exactly two dependent POSTs, with no readback, retries or compensation. */
export async function createSubmission(input: CreateSubmissionInputs): Promise<CreateSubmissionResult> {
  const snapshot = validateExternalContextSnapshot(input.snapshot);
  if (input.request.workItem.relation !== "new" || snapshot.mergeRequest.iid !== null || snapshot.mergeRequest.lifecycle !== "new" ||
      input.request.targetBranch !== input.targetBranch || input.sourceBranch.trim() === "" || input.targetBranch.trim() === "") throw invalidInput();
  // These marker fields are independent of the not-yet-created Issue IID.
  if (!/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/u.test(input.cliVersion) ||
      snapshot.targetProject.path.length > 512 || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/u.test(snapshot.targetProject.path)) throw invalidInput();
  const targetProjectId = numericId(snapshot.targetProject.id);
  const sourceProjectId = numericId(snapshot.sourceProject.id);
  const authorId = numericId(snapshot.mergeRequest.authorUserId);
  const desired = input.plan.desired;
  const labelNames = desired.labelIds.map((id) => {
    const labels = snapshot.labelCandidates.filter((label) => label.id === id);
    if (labels.length !== 1) throw invalidInput();
    return labels[0]!.name;
  });
  const assigneeIds = desired.assigneeUserId === null ? [] : [numericId(desired.assigneeUserId)];
  const reviewerIds = desired.reviewerUserIds.map(numericId);
  const date = chinaDate(input.now);
  const milestoneSelection = selectSubmissionMilestone(input.milestones ?? [], date);
  const milestoneFields = milestoneSelection.milestone === null ? {} : { milestoneId: milestoneSelection.milestone.id };
  if (milestoneSelection.milestone !== null && !positive(milestoneSelection.milestone.id)) throw invalidInput();
  const issueBody = renderIssue({ request: input.request, projectPath: snapshot.targetProject.path, authorUserId: snapshot.mergeRequest.authorUserId, date });
  const assertSafe = input.assertNoCredentialExposure ?? (() => {});
  assertSafe(milestoneSelection);
  const renderMr = (request: Request, renderSnapshot: ExternalContextSnapshot): string => renderDescription({
    request, snapshot: renderSnapshot, writePlan: desired, bundle: input.bundle,
    releaseTag: input.releaseTag, cliVersion: input.cliVersion, renderPhase: "preview",
  });
  const mrFields = {
    title: desired.title, sourceProjectId, sourceBranch: input.sourceBranch,
    targetProjectId, targetProjectPath: snapshot.targetProject.path, targetBranch: input.targetBranch,
    ...milestoneFields, squash: desired.squash, removeSourceBranch: desired.removeSourceBranch, labelNames, assigneeIds, reviewerIds,
  };
  const markerContext = {
    cliVersion: input.cliVersion, targetProjectPath: snapshot.targetProject.path, sourceHeadSha: snapshot.sourceHeadSha,
  };
  // Check the whole renderer before writing, without pretending an Issue IID exists.
  const previewBody = renderMr({ ...input.request, workItem: { relation: "none", noIssueReason: "A new Issue will be created by this submission." } }, { ...snapshot, issue: { kind: "none" } });
  assertSafe({
    ...mrFields,
    description: previewBody.replace(/<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n?$/u, ""),
    submissionMarker: markerContext,
  });
  const issueInput = {
    projectId: targetProjectId, projectPath: snapshot.targetProject.path, ...issueBody,
    ...milestoneFields, assigneeIds: [authorId], labelNames: labelNames.filter((name) => /^(?:type|priority)::/u.test(name)),
  };
  assertSafe(issueInput);
  const operations: string[] = [];
  let issue: GitLabCreatedIssue | null = null;
  let failedOperation = "issue.create";
  let mutationInFlight = false;
  try {
    operations.push("issue.create");
    mutationInFlight = true;
    const issueReceipt = await input.remote.createIssue(issueInput);
    const safeIssue = issueFromReceipt(issueReceipt.value, targetProjectId, snapshot.targetProject.path);
    assertSafe(safeIssue);
    issue = safeIssue;
    mutationInFlight = false;
    failedOperation = "merge-request.prepare";
    const body = renderMr({ ...input.request, workItem: { relation: "closes", iid: issue.iid } }, {
      ...snapshot, issue: { kind: "linked", iid: issue.iid, readStatus: "unavailable" },
    }).replace(/<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n?$/u, "");
    const description = appendSubmissionMarker(body, {
      ...markerContext, issueIid: issue.iid,
    });
    const mrInput = { ...mrFields, description };
    assertSafe(mrInput);
    failedOperation = "merge-request.create";
    operations.push("merge-request.create");
    mutationInFlight = true;
    const mrReceipt = await input.remote.createMergeRequestSubmission(mrInput);
    const mergeRequest = mrFromReceipt(mrReceipt.value, sourceProjectId, targetProjectId, snapshot.targetProject.path);
    assertSafe(mergeRequest);
    mutationInFlight = false;
    failedOperation = "submission.result";
    const result: CreateSubmissionResult = { issue, mergeRequest, milestoneSelection, verification: "creation-response", operations: [...operations] };
    assertSafe(result);
    return result;
  } catch (error) {
    const rejected = mutationInFlight && isRemoteMutationError(error, "rejected");
    const unknown = mutationInFlight && !rejected;
    const state = unknown ? "unknown" : issue === null ? "not-written" : "written";
    const code = unknown ? "PARTIAL_REMOTE_STATE" : issue !== null ? "PARTIAL_WRITE" :
      isRemoteMutationError(error) && error.reason === "auth" ? "AUTH_ERROR" : "GITLAB_ERROR";
    const outcome = unknown ? "unknown" : rejected ? "rejected" : "not-attempted";
    const failure = new ToolError(code, unknown ? "Issue-first submission stopped with unknown remote state" : "Issue-first submission stopped", {
      field: failedOperation, expected: "successful creation responses for the Issue and merge request",
      actual: outcome, safeNextStep: (issue === null ? "" : `Issue created: ${issue.webUrl}. `) +
        "Submission stopped; no automatic retry was performed. Inspect GitLab manually before deciding whether to create another submission.",
    });
    const data: JsonObject = { command: "create", mode: "issue-first", failedOperation, issue: issue === null ? null : { ...issue }, outcome };
    failures.set(failure, { remoteWrite: { state, operations: [...operations] }, data });
    throw failure;
  }
}
