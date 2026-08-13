import {
  RemoteMutationError,
  RemoteReadError,
  isRemoteMutationError,
  type RemoteMutationFailureReason,
  type RemoteReadFailureReason,
} from "../app/remote-outcome.ts";
import type {
  CreateDraftInput,
  ManagedFieldsInput,
  MergeRequestRemote,
  RemoteMergeRequest,
} from "../app/create-mr.ts";
import { mutationReceipt, valueReceipt } from "../app/remote-receipt.ts";
import { isToolError } from "../contracts/errors.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import {
  GitLabClient,
  isGitLabMutationRejectedError,
  isGitLabResponseValidationError,
} from "./client.ts";
import { isGitLabRequestError, type GitLabRequestError } from "./http.ts";
import type {
  GitLabMergeRequest,
  GitLabProjectIdentity,
} from "./types.ts";

export interface GitLabMergeRequestRemoteOptions {
  readonly gitlab: GitLabClient;
  readonly targetProject: GitLabProjectIdentity;
  readonly snapshotReader: (mr: GitLabMergeRequest) => Promise<ExternalContextSnapshot>;
}

function positiveInteger(value: string, subject: string): number {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    throw new TypeError(`${subject} must be a positive numeric GitLab ID`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TypeError(`${subject} must be a safe numeric GitLab ID`);
  }
  return parsed;
}

function mutationReason(error: GitLabRequestError): RemoteMutationFailureReason {
  if (error.kind === "auth") return "auth";
  if (error.kind === "timeout") return "timeout";
  if (error.kind === "network") return "network";
  if (error.kind === "response") return "server";
  if (error.status === 409) return "conflict";
  if (error.status !== null && [400, 404, 422].includes(error.status)) return "validation";
  return "server";
}

function readReason(error: GitLabRequestError): RemoteReadFailureReason {
  if (error.kind === "auth") return "auth";
  if (error.kind === "timeout") return "timeout";
  if (error.kind === "network") return "network";
  if (error.kind === "http" && error.status !== null && error.status < 500) return "validation";
  return "server";
}

function asMutationError(error: unknown): RemoteMutationError {
  if (isRemoteMutationError(error)) return error;
  if (isGitLabMutationRejectedError(error)) {
    return new RemoteMutationError("rejected", "validation", error.requestId);
  }
  if (isGitLabResponseValidationError(error)) {
    return new RemoteMutationError("unknown", "server", error.requestId);
  }
  if (isGitLabRequestError(error)) {
    const reason = mutationReason(error);
    const outcome = reason === "auth" || reason === "validation" || reason === "conflict"
      ? "rejected"
      : "unknown";
    return new RemoteMutationError(outcome, reason, error.requestId);
  }
  if (error instanceof TypeError) {
    return new RemoteMutationError("rejected", "validation", null);
  }
  return new RemoteMutationError("unknown", "server", null);
}

function asReadError(error: unknown): RemoteReadError {
  if (isGitLabResponseValidationError(error)) {
    return new RemoteReadError("server", error.requestId);
  }
  if (isGitLabRequestError(error)) {
    return new RemoteReadError(readReason(error), error.requestId);
  }
  if (isToolError(error, "AUTH_ERROR")) return new RemoteReadError("auth", null);
  if (error instanceof TypeError) return new RemoteReadError("validation", null);
  return new RemoteReadError("server", null);
}

function assertSnapshotIdentity(
  snapshot: ExternalContextSnapshot,
  mr: GitLabMergeRequest,
  target: GitLabProjectIdentity,
): void {
  const expectedLifecycle = mr.state === "merged" ? "merged"
    : mr.state === "closed" || mr.state === "locked" ? "closed"
    : mr.draft ? "draft" : "ready";
  const assigneeId = mr.assignees[0]?.id ?? null;
  const reviewerIds = mr.reviewers.map((user) => user.id).sort();
  const users = new Map(snapshot.userCandidates.map((user) => [user.id, user] as const));
  const expectedUsers = [mr.author, ...mr.assignees, ...mr.reviewers];
  if (mr.assignees.length > 1 ||
      snapshot.targetProject.id !== target.id || snapshot.targetProject.path !== target.fullPath ||
      snapshot.sourceProject.id !== mr.sourceProjectId ||
      snapshot.sourceHeadSha !== mr.sha || snapshot.mergeRequest.iid !== mr.iid ||
      snapshot.mergeRequest.authorUserId !== mr.author.id ||
      snapshot.mergeRequest.lifecycle !== expectedLifecycle ||
      snapshot.ci.status !== mr.pipelineStatus ||
      snapshot.metadataRead.status !== "available" ||
      snapshot.mergeRequest.assigneeUserId !== assigneeId ||
      snapshot.mergeRequest.reviewerUserIds.length !== reviewerIds.length ||
      snapshot.mergeRequest.reviewerUserIds.some((id, index) => id !== reviewerIds[index]) ||
      expectedUsers.some((user) => {
        const candidate = users.get(user.id);
        return candidate?.username !== user.username || candidate.displayName !== user.displayName;
      })) {
    throw new Error("Snapshot identity does not match the fresh GitLab MR read");
  }
}

function assertAppliedLabelIdentity(
  mr: GitLabMergeRequest,
  snapshot: ExternalContextSnapshot,
): void {
  if (mr.labels.length !== snapshot.mergeRequest.labelIds.length) {
    throw new Error("MR labels do not match the bound snapshot");
  }
  const candidates = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const applied = new Map(mr.labels.map((label) => [label.restId, label.name] as const));
  const seen = new Set<number>();
  for (const id of snapshot.mergeRequest.labelIds) {
    const match = /^gid:\/\/gitlab\/(?:Project|Group)Label\/([1-9][0-9]*)$/u.exec(id);
    const restId = match === null ? NaN : Number(match[1]);
    if (!Number.isSafeInteger(restId) || seen.has(restId) ||
        candidates.get(id) !== applied.get(restId)) {
      throw new Error("MR labels do not match the bound snapshot");
    }
    seen.add(restId);
  }
}

function remoteValue(mr: GitLabMergeRequest, snapshot: ExternalContextSnapshot): RemoteMergeRequest {
  return Object.freeze({
    iid: mr.iid,
    webUrl: mr.webUrl,
    title: mr.title,
    description: mr.description,
    draft: mr.draft,
    state: mr.state,
    sourceProjectId: mr.sourceProjectId,
    sourceBranch: mr.sourceBranch,
    targetProjectId: mr.targetProjectId,
    targetBranch: mr.targetBranch,
    sourceHeadSha: mr.sha,
    labelIds: snapshot.mergeRequest.labelIds,
    assigneeUserId: mr.assignees[0]?.id ?? null,
    reviewerUserIds: Object.freeze(mr.reviewers.map((user) => user.id).sort()),
    squash: mr.squash,
    removeSourceBranch: mr.shouldRemoveSourceBranch,
    snapshot,
  });
}

export class GitLabMergeRequestRemote implements MergeRequestRemote {
  private readonly gitlab: GitLabClient;
  private readonly targetProject: GitLabProjectIdentity;
  private readonly snapshotReader: GitLabMergeRequestRemoteOptions["snapshotReader"];

  constructor(options: GitLabMergeRequestRemoteOptions) {
    this.gitlab = options.gitlab;
    this.targetProject = Object.freeze({ ...options.targetProject });
    this.snapshotReader = options.snapshotReader;
    if (!/^[1-9][0-9]*$/u.test(this.targetProject.id) ||
        this.targetProject.fullPath === "" || this.targetProject.fullPath !== this.targetProject.fullPath.trim()) {
      throw new TypeError("Target project identity is invalid");
    }
  }

  async createDraft(input: CreateDraftInput) {
    try {
      if (input.targetProjectId !== this.targetProject.id || !input.title.startsWith("Draft:")) {
        throw new TypeError("Draft create input is not bound to the target project");
      }
      const receipt = await this.gitlab.createMergeRequest(this.targetProject, {
        title: input.title,
        description: input.description,
        sourceProjectId: positiveInteger(input.sourceProjectId, "Source project ID"),
        sourceBranch: input.sourceBranch,
        targetProjectId: positiveInteger(input.targetProjectId, "Target project ID"),
        targetBranch: input.targetBranch,
        squash: input.squash,
        removeSourceBranch: input.removeSourceBranch,
      });
      return valueReceipt(receipt.value, receipt.requestId);
    } catch (error) {
      throw asMutationError(error);
    }
  }

  async findOpen(input: CreateDraftInput) {
    try {
      if (input.targetProjectId !== this.targetProject.id) throw new TypeError("Target project mismatch");
      const receipt = await this.gitlab.listOpenMergeRequestReceipts(
        this.targetProject,
        input.sourceBranch,
        input.targetBranch,
      );
      const matched = receipt.value.filter((mr) =>
        mr.state === "opened" && mr.sourceProjectId === input.sourceProjectId &&
        mr.sourceBranch === input.sourceBranch && mr.targetProjectId === input.targetProjectId &&
        mr.targetBranch === input.targetBranch);
      const values: RemoteMergeRequest[] = [];
      for (const mr of matched) values.push(await this.bind(mr));
      return valueReceipt(Object.freeze(values), receipt.requestId);
    } catch (error) {
      throw asReadError(error);
    }
  }

  async addLabels(iid: number, labelIds: readonly string[]) {
    return this.labels(iid, labelIds, "ADD");
  }

  async removeLabels(iid: number, labelIds: readonly string[]) {
    return this.labels(iid, labelIds, "REMOVE");
  }

  private async labels(iid: number, labelIds: readonly string[], mode: "ADD" | "REMOVE") {
    try {
      const receipt = await this.gitlab.mutateLabels(this.targetProject, iid, labelIds, mode);
      return mutationReceipt(receipt.requestId);
    } catch (error) {
      throw asMutationError(error);
    }
  }

  async writeManagedFields(iid: number, input: ManagedFieldsInput) {
    try {
      const receipt = await this.gitlab.updateMergeRequest(this.targetProject, iid, {
        kind: "managed-fields",
        title: input.title,
        targetBranch: input.targetBranch,
        assigneeIds: input.assigneeUserId === null
          ? []
          : [positiveInteger(input.assigneeUserId, "Assignee user ID")],
        reviewerIds: input.reviewerUserIds.map((id) => positiveInteger(id, "Reviewer user ID")),
        squash: input.squash,
        removeSourceBranch: input.removeSourceBranch,
      });
      return mutationReceipt(receipt.requestId);
    } catch (error) {
      throw asMutationError(error);
    }
  }

  async writeDescription(iid: number, description: string) {
    return this.updateTitleOrDescription(iid, { kind: "description", description });
  }

  async markReady(iid: number, title: string) {
    if (title.startsWith("Draft:")) throw new RemoteMutationError("rejected", "validation", null);
    return this.updateTitleOrDescription(iid, { kind: "title", title });
  }

  async markDraft(iid: number, title: string) {
    if (!title.startsWith("Draft:")) throw new RemoteMutationError("rejected", "validation", null);
    return this.updateTitleOrDescription(iid, { kind: "title", title });
  }

  private async updateTitleOrDescription(
    iid: number,
    input: { readonly kind: "description"; readonly description: string } |
      { readonly kind: "title"; readonly title: string },
  ) {
    try {
      const receipt = await this.gitlab.updateMergeRequest(this.targetProject, iid, input);
      return mutationReceipt(receipt.requestId);
    } catch (error) {
      throw asMutationError(error);
    }
  }

  async read(iid: number) {
    try {
      const receipt = await this.gitlab.getMergeRequestReceipt(this.targetProject, iid);
      return valueReceipt(await this.bind(receipt.value), receipt.requestId);
    } catch (error) {
      throw asReadError(error);
    }
  }

  private async bind(mr: GitLabMergeRequest): Promise<RemoteMergeRequest> {
    if (mr.targetProjectId !== this.targetProject.id) {
      throw new Error("MR target project does not match the bound target project");
    }
    const snapshot = validateExternalContextSnapshot(await this.snapshotReader(mr));
    assertSnapshotIdentity(snapshot, mr, this.targetProject);
    assertAppliedLabelIdentity(mr, snapshot);
    const value = remoteValue(mr, snapshot);
    return value;
  }
}
