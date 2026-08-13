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
  readonly labelOperationModes: readonly ["ADD", "REMOVE"];
}

export interface GitLabRequestAudit {
  readonly requestIds: readonly string[];
}
