import { buildWritePlan, type MergeRequestWritePlan } from "../../app/write-plan.ts";
import {
  defaultExternalContextReader,
  type ExternalContextReader,
  type ExternalContextReadOptions,
  type ExternalContextReadResult,
} from "../../app/external-context.ts";
import {
  getContext,
  type DiscoveredContext,
  type GetContextOptions,
} from "../../app/get-context.ts";
import { validateTemplateBundle } from "../../bundle/validate.ts";
import {
  isToolError,
  ToolError,
} from "../../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../../contracts/jcs.ts";
import type { Request } from "../../contracts/request.ts";
import type { CandidateContextStore } from "../../context/store.ts";
import type {
  Candidate,
  ContextBinding,
} from "../../context/types.ts";
import { renderDescription } from "../../render/markdown.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../render/marker.ts";
import { renderTitle } from "../../render/title.ts";
import type { CliCommandExecution } from "../execute.ts";
import { normalizeProductionRequest } from "../production-input.ts";
import type { CliInvocation } from "../program.ts";
import { guardReadOnlySuccess } from "../success-output-guard.ts";
import type { TrustedBundleSelection } from "./local.ts";
import type { ProductionCommandServices } from "./production.ts";

const LOWER_SHA256 = /^[a-f0-9]{64}$/u;
const OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REMOTE_NAME = /^(?!-)[A-Za-z0-9._-]+$/u;
const CONTEXT_BEARER = /^hmrx1_[A-Za-z0-9_-]{43}$/u;
const CANDIDATE_BEARER = /^hmrc1_[A-Za-z0-9_-]{43}$/u;
const PROFILE_IDS = ["general", "code", "docs", "ops"] as const;

type ReadOnlyCommandKind = "context" | "labels.list" | "preview";
type ContextStorePort = Pick<CandidateContextStore, "issue" | "resolve">;

export interface DoctorCheck {
  readonly id: string;
  readonly status: "passed" | "warning" | "failed";
  readonly detail: string;
}

export interface DoctorReport {
  readonly checks: readonly DoctorCheck[];
  readonly capabilities: Readonly<Record<string, boolean>>;
  readonly audit?: { readonly requestIds: readonly string[] };
}

export interface ReadOnlyProfileDetection {
  readonly kind: "detected" | "ambiguous";
  readonly profileIds: readonly string[];
  readonly reasons: readonly JsonObject[];
}

export interface ReadOnlyPushPlan {
  readonly kind: "up-to-date" | "missing" | "behind" | "blocked";
  readonly remote: string;
  readonly ref: string;
  readonly sourceHeadSha: string;
  readonly remoteSha: string | null;
  readonly command: string | null;
}

export interface ReadOnlyMergeRequestPlan {
  readonly action: "create" | "update";
  readonly iid: number | null;
  readonly webUrl: string | null;
}

export type PreparedExternalContextReadOptions = Omit<ExternalContextReadOptions, "git"> & {
  readonly git: ExternalContextReadOptions["git"] & {
    readonly sourceRemote: string;
    readonly sourceRemoteRef: string;
    readonly targetRemote: string;
    readonly targetRef: string;
  };
};

export interface PreparedReadOnlyContext {
  readonly assertNoCredentialExposure: (value: unknown) => void;
  readonly selection: TrustedBundleSelection;
  readonly options: PreparedExternalContextReadOptions;
  readonly profileDetection: ReadOnlyProfileDetection;
  readonly gitDiffSummary: JsonObject;
  readonly pushPlan: ReadOnlyPushPlan;
  readonly mergeRequestPlan: ReadOnlyMergeRequestPlan;
  readonly migration?: ReadOnlyMigrationMetadata;
}

export interface ReadOnlyMigrationMetadata {
  readonly oldReleaseTag: string;
  readonly newReleaseTag: string;
  readonly oldBundleManifestHash: string;
  readonly newBundleManifestHash: string;
  readonly oldPolicySchema: number;
  readonly newPolicySchema: number;
  readonly historicalBundleEol: boolean;
}

export interface ReadOnlyContextPlanner {
  readonly prepare: (input: {
    readonly cliVersion: string;
    readonly command: ReadOnlyCommandKind;
    readonly currentBundle: TrustedBundleSelection;
    readonly cwd: string;
    readonly invocation: CliInvocation;
    readonly request: Request | null;
    readonly contextIssueIid: number | null;
  }) => Promise<PreparedReadOnlyContext>;
}

export interface ReadOnlyDoctorProbe {
  readonly inspect: (input: {
    readonly cliVersion: string;
    readonly currentBundle: TrustedBundleSelection;
    readonly cwd: string;
  }) => Promise<DoctorReport>;
}

export interface ReadOnlyRequestSource {
  readonly read: (invocation: CliInvocation) => Promise<unknown>;
}

export interface PreviewCandidateResolution {
  readonly binding: ContextBinding;
  readonly snapshot: JsonValue;
  readonly candidates: readonly Candidate[];
  readonly candidateSelectionDigest: string;
}

export type PreviewCandidateResolver = (input: {
  readonly request: Request;
  readonly expectedBinding: ContextBinding;
  readonly store: Pick<CandidateContextStore, "resolve">;
  readonly consume: false;
}) => Promise<PreviewCandidateResolution>;

export interface ReadOnlyCommandDependencies {
  readonly cliVersion: string;
  readonly cwd: string;
  readonly currentBundle: TrustedBundleSelection;
  readonly contextIssueIid?: number | null;
  readonly contextStore: ContextStorePort;
  readonly planner: ReadOnlyContextPlanner;
  readonly doctorProbe: ReadOnlyDoctorProbe;
  readonly requestSource: ReadOnlyRequestSource;
  readonly resolveCandidates: PreviewCandidateResolver;
  readonly externalContextReader?: ExternalContextReader;
  readonly issueContext?: (options: GetContextOptions) => Promise<DiscoveredContext>;
}

function compositionError(reason: string): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Read-only command composition failed safely", {
    field: "runtime",
    expected: "a complete verified read-only production composition",
    actual: reason,
    safeNextStep: "Run doctor, refresh context if needed, then retry with a complete verified release.",
  });
}

function staleContextError(): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError("CONCURRENT_UPDATE", "External context changed before preview", {
    field: "contextId",
    expected: "the current tokenless GitLab snapshot to match the issued candidate context",
    actual: "external context changed",
    safeNextStep: "Run context again, reselect candidates, and preview the refreshed request.",
  });
}

function inputMismatchError(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Preview request does not match the resolved target", {
    field: "targetBranch",
    expected: "the target branch bound by the current context",
    actual: "request target does not match context",
    safeNextStep: "Run context again and use its target branch in the request.",
  });
}

function scalar(value: string): boolean {
  return value !== "" && value === value.trim() && !/[\r\n\u0000]/u.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function exactObject(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw compositionError("a production port returned a non-plain object");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !allowed.has(key)) ||
    Object.values(descriptors).some((descriptor) => descriptor.enumerable !== true) ||
    Object.values(descriptors).some((descriptor) => "get" in descriptor || "set" in descriptor)
  ) {
    throw compositionError("a production port returned unsupported fields");
  }
  return value as Record<string, unknown>;
}

function jsonSnapshot(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw compositionError("a production port returned non-canonical JSON");
  }
  exactObject(copied, required, optional);
  return copied as JsonObject;
}

function stringArray(value: unknown, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !scalar(entry))) {
    throw compositionError(`${subject} contains an invalid string`);
  }
  const result = value as string[];
  if (new Set(result).size !== result.length) {
    throw compositionError(`${subject} contains duplicate strings`);
  }
  return Object.freeze([...result]);
}

function positiveIid(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function requestIssueIid(request: Request | null): number | null {
  if (request === null || request.workItem.relation === "none") return null;
  return request.workItem.iid;
}

function verifiedSelection(selection: TrustedBundleSelection): TrustedBundleSelection {
  const value = jsonSnapshot(selection, [
    "bundle",
    "bundleManifestHash",
    "releaseSetId",
    "releaseTag",
  ]);
  const bundle = value.bundle;
  try {
    validateTemplateBundle(bundle);
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) throw error;
    throw compositionError("Template Bundle validation failed");
  }
  if (
    typeof value.bundleManifestHash !== "string" ||
    !LOWER_SHA256.test(value.bundleManifestHash) ||
    typeof value.releaseSetId !== "string" ||
    !scalar(value.releaseSetId) ||
    typeof value.releaseTag !== "string" ||
    !scalar(value.releaseTag)
  ) {
    throw compositionError("trusted Bundle release metadata is invalid");
  }
  const validatedBundle = bundle as unknown as TrustedBundleSelection["bundle"];
  const manifestHash = sha256Utf8(`${canonicalizeJson(validatedBundle.manifest)}\n`);
  if (manifestHash !== value.bundleManifestHash) {
    throw compositionError("trusted Bundle manifest hash is inconsistent");
  }
  return deepFreeze({
    bundle: validatedBundle,
    bundleManifestHash: value.bundleManifestHash,
    releaseSetId: value.releaseSetId,
    releaseTag: value.releaseTag,
  });
}

function sameSelection(
  left: TrustedBundleSelection,
  right: TrustedBundleSelection,
): boolean {
  return left.bundleManifestHash === right.bundleManifestHash &&
    left.releaseSetId === right.releaseSetId &&
    left.releaseTag === right.releaseTag &&
    canonicalizeJson(left.bundle) === canonicalizeJson(right.bundle);
}

function expectedOperation(
  command: ReadOnlyCommandKind,
  invocation: CliInvocation,
): "create" | "update" | "migrate" {
  if (command !== "context") return "create";
  if (invocation.command.kind !== "context") {
    throw compositionError("context planner received a mismatched command");
  }
  if (invocation.command.mrIid === null) return "create";
  return invocation.command.migrateTemplate ? "migrate" : "update";
}

function objectId(value: unknown, subject: string): string {
  if (typeof value !== "string" || !OBJECT_ID.test(value)) {
    throw compositionError(`${subject} is not a full Git object ID`);
  }
  return value;
}

function canonicalOrigin(value: unknown): string {
  if (typeof value !== "string") throw compositionError("GitLab origin is invalid");
  try {
    const parsed = new URL(value);
    const loopbackHttp = parsed.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname.toLowerCase());
    if (
      (parsed.protocol !== "https:" && !loopbackHttp) ||
      value !== parsed.origin ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new TypeError("origin");
    }
    return value;
  } catch {
    throw compositionError("GitLab origin is invalid");
  }
}

function snapshotObservation(
  value: unknown,
  subject: string,
): ExternalContextSnapshot["localChecks"]["commitConvention"] {
  const observation = jsonSnapshot(value, ["status", "evidence"]);
  if (
    !["passed", "failed", "not-run", "unavailable"].includes(String(observation.status)) ||
    typeof observation.evidence !== "string" ||
    !scalar(observation.evidence)
  ) {
    throw compositionError(`${subject} is invalid`);
  }
  return deepFreeze(observation) as unknown as ExternalContextSnapshot["localChecks"]["commitConvention"];
}

function snapshotOptions(
  value: PreparedExternalContextReadOptions,
  selected: TrustedBundleSelection,
  cliVersion: string,
): PreparedExternalContextReadOptions {
  const options = exactObject(value, [
    "operation",
    "gitlabOrigin",
    "targetProject",
    "mrIid",
    "issueIid",
    "git",
    "bundle",
    "release",
    "gitlab",
  ]);
  if (!new Set(["create", "update", "migrate"]).has(options.operation as string)) {
    throw compositionError("prepared context operation is invalid");
  }
  const origin = canonicalOrigin(options.gitlabOrigin);
  if (typeof options.targetProject !== "string" || !scalar(options.targetProject)) {
    throw compositionError("prepared target project is invalid");
  }
  if (
    (options.mrIid !== null && !positiveIid(options.mrIid)) ||
    (options.issueIid !== null && !positiveIid(options.issueIid))
  ) {
    throw compositionError("prepared context IID is invalid");
  }
  const client = options.gitlab as { readonly origin?: unknown };
  if (client === null || (typeof client !== "object" && typeof client !== "function") || client.origin !== origin) {
    throw compositionError("prepared GitLab capability is inconsistent");
  }

  const git = jsonSnapshot(options.git, [
    "sourceProject",
    "sourceBranch",
    "sourceRemote",
    "sourceRemoteRef",
    "targetRefSha",
    "mergeBaseSha",
    "sourceHeadSha",
    "targetBranch",
    "targetRemote",
    "targetRef",
    "localChecks",
  ]);
  const sourceProject = jsonSnapshot(git.sourceProject, ["id", "path"]);
  if (
    typeof sourceProject.id !== "string" || !scalar(sourceProject.id) ||
    typeof sourceProject.path !== "string" || !scalar(sourceProject.path) ||
    typeof git.sourceBranch !== "string" || !scalar(git.sourceBranch) ||
    typeof git.targetBranch !== "string" || !scalar(git.targetBranch) ||
    typeof git.sourceRemote !== "string" || !REMOTE_NAME.test(git.sourceRemote) ||
    typeof git.targetRemote !== "string" || !REMOTE_NAME.test(git.targetRemote) ||
    git.sourceRemoteRef !== `refs/heads/${git.sourceBranch}` ||
    git.targetRef !== `refs/remotes/${git.targetRemote}/${git.targetBranch}`
  ) {
    throw compositionError("prepared Git repository identity is invalid");
  }
  const localChecks = jsonSnapshot(git.localChecks, [
    "commitConvention",
    "secretScan",
    "repositoryHygiene",
  ]);
  const gitSnapshot = deepFreeze({
    sourceProject: deepFreeze({ id: sourceProject.id, path: sourceProject.path }),
    sourceBranch: git.sourceBranch,
    sourceRemote: git.sourceRemote,
    sourceRemoteRef: git.sourceRemoteRef,
    targetRefSha: objectId(git.targetRefSha, "target ref SHA"),
    mergeBaseSha: objectId(git.mergeBaseSha, "merge-base SHA"),
    sourceHeadSha: objectId(git.sourceHeadSha, "source HEAD SHA"),
    targetBranch: git.targetBranch,
    targetRemote: git.targetRemote,
    targetRef: git.targetRef,
    localChecks: deepFreeze({
      commitConvention: snapshotObservation(localChecks.commitConvention, "commit convention observation"),
      secretScan: snapshotObservation(localChecks.secretScan, "secret scan observation"),
      repositoryHygiene: snapshotObservation(localChecks.repositoryHygiene, "repository hygiene observation"),
    }),
  });

  const release = jsonSnapshot(options.release, [
    "releaseSetId",
    "releaseTag",
    "bundleManifestHash",
    "cliVersion",
    "skillProtocol",
  ]);
  if (
    release.releaseSetId !== selected.releaseSetId ||
    release.releaseTag !== selected.releaseTag ||
    release.bundleManifestHash !== selected.bundleManifestHash ||
    release.cliVersion !== cliVersion ||
    (release.skillProtocol !== null &&
      (!Number.isSafeInteger(release.skillProtocol) || (release.skillProtocol as number) < 1)) ||
    canonicalizeJson(options.bundle as JsonValue) !== canonicalizeJson(selected.bundle)
  ) {
    throw compositionError("prepared context is not bound to the selected Bundle release");
  }
  return Object.freeze({
    operation: options.operation as ExternalContextReadOptions["operation"],
    gitlabOrigin: origin,
    targetProject: options.targetProject,
    mrIid: options.mrIid as number | null,
    issueIid: options.issueIid as number | null,
    git: gitSnapshot,
    bundle: selected.bundle,
    release: deepFreeze({
      releaseSetId: selected.releaseSetId,
      releaseTag: selected.releaseTag,
      bundleManifestHash: selected.bundleManifestHash,
      cliVersion,
      skillProtocol: release.skillProtocol as number | null,
    }),
    gitlab: options.gitlab as PreparedExternalContextReadOptions["gitlab"],
  });
}

function snapshotProfileDetection(value: ReadOnlyProfileDetection): ReadOnlyProfileDetection {
  const profile = jsonSnapshot(value, ["kind", "profileIds", "reasons"]);
  if (profile.kind !== "detected" && profile.kind !== "ambiguous") {
    throw compositionError("profile detection discriminant is invalid");
  }
  const profileIds = stringArray(profile.profileIds, "profile selection");
  if (profileIds.some((id) => !(PROFILE_IDS as readonly string[]).includes(id))) {
    throw compositionError("profile detection returned an unknown profile");
  }
  if ((profile.kind === "detected") !== (profileIds.length > 0)) {
    throw compositionError("profile detection selection is inconsistent");
  }
  if (!Array.isArray(profile.reasons) || profile.reasons.length === 0) {
    throw compositionError("profile detection reasons are unavailable");
  }
  const reasons = profile.reasons.map((reason) => {
    const expected = profile.kind === "detected" ? ["code", "profileId"] : ["code", "itemIndex"];
    const entry = jsonSnapshot(reason, expected);
    if (typeof entry.code !== "string" || !scalar(entry.code)) {
      throw compositionError("profile detection reason code is invalid");
    }
    if (profile.kind === "detected") {
      if (typeof entry.profileId !== "string" || !profileIds.includes(entry.profileId)) {
        throw compositionError("profile detection reason profile is invalid");
      }
    } else if (entry.itemIndex !== null &&
      (!Number.isSafeInteger(entry.itemIndex) || (entry.itemIndex as number) < 0)) {
      throw compositionError("profile detection reason item index is invalid");
    }
    return deepFreeze(entry);
  });
  return deepFreeze({ kind: profile.kind, profileIds, reasons }) as ReadOnlyProfileDetection;
}

function snapshotGitDiffSummary(value: JsonObject): JsonObject {
  const summary = jsonSnapshot(value, [
    "changedFileCount",
    "targetRefSha",
    "mergeBaseSha",
    "sourceHeadSha",
  ]);
  if (!Number.isSafeInteger(summary.changedFileCount) || (summary.changedFileCount as number) < 0) {
    throw compositionError("Git diff summary count is invalid");
  }
  objectId(summary.targetRefSha, "Git diff target ref SHA");
  objectId(summary.mergeBaseSha, "Git diff merge-base SHA");
  objectId(summary.sourceHeadSha, "Git diff source HEAD SHA");
  return deepFreeze(summary);
}

function snapshotPushPlan(value: ReadOnlyPushPlan): ReadOnlyPushPlan {
  const plan = jsonSnapshot(value, ["kind", "remote", "ref", "sourceHeadSha", "remoteSha", "command"]);
  if (!["up-to-date", "missing", "behind", "blocked"].includes(String(plan.kind)) ||
      typeof plan.remote !== "string" || !REMOTE_NAME.test(plan.remote) ||
      typeof plan.ref !== "string" || !plan.ref.startsWith("refs/heads/") ||
      (plan.command !== null && (typeof plan.command !== "string" || !scalar(plan.command)))) {
    throw compositionError("push plan fields are invalid");
  }
  const sourceHeadSha = objectId(plan.sourceHeadSha, "push-plan source HEAD SHA");
  const remoteSha = plan.remoteSha === null ? null : objectId(plan.remoteSha, "push-plan remote SHA");
  if (
    (plan.kind === "up-to-date" && (remoteSha !== sourceHeadSha || plan.command !== null)) ||
    (plan.kind === "missing" && (remoteSha !== null || plan.command === null)) ||
    (plan.kind === "behind" && (remoteSha === null || plan.command === null))
  ) {
    throw compositionError("push plan discriminant is inconsistent");
  }
  return deepFreeze({
    kind: plan.kind,
    remote: plan.remote,
    ref: plan.ref,
    sourceHeadSha,
    remoteSha,
    command: plan.command,
  }) as ReadOnlyPushPlan;
}

function snapshotMergeRequestPlan(
  value: ReadOnlyMergeRequestPlan,
  gitlabOrigin: string,
): ReadOnlyMergeRequestPlan {
  const plan = jsonSnapshot(value, ["action", "iid", "webUrl"]);
  if (plan.action !== "create" && plan.action !== "update") {
    throw compositionError("merge request plan action is invalid");
  }
  if ((plan.action === "create" && (plan.iid !== null || plan.webUrl !== null)) ||
      (plan.action === "update" && (!positiveIid(plan.iid) || typeof plan.webUrl !== "string"))) {
    throw compositionError("merge request plan identity is inconsistent");
  }
  if (plan.webUrl !== null) {
    try {
      const url = new URL(plan.webUrl as string);
      const loopbackHttp = url.protocol === "http:" &&
        ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase());
      if (
        (url.protocol !== "https:" && !loopbackHttp) ||
        url.origin !== gitlabOrigin ||
        url.username !== "" ||
        url.password !== "" ||
        url.href !== plan.webUrl
      ) {
        throw new TypeError("url");
      }
    } catch {
      throw compositionError("merge request plan URL is invalid");
    }
  }
  return deepFreeze({
    action: plan.action,
    iid: plan.iid as number | null,
    webUrl: plan.webUrl as string | null,
  });
}

function snapshotMigration(value: ReadOnlyMigrationMetadata): ReadOnlyMigrationMetadata {
  const migration = jsonSnapshot(value, [
    "oldReleaseTag",
    "newReleaseTag",
    "oldBundleManifestHash",
    "newBundleManifestHash",
    "oldPolicySchema",
    "newPolicySchema",
    "historicalBundleEol",
  ]);
  if (
    typeof migration.oldReleaseTag !== "string" || !scalar(migration.oldReleaseTag) ||
    typeof migration.newReleaseTag !== "string" || !scalar(migration.newReleaseTag) ||
    typeof migration.oldBundleManifestHash !== "string" || !LOWER_SHA256.test(migration.oldBundleManifestHash) ||
    typeof migration.newBundleManifestHash !== "string" || !LOWER_SHA256.test(migration.newBundleManifestHash) ||
    !Number.isSafeInteger(migration.oldPolicySchema) || (migration.oldPolicySchema as number) < 1 ||
    !Number.isSafeInteger(migration.newPolicySchema) || (migration.newPolicySchema as number) < 1 ||
    typeof migration.historicalBundleEol !== "boolean"
  ) {
    throw compositionError("migration metadata is invalid");
  }
  return deepFreeze(migration) as unknown as ReadOnlyMigrationMetadata;
}

function validatePreparedContext(
  dependencies: ReadOnlyCommandDependencies,
  command: ReadOnlyCommandKind,
  invocation: CliInvocation,
  prepared: PreparedReadOnlyContext,
  request: Request | null,
): PreparedReadOnlyContext {
  const value = exactObject(prepared, [
    "assertNoCredentialExposure",
    "selection",
    "options",
    "profileDetection",
    "gitDiffSummary",
    "pushPlan",
    "mergeRequestPlan",
  ], ["migration"]);
  if (typeof value.assertNoCredentialExposure !== "function") {
    throw compositionError("prepared context credential isolation is unavailable");
  }
  const assertNoCredentialExposure = (input: unknown): void => {
    try {
      (value.assertNoCredentialExposure as PreparedReadOnlyContext["assertNoCredentialExposure"])(input);
    } catch {
      throw compositionError("prepared context failed credential isolation");
    }
  };
  const current = verifiedSelection(dependencies.currentBundle);
  const selected = verifiedSelection(value.selection as TrustedBundleSelection);
  if (
    (command !== "context" ||
      invocation.command.kind !== "context" ||
      invocation.command.mrIid === null) &&
    !sameSelection(current, selected)
  ) {
    throw compositionError("a current-Bundle command selected another release");
  }
  if (command === "context" && invocation.command.kind === "context" &&
      invocation.command.migrateTemplate && !sameSelection(current, selected)) {
    throw compositionError("migration context did not select the current Bundle");
  }
  const options = snapshotOptions(
    value.options as PreparedExternalContextReadOptions,
    selected,
    dependencies.cliVersion,
  );
  const operation = expectedOperation(command, invocation);
  if (options.operation !== operation) {
    throw compositionError("prepared context operation is inconsistent");
  }
  if (command === "context" && invocation.command.kind === "context") {
    if (options.mrIid !== invocation.command.mrIid ||
        options.issueIid !== (dependencies.contextIssueIid ?? null)) {
      throw compositionError("prepared context MR is inconsistent");
    }
    if (invocation.command.migrateTemplate && value.migration === undefined) {
      throw compositionError("migration context is unavailable");
    }
    if (!invocation.command.migrateTemplate && value.migration !== undefined) {
      throw compositionError("unexpected migration context was returned");
    }
  } else if (options.mrIid !== null || value.migration !== undefined ||
      options.issueIid !== requestIssueIid(request)) {
    throw compositionError("non-context command received MR migration state");
  }
  const profileDetection = snapshotProfileDetection(value.profileDetection as ReadOnlyProfileDetection);
  if (request !== null && canonicalizeJson(profileDetection.profileIds) !== canonicalizeJson(request.profileIds)) {
    throw compositionError("preview profile selection differs from the normalized Request");
  }
  const mergeRequestPlan = snapshotMergeRequestPlan(
    value.mergeRequestPlan as ReadOnlyMergeRequestPlan,
    options.gitlabOrigin,
  );
  const expectedMrIid = command === "context" && invocation.command.kind === "context"
    ? invocation.command.mrIid
    : null;
  if ((expectedMrIid === null) !== (mergeRequestPlan.action === "create") ||
      (expectedMrIid !== null && mergeRequestPlan.iid !== expectedMrIid)) {
    throw compositionError("merge request plan does not match the invocation");
  }
  const gitDiffSummary = snapshotGitDiffSummary(value.gitDiffSummary as JsonObject);
  if (
    gitDiffSummary.targetRefSha !== options.git.targetRefSha ||
    gitDiffSummary.mergeBaseSha !== options.git.mergeBaseSha ||
    gitDiffSummary.sourceHeadSha !== options.git.sourceHeadSha
  ) {
    throw compositionError("Git diff summary is not bound to the prepared repository snapshot");
  }
  const pushPlan = snapshotPushPlan(value.pushPlan as ReadOnlyPushPlan);
  if (
    pushPlan.remote !== options.git.sourceRemote ||
    pushPlan.ref !== options.git.sourceRemoteRef ||
    pushPlan.sourceHeadSha !== options.git.sourceHeadSha
  ) {
    throw compositionError("push plan is not bound to the prepared repository snapshot");
  }
  if (
    (pushPlan.kind === "up-to-date" && pushPlan.command !== null) ||
    ((pushPlan.kind === "missing" || pushPlan.kind === "behind") &&
      pushPlan.command !== `git push --no-force ${pushPlan.remote} ${pushPlan.sourceHeadSha}:${pushPlan.ref}`)
  ) {
    throw compositionError("push command is not bound to the prepared push plan");
  }
  const migration = value.migration === undefined
    ? undefined
    : snapshotMigration(value.migration as ReadOnlyMigrationMetadata);
  const validated = {
    assertNoCredentialExposure: Object.freeze(assertNoCredentialExposure),
    selection: selected,
    options,
    profileDetection,
    gitDiffSummary,
    pushPlan,
    mergeRequestPlan,
    ...(migration === undefined
      ? {}
      : { migration }),
  };
  assertNoCredentialExposure({
    selection: validated.selection,
    options: {
      operation: options.operation,
      gitlabOrigin: options.gitlabOrigin,
      targetProject: options.targetProject,
      mrIid: options.mrIid,
      issueIid: options.issueIid,
      git: options.git,
      bundle: options.bundle,
      release: options.release,
    },
    profileDetection,
    gitDiffSummary,
    pushPlan,
    mergeRequestPlan,
    ...(migration === undefined ? {} : { migration }),
  });
  return Object.freeze(validated);
}

async function prepare(
  dependencies: ReadOnlyCommandDependencies,
  command: ReadOnlyCommandKind,
  invocation: CliInvocation,
  request: Request | null,
): Promise<PreparedReadOnlyContext> {
  const prepared = await dependencies.planner.prepare({
    cliVersion: dependencies.cliVersion,
    command,
    currentBundle: dependencies.currentBundle,
    cwd: dependencies.cwd,
    invocation,
    request,
    contextIssueIid: command === "context" ? dependencies.contextIssueIid ?? null : null,
  });
  return validatePreparedContext(dependencies, command, invocation, prepared, request);
}

function executionContext(
  selection: TrustedBundleSelection,
): NonNullable<CliCommandExecution["context"]> {
  return {
    versions: {
      templateVersion: selection.bundle.manifest.version,
      bundleHash: selection.bundleManifestHash,
      releaseSetId: selection.releaseSetId,
      inputSchema: selection.bundle.manifest.inputSchema,
      policySchema: selection.bundle.manifest.policySchema,
    },
  };
}

function profiles(selection: TrustedBundleSelection): JsonObject {
  return Object.fromEntries(PROFILE_IDS.map((id) => [
    id,
    copyJsonValue(selection.bundle.profiles[id]),
  ])) as JsonObject;
}

function planData(prepared: PreparedReadOnlyContext): {
  readonly profileDetection: JsonObject;
  readonly gitDiffSummary: JsonObject;
  readonly pushPlan: JsonObject;
  readonly mergeRequestPlan: JsonObject;
} {
  return {
    profileDetection: copyJsonValue(prepared.profileDetection as unknown as JsonObject) as JsonObject,
    gitDiffSummary: copyJsonValue(prepared.gitDiffSummary) as JsonObject,
    pushPlan: copyJsonValue(prepared.pushPlan as unknown as JsonObject) as JsonObject,
    mergeRequestPlan: copyJsonValue(prepared.mergeRequestPlan as unknown as JsonObject) as JsonObject,
  };
}

function snapshotBinding(value: ContextBinding): ContextBinding {
  const binding = jsonSnapshot(value, [
    "operation",
    "gitlabOrigin",
    "targetProject",
    "targetBranch",
    "sourceProject",
    "sourceBranch",
    "sourceHeadSha",
    "targetRefSha",
    "mrIid",
    "releaseSetId",
    "cliVersion",
    "bundle",
    "protocols",
  ]);
  if (!["create", "update", "migrate"].includes(String(binding.operation)) ||
      typeof binding.targetBranch !== "string" || !scalar(binding.targetBranch) ||
      typeof binding.sourceBranch !== "string" || !scalar(binding.sourceBranch) ||
      (binding.mrIid !== null && !positiveIid(binding.mrIid)) ||
      typeof binding.releaseSetId !== "string" || !scalar(binding.releaseSetId) ||
      typeof binding.cliVersion !== "string" || !scalar(binding.cliVersion)) {
    throw compositionError("external context binding fields are invalid");
  }
  const targetProject = jsonSnapshot(binding.targetProject, ["id", "fullPath"]);
  const sourceProject = jsonSnapshot(binding.sourceProject, ["id", "fullPath"]);
  for (const project of [targetProject, sourceProject]) {
    if (typeof project.id !== "string" || !scalar(project.id) ||
        typeof project.fullPath !== "string" || !scalar(project.fullPath)) {
      throw compositionError("external context project identity is invalid");
    }
  }
  const bundle = jsonSnapshot(binding.bundle, ["id", "version", "releaseTag", "manifestHash"]);
  if (typeof bundle.id !== "string" || !scalar(bundle.id) ||
      typeof bundle.version !== "string" || !scalar(bundle.version) ||
      typeof bundle.releaseTag !== "string" || !scalar(bundle.releaseTag) ||
      typeof bundle.manifestHash !== "string" || !LOWER_SHA256.test(bundle.manifestHash)) {
    throw compositionError("external context Bundle binding is invalid");
  }
  const protocols = jsonSnapshot(binding.protocols, ["inputSchema", "policySchema", "skillProtocol"]);
  if (!Number.isSafeInteger(protocols.inputSchema) || (protocols.inputSchema as number) < 1 ||
      !Number.isSafeInteger(protocols.policySchema) || (protocols.policySchema as number) < 1 ||
      (protocols.skillProtocol !== null &&
        (!Number.isSafeInteger(protocols.skillProtocol) || (protocols.skillProtocol as number) < 1))) {
    throw compositionError("external context protocol binding is invalid");
  }
  return deepFreeze({
    operation: binding.operation,
    gitlabOrigin: canonicalOrigin(binding.gitlabOrigin),
    targetProject: { id: targetProject.id, fullPath: targetProject.fullPath },
    targetBranch: binding.targetBranch,
    sourceProject: { id: sourceProject.id, fullPath: sourceProject.fullPath },
    sourceBranch: binding.sourceBranch,
    sourceHeadSha: objectId(binding.sourceHeadSha, "binding source HEAD SHA"),
    targetRefSha: objectId(binding.targetRefSha, "binding target ref SHA"),
    mrIid: binding.mrIid,
    releaseSetId: binding.releaseSetId,
    cliVersion: binding.cliVersion,
    bundle: {
      id: bundle.id,
      version: bundle.version,
      releaseTag: bundle.releaseTag,
      manifestHash: bundle.manifestHash,
    },
    protocols: {
      inputSchema: protocols.inputSchema,
      policySchema: protocols.policySchema,
      skillProtocol: protocols.skillProtocol,
    },
  }) as unknown as ContextBinding;
}

function snapshotAudit(value: unknown): { readonly requestIds: readonly string[] } {
  const audit = jsonSnapshot(value, ["requestIds"]);
  return deepFreeze({ requestIds: stringArray(audit.requestIds, "GitLab request audit") });
}

function snapshotLifecycle(value: unknown): {
  readonly draft: string;
  readonly ready: string;
  readonly merge: string;
} {
  const lifecycle = jsonSnapshot(value, ["draft", "ready", "merge"]);
  if (typeof lifecycle.draft !== "string" || !scalar(lifecycle.draft) ||
      typeof lifecycle.ready !== "string" || !scalar(lifecycle.ready) ||
      typeof lifecycle.merge !== "string" || !scalar(lifecycle.merge)) {
    throw compositionError("lifecycle label names are invalid");
  }
  return deepFreeze({
    draft: lifecycle.draft,
    ready: lifecycle.ready,
    merge: lifecycle.merge,
  });
}

function snapshotCandidate(value: unknown): Candidate {
  const base = jsonSnapshot(value, ["kind"], [
    "restId", "globalId", "name", "description", "color", "scopeKind", "scopeId",
    "scopePath", "policyCategory", "userId", "username", "displayName",
  ]);
  if (base.kind === "label") {
    exactObject(base, [
      "kind", "restId", "globalId", "name", "description", "color", "scopeKind",
      "scopeId", "scopePath", "policyCategory",
    ]);
    if (!positiveIid(base.restId) || typeof base.globalId !== "string" || !scalar(base.globalId) ||
        typeof base.name !== "string" || !scalar(base.name) ||
        typeof base.description !== "string" || /[\r\u0000]/u.test(base.description) ||
        typeof base.color !== "string" || !/^#[A-Fa-f0-9]{6}$/u.test(base.color) ||
        (base.scopeKind !== "project" && base.scopeKind !== "group") ||
        typeof base.scopeId !== "string" || !scalar(base.scopeId) ||
        typeof base.scopePath !== "string" || !scalar(base.scopePath) ||
        typeof base.policyCategory !== "string" || !scalar(base.policyCategory)) {
      throw compositionError("label candidate fields are invalid");
    }
    return deepFreeze(base) as unknown as Candidate;
  }
  if (base.kind === "assignee" || base.kind === "reviewer") {
    exactObject(base, ["kind", "userId", "globalId", "username", "displayName"]);
    if (typeof base.userId !== "string" || !scalar(base.userId) ||
        (base.globalId !== null && (typeof base.globalId !== "string" || !scalar(base.globalId))) ||
        typeof base.username !== "string" || !scalar(base.username) ||
        typeof base.displayName !== "string" || !scalar(base.displayName)) {
      throw compositionError("user candidate fields are invalid");
    }
    return deepFreeze(base) as unknown as Candidate;
  }
  throw compositionError("candidate discriminant is invalid");
}

function snapshotCandidateArray(value: unknown): readonly Candidate[] {
  if (!Array.isArray(value)) throw compositionError("candidate inventory is not an array");
  const candidates = value.map(snapshotCandidate);
  const identities = candidates.map((candidate) => candidate.kind === "label"
    ? `${candidate.kind}:${candidate.globalId}`
    : `${candidate.kind}:${candidate.userId}`);
  if (new Set(identities).size !== identities.length) {
    throw compositionError("candidate inventory contains duplicate identities");
  }
  return Object.freeze(candidates);
}

function snapshotContextLabelCandidate(value: unknown): DiscoveredContext["labelCandidates"][number] {
  const candidate = jsonSnapshot(value, [
    "token", "category", "name", "description", "scopeKind", "scopePath", "currentlyApplied",
  ]);
  if (typeof candidate.token !== "string" || !CANDIDATE_BEARER.test(candidate.token) ||
      typeof candidate.category !== "string" || !scalar(candidate.category) ||
      typeof candidate.name !== "string" || !scalar(candidate.name) ||
      typeof candidate.description !== "string" || /[\r\u0000]/u.test(candidate.description) ||
      (candidate.scopeKind !== "project" && candidate.scopeKind !== "group") ||
      typeof candidate.scopePath !== "string" || !scalar(candidate.scopePath) ||
      typeof candidate.currentlyApplied !== "boolean") {
    throw compositionError("issued label candidate fields are invalid");
  }
  return deepFreeze(candidate) as unknown as DiscoveredContext["labelCandidates"][number];
}

function snapshotContextUserCandidate(value: unknown): DiscoveredContext["userCandidates"][number] {
  const candidate = jsonSnapshot(value, [
    "token", "kind", "username", "displayName", "currentlyApplied", "defaultSelected",
    "qualifiedReviewer",
  ]);
  if (typeof candidate.token !== "string" || !CANDIDATE_BEARER.test(candidate.token) ||
      (candidate.kind !== "assignee" && candidate.kind !== "reviewer") ||
      typeof candidate.username !== "string" || !scalar(candidate.username) ||
      typeof candidate.displayName !== "string" || !scalar(candidate.displayName) ||
      typeof candidate.currentlyApplied !== "boolean" ||
      typeof candidate.defaultSelected !== "boolean" ||
      typeof candidate.qualifiedReviewer !== "boolean") {
    throw compositionError("issued user candidate fields are invalid");
  }
  return deepFreeze(candidate) as unknown as DiscoveredContext["userCandidates"][number];
}

function validateContextCore(
  prepared: PreparedReadOnlyContext,
  binding: ContextBinding,
  snapshotValue: JsonValue,
): ExternalContextSnapshot {
  const options = prepared.options;
  const selection = prepared.selection;
  if (
    binding.operation !== options.operation ||
    binding.gitlabOrigin !== options.gitlab.origin ||
    !scalar(binding.targetProject.id) ||
    binding.targetProject.fullPath !== options.targetProject ||
    binding.targetBranch !== options.git.targetBranch ||
    binding.sourceProject.id !== options.git.sourceProject.id ||
    binding.sourceProject.fullPath !== options.git.sourceProject.path ||
    binding.sourceBranch !== options.git.sourceBranch ||
    binding.sourceHeadSha !== options.git.sourceHeadSha ||
    binding.targetRefSha !== options.git.targetRefSha ||
    binding.mrIid !== options.mrIid ||
    binding.releaseSetId !== selection.releaseSetId ||
    binding.cliVersion !== options.release.cliVersion ||
    binding.bundle.id !== selection.bundle.manifest.bundleId ||
    binding.bundle.version !== selection.bundle.manifest.version ||
    binding.bundle.releaseTag !== selection.releaseTag ||
    binding.bundle.manifestHash !== selection.bundleManifestHash ||
    binding.protocols.inputSchema !== selection.bundle.manifest.inputSchema ||
    binding.protocols.policySchema !== selection.bundle.manifest.policySchema ||
    binding.protocols.skillProtocol !== options.release.skillProtocol
  ) {
    throw compositionError("external context binding is inconsistent");
  }
  const snapshot = validateExternalContextSnapshot(snapshotValue);
  if (
    snapshot.targetProject.id !== binding.targetProject.id ||
    snapshot.targetProject.path !== binding.targetProject.fullPath ||
    snapshot.sourceProject.id !== binding.sourceProject.id ||
    snapshot.sourceProject.path !== binding.sourceProject.fullPath ||
    snapshot.targetRefSha !== binding.targetRefSha ||
    snapshot.mergeBaseSha !== options.git.mergeBaseSha ||
    snapshot.sourceHeadSha !== binding.sourceHeadSha ||
    snapshot.mergeRequest.iid !== binding.mrIid
  ) {
    throw compositionError("external context snapshot is inconsistent");
  }
  return snapshot;
}

function validateDiscoveredContext(
  prepared: PreparedReadOnlyContext,
  discovered: DiscoveredContext,
): DiscoveredContext {
  const value = jsonSnapshot(discovered, [
    "contextId", "createdAtMs", "expiresAtMs", "binding", "snapshot", "labelCandidates",
    "userCandidates", "requiredLabelCategories", "lifecycleLabelNames", "audit",
  ]);
  if (
    typeof value.contextId !== "string" || !CONTEXT_BEARER.test(value.contextId) ||
    !Number.isSafeInteger(value.createdAtMs) ||
    !Number.isSafeInteger(value.expiresAtMs) ||
    (value.createdAtMs as number) < 0 ||
    (value.expiresAtMs as number) <= (value.createdAtMs as number)
  ) {
    throw compositionError("issued context bearer or lifetime is invalid");
  }
  if (!Array.isArray(value.labelCandidates) || !Array.isArray(value.userCandidates)) {
    throw compositionError("issued context candidates are not arrays");
  }
  const labelCandidates = value.labelCandidates.map(snapshotContextLabelCandidate);
  const userCandidates = value.userCandidates.map(snapshotContextUserCandidate);
  const candidateTokens = [...labelCandidates, ...userCandidates].map((candidate) => candidate.token);
  if (
    candidateTokens.some((token) => !CANDIDATE_BEARER.test(token)) ||
    new Set(candidateTokens).size !== candidateTokens.length
  ) {
    throw compositionError("issued candidate bearer contract is invalid");
  }
  const binding = snapshotBinding(value.binding as unknown as ContextBinding);
  const snapshot = validateContextCore(prepared, binding, value.snapshot as JsonValue);
  return deepFreeze({
    contextId: value.contextId,
    createdAtMs: value.createdAtMs,
    expiresAtMs: value.expiresAtMs,
    binding,
    snapshot,
    labelCandidates,
    userCandidates,
    requiredLabelCategories: stringArray(value.requiredLabelCategories, "required label categories"),
    lifecycleLabelNames: snapshotLifecycle(value.lifecycleLabelNames),
    audit: snapshotAudit(value.audit),
  }) as unknown as DiscoveredContext;
}

function containsRawBearer(value: JsonValue): boolean {
  if (typeof value === "string") {
    return CONTEXT_BEARER.test(value) || CANDIDATE_BEARER.test(value);
  }
  if (Array.isArray(value)) return value.some(containsRawBearer);
  if (value !== null && typeof value === "object") {
    return Object.values(value).some(containsRawBearer);
  }
  return false;
}

function validateLiveContext(
  prepared: PreparedReadOnlyContext,
  live: ExternalContextReadResult,
): ExternalContextReadResult {
  const copied = jsonSnapshot(live, [
    "binding", "snapshot", "candidates", "requiredLabelCategories", "lifecycleLabelNames", "audit",
  ]);
  if (
    containsRawBearer(copied) ||
    Object.prototype.hasOwnProperty.call(copied, "contextId")
  ) {
    throw compositionError("tokenless external context contains a bearer");
  }
  const binding = snapshotBinding(copied.binding as unknown as ContextBinding);
  const snapshot = validateContextCore(prepared, binding, copied.snapshot as JsonValue);
  return deepFreeze({
    binding,
    snapshot,
    candidates: snapshotCandidateArray(copied.candidates),
    requiredLabelCategories: stringArray(copied.requiredLabelCategories, "required label categories"),
    lifecycleLabelNames: snapshotLifecycle(copied.lifecycleLabelNames),
    audit: snapshotAudit(copied.audit),
  });
}

function contextSnapshotData(snapshot: ExternalContextSnapshot): JsonObject {
  return {
    snapshotVersion: snapshot.snapshotVersion,
    targetProject: copyJsonValue(snapshot.targetProject as unknown as JsonObject),
    sourceProject: copyJsonValue(snapshot.sourceProject as unknown as JsonObject),
    targetRefSha: snapshot.targetRefSha,
    mergeBaseSha: snapshot.mergeBaseSha,
    sourceHeadSha: snapshot.sourceHeadSha,
    issue: copyJsonValue(snapshot.issue as unknown as JsonObject),
    labelCandidates: copyJsonValue(snapshot.labelCandidates as unknown as JsonValue),
    userCandidates: copyJsonValue(snapshot.userCandidates as unknown as JsonValue),
    mergeRequest: copyJsonValue(snapshot.mergeRequest as unknown as JsonObject),
    localChecks: {
      commitConvention: copyJsonValue(snapshot.localChecks.commitConvention as unknown as JsonObject),
      contentSafetyScan: copyJsonValue(snapshot.localChecks.secretScan as unknown as JsonObject),
      repositoryHygiene: copyJsonValue(snapshot.localChecks.repositoryHygiene as unknown as JsonObject),
    },
    metadataRead: copyJsonValue(snapshot.metadataRead as unknown as JsonObject),
    ci: copyJsonValue(snapshot.ci as unknown as JsonObject),
    review: copyJsonValue(snapshot.review as unknown as JsonObject),
  };
}

function contextExecution(
  prepared: PreparedReadOnlyContext,
  discovered: DiscoveredContext,
): CliCommandExecution {
  return {
    context: executionContext(prepared.selection),
    output: {
      data: {
        command: "context",
        contextId: discovered.contextId,
        createdAtMs: discovered.createdAtMs,
        expiresAtMs: discovered.expiresAtMs,
        releaseTag: prepared.selection.releaseTag,
        bundleId: prepared.selection.bundle.manifest.bundleId,
        inputSchema: copyJsonValue(prepared.selection.bundle.schema),
        profiles: profiles(prepared.selection),
        ...planData(prepared),
        binding: copyJsonValue(discovered.binding as unknown as JsonObject),
        snapshot: contextSnapshotData(discovered.snapshot),
        labelCandidates: copyJsonValue(discovered.labelCandidates as unknown as JsonValue),
        userCandidates: copyJsonValue(discovered.userCandidates as unknown as JsonValue),
        requiredLabelCategories: [...discovered.requiredLabelCategories],
        lifecycleLabelNames: copyJsonValue(discovered.lifecycleLabelNames as unknown as JsonObject),
        audit: copyJsonValue(discovered.audit as unknown as JsonObject),
        ...(prepared.migration === undefined
          ? {}
          : { migration: copyJsonValue(prepared.migration) }),
      },
    },
  };
}

function labelData(
  candidate: Extract<Candidate, { readonly kind: "label" }>,
  currentlyApplied: ReadonlySet<string>,
): JsonObject {
  return {
    id: candidate.globalId,
    restId: candidate.restId,
    name: candidate.name,
    description: candidate.description,
    color: candidate.color,
    category: candidate.policyCategory,
    scopeKind: candidate.scopeKind,
    scopeId: candidate.scopeId,
    scopePath: candidate.scopePath,
    currentlyApplied: currentlyApplied.has(candidate.globalId),
  };
}

function labelsExecution(
  prepared: PreparedReadOnlyContext,
  live: Awaited<ReturnType<ExternalContextReader["read"]>>,
): CliCommandExecution {
  const applied = new Set(live.snapshot.mergeRequest.labelIds);
  const labels = live.candidates
    .filter((candidate): candidate is Extract<Candidate, { readonly kind: "label" }> =>
      candidate.kind === "label")
    .map((candidate) => labelData(candidate, applied))
    .sort((left, right) => {
      const leftKey = `${String(left.category)}\u0000${String(left.name)}\u0000${String(left.id)}`;
      const rightKey = `${String(right.category)}\u0000${String(right.name)}\u0000${String(right.id)}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  return {
    context: executionContext(prepared.selection),
    output: {
      data: {
        command: "labels.list",
        releaseTag: prepared.selection.releaseTag,
        bundleId: prepared.selection.bundle.manifest.bundleId,
        targetProject: copyJsonValue(live.binding.targetProject as unknown as JsonObject),
        targetBranch: live.binding.targetBranch,
        labels,
        requiredLabelCategories: [...live.requiredLabelCategories],
        lifecycleLabelNames: copyJsonValue(live.lifecycleLabelNames as unknown as JsonObject),
        audit: copyJsonValue(live.audit as unknown as JsonObject),
      },
    },
  };
}

function selectedLabelProjection(
  plan: MergeRequestWritePlan,
  snapshot: ExternalContextSnapshot,
): readonly { readonly id: string; readonly name: string }[] {
  const byId = new Map(snapshot.labelCandidates.map((entry) => [entry.id, entry.name] as const));
  return plan.desired.labelIds.map((id) => {
    const name = byId.get(id);
    if (name === undefined) throw compositionError("preview label projection is incomplete");
    return { id, name };
  });
}

function selectedUserProjection(
  ids: readonly string[],
  snapshot: ExternalContextSnapshot,
): readonly { readonly id: string; readonly username: string; readonly displayName: string }[] {
  const byId = new Map(snapshot.userCandidates.map((entry) => [entry.id, entry] as const));
  return ids.map((id) => {
    const entry = byId.get(id);
    if (entry === undefined) throw compositionError("preview user projection is incomplete");
    return { id, username: entry.username, displayName: entry.displayName };
  });
}

function previewExecution(
  prepared: PreparedReadOnlyContext,
  request: Request,
  snapshot: ExternalContextSnapshot,
  resolved: PreviewCandidateResolution,
  plan: MergeRequestWritePlan,
  description: string,
  audit: { readonly requestIds: readonly string[] },
): CliCommandExecution {
  const labels = selectedLabelProjection(plan, snapshot);
  const assignees = plan.desired.assigneeUserId === null
    ? []
    : selectedUserProjection([plan.desired.assigneeUserId], snapshot);
  const reviewers = selectedUserProjection(plan.desired.reviewerUserIds, snapshot);
  return {
    context: executionContext(prepared.selection),
    output: {
      data: {
        command: "preview",
        releaseTag: prepared.selection.releaseTag,
        bundleId: prepared.selection.bundle.manifest.bundleId,
        profileIds: [...request.profileIds],
        profileSelectionReasons: copyJsonValue(prepared.profileDetection.reasons as unknown as JsonValue),
        title: renderTitle(request, prepared.selection.bundle),
        description,
        labels: copyJsonValue(labels as unknown as JsonValue),
        assignee: copyJsonValue((assignees[0] ?? null) as JsonValue),
        reviewers: copyJsonValue(reviewers as unknown as JsonValue),
        scopedLabelEffects: labels
          .filter((entry) => typeof entry.name === "string" && entry.name.includes("::"))
          .map((entry) => ({
            id: entry.id,
            name: entry.name,
            effect: "GitLab may replace another label in the same scope when this label is added.",
          })),
        candidateSelectionDigest: resolved.candidateSelectionDigest,
        writePlan: copyJsonValue(plan as unknown as JsonObject),
        validation: { valid: true, issues: [] },
        ...planData(prepared),
        audit: copyJsonValue(audit as unknown as JsonObject),
      },
    },
  };
}

function validatedDoctorReport(report: DoctorReport): DoctorReport {
  const value = jsonSnapshot(report, ["checks", "capabilities"], ["audit"]);
  if (!Array.isArray(value.checks)) throw compositionError("doctor checks are not an array");
  const ids = new Set<string>();
  const checks = value.checks.map((checkValue) => {
    const check = jsonSnapshot(checkValue, ["id", "status", "detail"]);
    if (
      typeof check.id !== "string" || !scalar(check.id) ||
      typeof check.detail !== "string" || !scalar(check.detail) ||
      typeof check.status !== "string" ||
      !["passed", "warning", "failed"].includes(check.status) ||
      ids.has(check.id)
    ) {
      throw compositionError("doctor report contains an invalid check");
    }
    ids.add(check.id);
    return deepFreeze({ id: check.id, status: check.status, detail: check.detail });
  });
  const capabilities = jsonSnapshot(value.capabilities, [] , Object.keys(
    value.capabilities !== null && typeof value.capabilities === "object" && !Array.isArray(value.capabilities)
      ? value.capabilities
      : {},
  ));
  if (
    Object.entries(capabilities).some(([id, capability]) =>
      !scalar(id) || typeof capability !== "boolean")
  ) {
    throw compositionError("doctor report contains an invalid capability");
  }
  return deepFreeze({
    checks,
    capabilities,
    ...(value.audit === undefined ? {} : { audit: snapshotAudit(value.audit) }),
  }) as unknown as DoctorReport;
}

function validatedCandidateResolution(value: PreviewCandidateResolution): PreviewCandidateResolution {
  const result = jsonSnapshot(value, [
    "binding",
    "snapshot",
    "candidates",
    "candidateSelectionDigest",
  ]);
  if (typeof result.candidateSelectionDigest !== "string" ||
      !LOWER_SHA256.test(result.candidateSelectionDigest)) {
    throw compositionError("candidate selection digest is invalid");
  }
  return deepFreeze({
    binding: snapshotBinding(result.binding as unknown as ContextBinding),
    snapshot: validateExternalContextSnapshot(result.snapshot) as unknown as JsonValue,
    candidates: snapshotCandidateArray(result.candidates),
    candidateSelectionDigest: result.candidateSelectionDigest,
  });
}

function assertIssueScope(
  dependencies: ReadOnlyCommandDependencies,
  command: "doctor" | ReadOnlyCommandKind,
): void {
  if ((dependencies.contextIssueIid ?? null) === null || command === "context") return;
  throw new ToolError("INPUT_ERROR", "The context issue option is not valid for this command", {
    field: "issue",
    expected: "an issue IID scoped only to the context command",
    actual: "out-of-scope issue option",
    safeNextStep: "Remove --issue or invoke the context command.",
  });
}

export function createReadOnlyCommandServices(
  dependencies: ReadOnlyCommandDependencies,
): Pick<ProductionCommandServices, "doctor" | "context" | "labelsList" | "preview"> {
  const externalContextReader = dependencies.externalContextReader ?? defaultExternalContextReader;
  const issueContext = dependencies.issueContext ?? getContext;
  return {
    doctor: async () => {
      assertIssueScope(dependencies, "doctor");
      const selection = verifiedSelection(dependencies.currentBundle);
      const report = validatedDoctorReport(await dependencies.doctorProbe.inspect({
        cliVersion: dependencies.cliVersion,
        currentBundle: selection,
        cwd: dependencies.cwd,
      }));
      return guardReadOnlySuccess("doctor", {
        context: executionContext(selection),
        output: {
          data: {
            command: "doctor",
            checks: copyJsonValue(report.checks as unknown as JsonValue),
            capabilities: copyJsonValue(report.capabilities as unknown as JsonObject),
            ...(report.audit === undefined
              ? {}
              : { audit: copyJsonValue(report.audit as unknown as JsonObject) }),
          },
        },
      });
    },
    context: async (invocation) => {
      assertIssueScope(dependencies, "context");
      const prepared = await prepare(dependencies, "context", invocation, null);
      const discoveredValue = await issueContext({
        ...prepared.options,
        store: dependencies.contextStore,
      });
      prepared.assertNoCredentialExposure(discoveredValue);
      const discovered = validateDiscoveredContext(prepared, discoveredValue);
      const execution = contextExecution(prepared, discovered);
      prepared.assertNoCredentialExposure(execution);
      return guardReadOnlySuccess("context", execution);
    },
    labelsList: async (invocation) => {
      assertIssueScope(dependencies, "labels.list");
      const prepared = await prepare(dependencies, "labels.list", invocation, null);
      const liveValue = await externalContextReader.read(prepared.options);
      prepared.assertNoCredentialExposure(liveValue);
      const live = validateLiveContext(prepared, liveValue);
      const execution = labelsExecution(prepared, live);
      prepared.assertNoCredentialExposure(execution);
      return guardReadOnlySuccess("labels.list", execution);
    },
    preview: async (invocation) => {
      assertIssueScope(dependencies, "preview");
      const request = normalizeProductionRequest(await dependencies.requestSource.read(invocation));
      const prepared = await prepare(dependencies, "preview", invocation, request);
      const liveValue = await externalContextReader.read(prepared.options);
      prepared.assertNoCredentialExposure(liveValue);
      const live = validateLiveContext(prepared, liveValue);
      if (request.targetBranch !== live.binding.targetBranch) throw inputMismatchError();
      const resolvedValue = await dependencies.resolveCandidates({
        request,
        expectedBinding: live.binding,
        store: dependencies.contextStore,
        consume: false,
      });
      prepared.assertNoCredentialExposure(resolvedValue);
      const resolved = validatedCandidateResolution(resolvedValue);
      if (
        canonicalizeJson(resolved.binding) !== canonicalizeJson(live.binding) ||
        canonicalizeJson(resolved.snapshot) !== canonicalizeJson(live.snapshot)
      ) {
        throw staleContextError();
      }
      const snapshot = validateExternalContextSnapshot(resolved.snapshot);
      const writePlan = buildWritePlan({
        request,
        snapshot,
        resolvedCandidates: resolved.candidates,
        bundle: prepared.selection.bundle,
      });
      const description = renderDescription({
        request,
        snapshot,
        writePlan: writePlan.desired,
        bundle: prepared.selection.bundle,
        releaseTag: prepared.selection.releaseTag,
        cliVersion: dependencies.cliVersion,
        renderPhase: "preview",
      });
      const execution = previewExecution(
        prepared,
        request,
        snapshot,
        resolved,
        writePlan,
        description,
        live.audit,
      );
      prepared.assertNoCredentialExposure(execution);
      return guardReadOnlySuccess("preview", execution);
    },
  };
}
