import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { composeProfiles } from "../bundle/compose.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";
import type { Candidate, LabelCandidate, UserCandidate } from "../context/types.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import { renderTitle } from "../render/title.ts";
import {
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type DesiredWritePlanSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";

export interface BuildWritePlanInputs {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly resolvedCandidates: readonly Candidate[];
  readonly bundle: LoadedTemplateBundle;
}

export interface MergeRequestWritePlan {
  readonly writePlanVersion: 1;
  readonly intent: "draft" | "ready";
  readonly provisional: DesiredWritePlanSnapshot;
  readonly draft: DesiredWritePlanSnapshot;
  readonly desired: DesiredWritePlanSnapshot;
  readonly draftStatusLabelId: string;
  readonly readyStatusLabelId: string;
  readonly managedLabelIds: readonly string[];
  readonly preservedLabelIds: readonly string[];
}

interface LabelCategory {
  readonly id: string;
  readonly pattern: RegExp;
  readonly required: boolean;
  readonly max: number;
}

interface PolicyContract {
  readonly categories: readonly LabelCategory[];
  readonly statusCategory: string;
  readonly draftName: string;
  readonly readyName: string;
  readonly typeCompatibility: Readonly<Record<string, RegExp>>;
  readonly draftMinimumReviewers: number;
  readonly readyMinimumReviewers: number;
  readonly highRiskMinimumReviewers: number;
}

function policyError(code: "LABEL_ERROR" | "POLICY_ERROR" | "INPUT_ERROR", reason: string): ToolError {
  return new ToolError(code, `Merge request write plan is invalid: ${reason}`, {
    field: code === "LABEL_ERROR" ? "mergeRequest.labelCandidateTokens" : null,
    expected: "a canonical Request whose resolved candidates satisfy the active Bundle Policy",
    actual: "write plan contract mismatch",
    safeNextStep: "Refresh context, choose candidates from that context, and preview the write plan again.",
  });
}

function object(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw policyError("POLICY_ERROR", `${subject} is invalid`);
  }
  return value;
}

function scalar(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u2028\u2029]/u.test(value)) {
    throw policyError("POLICY_ERROR", `${subject} is invalid`);
  }
  return value;
}

function integer(value: JsonValue | undefined, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw policyError("POLICY_ERROR", `${subject} is invalid`);
  }
  return value as number;
}

function regex(value: JsonValue | undefined, subject: string): RegExp {
  try {
    return new RegExp(scalar(value, subject), "u");
  } catch {
    throw policyError("POLICY_ERROR", `${subject} is invalid`);
  }
}

function readPolicy(bundle: LoadedTemplateBundle): PolicyContract {
  const labels = object(bundle.policy.labels, "Policy labels");
  const rawCategories = object(labels.categories, "Policy label categories");
  const categories = Object.entries(rawCategories).map(([id, raw]): LabelCategory => {
    const category = object(raw, `Policy category ${id}`);
    if (typeof category.required !== "boolean") {
      throw policyError("POLICY_ERROR", `Policy category ${id} is invalid`);
    }
    return Object.freeze({
      id,
      pattern: regex(category.match, `Policy category ${id} match`),
      required: category.required,
      max: integer(category.max, `Policy category ${id} max`),
    });
  });
  const lifecycle = object(labels.lifecycle, "Policy lifecycle");
  const expected = object(lifecycle.expectedNames, "Policy lifecycle names");
  const title = object(bundle.policy.title, "Policy title");
  const rawCompatibility = object(title.typeLabelCompatibility, "Policy type compatibility");
  const typeCompatibility: Record<string, RegExp> = {};
  for (const [id, pattern] of Object.entries(rawCompatibility)) {
    typeCompatibility[id] = regex(pattern, `Policy title compatibility ${id}`);
  }
  const review = object(bundle.policy.review, "Policy review");
  return Object.freeze({
    categories: Object.freeze(categories),
    statusCategory: scalar(lifecycle.statusCategory, "Policy status category"),
    draftName: scalar(expected.draft, "Policy draft lifecycle name"),
    readyName: scalar(expected.ready, "Policy ready lifecycle name"),
    typeCompatibility: Object.freeze(typeCompatibility),
    draftMinimumReviewers: integer(review.draftMinimumReviewers, "Policy draft reviewer minimum"),
    readyMinimumReviewers: integer(review.readyMinimumReviewers, "Policy ready reviewer minimum"),
    highRiskMinimumReviewers: integer(review.highRiskMinimumReviewers, "Policy high-risk reviewer minimum"),
  });
}

function categoryFor(name: string, policy: PolicyContract): string | null {
  const matches = policy.categories.filter((category) => {
    category.pattern.lastIndex = 0;
    return category.pattern.test(name);
  });
  if (matches.length > 1) throw policyError("LABEL_ERROR", "a label matches multiple Policy categories");
  return matches[0]?.id ?? null;
}

function freezePlan(value: MergeRequestWritePlan): MergeRequestWritePlan {
  Object.freeze(value.managedLabelIds);
  Object.freeze(value.preservedLabelIds);
  return Object.freeze(value);
}

function assertCanonicalRequest(value: Request): Request {
  const copied = copyJsonValue(value);
  const normalized = normalizeAndValidateRequest(copied);
  if (canonicalizeJson(copied) !== canonicalizeJson(normalized)) {
    throw policyError("INPUT_ERROR", "the Request is not normalized canonical input");
  }
  return normalized;
}

function validateSelections(
  request: Request,
  snapshot: ExternalContextSnapshot,
  candidates: readonly Candidate[],
  policy: PolicyContract,
): {
  readonly selectedLabelIds: readonly string[];
  readonly assigneeUserId: string | null;
  readonly reviewerUserIds: readonly string[];
} {
  const labels = candidates.filter((candidate): candidate is LabelCandidate => candidate.kind === "label");
  const assignees = candidates.filter((candidate): candidate is UserCandidate => candidate.kind === "assignee");
  const reviewers = candidates.filter((candidate): candidate is UserCandidate => candidate.kind === "reviewer");
  if (labels.length !== request.mergeRequest.labelCandidateTokens.length ||
      reviewers.length !== request.review.reviewerCandidateTokens.length ||
      assignees.length !== (request.mergeRequest.assigneeCandidateToken === null ? 0 : 1)) {
    throw policyError("INPUT_ERROR", "resolved candidates do not match Request candidate selections");
  }

  const snapshotLabels = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const selectedByCategory = new Map<string, LabelCandidate[]>();
  for (const label of labels) {
    if (snapshotLabels.get(label.globalId) !== label.name) {
      throw policyError("LABEL_ERROR", "a selected label changed after context discovery");
    }
    const category = categoryFor(label.name, policy);
    if (category === null || category === policy.statusCategory || category !== label.policyCategory) {
      throw policyError("LABEL_ERROR", "a selected label is not an eligible user-managed category");
    }
    const values = selectedByCategory.get(category) ?? [];
    values.push(label);
    selectedByCategory.set(category, values);
  }
  for (const category of policy.categories) {
    if (category.id === policy.statusCategory) continue;
    const count = selectedByCategory.get(category.id)?.length ?? 0;
    if ((category.required && count === 0) || count > category.max) {
      throw policyError("LABEL_ERROR", "selected labels violate a Policy category cardinality");
    }
  }
  const selectedType = selectedByCategory.get("type")?.[0];
  const compatibility = policy.typeCompatibility[request.title.type];
  if (selectedType === undefined || compatibility === undefined) {
    throw policyError("LABEL_ERROR", "the title type has no selected compatible type label");
  }
  compatibility.lastIndex = 0;
  if (!compatibility.test(selectedType.name)) {
    throw policyError("LABEL_ERROR", "the selected type label is incompatible with the title type");
  }

  const snapshotUsers = new Map(snapshot.userCandidates.map((user) => [user.id, user] as const));
  for (const candidate of [...assignees, ...reviewers]) {
    const current = snapshotUsers.get(candidate.userId);
    if (current === undefined || current.username !== candidate.username || current.displayName !== candidate.displayName) {
      throw policyError("INPUT_ERROR", "a selected user changed after context discovery");
    }
  }
  const reviewerIds = reviewers.map((reviewer) => reviewer.userId).sort();
  if (new Set(reviewerIds).size !== reviewerIds.length || reviewerIds.includes(snapshot.mergeRequest.authorUserId)) {
    throw policyError("INPUT_ERROR", "reviewer selection contains duplicates or the MR author");
  }
  const minimum = request.intent === "draft"
    ? policy.draftMinimumReviewers
    : request.risk.level === "high"
      ? Math.max(policy.readyMinimumReviewers, policy.highRiskMinimumReviewers)
      : policy.readyMinimumReviewers;
  const qualified = snapshot.review.qualifiedReviewerUserIds;
  if (reviewerIds.length < minimum ||
      (minimum > 0 && (qualified === null || reviewerIds.filter((id) => qualified.includes(id)).length < minimum))) {
    throw policyError("INPUT_ERROR", "reviewer selection does not satisfy the current Policy minimum");
  }
  return {
    selectedLabelIds: Object.freeze(labels.map((label) => label.globalId).sort()),
    assigneeUserId: assignees[0]?.userId ?? null,
    reviewerUserIds: Object.freeze(reviewerIds),
  };
}

function exactLifecycleLabel(
  snapshot: ExternalContextSnapshot,
  policy: PolicyContract,
  name: string,
): string {
  const matches = snapshot.labelCandidates.filter((label) =>
    label.name === name && categoryFor(label.name, policy) === policy.statusCategory);
  if (matches.length !== 1) throw policyError("LABEL_ERROR", "a lifecycle label cannot be resolved exactly");
  return (matches[0] as { readonly id: string }).id;
}

export function buildWritePlan(input: BuildWritePlanInputs): MergeRequestWritePlan {
  try {
    validateTemplateBundle(input.bundle);
    const request = assertCanonicalRequest(input.request);
    composeProfiles(input.bundle, request.profileIds, { impactNature: request.impact.nature });
    const snapshot = validateExternalContextSnapshot(input.snapshot);
    const policy = readPolicy(input.bundle);
    const selected = validateSelections(request, snapshot, input.resolvedCandidates, policy);
    const draftStatusLabelId = exactLifecycleLabel(snapshot, policy, policy.draftName);
    const readyStatusLabelId = exactLifecycleLabel(snapshot, policy, policy.readyName);
    const managedCategoryIds = new Set(policy.categories.map((category) => category.id));
    const namesById = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
    const preservedLabelIds = snapshot.mergeRequest.labelIds.filter((id) => {
      const name = namesById.get(id);
      return name !== undefined && !managedCategoryIds.has(categoryFor(name, policy) ?? "");
    }).sort();
    const currentManagedLabelIds = snapshot.mergeRequest.labelIds.filter((id) => {
      const name = namesById.get(id);
      return name !== undefined && categoryFor(name, policy) !== null;
    });
    const managedLabelIds = [
      ...selected.selectedLabelIds,
      draftStatusLabelId,
      readyStatusLabelId,
      ...currentManagedLabelIds,
    ]
      .filter((id, index, values) => values.indexOf(id) === index)
      .sort();
    const base = {
      writePlanVersion: 1 as const,
      assigneeUserId: selected.assigneeUserId,
      reviewerUserIds: selected.reviewerUserIds,
      removeSourceBranch: request.mergeRequest.removeSourceBranch,
      squash: request.mergeRequest.squash,
    };
    const readyTitle = renderTitle(request, input.bundle);
    const draftTitle = request.intent === "draft"
      ? readyTitle
      : renderTitle({ ...request, intent: "draft" }, input.bundle);
    const provisional = validateDesiredWritePlan({
      ...base,
      title: draftTitle,
      labelIds: [],
      assigneeUserId: null,
      reviewerUserIds: [],
    });
    const draft = validateDesiredWritePlan({
      ...base,
      title: draftTitle,
      labelIds: [...selected.selectedLabelIds, draftStatusLabelId, ...preservedLabelIds],
    });
    const desired = request.intent === "ready"
      ? validateDesiredWritePlan({
          ...base,
          title: readyTitle,
          labelIds: [...selected.selectedLabelIds, readyStatusLabelId, ...preservedLabelIds],
        })
      : draft;
    return freezePlan({
      writePlanVersion: 1,
      intent: request.intent,
      provisional,
      draft,
      desired,
      draftStatusLabelId,
      readyStatusLabelId,
      managedLabelIds,
      preservedLabelIds: Object.freeze(preservedLabelIds),
    });
  } catch (error) {
    if (isToolError(error)) throw error;
    throw policyError("POLICY_ERROR", "write plan inputs could not be evaluated safely");
  }
}
