import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  sha256Utf8,
  type JsonValue,
} from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";
import { renderDescription } from "../render/markdown.ts";
import {
  parseDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type DesiredWritePlanSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import type { RemoteMergeRequest } from "./create-mr.ts";
import { assertManagedDescription } from "./description-ownership.ts";

export type VerificationLevel = "structure" | "ready" | "merge";

function assertVerificationLevel(level: unknown): asserts level is VerificationLevel {
  if (level !== "structure" && level !== "ready" && level !== "merge") {
    throw verificationError("verification level is invalid");
  }
}

export interface MergeRequestVerificationExpectation {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly description: string;
  readonly sourceBranch: string;
}

export interface VerifyMergeRequestInputs {
  readonly level: VerificationLevel;
  readonly current: RemoteMergeRequest;
  readonly bundle: LoadedTemplateBundle;
  readonly expected: MergeRequestVerificationExpectation;
}

export interface MergeRequestVerificationResult {
  readonly valid: true;
  readonly level: VerificationLevel;
  readonly iid: number;
  readonly webUrl: string;
  readonly live: {
    readonly lifecycle: "draft" | "ready";
    readonly ciStatus: ExternalContextSnapshot["ci"]["status"];
    readonly unresolvedDiscussions: number | null;
    readonly qualifiedApprovals: number | null;
  };
}

export interface VerificationBundleReference {
  readonly releaseTag: string;
  readonly bundleId: string;
  readonly bundleVersion: string;
  readonly bundleManifestHash: string;
  readonly policySchema: number;
}

export interface VerificationReceiptV1 {
  readonly receiptVersion: 1;
  readonly gitlabOrigin: string;
  readonly iid: number;
  readonly webUrl: string;
  readonly sourceProject: { readonly id: string; readonly path: string };
  readonly targetProject: { readonly id: string; readonly path: string };
  readonly sourceBranch: string;
  readonly targetBranch: string;
  readonly sourceHeadSha: string;
  readonly authorUserId: string;
  readonly lifecycle: "draft" | "ready";
  readonly riskLevel: Request["risk"]["level"];
  readonly expected: {
    readonly title: string;
    readonly description: string;
    readonly labelIds: readonly string[];
    readonly assigneeUserId: string | null;
    readonly reviewerUserIds: readonly string[];
    readonly squash: boolean;
    readonly removeSourceBranch: boolean;
  };
  readonly labelBindings: readonly { readonly id: string; readonly name: string }[];
  readonly userBindings: readonly { readonly id: string; readonly username: string; readonly displayName: string }[];
  readonly marker: ReturnType<typeof parseDiagnosticMarker>;
  readonly bundle: VerificationBundleReference;
}

export interface VerificationReceiptLocator {
  readonly gitlabOrigin: string;
  readonly targetProjectId: string;
  readonly iid: number;
  readonly markerDigest: string;
}

export type TrustedVerificationReceiptLoad =
  | { readonly trusted: true; readonly receipt: unknown }
  | { readonly trusted: false; readonly receipt: null };

export interface VerificationReceiptLoader {
  loadVerified(locator: VerificationReceiptLocator): Promise<TrustedVerificationReceiptLoad | null>;
}

export interface VerificationReceiptWriter {
  stageAuthenticated(receipt: VerificationReceiptV1): Promise<void>;
}

export type TrustedHistoricalBundleLoad =
  | { readonly trusted: true; readonly bundle: LoadedTemplateBundle }
  | { readonly trusted: false; readonly bundle: null };

export interface HistoricalBundleLoader {
  loadVerifiedExact(reference: VerificationBundleReference): Promise<TrustedHistoricalBundleLoad>;
}

export interface VerifyStoredMergeRequestInputs {
  readonly level: VerificationLevel;
  readonly current: RemoteMergeRequest;
  readonly gitlabOrigin: string;
  readonly receiptLoader: VerificationReceiptLoader;
  readonly bundleLoader: HistoricalBundleLoader;
}

const RECEIPT_FIELDS = new Set([
  "receiptVersion", "gitlabOrigin", "iid", "webUrl", "sourceProject", "targetProject", "sourceBranch",
  "targetBranch", "sourceHeadSha", "authorUserId", "lifecycle", "riskLevel", "expected",
  "labelBindings", "userBindings", "marker", "bundle",
]);
const PROJECT_FIELDS = new Set(["id", "path"]);
const EXPECTED_FIELDS = new Set([
  "title", "description", "labelIds", "assigneeUserId", "reviewerUserIds", "squash",
  "removeSourceBranch",
]);
const BINDING_FIELDS = new Set(["id", "name"]);
const USER_BINDING_FIELDS = new Set(["id", "username", "displayName"]);
const BUNDLE_REFERENCE_FIELDS = new Set([
  "releaseTag", "bundleId", "bundleVersion", "bundleManifestHash", "policySchema",
]);
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const TOKEN_SHAPE = /(?:hmr[ctx]1_[A-Za-z0-9_-]{43}|glpat-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|(?:authorization|bearer)\s*[:=]\s*[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;

function receiptRecord(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw verificationError(`${subject} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exactReceiptFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  subject: string,
): void {
  const actual = Object.keys(value);
  if (actual.length !== fields.size || actual.some((field) => !fields.has(field))) {
    throw verificationError(`${subject} fields are invalid`);
  }
}

function receiptString(value: unknown, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw verificationError(`${subject} is invalid`);
  }
  return value;
}

function receiptOrigin(value: unknown): string {
  const origin = receiptString(value, "verification receipt GitLab origin");
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw verificationError("verification receipt GitLab origin is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
      parsed.search !== "" || parsed.hash !== "" || parsed.pathname !== "/" ||
      parsed.origin !== origin) {
    throw verificationError("verification receipt GitLab origin is invalid");
  }
  return origin;
}

function receiptWebUrl(value: unknown, origin: string): string {
  const webUrl = receiptString(value, "verification receipt MR URL");
  let parsed: URL;
  try {
    parsed = new URL(webUrl);
  } catch {
    throw verificationError("verification receipt MR URL is invalid");
  }
  if (parsed.protocol !== "https:" || parsed.origin !== origin || parsed.username !== "" ||
      parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
      parsed.pathname === "/") {
    throw verificationError("verification receipt MR URL is invalid");
  }
  return webUrl;
}

function receiptStringArray(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry === "") ||
      new Set(value).size !== value.length) {
    throw verificationError(`${subject} is invalid`);
  }
  return Object.freeze([...value].sort());
}

function projectValue(value: unknown, subject: string): { readonly id: string; readonly path: string } {
  const input = receiptRecord(value, subject);
  exactReceiptFields(input, PROJECT_FIELDS, subject);
  return Object.freeze({
    id: receiptString(input.id, `${subject} ID`),
    path: receiptString(input.path, `${subject} path`),
  });
}

function bundleReference(value: unknown): VerificationBundleReference {
  const input = receiptRecord(value, "verification receipt Bundle reference");
  exactReceiptFields(input, BUNDLE_REFERENCE_FIELDS, "verification receipt Bundle reference");
  const hash = receiptString(input.bundleManifestHash, "verification receipt Bundle hash");
  if (!SHA256.test(hash) || !Number.isSafeInteger(input.policySchema) || (input.policySchema as number) < 1) {
    throw verificationError("verification receipt Bundle reference is invalid");
  }
  return Object.freeze({
    releaseTag: receiptString(input.releaseTag, "verification receipt release tag"),
    bundleId: receiptString(input.bundleId, "verification receipt Bundle ID"),
    bundleVersion: receiptString(input.bundleVersion, "verification receipt Bundle version"),
    bundleManifestHash: hash,
    policySchema: input.policySchema as number,
  });
}

function labelBindings(value: unknown): VerificationReceiptV1["labelBindings"] {
  if (!Array.isArray(value)) throw verificationError("verification receipt label bindings are invalid");
  const bindings = value.map((entry) => {
    const input = receiptRecord(entry, "verification receipt label binding");
    exactReceiptFields(input, BINDING_FIELDS, "verification receipt label binding");
    return Object.freeze({
      id: receiptString(input.id, "verification receipt label binding ID"),
      name: receiptString(input.name, "verification receipt label binding name"),
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindings.map(({ id }) => id)).size !== bindings.length) {
    throw verificationError("verification receipt label bindings contain duplicates");
  }
  return Object.freeze(bindings);
}

function userBindings(value: unknown): VerificationReceiptV1["userBindings"] {
  if (!Array.isArray(value)) throw verificationError("verification receipt user bindings are invalid");
  const bindings = value.map((entry) => {
    const input = receiptRecord(entry, "verification receipt user binding");
    exactReceiptFields(input, USER_BINDING_FIELDS, "verification receipt user binding");
    return Object.freeze({
      id: receiptString(input.id, "verification receipt user binding ID"),
      username: receiptString(input.username, "verification receipt username"),
      displayName: receiptString(input.displayName, "verification receipt user display name"),
    });
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (new Set(bindings.map(({ id }) => id)).size !== bindings.length) {
    throw verificationError("verification receipt user bindings contain duplicates");
  }
  return Object.freeze(bindings);
}

export function validateVerificationReceipt(value: unknown): VerificationReceiptV1 {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw verificationError("verification receipt is not strict JSON");
  }
  if (TOKEN_SHAPE.test(canonicalizeJson(copied))) {
    throw verificationError("verification receipt contains an opaque credential-shaped value");
  }
  const input = receiptRecord(copied, "verification receipt");
  exactReceiptFields(input, RECEIPT_FIELDS, "verification receipt");
  const expectedInput = receiptRecord(input.expected, "verification receipt expected state");
  exactReceiptFields(expectedInput, EXPECTED_FIELDS, "verification receipt expected state");
  if (typeof expectedInput.squash !== "boolean" ||
      typeof expectedInput.removeSourceBranch !== "boolean") {
    throw verificationError("verification receipt expected options are invalid");
  }
  const expected = Object.freeze({
    title: receiptString(expectedInput.title, "verification receipt title"),
    description: typeof expectedInput.description === "string" && expectedInput.description !== ""
      ? expectedInput.description
      : (() => { throw verificationError("verification receipt description is invalid"); })(),
    labelIds: receiptStringArray(expectedInput.labelIds, "verification receipt labels"),
    assigneeUserId: expectedInput.assigneeUserId === null
      ? null
      : receiptString(expectedInput.assigneeUserId, "verification receipt assignee"),
    reviewerUserIds: receiptStringArray(expectedInput.reviewerUserIds, "verification receipt reviewers"),
    squash: expectedInput.squash,
    removeSourceBranch: expectedInput.removeSourceBranch,
  });
  const marker = parseDiagnosticMarker(expected.description);
  if (input.receiptVersion !== 1 || !Number.isSafeInteger(input.iid) || (input.iid as number) < 1 ||
      !["draft", "ready"].includes(input.lifecycle as string) ||
      !["low", "medium", "high"].includes(input.riskLevel as string)) {
    throw verificationError("verification receipt scalar fields are invalid");
  }
  const markerInput = receiptRecord(input.marker, "verification receipt marker");
  if (canonicalizeJson(markerInput as JsonValue) !== canonicalizeJson(marker as unknown as JsonValue)) {
    throw verificationError("verification receipt marker does not match its description");
  }
  const gitlabOrigin = receiptOrigin(input.gitlabOrigin);
  const receipt: VerificationReceiptV1 = {
    receiptVersion: 1,
    gitlabOrigin,
    iid: input.iid as number,
    webUrl: receiptWebUrl(input.webUrl, gitlabOrigin),
    sourceProject: projectValue(input.sourceProject, "verification receipt source project"),
    targetProject: projectValue(input.targetProject, "verification receipt target project"),
    sourceBranch: receiptString(input.sourceBranch, "verification receipt source branch"),
    targetBranch: receiptString(input.targetBranch, "verification receipt target branch"),
    sourceHeadSha: receiptString(input.sourceHeadSha, "verification receipt source SHA"),
    authorUserId: receiptString(input.authorUserId, "verification receipt author"),
    lifecycle: input.lifecycle as VerificationReceiptV1["lifecycle"],
    riskLevel: input.riskLevel as VerificationReceiptV1["riskLevel"],
    expected,
    labelBindings: labelBindings(input.labelBindings),
    userBindings: userBindings(input.userBindings),
    marker,
    bundle: bundleReference(input.bundle),
  };
  if (!SHA.test(receipt.sourceHeadSha) || receipt.marker.renderPhase !== "final" ||
      receipt.marker.releaseTag !== receipt.bundle.releaseTag ||
      receipt.marker.bundleId !== receipt.bundle.bundleId ||
      receipt.marker.bundleVersion !== receipt.bundle.bundleVersion ||
      receipt.marker.bundleManifestHash !== receipt.bundle.bundleManifestHash ||
      receipt.marker.policySchema !== receipt.bundle.policySchema ||
      !sameIds(receipt.expected.labelIds, receipt.labelBindings.map(({ id }) => id)) ||
      !sameIds(
        [
          receipt.authorUserId,
          ...(receipt.expected.assigneeUserId === null ? [] : [receipt.expected.assigneeUserId]),
          ...receipt.expected.reviewerUserIds,
        ].filter((id, index, values) => values.indexOf(id) === index),
        receipt.userBindings.map(({ id }) => id),
      )) {
    throw verificationError("verification receipt bindings are inconsistent");
  }
  return deepFreezeReceipt(receipt);
}

function deepFreezeReceipt<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeReceipt(child);
    Object.freeze(value);
  }
  return value;
}

export function buildVerificationReceipt(inputs: {
  readonly gitlabOrigin: string;
  readonly current: RemoteMergeRequest;
  readonly expected: MergeRequestVerificationExpectation;
  readonly bundle: LoadedTemplateBundle;
}): VerificationReceiptV1 {
  validateTemplateBundle(inputs.bundle);
  const snapshot = validateExternalContextSnapshot(inputs.expected.snapshot);
  const writePlan = validateDesiredWritePlan(inputs.expected.writePlan);
  const regenerated = renderDescription({
    request: inputs.expected.request,
    snapshot,
    writePlan,
    bundle: inputs.bundle,
    releaseTag: inputs.expected.releaseTag,
    cliVersion: inputs.expected.cliVersion,
    renderPhase: "final",
    ...(inputs.expected.request.intent === "ready" && snapshot.mergeRequest.lifecycle === "draft"
      ? { snapshotExpectation: "ready-transition-pending" as const }
      : {}),
  });
  if (regenerated !== inputs.expected.description || inputs.current.iid < 1 ||
      inputs.current.state !== "opened" || inputs.current.sourceProjectId !== snapshot.sourceProject.id ||
      inputs.current.targetProjectId !== snapshot.targetProject.id ||
      inputs.current.sourceBranch !== inputs.expected.sourceBranch ||
      inputs.current.targetBranch !== inputs.expected.request.targetBranch ||
      inputs.current.sourceHeadSha !== snapshot.sourceHeadSha ||
      snapshot.mergeRequest.iid !== inputs.current.iid) {
    throw verificationError("the durable receipt expectation is inconsistent with its MR identity");
  }
  const labels = new Map(snapshot.labelCandidates.map((label) => [label.id, label] as const));
  const users = new Map(snapshot.userCandidates.map((user) => [user.id, user] as const));
  const labelValues = inputs.expected.writePlan.labelIds.map((id) => {
    const value = labels.get(id);
    if (value === undefined) throw verificationError("an expected label binding is unavailable");
    return value;
  });
  const userIds = [
    snapshot.mergeRequest.authorUserId,
    ...(inputs.expected.writePlan.assigneeUserId === null ? [] : [inputs.expected.writePlan.assigneeUserId]),
    ...inputs.expected.writePlan.reviewerUserIds,
  ].filter((id, index, values) => values.indexOf(id) === index);
  const userValues = userIds.map((id) => {
    const value = users.get(id);
    if (value === undefined) throw verificationError("an expected user binding is unavailable");
    return value;
  });
  const marker = parseDiagnosticMarker(inputs.expected.description);
  return validateVerificationReceipt({
    receiptVersion: 1,
    gitlabOrigin: inputs.gitlabOrigin,
    iid: inputs.current.iid,
    webUrl: inputs.current.webUrl,
    sourceProject: snapshot.sourceProject,
    targetProject: snapshot.targetProject,
    sourceBranch: inputs.expected.sourceBranch,
    targetBranch: inputs.expected.request.targetBranch,
    sourceHeadSha: snapshot.sourceHeadSha,
    authorUserId: snapshot.mergeRequest.authorUserId,
    lifecycle: inputs.expected.request.intent,
    riskLevel: inputs.expected.request.risk.level,
    expected: {
      title: writePlan.title,
      description: inputs.expected.description,
      labelIds: writePlan.labelIds,
      assigneeUserId: writePlan.assigneeUserId,
      reviewerUserIds: writePlan.reviewerUserIds,
      squash: writePlan.squash,
      removeSourceBranch: writePlan.removeSourceBranch,
    },
    labelBindings: labelValues,
    userBindings: userValues,
    marker,
    bundle: {
      releaseTag: inputs.expected.releaseTag,
      bundleId: inputs.bundle.manifest.bundleId,
      bundleVersion: inputs.bundle.manifest.version,
      bundleManifestHash: sha256Utf8(`${canonicalizeJson(inputs.bundle.manifest)}\n`),
      policySchema: inputs.bundle.manifest.policySchema,
    },
  });
}

export async function stageVerificationReceipt(
  writer: VerificationReceiptWriter,
  inputs: Parameters<typeof buildVerificationReceipt>[0],
): Promise<VerificationReceiptV1> {
  const receipt = buildVerificationReceipt(inputs);
  try {
    await writer.stageAuthenticated(receipt);
  } catch (cause) {
    throw new ToolError("POSTCONDITION_ERROR", "The durable verification receipt could not be staged", {
      field: "verificationReceipt",
      expected: "an authenticated, atomically persisted receipt before the final description write",
      actual: "receipt persistence failed",
      safeNextStep: "Repair the private local state store and retry the MR operation without deleting the Draft.",
    }, cause);
  }
  return receipt;
}

export function isVerificationReceiptStageError(error: unknown): boolean {
  return error instanceof ToolError && error.details.field === "verificationReceipt";
}

export function assertTransactionStructure(
  current: RemoteMergeRequest,
  expectedDescription: string,
  bundle: LoadedTemplateBundle,
  releaseTag: string,
): void {
  assertManagedDescription(current.description, bundle, releaseTag);
  if (current.description !== expectedDescription ||
      parseDiagnosticMarker(current.description).renderPhase !== "final") {
    throw verificationError("description body or diagnostic marker drifted during the transaction");
  }
}

function verificationError(reason: string): ToolError<"POSTCONDITION_ERROR"> {
  return new ToolError("POSTCONDITION_ERROR", "Merge request verification failed", {
    field: "mergeRequest",
    expected: "canonical managed fields, a verified final marker, and live state satisfying the requested level",
    actual: reason,
    safeNextStep: "Refresh the MR and context, inspect the reported drift, and update it through harness-mrtool.",
  });
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function reviewPolicy(bundle: LoadedTemplateBundle): {
  readonly ready: number;
  readonly highRisk: number;
  readonly mergeStatusName: string;
} {
  const review = bundle.policy.review;
  const labels = bundle.policy.labels;
  const lifecycle = labels !== null && typeof labels === "object" && !Array.isArray(labels)
    ? labels.lifecycle
    : null;
  const expectedNames = lifecycle !== null && typeof lifecycle === "object" && !Array.isArray(lifecycle)
    ? lifecycle.expectedNames
    : null;
  if (review === null || typeof review !== "object" || Array.isArray(review) ||
      !Number.isSafeInteger(review.readyMinimumReviewers) ||
      !Number.isSafeInteger(review.highRiskMinimumReviewers) ||
      (review.readyMinimumReviewers as number) < 0 ||
      (review.highRiskMinimumReviewers as number) < 0 ||
      expectedNames === null || typeof expectedNames !== "object" || Array.isArray(expectedNames) ||
      typeof expectedNames.merge !== "string" || expectedNames.merge === "") {
    throw verificationError("Bundle review Policy is invalid");
  }
  return {
    ready: review.readyMinimumReviewers as number,
    highRisk: review.highRiskMinimumReviewers as number,
    mergeStatusName: expectedNames.merge,
  };
}

export function assertReadyGate(
  snapshotValue: ExternalContextSnapshot,
  request: Request,
  writePlanValue: DesiredWritePlanSnapshot,
  bundle: LoadedTemplateBundle,
): void {
  validateTemplateBundle(bundle);
  const snapshot = validateExternalContextSnapshot(snapshotValue);
  const writePlan = validateDesiredWritePlan(writePlanValue);
  if (request.intent !== "ready") {
    throw verificationError("Ready gate requires a Ready-intent Request");
  }
  const policy = reviewPolicy(bundle);
  const minimum = request.risk.level === "high"
    ? Math.max(policy.ready, policy.highRisk)
    : policy.ready;
  const qualified = snapshot.review.qualifiedReviewerUserIds;
  const qualifiedReviewers = qualified === null
    ? null
    : writePlan.reviewerUserIds.filter((id) =>
        id !== snapshot.mergeRequest.authorUserId && qualified.includes(id)).length;
  if (qualifiedReviewers === null || qualifiedReviewers < minimum) {
    throw verificationError("the latest qualified reviewer selection does not satisfy Ready Policy");
  }
}

function assertStructure(inputs: VerifyMergeRequestInputs): {
  readonly currentSnapshot: ExternalContextSnapshot;
  readonly expectedSnapshot: ExternalContextSnapshot;
  readonly writePlan: DesiredWritePlanSnapshot;
} {
  validateTemplateBundle(inputs.bundle);
  assertManagedDescription(
    inputs.current.description,
    inputs.bundle,
    inputs.expected.releaseTag,
  );
  assertVerificationLevel(inputs.level);
  const currentSnapshot = validateExternalContextSnapshot(inputs.current.snapshot);
  const expectedSnapshot = validateExternalContextSnapshot(inputs.expected.snapshot);
  const writePlan = validateDesiredWritePlan(inputs.expected.writePlan);
  const expectedLifecycle = inputs.expected.request.intent;
  const currentLifecycle = inputs.current.draft ? "draft" : "ready";
  const regenerated = renderDescription({
    request: inputs.expected.request,
    snapshot: expectedSnapshot,
    writePlan,
    bundle: inputs.bundle,
    releaseTag: inputs.expected.releaseTag,
    cliVersion: inputs.expected.cliVersion,
    renderPhase: "final",
    ...(inputs.expected.request.intent === "ready" && expectedSnapshot.mergeRequest.lifecycle === "draft"
      ? { snapshotExpectation: "ready-transition-pending" as const }
      : {}),
  });
  if (inputs.current.description !== inputs.expected.description ||
      inputs.current.description !== regenerated ||
      parseDiagnosticMarker(inputs.current.description).renderPhase !== "final") {
    throw verificationError("description body or diagnostic marker drifted");
  }
  if (inputs.current.iid < 1 || inputs.current.webUrl === "" || inputs.current.state !== "opened" ||
      inputs.current.sourceProjectId !== expectedSnapshot.sourceProject.id ||
      inputs.current.targetProjectId !== expectedSnapshot.targetProject.id ||
      inputs.current.sourceBranch !== inputs.expected.sourceBranch ||
      inputs.current.targetBranch !== inputs.expected.request.targetBranch ||
      inputs.current.sourceHeadSha !== expectedSnapshot.sourceHeadSha ||
      inputs.current.title !== writePlan.title ||
      currentLifecycle !== expectedLifecycle ||
      !sameIds(inputs.current.labelIds, writePlan.labelIds) ||
      inputs.current.assigneeUserId !== writePlan.assigneeUserId ||
      !sameIds(inputs.current.reviewerUserIds, writePlan.reviewerUserIds) ||
      inputs.current.squash !== writePlan.squash ||
      inputs.current.removeSourceBranch !== writePlan.removeSourceBranch ||
      currentSnapshot.mergeRequest.iid !== inputs.current.iid ||
      currentSnapshot.mergeRequest.lifecycle !== currentLifecycle ||
      !sameIds(currentSnapshot.mergeRequest.labelIds, inputs.current.labelIds) ||
      currentSnapshot.mergeRequest.assigneeUserId !== inputs.current.assigneeUserId ||
      !sameIds(currentSnapshot.mergeRequest.reviewerUserIds, inputs.current.reviewerUserIds) ||
      currentSnapshot.sourceHeadSha !== expectedSnapshot.sourceHeadSha ||
      currentSnapshot.targetRefSha !== expectedSnapshot.targetRefSha) {
    throw verificationError("managed field, lifecycle, branch, or source SHA drifted");
  }
  return { currentSnapshot, expectedSnapshot, writePlan };
}

export function verifyMergeRequest(inputs: VerifyMergeRequestInputs): MergeRequestVerificationResult {
  assertVerificationLevel(inputs.level);
  const { currentSnapshot } = assertStructure(inputs);
  const policy = reviewPolicy(inputs.bundle);
  const qualified = currentSnapshot.review.qualifiedReviewerUserIds;
  const qualifiedReviewers = qualified === null
    ? null
    : inputs.current.reviewerUserIds.filter((id) => qualified.includes(id)).length;
  const minimum = inputs.expected.request.risk.level === "high"
    ? Math.max(policy.ready, policy.highRisk)
    : policy.ready;
  if (inputs.level !== "structure" && inputs.expected.request.intent !== "ready") {
    throw verificationError("ready and merge verification require a Ready-intent MR");
  }
  if (inputs.level === "ready" &&
      (qualifiedReviewers === null || qualifiedReviewers < minimum)) {
    throw verificationError("the current qualified reviewer selection does not satisfy Ready Policy");
  }
  const qualifiedApprovals = qualified === null
    ? null
    : currentSnapshot.review.approvedByUserIds.filter((id) =>
        id !== currentSnapshot.mergeRequest.authorUserId && qualified.includes(id)).length;
  const liveLabelNames = new Map(currentSnapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const hasMergeStatus = inputs.current.labelIds.some((id) => liveLabelNames.get(id) === policy.mergeStatusName);
  if (inputs.level === "merge" && (
    !hasMergeStatus ||
    currentSnapshot.ci.status !== "passed" ||
    currentSnapshot.review.unresolvedDiscussions !== 0 ||
    qualifiedApprovals === null || qualifiedApprovals < minimum
  )) {
    throw verificationError("live CI, approvals, or blocking discussions do not satisfy merge Policy");
  }
  return Object.freeze({
    valid: true,
    level: inputs.level,
    iid: inputs.current.iid,
    webUrl: inputs.current.webUrl,
    live: Object.freeze({
      lifecycle: inputs.current.draft ? "draft" : "ready",
      ciStatus: currentSnapshot.ci.status,
      unresolvedDiscussions: currentSnapshot.review.unresolvedDiscussions,
      qualifiedApprovals,
    }),
  });
}

function assertReceiptStructure(
  current: RemoteMergeRequest,
  receipt: VerificationReceiptV1,
  bundle: LoadedTemplateBundle,
): ExternalContextSnapshot {
  validateTemplateBundle(bundle);
  const manifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  if (bundle.manifest.bundleId !== receipt.bundle.bundleId ||
      bundle.manifest.version !== receipt.bundle.bundleVersion ||
      bundle.manifest.policySchema !== receipt.bundle.policySchema ||
      manifestHash !== receipt.bundle.bundleManifestHash) {
    throw verificationError("the verified historical Bundle does not match the durable receipt");
  }
  const snapshot = validateExternalContextSnapshot(current.snapshot);
  let marker: ReturnType<typeof parseDiagnosticMarker>;
  try {
    marker = parseDiagnosticMarker(current.description);
  } catch {
    throw verificationError("the current description has no valid final marker");
  }
  const lifecycle = current.draft ? "draft" : "ready";
  if (current.iid !== receipt.iid || current.webUrl !== receipt.webUrl || current.state !== "opened" ||
      current.sourceProjectId !== receipt.sourceProject.id ||
      current.targetProjectId !== receipt.targetProject.id ||
      current.sourceBranch !== receipt.sourceBranch || current.targetBranch !== receipt.targetBranch ||
      current.sourceHeadSha !== receipt.sourceHeadSha || current.title !== receipt.expected.title ||
      current.description !== receipt.expected.description || lifecycle !== receipt.lifecycle ||
      !sameIds(current.labelIds, receipt.expected.labelIds) ||
      current.assigneeUserId !== receipt.expected.assigneeUserId ||
      !sameIds(current.reviewerUserIds, receipt.expected.reviewerUserIds) ||
      current.squash !== receipt.expected.squash ||
      current.removeSourceBranch !== receipt.expected.removeSourceBranch ||
      canonicalizeJson(marker as unknown as JsonValue) !== canonicalizeJson(receipt.marker as unknown as JsonValue) ||
      snapshot.targetProject.id !== receipt.targetProject.id ||
      snapshot.targetProject.path !== receipt.targetProject.path ||
      snapshot.sourceProject.id !== receipt.sourceProject.id ||
      snapshot.sourceProject.path !== receipt.sourceProject.path ||
      snapshot.sourceHeadSha !== receipt.sourceHeadSha ||
      snapshot.mergeRequest.iid !== current.iid ||
      snapshot.mergeRequest.authorUserId !== receipt.authorUserId ||
      snapshot.mergeRequest.lifecycle !== lifecycle ||
      !sameIds(snapshot.mergeRequest.labelIds, current.labelIds) ||
      snapshot.mergeRequest.assigneeUserId !== current.assigneeUserId ||
      !sameIds(snapshot.mergeRequest.reviewerUserIds, current.reviewerUserIds)) {
    throw verificationError("the current merge request does not match its durable verification receipt");
  }
  const liveLabels = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const liveUsers = new Map(snapshot.userCandidates.map((user) => [user.id, user] as const));
  if (receipt.labelBindings.some((binding) => liveLabels.get(binding.id) !== binding.name) ||
      receipt.userBindings.some((binding) => {
        const live = liveUsers.get(binding.id);
        return live === undefined || live.username !== binding.username || live.displayName !== binding.displayName;
      })) {
    throw verificationError("a durable label or user identity binding drifted");
  }
  return snapshot;
}

function verifyStoredLiveGate(
  level: VerificationLevel,
  current: RemoteMergeRequest,
  snapshot: ExternalContextSnapshot,
  receipt: VerificationReceiptV1,
  bundle: LoadedTemplateBundle,
): MergeRequestVerificationResult {
  const policy = reviewPolicy(bundle);
  const minimum = receipt.riskLevel === "high"
    ? Math.max(policy.ready, policy.highRisk)
    : policy.ready;
  const qualified = snapshot.review.qualifiedReviewerUserIds;
  const qualifiedReviewers = qualified === null
    ? null
    : current.reviewerUserIds.filter((id) =>
        id !== receipt.authorUserId && qualified.includes(id)).length;
  if (level !== "structure" && receipt.lifecycle !== "ready") {
    throw verificationError("ready and merge verification require a Ready receipt");
  }
  if (level === "ready" && (qualifiedReviewers === null || qualifiedReviewers < minimum)) {
    throw verificationError("the current qualified reviewer selection does not satisfy Ready Policy");
  }
  const qualifiedApprovals = qualified === null
    ? null
    : snapshot.review.approvedByUserIds.filter((id) =>
        id !== receipt.authorUserId && qualified.includes(id)).length;
  const liveLabelNames = new Map(snapshot.labelCandidates.map((label) => [label.id, label.name] as const));
  const hasMergeStatus = current.labelIds.some((id) => liveLabelNames.get(id) === policy.mergeStatusName);
  if (level === "merge" && (!hasMergeStatus || snapshot.ci.status !== "passed" ||
      snapshot.review.unresolvedDiscussions !== 0 || qualifiedApprovals === null ||
      qualifiedApprovals < minimum)) {
    throw verificationError("live CI, approvals, or blocking discussions do not satisfy merge Policy");
  }
  return Object.freeze({
    valid: true,
    level,
    iid: current.iid,
    webUrl: current.webUrl,
    live: Object.freeze({
      lifecycle: current.draft ? "draft" : "ready",
      ciStatus: snapshot.ci.status,
      unresolvedDiscussions: snapshot.review.unresolvedDiscussions,
      qualifiedApprovals,
    }),
  });
}

export async function verifyStoredMergeRequest(
  inputs: VerifyStoredMergeRequestInputs,
): Promise<MergeRequestVerificationResult> {
  assertVerificationLevel(inputs.level);
  let marker: ReturnType<typeof parseDiagnosticMarker>;
  try {
    marker = parseDiagnosticMarker(inputs.current.description);
  } catch {
    throw verificationError("the current description cannot locate a durable verification receipt");
  }
  const loaded = await inputs.receiptLoader.loadVerified(Object.freeze({
    gitlabOrigin: inputs.gitlabOrigin,
    targetProjectId: inputs.current.targetProjectId,
    iid: inputs.current.iid,
    markerDigest: sha256CanonicalJson(marker as unknown as JsonValue),
  }));
  if (loaded === null || loaded.trusted !== true) {
    throw verificationError("a trusted durable verification receipt is unavailable");
  }
  const receipt = validateVerificationReceipt(loaded.receipt);
  if (receipt.gitlabOrigin !== inputs.gitlabOrigin || receipt.iid !== inputs.current.iid ||
      receipt.targetProject.id !== inputs.current.targetProjectId ||
      canonicalizeJson(receipt.marker as unknown as JsonValue) !==
        canonicalizeJson(marker as unknown as JsonValue)) {
    throw verificationError("the trusted verification receipt is bound to another merge request");
  }
  const bundleLoad = await inputs.bundleLoader.loadVerifiedExact(receipt.bundle);
  if (bundleLoad.trusted !== true) {
    throw verificationError("the exact historical Template Bundle is not trusted");
  }
  const snapshot = assertReceiptStructure(inputs.current, receipt, bundleLoad.bundle);
  return verifyStoredLiveGate(inputs.level, inputs.current, snapshot, receipt, bundleLoad.bundle);
}
