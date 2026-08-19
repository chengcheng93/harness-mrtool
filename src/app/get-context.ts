import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { canonicalizeJson, sha256Utf8, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import type {
  Candidate,
  ContextBinding,
  ContextOperation,
  IssuedContext,
  IssueContextInput,
} from "../context/types.ts";
import type { CandidateContextStore } from "../context/store.ts";
import type { GitLabClient } from "../gitlab/client.ts";
import { normalizeGitLabOrigin } from "../gitlab/http.ts";
import type { GitLabAppliedLabel, GitLabIssue, GitLabLabel, GitLabMergeRequest, GitLabUser } from "../gitlab/types.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
  type IssueContextSnapshot,
} from "../render/marker.ts";

export interface GitContextSnapshot {
  readonly sourceProject: { readonly id: string; readonly path: string };
  readonly sourceBranch: string;
  readonly targetRefSha: string;
  readonly mergeBaseSha: string;
  readonly sourceHeadSha: string;
  readonly targetBranch: string;
  readonly localChecks: ExternalContextSnapshot["localChecks"];
}

export interface GetContextRelease {
  readonly releaseSetId: string;
  readonly releaseTag: string;
  readonly bundleManifestHash: string;
  readonly cliVersion: string;
  readonly skillProtocol: number | null;
}

export interface GetContextOptions {
  readonly operation: ContextOperation;
  readonly gitlabOrigin: string;
  readonly targetProject: string;
  readonly mrIid: number | null;
  readonly issueIid: number | null;
  readonly git: GitContextSnapshot;
  readonly bundle: LoadedTemplateBundle;
  readonly release: GetContextRelease;
  readonly gitlab: GitLabClient;
  readonly store: Pick<CandidateContextStore, "issue">;
}

export interface ContextLabelCandidate {
  readonly token: string;
  readonly category: string;
  readonly name: string;
  readonly description: string;
  readonly scopeKind: "project" | "group";
  readonly scopePath: string;
  readonly currentlyApplied: boolean;
}

export interface ContextUserCandidate {
  readonly token: string;
  readonly kind: "assignee" | "reviewer";
  readonly username: string;
  readonly displayName: string;
  readonly currentlyApplied: boolean;
  readonly defaultSelected: boolean;
  readonly qualifiedReviewer: boolean;
}

export interface DiscoveredContext {
  readonly contextId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly binding: ContextBinding;
  readonly snapshot: ExternalContextSnapshot;
  readonly labelCandidates: readonly ContextLabelCandidate[];
  readonly userCandidates: readonly ContextUserCandidate[];
  readonly requiredLabelCategories: readonly string[];
  readonly lifecycleLabelNames: {
    readonly draft: string;
    readonly ready: string;
    readonly merge: string;
  };
  readonly audit: { readonly requestIds: readonly string[] };
}

interface LabelCategory {
  readonly id: string;
  readonly pattern: RegExp;
  readonly required: boolean;
  readonly max: number;
}

interface PolicyView {
  readonly categories: readonly LabelCategory[];
  readonly lifecycle: {
    readonly statusCategory: string;
    readonly expectedNames: { readonly draft: string; readonly ready: string; readonly merge: string };
  };
}

function contextError(code: "LABEL_ERROR" | "GITLAB_ERROR", message: string, actual: string): ToolError<"LABEL_ERROR" | "GITLAB_ERROR"> {
  return new ToolError(code, message, {
    field: code === "LABEL_ERROR" ? "mergeRequest.labelCandidateTokens" : "gitlab",
    expected: code === "LABEL_ERROR"
      ? "at least one unambiguous live candidate for every required label category"
      : "a complete immutable external context snapshot",
    actual,
    safeNextStep: code === "LABEL_ERROR"
      ? "Create or restore the required GitLab project/group labels, then refresh context."
      : "Retry context after the GitLab state becomes readable.",
  });
}

function asObject(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw contextError("GITLAB_ERROR", `Template Policy ${subject} is invalid`, subject);
  }
  return value;
}

function nonEmpty(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw contextError("GITLAB_ERROR", `Template Policy ${subject} is invalid`, subject);
  }
  return value;
}

function policy(bundle: LoadedTemplateBundle): PolicyView {
  const labels = asObject(bundle.policy.labels, "labels");
  const rawCategories = asObject(labels.categories, "label categories");
  const categories: LabelCategory[] = [];
  for (const [id, value] of Object.entries(rawCategories)) {
    const category = asObject(value, `category ${id}`);
    let pattern: RegExp;
    try {
      pattern = new RegExp(nonEmpty(category.match, `category ${id} match`), "u");
    } catch {
      throw contextError("GITLAB_ERROR", "Template Policy label regex is invalid", id);
    }
    if (typeof category.required !== "boolean" || !Number.isSafeInteger(category.max) || (category.max as number) < 1) {
      throw contextError("GITLAB_ERROR", "Template Policy label category is invalid", id);
    }
    categories.push({ id, pattern, required: category.required, max: category.max as number });
  }
  const lifecycle = asObject(labels.lifecycle, "lifecycle");
  const expected = asObject(lifecycle.expectedNames, "lifecycle names");
  return Object.freeze({
    categories: Object.freeze(categories),
    lifecycle: Object.freeze({
      statusCategory: nonEmpty(lifecycle.statusCategory, "lifecycle status category"),
      expectedNames: Object.freeze({
        draft: nonEmpty(expected.draft, "draft lifecycle label"),
        ready: nonEmpty(expected.ready, "ready lifecycle label"),
        merge: nonEmpty(expected.merge, "merge lifecycle label"),
      }),
    }),
  });
}

function categoryFor(label: GitLabLabel, categories: readonly LabelCategory[]): string | null {
  const matches = categories.filter((category) => {
    category.pattern.lastIndex = 0;
    return category.pattern.test(label.name);
  });
  if (matches.length > 1) {
    throw contextError("LABEL_ERROR", "GitLab label matches more than one Policy category", label.name);
  }
  return matches[0]?.id ?? null;
}

function userSnapshot(value: GitLabUser): { readonly id: string; readonly username: string; readonly displayName: string } {
  return Object.freeze({ id: value.id, username: value.username, displayName: value.displayName });
}

function labelSnapshot(value: GitLabLabel): { readonly id: string; readonly name: string } {
  return Object.freeze({ id: value.globalId, name: value.name });
}

function resolveAppliedLabels(
  applied: readonly GitLabAppliedLabel[],
  labels: readonly GitLabLabel[],
  subject: "Issue" | "MR",
): readonly { readonly id: string; readonly name: string }[] {
  const byRestId = new Map<number, GitLabLabel[]>();
  for (const label of labels) {
    const values = byRestId.get(label.restId) ?? [];
    values.push(label);
    byRestId.set(label.restId, values);
  }
  return Object.freeze(applied.map((entry) => {
    const matches = (byRestId.get(entry.restId) ?? []).filter((label) => label.name === entry.name);
    if (matches.length !== 1) {
      throw contextError("GITLAB_ERROR", `${subject} label ID cannot be resolved unambiguously`, entry.name);
    }
    const match = matches[0] as GitLabLabel;
    if (entry.archived !== match.archived) {
      throw contextError("GITLAB_ERROR", `${subject} label archive state is inconsistent`, entry.name);
    }
    return labelSnapshot(match);
  }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
}

function issueSnapshot(issue: GitLabIssue | null, labels: readonly GitLabLabel[]): IssueContextSnapshot {
  if (issue === null) return Object.freeze({ kind: "none" });
  return Object.freeze({
    kind: "linked",
    iid: issue.iid,
    readStatus: "available",
    milestone: issue.milestone,
    assignees: Object.freeze(issue.assignees.map(userSnapshot)),
    dueDate: issue.dueDate,
    labels: resolveAppliedLabels(issue.labels, labels, "Issue"),
  });
}

function snapshotLabels(
  effective: readonly GitLabLabel[],
  all: readonly GitLabLabel[],
  issue: GitLabIssue | null,
  mr: GitLabMergeRequest | null,
): readonly GitLabLabel[] {
  const requiredRestIds = new Set([
    ...(issue?.labels ?? []),
    ...(mr?.labels ?? []),
  ].map((label) => label.restId));
  const byGlobalId = new Map(effective.map((label) => [label.globalId, label] as const));
  for (const label of all) {
    if (requiredRestIds.has(label.restId)) byGlobalId.set(label.globalId, label);
  }
  return Object.freeze([...byGlobalId.values()].sort((left, right) =>
    left.globalId < right.globalId ? -1 : left.globalId > right.globalId ? 1 : 0));
}

function mrSnapshot(
  mr: GitLabMergeRequest | null,
  currentUser: GitLabUser,
  labels: readonly GitLabLabel[],
  users: readonly GitLabUser[],
): ExternalContextSnapshot["mergeRequest"] {
  if ((mr?.assignees.length ?? 0) > 1) {
    throw contextError("GITLAB_ERROR", "MR has more assignees than the V1 contract supports", "multiple MR assignees");
  }
  const userIds = new Set(users.map((user) => user.id));
  const labelIds = resolveAppliedLabels(mr?.labels ?? [], labels, "MR").map((label) => label.id);
  const assigneeId = mr?.assignees[0]?.id ?? null;
  const reviewerIds = (mr?.reviewers ?? []).map((entry) => entry.id).sort();
  if ((assigneeId !== null && !userIds.has(assigneeId)) || reviewerIds.some((id) => !userIds.has(id))) {
    throw contextError("GITLAB_ERROR", "MR personnel cannot be resolved from the current project membership", "dangling user ID");
  }
  const lifecycle = mr === null ? "new"
    : mr.state === "merged" ? "merged"
    : mr.state === "closed" || mr.state === "locked" ? "closed"
    : mr.draft ? "draft" : "ready";
  return Object.freeze({
    iid: mr?.iid ?? null,
    authorUserId: mr?.author.id ?? currentUser.id,
    lifecycle,
    labelIds: Object.freeze(labelIds),
    assigneeUserId: assigneeId,
    reviewerUserIds: Object.freeze(reviewerIds),
  });
}

export async function getContext(options: GetContextOptions): Promise<DiscoveredContext> {
  validateTemplateBundle(options.bundle);
  const expectedManifestHash = sha256Utf8(`${canonicalizeJson(options.bundle.manifest)}\n`);
  if (options.release.bundleManifestHash !== expectedManifestHash) {
    throw contextError("GITLAB_ERROR", "Template Bundle receipt does not match the loaded Bundle", "Bundle manifest hash mismatch");
  }
  let requestedOrigin: string;
  try {
    requestedOrigin = normalizeGitLabOrigin(options.gitlabOrigin, options.gitlab.origin.startsWith("http://"));
  } catch {
    throw contextError("GITLAB_ERROR", "GitLab origin binding is invalid", "invalid GitLab origin");
  }
  if (requestedOrigin !== options.gitlab.origin) {
    throw contextError("GITLAB_ERROR", "GitLab origin binding does not match the API client", "GitLab origin mismatch");
  }
  if ((options.operation === "create") !== (options.mrIid === null)) {
    throw contextError("GITLAB_ERROR", "Context operation and MR IID are inconsistent", "operation/MR IID mismatch");
  }
  if (options.git.targetBranch === "" || options.git.sourceBranch === "") {
    throw contextError("GITLAB_ERROR", "Source or target branch is invalid", "empty branch");
  }
  const project = await options.gitlab.getProject(options.targetProject);
  const sourceProject = options.git.sourceProject.path === project.fullPath
    ? project
    : await options.gitlab.getProject(options.git.sourceProject.path);
  if (sourceProject.id !== options.git.sourceProject.id || sourceProject.fullPath !== options.git.sourceProject.path) {
    throw contextError("GITLAB_ERROR", "Source project identity does not match the local Git snapshot", "source project mismatch");
  }
  if (sourceProject.id === project.id && options.git.sourceBranch === options.git.targetBranch) {
    throw contextError("GITLAB_ERROR", "Source and target branches cannot be identical", "identical source and target branch");
  }
  const targetHead = await options.gitlab.getBranchHead(project.id, options.git.targetBranch);
  if (targetHead !== options.git.targetRefSha) {
    throw contextError("GITLAB_ERROR", "Target branch moved after the local Git snapshot", "target HEAD mismatch");
  }
  const [inventory, users, currentUser, issue, mr] = await Promise.all([
    options.gitlab.labelInventory(project.id),
    options.gitlab.listUsers(project.id),
    options.gitlab.getCurrentUser(),
    options.issueIid === null ? Promise.resolve(null) : options.gitlab.getIssue(project.id, options.issueIid),
    options.mrIid === null ? Promise.resolve(null) : options.gitlab.getMergeRequest(project.id, options.mrIid),
  ]);
  if (mr !== null && (
    mr.targetProjectId !== project.id || mr.targetBranch !== options.git.targetBranch ||
    mr.sourceProjectId !== options.git.sourceProject.id || mr.sourceBranch !== options.git.sourceBranch ||
    mr.sha !== options.git.sourceHeadSha
  )) {
    throw contextError("GITLAB_ERROR", "MR source/target identity does not match the local snapshot", "MR identity mismatch");
  }
  const review = mr === null
    ? { approvedUserIds: Object.freeze([]) as readonly string[], unresolvedDiscussions: 0 }
    : await options.gitlab.getReviewState(project.id, mr.iid, mr.sha);
  const policyView = policy(options.bundle);
  const categorized = inventory.effective.flatMap((label) => {
    const category = categoryFor(label, policyView.categories);
    return category === null ? [] : [{ label, category }];
  });
  for (const category of policyView.categories) {
    const matches = categorized.filter((entry) => entry.category === category.id);
    if (category.required && matches.length === 0) {
      throw contextError("LABEL_ERROR", "Required GitLab label category has no candidate", category.id);
    }
  }
  const statusNames = policyView.lifecycle.expectedNames;
  for (const name of new Set(Object.values(statusNames))) {
    const matches = categorized.filter((entry) => entry.category === policyView.lifecycle.statusCategory && entry.label.name === name);
    if (matches.length !== 1) throw contextError("LABEL_ERROR", "Lifecycle label cannot be resolved exactly", name);
  }
  const labelCandidates = categorized
    .filter((entry) => entry.category !== policyView.lifecycle.statusCategory)
    .map(({ label, category }): Candidate => ({
      kind: "label",
      restId: label.restId,
      globalId: label.globalId,
      name: label.name,
      description: label.description,
      color: label.color,
      scopeKind: label.scopeKind,
      scopeId: label.scopeId,
      scopePath: label.scopePath,
      policyCategory: category,
    }));
  const assignees: Candidate[] = users.map((entry) => ({
    kind: "assignee",
    userId: entry.id,
    globalId: `gid://gitlab/User/${entry.id}`,
    username: entry.username,
    displayName: entry.displayName,
  }));
  const reviewers: Candidate[] = users.filter((entry) => entry.id !== (mr?.author.id ?? currentUser.id)).map((entry) => ({
    kind: "reviewer",
    userId: entry.id,
    globalId: `gid://gitlab/User/${entry.id}`,
    username: entry.username,
    displayName: entry.displayName,
  }));
  const knownSnapshotLabels = snapshotLabels(inventory.effective, inventory.all, issue, mr);
  const snapshot = validateExternalContextSnapshot({
    snapshotVersion: 1,
    targetProject: { id: project.id, path: project.fullPath },
    sourceProject: { id: sourceProject.id, path: sourceProject.fullPath },
    targetRefSha: options.git.targetRefSha,
    mergeBaseSha: options.git.mergeBaseSha,
    sourceHeadSha: options.git.sourceHeadSha,
    issue: issueSnapshot(issue, inventory.all),
    labelCandidates: Object.freeze(knownSnapshotLabels.map(labelSnapshot)),
    userCandidates: Object.freeze(users.map(userSnapshot)),
    mergeRequest: mrSnapshot(mr, currentUser, inventory.all, users),
    localChecks: options.git.localChecks,
    metadataRead: { status: mr === null ? "unavailable" : "available", evidence: "GitLab MR metadata read completed." },
    ci: { status: mr?.pipelineStatus ?? "unavailable" },
    review: {
      approvedByUserIds: review.approvedUserIds,
      qualifiedReviewerUserIds: Object.freeze(users.filter((entry) => (entry.accessLevel ?? 0) >= 40).map((entry) => entry.id).sort()),
      unresolvedDiscussions: review.unresolvedDiscussions,
    },
  });
  const binding: ContextBinding = {
    operation: options.operation,
    gitlabOrigin: options.gitlab.origin,
    targetProject: { id: project.id, fullPath: project.fullPath },
    targetBranch: options.git.targetBranch,
    sourceProject: { id: sourceProject.id, fullPath: sourceProject.fullPath },
    sourceBranch: options.git.sourceBranch,
    sourceHeadSha: options.git.sourceHeadSha,
    targetRefSha: options.git.targetRefSha,
    mrIid: options.mrIid,
    releaseSetId: options.release.releaseSetId,
    cliVersion: options.release.cliVersion,
    bundle: {
      id: options.bundle.manifest.bundleId,
      version: options.bundle.manifest.version,
      releaseTag: options.release.releaseTag,
      manifestHash: options.release.bundleManifestHash,
    },
    protocols: {
      inputSchema: options.bundle.manifest.inputSchema,
      policySchema: options.bundle.manifest.policySchema,
      skillProtocol: options.release.skillProtocol,
    },
  };
  const finalProject = await options.gitlab.getProject(options.targetProject);
  if (finalProject.id !== project.id || finalProject.fullPath !== project.fullPath) {
    throw contextError("GITLAB_ERROR", "Target project identity changed during context discovery", "target project mismatch");
  }
  const finalTargetHead = await options.gitlab.getBranchHead(project.id, options.git.targetBranch);
  if (finalTargetHead !== options.git.targetRefSha) {
    throw contextError("GITLAB_ERROR", "Target branch moved during context discovery", "target HEAD mismatch");
  }
  const issueInput: IssueContextInput = { binding, snapshot: snapshot as unknown as JsonValue, candidates: [...labelCandidates, ...assignees, ...reviewers] };
  const issued: IssuedContext = await options.store.issue(issueInput);
  const mrLabelIds = new Set(snapshot.mergeRequest.labelIds);
  const mrAssigneeId = snapshot.mergeRequest.assigneeUserId;
  const mrReviewerIds = new Set(snapshot.mergeRequest.reviewerUserIds);
  const labelsOutput: ContextLabelCandidate[] = [];
  const usersOutput: ContextUserCandidate[] = [];
  for (const candidate of issued.candidates) {
    if (candidate.metadata.kind === "label") {
      labelsOutput.push({
        token: candidate.token,
        category: candidate.metadata.policyCategory,
        name: candidate.metadata.name,
        description: candidate.metadata.description,
        scopeKind: candidate.metadata.scopeKind,
        scopePath: candidate.metadata.scopePath,
        currentlyApplied: mrLabelIds.has(candidate.metadata.globalId),
      });
    } else {
      usersOutput.push({
        token: candidate.token,
        kind: candidate.metadata.kind,
        username: candidate.metadata.username,
        displayName: candidate.metadata.displayName,
        currentlyApplied: candidate.metadata.kind === "assignee"
          ? mrAssigneeId === candidate.metadata.userId
          : mrReviewerIds.has(candidate.metadata.userId),
        defaultSelected: candidate.metadata.kind === "assignee" && mr === null && candidate.metadata.userId === currentUser.id,
        qualifiedReviewer: candidate.metadata.kind === "reviewer" &&
          (snapshot.review.qualifiedReviewerUserIds?.includes(candidate.metadata.userId) ?? false),
      });
    }
  }
  const required = policyView.categories.filter((entry) => entry.required && entry.id !== policyView.lifecycle.statusCategory).map((entry) => entry.id);
  return Object.freeze({
    contextId: issued.contextId,
    createdAtMs: issued.createdAtMs,
    expiresAtMs: issued.expiresAtMs,
    binding,
    snapshot,
    labelCandidates: Object.freeze(labelsOutput),
    userCandidates: Object.freeze(usersOutput),
    requiredLabelCategories: Object.freeze(required),
    lifecycleLabelNames: statusNames,
    audit: options.gitlab.audit(),
  });
}
