import { seedHistoricalMr } from "../helpers/seed-historical-mr.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type {
  CreateMergeRequestInput,
  CreateMergeRequestResult,
  ManagedFieldsInput,
  MergeRequestRemote,
  RemoteMergeRequest,
} from "../../src/app/create-mr.ts";
import type { UpdateMergeRequestInputs, UpdateMergeRequestResult } from "../../src/app/update-mr.ts";
import { mutationReceipt, valueReceipt } from "../../src/app/remote-receipt.ts";
import {
  RemoteMutationError,
  RemoteReadError,
} from "../../src/app/remote-outcome.ts";
import {
  attachTransactionAudit,
  candidateSelectionDigest,
  TransactionJournal,
  getTransactionAudit,
  type TransactionAudit,
} from "../../src/app/transaction-journal.ts";
import {
  buildVerificationReceipt,
  verifyStoredMergeRequest,
  type MergeRequestVerificationResult,
} from "../../src/app/verify-mr.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, copyJsonValue, sha256CanonicalJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { createSuccessOutput } from "../../src/contracts/output.ts";
import type { Request } from "../../src/contracts/request.ts";
import type { Candidate, ContextBinding, ResolvedContext } from "../../src/context/types.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../src/render/marker.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import {
  createMergeRequestCommandAdapter,
  type MergeRequestCommandAdapterDependencies,
  type PreparedCreateMergeRequestCommand,
  type PreparedUpdateMergeRequestCommand,
} from "../../src/cli/commands/merge-request.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const CONTEXT = `hmrx1_${"A".repeat(43)}`;
const LABEL = `hmrc1_${"B".repeat(43)}`;
const ASSIGNEE = `hmrc1_${"C".repeat(43)}`;
const REVIEWER = `hmrc1_${"D".repeat(43)}`;
const BEARERS = [CONTEXT, LABEL, ASSIGNEE, REVIEWER];

function labelCandidate(): Extract<Candidate, { readonly kind: "label" }> {
  return {
    kind: "label",
    restId: 10,
    globalId: "gid://gitlab/ProjectLabel/10",
    name: "type::bug",
    description: "Bug",
    color: "#123456",
    scopeKind: "project",
    scopeId: "100",
    scopePath: "luban/luban-studio",
    policyCategory: "type",
  };
}

const candidates: readonly Candidate[] = Object.freeze([
  labelCandidate(),
  {
    kind: "assignee",
    userId: "user:10",
    globalId: "gid://gitlab/User/10",
    username: "alice",
    displayName: "Alice Zhang",
  },
  {
    kind: "reviewer",
    userId: "user:20",
    globalId: "gid://gitlab/User/20",
    username: "bob",
    displayName: "Bob Chen",
  },
]);

interface Fixture {
  readonly request: Request;
  readonly snapshot: ExternalContextSnapshot;
  readonly binding: ContextBinding;
  readonly bundle: Awaited<ReturnType<typeof loadTemplateBundle>>;
}

async function fixture(): Promise<Fixture> {
  const [rawRequest, rawSnapshot, bundle] = await Promise.all([
    readFile(resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(resolve(repositoryRoot, "test/golden/fixtures/code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  rawRequest.contextId = CONTEXT;
  rawRequest.mergeRequest.labelCandidateTokens = [LABEL];
  rawRequest.mergeRequest.assigneeCandidateToken = ASSIGNEE;
  rawRequest.review.reviewerCandidateTokens = [REVIEWER];
  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/10", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
  ];
  rawSnapshot.mergeRequest = {
    ...rawSnapshot.mergeRequest,
    iid: null,
    lifecycle: "new",
    labelIds: [],
    assigneeUserId: null,
    reviewerUserIds: [],
  };
  rawSnapshot.metadataRead = { status: "unavailable", evidence: "No MR exists yet." };
  const snapshot = validateExternalContextSnapshot(rawSnapshot);
  const request = normalizeAndValidateRequest(rawRequest);
  const binding: ContextBinding = {
    operation: "create",
    gitlabOrigin: "https://gitlab.example.test",
    targetProject: { id: snapshot.targetProject.id, fullPath: snapshot.targetProject.path },
    targetBranch: request.targetBranch,
    sourceProject: { id: snapshot.sourceProject.id, fullPath: snapshot.sourceProject.path },
    sourceBranch: "fix/webengine-css",
    sourceHeadSha: snapshot.sourceHeadSha,
    targetRefSha: snapshot.targetRefSha,
    mrIid: null,
    releaseSetId: "stable-42",
    cliVersion: "0.1.0-dev",
    bundle: {
      id: bundle.manifest.bundleId,
      version: bundle.manifest.version,
      releaseTag: "templates-v1.0.0",
      manifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`),
    },
    protocols: {
      inputSchema: bundle.manifest.inputSchema,
      policySchema: bundle.manifest.policySchema,
      skillProtocol: null,
    },
  };
  return { request, snapshot, binding, bundle };
}

function existingSnapshot(snapshot: ExternalContextSnapshot, iid = 88): ExternalContextSnapshot {
  return validateExternalContextSnapshot({
    ...structuredClone(snapshot),
    metadataRead: { status: "available", evidence: "MR metadata read." },
    mergeRequest: {
      ...structuredClone(snapshot.mergeRequest),
      iid,
      lifecycle: "ready",
    },
  });
}

function remoteValue(snapshot: ExternalContextSnapshot): RemoteMergeRequest {
  const bound = snapshot.mergeRequest.iid === null ? existingSnapshot(snapshot) : snapshot;
  return Object.freeze({
    iid: bound.mergeRequest.iid ?? 88,
    webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
    title: "[fix][runtime] Test",
    description: "managed description",
    draft: false,
    state: "opened",
    sourceProjectId: bound.sourceProject.id,
    sourceBranch: "fix/webengine-css",
    targetProjectId: bound.targetProject.id,
    targetBranch: "develop",
    sourceHeadSha: bound.sourceHeadSha,
    labelIds: bound.mergeRequest.labelIds,
    assigneeUserId: bound.mergeRequest.assigneeUserId,
    reviewerUserIds: bound.mergeRequest.reviewerUserIds,
    squash: true,
    removeSourceBranch: true,
    snapshot: bound,
  });
}

/**
 * A forged "successful" audit with the real transaction shape: an optional
 * create, the managed-field write, and the final description write (`complete`).
 */
function successfulAudit(
  operation: "create" | "update",
  final: RemoteMergeRequest,
  selectionDigest: string,
): TransactionAudit {
  const journal = new TransactionJournal(operation, final.sourceHeadSha, selectionDigest);
  if (operation === "create") {
    const created = journal.start("normal", "create", null);
    created.mutation("confirmed", "req-create");
    created.readSucceeded("req-read-create", final);
    created.postcondition("matched");
  }
  const fields = journal.start("normal", "fields-write", final, "req-pre-fields");
  fields.mutation("confirmed", "req-fields");
  fields.readSucceeded("req-read-fields", final);
  fields.postcondition("matched");
  const description = journal.start("normal", "description-write", final, "req-pre-description");
  description.mutation("confirmed", "req-description");
  description.readSucceeded("req-read-description", final);
  description.postcondition("matched");
  journal.setFinalState("complete");
  return journal.snapshot();
}

function result(
  operation: "create" | "update",
  final: RemoteMergeRequest,
  base: Fixture,
  auditSnapshot: ExternalContextSnapshot = operation === "create" ? base.snapshot : final.snapshot,
): UpdateMergeRequestResult {
  const desired = {
    writePlanVersion: 1 as const,
    title: final.title,
    labelIds: final.labelIds,
    assigneeUserId: final.assigneeUserId,
    reviewerUserIds: final.reviewerUserIds,
    removeSourceBranch: final.removeSourceBranch,
    squash: final.squash,
  };
  const provisional = { ...desired, labelIds: [], assigneeUserId: null, reviewerUserIds: [] };
  return {
    iid: final.iid,
    webUrl: final.webUrl,
    writePlan: {
      writePlanVersion: 1,
      provisional,
      desired,
      statusLabelId: "gid://gitlab/ProjectLabel/50",
      managedLabelIds: final.labelIds,
      preservedLabelIds: [],
    },
    completedWrites: operation === "create"
      ? ["create", "fields-write", "description-write"]
      : ["fields-write", "description-write"],
    recoveredUnknownOutcome: false,
    final,
    verification: {
      request: base.request,
      snapshot: final.snapshot,
      writePlan: desired,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      description: final.description,
      sourceBranch: "fix/webengine-css",
    },
    transaction: successfulAudit(
      operation,
      final,
      candidateSelectionDigest(base.request, candidates, auditSnapshot),
    ),
    forcedDescriptionReplacement: false,
  };
}

function durableVerificationFixture(base: Fixture): {
  readonly request: Request;
  readonly initialSnapshot: ExternalContextSnapshot;
  readonly resolved: readonly Candidate[];
  readonly current: RemoteMergeRequest;
  readonly receipt: ReturnType<typeof buildVerificationReceipt>;
  readonly expected: MergeRequestVerificationResult;
} {
  const request = normalizeAndValidateRequest({
    ...structuredClone(base.request),
    mergeRequest: {
      ...structuredClone(base.request.mergeRequest),
      labelCandidateTokens: [
        `hmrc1_${"E".repeat(43)}`,
        LABEL,
        `hmrc1_${"F".repeat(43)}`,
      ],
    },
  });
  const snapshot = validateExternalContextSnapshot({
    ...structuredClone(base.snapshot),
    labelCandidates: [
      { id: "gid://gitlab/ProjectLabel/10", name: "week::2026-w32-0803-0809" },
      { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
      { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
      { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
    ],
  });
  const resolved: readonly Candidate[] = [
    {
      ...labelCandidate(),
      restId: 10,
      globalId: "gid://gitlab/ProjectLabel/10",
      name: "week::2026-w32-0803-0809",
      policyCategory: "week",
    },
    {
      ...labelCandidate(),
      restId: 20,
      globalId: "gid://gitlab/ProjectLabel/20",
      name: "type::bug",
    },
    {
      ...labelCandidate(),
      restId: 30,
      globalId: "gid://gitlab/ProjectLabel/30",
      name: "priority::p2",
      policyCategory: "priority",
    },
    candidates[1]!,
    candidates[2]!,
  ];
  const writePlan = buildWritePlan({ request, snapshot, resolvedCandidates: resolved, bundle: base.bundle, labelDiff: bugLabelDiff(snapshot) });
  const readySnapshot = validateExternalContextSnapshot({
    ...structuredClone(snapshot),
    metadataRead: { status: "available", evidence: "MR metadata read." },
    mergeRequest: {
      ...structuredClone(snapshot.mergeRequest),
      iid: 88,
      lifecycle: "ready",
      labelIds: writePlan.desired.labelIds,
      assigneeUserId: writePlan.desired.assigneeUserId,
      reviewerUserIds: writePlan.desired.reviewerUserIds,
    },
  });
  const initial: RemoteMergeRequest = {
    iid: 88,
    webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
    title: writePlan.desired.title,
    description: "pending final description",
    draft: false,
    state: "opened",
    sourceProjectId: readySnapshot.sourceProject.id,
    sourceBranch: "fix/webengine-css",
    targetProjectId: readySnapshot.targetProject.id,
    targetBranch: request.targetBranch,
    sourceHeadSha: readySnapshot.sourceHeadSha,
    labelIds: writePlan.desired.labelIds,
    assigneeUserId: writePlan.desired.assigneeUserId,
    reviewerUserIds: writePlan.desired.reviewerUserIds,
    squash: writePlan.desired.squash,
    removeSourceBranch: writePlan.desired.removeSourceBranch,
    snapshot: readySnapshot,
  };
  const description = renderDescription({
    request,
    snapshot: readySnapshot,
    writePlan: writePlan.desired,
    bundle: base.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    renderPhase: "final",
  });
  const current = Object.freeze({ ...initial, description });
  const expectation = Object.freeze({
    request,
    snapshot: readySnapshot,
    writePlan: writePlan.desired,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    description,
    sourceBranch: "fix/webengine-css",
  });
  const receipt = buildVerificationReceipt({
    gitlabOrigin: "https://gitlab.example.test",
    current,
    expected: expectation,
    bundle: base.bundle,
  });
  const qualified = current.snapshot.review.qualifiedReviewerUserIds;
  return {
    request,
    initialSnapshot: snapshot,
    resolved,
    current,
    receipt,
    expected: {
      valid: true,
      level: "structure",
      iid: current.iid,
      webUrl: current.webUrl,
      live: {
        lifecycle: current.draft ? "draft" : "ready",
        ciStatus: current.snapshot.ci.status,
        unresolvedDiscussions: current.snapshot.review.unresolvedDiscussions,
        qualifiedApprovals: qualified === null
          ? null
          : current.snapshot.review.approvedByUserIds.filter((id) =>
              id !== current.snapshot.mergeRequest.authorUserId && qualified.includes(id)).length,
      },
    },
  };
}

function durableCandidateStore(
  base: Fixture,
  operations: string[],
  resolved: readonly Candidate[],
): MergeRequestCommandAdapterDependencies["candidateStore"] {
  return {
    resolve: async (input) => {
      operations.push(`candidate:${String(input.consume === true)}`);
      return {
        contextId: CONTEXT,
        createdAtMs: 1,
        expiresAtMs: 2,
        binding: input.expectedBinding,
        externalSnapshotDigest: sha256CanonicalJson(base.snapshot),
        snapshot: base.snapshot as never,
        candidates: resolved,
      };
    },
  };
}

class RecordingRemote implements MergeRequestRemote {
  readonly operations: string[];
  open: readonly RemoteMergeRequest[] = [];
  readonly current: RemoteMergeRequest;
  readRequestIds: string[] = [];
  readValues: RemoteMergeRequest[] = [];
  private readIndex = 0;

  constructor(operations: string[], snapshot: ExternalContextSnapshot) {
    this.operations = operations;
    this.current = remoteValue(snapshot);
  }

  async create(_input: CreateMergeRequestInput) {
    this.operations.push("mutation:create");
    return valueReceipt({ iid: 88 }, "req-create");
  }

  async findOpen(_input: CreateMergeRequestInput) {
    this.operations.push("read:find-open");
    return valueReceipt(this.open, "req-find");
  }

  async addLabels(_iid: number, _labelIds: readonly string[]) {
    this.operations.push("mutation:add-labels");
    return mutationReceipt("req-label-add");
  }

  async removeLabels(_iid: number, _labelIds: readonly string[]) {
    this.operations.push("mutation:remove-labels");
    return mutationReceipt("req-label-remove");
  }

  async writeManagedFields(_iid: number, _input: ManagedFieldsInput) {
    this.operations.push("mutation:write-fields");
    return mutationReceipt("req-fields");
  }

  async writeDescription(_iid: number, _description: string) {
    this.operations.push("mutation:write-description");
    return mutationReceipt("req-description");
  }

  async read(_iid: number) {
    this.operations.push("read:mr");
    const index = this.readIndex++;
    return valueReceipt(
      this.readValues[index] ?? this.current,
      this.readRequestIds[index] ?? `req-read-${String(index)}`,
    );
  }
}

class StatefulRemote implements MergeRequestRemote {
  readonly operations: string[] = [];
  current: RemoteMergeRequest | null = null;
  failReadAt: number | null = null;
  private requestSequence = 0;
  private readSequence = 0;

  constructor(private readonly initialSnapshot: ExternalContextSnapshot) {}

  private requestId(method: string): string {
    this.requestSequence += 1;
    return `req-${method}-${String(this.requestSequence)}`;
  }

  private requireCurrent(): RemoteMergeRequest {
    if (this.current === null) throw new Error("Merge request does not exist");
    return this.current;
  }

  private replace(patch: Partial<RemoteMergeRequest>): RemoteMergeRequest {
    const previous = this.requireCurrent();
    const next = { ...previous, ...patch };
    const lifecycle = next.state === "merged" ? "merged"
      : next.state === "opened" ? (next.draft ? "draft" : "ready") : "closed";
    const snapshot = validateExternalContextSnapshot({
      ...structuredClone(previous.snapshot),
      mergeRequest: {
        ...structuredClone(previous.snapshot.mergeRequest),
        iid: next.iid,
        lifecycle,
        labelIds: next.labelIds,
        assigneeUserId: next.assigneeUserId,
        reviewerUserIds: next.reviewerUserIds,
      },
    });
    this.current = Object.freeze({ ...next, snapshot });
    return this.current;
  }

  async findOpen(_input: CreateMergeRequestInput) {
    this.operations.push("read:find-open");
    return valueReceipt(this.current === null ? [] : [this.current], this.requestId("find"));
  }

  async create(_input: CreateMergeRequestInput): Promise<never> {
    this.operations.push("mutation:create");
    throw new Error("Retired MR-only create must not reach the remote");
  }

  async addLabels(_iid: number, labelIds: readonly string[]) {
    this.operations.push("mutation:add-labels");
    const current = this.requireCurrent();
    this.replace({ labelIds: [...new Set([...current.labelIds, ...labelIds])] });
    return mutationReceipt(this.requestId("labels-add"));
  }

  async removeLabels(_iid: number, labelIds: readonly string[]) {
    this.operations.push("mutation:remove-labels");
    const removed = new Set(labelIds);
    this.replace({ labelIds: this.requireCurrent().labelIds.filter((id) => !removed.has(id)) });
    return mutationReceipt(this.requestId("labels-remove"));
  }

  async writeManagedFields(_iid: number, input: ManagedFieldsInput) {
    this.operations.push("mutation:write-fields");
    this.replace({
      title: input.title,
      targetBranch: input.targetBranch,
      assigneeUserId: input.assigneeUserId,
      reviewerUserIds: [...input.reviewerUserIds],
      squash: input.squash,
      removeSourceBranch: input.removeSourceBranch,
    });
    return mutationReceipt(this.requestId("fields"));
  }

  async writeDescription(_iid: number, description: string) {
    this.operations.push("mutation:write-description");
    this.replace({ description });
    return mutationReceipt(this.requestId("description"));
  }

  async read(_iid: number) {
    this.operations.push("read:mr");
    this.readSequence += 1;
    const requestId = this.requestId("read");
    if (this.failReadAt === this.readSequence) throw new RemoteReadError("network", requestId);
    return valueReceipt(this.requireCurrent(), requestId);
  }
}

function createInput(): CreateMergeRequestInput {
  return {
    title: "[fix][runtime] Test",
    description: "provisional",
    sourceProjectId: "project:100",
    sourceBranch: "fix/webengine-css",
    targetProjectId: "project:100",
    targetBranch: "develop",
    sourceHeadSha: "3".repeat(40),
    squash: true,
    removeSourceBranch: true,
  } satisfies CreateMergeRequestInput;
}

function managedFieldsInput(): ManagedFieldsInput {
  return {
    title: "[fix][runtime] Test",
    targetBranch: "develop",
    assigneeUserId: null,
    reviewerUserIds: [],
    squash: true,
    removeSourceBranch: true,
  };
}

function candidateStore(
  base: Fixture,
  operations: string[],
): { readonly resolve: MergeRequestCommandAdapterDependencies["candidateStore"]["resolve"] } {
  return {
    resolve: async (input) => {
      operations.push(`candidate:${String(input.consume === true)}`);
      const snapshot = input.expectedBinding.operation === "create"
        ? base.snapshot
        : existingSnapshot(base.snapshot, input.expectedBinding.mrIid ?? 88);
      const resolved: ResolvedContext = {
        contextId: CONTEXT,
        createdAtMs: 1,
        expiresAtMs: 2,
        binding: input.expectedBinding,
        externalSnapshotDigest: sha256CanonicalJson(snapshot),
        snapshot: snapshot as never,
        candidates,
      };
      return resolved;
    },
  };
}

async function performInjectedUpdate(input: UpdateMergeRequestInputs, remote: RecordingRemote, base: Fixture) {
  const read = async () => { try { await input.remote.read(88); } catch { /* injected domain deliberately forges successful reads */ } };
  await read();
  await read();
  try { await input.remote.writeManagedFields(88, managedFieldsInput()); } catch { /* deliberately forged success */ }
  await read();
  await input.verificationReceiptWriter.stageAuthenticated({} as never);
  await read();
  await input.remote.writeDescription(88, "final");
  await read();
  return result("update", remote.current, base);
}

function updateFixture(base: Fixture): Fixture {
  return { ...base, snapshot: existingSnapshot(base.snapshot),
    binding: { ...base.binding, operation: "update", mrIid: 88 } };
}

function preparedCreate(base: Fixture, remote: MergeRequestRemote): PreparedCreateMergeRequestCommand {
  return {
    labelDiff: bugLabelDiff(base.snapshot),
    request: base.request,
    binding: base.binding,
    initialSnapshot: base.snapshot,
    bundle: base.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    remote,
  };
}

function preparedUpdate(base: Fixture, remote: MergeRequestRemote): PreparedUpdateMergeRequestCommand {
  const initial = remoteValue(existingSnapshot(base.snapshot));
  return {
    labelDiff: bugLabelDiff(base.snapshot),
    request: base.request,
    binding: { ...base.binding, operation: "update", mrIid: initial.iid },
    initial,
    bundle: base.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    remote,
  };
}

function dependencies(
  base: Fixture,
  operations: string[],
  overrides: Partial<MergeRequestCommandAdapterDependencies> = {},
): MergeRequestCommandAdapterDependencies {
  return {
    gitlabOrigin: "https://gitlab.example.test",
    readCurrentBinding: async ({ operation, mrIid }) => ({
      ...structuredClone(base.binding),
      operation,
      mrIid,
    }),
    candidateStore: candidateStore(base, operations),
    verifyLiveCandidateIdentities: async () => {
      operations.push("live-identities");
    },
    verificationReceiptWriter: {
      stageAuthenticated: async () => {
        operations.push("receipt-stage");
      },
    },
    verificationReceiptLoader: { loadVerified: async () => null },
    historicalBundleLoader: { loadVerifiedExact: async () => ({ trusted: false, bundle: null }) },
    ...overrides,
  };
}

test("trusted current binding rejects release, protocol, and remote provenance drift before candidate access", async () => {
  const scenarios = [
    (binding: ContextBinding): ContextBinding => ({ ...binding, releaseSetId: "stable-43" }),
    (binding: ContextBinding): ContextBinding => ({
      ...binding,
      protocols: { ...binding.protocols, skillProtocol: 7 },
    }),
    (binding: ContextBinding): ContextBinding => ({
      ...binding,
      sourceProject: { ...binding.sourceProject, fullPath: "attacker/fork" },
    }),
  ];
  for (const drift of scenarios) {
    const base = updateFixture(await fixture());
    const operations: string[] = [];
    const remote = new RecordingRemote(operations, base.snapshot);
    const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
      readCurrentBinding: async () => drift(base.binding),
      domain: {
        update: async () => result("update", remote.current, base),
        create: async () => { throw new Error("unused"); },
      },
    }));

    await assert.rejects(
      adapter.update({ forceReplaceDescription: false, prepare: async () => preparedUpdate(base, remote) }),
      (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
    );
    assert.deepEqual(operations, []);
  }
});

test("candidate preflight snapshot must exactly match the prepared repository snapshot", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const driftedSnapshot = validateExternalContextSnapshot({
    ...structuredClone(base.snapshot),
    ci: { ...structuredClone(base.snapshot.ci), status: "passed" },
  });
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    candidateStore: {
      resolve: async (input) => {
        operations.push(`candidate:${String(input.consume === true)}`);
        return {
          contextId: CONTEXT,
          createdAtMs: 1,
          expiresAtMs: 2,
          binding: input.expectedBinding,
          externalSnapshotDigest: sha256CanonicalJson(driftedSnapshot),
          snapshot: driftedSnapshot as never,
          candidates,
        };
      },
    },
    domain: {
      update: async () => result("update", remote.current, base),
      create: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.update({ forceReplaceDescription: false, prepare: async () => preparedUpdate(base, remote) }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(operations, ["candidate:false"]);
});

test("prepared request mutation during an await is rejected before candidate access", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const prepared = {
    ...preparedUpdate(base, remote),
    request: structuredClone(base.request),
    binding: structuredClone(base.binding),
    initialSnapshot: structuredClone(base.snapshot),
  };
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    readCurrentBinding: async () => {
      (prepared.request as unknown as { targetBranch: string }).targetBranch = "attacker-branch";
      return structuredClone(base.binding);
    },
    domain: {
      update: async (input) => {
        await input.remote.writeManagedFields(88, managedFieldsInput());
        return result("update", remote.current, base);
      },
      create: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.update({ forceReplaceDescription: false, prepare: async () => prepared }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(operations, []);
});

test("trusted binding drift after preflight is rejected before consume and mutation", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  let bindingReads = 0;
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    readCurrentBinding: async () => {
      bindingReads += 1;
      return bindingReads === 1
        ? structuredClone(base.binding)
        : { ...structuredClone(base.binding), releaseSetId: "stable-43" };
    },
    domain: {
      update: async (input) => {
        await input.remote.writeManagedFields(88, managedFieldsInput());
        return result("update", remote.current, base);
      },
      create: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.update({ forceReplaceDescription: false, prepare: async () => preparedUpdate(base, remote) }),
    (error: unknown) => error instanceof RemoteMutationError && error.outcome === "rejected" && error.reason === "conflict",
  );
  assert.equal(bindingReads, 2);
  assert.equal(operations.includes("candidate:true"), false);
  assert.equal(operations.some((operation) => operation.startsWith("mutation:")), false);
});

test("an injected write domain cannot return success without gate, exact audit, and final identity proof", async (t) => {
  const scenarios = ["valid", "no-gate", "digest", "identity", "operation"] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const base = updateFixture(await fixture());
      const operations: string[] = [];
      const remote = new RecordingRemote(operations, base.snapshot);
      remote.readRequestIds = ["req-initial-update", "req-pre-fields", "req-read-fields", "req-pre-description", "req-read-description"];
      const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
        domain: {
          update: async (input) => {
            const successful = scenario === "no-gate" ? result("update", remote.current, base)
              : await performInjectedUpdate(input, remote, base);
            if (scenario === "operation") return { ...successful, transaction: { ...successful.transaction, operation: "create" } };
            if (scenario === "digest") {
              return {
                ...successful,
                transaction: { ...successful.transaction, candidateSelectionDigest: "f".repeat(64) },
              };
            }
            if (scenario === "identity") {
              return {
                ...successful,
                final: { ...successful.final, sourceBranch: "attacker/branch" },
              };
            }
            return successful;
          },
          create: async () => { throw new Error("unused"); },
        },
      }));

      const execution = adapter.update({ forceReplaceDescription: false, prepare: async () => preparedUpdate(base, remote) });
      if (scenario === "valid") assert.equal((await execution).output?.data?.command, "update");
      else await assert.rejects(execution, (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR", scenario);
    });
  }
});

test("write success proof binds each mutation method, outcome, order, and completed write", async (t) => {
  for (const scenario of ["valid", "only-description-write", "wrong-order", "duplicate-request-id", "rejected", "unknown", "read-only", "completed-order"] as const) {
    await t.test(scenario, async () => {
      const base = updateFixture(await fixture()); const operations: string[] = [];
      const remote = new RecordingRemote(operations, base.snapshot);
      remote.readRequestIds = ["req-initial-update", "req-pre-fields", "req-read-fields", "req-pre-description", "req-read-description"];
      if (scenario === "duplicate-request-id") {
        remote.writeManagedFields = async () => { operations.push("mutation:write-fields"); return mutationReceipt("req-description"); };
      } else if (scenario === "rejected" || scenario === "unknown") {
        remote.writeManagedFields = async () => { operations.push("mutation:write-fields");
          throw new RemoteMutationError(scenario === "rejected" ? "rejected" : "unknown", "validation", "req-fields"); };
      }
      const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, { domain: {
        create: async () => { throw new Error("unused"); }, update: async input => {
          let successful;
          if (scenario === "read-only") { await input.remote.read(88); successful = result("update", remote.current, base); }
          else if (scenario === "only-description-write") { await input.remote.writeDescription(88, "final"); successful = result("update", remote.current, base); }
          else if (scenario === "wrong-order") { await input.remote.writeDescription(88, "final"); successful = await performInjectedUpdate(input, remote, base); }
          else successful = await performInjectedUpdate(input, remote, base);
          if (scenario === "duplicate-request-id") {
            const transaction = structuredClone(successful.transaction);
            for (const step of transaction.steps) if (step.mutation !== null)
              (step.mutation as {requestId:string|null}).requestId = "req-description";
            return {...successful, transaction};
          }
          if (scenario === "completed-order") return {...successful, completedWrites:["description-write", "fields-write"]};
          return successful;
        } } }));
      const execution=adapter.update({forceReplaceDescription:false,prepare:async()=>preparedUpdate(base,remote)});
      if(scenario==="valid") assert.equal((await execution).output?.data?.command,"update");
      else await assert.rejects(execution,(error:unknown)=>error instanceof ToolError && error.code==="INTERNAL_ERROR");
    });
  }
});

test("write success binds every audit read to the exact remote query trace", async (t) => {
  for (const scenario of ["valid", "missing", "wrong-method", "wrong-request-id", "wrong-order", "reused-request-id", "threw-read", "snapshot-mismatch"] as const) {
    await t.test(scenario, async () => {
      const base = updateFixture(await fixture()); const operations:string[]=[];
      const remote = new RecordingRemote(operations,base.snapshot); const final=remote.current;
      const ids=["req-initial-update","req-pre-fields","req-read-fields","req-pre-description","req-read-description"];
      let readIndex=0;
      remote.read=async()=>{ const index=readIndex++; operations.push("read:mr");
        if(scenario==="threw-read" && index===2) throw new RemoteReadError("network",ids[index]??null);
        const value=scenario==="snapshot-mismatch" && index===2?{...final,description:"changed"}:final;
        return valueReceipt(value,scenario==="wrong-request-id"&&index===2?"req-wrong":
          scenario==="reused-request-id"&&index===2?"req-fields":ids[index]??"extra"); };
      const adapter=createMergeRequestCommandAdapter(dependencies(base,operations,{domain:{
        create:async()=>{throw new Error("unused");},update:async input=>{
          await input.remote.read(88);
          if(scenario==="wrong-method") await input.remote.findOpen(createInput());
          else if(scenario!=="missing" && scenario!=="wrong-order") await input.remote.read(88);
          await input.remote.writeManagedFields(88,managedFieldsInput());
          if(scenario==="wrong-order") await input.remote.read(88);
          try{await input.remote.read(88);}catch{/* domain forges successful postread */}
          await input.verificationReceiptWriter.stageAuthenticated({} as never);
          await input.remote.read(88); await input.remote.writeDescription(88,"final"); await input.remote.read(88);
          const forged=result("update",final,base);
          if(scenario==="reused-request-id"){const transaction=structuredClone(forged.transaction);
            (transaction.steps[0]!.postRead as {requestId:string|null}).requestId="req-fields";return {...forged,transaction};}
          return forged;
        }}}));
      const execution=adapter.update({forceReplaceDescription:false,prepare:async()=>preparedUpdate(base,remote)});
      if(scenario==="valid") assert.equal((await execution).output?.data?.command,"update");
      else await assert.rejects(execution,(error:unknown)=>error instanceof ToolError && error.code==="INTERNAL_ERROR");
    });
  }
});

test("the default update domain satisfies the exact remote query proof for a seeded historical MR", async () => {
  const base = await fixture(); const durable = durableVerificationFixture(base);
  const writeBase:Fixture={...base,request:durable.request,snapshot:durable.current.snapshot,
    binding:{...base.binding,operation:"update",mrIid:88}};
  const operations:string[]=[];const remote=new StatefulRemote(writeBase.snapshot);remote.current=durable.current;
  const adapter=createMergeRequestCommandAdapter(dependencies(writeBase,operations,{
    candidateStore:durableCandidateStore(writeBase,operations,durable.resolved)}));
  const execution=await adapter.update({forceReplaceDescription:false,prepare:async()=>({...preparedUpdate(writeBase,remote),initial:remote.current!})});
  assert.equal(execution.output?.data?.command,"update");assert.equal(execution.output?.data?.lifecycle,"ready");
  assert.equal(execution.context?.remoteWrite?.state,"written");assert.equal(remote.operations[0],"read:mr");
  assert.deepEqual(remote.operations.filter(operation=>operation.startsWith("mutation:")),["mutation:write-fields","mutation:write-description"]);
  assert.deepEqual(execution.output?.data?.completedWrites,["fields-write","description-write"]);
  assert.equal(remote.current?.draft,false);assert.equal(remote.operations.at(-1),"read:mr");
});

async function pristineAdapterResumeFixture() {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  const writeBase: Fixture = { ...base, request: durable.request, snapshot: durable.initialSnapshot };
  const originalRequest = normalizeAndValidateRequest({ ...durable.request,
    contextId: `hmrx1_${"G".repeat(43)}`,
    mergeRequest: { ...durable.request.mergeRequest,
      labelCandidateTokens: ["original-week", "original-type", "original-priority"],
      assigneeCandidateToken: "original-assignee" },
    review: { ...durable.request.review, reviewerCandidateTokens: ["original-reviewer"] },
  });
  const originalContext: ResolvedContext = {
    contextId: originalRequest.contextId, createdAtMs: 1, expiresAtMs: 2, binding: base.binding,
    externalSnapshotDigest: sha256CanonicalJson(writeBase.snapshot),
    snapshot: copyJsonValue(writeBase.snapshot), candidates: durable.resolved,
  };
  const remote = new StatefulRemote(writeBase.snapshot);
  remote.current=seedHistoricalMr({request:originalRequest,initialSnapshot:writeBase.snapshot,
    resolvedCandidates:durable.resolved,bundle:base.bundle,releaseTag:base.binding.bundle.releaseTag,
    cliVersion:base.binding.cliVersion,sourceBranch:base.binding.sourceBranch,gitlabOrigin:base.binding.gitlabOrigin,
    labelDiff:bugLabelDiff(writeBase.snapshot),provisional:true}).current;
  remote.operations.length = 0;
  return { writeBase, remote, resolved: durable.resolved,
    resume: { iid: 88, originalRequest, originalContext } };
}

test("explicit resume preserves the adapter query, consumption, receipt, and update-audit proofs", async () => {
  const { writeBase, remote, resolved, resume } = await pristineAdapterResumeFixture();
  const operations: string[] = [];
  const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
    candidateStore: durableCandidateStore(writeBase, operations, resolved),
  }));
  const execution = await adapter.create({ upsert: false, resume,
    prepare: async () => preparedCreate(writeBase, remote) });
  assert.equal(execution.output?.data?.command, "update");
  assert.equal(execution.context?.remoteWrite?.state, "written");
  assert.deepEqual(remote.operations.slice(0, 2), ["read:find-open", "read:mr"]);
  assert.equal(remote.operations.includes("mutation:create"), false);
  assert.equal(remote.operations.at(-1), "read:mr");
  assert.equal(operations.filter((operation) => operation === "candidate:true").length, 1);
  assert.equal(operations.filter((operation) => operation === "receipt-stage").length, 1);
  assert.equal(remote.current?.draft, false);
  const serialized = JSON.stringify(execution);
  for (const secret of [...BEARERS, resume.originalRequest.contextId, "original-assignee"]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("resume evidence is detached and frozen before invoking the domain", async () => {
  const { writeBase, remote, resolved, resume } = await pristineAdapterResumeFixture();
  const operations: string[] = [];
  const sentinel = new ToolError("INPUT_ERROR", "stop after inspecting resume proof", {
    field: "--resume", expected: "immutable proof", actual: "test inspection", safeNextStep: "retry",
  });
  const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
    candidateStore: durableCandidateStore(writeBase, operations, resolved),
    domain: { create: async (input) => {
      assert.ok(input.resume);
      assert.notEqual(input.resume.originalContext, resume.originalContext);
      assert.notEqual(input.resume.originalRequest, resume.originalRequest);
      assert.ok(Object.isFrozen(input.resume));
      assert.ok(Object.isFrozen(input.resume.originalContext.candidates));
      assert.ok(Object.isFrozen(input.resume.binding));
      throw sentinel;
    }, update: async () => { throw new Error("unused"); } },
  }));
  await assert.rejects(adapter.create({ upsert: false, resume,
    prepare: async () => preparedCreate(writeBase, remote) }), (error: unknown) => error === sentinel);
  assert.equal(Object.isFrozen(resume.originalContext), false);
  assert.deepEqual(remote.operations, []);
});

test("resume blocks domain attempts to create or mutate another IID before candidate consumption", async () => {
  for (const attempt of ["create", "wrong-iid"] as const) {
    const { writeBase, remote, resolved, resume } = await pristineAdapterResumeFixture();
    const operations: string[] = [];
    const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
      candidateStore: durableCandidateStore(writeBase, operations, resolved),
      domain: { create: async (input) => {
        if (attempt === "create") await input.remote.create(createInput());
        else await input.remote.addLabels(89, ["gid://gitlab/ProjectLabel/20"]);
        throw new Error("an unauthorized resume mutation reached the transport");
      }, update: async () => { throw new Error("unused"); } },
    }));
    await assert.rejects(adapter.create({ upsert: false, resume,
      prepare: async () => preparedCreate(writeBase, remote) }),
      (error: unknown) => error instanceof RemoteMutationError && error.outcome === "rejected", attempt);
    assert.deepEqual(remote.operations, [], attempt);
    assert.equal(operations.includes("candidate:true"), false, attempt);
  }
});

test("resume evidence mutation across preparation and the first-write gate rejects before consumption", async () => {
  for (const phase of ["prepare", "binding", "live"] as const) {
    const fixture = await pristineAdapterResumeFixture();
    const resume = structuredClone(fixture.resume);
    const operations: string[] = [];
    const mutate = () => { (resume.originalContext as { createdAtMs: number }).createdAtMs += 1; };
    const adapter = createMergeRequestCommandAdapter(dependencies(fixture.writeBase, operations, {
      candidateStore: durableCandidateStore(fixture.writeBase, operations, fixture.resolved),
      readCurrentBinding: async () => {
        if (phase === "binding") mutate();
        return fixture.writeBase.binding;
      },
      verifyLiveCandidateIdentities: async () => { if (phase === "live") mutate(); },
    }));
    await assert.rejects(adapter.create({ upsert: false, resume, prepare: async () => {
      if (phase === "prepare") mutate();
      return preparedCreate(fixture.writeBase, fixture.remote);
    } }), (error: unknown) => error instanceof ToolError &&
      error.code === (phase === "live" ? "CONCURRENT_UPDATE" : "INTERNAL_ERROR"), phase);
    assert.equal(fixture.remote.operations.some((operation) => operation.startsWith("mutation:")), false, phase);
    assert.equal(operations.includes("candidate:true"), false, phase);
  }
});

test("a default update readback failure preserves the real partial audit",async()=>{
  const base=await fixture();const durable=durableVerificationFixture(base);
  const writeBase:Fixture={...base,request:durable.request,snapshot:durable.current.snapshot,
    binding:{...base.binding,operation:"update",mrIid:88}};
  const operations:string[]=[];const remote=new StatefulRemote(writeBase.snapshot);remote.current=durable.current;remote.failReadAt=3;
  const adapter=createMergeRequestCommandAdapter(dependencies(writeBase,operations,{candidateStore:durableCandidateStore(writeBase,operations,durable.resolved)}));
  let caught:unknown;try{await adapter.update({forceReplaceDescription:false,prepare:async()=>({...preparedUpdate(writeBase,remote),initial:remote.current!})});}catch(error){caught=error;}
  assert.equal(caught instanceof ToolError && caught.code==="PARTIAL_REMOTE_STATE",true);
  assert.equal(getTransactionAudit(caught)?.steps[0]?.postRead.outcome,"failed");
  assert.deepEqual(remote.operations,["read:mr","read:mr","mutation:write-fields","read:mr"]);
});

test("update runs every read precondition before live revalidation, consumption, and the first mutation", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  remote.readRequestIds = [
    "req-initial-update",
    "req-pre-fields",
    "req-read-fields",
    "req-pre-description",
    "req-read-description",
  ];
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      update: async input => performInjectedUpdate(input, remote, base),
      create: async () => { throw new Error("unused"); },
    },
  }));

  const execution = await adapter.update({
    forceReplaceDescription: false,
    prepare: async () => {
      operations.push("prepare");
      return preparedUpdate(base, remote);
    },
  });

  assert.deepEqual(operations, [
    "prepare", "candidate:false", "read:mr", "read:mr", "live-identities",
    "candidate:false", "candidate:true", "mutation:write-fields", "read:mr",
    "receipt-stage", "read:mr", "mutation:write-description", "read:mr",
  ]);
  assert.equal(execution.context?.remoteWrite?.state, "written");
  assert.equal(execution.output?.data?.command, "update");
  assert.equal(execution.output?.data?.lifecycle, "ready");
  const mandatory = execution.output?.data?.mandatoryLabels as { names: string[]; ids: string[]; diffDigest: string; source: string };
  assert.deepEqual(mandatory.names, ["type::bug", "priority::p2", "status::review"]);
  assert.equal(mandatory.source, "diff");
  assert.match(mandatory.diffDigest, /^[a-f0-9]{64}$/u);
  assert.equal(mandatory.ids.length, 3);
  const projectedCandidates = execution.output?.data?.selectedCandidates as readonly Record<string, unknown>[];
  assert.deepEqual(Object.keys(projectedCandidates[0] ?? {}).sort(), [
    "globalId", "kind", "name", "policyCategory", "restId", "scopeId", "scopeKind", "scopePath",
  ]);
  const envelope = createSuccessOutput({
    cliVersion: "0.1.0-dev",
    ...execution.context,
  }, execution.output);
  const serialized = JSON.stringify(envelope);
  for (const bearer of BEARERS) assert.equal(serialized.includes(bearer), false);
  assert.equal(serialized.includes("contextId"), false);
});

test("legacy adapter create rejects ordinary and upsert attempts before candidate consumption", async () => {
  for (const upsert of [false, true]) {
    const base = await fixture(); const operations: string[] = [];
    const remote = new RecordingRemote(operations, base.snapshot);
    const adapter = createMergeRequestCommandAdapter(dependencies(base, operations));
    await assert.rejects(adapter.create({ upsert, prepare: async () => preparedCreate(base, remote) }),
      { code: "INPUT_ERROR" });
    assert.deepEqual(operations, []);
  }
});

test("preparation and live identity failures leave candidates reusable and perform zero writes", async () => {
  const base = updateFixture(await fixture());
  for (const phase of ["prepare", "live"] as const) {
    const operations: string[] = [];
    const remote = new RecordingRemote(operations, base.snapshot);
    const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
      verifyLiveCandidateIdentities: async () => {
        operations.push("live-identities");
        throw new ToolError("LABEL_ERROR", "Selected identity changed", {
          field: "mergeRequest.labelCandidateTokens",
          expected: "the current label identity",
          actual: "label identity drift",
          safeNextStep: "Run context again.",
        });
      },
      domain: {
        update: async (input) => {
          await input.remote.writeManagedFields(88, managedFieldsInput());
          return result("update", remote.current, base);
        },
        create: async () => { throw new Error("unused"); },
      },
    }));
    await assert.rejects(
      adapter.update({
        forceReplaceDescription: false,
        prepare: async () => {
          operations.push("prepare");
          if (phase === "prepare") throw new Error("precondition failed");
          return preparedUpdate(base, remote);
        },
      }),
    );
    assert.equal(operations.includes("candidate:true"), false, phase);
    assert.equal(operations.some((operation) => operation.startsWith("mutation:")), false, phase);
  }
});

test("prepared input drift from the context binding fails before candidate access", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      update: async () => result("update", remote.current, base),
      create: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.update({
      forceReplaceDescription: false,
      prepare: async () => ({
        ...preparedUpdate(base, remote),
        sourceBranch: "feature/drifted-after-preflight",
      }),
    }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(operations, []);
});

test("update completes its initial remote read before the shared mutation gate", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, existingSnapshot(base.snapshot));
  remote.readRequestIds = [
    "req-initial-update",
    "req-pre-fields",
    "req-read-fields",
    "req-pre-description",
    "req-read-description",
  ];
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      create: async () => { throw new Error("unused"); },
      update: async (input) => {
        await input.remote.read(input.initial.iid);
        await input.remote.read(input.initial.iid);
        await input.remote.writeManagedFields(input.initial.iid, {
          title: input.initial.title,
          targetBranch: input.initial.targetBranch,
          assigneeUserId: input.initial.assigneeUserId,
          reviewerUserIds: input.initial.reviewerUserIds,
          squash: input.initial.squash,
          removeSourceBranch: input.initial.removeSourceBranch,
        });
        await input.remote.read(input.initial.iid);
        await input.remote.read(input.initial.iid);
        await input.remote.writeDescription(input.initial.iid, "final");
        await input.remote.read(input.initial.iid);
        return { ...result("update", remote.current, base), forcedDescriptionReplacement: false };
      },
    },
  }));

  const execution = await adapter.update({
    forceReplaceDescription: false,
    prepare: async () => preparedUpdate(base, remote),
  });

  assert.deepEqual(operations.slice(0, 11), [
    "candidate:false",
    "read:mr",
    "read:mr",
    "live-identities",
    "candidate:false",
    "candidate:true",
    "mutation:write-fields",
    "read:mr",
    "read:mr",
    "mutation:write-description",
    "read:mr",
  ]);
  assert.equal(execution.output?.data?.command, "update");
});

test("write failures retain the original attached transaction audit for output mapping", async () => {
  const base = updateFixture(await fixture());
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const failure = new ToolError("PARTIAL_REMOTE_STATE", "Remote state is unknown", {
    field: "mergeRequest",
    expected: "a fully read-back merge request matching the verified write plan",
    actual: "unknown mutation outcome",
    safeNextStep: "Run verify.",
  });
  const journal = new TransactionJournal("create", base.snapshot.sourceHeadSha, "0".repeat(64));
  const step = journal.start("normal", "create", null);
  step.mutation("unknown", "req-create");
  step.readFailed("req-read");
  journal.setFinalState("unknown");
  attachTransactionAudit(failure, journal.snapshot());
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      update: async (input) => {
        await input.remote.writeManagedFields(88, managedFieldsInput());
        throw failure;
      },
      create: async () => { throw new Error("unused"); },
    },
  }));

  let caught: unknown;
  try {
    await adapter.update({ forceReplaceDescription: false, prepare: async () => preparedUpdate(base, remote) });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught, failure);
  assert.equal(getTransactionAudit(caught)?.finalState, "unknown");
});

test("verify ignores an injected domain result and enforces the real merge gate", async () => {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  assert.equal(durable.current.snapshot.ci.status, "pending");
  assert.deepEqual(durable.current.snapshot.review.approvedByUserIds, []);
  const operations: string[] = [];
  let injectedVerifyCalls = 0;
  const injectedDomain = {
    create: async () => { throw new Error("unused"); },
    update: async () => { throw new Error("unused"); },
    verify: async (input: Parameters<typeof verifyStoredMergeRequest>[0]) => {
      injectedVerifyCalls += 1;
      const structure = await verifyStoredMergeRequest({ ...input, level: "structure" });
      return { ...structure, level: "merge" as const };
    },
  };
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    verificationReceiptLoader: {
      loadVerified: async () => ({ trusted: true as const, receipt: durable.receipt }),
    },
    historicalBundleLoader: {
      loadVerifiedExact: async () => ({ trusted: true as const, bundle: base.bundle }),
    },
    domain: injectedDomain,
  }));

  await assert.rejects(
    adapter.verify({ level: "merge", prepare: async () => ({ current: durable.current }) }),
    (error: unknown) => error instanceof ToolError && error.code === "POSTCONDITION_ERROR",
  );
  assert.equal(injectedVerifyCalls, 0);
  assert.equal(operations.some((operation) => operation.startsWith("mutation:")), false);
});

test("default stored verification loads the durable receipt and exact historical Bundle", async () => {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  const operations: string[] = [];
  let loadedReference: unknown;
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    verificationReceiptLoader: {
      loadVerified: async () => {
        operations.push("receipt-load");
        return { trusted: true as const, receipt: structuredClone(durable.receipt) };
      },
    },
    historicalBundleLoader: {
      loadVerifiedExact: async (reference) => {
        operations.push("bundle-load");
        loadedReference = reference;
        return { trusted: true as const, bundle: base.bundle };
      },
    },
  }));

  const execution = await adapter.verify({
    level: "structure",
    prepare: async () => ({ current: structuredClone(durable.current) }),
  });

  assert.deepEqual(operations, ["receipt-load", "bundle-load"]);
  assert.deepEqual(loadedReference, durable.receipt.bundle);
  assert.equal(execution.context?.remoteWrite?.state, "not-attempted");
  assert.equal(execution.output?.data?.valid, true);
});
