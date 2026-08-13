import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { composeProfiles, type ComposedProfile } from "../bundle/compose.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import type { Request, VerificationItem } from "../contracts/request.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import {
  appendDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type CheckboxState,
  type DesiredWritePlanSnapshot,
  type DiagnosticMarkerInputs,
  type ExternalContextSnapshot,
  type RenderPhase,
  type SnapshotLabel,
  type SnapshotUser,
} from "./marker.ts";
import { renderTitle } from "./title.ts";

export interface RenderDescriptionInputs {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly renderPhase: RenderPhase;
}

export interface DerivedCheckboxState {
  readonly state: "checked" | "pending" | "not-applicable";
  readonly reason: string | null;
}

export type ReviewStateMap = Readonly<Record<string, DerivedCheckboxState>>;

interface CheckboxEntry {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly sectionSlot: string;
  readonly order: number;
  readonly applicableProfiles: readonly string[];
}

interface FieldEntry {
  readonly id: string;
  readonly h3: string;
  readonly sectionSlot: string;
  readonly order: number;
}

interface PreparedInputs {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
  readonly bundle: LoadedTemplateBundle;
  readonly composition: ComposedProfile;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly renderPhase: RenderPhase;
}

const RENDER_INPUT_FIELDS = new Set([
  "request", "snapshot", "writePlan", "bundle", "releaseTag", "cliVersion", "renderPhase",
]);
const REVIEW_IDS = [
  "source-branch-synced",
  "commit-convention",
  "work-item-reviewed",
  "metadata-reviewed",
  "secret-scan-reviewed",
  "repository-hygiene-reviewed",
  "ci-status",
  "reviewer-requested",
  "high-risk-reviewers",
  "blocking-issues",
] as const;
const MARKER_INJECTION = /<!--\s*harness-mrtool:v1\b/iu;

function renderError(reason: string): ToolError<"RENDER_ERROR"> {
  return new ToolError("RENDER_ERROR", `Merge request description rendering failed: ${reason}`, {
    field: "description",
    expected: "canonical renderer inputs producing the fixed eight-section layout",
    actual: reason,
    safeNextStep: "Refresh the context and render again from a normalized request and verified Bundle.",
  });
}

function asObject(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw renderError(`${subject} must be an object`);
  }
  return value;
}

function exactFields(value: JsonObject, expected: ReadonlySet<string>, subject: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw renderError(`${subject} has missing or unknown fields`);
  }
}

function canonicalString(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u2028\u2029]/u.test(value)) {
    throw renderError(`${subject} must be a canonical non-empty string`);
  }
  return value;
}

function safeText(value: string): string {
  if (MARKER_INJECTION.test(value)) {
    throw renderError("content contains the reserved diagnostic marker prefix");
  }
  if (/(?:^|\n) {0,3}##(?:\s|$)/u.test(value)) {
    throw renderError("content attempts to introduce an H2 heading");
  }
  if (/\p{Cc}/u.test(value.replace(/[\t\n]/gu, ""))) {
    throw renderError("content contains an unsupported control character");
  }
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/[\\*_\[\]`(){}|#!:@~\t\n]/gu, (character) =>
      `&#${String(character.codePointAt(0))};`)
    .replace(/\bwww\./giu, "www&#46;");
}

function renderList(values: readonly string[]): string {
  return values.length === 0 ? "None." : values.map((value) => `- ${safeText(value)}`).join("\n");
}

function checkboxEntries(bundle: LoadedTemplateBundle): readonly CheckboxEntry[] {
  const registry = asObject(bundle.registries.checkboxes, "checkbox registry");
  if (!Array.isArray(registry.checkboxes)) {
    throw renderError("checkbox registry entries are missing");
  }
  return registry.checkboxes.map((value) => {
    const entry = asObject(value, "checkbox registry entry");
    if (typeof entry.id !== "string" || typeof entry.label !== "string" ||
        typeof entry.kind !== "string" || typeof entry.sectionSlot !== "string" ||
        !Number.isSafeInteger(entry.order) || !Array.isArray(entry.applicableProfiles) ||
        entry.applicableProfiles.some((profile) => typeof profile !== "string")) {
      throw renderError("checkbox registry entry is invalid");
    }
    return {
      id: entry.id,
      label: entry.label,
      kind: entry.kind,
      sectionSlot: entry.sectionSlot,
      order: entry.order as number,
      applicableProfiles: entry.applicableProfiles as string[],
    };
  }).sort((left, right) => left.order - right.order);
}

function fieldEntries(bundle: LoadedTemplateBundle): readonly FieldEntry[] {
  const registry = asObject(bundle.registries.fields, "field registry");
  if (!Array.isArray(registry.fields)) {
    throw renderError("field registry entries are missing");
  }
  return registry.fields.map((value) => {
    const entry = asObject(value, "field registry entry");
    if (typeof entry.id !== "string" || typeof entry.h3 !== "string" ||
        typeof entry.sectionSlot !== "string" || !Number.isSafeInteger(entry.order)) {
      throw renderError("field registry entry is invalid");
    }
    return {
      id: entry.id,
      h3: entry.h3,
      sectionSlot: entry.sectionSlot,
      order: entry.order as number,
    };
  }).sort((left, right) => left.order - right.order);
}

function candidateById<T extends { readonly id: string }>(
  candidates: readonly T[],
  id: string,
  subject: string,
): T {
  const candidate = candidates.find((value) => value.id === id);
  if (candidate === undefined) {
    throw renderError(`${subject} stable ID is absent from the external snapshot`);
  }
  return candidate;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameStableIdSet(left: readonly string[], right: readonly string[]): boolean {
  return sameArray([...left].sort(), [...right].sort());
}

function policyReview(bundle: LoadedTemplateBundle): {
  readonly draftMinimumReviewers: number;
  readonly readyMinimumReviewers: number;
  readonly highRiskMinimumReviewers: number;
} {
  const review = asObject(asObject(bundle.policy, "policy").review, "review policy");
  for (const field of ["draftMinimumReviewers", "readyMinimumReviewers", "highRiskMinimumReviewers"] as const) {
    if (!Number.isSafeInteger(review[field]) || (review[field] as number) < 0) {
      throw renderError("review policy is invalid");
    }
  }
  return review as unknown as {
    draftMinimumReviewers: number;
    readyMinimumReviewers: number;
    highRiskMinimumReviewers: number;
  };
}

function assertLabelPolicy(inputs: PreparedInputs, labels: readonly SnapshotLabel[]): void {
  const labelPolicy = asObject(asObject(inputs.bundle.policy, "policy").labels, "label policy");
  const categories = asObject(labelPolicy.categories, "label categories");
  for (const categoryId of Object.keys(categories).sort()) {
    const category = asObject(categories[categoryId], `label category ${categoryId}`);
    const expression = canonicalString(category.match, `label category ${categoryId} match`);
    const matches = labels.filter((candidate) => new RegExp(expression, "u").test(candidate.name));
    if (category.required === true && matches.length !== 1) {
      throw renderError(`write plan does not select exactly one ${categoryId} label`);
    }
    if (!Number.isSafeInteger(category.max) || matches.length > (category.max as number)) {
      throw renderError(`write plan exceeds the ${categoryId} label cardinality`);
    }
  }
  const lifecycle = asObject(labelPolicy.lifecycle, "label lifecycle");
  const expectedNames = asObject(lifecycle.expectedNames, "label lifecycle names");
  const expectedStatus = inputs.request.intent === "draft" ? expectedNames.draft : expectedNames.ready;
  if (typeof expectedStatus !== "string" || !labels.some((candidate) => candidate.name === expectedStatus)) {
    throw renderError("write plan lifecycle label does not match the request intent");
  }
  const title = asObject(asObject(inputs.bundle.policy, "policy").title, "title policy");
  const compatibility = asObject(title.typeLabelCompatibility, "title compatibility policy");
  const compatibleExpression = compatibility[inputs.request.title.type];
  if (typeof compatibleExpression !== "string" ||
      !labels.some((candidate) => new RegExp(compatibleExpression, "u").test(candidate.name))) {
    throw renderError("write plan type label does not match the title type");
  }
}

function labelsInPolicyOrder(
  bundle: LoadedTemplateBundle,
  labels: readonly SnapshotLabel[],
): readonly SnapshotLabel[] {
  const categories = asObject(
    asObject(asObject(bundle.policy, "policy").labels, "label policy").categories,
    "label categories",
  );
  const categoryOrder = Object.entries(categories).map(([id, value]) => ({
    id,
    match: canonicalString(asObject(value, `label category ${id}`).match, `label category ${id} match`),
  }));
  return [...labels].sort((left, right) => {
    const leftIndex = categoryOrder.findIndex(({ match }) => new RegExp(match, "u").test(left.name));
    const rightIndex = categoryOrder.findIndex(({ match }) => new RegExp(match, "u").test(right.name));
    return leftIndex - rightIndex || compareStableId(left.id, right.id);
  });
}

function assertWritePlan(inputs: PreparedInputs): {
  readonly labels: readonly SnapshotLabel[];
  readonly assignee: SnapshotUser | null;
  readonly reviewers: readonly SnapshotUser[];
} {
  if (inputs.writePlan.title !== renderTitle(inputs.request, inputs.bundle) ||
      inputs.writePlan.removeSourceBranch !== inputs.request.mergeRequest.removeSourceBranch ||
      inputs.writePlan.squash !== inputs.request.mergeRequest.squash) {
    throw renderError("write plan does not match the normalized request");
  }
  const labels = inputs.writePlan.labelIds.map((id) =>
    candidateById(inputs.snapshot.labelCandidates, id, "label candidate"));
  assertLabelPolicy(inputs, labels);

  const assignee = inputs.writePlan.assigneeUserId === null
    ? null
    : candidateById(
      inputs.snapshot.userCandidates,
      inputs.writePlan.assigneeUserId,
      "assignee candidate",
    );
  const reviewers = inputs.writePlan.reviewerUserIds.map((id) =>
    candidateById(inputs.snapshot.userCandidates, id, "reviewer candidate"));
  if (reviewers.some((reviewer) => reviewer.id === inputs.snapshot.mergeRequest.authorUserId)) {
    throw renderError("a merge request author cannot be selected as a reviewer");
  }

  if (inputs.renderPhase === "final") {
    const current = inputs.snapshot.mergeRequest;
    if (current.lifecycle !== inputs.request.intent ||
        !sameStableIdSet(current.labelIds, inputs.writePlan.labelIds) ||
        current.assigneeUserId !== inputs.writePlan.assigneeUserId ||
        !sameStableIdSet(current.reviewerUserIds, inputs.writePlan.reviewerUserIds)) {
      throw renderError("final snapshot does not match the desired write plan");
    }
  }
  return { labels: labelsInPolicyOrder(inputs.bundle, labels), assignee, reviewers };
}

function frozenReviewStates(value: Record<string, DerivedCheckboxState>): ReviewStateMap {
  for (const state of Object.values(value)) {
    Object.freeze(state);
  }
  return Object.freeze(value);
}

export function deriveReviewStates(
  request: Request,
  snapshot: ExternalContextSnapshot,
  bundle: LoadedTemplateBundle,
): ReviewStateMap {
  const policy = policyReview(bundle);
  const qualified = snapshot.review.qualifiedReviewerUserIds === null
    ? null
    : new Set(snapshot.review.qualifiedReviewerUserIds);
  const qualifiedRequested = qualified === null
    ? null
    : snapshot.mergeRequest.reviewerUserIds.filter((id) => qualified.has(id)).length;
  const minimumReviewers = request.intent === "draft"
    ? policy.draftMinimumReviewers
    : policy.readyMinimumReviewers;
  if ((request.workItem.relation === "none" && snapshot.issue.kind !== "none") ||
      (request.workItem.relation !== "none" &&
        (snapshot.issue.kind !== "linked" || snapshot.issue.iid !== request.workItem.iid))) {
    throw renderError("work item Request and external Issue snapshot do not match");
  }
  const workItemState: DerivedCheckboxState = request.workItem.relation === "none" ||
      (snapshot.issue.kind === "linked" && snapshot.issue.readStatus === "available")
    ? { state: "checked", reason: null }
    : { state: "pending", reason: "The linked Issue snapshot is unavailable." };
  const existingMr = snapshot.mergeRequest.iid !== null && snapshot.mergeRequest.lifecycle !== "new";
  const metadataState: DerivedCheckboxState = existingMr && snapshot.metadataRead.status === "available" &&
      (request.workItem.relation === "none" || (snapshot.issue.kind === "linked" && snapshot.issue.readStatus === "available"))
    ? { state: "checked", reason: null }
    : { state: "pending", reason: snapshot.metadataRead.evidence };
  const ciReason: Readonly<Record<ExternalContextSnapshot["ci"]["status"], string>> = {
    unavailable: "The target project pipeline status is unavailable.",
    pending: "The target project pipeline is still pending.",
    running: "The target project pipeline is running.",
    passed: "The target project pipeline passed.",
    failed: "The target project pipeline failed.",
    canceled: "The target project pipeline was canceled.",
    skipped: "The target project pipeline was skipped.",
  };
  const states: Record<string, DerivedCheckboxState> = {
    "source-branch-synced": snapshot.mergeBaseSha === snapshot.targetRefSha
      ? { state: "checked", reason: null }
      : { state: "pending", reason: "The source branch does not contain the recorded target ref." },
    "commit-convention": snapshot.localChecks.commitConvention.status === "passed"
      ? { state: "checked", reason: null }
      : { state: "pending", reason: "The configured commit convention check has not passed." },
    "work-item-reviewed": workItemState,
    "metadata-reviewed": metadataState,
    "secret-scan-reviewed": snapshot.localChecks.secretScan.status === "passed"
      ? { state: "checked", reason: null }
      : { state: "pending", reason: "Secret scan is not configured for this repository." },
    "repository-hygiene-reviewed": snapshot.localChecks.repositoryHygiene.status === "passed"
      ? { state: "checked", reason: null }
      : { state: "pending", reason: "Repository hygiene checks have not passed." },
    "ci-status": snapshot.ci.status === "passed"
      ? { state: "checked", reason: null }
      : { state: "pending", reason: ciReason[snapshot.ci.status] },
    "reviewer-requested": minimumReviewers === 0
      ? { state: "not-applicable", reason: "The current lifecycle does not require a reviewer." }
      : qualifiedRequested === null
        ? { state: "pending", reason: "Qualified reviewer information is unavailable." }
        : qualifiedRequested >= minimumReviewers
          ? { state: "checked", reason: null }
          : { state: "pending", reason: `Only ${String(qualifiedRequested)} of ${String(minimumReviewers)} required qualified reviewers are requested.` },
    "high-risk-reviewers": request.risk.level !== "high"
      ? { state: "not-applicable", reason: "Risk level is not high." }
      : qualifiedRequested === null
        ? { state: "pending", reason: "Qualified reviewer information is unavailable." }
        : qualifiedRequested >= policy.highRiskMinimumReviewers
        ? { state: "checked", reason: null }
        : { state: "pending", reason: `Only ${String(qualifiedRequested)} of ${String(policy.highRiskMinimumReviewers)} required high-risk reviewers are requested.` },
    "blocking-issues": snapshot.review.unresolvedDiscussions === 0
      ? { state: "checked", reason: null }
      : snapshot.review.unresolvedDiscussions === null
        ? { state: "pending", reason: "The unresolved discussion count is unavailable." }
        : { state: "pending", reason: `${String(snapshot.review.unresolvedDiscussions)} unresolved discussions remain.` },
  };
  if (Object.keys(states).length !== REVIEW_IDS.length || REVIEW_IDS.some((id) => states[id] === undefined)) {
    throw renderError("the derived Review / CI state map is incomplete");
  }
  return frozenReviewStates(states);
}

function prepareInputs(value: RenderDescriptionInputs | unknown): PreparedInputs {
  const input = asObject(copyJsonValue(value), "renderer input");
  exactFields(input, RENDER_INPUT_FIELDS, "renderer input");
  const bundle = input.bundle as unknown as LoadedTemplateBundle;
  validateTemplateBundle(bundle);
  const requestSnapshot = copyJsonValue(input.request);
  const request = normalizeAndValidateRequest(requestSnapshot);
  if (canonicalizeJson(requestSnapshot) !== canonicalizeJson(request)) {
    throw renderError("request is not in normalized canonical form");
  }
  const snapshot = validateExternalContextSnapshot(input.snapshot);
  const writePlan = validateDesiredWritePlan(input.writePlan);
  const releaseTag = canonicalString(input.releaseTag, "releaseTag");
  const cliVersion = canonicalString(input.cliVersion, "cliVersion");
  if (!(["preview", "provisional", "final"] as const).includes(input.renderPhase as RenderPhase)) {
    throw renderError("renderPhase is invalid");
  }
  const composition = composeProfiles(bundle, request.profileIds, { impactNature: request.impact.nature });
  if (!sameArray(composition.profileIds, request.profileIds)) {
    throw renderError("Profile IDs are not in canonical composition order");
  }
  const expectedProfileFields = [...composition.requiredFieldIds];
  if (!sameArray(Object.keys(request.profileFields).sort(), [...expectedProfileFields].sort())) {
    throw renderError("profileFields do not exactly match the active Profile registry fields");
  }
  return {
    request,
    snapshot,
    writePlan,
    bundle,
    composition,
    releaseTag,
    cliVersion,
    renderPhase: input.renderPhase as RenderPhase,
  };
}

function checkboxLine(entry: CheckboxEntry, state: CheckboxState, reason?: string | null): string {
  const marker = state === "checked" ? "x" : " ";
  const suffix = state === "pending" && reason !== undefined && reason !== null
    ? ` (Pending: ${safeText(reason)})`
    : state === "not-applicable" && reason !== undefined && reason !== null
      ? ` (Not applicable: ${safeText(reason)})`
      : "";
  return `- [${marker}] ${entry.label}${suffix}`;
}

function renderCategoricalCheckboxes(
  entries: readonly CheckboxEntry[],
  slot: string,
  selectedIds: ReadonlySet<string>,
): string {
  return entries.filter((entry) => entry.sectionSlot === slot).map((entry) => {
    return selectedIds.has(entry.id)
      ? checkboxLine(entry, "checked")
      : `- [ ] ${entry.label}`;
  }).join("\n");
}

function verificationMethod(item: VerificationItem): { readonly method: string; readonly result: string } {
  if (item.state === "pending") {
    return { method: "Not run", result: "Pending" };
  }
  if (item.state === "not-applicable") {
    return { method: "Not applicable", result: "Not applicable" };
  }
  if (item.evidenceKind === "command-output") {
    return { method: item.command, result: item.result };
  }
  return {
    method: item.evidenceKind === "file-inspection" ? "File inspection" : "Manual verification",
    result: item.result,
  };
}

function renderVerification(
  inputs: PreparedInputs,
  entries: readonly CheckboxEntry[],
  stateMap: Record<string, CheckboxState>,
): { readonly checkboxes: string; readonly rows: string } {
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const itemById = new Map(inputs.request.verification.items.map((item) => [item.id, item]));
  const expectedIds = inputs.composition.profileIds[0] === "general"
    ? entries.filter((entry) => entry.kind === "evidence-state" &&
        entry.applicableProfiles.includes("general") && itemById.has(entry.id)).map((entry) => entry.id)
    : [...inputs.composition.requiredCheckboxIds];
  if (expectedIds.length === 0 || !sameArray([...itemById.keys()].sort(), [...expectedIds].sort())) {
    throw renderError("verification evidence IDs do not exactly match the composed Profile contract");
  }
  const orderedItems = entries
    .filter((entry) => expectedIds.includes(entry.id))
    .map((entry) => ({ entry, item: itemById.get(entry.id) as VerificationItem }));
  return {
    checkboxes: orderedItems.map(({ entry, item }) => {
      stateMap[entry.id] = item.state;
      return checkboxLine(entry, item.state);
    }).join("\n"),
    rows: orderedItems.length === 0
      ? "| None | Not applicable | Not run | No evidence |"
      : orderedItems.map(({ entry, item }) => {
        const { method, result } = verificationMethod(item);
        return `| ${entry.label} | ${safeText(method)} | ${safeText(result)} | ${safeText(item.evidence)} |`;
      }).join("\n"),
  };
}

function renderProfileSlots(
  inputs: PreparedInputs,
  fields: readonly FieldEntry[],
): Readonly<Record<string, string>> {
  const slots: Record<string, string[]> = {
    changes: [], motivation: [], impact: [], documentation: [], risk: [],
  };
  for (const field of fields.filter((entry) => inputs.composition.requiredFieldIds.includes(entry.id))) {
    const values = inputs.request.profileFields[field.id];
    if (values === undefined || values.length === 0 || slots[field.sectionSlot] === undefined) {
      throw renderError("an active Profile field is missing or has an invalid section slot");
    }
    slots[field.sectionSlot]?.push(`### ${field.h3}\n\n${renderList(values)}`);
  }
  return Object.fromEntries(Object.entries(slots).map(([slot, values]) => [slot, values.join("\n\n")]));
}

function renderIssue(inputs: PreparedInputs, labels: readonly SnapshotLabel[]): {
  readonly relationLines: string;
  readonly milestone: string;
  readonly assignees: string;
  readonly dueDate: string;
  readonly issueLabels: string;
  readonly mergeRequestLabels: string;
} {
  const mergeRequestLabels = labels.length === 0
    ? "None."
    : labels.map((label) => safeText(label.name)).join(", ");
  if (inputs.request.workItem.relation === "none") {
    if (inputs.snapshot.issue.kind !== "none") {
      throw renderError("work item Request and external Issue snapshot do not match");
    }
    return {
      relationLines: `- Relation: None\n- Reason: ${safeText(inputs.request.workItem.noIssueReason)}`,
      milestone: "Not applicable",
      assignees: "Not applicable",
      dueDate: "Not applicable",
      issueLabels: "Not applicable",
      mergeRequestLabels,
    };
  }
  if (inputs.snapshot.issue.kind !== "linked" ||
      inputs.snapshot.issue.iid !== inputs.request.workItem.iid) {
    throw renderError("linked work item does not match the external Issue snapshot");
  }
  const verb = inputs.request.workItem.relation === "closes" ? "Closes" : "Related";
  if (inputs.snapshot.issue.readStatus === "unavailable") {
    return {
      relationLines: `${verb} #${String(inputs.request.workItem.iid)}\n- Reason: Not applicable`,
      milestone: "Unavailable",
      assignees: "Unavailable",
      dueDate: "Unavailable",
      issueLabels: "Unavailable",
      mergeRequestLabels,
    };
  }
  return {
    relationLines: `${verb} #${String(inputs.request.workItem.iid)}\n- Reason: Not applicable`,
    milestone: inputs.snapshot.issue.milestone === null ? "None." : safeText(inputs.snapshot.issue.milestone),
    assignees: inputs.snapshot.issue.assignees.length === 0
      ? "None."
      : inputs.snapshot.issue.assignees.map((user) =>
        `${safeText(user.displayName)} (username: ${safeText(user.username)})`).join(", "),
    dueDate: inputs.snapshot.issue.dueDate === null ? "None." : safeText(inputs.snapshot.issue.dueDate),
    issueLabels: inputs.snapshot.issue.labels.length === 0
      ? "None."
      : inputs.snapshot.issue.labels.map((label) => safeText(label.name)).join(", "),
    mergeRequestLabels,
  };
}

function replaceLayout(layout: string, replacements: Readonly<Record<string, string>>): string {
  let rendered = layout;
  for (const [placeholder, value] of Object.entries(replacements)) {
    const token = `{{${placeholder}}}`;
    if (!rendered.includes(token)) {
      throw renderError(`layout is missing placeholder ${placeholder}`);
    }
    rendered = rendered.replace(token, value);
  }
  if (/\{\{[^{}]+\}\}/u.test(rendered)) {
    throw renderError("layout contains an unresolved placeholder");
  }
  return `${rendered.replace(/\r\n?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

function buildStateMap(
  entries: readonly CheckboxEntry[],
  categoricalAndEvidence: Readonly<Record<string, CheckboxState>>,
  review: ReviewStateMap,
): Readonly<Record<string, CheckboxState>> {
  const complete: Record<string, CheckboxState> = {};
  for (const entry of entries) {
    const state = categoricalAndEvidence[entry.id] ?? review[entry.id]?.state;
    if (state !== undefined) {
      complete[entry.id] = state;
    }
  }
  return Object.freeze(complete);
}

function renderPrepared(inputs: PreparedInputs): string {
  const entries = checkboxEntries(inputs.bundle);
  const fields = fieldEntries(inputs.bundle);
  const selected = assertWritePlan(inputs);
  const reviewStates = deriveReviewStates(inputs.request, inputs.snapshot, inputs.bundle);
  const stateMap: Record<string, CheckboxState> = {};
  const impact = [
    renderCategoricalCheckboxes(entries, "impact.area", new Set(inputs.request.impact.areaIds)),
    renderCategoricalCheckboxes(entries, "impact.nature", new Set([inputs.request.impact.nature])),
  ].join("\n");
  const documentation = renderCategoricalCheckboxes(
    entries,
    "documentation",
    new Set(inputs.request.documentation.itemIds),
  );
  const risk = renderCategoricalCheckboxes(
    entries,
    "risk.level",
    new Set([inputs.request.risk.level]),
  );
  const verification = renderVerification(inputs, entries, stateMap);
  const review = entries.filter((entry) => entry.sectionSlot === "review").map((entry) => {
    const derived = reviewStates[entry.id];
    if (derived === undefined) {
      throw renderError("Review / CI registry and derived state map do not match");
    }
    return checkboxLine(entry, derived.state, derived.reason);
  }).join("\n");
  const issue = renderIssue(inputs, selected.labels);
  const profileSlots = renderProfileSlots(inputs, fields);
  const body = replaceLayout(inputs.bundle.layout.markdown, {
    "changes.summary": renderList(inputs.request.changes.summary),
    "changes.technicalChanges": renderList(inputs.request.changes.technicalChanges),
    "changes.outOfScope": renderList(inputs.request.changes.outOfScope),
    "profileFields.changes": profileSlots.changes ?? "",
    "motivation.background": renderList(inputs.request.motivation.background),
    "motivation.whyNeeded": renderList(inputs.request.motivation.whyNeeded),
    "profileFields.motivation": profileSlots.motivation ?? "",
    "workItem.canonicalRelationLines": issue.relationLines,
    "issueSnapshot.milestone": issue.milestone,
    "issueSnapshot.assignees": issue.assignees,
    "issueSnapshot.dueDate": issue.dueDate,
    "issueSnapshot.labels": issue.issueLabels,
    "mergeRequest.labels": issue.mergeRequestLabels,
    "impact.checkboxes": impact,
    "impact.details": renderList(inputs.request.impact.details),
    "profileFields.impact": profileSlots.impact ?? "",
    "verification.checkboxes": verification.checkboxes,
    "verification.rows": verification.rows,
    "verification.acceptanceEvidence": renderList(inputs.request.verification.acceptanceEvidence),
    "verification.knownGaps": renderList(inputs.request.verification.knownGaps),
    "documentation.checkboxes": documentation,
    "documentation.details": renderList(inputs.request.documentation.details),
    "profileFields.documentation": profileSlots.documentation ?? "",
    "risk.levelCheckboxes": risk,
    "risk.items": renderList(inputs.request.risk.items),
    "risk.compatibilityImpact": renderList(inputs.request.risk.compatibilityImpact),
    "risk.rollbackPlan": renderList(inputs.request.risk.rollbackPlan),
    "profileFields.risk": profileSlots.risk ?? "",
    "review.checkboxes": review,
    "review.reviewerFocus": renderList(inputs.request.review.reviewerFocus),
    "review.additionalNotes": renderList(inputs.request.review.additionalNotes),
    diagnosticMarker: "",
  });
  const markerInputs: DiagnosticMarkerInputs = {
    releaseTag: inputs.releaseTag,
    bundleId: inputs.bundle.manifest.bundleId,
    bundleVersion: inputs.bundle.manifest.version,
    bundleManifestHash: sha256Utf8(`${canonicalizeJson(inputs.bundle.manifest)}\n`),
    profileIds: inputs.composition.profileIds,
    policySchema: inputs.bundle.manifest.policySchema,
    cliVersion: inputs.cliVersion,
    renderPhase: inputs.renderPhase,
    stateMap: buildStateMap(entries, stateMap, reviewStates),
    request: inputs.request,
    snapshot: inputs.snapshot,
    writePlan: inputs.writePlan,
  };
  return appendDiagnosticMarker(body, markerInputs);
}

export function renderDescription(inputs: RenderDescriptionInputs | unknown): string {
  try {
    return renderPrepared(prepareInputs(inputs));
  } catch (error) {
    if (isToolError(error, "RENDER_ERROR")) {
      throw error;
    }
    throw renderError("renderer inputs or Bundle data are invalid");
  }
}
