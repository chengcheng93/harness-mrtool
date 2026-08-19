import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import type {
  CreateDraftInput,
  CreateMergeRequestResult,
  ManagedFieldsInput,
  MergeRequestRemote,
  RemoteMergeRequest,
} from "../../src/app/create-mr.ts";
import { mutationReceipt, valueReceipt } from "../../src/app/remote-receipt.ts";
import {
  RemoteMutationError,
  RemoteReadError,
  UnknownRemoteOutcomeError,
} from "../../src/app/remote-outcome.ts";
import {
  attachTransactionAudit,
  candidateSelectionDigest,
  TransactionJournal,
  getTransactionAudit,
  type TransactionAuditV1,
} from "../../src/app/transaction-journal.ts";
import {
  buildVerificationReceipt,
  verifyStoredMergeRequest,
  type MergeRequestVerificationResult,
} from "../../src/app/verify-mr.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256CanonicalJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
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
    { id: "gid://gitlab/ProjectLabel/40", name: "status::doing" },
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

function remoteValue(snapshot: ExternalContextSnapshot, draft = false): RemoteMergeRequest {
  const bound = snapshot.mergeRequest.iid === null ? existingSnapshot(snapshot) : snapshot;
  return Object.freeze({
    iid: bound.mergeRequest.iid ?? 88,
    webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
    title: draft ? "Draft: [fix][runtime] Test" : "[fix][runtime] Test",
    description: "managed description",
    draft,
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

function successfulAudit(
  operation: "create" | "update",
  final: RemoteMergeRequest,
  selectionDigest: string,
): TransactionAuditV1 {
  const journal = new TransactionJournal(operation, final.sourceHeadSha, selectionDigest);
  if (operation === "create") {
    const created = journal.start("normal", "create-draft", null);
    created.mutation("confirmed", "req-create");
    created.readSucceeded("req-read-create", final);
    created.postcondition("matched");
    const description = journal.start("normal", "description-write", final, "req-pre-description");
    description.mutation("confirmed", "req-description");
    description.readSucceeded("req-read-description", final);
    description.postcondition("matched");
  } else {
    const fields = journal.start("normal", "fields-write", final, "req-pre-fields");
    fields.mutation("confirmed", "req-fields");
    fields.readSucceeded("req-read-fields", final);
    fields.postcondition("matched");
  }
  const ready = journal.start("normal", "mark-ready", final, "req-pre-ready");
  ready.mutation("confirmed", "req-ready");
  ready.readSucceeded("req-read-ready", final);
  ready.postcondition("matched");
  journal.setFinalState("ready-proven");
  return journal.snapshot();
}

function result(
  operation: "create" | "update",
  final: RemoteMergeRequest,
  base: Fixture,
  auditSnapshot: ExternalContextSnapshot = operation === "create" ? base.snapshot : final.snapshot,
): CreateMergeRequestResult {
  const desired = {
    writePlanVersion: 1 as const,
    title: final.title,
    labelIds: final.labelIds,
    assigneeUserId: final.assigneeUserId,
    reviewerUserIds: final.reviewerUserIds,
    removeSourceBranch: final.removeSourceBranch,
    squash: final.squash,
  };
  const draft = { ...desired, title: `Draft: ${final.title}` };
  return {
    iid: final.iid,
    webUrl: final.webUrl,
    writePlan: {
      writePlanVersion: 1,
      intent: final.draft ? "draft" : "ready",
      provisional: draft,
      draft,
      desired,
      draftStatusLabelId: "gid://gitlab/ProjectLabel/40",
      readyStatusLabelId: "gid://gitlab/ProjectLabel/50",
      managedLabelIds: final.labelIds,
      preservedLabelIds: [],
    },
    completedWrites: operation === "create"
      ? ["create-draft", "description-write", "mark-ready"]
      : ["fields-write", "mark-ready"],
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
    ...(operation === "update" ? { forcedDescriptionReplacement: false } : {}),
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
      { id: "gid://gitlab/ProjectLabel/30", name: "priority::p1" },
      { id: "gid://gitlab/ProjectLabel/40", name: "status::doing" },
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
      name: "priority::p1",
      policyCategory: "priority",
    },
    candidates[1]!,
    candidates[2]!,
  ];
  const writePlan = buildWritePlan({ request, snapshot, resolvedCandidates: resolved, bundle: base.bundle });
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

  async createDraft(_input: CreateDraftInput) {
    this.operations.push("mutation:create-draft");
    return valueReceipt({ iid: 88 }, "req-create");
  }

  async findOpen(_input: CreateDraftInput) {
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

  async markReady(_iid: number, _title: string) {
    this.operations.push("mutation:mark-ready");
    return mutationReceipt("req-ready");
  }

  async markDraft(_iid: number, _title: string) {
    this.operations.push("mutation:mark-draft");
    return mutationReceipt("req-draft");
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
  unknownCreate = false;
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

  async findOpen(_input: CreateDraftInput) {
    this.operations.push("read:find-open");
    return valueReceipt(this.current === null ? [] : [this.current], this.requestId("find"));
  }

  async createDraft(input: CreateDraftInput) {
    this.operations.push("mutation:create-draft");
    const snapshot = validateExternalContextSnapshot({
      ...structuredClone(this.initialSnapshot),
      metadataRead: { status: "available", evidence: "MR metadata read." },
      mergeRequest: {
        ...structuredClone(this.initialSnapshot.mergeRequest),
        iid: 88,
        lifecycle: "draft",
        labelIds: [],
        assigneeUserId: null,
        reviewerUserIds: [],
      },
    });
    this.current = Object.freeze({
      iid: 88,
      webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
      title: input.title,
      description: input.description,
      draft: true,
      state: "opened" as const,
      sourceProjectId: input.sourceProjectId,
      sourceBranch: input.sourceBranch,
      targetProjectId: input.targetProjectId,
      targetBranch: input.targetBranch,
      sourceHeadSha: input.sourceHeadSha,
      labelIds: [],
      assigneeUserId: null,
      reviewerUserIds: [],
      squash: input.squash,
      removeSourceBranch: input.removeSourceBranch,
      snapshot,
    });
    const requestId = this.requestId("create");
    if (this.unknownCreate) throw new UnknownRemoteOutcomeError("unknown create", requestId);
    return valueReceipt({ iid: 88 }, requestId);
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

  async markReady(_iid: number, title: string) {
    this.operations.push("mutation:mark-ready");
    this.replace({ title, draft: false });
    return mutationReceipt(this.requestId("ready"));
  }

  async markDraft(_iid: number, title: string) {
    this.operations.push("mutation:mark-draft");
    this.replace({ title, draft: true });
    return mutationReceipt(this.requestId("draft"));
  }

  async read(_iid: number) {
    this.operations.push("read:mr");
    this.readSequence += 1;
    const requestId = this.requestId("read");
    if (this.failReadAt === this.readSequence) throw new RemoteReadError("network", requestId);
    return valueReceipt(this.requireCurrent(), requestId);
  }
}

function createInput(): CreateDraftInput {
  return {
    title: "Draft: [fix][runtime] Test",
    description: "provisional",
    sourceProjectId: "project:100",
    sourceBranch: "fix/webengine-css",
    targetProjectId: "project:100",
    targetBranch: "develop",
    sourceHeadSha: "3".repeat(40),
    squash: true,
    removeSourceBranch: true,
  } satisfies CreateDraftInput;
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

function preparedCreate(base: Fixture, remote: MergeRequestRemote): PreparedCreateMergeRequestCommand {
  return {
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
    const base = await fixture();
    const operations: string[] = [];
    const remote = new RecordingRemote(operations, base.snapshot);
    const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
      readCurrentBinding: async () => drift(base.binding),
      domain: {
        create: async () => result("create", remote.current, base),
        update: async () => { throw new Error("unused"); },
      },
    }));

    await assert.rejects(
      adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
      (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
    );
    assert.deepEqual(operations, []);
  }
});

test("candidate preflight snapshot must exactly match the prepared repository snapshot", async () => {
  const base = await fixture();
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
      create: async () => result("create", remote.current, base),
      update: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(operations, ["candidate:false"]);
});

test("prepared request mutation during an await is rejected before candidate access", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const prepared = {
    ...preparedCreate(base, remote),
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
      create: async (input) => {
        await input.remote.createDraft(createInput());
        return result("create", remote.current, base);
      },
      update: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.create({ upsert: false, prepare: async () => prepared }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.deepEqual(operations, []);
});

test("trusted binding drift after preflight is rejected before consume and mutation", async () => {
  const base = await fixture();
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
      create: async (input) => {
        await input.remote.findOpen(createInput());
        await input.remote.createDraft(createInput());
        return result("create", remote.current, base);
      },
      update: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(bindingReads, 2);
  assert.equal(operations.includes("candidate:true"), false);
  assert.equal(operations.some((operation) => operation.startsWith("mutation:")), false);
});

test("an injected write domain cannot return success without gate, exact audit, and final identity proof", async (t) => {
  const scenarios = ["no-gate", "digest", "identity", "operation"] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const base = await fixture();
      const operations: string[] = [];
      const remote = new RecordingRemote(operations, base.snapshot);
      const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
        domain: {
          create: async (input) => {
            if (scenario !== "no-gate") await input.remote.createDraft(createInput());
            const successful = result(
              scenario === "operation" ? "update" : "create",
              remote.current,
              base,
            );
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
          update: async () => { throw new Error("unused"); },
        },
      }));

      await assert.rejects(
        adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
        (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
        scenario,
      );
    });
  }
});

test("write success proof binds each mutation method, outcome, order, and completed write", async (t) => {
  const scenarios = [
    "only-mark-ready",
    "wrong-order",
    "duplicate-request-id",
    "rejected",
    "unknown",
    "read-only",
    "completed-order",
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const base = await fixture();
      const operations: string[] = [];
      const remote = new RecordingRemote(operations, base.snapshot);
      if (scenario === "duplicate-request-id") {
        remote.createDraft = async () => {
          operations.push("mutation:create-draft");
          return valueReceipt({ iid: 88 }, "req-ready");
        };
        remote.writeDescription = async () => {
          operations.push("mutation:write-description");
          return mutationReceipt("req-ready");
        };
      } else if (scenario === "rejected") {
        remote.createDraft = async () => {
          operations.push("mutation:create-draft");
          throw new RemoteMutationError("rejected", "validation", "req-create");
        };
      } else if (scenario === "unknown") {
        remote.createDraft = async () => {
          operations.push("mutation:create-draft");
          throw new UnknownRemoteOutcomeError("unknown create", "req-create");
        };
      }
      const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
        domain: {
          create: async (input) => {
            if (scenario === "read-only") {
              await input.remote.findOpen(createInput());
              await input.remote.read(88);
            } else if (scenario === "only-mark-ready") {
              await input.remote.markReady(88, "[fix][runtime] Test");
            } else if (scenario === "wrong-order") {
              await input.remote.markReady(88, "[fix][runtime] Test");
              await input.remote.writeDescription(88, "final");
              await input.remote.createDraft(createInput());
            } else {
              try {
                await input.remote.createDraft(createInput());
              } catch {
                // The injected domain is deliberately trying to turn a failed write into success.
              }
              await input.remote.writeDescription(88, "final");
              await input.remote.markReady(88, "[fix][runtime] Test");
            }
            const successful = result("create", remote.current, base);
            if (scenario === "only-mark-ready" || scenario === "duplicate-request-id") {
              const transaction = structuredClone(successful.transaction);
              for (const step of transaction.steps) {
                if (step.mutation !== null) {
                  (step.mutation as { requestId: string | null }).requestId = "req-ready";
                }
              }
              return { ...successful, transaction };
            }
            if (scenario === "completed-order") {
              return { ...successful, completedWrites: ["mark-ready", "create-draft"] };
            }
            return successful;
          },
          update: async () => { throw new Error("unused"); },
        },
      }));

      await assert.rejects(
        adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
        (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
      );
    });
  }
});

test("unknown create recovery requires the remote reads claimed by the audit", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  remote.createDraft = async () => {
    operations.push("mutation:create-draft");
    throw new UnknownRemoteOutcomeError("unknown create", "req-create");
  };
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      create: async (input) => {
        try {
          await input.remote.createDraft(createInput());
        } catch {
          // Deliberately omit the recovery query and every mutation readback.
        }
        await input.remote.writeDescription(88, "final");
        await input.remote.markReady(88, "[fix][runtime] Test");
        const forged = result("create", remote.current, base);
        const journal = new TransactionJournal(
          "create",
          remote.current.sourceHeadSha,
          forged.transaction.candidateSelectionDigest,
        );
        const created = journal.start("normal", "create-draft", null);
        created.mutation("unknown", "req-create");
        const recovery = journal.start("recovery", "create-outcome-query", null);
        recovery.readResultSucceeded("req-recovery", [remote.current]);
        recovery.postcondition("matched");
        journal.markRecoveredUnknown();
        const description = journal.start(
          "normal",
          "description-write",
          remote.current,
          "req-pre-description",
        );
        description.mutation("confirmed", "req-description");
        description.readSucceeded("req-read-description", remote.current);
        description.postcondition("matched");
        const ready = journal.start("normal", "mark-ready", remote.current, "req-pre-ready");
        ready.mutation("confirmed", "req-ready");
        ready.readSucceeded("req-read-ready", remote.current);
        ready.postcondition("matched");
        journal.setFinalState("ready-proven");
        return {
          ...forged,
          completedWrites: ["create-draft.recovered", "description-write", "mark-ready"],
          recoveredUnknownOutcome: true,
          transaction: journal.snapshot(),
        };
      },
      update: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
    (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
  );
  assert.equal(operations.some((operation) => operation.startsWith("read:")), false);
});

test("write success binds every audit read to the exact remote query trace", async (t) => {
  const scenarios = [
    "missing",
    "wrong-method",
    "wrong-request-id",
    "wrong-order",
    "reused-request-id",
    "threw-read",
    "snapshot-mismatch",
  ] as const;
  for (const scenario of scenarios) {
    await t.test(scenario, async () => {
      const base = await fixture();
      const operations: string[] = [];
      const remote = new RecordingRemote(operations, base.snapshot);
      const final = remote.current;
      const drifted = Object.freeze({ ...final, description: "different remote description" });
      const ids = [
        scenario === "wrong-request-id" ? "req-wrong"
          : scenario === "reused-request-id" ? "req-create" : "req-read-create",
        "req-pre-description",
        "req-read-description",
        "req-pre-ready",
        "req-read-ready",
      ];
      const values = [scenario === "snapshot-mismatch" ? drifted : final, final, final, final, final];
      if (scenario === "wrong-method") {
        ids.shift();
        values.shift();
        let findCalls = 0;
        remote.findOpen = async () => {
          operations.push("read:find-open");
          findCalls += 1;
          return findCalls === 1
            ? valueReceipt([], "req-find")
            : valueReceipt([final], "req-read-create");
        };
      }
      let readIndex = 0;
      remote.read = async () => {
        operations.push("read:mr");
        const index = readIndex++;
        if (scenario === "threw-read" && index === 0) {
          throw new RemoteReadError("network", "req-read-create");
        }
        return valueReceipt(values[index] ?? final, ids[index] ?? `req-extra-${String(index)}`);
      };
      const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
        domain: {
          create: async (input) => {
            await input.remote.findOpen(createInput());
            await input.remote.createDraft(createInput());
            if (scenario !== "missing") {
              if (scenario === "wrong-method") {
                await input.remote.findOpen(createInput());
              } else {
                try {
                  await input.remote.read(88);
                } catch {
                  // The fake domain continues and forges a successful read receipt in its audit.
                }
              }
              if (scenario === "wrong-order") {
                await input.remote.writeDescription(88, "final");
                await input.remote.read(88);
              } else {
                await input.remote.read(88);
                await input.remote.writeDescription(88, "final");
              }
              await input.remote.read(88);
              await input.remote.read(88);
            } else {
              await input.remote.writeDescription(88, "final");
            }
            await input.remote.markReady(88, "[fix][runtime] Test");
            if (scenario !== "missing") await input.remote.read(88);
            const forged = result("create", final, base);
            if (scenario === "reused-request-id") {
              const transaction = structuredClone(forged.transaction);
              const createStep = transaction.steps[0];
              if (createStep !== undefined) {
                (createStep.postRead as { requestId: string | null }).requestId = "req-create";
              }
              return { ...forged, transaction };
            }
            return forged;
          },
          update: async () => { throw new Error("unused"); },
        },
      }));

      await assert.rejects(
        adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) }),
        (error: unknown) => error instanceof ToolError && error.code === "INTERNAL_ERROR",
      );
    });
  }
});

test("the default create domain satisfies the exact remote query proof", async () => {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  const writeBase: Fixture = {
    ...base,
    request: durable.request,
    snapshot: durable.initialSnapshot,
  };
  const operations: string[] = [];
  const remote = new StatefulRemote(writeBase.snapshot);
  const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
    candidateStore: durableCandidateStore(writeBase, operations, durable.resolved),
  }));

  const execution = await adapter.create({
    upsert: false,
    prepare: async () => preparedCreate(writeBase, remote),
  });

  assert.equal(execution.output?.data?.command, "create");
  assert.equal(execution.context?.remoteWrite?.state, "written");
  assert.equal(remote.operations[0], "read:find-open");
  assert.equal(remote.operations.some((operation) => operation === "mutation:create-draft"), true);
  assert.equal(remote.operations.at(-1), "read:mr");
});

test("the default create domain binds unknown recovery to its second findOpen", async () => {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  const writeBase: Fixture = {
    ...base,
    request: durable.request,
    snapshot: durable.initialSnapshot,
  };
  const operations: string[] = [];
  const remote = new StatefulRemote(writeBase.snapshot);
  remote.unknownCreate = true;
  const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
    candidateStore: durableCandidateStore(writeBase, operations, durable.resolved),
  }));

  const execution = await adapter.create({
    upsert: false,
    prepare: async () => preparedCreate(writeBase, remote),
  });

  assert.deepEqual(remote.operations.slice(0, 3), [
    "read:find-open",
    "mutation:create-draft",
    "read:find-open",
  ]);
  assert.equal(execution.output?.data?.recoveredUnknownOutcome, true);
  assert.equal((execution.output?.data?.completedWrites as readonly string[])[0], "create-draft.recovered");
});

test("a default-domain read failure preserves the real partial audit", async () => {
  const base = await fixture();
  const durable = durableVerificationFixture(base);
  const writeBase: Fixture = {
    ...base,
    request: durable.request,
    snapshot: durable.initialSnapshot,
  };
  const operations: string[] = [];
  const remote = new StatefulRemote(writeBase.snapshot);
  remote.failReadAt = 1;
  const adapter = createMergeRequestCommandAdapter(dependencies(writeBase, operations, {
    candidateStore: durableCandidateStore(writeBase, operations, durable.resolved),
  }));

  let caught: unknown;
  try {
    await adapter.create({ upsert: false, prepare: async () => preparedCreate(writeBase, remote) });
  } catch (error) {
    caught = error;
  }

  assert.equal(caught instanceof ToolError && caught.code === "PARTIAL_REMOTE_STATE", true);
  assert.equal(getTransactionAudit(caught)?.steps[0]?.postRead.outcome, "failed");
  assert.deepEqual(remote.operations, ["read:find-open", "mutation:create-draft", "read:mr"]);
});

test("create runs every read precondition before live revalidation, consumption, and the first mutation", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  remote.readRequestIds = [
    "req-read-create",
    "req-pre-description",
    "req-read-description",
    "req-pre-ready",
    "req-read-ready",
  ];
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      create: async (input) => {
        await input.remote.findOpen(createInput());
        await input.remote.createDraft(createInput());
        await input.remote.read(88);
        await input.verificationReceiptWriter.stageAuthenticated({} as never);
        await input.remote.read(88);
        await input.remote.writeDescription(88, "final");
        await input.remote.read(88);
        await input.remote.read(88);
        await input.remote.markReady(88, "[fix][runtime] Test");
        await input.remote.read(88);
        return result("create", remote.current, base);
      },
      update: async () => { throw new Error("unused"); },
    },
  }));

  const execution = await adapter.create({
    upsert: false,
    prepare: async () => {
      operations.push("prepare");
      return preparedCreate(base, remote);
    },
  });

  assert.deepEqual(operations, [
    "prepare",
    "candidate:false",
    "read:find-open",
    "live-identities",
    "candidate:false",
    "candidate:true",
    "mutation:create-draft",
    "read:mr",
    "receipt-stage",
    "read:mr",
    "mutation:write-description",
    "read:mr",
    "read:mr",
    "mutation:mark-ready",
    "read:mr",
  ]);
  assert.equal(execution.context?.remoteWrite?.state, "written");
  assert.equal(execution.output?.data?.command, "create");
  assert.equal(execution.output?.data?.lifecycle, "ready");
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

test("zero, one, and many open MR outcomes preserve app-owned upsert semantics without early consumption", async () => {
  const cases = [
    { count: 0, upsert: false, writes: true },
    { count: 1, upsert: false, writes: false },
    { count: 1, upsert: true, writes: true },
    { count: 2, upsert: false, writes: false },
    { count: 2, upsert: true, writes: false },
  ] as const;
  for (const scenario of cases) {
    const base = await fixture();
    const operations: string[] = [];
    const remote = new RecordingRemote(operations, base.snapshot);
    remote.open = Array.from({ length: scenario.count }, () => remote.current);
    remote.readRequestIds = scenario.count === 0
      ? ["req-read-create", "req-pre-description", "req-read-description", "req-pre-ready", "req-read-ready"]
      : ["req-initial-update", "req-pre-fields", "req-read-fields", "req-pre-ready", "req-read-ready"];
    const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
      domain: {
        create: async (input) => {
          const found = await input.remote.findOpen(createInput());
          if (found.value.length === 0) {
            await input.remote.createDraft(createInput());
            await input.remote.read(88);
            await input.remote.read(88);
            await input.remote.writeDescription(88, "final");
            await input.remote.read(88);
          } else if (found.value.length === 1 && input.upsert === true) {
            await input.remote.read(88);
            await input.remote.read(88);
            await input.remote.writeManagedFields(88, {
              title: "[fix][runtime] Test",
              targetBranch: "develop",
              assigneeUserId: null,
              reviewerUserIds: [],
              squash: true,
              removeSourceBranch: true,
            });
            await input.remote.read(88);
          } else {
            throw new ToolError("INPUT_ERROR", "Open MR selection is ambiguous", {
              field: "mergeRequest.iid",
              expected: "zero MRs or one MR with upsert",
              actual: found.value.length,
              safeNextStep: "Select the exact MR and retry.",
            });
          }
          await input.remote.read(88);
          await input.remote.markReady(88, "[fix][runtime] Test");
          await input.remote.read(88);
          return result(
            found.value.length === 0 ? "create" : "update",
            remote.current,
            base,
            found.value.length === 0 ? base.snapshot : remote.current.snapshot,
          );
        },
        update: async () => { throw new Error("unused"); },
      },
    }));
    const run = adapter.create({
      upsert: scenario.upsert,
      prepare: async () => preparedCreate(base, remote),
    });
    if (scenario.writes) await run;
    else await assert.rejects(run, (error: unknown) => error instanceof ToolError && error.code === "INPUT_ERROR");
    assert.equal(operations.includes("candidate:true"), scenario.writes, JSON.stringify(scenario));
    assert.equal(operations.some((operation) => operation.startsWith("mutation:")), scenario.writes);
  }
});

test("preparation and live identity failures leave candidates reusable and perform zero writes", async () => {
  const base = await fixture();
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
        create: async (input) => {
          await input.remote.createDraft(createInput());
          return result("create", remote.current, base);
        },
        update: async () => { throw new Error("unused"); },
      },
    }));
    await assert.rejects(
      adapter.create({
        upsert: false,
        prepare: async () => {
          operations.push("prepare");
          if (phase === "prepare") throw new Error("precondition failed");
          return preparedCreate(base, remote);
        },
      }),
    );
    assert.equal(operations.includes("candidate:true"), false, phase);
    assert.equal(operations.some((operation) => operation.startsWith("mutation:")), false, phase);
  }
});

test("prepared input drift from the context binding fails before candidate access", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      create: async () => result("create", remote.current, base),
      update: async () => { throw new Error("unused"); },
    },
  }));

  await assert.rejects(
    adapter.create({
      upsert: false,
      prepare: async () => ({
        ...preparedCreate(base, remote),
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
    "req-pre-ready",
    "req-read-ready",
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
        await input.remote.markReady(input.initial.iid, input.initial.title);
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
    "mutation:mark-ready",
    "read:mr",
  ]);
  assert.equal(execution.output?.data?.command, "update");
});

test("write failures retain the original attached transaction audit for output mapping", async () => {
  const base = await fixture();
  const operations: string[] = [];
  const remote = new RecordingRemote(operations, base.snapshot);
  const failure = new ToolError("PARTIAL_REMOTE_STATE", "Remote state is unknown", {
    field: "mergeRequest",
    expected: "a proven Draft",
    actual: "unknown mutation outcome",
    safeNextStep: "Run verify.",
  });
  const journal = new TransactionJournal("create", base.snapshot.sourceHeadSha, "0".repeat(64));
  const step = journal.start("normal", "create-draft", null);
  step.mutation("unknown", "req-create");
  step.readFailed("req-read");
  journal.setFinalState("unknown");
  attachTransactionAudit(failure, journal.snapshot());
  const adapter = createMergeRequestCommandAdapter(dependencies(base, operations, {
    domain: {
      create: async (input) => {
        await input.remote.createDraft(createInput());
        throw failure;
      },
      update: async () => { throw new Error("unused"); },
    },
  }));

  let caught: unknown;
  try {
    await adapter.create({ upsert: false, prepare: async () => preparedCreate(base, remote) });
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
