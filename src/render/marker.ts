import { ToolError } from "../contracts/errors.ts";
import type { Request } from "../contracts/request.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";

export type RenderPhase = "preview" | "provisional" | "final";
export type CheckboxState = "checked" | "pending" | "not-applicable";
export type DerivedStateMap = Readonly<Record<string, CheckboxState>>;

export interface SnapshotLabel {
  readonly id: string;
  readonly name: string;
}

export interface SnapshotUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
}

export type LocalObservationStatus = "passed" | "failed" | "not-run" | "unavailable";

export interface LocalObservation {
  readonly status: LocalObservationStatus;
  readonly evidence: string;
}

export type IssueContextSnapshot =
  | { readonly kind: "none" }
  | {
      readonly kind: "linked";
      readonly iid: number;
      readonly readStatus: "unavailable";
    }
  | {
      readonly kind: "linked";
      readonly iid: number;
      readonly readStatus: "available";
      readonly milestone: string | null;
      readonly assignees: readonly SnapshotUser[];
      readonly dueDate: string | null;
      readonly labels: readonly SnapshotLabel[];
    };

export interface ExternalContextSnapshot {
  readonly snapshotVersion: 1;
  readonly targetProject: { readonly id: string; readonly path: string };
  readonly sourceProject: { readonly id: string; readonly path: string };
  readonly targetRefSha: string;
  readonly mergeBaseSha: string;
  readonly sourceHeadSha: string;
  readonly issue: IssueContextSnapshot;
  readonly labelCandidates: readonly SnapshotLabel[];
  readonly userCandidates: readonly SnapshotUser[];
  readonly mergeRequest: {
    readonly iid: number | null;
    readonly authorUserId: string;
    readonly lifecycle: "new" | "draft" | "ready" | "closed" | "merged";
    readonly labelIds: readonly string[];
    readonly assigneeUserId: string | null;
    readonly reviewerUserIds: readonly string[];
  };
  readonly localChecks: {
    readonly commitConvention: LocalObservation;
    readonly secretScan: LocalObservation;
    readonly repositoryHygiene: LocalObservation;
  };
  readonly metadataRead: {
    readonly status: "available" | "unavailable";
    readonly evidence: string;
  };
  readonly ci: {
    readonly status: "unavailable" | "pending" | "running" | "passed" | "failed" | "canceled" | "skipped";
  };
  readonly review: {
    readonly approvedByUserIds: readonly string[];
    readonly qualifiedReviewerUserIds: readonly string[] | null;
    readonly unresolvedDiscussions: number | null;
  };
}

export interface DesiredWritePlanSnapshot {
  readonly writePlanVersion: 1;
  readonly title: string;
  readonly labelIds: readonly string[];
  readonly assigneeUserId: string | null;
  readonly reviewerUserIds: readonly string[];
  readonly removeSourceBranch: boolean;
  readonly squash: boolean;
}

export interface DiagnosticMarkerInputs {
  readonly releaseTag: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleManifestHash: string;
  readonly profileIds: readonly string[];
  readonly policySchema: number;
  readonly cliVersion: string;
  readonly renderPhase: RenderPhase;
  readonly stateMap: DerivedStateMap;
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
}

export interface DiagnosticMarkerMetadata {
  readonly releaseTag: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleManifestHash: string;
  readonly profileIds: readonly string[];
  readonly policySchema: number;
  readonly cliVersion: string;
  readonly renderPhase: RenderPhase;
  readonly stateMap: DerivedStateMap;
  readonly requestDigest: string;
  readonly snapshotDigest: string;
  readonly writePlanDigest: string;
  readonly bodyDigest: string;
}

const MARKER_PREFIX = "<!-- harness-mrtool:v1 ";
const MARKER_PATTERN = /<!-- harness-mrtool:v1 ([A-Za-z0-9_-]+) -->\n$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const METADATA_FIELDS = new Set([
  "releaseTag", "bundleId", "bundleVersion", "bundleManifestHash", "profileIds",
  "policySchema", "cliVersion", "renderPhase", "stateMap", "requestDigest",
  "snapshotDigest", "writePlanDigest", "bodyDigest",
]);
const MARKER_INPUT_FIELDS = new Set([
  "releaseTag", "bundleId", "bundleVersion", "bundleManifestHash", "profileIds",
  "policySchema", "cliVersion", "renderPhase", "stateMap", "request", "snapshot", "writePlan",
]);
const REVIEW_STATE_IDS = new Set([
  "source-branch-synced", "commit-convention", "work-item-reviewed",
  "metadata-reviewed", "secret-scan-reviewed", "repository-hygiene-reviewed",
  "ci-status", "reviewer-requested", "high-risk-reviewers", "blocking-issues",
]);
const VERIFICATION_STATE_IDS = new Set([
  "local-build", "unit-tests", "integration-tests", "core-behavior",
  "docs-links-format", "deployment-pipeline",
]);
const COMPOSABLE_PROFILE_ORDER = ["code", "docs", "ops"] as const;

function renderError(reason: string): ToolError<"RENDER_ERROR"> {
  return new ToolError("RENDER_ERROR", `Diagnostic marker validation failed: ${reason}`, {
    field: "diagnosticMarker",
    expected: "one canonical harness-mrtool:v1 marker with verified digests",
    actual: reason,
    safeNextStep: "Regenerate the description from verified canonical renderer inputs.",
  });
}

function normalizeLfWithFinalLf(value: string): string {
  return `${value.replace(/\r\n?/gu, "\n").replace(/\n*$/u, "")}\n`;
}

function exactFields(value: JsonObject, expected: ReadonlySet<string>, subject: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw renderError(`${subject} has missing or unknown fields`);
  }
}

function asRecord(value: JsonValue, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw renderError(`${subject} must be an object`);
  }
  return value;
}

function nonEmpty(value: JsonValue | undefined, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u2028\u2029]/u.test(value)) {
    throw renderError(`${subject} must be a canonical non-empty string`);
  }
  return value;
}

function stringArray(value: JsonValue | undefined, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw renderError(`${subject} must be a string array`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length || strings.some((entry) => nonEmpty(entry, subject) !== entry)) {
    throw renderError(`${subject} must contain unique canonical strings`);
  }
  return strings;
}

function sortedStringArray(value: JsonValue | undefined, subject: string): readonly string[] {
  const values = stringArray(value, subject);
  if (values.some((entry, index) => index > 0 && compareStableId(values[index - 1] as string, entry) >= 0)) {
    throw renderError(`${subject} must be sorted by stable ID`);
  }
  return values;
}

function compareStableId(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalProfileIds(
  profileIds: readonly string[],
  requestProfileIds?: readonly string[],
): void {
  const canonical = profileIds.length === 1 && profileIds[0] === "general"
    ? ["general"]
    : COMPOSABLE_PROFILE_ORDER.filter((id) => profileIds.includes(id));
  if (profileIds.length === 0 || profileIds.length !== canonical.length ||
      profileIds.some((id, index) => id !== canonical[index])) {
    throw renderError("Profile IDs are not a canonical V1 Profile selection");
  }
  if (requestProfileIds !== undefined &&
      (profileIds.length !== requestProfileIds.length ||
        profileIds.some((id, index) => id !== requestProfileIds[index]))) {
    throw renderError("Profile IDs do not match the normalized Request");
  }
}

function assertSha(value: JsonValue | undefined, subject: string, lengths: readonly number[] = [64]): string {
  if (typeof value !== "string" || !/^[a-f0-9]+$/u.test(value) || !lengths.includes(value.length)) {
    throw renderError(`${subject} must be lowercase hexadecimal`);
  }
  return value;
}

function assertLabel(value: JsonValue, subject: string): void {
  const record = asRecord(value, subject);
  exactFields(record, new Set(["id", "name"]), subject);
  nonEmpty(record.id, `${subject}.id`);
  nonEmpty(record.name, `${subject}.name`);
}

function assertUser(value: JsonValue, subject: string): void {
  const record = asRecord(value, subject);
  exactFields(record, new Set(["id", "username", "displayName"]), subject);
  nonEmpty(record.id, `${subject}.id`);
  nonEmpty(record.username, `${subject}.username`);
  nonEmpty(record.displayName, `${subject}.displayName`);
}

function assertUniqueIds(values: JsonValue | undefined, subject: string, validator: (value: JsonValue, subject: string) => void): void {
  if (!Array.isArray(values)) {
    throw renderError(`${subject} must be an array`);
  }
  const ids = new Set<string>();
  values.forEach((value, index) => {
    validator(value, `${subject}[${String(index)}]`);
    const id = asRecord(value, subject).id as string;
    if (ids.has(id)) {
      throw renderError(`${subject} contains duplicate IDs`);
    }
    ids.add(id);
  });
}

function assertObservation(
  value: JsonValue | undefined,
  subject: string,
  statuses: readonly string[],
): void {
  const observation = asRecord(value as JsonValue, subject);
  exactFields(observation, new Set(["status", "evidence"]), subject);
  if (typeof observation.status !== "string" || !statuses.includes(observation.status)) {
    throw renderError(`${subject}.status is invalid`);
  }
  nonEmpty(observation.evidence, `${subject}.evidence`);
}

function assertProject(value: JsonValue | undefined, subject: string): void {
  const record = asRecord(value as JsonValue, subject);
  exactFields(record, new Set(["id", "path"]), subject);
  nonEmpty(record.id, `${subject}.id`);
  nonEmpty(record.path, `${subject}.path`);
}

function assertReferences(values: readonly string[], known: ReadonlySet<string>, subject: string): void {
  if (values.some((value) => !known.has(value))) {
    throw renderError(`${subject} contains a dangling stable ID`);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertCanonicalDate(value: JsonValue | undefined, subject: string): void {
  if (value === null) {
    return;
  }
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw renderError(`${subject} must be YYYY-MM-DD or null`);
  }
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw renderError(`${subject} is not a valid calendar date`);
  }
}

function sortObjectArrayById(value: JsonValue | undefined, subject: string): JsonValue[] {
  if (!Array.isArray(value)) {
    throw renderError(`${subject} must be an array`);
  }
  return [...value].sort((left, right) => {
    const leftId = asRecord(left, subject).id;
    const rightId = asRecord(right, subject).id;
    return compareStableId(leftId as string, rightId as string);
  });
}

function canonicalStringArray(value: JsonValue | undefined, subject: string): string[] {
  return [...stringArray(value, subject)].sort(compareStableId);
}

export function validateExternalContextSnapshot(value: unknown): ExternalContextSnapshot {
  const snapshot = asRecord(copyJsonValue(value), "snapshot");
  exactFields(snapshot, new Set([
    "snapshotVersion", "targetProject", "sourceProject", "targetRefSha", "mergeBaseSha",
    "sourceHeadSha", "issue", "labelCandidates", "userCandidates", "mergeRequest", "localChecks",
    "metadataRead", "ci", "review",
  ]), "snapshot");
  if (snapshot.snapshotVersion !== 1) {
    throw renderError("snapshotVersion must be 1");
  }
  assertProject(snapshot.targetProject, "snapshot.targetProject");
  assertProject(snapshot.sourceProject, "snapshot.sourceProject");
  assertSha(snapshot.targetRefSha, "snapshot.targetRefSha", [40, 64]);
  assertSha(snapshot.mergeBaseSha, "snapshot.mergeBaseSha", [40, 64]);
  assertSha(snapshot.sourceHeadSha, "snapshot.sourceHeadSha", [40, 64]);

  const issue = asRecord(snapshot.issue as JsonValue, "snapshot.issue");
  if (issue.kind === "none") {
    exactFields(issue, new Set(["kind"]), "snapshot.issue");
  } else if (issue.kind === "linked") {
    if (!Number.isSafeInteger(issue.iid) || (issue.iid as number) < 1 ||
        !["available", "unavailable"].includes(issue.readStatus as string)) {
      throw renderError("snapshot.issue linked fields are invalid");
    }
    if (issue.readStatus === "unavailable") {
      exactFields(issue, new Set(["kind", "iid", "readStatus"]), "snapshot.issue");
    } else {
      exactFields(issue, new Set([
        "kind", "iid", "readStatus", "milestone", "assignees", "dueDate", "labels",
      ]), "snapshot.issue");
      if ((issue.milestone !== null && typeof issue.milestone !== "string") ||
          (issue.milestone !== null && nonEmpty(issue.milestone, "snapshot.issue.milestone") !== issue.milestone)) {
        throw renderError("snapshot.issue display fields are invalid");
      }
      assertCanonicalDate(issue.dueDate, "snapshot.issue.dueDate");
      assertUniqueIds(issue.assignees, "snapshot.issue.assignees", assertUser);
      assertUniqueIds(issue.labels, "snapshot.issue.labels", assertLabel);
      (issue as Record<string, JsonValue>).assignees = sortObjectArrayById(
        issue.assignees,
        "snapshot.issue.assignees",
      );
      (issue as Record<string, JsonValue>).labels = sortObjectArrayById(
        issue.labels,
        "snapshot.issue.labels",
      );
    }
  } else {
    throw renderError("snapshot.issue kind is invalid");
  }
  assertUniqueIds(snapshot.labelCandidates, "snapshot.labelCandidates", assertLabel);
  assertUniqueIds(snapshot.userCandidates, "snapshot.userCandidates", assertUser);
  (snapshot as Record<string, JsonValue>).labelCandidates = sortObjectArrayById(
    snapshot.labelCandidates,
    "snapshot.labelCandidates",
  );
  (snapshot as Record<string, JsonValue>).userCandidates = sortObjectArrayById(
    snapshot.userCandidates,
    "snapshot.userCandidates",
  );

  const mr = asRecord(snapshot.mergeRequest as JsonValue, "snapshot.mergeRequest");
  exactFields(mr, new Set([
    "iid", "authorUserId", "lifecycle", "labelIds", "assigneeUserId", "reviewerUserIds",
  ]), "snapshot.mergeRequest");
  if ((mr.iid !== null && (!Number.isSafeInteger(mr.iid) || (mr.iid as number) < 1)) ||
      typeof mr.authorUserId !== "string" || nonEmpty(mr.authorUserId, "snapshot.mergeRequest.authorUserId") !== mr.authorUserId ||
      !["new", "draft", "ready", "closed", "merged"].includes(mr.lifecycle as string) ||
      (mr.assigneeUserId !== null && typeof mr.assigneeUserId !== "string")) {
    throw renderError("snapshot.mergeRequest fields are invalid");
  }
  if ((mr.iid === null) !== (mr.lifecycle === "new")) {
    throw renderError("snapshot.mergeRequest new/existing state is inconsistent");
  }
  const currentLabelIds = canonicalStringArray(mr.labelIds, "snapshot.mergeRequest.labelIds");
  const currentReviewerIds = canonicalStringArray(mr.reviewerUserIds, "snapshot.mergeRequest.reviewerUserIds");
  (mr as Record<string, JsonValue>).labelIds = currentLabelIds;
  (mr as Record<string, JsonValue>).reviewerUserIds = currentReviewerIds;

  const localChecks = asRecord(snapshot.localChecks as JsonValue, "snapshot.localChecks");
  exactFields(localChecks, new Set([
    "commitConvention", "secretScan", "repositoryHygiene",
  ]), "snapshot.localChecks");
  const localStatuses = ["passed", "failed", "not-run", "unavailable"];
  assertObservation(localChecks.commitConvention, "snapshot.localChecks.commitConvention", localStatuses);
  assertObservation(localChecks.secretScan, "snapshot.localChecks.secretScan", localStatuses);
  assertObservation(localChecks.repositoryHygiene, "snapshot.localChecks.repositoryHygiene", localStatuses);
  assertObservation(snapshot.metadataRead, "snapshot.metadataRead", ["available", "unavailable"]);

  const ci = asRecord(snapshot.ci as JsonValue, "snapshot.ci");
  exactFields(ci, new Set(["status"]), "snapshot.ci");
  if (!["unavailable", "pending", "running", "passed", "failed", "canceled", "skipped"].includes(ci.status as string)) {
    throw renderError("snapshot.ci status is invalid");
  }
  const review = asRecord(snapshot.review as JsonValue, "snapshot.review");
  exactFields(review, new Set([
    "approvedByUserIds", "qualifiedReviewerUserIds", "unresolvedDiscussions",
  ]), "snapshot.review");
  const approvedIds = canonicalStringArray(review.approvedByUserIds, "snapshot.review.approvedByUserIds");
  const qualifiedIds = review.qualifiedReviewerUserIds === null
    ? null
    : canonicalStringArray(review.qualifiedReviewerUserIds, "snapshot.review.qualifiedReviewerUserIds");
  (review as Record<string, JsonValue>).approvedByUserIds = approvedIds;
  (review as Record<string, JsonValue>).qualifiedReviewerUserIds = qualifiedIds;
  if (review.unresolvedDiscussions !== null &&
      (!Number.isSafeInteger(review.unresolvedDiscussions) || (review.unresolvedDiscussions as number) < 0)) {
      throw renderError("snapshot.review unresolved discussion count is invalid");
  }

  const labelIds = new Set((snapshot.labelCandidates as JsonValue[]).map((value) =>
    asRecord(value, "snapshot.labelCandidates").id as string));
  const userIds = new Set((snapshot.userCandidates as JsonValue[]).map((value) =>
    asRecord(value, "snapshot.userCandidates").id as string));
  assertReferences(currentLabelIds, labelIds, "snapshot.mergeRequest.labelIds");
  assertReferences(currentReviewerIds, userIds, "snapshot.mergeRequest.reviewerUserIds");
  assertReferences(approvedIds, userIds, "snapshot.review.approvedByUserIds");
  if (qualifiedIds !== null) {
    assertReferences(qualifiedIds, userIds, "snapshot.review.qualifiedReviewerUserIds");
  }
  if (!userIds.has(mr.authorUserId as string) ||
      (mr.assigneeUserId !== null && !userIds.has(mr.assigneeUserId as string)) ||
      currentReviewerIds.includes(mr.authorUserId as string)) {
    throw renderError("snapshot.mergeRequest contains an invalid user reference");
  }
  return deepFreeze(snapshot as unknown as ExternalContextSnapshot);
}

export function validateDesiredWritePlan(value: unknown): DesiredWritePlanSnapshot {
  const plan = asRecord(copyJsonValue(value), "writePlan");
  exactFields(plan, new Set([
    "writePlanVersion", "title", "labelIds", "assigneeUserId", "reviewerUserIds",
    "removeSourceBranch", "squash",
  ]), "writePlan");
  if (plan.writePlanVersion !== 1 || typeof plan.title !== "string" || plan.title === "" ||
      (plan.assigneeUserId !== null && typeof plan.assigneeUserId !== "string") ||
      typeof plan.removeSourceBranch !== "boolean" || typeof plan.squash !== "boolean") {
    throw renderError("writePlan fields are invalid");
  }
  (plan as Record<string, JsonValue>).labelIds = canonicalStringArray(plan.labelIds, "writePlan.labelIds");
  (plan as Record<string, JsonValue>).reviewerUserIds = canonicalStringArray(
    plan.reviewerUserIds,
    "writePlan.reviewerUserIds",
  );
  return deepFreeze(plan as unknown as DesiredWritePlanSnapshot);
}

function validateStateMap(value: unknown): DerivedStateMap {
  const stateMap = asRecord(copyJsonValue(value), "stateMap");
  for (const [id, state] of Object.entries(stateMap)) {
    nonEmpty(id, "stateMap ID");
    if (!["checked", "pending", "not-applicable"].includes(state as string)) {
      throw renderError("stateMap contains an invalid state");
    }
  }
  return stateMap as unknown as DerivedStateMap;
}

function expectedStateIds(request: Request): ReadonlySet<string> {
  return new Set([
    ...request.verification.items.map((item) => item.id),
    ...REVIEW_STATE_IDS,
  ]);
}

function assertExactStateMap(stateMap: DerivedStateMap, request?: Request): void {
  const actual = Object.keys(stateMap).sort();
  const expected = request === undefined
    ? null
    : [...expectedStateIds(request)].sort();
  if (actual.some((id) => !REVIEW_STATE_IDS.has(id) && !VERIFICATION_STATE_IDS.has(id)) ||
      [...REVIEW_STATE_IDS].some((id) => !Object.hasOwn(stateMap, id)) ||
      (expected !== null &&
        (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])))) {
    throw renderError("stateMap keys do not match active evidence plus the ten Review / CI states");
  }
}

function validateInputs(value: DiagnosticMarkerInputs): DiagnosticMarkerInputs {
  const input = asRecord(copyJsonValue(value), "marker inputs");
  exactFields(input, MARKER_INPUT_FIELDS, "marker inputs");
  const releaseTag = nonEmpty(input.releaseTag, "releaseTag");
  const bundleId = nonEmpty(input.bundleId, "bundleId");
  const bundleVersion = nonEmpty(input.bundleVersion, "bundleVersion");
  const bundleManifestHash = assertSha(input.bundleManifestHash, "bundleManifestHash");
  const profileIds = stringArray(input.profileIds, "profileIds");
  if (!Number.isSafeInteger(input.policySchema) || (input.policySchema as number) < 1 ||
      !["preview", "provisional", "final"].includes(input.renderPhase as string)) {
    throw renderError("marker version or render phase is invalid");
  }
  const cliVersion = nonEmpty(input.cliVersion, "cliVersion");
  const stateMap = validateStateMap(input.stateMap);
  const requestValue = copyJsonValue(input.request);
  const request = normalizeAndValidateRequest(requestValue);
  if (canonicalizeJson(requestValue) !== canonicalizeJson(request)) {
    throw renderError("request is not normalized canonical input");
  }
  assertCanonicalProfileIds(profileIds, request.profileIds);
  assertExactStateMap(stateMap, request);
  const snapshot = validateExternalContextSnapshot(input.snapshot);
  const writePlan = validateDesiredWritePlan(input.writePlan);
  return {
    releaseTag,
    bundleId,
    bundleVersion,
    bundleManifestHash,
    profileIds,
    policySchema: input.policySchema as number,
    cliVersion,
    renderPhase: input.renderPhase as RenderPhase,
    stateMap,
    request,
    snapshot,
    writePlan,
  };
}

function metadataWithoutBody(inputsValue: DiagnosticMarkerInputs): Omit<DiagnosticMarkerMetadata, "bodyDigest"> {
  const inputs = validateInputs(inputsValue);
  return {
    releaseTag: inputs.releaseTag,
    bundleId: inputs.bundleId,
    bundleVersion: inputs.bundleVersion,
    bundleManifestHash: inputs.bundleManifestHash,
    profileIds: inputs.profileIds,
    policySchema: inputs.policySchema,
    cliVersion: inputs.cliVersion,
    renderPhase: inputs.renderPhase,
    stateMap: inputs.stateMap,
    requestDigest: sha256CanonicalJson(inputs.request),
    snapshotDigest: sha256CanonicalJson(inputs.snapshot),
    writePlanDigest: sha256CanonicalJson(inputs.writePlan),
  };
}

function splitDescription(value: string): { readonly body: string; readonly encoded: string } {
  if (typeof value !== "string" || value.includes("\r")) {
    throw renderError("description must use LF line endings");
  }
  const occurrences = value.split(MARKER_PREFIX).length - 1;
  const match = MARKER_PATTERN.exec(value);
  if (occurrences !== 1 || match === null || match.index <= 0 || match[1] === undefined) {
    throw renderError("description must end in exactly one marker");
  }
  return { body: value.slice(0, match.index), encoded: match[1] };
}

function decodeMetadata(encoded: string): DiagnosticMarkerMetadata {
  if (encoded.length % 4 === 1) {
    throw renderError("marker base64url is invalid");
  }
  let bytes: Uint8Array;
  try {
    const buffer = Buffer.from(encoded, "base64url");
    if (buffer.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url");
    }
    bytes = buffer;
  } catch {
    throw renderError("marker base64url is invalid");
  }
  let serialized: string;
  try {
    serialized = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw renderError("marker metadata is not UTF-8");
  }
  let value: JsonValue;
  try {
    value = parseStrictJson(serialized);
  } catch {
    throw renderError("marker metadata is not strict JSON");
  }
  const record = asRecord(value, "marker metadata");
  if (canonicalizeJson(record) !== serialized) {
    throw renderError("marker metadata is not canonical JCS");
  }
  exactFields(record, METADATA_FIELDS, "marker metadata");
  nonEmpty(record.releaseTag, "marker releaseTag");
  nonEmpty(record.bundleId, "marker bundleId");
  nonEmpty(record.bundleVersion, "marker bundleVersion");
  assertSha(record.bundleManifestHash, "marker bundleManifestHash");
  assertCanonicalProfileIds(stringArray(record.profileIds, "marker profileIds"));
  if (!Number.isSafeInteger(record.policySchema) || (record.policySchema as number) < 1 ||
      typeof record.cliVersion !== "string" ||
      !["preview", "provisional", "final"].includes(record.renderPhase as string)) {
    throw renderError("marker metadata scalar fields are invalid");
  }
  validateStateMap(record.stateMap);
  assertExactStateMap(record.stateMap as DerivedStateMap);
  for (const field of ["requestDigest", "snapshotDigest", "writePlanDigest", "bodyDigest"] as const) {
    if (typeof record[field] !== "string" || !SHA256.test(record[field] as string)) {
      throw renderError(`marker ${field} is invalid`);
    }
  }
  return record as unknown as DiagnosticMarkerMetadata;
}

export function digestDescriptionBody(description: string): string {
  if (description.includes(MARKER_PREFIX)) {
    return sha256Utf8(normalizeLfWithFinalLf(splitDescription(description).body));
  }
  return sha256Utf8(normalizeLfWithFinalLf(description));
}

export function appendDiagnosticMarker(
  body: string,
  inputs: DiagnosticMarkerInputs,
): string {
  if (typeof body !== "string" || body.includes(MARKER_PREFIX)) {
    throw renderError("body already contains a diagnostic marker");
  }
  const normalizedBody = normalizeLfWithFinalLf(body);
  const metadata: DiagnosticMarkerMetadata = {
    ...metadataWithoutBody(inputs),
    bodyDigest: sha256Utf8(normalizedBody),
  };
  const encoded = Buffer.from(canonicalizeJson(metadata), "utf8").toString("base64url");
  return `${normalizedBody}${MARKER_PREFIX}${encoded} -->\n`;
}

export function parseDiagnosticMarker(description: string): DiagnosticMarkerMetadata {
  return decodeMetadata(splitDescription(description).encoded);
}

export function verifyDiagnosticMarker(
  description: string,
  inputs?: DiagnosticMarkerInputs,
): DiagnosticMarkerMetadata {
  const { body } = splitDescription(description);
  const metadata = parseDiagnosticMarker(description);
  if (metadata.bodyDigest !== sha256Utf8(normalizeLfWithFinalLf(body))) {
    throw renderError("marker body digest does not match the description");
  }
  if (inputs !== undefined) {
    const expected = {
      ...metadataWithoutBody(inputs),
      bodyDigest: metadata.bodyDigest,
    };
    if (canonicalizeJson(metadata) !== canonicalizeJson(expected)) {
      throw renderError("marker metadata does not match the renderer inputs");
    }
  }
  return metadata;
}
