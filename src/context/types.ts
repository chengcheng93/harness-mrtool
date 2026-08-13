import type { JsonValue } from "../contracts/jcs.ts";

export const CONTEXT_STORE_VERSION = 1 as const;
export const CANDIDATE_CONTEXT_TTL_MS = 30 * 60 * 1_000;

export type CandidateKind = "label" | "assignee" | "reviewer";
export type ContextOperation = "create" | "update" | "migrate";

export interface ContextBinding {
  readonly operation: ContextOperation;
  readonly gitlabOrigin: string;
  readonly targetProject: {
    readonly id: string;
    readonly fullPath: string;
  };
  readonly targetBranch: string;
  readonly sourceHeadSha: string;
  readonly mrIid: number | null;
  readonly releaseSetId: string;
  readonly cliVersion: string;
  readonly bundle: {
    readonly id: string;
    readonly version: string;
    readonly releaseTag: string;
    readonly manifestHash: string;
  };
  readonly protocols: {
    readonly inputSchema: number;
    readonly policySchema: number;
    readonly skillProtocol: number | null;
  };
}

export interface LabelCandidate {
  readonly kind: "label";
  readonly restId: number;
  readonly globalId: string;
  readonly name: string;
  readonly description: string;
  readonly color: string;
  readonly scopeKind: "project" | "group";
  readonly scopeId: string;
  readonly scopePath: string;
  readonly policyCategory: string;
}

export interface UserCandidate {
  readonly kind: "assignee" | "reviewer";
  readonly userId: string;
  readonly globalId: string | null;
  readonly username: string;
  readonly displayName: string;
}

export type Candidate = LabelCandidate | UserCandidate;

export interface IssueContextInput {
  readonly binding: ContextBinding;
  readonly snapshot: JsonValue;
  readonly candidates: readonly Candidate[];
}

export interface IssuedCandidate {
  readonly kind: CandidateKind;
  readonly token: string;
  readonly metadata: Candidate;
}

export interface IssuedContext {
  readonly contextId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly externalSnapshotDigest: string;
  readonly candidates: readonly IssuedCandidate[];
}

export interface CandidateSelection {
  readonly token: string;
  readonly kind: CandidateKind;
}

export interface ResolveContextInput {
  readonly contextId: string;
  readonly expectedBinding: ContextBinding;
  readonly selections: readonly CandidateSelection[];
  readonly consume?: boolean;
}

export interface ResolvedContext {
  readonly contextId: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly binding: ContextBinding;
  readonly externalSnapshotDigest: string;
  readonly snapshot: JsonValue;
  readonly candidates: readonly Candidate[];
}

export interface PersistedCandidate {
  readonly tokenDigest: string;
  readonly kind: CandidateKind;
  readonly consumedAtMs: number | null;
  readonly metadata: Candidate;
}

export interface PersistedContext {
  readonly contextIdDigest: string;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
  readonly binding: ContextBinding;
  readonly externalSnapshotDigest: string;
  readonly snapshot: JsonValue;
  readonly candidates: readonly PersistedCandidate[];
}

export interface ContextStoreDocument {
  readonly storeVersion: typeof CONTEXT_STORE_VERSION;
  readonly contexts: readonly PersistedContext[];
}
