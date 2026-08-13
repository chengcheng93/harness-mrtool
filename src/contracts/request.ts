export const REQUEST_SCHEMA_VERSION = 1 as const;

export interface RequestIdentity {
  readonly schemaVersion: typeof REQUEST_SCHEMA_VERSION;
  readonly contextId: string;
}

export type RequestIntent = "draft" | "ready";
export type ImpactNature = "functional" | "non-functional" | "docs-only";
export type RiskLevel = "low" | "medium" | "high";
export type VerificationState = "checked" | "pending" | "not-applicable";
export type VerificationEvidenceKind =
  | "command-output"
  | "file-inspection"
  | "manual-verification"
  | "pending-reason"
  | "not-applicable-reason";

interface VerificationItemBase {
  readonly id: string;
  readonly evidence: string;
}

export type VerificationItem =
  | (VerificationItemBase & {
      readonly state: "checked";
      readonly evidenceKind: "command-output";
      readonly command: string;
      readonly result: string;
    })
  | (VerificationItemBase & {
      readonly state: "checked";
      readonly evidenceKind: "file-inspection" | "manual-verification";
      readonly command: string | null;
      readonly result: string;
    })
  | (VerificationItemBase & {
      readonly state: "pending";
      readonly evidenceKind: "pending-reason";
      readonly command: null;
      readonly result: null;
    })
  | (VerificationItemBase & {
      readonly state: "not-applicable";
      readonly evidenceKind: "not-applicable-reason";
      readonly command: null;
      readonly result: null;
    });

export type WorkItem =
  | { readonly relation: "closes" | "related"; readonly iid: number }
  | { readonly relation: "none"; readonly noIssueReason: string };

export interface Request extends RequestIdentity {
  readonly intent: RequestIntent;
  readonly profileIds: readonly string[];
  readonly targetBranch: string;
  readonly title: {
    readonly type: string;
    readonly module: string;
    readonly titleSummary: string;
  };
  readonly changes: {
    readonly summary: readonly string[];
    readonly technicalChanges: readonly string[];
    readonly outOfScope: readonly string[];
  };
  readonly motivation: {
    readonly background: readonly string[];
    readonly whyNeeded: readonly string[];
  };
  readonly workItem: WorkItem;
  readonly impact: {
    readonly areaIds: readonly string[];
    readonly nature: ImpactNature;
    readonly details: readonly string[];
  };
  readonly verification: {
    readonly items: readonly VerificationItem[];
    readonly acceptanceEvidence: readonly string[];
    readonly knownGaps: readonly string[];
  };
  readonly documentation: {
    readonly itemIds: readonly string[];
    readonly details: readonly string[];
  };
  readonly risk: {
    readonly level: RiskLevel;
    readonly items: readonly string[];
    readonly compatibilityImpact: readonly string[];
    readonly rollbackPlan: readonly string[];
  };
  readonly profileFields: Readonly<Record<string, readonly string[]>>;
  readonly review: {
    readonly reviewerCandidateTokens: readonly string[];
    readonly reviewerFocus: readonly string[];
    readonly additionalNotes: readonly string[];
  };
  readonly mergeRequest: {
    readonly assigneeCandidateToken: string | null;
    readonly labelCandidateTokens: readonly string[];
    readonly removeSourceBranch: boolean;
    readonly squash: boolean;
  };
}
