import {
  createMergeRequest,
  type CreateMergeRequestResult,
  type MergeRequestRemote,
  type RemoteMergeRequest,
} from "../../app/create-mr.ts";
import { resolveRequestCandidates } from "../../app/resolve-candidates.ts";
import {
  candidateSelectionDigest,
  remoteSnapshotDigest,
  remoteWriteFromTransactionAudit,
  validateTransactionAudit,
  type TransactionAuditV1,
  type TransactionReadAudit,
  type TransactionStepOperation,
} from "../../app/transaction-journal.ts";
import { isRemoteMutationError, isRemoteReadError } from "../../app/remote-outcome.ts";
import {
  updateMergeRequest,
  type UpdateMergeRequestResult,
} from "../../app/update-mr.ts";
import {
  verifyStoredMergeRequest,
  validateVerificationReceipt,
  type HistoricalBundleLoader,
  type MergeRequestVerificationResult,
  type VerificationLevel,
  type VerificationReceiptLoader,
  type VerificationReceiptWriter,
} from "../../app/verify-mr.ts";
import type { LoadedTemplateBundle } from "../../bundle/load.ts";
import { ToolError } from "../../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../../contracts/jcs.ts";
import type { Request } from "../../contracts/request.ts";
import type { CandidateContextStore } from "../../context/store.ts";
import type { Candidate, ContextBinding } from "../../context/types.ts";
import { normalizeAndValidateRequest } from "../../input/normalize.ts";
import {
  parseDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../render/marker.ts";
import type { CliCommandExecution } from "../execute.ts";

export interface PreparedMergeRequestCommandBase {
  readonly request: Request;
  readonly binding: ContextBinding;
  readonly bundle: LoadedTemplateBundle;
  readonly releaseTag: string;
  readonly cliVersion: string;
  readonly sourceBranch: string;
  readonly remote: MergeRequestRemote;
}

export interface PreparedCreateMergeRequestCommand extends PreparedMergeRequestCommandBase {
  readonly initialSnapshot: ExternalContextSnapshot;
}

export interface PreparedUpdateMergeRequestCommand extends PreparedMergeRequestCommandBase {
  readonly initial: RemoteMergeRequest;
}

export interface PreparedVerifyMergeRequestCommand {
  readonly current: RemoteMergeRequest;
}

export interface LiveCandidateIdentityInput {
  readonly binding: ContextBinding;
  readonly candidates: readonly Candidate[];
}

export interface MergeRequestCommandDomain {
  readonly create: typeof createMergeRequest;
  readonly update: typeof updateMergeRequest;
}

export interface MergeRequestCommandAdapterDependencies {
  readonly gitlabOrigin: string;
  readonly readCurrentBinding: (input: {
    readonly operation: "create" | "update";
    readonly mrIid: number | null;
    readonly remote: MergeRequestRemote;
  }) => Promise<ContextBinding>;
  readonly candidateStore: Pick<CandidateContextStore, "resolve">;
  readonly verifyLiveCandidateIdentities: (input: LiveCandidateIdentityInput) => Promise<void>;
  readonly verificationReceiptWriter: VerificationReceiptWriter;
  readonly verificationReceiptLoader: VerificationReceiptLoader;
  readonly historicalBundleLoader: HistoricalBundleLoader;
  readonly domain?: MergeRequestCommandDomain;
}

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function exactFields(value: JsonObject, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim() &&
    !/[\r\n\u0000]/u.test(value);
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotBinding(value: ContextBinding): ContextBinding {
  try {
    const copied = copyJsonValue(value, "$binding") as unknown as ContextBinding;
    const root = copied as unknown as JsonObject;
    const targetProject = copied.targetProject as unknown as JsonObject;
    const sourceProject = copied.sourceProject as unknown as JsonObject;
    const bundle = copied.bundle as unknown as JsonObject;
    const protocols = copied.protocols as unknown as JsonObject;
    if (!exactFields(root, [
      "operation", "gitlabOrigin", "targetProject", "targetBranch", "sourceProject",
      "sourceBranch", "sourceHeadSha", "targetRefSha", "mrIid", "releaseSetId",
      "cliVersion", "bundle", "protocols",
    ]) || !exactFields(targetProject, ["id", "fullPath"]) ||
        !exactFields(sourceProject, ["id", "fullPath"]) ||
        !exactFields(bundle, ["id", "version", "releaseTag", "manifestHash"]) ||
        !exactFields(protocols, ["inputSchema", "policySchema", "skillProtocol"]) ||
        !["create", "update", "migrate"].includes(copied.operation) ||
        !nonEmpty(copied.gitlabOrigin) || !nonEmpty(copied.targetProject.id) ||
        !nonEmpty(copied.targetProject.fullPath) || !nonEmpty(copied.targetBranch) ||
        !nonEmpty(copied.sourceProject.id) || !nonEmpty(copied.sourceProject.fullPath) ||
        !nonEmpty(copied.sourceBranch) || !SHA.test(copied.sourceHeadSha) ||
        !SHA.test(copied.targetRefSha) || !nonEmpty(copied.releaseSetId) ||
        !nonEmpty(copied.cliVersion) || !nonEmpty(copied.bundle.id) ||
        !nonEmpty(copied.bundle.version) || !nonEmpty(copied.bundle.releaseTag) ||
        !SHA256.test(copied.bundle.manifestHash) ||
        !positiveInteger(copied.protocols.inputSchema) ||
        !positiveInteger(copied.protocols.policySchema) ||
        (copied.protocols.skillProtocol !== null && !positiveInteger(copied.protocols.skillProtocol)) ||
        (copied.operation === "create" ? copied.mrIid !== null : !positiveInteger(copied.mrIid))) {
      throw preparedInputFailure();
    }
    const origin = new URL(copied.gitlabOrigin);
    if (!["http:", "https:"].includes(origin.protocol) || origin.username !== "" ||
        origin.password !== "" || origin.pathname !== "/" || origin.search !== "" ||
        origin.hash !== "" || origin.origin !== copied.gitlabOrigin) {
      throw preparedInputFailure();
    }
    return deepFreeze(copied);
  } catch (error) {
    if (error instanceof ToolError && error.code === "INTERNAL_ERROR") throw error;
    throw preparedInputFailure();
  }
}

function assertExactBinding(actual: ContextBinding, expected: ContextBinding): void {
  if (canonicalizeJson(actual) !== canonicalizeJson(expected)) throw preparedInputFailure();
}

const PREPARED_BASE_FIELDS = [
  "request", "binding", "bundle", "releaseTag", "cliVersion", "sourceBranch", "remote",
] as const;

function assertPreparedFields(value: object, extra: string): void {
  if (!exactFields(value as JsonObject, [...PREPARED_BASE_FIELDS, extra])) {
    throw preparedInputFailure();
  }
}

function assertRemotePort(remote: MergeRequestRemote): void {
  if (remote === null || typeof remote !== "object" ||
      typeof remote.findOpen !== "function" || typeof remote.read !== "function" ||
      typeof remote.createDraft !== "function" || typeof remote.addLabels !== "function" ||
      typeof remote.removeLabels !== "function" || typeof remote.writeManagedFields !== "function" ||
      typeof remote.writeDescription !== "function" || typeof remote.markReady !== "function" ||
      typeof remote.markDraft !== "function") {
    throw preparedInputFailure();
  }
}

function snapshotBundle(value: LoadedTemplateBundle): LoadedTemplateBundle {
  try {
    return deepFreeze(copyJsonValue(value, "$bundle") as unknown as LoadedTemplateBundle);
  } catch {
    throw preparedInputFailure();
  }
}

function snapshotRemoteMergeRequest(value: RemoteMergeRequest): RemoteMergeRequest {
  try {
    const copied = copyJsonValue(value, "$mergeRequest") as unknown as RemoteMergeRequest;
    const record = copied as unknown as JsonObject;
    if (!exactFields(record, [
      "iid", "webUrl", "title", "description", "draft", "state", "sourceProjectId",
      "sourceBranch", "targetProjectId", "targetBranch", "sourceHeadSha", "labelIds",
      "assigneeUserId", "reviewerUserIds", "squash", "removeSourceBranch", "snapshot",
    ]) || !positiveInteger(copied.iid) || !nonEmpty(copied.webUrl) ||
        typeof copied.title !== "string" || typeof copied.description !== "string" ||
        typeof copied.draft !== "boolean" || !["opened", "closed", "merged", "locked"].includes(copied.state) ||
        !nonEmpty(copied.sourceProjectId) || !nonEmpty(copied.sourceBranch) ||
        !nonEmpty(copied.targetProjectId) || !nonEmpty(copied.targetBranch) ||
        !SHA.test(copied.sourceHeadSha) || !Array.isArray(copied.labelIds) ||
        !copied.labelIds.every(nonEmpty) ||
        (copied.assigneeUserId !== null && !nonEmpty(copied.assigneeUserId)) ||
        !Array.isArray(copied.reviewerUserIds) || !copied.reviewerUserIds.every(nonEmpty) ||
        typeof copied.squash !== "boolean" || typeof copied.removeSourceBranch !== "boolean") {
      throw preparedInputFailure();
    }
    const snapshot = validateExternalContextSnapshot(copied.snapshot);
    return deepFreeze({ ...copied, snapshot });
  } catch (error) {
    if (error instanceof ToolError && error.code === "INTERNAL_ERROR") throw error;
    throw preparedInputFailure();
  }
}

function snapshotPreparedBase(value: PreparedMergeRequestCommandBase) {
  if (!nonEmpty(value.releaseTag) || !nonEmpty(value.cliVersion) || !nonEmpty(value.sourceBranch)) {
    throw preparedInputFailure();
  }
  assertRemotePort(value.remote);
  return {
    request: normalizeAndValidateRequest(copyJsonValue(value.request, "$request")),
    binding: snapshotBinding(value.binding),
    bundle: snapshotBundle(value.bundle),
    releaseTag: value.releaseTag,
    cliVersion: value.cliVersion,
    sourceBranch: value.sourceBranch,
    remote: value.remote,
  };
}

function snapshotPreparedCreate(value: PreparedCreateMergeRequestCommand): PreparedCreateMergeRequestCommand {
  assertPreparedFields(value, "initialSnapshot");
  return Object.freeze({
    ...snapshotPreparedBase(value),
    initialSnapshot: validateExternalContextSnapshot(copyJsonValue(value.initialSnapshot, "$initialSnapshot")),
  });
}

function snapshotPreparedUpdate(value: PreparedUpdateMergeRequestCommand): PreparedUpdateMergeRequestCommand {
  assertPreparedFields(value, "initial");
  return Object.freeze({ ...snapshotPreparedBase(value), initial: snapshotRemoteMergeRequest(value.initial) });
}

function assertCurrentSelfConsistent(current: RemoteMergeRequest): void {
  const snapshot = current.snapshot;
  const lifecycle = current.state === "opened"
    ? (current.draft ? "draft" : "ready")
    : current.state === "merged" ? "merged" : "closed";
  let webUrl: URL;
  try {
    webUrl = new URL(current.webUrl);
  } catch {
    throw preparedInputFailure();
  }
  if (webUrl.username !== "" || webUrl.password !== "" || webUrl.search !== "" ||
      webUrl.hash !== "" ||
      webUrl.pathname !== `/${snapshot.targetProject.path}/-/merge_requests/${String(current.iid)}` ||
      current.sourceProjectId !== snapshot.sourceProject.id ||
      current.targetProjectId !== snapshot.targetProject.id ||
      current.sourceHeadSha !== snapshot.sourceHeadSha || snapshot.mergeRequest.iid !== current.iid ||
      snapshot.mergeRequest.lifecycle !== lifecycle ||
      canonicalizeJson(snapshot.mergeRequest.labelIds) !== canonicalizeJson(current.labelIds) ||
      snapshot.mergeRequest.assigneeUserId !== current.assigneeUserId ||
      canonicalizeJson(snapshot.mergeRequest.reviewerUserIds) !== canonicalizeJson(current.reviewerUserIds)) {
    throw preparedInputFailure();
  }
}

function snapshotPreparedVerify(value: PreparedVerifyMergeRequestCommand): PreparedVerifyMergeRequestCommand {
  if (!exactFields(value as unknown as JsonObject, ["current"])) throw preparedInputFailure();
  const current = snapshotRemoteMergeRequest(value.current);
  assertCurrentSelfConsistent(current);
  return Object.freeze({ current });
}

function preparedFingerprint(
  value: PreparedMergeRequestCommandBase,
  snapshot: ExternalContextSnapshot,
  mrIid: number | null,
): string {
  return canonicalizeJson({
    request: value.request,
    binding: value.binding,
    bundle: value.bundle,
    releaseTag: value.releaseTag,
    cliVersion: value.cliVersion,
    sourceBranch: value.sourceBranch,
    snapshot,
    mrIid,
  });
}

export interface CreateMergeRequestCommandInput {
  readonly upsert: boolean;
  readonly prepare: () => Promise<PreparedCreateMergeRequestCommand>;
}

export interface UpdateMergeRequestCommandInput {
  readonly forceReplaceDescription: boolean;
  readonly prepare: () => Promise<PreparedUpdateMergeRequestCommand>;
}

export interface VerifyMergeRequestCommandInput {
  readonly level: VerificationLevel;
  readonly prepare: () => Promise<PreparedVerifyMergeRequestCommand>;
}

export interface MergeRequestCommandAdapter {
  create(input: CreateMergeRequestCommandInput): Promise<CliCommandExecution>;
  update(input: UpdateMergeRequestCommandInput): Promise<CliCommandExecution>;
  verify(input: VerifyMergeRequestCommandInput): Promise<CliCommandExecution>;
}

function internalFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Candidate consumption failed safely", {
    field: null,
    expected: "the exact preflight candidate selection at the first remote mutation",
    actual: "candidate selection changed between validation and consumption",
    safeNextStep: "Run context again and retry with newly issued candidate values.",
  });
}

function preparedInputFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Prepared merge request input failed closed", {
    field: null,
    expected: "one immutable prepared input matching the exact candidate context binding",
    actual: "prepared repository, Bundle, or remote identity drifted",
    safeNextStep: "Re-run repository and context discovery, then retry the command.",
  });
}

function assertPreparedBinding(
  prepared: PreparedMergeRequestCommandBase,
  operation: "create" | "update",
  snapshot: ExternalContextSnapshot,
  mrIid: number | null,
  gitlabOrigin: string,
): void {
  const binding = prepared.binding;
  const manifestHash = sha256Utf8(`${canonicalizeJson(prepared.bundle.manifest)}\n`);
  if (binding.operation !== operation || binding.mrIid !== mrIid ||
      binding.gitlabOrigin !== gitlabOrigin ||
      binding.targetProject.id !== snapshot.targetProject.id ||
      binding.targetProject.fullPath !== snapshot.targetProject.path ||
      binding.sourceProject.id !== snapshot.sourceProject.id ||
      binding.sourceProject.fullPath !== snapshot.sourceProject.path ||
      binding.targetBranch !== prepared.request.targetBranch ||
      binding.sourceBranch !== prepared.sourceBranch ||
      binding.sourceHeadSha !== snapshot.sourceHeadSha ||
      binding.targetRefSha !== snapshot.targetRefSha ||
      binding.cliVersion !== prepared.cliVersion ||
      binding.bundle.id !== prepared.bundle.manifest.bundleId ||
      binding.bundle.version !== prepared.bundle.manifest.version ||
      binding.bundle.releaseTag !== prepared.releaseTag ||
      binding.bundle.manifestHash !== manifestHash ||
      binding.protocols.inputSchema !== prepared.bundle.manifest.inputSchema ||
      binding.protocols.policySchema !== prepared.bundle.manifest.policySchema) {
    throw preparedInputFailure();
  }
}

function selectedCandidates(candidates: readonly Candidate[]): readonly JsonObject[] {
  return candidates.map((candidate) => candidate.kind === "label"
    ? {
        kind: candidate.kind,
        restId: candidate.restId,
        globalId: candidate.globalId,
        name: candidate.name,
        scopeKind: candidate.scopeKind,
        scopeId: candidate.scopeId,
        scopePath: candidate.scopePath,
        policyCategory: candidate.policyCategory,
      }
    : {
        kind: candidate.kind,
        userId: candidate.userId,
        globalId: candidate.globalId,
        username: candidate.username,
        displayName: candidate.displayName,
      });
}

function jsonRecord(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw preparedInputFailure();
  }
  return value as JsonObject;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => !nonEmpty(entry)) ||
      new Set(value).size !== value.length) {
    throw preparedInputFailure();
  }
  return Object.freeze([...value]) as readonly string[];
}

function snapshotWritePlan(value: unknown) {
  const plan = jsonRecord(value);
  if (!exactFields(plan, [
    "writePlanVersion", "intent", "provisional", "draft", "desired", "draftStatusLabelId",
    "readyStatusLabelId", "managedLabelIds", "preservedLabelIds",
  ]) || plan.writePlanVersion !== 1 || !["draft", "ready"].includes(String(plan.intent)) ||
      !nonEmpty(plan.draftStatusLabelId) || !nonEmpty(plan.readyStatusLabelId)) {
    throw preparedInputFailure();
  }
  const provisional = validateDesiredWritePlan(plan.provisional);
  const draft = validateDesiredWritePlan(plan.draft);
  const desired = validateDesiredWritePlan(plan.desired);
  const managedLabelIds = stringArray(plan.managedLabelIds);
  const preservedLabelIds = stringArray(plan.preservedLabelIds);
  return deepFreeze({
    writePlanVersion: 1 as const,
    intent: plan.intent as "draft" | "ready",
    provisional,
    draft,
    desired,
    draftStatusLabelId: plan.draftStatusLabelId,
    readyStatusLabelId: plan.readyStatusLabelId,
    managedLabelIds,
    preservedLabelIds,
  });
}

function assertFinalIdentity(final: RemoteMergeRequest, binding: ContextBinding): void {
  const snapshot = final.snapshot;
  const expectedLifecycle = final.draft ? "draft" : "ready";
  let webUrl: URL;
  try {
    webUrl = new URL(final.webUrl);
  } catch {
    throw preparedInputFailure();
  }
  if (final.state !== "opened" || final.sourceProjectId !== binding.sourceProject.id ||
      final.sourceBranch !== binding.sourceBranch || final.targetProjectId !== binding.targetProject.id ||
      final.targetBranch !== binding.targetBranch || final.sourceHeadSha !== binding.sourceHeadSha ||
      webUrl.origin !== binding.gitlabOrigin || webUrl.username !== "" || webUrl.password !== "" ||
      webUrl.search !== "" || webUrl.hash !== "" ||
      webUrl.pathname !== `/${binding.targetProject.fullPath}/-/merge_requests/${String(final.iid)}` ||
      snapshot.sourceProject.id !== binding.sourceProject.id ||
      snapshot.sourceProject.path !== binding.sourceProject.fullPath ||
      snapshot.targetProject.id !== binding.targetProject.id ||
      snapshot.targetProject.path !== binding.targetProject.fullPath ||
      snapshot.sourceHeadSha !== binding.sourceHeadSha || snapshot.targetRefSha !== binding.targetRefSha ||
      snapshot.mergeRequest.iid !== final.iid || snapshot.mergeRequest.lifecycle !== expectedLifecycle ||
      canonicalizeJson(snapshot.mergeRequest.labelIds) !== canonicalizeJson(final.labelIds) ||
      snapshot.mergeRequest.assigneeUserId !== final.assigneeUserId ||
      canonicalizeJson(snapshot.mergeRequest.reviewerUserIds) !== canonicalizeJson(final.reviewerUserIds)) {
    throw preparedInputFailure();
  }
}

function expectedAuditSnapshot(
  command: "create" | "update",
  upsert: boolean,
  audit: TransactionAuditV1,
  preparedSnapshot: ExternalContextSnapshot,
  final: RemoteMergeRequest,
  proof: GatedRemoteProof,
): ExternalContextSnapshot {
  if (command === "update") {
    if (audit.operation !== "update") throw preparedInputFailure();
    return preparedSnapshot;
  }
  if (audit.operation === "create") return preparedSnapshot;
  if (!upsert) throw preparedInputFailure();
  const matchingReads = proof.openReads.filter((read) =>
    read.length === 1 && read[0]?.iid === final.iid);
  if (matchingReads.length !== 1) throw preparedInputFailure();
  return matchingReads[0]![0]!.snapshot;
}

const MUTATION_METHOD_OPERATIONS: Readonly<Record<MutationMethod, readonly TransactionStepOperation[]>> = {
  createDraft: ["create-draft"],
  addLabels: ["labels-add", "lifecycle-status-ready-add", "compensation-labels-add"],
  removeLabels: ["labels-remove", "lifecycle-status-ready-remove", "compensation-labels-remove"],
  writeManagedFields: ["fields-write", "compensation-fields"],
  writeDescription: ["description-write", "compensation-description"],
  markReady: ["mark-ready"],
  markDraft: ["mark-draft"],
};

type PreparedWriteCommand = PreparedCreateMergeRequestCommand | PreparedUpdateMergeRequestCommand;

type RemoteCallProof =
  | { readonly kind: "mutation"; readonly attempt: MutationAttemptProof }
  | { readonly kind: "query"; readonly attempt: QueryAttemptProof };

function sameRemoteValue(left: RemoteMergeRequest, right: RemoteMergeRequest): boolean {
  return canonicalizeJson(left as unknown as JsonObject) === canonicalizeJson(right as unknown as JsonObject);
}

function readQueryDigest(iid: number): string {
  return sha256CanonicalJson({ method: "read", iid });
}

function assertReturnedQuery(
  query: QueryAttemptProof | undefined,
  method: QueryAttemptProof["method"],
): asserts query is QueryAttemptProof {
  if (query === undefined || query.method !== method || query.outcome !== "returned" ||
      query.resultDigest === null) {
    throw preparedInputFailure();
  }
}

function assertBusinessQueries(
  command: "create" | "update",
  upsert: boolean,
  audit: TransactionAuditV1,
  prepared: PreparedWriteCommand,
  leading: readonly QueryAttemptProof[],
): string | null {
  if (command === "update") {
    const initial = "initial" in prepared ? prepared.initial : null;
    const query = leading[0];
    assertReturnedQuery(query, "read");
    if (initial === null || leading.length !== 1 || query.readValue === null ||
        query.queryDigest !== readQueryDigest(initial.iid) || !sameRemoteValue(query.readValue, initial)) {
      throw preparedInputFailure();
    }
    return null;
  }
  const find = leading[0];
  assertReturnedQuery(find, "findOpen");
  if (find.openValues === null) throw preparedInputFailure();
  if (audit.operation === "create") {
    if (leading.length !== 1 || find.openValues.length !== 0) throw preparedInputFailure();
  } else {
    const initialRead = leading[1];
    const initial = find.openValues[0];
    assertReturnedQuery(initialRead, "read");
    if (!upsert || leading.length !== 2 || find.openValues.length !== 1 || initial === undefined ||
        initialRead.readValue === null || initialRead.queryDigest !== readQueryDigest(initial.iid) ||
        !sameRemoteValue(initialRead.readValue, initial)) {
      throw preparedInputFailure();
    }
  }
  return find.queryDigest;
}

function assertReadProof(
  actual: RemoteCallProof | undefined,
  expected: TransactionReadAudit,
  method: QueryAttemptProof["method"],
): QueryAttemptProof | null {
  if (!['succeeded', 'failed'].includes(expected.outcome)) return null;
  if (actual?.kind !== "query" || actual.attempt.method !== method) throw preparedInputFailure();
  const query = actual.attempt;
  const outcome = expected.outcome === "succeeded" ? "returned" : "threw";
  if (query.outcome !== outcome || query.requestId !== expected.requestId ||
      query.resultDigest !== expected.snapshotDigest) {
    throw preparedInputFailure();
  }
  return query;
}

function assertExactMutationProof(
  command: "create" | "update",
  upsert: boolean,
  audit: TransactionAuditV1,
  completedWrites: readonly string[],
  prepared: PreparedWriteCommand,
  final: RemoteMergeRequest,
  proof: GatedRemoteProof,
): void {
  if (!proof.gateCompleted || proof.pendingMutationCalls !== 0 || proof.pendingQueryCalls !== 0 ||
      proof.mutationAttempts.length === 0) {
    throw preparedInputFailure();
  }
  const firstMutation = proof.mutationAttempts[0];
  if (firstMutation === undefined) throw preparedInputFailure();
  const sortedQueries = [...proof.queryAttempts].sort((left, right) => left.sequence - right.sequence);
  const businessQueryCount = command === "create" && audit.operation === "update" ? 2 : 1;
  const leadingQueries = sortedQueries.slice(0, businessQueryCount);
  if (leadingQueries.length !== businessQueryCount ||
      leadingQueries.some((query) => query.sequence >= firstMutation.sequence)) {
    throw preparedInputFailure();
  }
  const createQueryDigest = assertBusinessQueries(command, upsert, audit, prepared, leadingQueries);
  const transactionCalls: RemoteCallProof[] = [
    ...proof.mutationAttempts.map((attempt) => ({ kind: "mutation" as const, attempt })),
    ...sortedQueries
      .slice(businessQueryCount)
      .map((attempt) => ({ kind: "query" as const, attempt })),
  ].sort((left, right) => left.attempt.sequence - right.attempt.sequence);
  const requestIds = new Set<string>();
  const allCalls: RemoteCallProof[] = [
    ...proof.mutationAttempts.map((attempt) => ({ kind: "mutation" as const, attempt })),
    ...proof.queryAttempts.map((attempt) => ({ kind: "query" as const, attempt })),
  ];
  for (const call of allCalls) {
    const requestId = call.attempt.requestId;
    if (requestId !== null) {
      if (typeof requestId !== "string" || requestIds.has(requestId)) throw preparedInputFailure();
      requestIds.add(requestId);
    }
  }
  const expectedCompleted: string[] = [];
  let callIndex = 0;
  let recoveryQuery: QueryAttemptProof | null = null;
  let finalPostRead: QueryAttemptProof | null = null;
  for (const step of audit.steps) {
    if (["succeeded", "failed"].includes(step.preRead.outcome)) {
      assertReadProof(transactionCalls[callIndex], step.preRead, "read");
      callIndex += 1;
    }
    if (step.mutation !== null) {
      const call = transactionCalls[callIndex];
      if (call?.kind !== "mutation") throw preparedInputFailure();
      const attempt = call.attempt;
      const expectedOutcome = attempt.outcome === "returned"
        ? "confirmed"
        : attempt.outcome === "threw-rejected" ? "rejected" : "unknown";
      if (attempt.outcome === "pending" ||
          !MUTATION_METHOD_OPERATIONS[attempt.method].includes(step.operation) ||
          step.mutation.requestId !== attempt.requestId || step.mutation.outcome !== expectedOutcome ||
          step.mutation.outcome === "rejected") {
        throw preparedInputFailure();
      }
      callIndex += 1;
    }
    if (["succeeded", "failed"].includes(step.postRead.outcome)) {
      const method = step.operation === "create-outcome-query" ? "findOpen" : "read";
      const query = assertReadProof(transactionCalls[callIndex], step.postRead, method);
      if (step.operation === "create-outcome-query") recoveryQuery = query;
      finalPostRead = query;
      callIndex += 1;
    }
    if (step.mutation !== null) {
      const directlyProven = step.postRead.outcome === "succeeded" && step.postcondition === "matched";
      const recoveredCreate = step.operation === "create-draft" && step.mutation.outcome === "unknown";
      if (!directlyProven && !recoveredCreate) throw preparedInputFailure();
      expectedCompleted.push(
        step.mutation.outcome === "unknown" ? `${step.operation}.recovered` : step.operation,
      );
    }
  }
  if (callIndex !== transactionCalls.length ||
      canonicalizeJson(completedWrites) !== canonicalizeJson(expectedCompleted)) {
    throw preparedInputFailure();
  }
  const unknownCreate = audit.steps.find((step) =>
    step.operation === "create-draft" && step.mutation?.outcome === "unknown");
  if (unknownCreate !== undefined) {
    const recovered = recoveryQuery?.openValues;
    const value = recovered?.[0];
    if (createQueryDigest === null || recoveryQuery === null ||
        recoveryQuery.queryDigest !== createQueryDigest || recovered?.length !== 1 || value === undefined ||
        value.iid !== final.iid || value.webUrl !== final.webUrl || value.draft !== true ||
        value.state !== "opened" || value.sourceProjectId !== final.sourceProjectId ||
        value.sourceBranch !== final.sourceBranch || value.targetProjectId !== final.targetProjectId ||
        value.targetBranch !== final.targetBranch || value.sourceHeadSha !== final.sourceHeadSha) {
      throw preparedInputFailure();
    }
  } else if (recoveryQuery !== null) {
    throw preparedInputFailure();
  }
  if (finalPostRead?.readValue === null || finalPostRead?.readValue === undefined ||
      !sameRemoteValue(finalPostRead.readValue, final)) {
    throw preparedInputFailure();
  }
  const steps = audit.steps.filter((step) => step.mutation !== null);
  const remoteWrite = remoteWriteFromTransactionAudit(audit);
  if (remoteWrite.state !== "written" ||
      canonicalizeJson(remoteWrite.operations) !== canonicalizeJson(steps.map((step) => step.operation))) {
    throw preparedInputFailure();
  }
}

function validateSuccessfulWrite(
  value: CreateMergeRequestResult | UpdateMergeRequestResult,
  command: "create" | "update",
  upsert: boolean,
  prepared: PreparedWriteCommand,
  preparedSnapshot: ExternalContextSnapshot,
  candidates: readonly Candidate[],
  proof: GatedRemoteProof,
): {
  readonly command: "create" | "update";
  readonly result: CreateMergeRequestResult | UpdateMergeRequestResult;
} {
  try {
    const copied = copyJsonValue(value, "$domainResult");
    const result = jsonRecord(copied);
    const audit = validateTransactionAudit(result.transaction);
    const fields = [
      "iid", "webUrl", "writePlan", "completedWrites", "recoveredUnknownOutcome", "final",
      "verification", "transaction",
      ...(audit.operation === "update" ? ["forcedDescriptionReplacement"] : []),
    ];
    if (!exactFields(result, fields) || !positiveInteger(result.iid) || !nonEmpty(result.webUrl) ||
        typeof result.recoveredUnknownOutcome !== "boolean" ||
        (audit.operation === "update" && typeof result.forcedDescriptionReplacement !== "boolean")) {
      throw preparedInputFailure();
    }
    const completedWrites = stringArray(result.completedWrites);
    if (completedWrites.some((entry) => !/^[a-z][a-z0-9-]*(?:\.recovered)?$/u.test(entry))) {
      throw preparedInputFailure();
    }
    const final = snapshotRemoteMergeRequest(result.final as unknown as RemoteMergeRequest);
    const writePlan = snapshotWritePlan(result.writePlan);
    const verification = jsonRecord(result.verification);
    if (!exactFields(verification, [
      "request", "snapshot", "writePlan", "releaseTag", "cliVersion", "description", "sourceBranch",
    ]) || verification.releaseTag !== prepared.releaseTag || verification.cliVersion !== prepared.cliVersion ||
        verification.sourceBranch !== prepared.sourceBranch || verification.description !== final.description) {
      throw preparedInputFailure();
    }
    const verificationRequest = normalizeAndValidateRequest(verification.request);
    const verificationSnapshot = validateExternalContextSnapshot(verification.snapshot);
    const verificationPlan = validateDesiredWritePlan(verification.writePlan);
    if (canonicalizeJson(verificationRequest) !== canonicalizeJson(prepared.request) ||
        canonicalizeJson(verificationPlan) !== canonicalizeJson(writePlan.desired) ||
        verificationSnapshot.sourceProject.id !== prepared.binding.sourceProject.id ||
        verificationSnapshot.targetProject.id !== prepared.binding.targetProject.id ||
        verificationSnapshot.sourceHeadSha !== prepared.binding.sourceHeadSha ||
        verificationSnapshot.mergeRequest.iid !== final.iid ||
        writePlan.intent !== (final.draft ? "draft" : "ready") ||
        final.title !== (final.draft ? writePlan.draft.title : writePlan.desired.title) ||
        final.assigneeUserId !== writePlan.desired.assigneeUserId ||
        canonicalizeJson(final.reviewerUserIds) !== canonicalizeJson(writePlan.desired.reviewerUserIds) ||
        final.squash !== writePlan.desired.squash ||
        final.removeSourceBranch !== writePlan.desired.removeSourceBranch) {
      throw preparedInputFailure();
    }
    assertFinalIdentity(final, prepared.binding);
    const digestSnapshot = expectedAuditSnapshot(
      command,
      upsert,
      audit,
      preparedSnapshot,
      final,
      proof,
    );
    const expectedDigest = candidateSelectionDigest(prepared.request, candidates, digestSnapshot);
    const expectedFinalState = final.draft ? "draft-proven" : "ready-proven";
    if (audit.sourceHeadSha !== prepared.binding.sourceHeadSha ||
        audit.candidateSelectionDigest !== expectedDigest || audit.finalState !== expectedFinalState ||
        result.iid !== final.iid || result.webUrl !== final.webUrl ||
        result.recoveredUnknownOutcome !== audit.recoveredUnknownOutcome) {
      throw preparedInputFailure();
    }
    assertExactMutationProof(command, upsert, audit, completedWrites, prepared, final, proof);
    const safeResult = deepFreeze({
      iid: result.iid,
      webUrl: result.webUrl,
      writePlan,
      completedWrites,
      recoveredUnknownOutcome: result.recoveredUnknownOutcome,
      final,
      verification: {
        request: verificationRequest,
        snapshot: verificationSnapshot,
        writePlan: verificationPlan,
        releaseTag: verification.releaseTag,
        cliVersion: verification.cliVersion,
        description: verification.description,
        sourceBranch: verification.sourceBranch,
      },
      transaction: audit,
      ...(audit.operation === "update"
        ? { forcedDescriptionReplacement: result.forcedDescriptionReplacement }
        : {}),
    }) as CreateMergeRequestResult | UpdateMergeRequestResult;
    return { command: audit.operation, result: safeResult };
  } catch (error) {
    if (error instanceof ToolError && error.code === "INTERNAL_ERROR") throw error;
    throw preparedInputFailure();
  }
}

function writeExecution(
  command: "create" | "update",
  result: CreateMergeRequestResult | UpdateMergeRequestResult,
  candidates: readonly Candidate[],
  binding: ContextBinding,
): CliCommandExecution {
  const data = copyJsonValue({
    command,
    iid: result.iid,
    webUrl: result.webUrl,
    lifecycle: result.final.draft ? "draft" : "ready",
    state: result.final.state,
    completedWrites: result.completedWrites,
    recoveredUnknownOutcome: result.recoveredUnknownOutcome,
    selectedCandidates: selectedCandidates(candidates),
    transaction: result.transaction,
    ...(command === "update" && "forcedDescriptionReplacement" in result
      ? { forcedDescriptionReplacement: result.forcedDescriptionReplacement }
      : {}),
  }) as JsonObject;
  return {
    context: {
      versions: {
        templateVersion: binding.bundle.version,
        bundleHash: binding.bundle.manifestHash,
        releaseSetId: binding.releaseSetId,
        inputSchema: binding.protocols.inputSchema,
        policySchema: binding.protocols.policySchema,
      },
      remoteWrite: remoteWriteFromTransactionAudit(result.transaction),
    },
    output: {
      message: command === "create"
        ? "Merge request created successfully"
        : "Merge request updated successfully",
      data,
    },
  };
}

interface VerificationLoaderProof {
  readonly receiptLoader: VerificationReceiptLoader;
  readonly bundleLoader: HistoricalBundleLoader;
  readonly assertComplete: () => void;
}

function verificationLoaderProof(
  dependencies: MergeRequestCommandAdapterDependencies,
  current: RemoteMergeRequest,
): VerificationLoaderProof {
  let expectedLocator: JsonObject | null = null;
  try {
    const marker = parseDiagnosticMarker(current.description);
    expectedLocator = {
      gitlabOrigin: dependencies.gitlabOrigin,
      targetProjectId: current.targetProjectId,
      iid: current.iid,
      markerDigest: sha256CanonicalJson(marker as unknown as JsonObject),
    };
  } catch {
    expectedLocator = null;
  }
  let receiptCalls = 0;
  let bundleCalls = 0;
  let receipt: ReturnType<typeof validateVerificationReceipt> | null = null;
  let bundleTrusted = false;
  const receiptLoader: VerificationReceiptLoader = {
    loadVerified: async (locator) => {
      receiptCalls += 1;
      if (receiptCalls !== 1 || expectedLocator === null ||
          canonicalizeJson(locator as unknown as JsonObject) !== canonicalizeJson(expectedLocator)) {
        throw preparedInputFailure();
      }
      const loaded = await dependencies.verificationReceiptLoader.loadVerified(locator);
      if (loaded?.trusted === true) {
        try {
          receipt = validateVerificationReceipt(loaded.receipt);
        } catch {
          throw preparedInputFailure();
        }
        if (receipt.gitlabOrigin !== dependencies.gitlabOrigin || receipt.iid !== current.iid ||
            receipt.webUrl !== current.webUrl || receipt.targetProject.id !== current.targetProjectId ||
            canonicalizeJson(receipt.marker as unknown as JsonObject) !==
              canonicalizeJson(parseDiagnosticMarker(current.description) as unknown as JsonObject)) {
          throw preparedInputFailure();
        }
      }
      return loaded;
    },
  };
  const bundleLoader: HistoricalBundleLoader = {
    loadVerifiedExact: async (reference) => {
      bundleCalls += 1;
      if (bundleCalls !== 1 || receipt === null ||
          canonicalizeJson(reference as unknown as JsonObject) !==
            canonicalizeJson(receipt.bundle as unknown as JsonObject)) {
        throw preparedInputFailure();
      }
      const loaded = await dependencies.historicalBundleLoader.loadVerifiedExact(reference);
      if (loaded.trusted === true) {
        const manifestHash = sha256Utf8(`${canonicalizeJson(loaded.bundle.manifest)}\n`);
        if (loaded.bundle.manifest.bundleId !== reference.bundleId ||
            loaded.bundle.manifest.version !== reference.bundleVersion ||
            loaded.bundle.manifest.policySchema !== reference.policySchema ||
            manifestHash !== reference.bundleManifestHash) {
          throw preparedInputFailure();
        }
        bundleTrusted = true;
      }
      return loaded;
    },
  };
  return {
    receiptLoader: Object.freeze(receiptLoader),
    bundleLoader: Object.freeze(bundleLoader),
    assertComplete: () => {
      if (receiptCalls !== 1 || bundleCalls !== 1 || receipt === null || !bundleTrusted) {
        throw preparedInputFailure();
      }
    },
  };
}

function validateVerificationSuccess(
  value: MergeRequestVerificationResult,
  level: VerificationLevel,
  current: RemoteMergeRequest,
  proof: VerificationLoaderProof,
): MergeRequestVerificationResult {
  try {
    proof.assertComplete();
    const result = jsonRecord(copyJsonValue(value, "$verificationResult"));
    const live = jsonRecord(result.live);
    if (!exactFields(result, ["valid", "level", "iid", "webUrl", "live"]) ||
        !exactFields(live, ["lifecycle", "ciStatus", "unresolvedDiscussions", "qualifiedApprovals"]) ||
        result.valid !== true || result.level !== level || result.iid !== current.iid ||
        result.webUrl !== current.webUrl) {
      throw preparedInputFailure();
    }
    const snapshot = current.snapshot;
    const qualified = snapshot.review.qualifiedReviewerUserIds;
    const qualifiedApprovals = qualified === null
      ? null
      : snapshot.review.approvedByUserIds.filter((id) =>
          id !== snapshot.mergeRequest.authorUserId && qualified.includes(id)).length;
    const lifecycle = current.draft ? "draft" : "ready";
    if (live.lifecycle !== lifecycle || live.ciStatus !== snapshot.ci.status ||
        live.unresolvedDiscussions !== snapshot.review.unresolvedDiscussions ||
        live.qualifiedApprovals !== qualifiedApprovals) {
      throw preparedInputFailure();
    }
    return deepFreeze({
      valid: true,
      level,
      iid: current.iid,
      webUrl: current.webUrl,
      live: {
        lifecycle,
        ciStatus: snapshot.ci.status,
        unresolvedDiscussions: snapshot.review.unresolvedDiscussions,
        qualifiedApprovals,
      },
    });
  } catch (error) {
    if (error instanceof ToolError && error.code === "INTERNAL_ERROR") throw error;
    throw preparedInputFailure();
  }
}

function verifyExecution(result: MergeRequestVerificationResult): CliCommandExecution {
  return {
    context: {
      remoteWrite: { state: "not-attempted", operations: [] },
    },
    output: {
      message: "Merge request verification completed successfully",
      data: copyJsonValue({
        command: "verify",
        valid: result.valid,
        level: result.level,
        iid: result.iid,
        webUrl: result.webUrl,
        live: result.live,
      }) as JsonObject,
    },
  };
}

type MutationMethod =
  | "createDraft"
  | "addLabels"
  | "removeLabels"
  | "writeManagedFields"
  | "writeDescription"
  | "markReady"
  | "markDraft";

interface MutationAttemptProof {
  readonly sequence: number;
  readonly method: MutationMethod;
  outcome: "pending" | "returned" | "threw-rejected" | "threw-unknown";
  requestId: string | null;
}

interface QueryAttemptProof {
  readonly sequence: number;
  readonly method: "findOpen" | "read";
  readonly queryDigest: string;
  outcome: "pending" | "returned" | "threw";
  requestId: string | null;
  resultDigest: string | null;
  readValue: RemoteMergeRequest | null;
  openValues: readonly RemoteMergeRequest[] | null;
}

interface GatedRemoteProof {
  gateCompleted: boolean;
  pendingMutationCalls: number;
  pendingQueryCalls: number;
  readonly mutationAttempts: MutationAttemptProof[];
  readonly queryAttempts: QueryAttemptProof[];
  readonly openReads: (readonly RemoteMergeRequest[])[];
}

function mutationGatedRemote(
  remote: MergeRequestRemote,
  beforeFirstMutation: () => Promise<void>,
): { readonly remote: MergeRequestRemote; readonly proof: GatedRemoteProof } {
  let gate: Promise<void> | null = null;
  let callSequence = 0;
  const proof: GatedRemoteProof = {
    gateCompleted: false,
    pendingMutationCalls: 0,
    pendingQueryCalls: 0,
    mutationAttempts: [],
    queryAttempts: [],
    openReads: [],
  };
  const beforeMutation = (): Promise<void> => {
    gate ??= beforeFirstMutation().then(() => {
      proof.gateCompleted = true;
    });
    return gate;
  };
  const mutate = async <T extends { readonly requestId: string | null }>(
    method: MutationMethod,
    run: () => Promise<T>,
  ): Promise<T> => {
    proof.pendingMutationCalls += 1;
    try {
      await beforeMutation();
      const attempt: MutationAttemptProof = {
        sequence: ++callSequence,
        method,
        outcome: "pending",
        requestId: null,
      };
      proof.mutationAttempts.push(attempt);
      try {
        const receipt = await run();
        attempt.outcome = "returned";
        attempt.requestId = receipt.requestId;
        return receipt;
      } catch (error) {
        attempt.outcome = isRemoteMutationError(error, "rejected")
          ? "threw-rejected"
          : "threw-unknown";
        attempt.requestId = isRemoteMutationError(error) ? error.requestId : null;
        throw error;
      }
    } finally {
      proof.pendingMutationCalls -= 1;
    }
  };
  const query = async <T>(
    method: QueryAttemptProof["method"],
    queryValue: JsonValue,
    run: () => Promise<{ readonly value: T; readonly requestId: string | null }>,
    validate: (value: T) => {
      readonly resultDigest: string;
      readonly readValue: RemoteMergeRequest | null;
      readonly openValues: readonly RemoteMergeRequest[] | null;
    },
  ): Promise<{ readonly value: T; readonly requestId: string | null }> => {
    const attempt: QueryAttemptProof = {
      sequence: ++callSequence,
      method,
      queryDigest: sha256CanonicalJson(queryValue),
      outcome: "pending",
      requestId: null,
      resultDigest: null,
      readValue: null,
      openValues: null,
    };
    proof.queryAttempts.push(attempt);
    proof.pendingQueryCalls += 1;
    try {
      const receipt = await run();
      const validated = validate(receipt.value);
      attempt.outcome = "returned";
      attempt.requestId = receipt.requestId;
      attempt.resultDigest = validated.resultDigest;
      attempt.readValue = validated.readValue;
      attempt.openValues = validated.openValues;
      return receipt;
    } catch (error) {
      attempt.outcome = "threw";
      attempt.requestId = isRemoteReadError(error) ? error.requestId : null;
      throw error;
    } finally {
      proof.pendingQueryCalls -= 1;
    }
  };
  const wrapper: MergeRequestRemote = {
    findOpen: async (input) => query(
      "findOpen",
      copyJsonValue(input as unknown as JsonValue),
      () => remote.findOpen(input),
      (value) => {
        if (!Array.isArray(value)) throw preparedInputFailure();
        const openValues = Object.freeze(value.map(snapshotRemoteMergeRequest));
        proof.openReads.push(openValues);
        return {
          resultDigest: sha256CanonicalJson(openValues as unknown as JsonValue),
          readValue: null,
          openValues,
        };
      },
    ),
    read: async (iid) => query(
      "read",
      { method: "read", iid } as unknown as JsonValue,
      () => remote.read(iid),
      (value) => {
        const readValue = snapshotRemoteMergeRequest(value);
        return {
          resultDigest: remoteSnapshotDigest(readValue),
          readValue,
          openValues: null,
        };
      },
    ),
    createDraft: (input) => mutate("createDraft", () => remote.createDraft(input)),
    addLabels: (iid, labelIds) => mutate("addLabels", () => remote.addLabels(iid, labelIds)),
    removeLabels: (iid, labelIds) => mutate("removeLabels", () => remote.removeLabels(iid, labelIds)),
    writeManagedFields: (iid, input) =>
      mutate("writeManagedFields", () => remote.writeManagedFields(iid, input)),
    writeDescription: (iid, description) =>
      mutate("writeDescription", () => remote.writeDescription(iid, description)),
    markReady: (iid, title) => mutate("markReady", () => remote.markReady(iid, title)),
    markDraft: (iid, title) => mutate("markDraft", () => remote.markDraft(iid, title)),
  };
  return Object.freeze({ remote: Object.freeze(wrapper), proof });
}

function domainServices(
  value: MergeRequestCommandDomain | undefined,
): MergeRequestCommandDomain {
  return value ?? Object.freeze({
    create: createMergeRequest,
    update: updateMergeRequest,
  });
}

function validateDependencies(dependencies: MergeRequestCommandAdapterDependencies): void {
  if (typeof dependencies.gitlabOrigin !== "string" || dependencies.gitlabOrigin.trim() === "" ||
      typeof dependencies.readCurrentBinding !== "function" ||
      typeof dependencies.candidateStore?.resolve !== "function" ||
      typeof dependencies.verifyLiveCandidateIdentities !== "function" ||
      typeof dependencies.verificationReceiptWriter?.stageAuthenticated !== "function" ||
      typeof dependencies.verificationReceiptLoader?.loadVerified !== "function" ||
      typeof dependencies.historicalBundleLoader?.loadVerifiedExact !== "function") {
    throw new TypeError("Merge request command dependencies are incomplete");
  }
}

export function createMergeRequestCommandAdapter(
  dependencies: MergeRequestCommandAdapterDependencies,
): MergeRequestCommandAdapter {
  validateDependencies(dependencies);
  const domain = domainServices(dependencies.domain);

  const prepareWrite = async <Prepared extends PreparedMergeRequestCommandBase>(
    prepare: () => Promise<Prepared>,
    snapshotPrepared: (prepared: Prepared) => Prepared,
    operation: "create" | "update",
    snapshotOf: (prepared: Prepared) => ExternalContextSnapshot,
    mrIid: (prepared: Prepared) => number | null,
  ): Promise<{
    readonly prepared: Prepared;
    readonly candidates: readonly Candidate[];
    readonly remote: MergeRequestRemote;
    readonly proof: GatedRemoteProof;
    readonly preparedSnapshot: ExternalContextSnapshot;
  }> => {
    const supplied = await prepare();
    const suppliedRemote = supplied.remote;
    const prepared = snapshotPrepared(supplied);
    const expectedSnapshot = snapshotOf(prepared);
    const expectedMrIid = mrIid(prepared);
    const fingerprint = preparedFingerprint(prepared, expectedSnapshot, expectedMrIid);
    const assertUnchanged = (): void => {
      const current = snapshotPrepared(supplied);
      if (current.remote !== suppliedRemote ||
          preparedFingerprint(current, snapshotOf(current), mrIid(current)) !== fingerprint) {
        throw preparedInputFailure();
      }
    };
    assertPreparedBinding(
      prepared,
      operation,
      expectedSnapshot,
      expectedMrIid,
      dependencies.gitlabOrigin,
    );
    const preparedBinding = snapshotBinding(prepared.binding);
    const currentBinding = snapshotBinding(await dependencies.readCurrentBinding({
      operation,
      mrIid: expectedMrIid,
      remote: prepared.remote,
    }));
    assertUnchanged();
    assertExactBinding(currentBinding, preparedBinding);
    const preflight = await resolveRequestCandidates({
      request: prepared.request,
      expectedBinding: preparedBinding,
      store: dependencies.candidateStore,
      consume: false,
    });
    assertUnchanged();
    if (canonicalizeJson(preflight.snapshot) !== canonicalizeJson(expectedSnapshot)) {
      throw preparedInputFailure();
    }
    const gated = mutationGatedRemote(prepared.remote, async () => {
      assertUnchanged();
      await dependencies.verifyLiveCandidateIdentities({
        binding: preflight.binding,
        candidates: preflight.candidates,
      });
      assertUnchanged();
      const liveBinding = snapshotBinding(await dependencies.readCurrentBinding({
        operation,
        mrIid: expectedMrIid,
        remote: prepared.remote,
      }));
      assertUnchanged();
      assertExactBinding(liveBinding, preparedBinding);
      const consumed = await resolveRequestCandidates({
        request: prepared.request,
        expectedBinding: preparedBinding,
        store: dependencies.candidateStore,
        consume: true,
      });
      assertUnchanged();
      if (consumed.candidateSelectionDigest !== preflight.candidateSelectionDigest ||
          canonicalizeJson(consumed.snapshot) !== canonicalizeJson(expectedSnapshot)) {
        throw internalFailure();
      }
    });
    return {
      prepared,
      candidates: preflight.candidates,
      remote: gated.remote,
      proof: gated.proof,
      preparedSnapshot: expectedSnapshot,
    };
  };

  return Object.freeze({
    async create(input: CreateMergeRequestCommandInput): Promise<CliCommandExecution> {
      const { prepared, candidates, remote, proof, preparedSnapshot } = await prepareWrite(
        input.prepare,
        snapshotPreparedCreate,
        "create",
        (value) => value.initialSnapshot,
        () => null,
      );
      const domainResult = await domain.create({
        request: prepared.request,
        initialSnapshot: prepared.initialSnapshot,
        resolvedCandidates: candidates,
        bundle: prepared.bundle,
        releaseTag: prepared.releaseTag,
        cliVersion: prepared.cliVersion,
        sourceBranch: prepared.sourceBranch,
        remote,
        gitlabOrigin: dependencies.gitlabOrigin,
        verificationReceiptWriter: dependencies.verificationReceiptWriter,
        upsert: input.upsert,
      });
      const validated = validateSuccessfulWrite(
        domainResult,
        "create",
        input.upsert,
        prepared,
        preparedSnapshot,
        candidates,
        proof,
      );
      return writeExecution(validated.command, validated.result, candidates, prepared.binding);
    },

    async update(input: UpdateMergeRequestCommandInput): Promise<CliCommandExecution> {
      const { prepared, candidates, remote, proof, preparedSnapshot } = await prepareWrite(
        input.prepare,
        snapshotPreparedUpdate,
        "update",
        (value) => value.initial.snapshot,
        (value) => value.initial.iid,
      );
      const domainResult = await domain.update({
        request: prepared.request,
        initial: prepared.initial,
        resolvedCandidates: candidates,
        bundle: prepared.bundle,
        releaseTag: prepared.releaseTag,
        cliVersion: prepared.cliVersion,
        sourceBranch: prepared.sourceBranch,
        remote,
        gitlabOrigin: dependencies.gitlabOrigin,
        verificationReceiptWriter: dependencies.verificationReceiptWriter,
        forceReplaceDescription: input.forceReplaceDescription,
      });
      const validated = validateSuccessfulWrite(
        domainResult,
        "update",
        false,
        prepared,
        preparedSnapshot,
        candidates,
        proof,
      );
      return writeExecution(validated.command, validated.result, candidates, prepared.binding);
    },

    async verify(input: VerifyMergeRequestCommandInput): Promise<CliCommandExecution> {
      const level = input.level;
      if (!["structure", "ready", "merge"].includes(level)) throw preparedInputFailure();
      const supplied = await input.prepare();
      const prepared = snapshotPreparedVerify(supplied);
      const fingerprint = canonicalizeJson(prepared.current as unknown as JsonObject);
      const proof = verificationLoaderProof(dependencies, prepared.current);
      const domainResult = await verifyStoredMergeRequest({
        level,
        current: prepared.current,
        gitlabOrigin: dependencies.gitlabOrigin,
        receiptLoader: proof.receiptLoader,
        bundleLoader: proof.bundleLoader,
      });
      const current = snapshotPreparedVerify(supplied).current;
      if (canonicalizeJson(current as unknown as JsonObject) !== fingerprint) {
        throw preparedInputFailure();
      }
      return verifyExecution(validateVerificationSuccess(domainResult, level, prepared.current, proof));
    },
  });
}
