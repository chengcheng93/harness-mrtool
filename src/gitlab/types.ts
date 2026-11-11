export interface GitLabProject {
  readonly id: string;
  readonly fullPath: string;
  readonly defaultBranch: string;
  readonly webUrl: string;
}

export interface GitLabGroup {
  readonly id: string;
  readonly fullPath: string;
}

export interface GitLabLabel {
  readonly restId: number;
  readonly globalId: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly archived: boolean;
  readonly scopeKind: "project" | "group";
  readonly scopeId: string;
  readonly scopePath: string;
}

export interface GitLabUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly state: "active" | "blocked" | "deactivated";
  readonly accessLevel: number | null;
}

export interface GitLabAppliedLabel {
  readonly restId: number;
  readonly name: string;
  readonly archived: boolean;
}

export interface GitLabMilestone {
  readonly id: number;
  readonly title: string;
  readonly state: "active" | "closed";
  readonly dueDate: string | null;
}

export interface GitLabIssue {
  readonly iid: number;
  readonly milestone: string | null;
  readonly assignees: readonly GitLabUser[];
  readonly dueDate: string | null;
  readonly labels: readonly GitLabAppliedLabel[];
}

export interface GitLabMergeRequest {
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
  readonly sha: string;
  readonly author: GitLabUser;
  readonly assignees: readonly GitLabUser[];
  readonly reviewers: readonly GitLabUser[];
  readonly labels: readonly GitLabAppliedLabel[];
  readonly squash: boolean;
  readonly shouldRemoveSourceBranch: boolean;
  readonly pipelineStatus: "unavailable" | "pending" | "running" | "passed" | "failed" | "canceled" | "skipped";
}

export interface GitLabReviewState {
  readonly approvedUserIds: readonly string[];
  readonly unresolvedDiscussions: number;
}

export interface GitLabCapabilities {
  readonly version: string;
  readonly revision: string | null;
  readonly mergeRequestSetLabels: true;
  readonly labelOperationModes: readonly ["APPEND" | "ADD", "REMOVE"];
}

export interface GitLabRequestAudit {
  readonly requestIds: readonly string[];
}

export interface GitLabProjectIdentity {
  readonly id: string;
  readonly fullPath: string;
}

export interface GitLabValueReceipt<T> {
  readonly value: T;
  readonly requestId: string | null;
}

export interface GitLabMutationReceipt {
  readonly requestId: string | null;
}

export interface GitLabCreateMergeRequestInput {
  readonly title: string;
  readonly description: string;
  readonly sourceProjectId: number;
  readonly sourceBranch: string;
  readonly targetProjectId: number;
  readonly targetBranch: string;
  readonly squash: boolean;
  readonly removeSourceBranch: boolean;
}

export type GitLabUpdateMergeRequestInput =
  | {
      readonly kind: "managed-fields";
      readonly title: string;
      readonly targetBranch: string;
      readonly assigneeIds: readonly number[];
      readonly reviewerIds: readonly number[];
      readonly squash: boolean;
      readonly removeSourceBranch: boolean;
    }
  | { readonly kind: "description"; readonly description: string };

export interface GitLabCreateIssueInput {
  readonly projectId: number;
  readonly projectPath: string;
  readonly title: string;
  readonly description: string;
  readonly assigneeIds: readonly number[];
  readonly dueDate: string;
  readonly milestoneId?: number;
  readonly labelNames?: readonly string[];
}

export interface GitLabCreatedIssue {
  readonly id: number;
  readonly iid: number;
  readonly projectId: number;
  readonly webUrl: string;
}

export interface GitLabCreateMergeRequestSubmissionInput extends GitLabCreateMergeRequestInput {
  readonly milestoneId?: number;
  readonly targetProjectPath: string;
  readonly labelNames: readonly string[];
  readonly assigneeIds: readonly number[];
  readonly reviewerIds: readonly number[];
}

export interface GitLabSubmittedMergeRequest {
  readonly iid: number;
  readonly webUrl: string;
  readonly sourceProjectId: number;
  readonly targetProjectId: number;
}
