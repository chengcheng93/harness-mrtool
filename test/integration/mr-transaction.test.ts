import { seedHistoricalMr } from "../helpers/seed-historical-mr.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createMergeRequest,
  type CreateMergeRequestInput,
  type CreateMergeRequestInputs,
  type ManagedFieldsInput,
  type MergeRequestRemote,
  type RemoteMergeRequest,
} from "../../src/app/create-mr.ts";
import {
  assertTransactionStructure,
  buildVerificationReceipt,
  validateVerificationReceipt,
  verifyMergeRequest,
  verifyStoredMergeRequest,
  type VerificationReceiptV1,
} from "../../src/app/verify-mr.ts";
import { updateMergeRequest } from "../../src/app/update-mr.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import {
  getTransactionAudit,
  getTransactionFailureReceipt,
} from "../../src/app/transaction-journal.ts";
import { mutationReceipt, valueReceipt } from "../../src/app/remote-receipt.ts";
import { RemoteMutationError } from "../../src/app/remote-outcome.ts";
import { RemoteReadError } from "../../src/app/remote-outcome.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import type { Candidate, ContextBinding, ResolvedContext } from "../../src/context/types.ts";
import { canonicalizeJson, copyJsonValue, sha256CanonicalJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import {
  parseDiagnosticMarker,
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../src/render/marker.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : null;
}

function errorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

function labelCandidate(
  restId: number,
  globalId: string,
  name: string,
  policyCategory: string,
): Candidate {
  return {
    kind: "label",
    restId,
    globalId,
    name,
    description: `${name} description`,
    color: "#123456",
    scopeKind: "project",
    scopeId: "100",
    scopePath: "luban/luban-studio",
    policyCategory,
  };
}

test("WritePlan derives fixed labels and removes retired or unrelated selections", async () => {
  const fixture = (name: string) => resolve(repositoryRoot, "test/golden/fixtures", name);
  const [rawRequest, rawSnapshot, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  rawRequest.mergeRequest.labelCandidateTokens = [
    "hmrc1_type-token",
    "hmrc1_priority-token",
  ];
  rawRequest.mergeRequest.assigneeCandidateToken = "hmrc1_assignee-token";
  rawRequest.review.reviewerCandidateTokens = ["hmrc1_reviewer-token"];
  const request = normalizeAndValidateRequest(rawRequest);

  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/10", name: "week::2026-w32-0803-0809" },
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/40", name: "status::doing" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
    { id: "gid://gitlab/ProjectLabel/60", name: "manual::keep" },
    { id: "gid://gitlab/ProjectLabel/70", name: "type::feature" },
  ];
  rawSnapshot.mergeRequest.labelIds = [
    "gid://gitlab/ProjectLabel/60",
    "gid://gitlab/ProjectLabel/70",
  ];
  rawSnapshot.mergeRequest.lifecycle = "ready";
  rawSnapshot.mergeRequest.iid = 88;
  const snapshot = validateExternalContextSnapshot(rawSnapshot);
  const candidates: readonly Candidate[] = [
    labelCandidate(20, "gid://gitlab/ProjectLabel/20", "type::bug", "type"),
    labelCandidate(30, "gid://gitlab/ProjectLabel/30", "priority::p2", "priority"),
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
  ];

  const plan = buildWritePlan({ request, snapshot, resolvedCandidates: candidates, bundle, labelDiff: bugLabelDiff(snapshot) });

  // There is no Draft stage: no intent, no Draft plan, no Draft/Ready status pair.
  assert.deepEqual(Object.keys(plan).sort(), [
    "desired", "managedLabelIds", "preservedLabelIds", "provisional", "statusLabelId", "writePlanVersion",
  ]);
  assert.equal(plan.writePlanVersion, 1);
  assert.equal(plan.desired.title, "[fix][luban-studio] Preserve WebEngine-compatible CSS output");
  assert.equal(plan.provisional.title, plan.desired.title);
  assert.deepEqual(plan.provisional.labelIds, []);
  assert.equal(plan.provisional.assigneeUserId, null);
  assert.deepEqual(plan.provisional.reviewerUserIds, []);
  assert.deepEqual(plan.desired.labelIds, [
    "gid://gitlab/ProjectLabel/20", "gid://gitlab/ProjectLabel/30", "gid://gitlab/ProjectLabel/50",
  ]);
  assert.equal(plan.statusLabelId, "gid://gitlab/ProjectLabel/50");
  assert.equal(plan.managedLabelIds.includes("gid://gitlab/ProjectLabel/70"), true);
  assert.equal(plan.managedLabelIds.includes("gid://gitlab/ProjectLabel/60"), true);
  assert.equal(plan.managedLabelIds.includes("gid://gitlab/ProjectLabel/40"), false);
  assert.deepEqual(plan.preservedLabelIds, []);
  assert.equal(plan.desired.assigneeUserId, "user:10");
  assert.deepEqual(plan.desired.reviewerUserIds, ["user:20"]);
});

test("a high-risk request with zero reviewers builds a plan: there is no reviewer minimum", async () => {
  const fixture = await transactionFixture();
  const request = normalizeAndValidateRequest({
    ...structuredClone(fixture.request),
    risk: { ...fixture.request.risk, level: "high" },
    review: { ...fixture.request.review, reviewerCandidateTokens: [] },
  });
  const candidates = fixture.candidates.filter((candidate) => candidate.kind !== "reviewer");

  const plan = buildWritePlan({
    request,
    snapshot: fixture.snapshot,
    labelDiff: bugLabelDiff(fixture.snapshot),
    resolvedCandidates: candidates,
    bundle: fixture.bundle,
  });

  assert.deepEqual(plan.desired.reviewerUserIds, []);
  assert.equal(plan.desired.assigneeUserId, "user:10");
  assert.equal(plan.desired.labelIds.includes(plan.statusLabelId), true);
});

test("the request schema rejects the retired intent field", async () => {
  const fixture = await transactionFixture();
  for (const intent of ["draft", "ready"]) {
    assert.throws(
      () => normalizeAndValidateRequest({ ...structuredClone(fixture.request), intent }),
      { code: "INPUT_ERROR" },
      intent,
    );
  }
});

type WriteKind =
  | "create"
  | "add-labels"
  | "remove-labels"
  | "write-fields"
  | "write-description";

/** GitLab derives Draft status from the title prefix; the fake mirrors that rule. */
function isDraftTitle(title: string): boolean {
  return /^(?:draft:|\[draft\]|\(draft\))/iu.test(title);
}

class FakeMergeRequestRemote implements MergeRequestRemote {
  readonly writes: WriteKind[] = [];
  readonly stagedVerificationReceipts: VerificationReceiptV1[] = [];
  readonly baseSnapshot: ExternalContextSnapshot;
  findOpenCalls = 0;
  current: RemoteMergeRequest | null = null;
  failWrite: WriteKind | null = null;
  createRecovery: "exact" | "none" | "mismatch" | "multiple" = "exact";
  unknownAfterWrite: WriteKind | null = null;
  unclassifiedAfterWrite: WriteKind | null = null;
  driftDescriptionBeforeRead: string | null = null;
  driftDescriptionOnReadNumber: { readonly number: number; readonly description: string } | null = null;
  naturalContextDriftOnReadNumber: number | null = null;
  /** Every live read reports the selected reviewers as no longer qualified. */
  dropReviewerQualification = false;
  renameLabelAfterWrite: { readonly kind: WriteKind; readonly id: string; readonly name: string } | null = null;
  duplicateLabelAfterWrite: { readonly kind: WriteKind; readonly name: string } | null = null;
  private activeDuplicateLabelName: string | null = null;
  private activeLabelRename: { readonly id: string; readonly name: string } | null = null;
  private failReadAfterWriteKind: WriteKind | null = null;
  failReadAfterWriteOccurrence = 1;
  failReads = 0;
  nextReadError: RemoteReadError | null = null;
  private readCount = 0;
  private failReadSeen = 0;

  get failReadAfterWrite(): WriteKind | null {
    return this.failReadAfterWriteKind;
  }

  set failReadAfterWrite(value: WriteKind | null) {
    this.failReadAfterWriteKind = value;
    this.failReadSeen = 0;
  }

  get currentReadCount(): number {
    return this.readCount;
  }

  readonly initialSnapshot: ExternalContextSnapshot;
  constructor(snapshot: ExternalContextSnapshot, readonly gitlabOrigin = "https://gitlab.example.test") {
    this.initialSnapshot = snapshot;
    this.baseSnapshot = snapshot;
  }

  private record(kind: WriteKind): void {
    this.writes.push(kind);
    if (this.failWrite === kind) {
      throw new RemoteMutationError("rejected", "validation", `req-${kind}-rejected`);
    }
  }

  private throwUnknownAfter(kind: WriteKind): void {
    if (this.unclassifiedAfterWrite === kind) {
      this.unclassifiedAfterWrite = null;
      throw new Error("Unclassified adapter failure");
    }
    if (this.unknownAfterWrite === kind) {
      this.unknownAfterWrite = null;
      throw new RemoteMutationError("unknown", "timeout", `req-${kind}-unknown`);
    }
  }

  private requireCurrent(): RemoteMergeRequest {
    if (this.current === null) throw new Error("MR has not been created");
    return this.current;
  }

  private snapshotFor(current: RemoteMergeRequest): ExternalContextSnapshot {
    const snapshot = structuredClone(this.baseSnapshot);
    if (this.dropReviewerQualification) {
      const review = snapshot.review as { qualifiedReviewerUserIds: string[] | null };
      review.qualifiedReviewerUserIds = [];
    }
    if (this.activeLabelRename !== null) {
      const mutable = snapshot as unknown as { labelCandidates: Array<{ id: string; name: string }> };
      mutable.labelCandidates = snapshot.labelCandidates.map((label) =>
        label.id === this.activeLabelRename?.id
          ? { ...label, name: this.activeLabelRename.name }
          : label);
    }
    if (this.activeDuplicateLabelName !== null) {
      const mutable = snapshot as unknown as { labelCandidates: Array<{ id: string; name: string }> };
      mutable.labelCandidates.push({ id: "gid://gitlab/ProjectLabel/999", name: this.activeDuplicateLabelName });
    }
    return validateExternalContextSnapshot({
      ...snapshot,
      metadataRead: { status: "available", evidence: "GitLab MR metadata read completed." },
      mergeRequest: {
        ...structuredClone(this.baseSnapshot.mergeRequest),
        iid: current.iid,
        lifecycle: current.draft ? "draft" : "ready",
        labelIds: current.labelIds,
        assigneeUserId: current.assigneeUserId,
        reviewerUserIds: current.reviewerUserIds,
      },
    });
  }

  private replace(values: Partial<RemoteMergeRequest>): void {
    const current = this.requireCurrent();
    const next = { ...current, ...values };
    this.current = Object.freeze({ ...next, snapshot: this.snapshotFor(next) });
  }

  private preparePostWriteSnapshot(kind: WriteKind): void {
    if (this.duplicateLabelAfterWrite?.kind === kind) {
      this.activeDuplicateLabelName = this.duplicateLabelAfterWrite.name;
      this.duplicateLabelAfterWrite = null;
    }
    if (this.renameLabelAfterWrite?.kind === kind) {
      this.activeLabelRename = this.renameLabelAfterWrite;
      this.renameLabelAfterWrite = null;
    }
  }

  private failNextReadAfter(kind: WriteKind): void {
    if (this.failReadAfterWrite === kind) this.failReadSeen += 1;
    if (this.failReadAfterWrite === kind && this.failReadSeen === this.failReadAfterWriteOccurrence) {
      this.failReadAfterWrite = null;
      this.failReads += 1;
    }
  }

  seed(current: RemoteMergeRequest): void {
    this.current = Object.freeze({ ...current, snapshot: this.snapshotFor(current) });
  }

  /** Simulates a merge request that the retired Draft stage left as a GitLab Draft. */
  markLegacyDraft(): void {
    const current = this.requireCurrent();
    this.replace({ draft: true, title: `Draft: ${current.title}` });
  }

  async create(_input: CreateMergeRequestInput): Promise<never> {
    this.record("create");
    throw new Error("Retired MR-only create must not reach the remote");
  }

  async findOpen(input: CreateMergeRequestInput) {
    this.findOpenCalls += 1;
    const current = this.current;
    if (current === null || current.state !== "opened" ||
        current.sourceProjectId !== input.sourceProjectId ||
        current.sourceBranch !== input.sourceBranch ||
        current.targetProjectId !== input.targetProjectId ||
        current.targetBranch !== input.targetBranch) {
      return valueReceipt([] as readonly RemoteMergeRequest[], "req-find");
    }
    if (this.createRecovery === "none") return valueReceipt([] as readonly RemoteMergeRequest[], "req-find");
    const result = this.createRecovery === "mismatch"
      ? Object.freeze({ ...current, description: "A different provisional description" })
      : current;
    return valueReceipt(this.createRecovery === "multiple" ? [result, result] : [result], "req-find");
  }

  async addLabels(_iid: number, labelIds: readonly string[]) {
    this.record("add-labels");
    this.preparePostWriteSnapshot("add-labels");
    this.replace({ labelIds: [...new Set([...this.requireCurrent().labelIds, ...labelIds])].sort() });
    this.failNextReadAfter("add-labels");
    this.throwUnknownAfter("add-labels");
    return mutationReceipt("req-label-add");
  }

  async removeLabels(_iid: number, labelIds: readonly string[]) {
    this.record("remove-labels");
    this.preparePostWriteSnapshot("remove-labels");
    const removing = new Set(labelIds);
    this.replace({ labelIds: this.requireCurrent().labelIds.filter((id) => !removing.has(id)) });
    this.failNextReadAfter("remove-labels");
    this.throwUnknownAfter("remove-labels");
    return mutationReceipt("req-label-remove");
  }

  async writeManagedFields(_iid: number, input: ManagedFieldsInput) {
    this.record("write-fields");
    this.preparePostWriteSnapshot("write-fields");
    this.replace({
      title: input.title,
      // Rewriting the title is what moves a legacy Draft out of GitLab's Draft state.
      draft: isDraftTitle(input.title),
      targetBranch: input.targetBranch,
      assigneeUserId: input.assigneeUserId,
      reviewerUserIds: [...input.reviewerUserIds],
      squash: input.squash,
      removeSourceBranch: input.removeSourceBranch,
    });
    this.failNextReadAfter("write-fields");
    this.throwUnknownAfter("write-fields");
    return mutationReceipt("req-fields");
  }

  async writeDescription(_iid: number, description: string) {
    this.record("write-description");
    this.preparePostWriteSnapshot("write-description");
    this.replace({ description });
    this.failNextReadAfter("write-description");
    this.throwUnknownAfter("write-description");
    return mutationReceipt("req-description");
  }

  async read(iid: number) {
    this.readCount += 1;
    if (this.nextReadError !== null) {
      const error = this.nextReadError;
      this.nextReadError = null;
      throw error;
    }
    if (this.failReads > 0) {
      this.failReads -= 1;
      throw new Error("Injected readback failure");
    }
    const current = this.requireCurrent();
    assert.equal(iid, current.iid);
    if (this.driftDescriptionOnReadNumber?.number === this.readCount) {
      const description = this.driftDescriptionOnReadNumber.description;
      this.driftDescriptionOnReadNumber = null;
      this.replace({ description });
      return valueReceipt(this.requireCurrent(), "req-read");
    }
    if (this.driftDescriptionBeforeRead !== null) {
      const description = this.driftDescriptionBeforeRead;
      this.driftDescriptionBeforeRead = null;
      this.replace({ description });
      return valueReceipt(this.requireCurrent(), "req-read");
    }
    if (this.naturalContextDriftOnReadNumber === this.readCount) {
      this.naturalContextDriftOnReadNumber = null;
      const snapshot = structuredClone(current.snapshot);
      const changedSnapshot = validateExternalContextSnapshot({
        ...snapshot,
        issue: snapshot.issue.kind === "linked" && snapshot.issue.readStatus === "available"
          ? { ...snapshot.issue, milestone: "Later milestone", dueDate: "2026-09-01" }
          : snapshot.issue,
        ci: { status: "running" },
        review: {
          ...snapshot.review,
          approvedByUserIds: [],
          unresolvedDiscussions: 3,
        },
      });
      this.current = Object.freeze({ ...current, snapshot: changedSnapshot });
      return valueReceipt(this.current, "req-read");
    }
    return valueReceipt(current, "req-read");
  }
}

function transactionRuntime(remote: FakeMergeRequestRemote) {
  return {
    labelDiff: bugLabelDiff(remote.initialSnapshot),
    remote,
    gitlabOrigin: remote.gitlabOrigin,
    verificationReceiptWriter: {
      stageAuthenticated: async (receipt: VerificationReceiptV1) => {
        remote.stagedVerificationReceipts.push(structuredClone(receipt));
      },
    },
  };
}

// Historical MRs are seeded locally; only the supported update transaction is exercised.
function seedTransaction(inputs: CreateMergeRequestInputs) {
  const seeded = seedHistoricalMr(inputs);
  const remote = inputs.remote as FakeMergeRequestRemote;
  remote.seed(seeded.current);
  return { ...seeded, final: remote.current! };
}

async function updateHistoricalMergeRequest(inputs: CreateMergeRequestInputs) {
  const remote = inputs.remote as FakeMergeRequestRemote;
  if (remote.current === null) {
    const seeded = seedTransaction(inputs);
    remote.seed({ ...seeded.current, labelIds: [], assigneeUserId: null, reviewerUserIds: [] });
  }
  return updateMergeRequest({ ...inputs, initial: remote.current! });
}

test("create queries open merge requests before refusing legacy fresh creation", async () => {
  const fixture = await transactionFixture();
  await assert.rejects(createMergeRequest({ request: fixture.request, initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates, bundle: fixture.bundle, releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev", sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
  }), { code: "INPUT_ERROR" });
  assert.equal(fixture.remote.findOpenCalls, 1);
  assert.deepEqual(fixture.remote.writes, []);
});

test("create refuses one or multiple existing open merge requests before writing", async () => {
  for (const count of [1, 2]) {
    const fixture = await transactionFixture();
    seedTransaction({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
    fixture.remote.writes.length = 0;
    fixture.remote.createRecovery = count === 1 ? "exact" : "multiple";

    await assert.rejects(
      createMergeRequest({
        request: fixture.request,
        initialSnapshot: fixture.snapshot,
        resolvedCandidates: fixture.candidates,
        bundle: fixture.bundle,
        releaseTag: "templates-v1.0.0",
        cliVersion: "0.1.0-dev",
        sourceBranch: "fix/webengine-css",
        ...transactionRuntime(fixture.remote),
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "INPUT_ERROR",
    );
    assert.deepEqual(fixture.remote.writes, []);
  }
});

test("create upserts the one existing open managed merge request only when explicitly requested", async () => {
  const fixture = await transactionFixture();
  const created = seedTransaction({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;

  const upserted = await createMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
    upsert: true,
  });

  assert.equal(upserted.iid, created.iid);
  assert.equal(upserted.transaction.operation, "update");
  assert.equal(fixture.remote.writes.includes("create"), false);
  // An already converged merge request is only rewritten through fields-write and description-write.
  assert.deepEqual(fixture.remote.writes, ["write-fields", "write-description"]);
});

async function pristineResumeFixture() {
  const fixture = await transactionFixture();
  const releaseTag = `templates-v${fixture.bundle.manifest.version}`;
  const binding: ContextBinding = {
    operation: "create", gitlabOrigin: fixture.remote.gitlabOrigin,
    sourceProject: { id: fixture.snapshot.sourceProject.id, fullPath: fixture.snapshot.sourceProject.path },
    targetProject: { id: fixture.snapshot.targetProject.id, fullPath: fixture.snapshot.targetProject.path },
    sourceBranch: "fix/webengine-css", targetBranch: fixture.request.targetBranch,
    sourceHeadSha: fixture.snapshot.sourceHeadSha, targetRefSha: fixture.snapshot.targetRefSha,
    mrIid: null, releaseSetId: "embedded:test", cliVersion: "0.1.0-dev",
    bundle: { id: fixture.bundle.manifest.bundleId, version: fixture.bundle.manifest.version,
      releaseTag, manifestHash: sha256Utf8(`${canonicalizeJson(fixture.bundle.manifest)}\n`) },
    protocols: { inputSchema: fixture.bundle.manifest.inputSchema,
      policySchema: fixture.bundle.manifest.policySchema, skillProtocol: null },
  };
  const originalContext: ResolvedContext = {
    contextId: fixture.request.contextId, createdAtMs: 1, expiresAtMs: 2,
    binding, externalSnapshotDigest: sha256CanonicalJson(fixture.snapshot),
    snapshot: copyJsonValue(fixture.snapshot), candidates: fixture.candidates,
  };
  const original = {
    request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle, releaseTag, cliVersion: binding.cliVersion, sourceBranch: binding.sourceBranch,
    ...transactionRuntime(fixture.remote),
  };
  fixture.remote.seed(seedHistoricalMr({ ...original, provisional: true }).current);
  const request = normalizeAndValidateRequest({ ...fixture.request, contextId: "renewed-create-context",
    mergeRequest: { ...fixture.request.mergeRequest, labelCandidateTokens: ["fresh-type", "fresh-priority"],
      assigneeCandidateToken: "fresh-assignee" },
    review: { ...fixture.request.review, reviewerCandidateTokens: ["fresh-reviewer"] },
  });
  return { fixture, original, inputs: { ...original, request,
    resume: { iid: 88, originalRequest: fixture.request, originalContext, binding } } };
}

test("explicit create resume completes only the selected pristine provisional merge request using fresh context", async () => {
  const { fixture, inputs } = await pristineResumeFixture();
  const result = await createMergeRequest(inputs);
  assert.equal(result.iid, 88);
  assert.equal(result.transaction.operation, "update");
  assert.equal(result.transaction.finalState, "complete");
  assert.equal(result.final.draft, false);
  assert.deepEqual(fixture.remote.writes, ["add-labels", "write-fields", "write-description"]);
  assert.equal(parseDiagnosticMarker(result.final.description).renderPhase, "final");
  assert.equal(fixture.remote.stagedVerificationReceipts.length, 1);
});

for (const metadataWritten of [false, true]) {
  test(`explicit resume completes a full-label prefix with metadata ${metadataWritten ? "written" : "pending"}`, async () => {
    const { fixture, inputs } = await pristineResumeFixture();
    const plan = buildWritePlan({ request: inputs.request, snapshot: inputs.initialSnapshot,
      resolvedCandidates: inputs.resolvedCandidates, bundle: inputs.bundle, labelDiff: inputs.labelDiff });
    await fixture.remote.addLabels(88, plan.desired.labelIds);
    if (metadataWritten) await fixture.remote.writeManagedFields(88, {
      title: plan.desired.title, targetBranch: inputs.request.targetBranch,
      assigneeUserId: plan.desired.assigneeUserId, reviewerUserIds: plan.desired.reviewerUserIds,
      squash: plan.desired.squash, removeSourceBranch: plan.desired.removeSourceBranch,
    });
    fixture.remote.writes.length = 0;
    const result = await createMergeRequest(inputs);
    assert.equal(result.iid, 88);
    assert.equal(result.transaction.operation, "update");
    assert.equal(result.final.draft, false);
    assert.equal(fixture.remote.writes[0], metadataWritten ? "write-description" : "write-fields");
    assert.equal(fixture.remote.writes.includes("create"), false);
    assert.equal(fixture.remote.writes.includes("write-fields"), !metadataWritten);
    assert.equal(result.transaction.steps.some((step) => step.operation === "labels-add"), false);
    assert.equal(result.transaction.steps.some((step) => step.operation === "fields-write"), !metadataWritten);
    assert.equal(parseDiagnosticMarker(result.final.description).renderPhase, "final");
    assert.deepEqual(result.final.labelIds, plan.desired.labelIds);
  });
}

test("explicit resume rejects partial labels and mixed metadata before further mutations", async () => {
  for (const mixedMetadata of [false, true]) {
    const { fixture, inputs } = await pristineResumeFixture();
    const plan = buildWritePlan({ request: inputs.request, snapshot: inputs.initialSnapshot,
      resolvedCandidates: inputs.resolvedCandidates, bundle: inputs.bundle, labelDiff: inputs.labelDiff });
    await fixture.remote.addLabels(88, mixedMetadata ? plan.desired.labelIds : plan.desired.labelIds.slice(0, 2));
    if (mixedMetadata) await fixture.remote.writeManagedFields(88, {
      title: plan.desired.title, targetBranch: inputs.request.targetBranch,
      assigneeUserId: plan.desired.assigneeUserId, reviewerUserIds: [],
      squash: plan.desired.squash, removeSourceBranch: plan.desired.removeSourceBranch,
    });
    fixture.remote.writes.length = 0;
    await assert.rejects(createMergeRequest(inputs),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "INPUT_ERROR");
    assert.deepEqual(fixture.remote.writes, []);
  }
});

test("explicit create resume rejects absent, ambiguous, wrong-IID, or edited merge requests without creating", async () => {
  for (const scenario of ["absent", "ambiguous", "wrong-iid", "edited"] as const) {
    const { fixture, inputs } = await pristineResumeFixture();
    if (scenario === "absent") fixture.remote.createRecovery = "none";
    if (scenario === "ambiguous") fixture.remote.createRecovery = "multiple";
    if (scenario === "edited") fixture.remote.createRecovery = "mismatch";
    const resume = scenario === "wrong-iid" ? { ...inputs.resume, iid: 89 } : inputs.resume;
    await assert.rejects(createMergeRequest({ ...inputs, resume }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "INPUT_ERROR", scenario);
    assert.deepEqual(fixture.remote.writes, [], scenario);
  }
});

test("explicit create resume refuses a merge request that became a Draft", async () => {
  const { fixture, inputs } = await pristineResumeFixture();
  fixture.remote.markLegacyDraft();
  await assert.rejects(createMergeRequest(inputs),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "INPUT_ERROR");
  assert.deepEqual(fixture.remote.writes, []);
});

test("resume keeps the independent update read and ordinary upsert ownership checks", async () => {
  const { fixture, inputs, original } = await pristineResumeFixture();
  await assert.rejects(createMergeRequest({ ...original, upsert: true }));
  assert.deepEqual(fixture.remote.writes, []);
  fixture.remote.driftDescriptionBeforeRead = `${fixture.remote.current!.description}human edit`;
  await assert.rejects(createMergeRequest(inputs),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "CONCURRENT_UPDATE");
  assert.deepEqual(fixture.remote.writes, []);
});

async function transactionFixture(gitlabOrigin = "https://gitlab.example.test"): Promise<{
  readonly request: ReturnType<typeof normalizeAndValidateRequest>;
  readonly snapshot: ExternalContextSnapshot;
  readonly candidates: readonly Candidate[];
  readonly bundle: Awaited<ReturnType<typeof loadTemplateBundle>>;
  readonly remote: FakeMergeRequestRemote;
}> {
  const fixture = (name: string) => resolve(repositoryRoot, "test/golden/fixtures", name);
  const [rawRequest, rawSnapshot, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  rawRequest.mergeRequest.labelCandidateTokens = ["type-token", "priority-token"];
  rawRequest.mergeRequest.assigneeCandidateToken = "assignee-token";
  rawRequest.review.reviewerCandidateTokens = ["reviewer-token"];
  // status::doing is a leftover of the retired Draft stage: legacy projects may
  // still define it, but it is never planned.
  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/10", name: "week::2026-w32-0803-0809" },
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
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
  const candidates: readonly Candidate[] = [
    labelCandidate(20, "gid://gitlab/ProjectLabel/20", "type::bug", "type"),
    labelCandidate(30, "gid://gitlab/ProjectLabel/30", "priority::p2", "priority"),
    {
      kind: "assignee", userId: "user:10", globalId: "gid://gitlab/User/10",
      username: "alice", displayName: "Alice Zhang",
    },
    {
      kind: "reviewer", userId: "user:20", globalId: "gid://gitlab/User/20",
      username: "bob", displayName: "Bob Chen",
    },
  ];
  return {
    request: normalizeAndValidateRequest(rawRequest),
    snapshot,
    candidates,
    bundle,
    remote: new FakeMergeRequestRemote(snapshot, gitlabOrigin),
  };
}

test("the final description write is the last normal write and the final marker is read back", async () => {
  const fixture = await transactionFixture();
  const result = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.deepEqual(fixture.remote.writes, ["add-labels", "write-fields", "write-description"]);
  assert.deepEqual(result.completedWrites, ["labels-add", "fields-write", "description-write"]);
  assert.equal(fixture.remote.current?.draft, false);
  assert.equal(fixture.remote.current?.title, result.writePlan.desired.title);
  assert.deepEqual(fixture.remote.current?.labelIds, [...result.writePlan.desired.labelIds].sort());
  assert.equal(fixture.remote.current?.snapshot.mergeRequest.lifecycle, "ready");
  assert.equal(parseDiagnosticMarker(fixture.remote.current?.description ?? "").renderPhase, "final");
  assert.equal(result.recoveredUnknownOutcome, false);
});

test("a request with zero reviewers updates a historical merge request", async () => {
  const fixture = await transactionFixture();
  const request = normalizeAndValidateRequest({
    ...structuredClone(fixture.request),
    risk: { ...fixture.request.risk, level: "high" },
    review: { ...fixture.request.review, reviewerCandidateTokens: [] },
  });
  const candidates = fixture.candidates.filter((candidate) => candidate.kind !== "reviewer");

  const result = await updateHistoricalMergeRequest({
    request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(result.transaction.finalState, "complete");
  assert.equal(result.final.draft, false);
  assert.deepEqual(result.final.reviewerUserIds, []);
  assert.equal(result.final.assigneeUserId, "user:10");
  assert.deepEqual(fixture.remote.writes, ["add-labels", "write-fields", "write-description"]);
  assert.equal(verifyMergeRequest({
    level: "ready",
    current: result.final,
    bundle: fixture.bundle,
    expected: result.verification,
  }).valid, true);
});

test("a selected reviewer losing qualification no longer stops the transaction", async () => {
  const fixture = await transactionFixture();
  fixture.remote.dropReviewerQualification = true;

  const result = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(result.transaction.finalState, "complete");
  assert.deepEqual(result.final.reviewerUserIds, ["user:20"]);
  assert.deepEqual(result.final.snapshot.review.qualifiedReviewerUserIds, []);
  assert.equal(verifyMergeRequest({
    level: "ready",
    current: result.final,
    bundle: fixture.bundle,
    expected: result.verification,
  }).valid, true);
});

test("unknown label, field, and description writes continue only after exact readback", async () => {
  for (const kind of ["add-labels", "write-fields", "write-description"] as const) {
    const fixture = await transactionFixture();
    fixture.remote.unknownAfterWrite = kind;
    const result = await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
    assert.equal(result.recoveredUnknownOutcome, true, kind);
    assert.equal(result.final.draft, false, kind);
    assert.equal(result.transaction.finalState, "complete", kind);
  }
});

test("an unclassified adapter failure is treated as unknown until exact readback", async () => {
  const fixture = await transactionFixture();
  fixture.remote.unclassifiedAfterWrite = "write-fields";

  const result = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(result.recoveredUnknownOutcome, true);
  const step = result.transaction.steps.find((entry) => entry.operation === "fields-write");
  assert.equal(step?.mutation?.outcome, "unknown");
  assert.equal(step?.postRead.outcome, "succeeded");
  assert.equal(step?.postcondition, "matched");
});

test("a request whose rendered title exceeds GitLab's limit writes nothing", async () => {
  const fixture = await transactionFixture();
  const raw = structuredClone(fixture.request);
  const mutableTitle = raw.title as { module: string; titleSummary: string };
  mutableTitle.module = "m".repeat(32);
  mutableTitle.titleSummary = "S".repeat(72);
  const request = normalizeAndValidateRequest(raw);

  await assert.rejects(
    updateHistoricalMergeRequest({
      request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "RENDER_ERROR",
  );
  assert.deepEqual(fixture.remote.writes, []);
});

for (const ciStatus of ["pending", "unavailable"] as const) {
  test("structure and ready verification allow " + ciStatus + " CI while merge verification does not", async () => {
    const fixture = await transactionFixture();
    const created = await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });

    const current = { ...created.final, snapshot: validateExternalContextSnapshot({
      ...created.final.snapshot, ci: { status: ciStatus },
    }) };
    assert.equal(verifyMergeRequest({
      level: "structure",
      current,
      bundle: fixture.bundle,
      expected: created.verification,
    }).valid, true);
    assert.equal(verifyMergeRequest({
      level: "ready",
      current,
      bundle: fixture.bundle,
      expected: created.verification,
    }).live.lifecycle, "ready");
    assert.throws(
      () => verifyMergeRequest({
        level: "merge",
        current,
        bundle: fixture.bundle,
        expected: created.verification,
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "POSTCONDITION_ERROR",
    );
  });
}

test("stored verification rejects an invalid level before loading durable state", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  let receiptLoads = 0;

  await assert.rejects(
    verifyStoredMergeRequest({
      level: "bypass" as never,
      current: created.final,
      gitlabOrigin: "https://gitlab.example.test",
      receiptLoader: {
        loadVerified: async () => {
          receiptLoads += 1;
          return { trusted: true as const, receipt: null };
        },
      },
      bundleLoader: {
        loadVerifiedExact: async () => ({ trusted: true as const, bundle: fixture.bundle }),
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
  assert.equal(receiptLoads, 0);
});

test("the durable verification receipt is staged before the final description write", async () => {
  const fixture = await transactionFixture();
  const staged: VerificationReceiptV1[] = [];

  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
    gitlabOrigin: "https://gitlab.example.test",
    verificationReceiptWriter: {
      stageAuthenticated: async (receipt: VerificationReceiptV1) => {
        assert.equal(fixture.remote.writes.includes("write-description"), false);
        staged.push(structuredClone(receipt));
      },
    },
  });

  assert.equal(staged.length, 1);
  assert.equal(staged[0]?.expected.description, created.final.description);
  assert.equal(staged[0]?.lifecycle, "ready");
});

test("a durable receipt staging failure prevents the final description write", async () => {
  const fixture = await transactionFixture();
  let caught: unknown;
  try {
    await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
      gitlabOrigin: "https://gitlab.example.test",
      verificationReceiptWriter: {
        stageAuthenticated: async () => {
          throw new Error("Injected authenticated receipt persistence failure");
        },
      },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(
    typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
    "PARTIAL_WRITE",
  );
  assert.equal(getTransactionAudit(caught)?.finalState, "partial");
  assert.equal(getTransactionFailureReceipt(caught)?.failedOperation, "verification-receipt-stage");
  assert.equal(getTransactionFailureReceipt(caught)?.failedField, "verificationReceipt");
  assert.deepEqual(getTransactionFailureReceipt(caught)?.completedSteps, ["labels-add", "fields-write"]);
  assert.equal(fixture.remote.writes.includes("write-description"), false);
});

test("standalone verification reloads a trusted durable receipt and exact historical Bundle", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const receipt = buildVerificationReceipt({
    gitlabOrigin: "https://gitlab.example.test",
    current: created.final,
    expected: created.verification,
    bundle: fixture.bundle,
  });
  assert.equal(JSON.stringify(receipt).includes(fixture.request.contextId), false);
  assert.equal(JSON.stringify(receipt).includes("week-token"), false);
  let loadedBundleRef: unknown;

  const verified = await verifyStoredMergeRequest({
    level: "structure",
    current: structuredClone(created.final),
    gitlabOrigin: "https://gitlab.example.test",
    receiptLoader: {
      loadVerified: async () => ({ trusted: true as const, receipt: structuredClone(receipt) }),
    },
    bundleLoader: {
      loadVerifiedExact: async (reference) => {
        loadedBundleRef = reference;
        return { trusted: true as const, bundle: fixture.bundle };
      },
    },
  });

  assert.equal(verified.valid, true);
  assert.deepEqual(loadedBundleRef, receipt.bundle);
});

test("HTTP transactions stage a receipt and standalone verification preserves its exact origin identity", async () => {
  const fixture = await transactionFixture("http://gitlab.example.test:8080");
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  assert.equal(fixture.remote.stagedVerificationReceipts.length, 1);
  const receipt = fixture.remote.stagedVerificationReceipts[0];
  assert.ok(receipt);
  assert.equal(receipt.gitlabOrigin, "http://gitlab.example.test:8080");
  assert.equal(receipt.webUrl, "http://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88");
  const verificationError = (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && error.code === "POSTCONDITION_ERROR";
  const verificationInputs = {
    level: "structure" as const,
    current: created.final,
    gitlabOrigin: "http://gitlab.example.test:8080",
    receiptLoader: {
      loadVerified: async () => ({ trusted: true as const, receipt: structuredClone(receipt) }),
    },
    bundleLoader: {
      loadVerifiedExact: async () => ({ trusted: true as const, bundle: fixture.bundle }),
    },
  };

  const verified = await verifyStoredMergeRequest(verificationInputs);

  assert.equal(verified.valid, true);
  assert.equal(verified.webUrl, "http://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88");
  for (const gitlabOrigin of ["https://gitlab.example.test:8080", "http://gitlab.example.test:8081"]) {
    await assert.rejects(
      verifyStoredMergeRequest({ ...verificationInputs, gitlabOrigin }),
      verificationError,
      gitlabOrigin,
    );
  }
  for (const gitlabOrigin of [
    "ftp://gitlab.example.test:8080",
    "http://user:password@gitlab.example.test:8080",
    "http://gitlab.example.test:8080/group/project",
    "http://gitlab.example.test:8080?query=value",
    "http://gitlab.example.test:8080#fragment",
    "http://gitlab.example.test:8080/",
  ]) {
    assert.throws(() => validateVerificationReceipt({ ...receipt, gitlabOrigin }), verificationError, gitlabOrigin);
  }
  for (const webUrl of [
    "ftp://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88",
    "https://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88",
    "http://gitlab.example.test:8081/luban/luban-studio/-/merge_requests/88",
    "http://other-gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88",
    "http://user:password@gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88",
    "http://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88?query=value",
    "http://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88#fragment",
    "http://gitlab.example.test:8080/",
  ]) {
    assert.throws(() => validateVerificationReceipt({ ...receipt, webUrl }), verificationError, webUrl);
  }
});

test("HTTP transaction failures retain their MR URL and recovery receipt", async () => {
  const fixture = await transactionFixture("http://gitlab.example.test:8080");
  fixture.remote.failReadAfterWrite = "write-fields";
  let caught: unknown;
  try {
    await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null, "PARTIAL_REMOTE_STATE");
  const receipt = getTransactionFailureReceipt(caught);
  assert.equal(receipt?.webUrl, "http://gitlab.example.test:8080/luban/luban-studio/-/merge_requests/88");
  assert.equal(receipt?.failedOperation, "fields-write");
  assert.equal(receipt?.retryCommand, "harness-mrtool update 88 --input - --non-interactive --output json");
  assert.equal(getTransactionAudit(caught)?.finalState, "unknown");
});

test("standalone verification fails closed for a missing or untrusted durable receipt", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  for (const loadVerified of [
    async () => null,
    async () => ({ trusted: false as const, receipt: null }),
  ]) {
    await assert.rejects(
      verifyStoredMergeRequest({
        level: "structure",
        current: created.final,
        gitlabOrigin: "https://gitlab.example.test",
        receiptLoader: { loadVerified },
        bundleLoader: {
          loadVerifiedExact: async () => {
            throw new Error("Bundle loading must not precede receipt trust");
          },
        },
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "POSTCONDITION_ERROR",
    );
  }
});

test("a durable receipt must bind every managed user identity", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const receipt = buildVerificationReceipt({
    gitlabOrigin: "https://gitlab.example.test",
    current: created.final,
    expected: created.verification,
    bundle: fixture.bundle,
  });
  const missingAuthorBinding = {
    ...structuredClone(receipt),
    userBindings: receipt.userBindings.filter(({ id }) => id !== receipt.authorUserId),
  };

  await assert.rejects(
    verifyStoredMergeRequest({
      level: "structure",
      current: created.final,
      gitlabOrigin: "https://gitlab.example.test",
      receiptLoader: {
        loadVerified: async () => ({ trusted: true as const, receipt: missingAuthorBinding }),
      },
      bundleLoader: {
        loadVerifiedExact: async () => ({ trusted: true as const, bundle: fixture.bundle }),
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
});

test("verification receipt validation rejects bearer-shaped persisted content", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const receipt = buildVerificationReceipt({
    gitlabOrigin: "https://gitlab.example.test",
    current: created.final,
    expected: created.verification,
    bundle: fixture.bundle,
  });

  assert.throws(
    () => validateVerificationReceipt({
      ...structuredClone(receipt),
      expected: { ...structuredClone(receipt.expected), title: "glpat-secretBearerValue" },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
});

test("merge verification never counts the MR author's approval", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const raw = structuredClone(created.final.snapshot);
  const mutableCi = raw.ci as { status: ExternalContextSnapshot["ci"]["status"] };
  const mutableReview = raw.review as {
    unresolvedDiscussions: number | null;
    qualifiedReviewerUserIds: string[] | null;
    approvedByUserIds: string[];
  };
  mutableCi.status = "passed";
  mutableReview.unresolvedDiscussions = 0;
  mutableReview.qualifiedReviewerUserIds = [raw.mergeRequest.authorUserId, "user:20"].sort();
  mutableReview.approvedByUserIds = [raw.mergeRequest.authorUserId];
  const current = {
    ...created.final,
    snapshot: validateExternalContextSnapshot(raw),
  };

  assert.throws(
    () => verifyMergeRequest({
      level: "merge",
      current,
      bundle: fixture.bundle,
      expected: created.verification,
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
});

test("merge verification requires the Policy merge lifecycle label", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const raw = structuredClone(created.final.snapshot);
  const mutableCi = raw.ci as { status: ExternalContextSnapshot["ci"]["status"] };
  const mutableReview = raw.review as {
    unresolvedDiscussions: number | null;
    qualifiedReviewerUserIds: string[] | null;
    approvedByUserIds: string[];
  };
  mutableCi.status = "passed";
  mutableReview.unresolvedDiscussions = 0;
  mutableReview.qualifiedReviewerUserIds = ["user:20"];
  mutableReview.approvedByUserIds = ["user:20"];
  const withoutStatus = {
    ...created.final,
    labelIds: created.final.labelIds.filter((id) => id !== "gid://gitlab/ProjectLabel/50"),
  };
  const current = {
    ...withoutStatus,
    snapshot: validateExternalContextSnapshot({
      ...raw,
      mergeRequest: { ...raw.mergeRequest, labelIds: withoutStatus.labelIds },
    }),
  };

  assert.throws(
    () => verifyMergeRequest({
      level: "merge",
      current,
      bundle: fixture.bundle,
      expected: created.verification,
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
});

test("structure verification detects body drift without writing the MR", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const writeCount = fixture.remote.writes.length;
  const current = fixture.remote.current as RemoteMergeRequest;
  const tampered = { ...current, description: current.description.replace("## 1. Changes", "## 1. Changed") };

  assert.throws(
    () => verifyMergeRequest({
      level: "structure",
      current: tampered,
      bundle: fixture.bundle,
      expected: created.verification,
    }),
  );
  assert.equal(fixture.remote.writes.length, writeCount);
});

test("structure verification rejects a merge request that became a Draft", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.markLegacyDraft();
  const current = fixture.remote.current as RemoteMergeRequest;
  assert.equal(current.draft, true);

  for (const level of ["structure", "ready", "merge"] as const) {
    assert.throws(
      () => verifyMergeRequest({ level, current, bundle: fixture.bundle, expected: created.verification }),
      { code: "POSTCONDITION_ERROR" },
      level,
    );
  }
});

test("verification classifies unmanaged and manually edited descriptions without writes", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const writeCount = fixture.remote.writes.length;
  for (const [description, code] of [
    ["Human-authored description", "UNMANAGED_MR"],
    [created.final.description.replace("Preserve WebEngine-compatible", "Manually changed"),
      "MANUAL_DESCRIPTION_CHANGE"],
  ] as const) {
    assert.throws(
      () => verifyMergeRequest({
        level: "structure",
        current: { ...created.final, description },
        bundle: fixture.bundle,
        expected: created.verification,
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === code,
    );
  }
  assert.equal(fixture.remote.writes.length, writeCount);
});

test("update refuses an unmanaged or manually edited description without remote writes", async () => {
  const fixture = await transactionFixture();
  await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const managed = fixture.remote.current as RemoteMergeRequest;

  for (const [description, code] of [
    ["Human-authored description", "UNMANAGED_MR"],
    [managed.description.replace("Preserve WebEngine-compatible", "Manually changed"), "MANUAL_DESCRIPTION_CHANGE"],
  ] as const) {
    fixture.remote.current = Object.freeze({ ...managed, description });
    fixture.remote.writes.length = 0;
    await assert.rejects(
      updateMergeRequest({
        request: fixture.request,
        initial: fixture.remote.current,
        resolvedCandidates: fixture.candidates,
        bundle: fixture.bundle,
        releaseTag: "templates-v1.0.0",
        cliVersion: "0.1.0-dev",
        sourceBranch: "fix/webengine-css",
        ...transactionRuntime(fixture.remote),
      }),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === code,
    );
    assert.deepEqual(fixture.remote.writes, []);
  }
});

test("update maps its initial read failure without claiming a remote write", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.nextReadError = new RemoteReadError("auth", "read-auth-request");
  let caught: unknown;
  try {
    await updateMergeRequest({
      request: fixture.request,
      initial: created.final,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(
    typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
    "AUTH_ERROR",
  );
  assert.equal(getTransactionAudit(caught)?.finalState, "not-started");
  assert.deepEqual(fixture.remote.writes, []);
});

test("force replacement is limited to a managed MR with a manually edited body", async () => {
  const fixture = await transactionFixture();
  await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const managed = fixture.remote.current as RemoteMergeRequest;
  fixture.remote.current = Object.freeze({
    ...managed,
    description: managed.description.replace("Preserve WebEngine-compatible", "Manually changed"),
  });
  fixture.remote.writes.length = 0;

  const updated = await updateMergeRequest({
    request: fixture.request,
    initial: fixture.remote.current,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
    forceReplaceDescription: true,
  });

  assert.equal(updated.forcedDescriptionReplacement, true);
  assert.equal(updated.final.description.includes("Manually changed"), false);
});

test("a managed merge request update rewrites fields and finishes with the description write", async () => {
  const fixture = await transactionFixture();
  await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const initial = fixture.remote.current as RemoteMergeRequest;
  fixture.remote.writes.length = 0;

  const updated = await updateMergeRequest({
    request: fixture.request,
    initial,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  // The title is only ever touched through fields-write; there is no Draft round trip.
  assert.deepEqual(fixture.remote.writes, ["write-fields", "write-description"]);
  assert.deepEqual(
    updated.transaction.steps.map((step) => step.operation),
    ["fields-write", "description-write"],
  );
  assert.equal(updated.transaction.finalState, "complete");
  assert.equal(updated.final.draft, false);
  assert.equal(updated.final.title, updated.writePlan.desired.title);
  assert.equal(updated.final.snapshot.mergeRequest.lifecycle, "ready");
});

test("update converts a legacy Draft merge request into a normal one through the title rewrite", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  // The retired Draft stage left merge requests with a Draft title and status::doing.
  await fixture.remote.removeLabels(88, ["gid://gitlab/ProjectLabel/50"]);
  await fixture.remote.addLabels(88, ["gid://gitlab/ProjectLabel/40"]);
  fixture.remote.markLegacyDraft();
  const legacy = fixture.remote.current as RemoteMergeRequest;
  assert.equal(legacy.draft, true);
  assert.equal(legacy.title.startsWith("Draft: "), true);
  assert.equal(legacy.snapshot.mergeRequest.lifecycle, "draft");
  fixture.remote.writes.length = 0;

  const updated = await updateMergeRequest({
    request: fixture.request,
    initial: legacy,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.deepEqual(fixture.remote.writes, ["add-labels", "remove-labels", "write-fields", "write-description"]);
  assert.deepEqual(
    updated.transaction.steps.map((step) => step.operation),
    ["labels-add", "labels-remove", "fields-write", "description-write"],
  );
  assert.equal(updated.transaction.finalState, "complete");
  assert.equal(updated.final.draft, false);
  assert.equal(updated.final.title, created.writePlan.desired.title);
  assert.equal(updated.final.snapshot.mergeRequest.lifecycle, "ready");
  assert.deepEqual([...updated.final.labelIds].sort(), [...created.writePlan.desired.labelIds].sort());
  assert.equal(updated.final.labelIds.includes("gid://gitlab/ProjectLabel/40"), false);
  assert.equal(verifyMergeRequest({
    level: "ready",
    current: updated.final,
    bundle: fixture.bundle,
    expected: updated.verification,
  }).valid, true);
});

test("an update failure after a confirmed write reports a provable partial write", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.failWrite = "write-description";
  let caught: unknown;
  try {
    await updateMergeRequest({
      request: fixture.request,
      initial: created.final,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(errorCode(caught), "PARTIAL_WRITE");
  assert.equal(errorMessage(caught), "The merge request update did not complete; its current state was read back");
  assert.deepEqual(fixture.remote.writes, ["write-fields", "write-description"]);
  const audit = getTransactionAudit(caught);
  assert.equal(audit?.finalState, "partial");
  assert.deepEqual(audit?.steps.map((step) => step.operation), ["fields-write", "description-write"]);
  const receipt = getTransactionFailureReceipt(caught);
  assert.deepEqual(receipt?.completedSteps, ["fields-write"]);
  assert.equal(receipt?.failedOperation, "description-write");
  assert.equal(receipt?.retryCommand, "harness-mrtool update 88 --input - --non-interactive --output json");
  assert.equal(fixture.remote.current?.draft, false);
});

test("an update whose first write is rejected claims no remote write", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.failWrite = "write-fields";
  let caught: unknown;
  try {
    await updateMergeRequest({
      request: fixture.request,
      initial: created.final,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(errorCode(caught), "GITLAB_ERROR");
  assert.equal(getTransactionAudit(caught)?.finalState, "not-started");
  assert.equal(getTransactionAudit(caught)?.steps[0]?.mutation?.outcome, "rejected");
  assert.equal(getTransactionFailureReceipt(caught), null);
  assert.equal(fixture.remote.current?.title, created.final.title);
});

test("update re-reads ownership and rejects description drift before its first write", async () => {
  const fixture = await transactionFixture();
  await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  const initial = fixture.remote.current as RemoteMergeRequest;
  fixture.remote.writes.length = 0;
  fixture.remote.driftDescriptionBeforeRead = "Concurrent human edit";

  await assert.rejects(
    updateMergeRequest({
      request: fixture.request,
      initial,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "CONCURRENT_UPDATE",
  );
  assert.deepEqual(fixture.remote.writes, []);
});

test("update reports concurrent drift found by its first mutation pre-read with zero writes", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.driftDescriptionOnReadNumber = {
    number: fixture.remote.currentReadCount + 2,
    description: `${created.final.description}\nConcurrent edit`,
  };

  let caught: unknown;
  try {
    await updateMergeRequest({
      request: fixture.request,
      initial: created.final,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(
    typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
    "CONCURRENT_UPDATE",
  );
  assert.deepEqual(fixture.remote.writes, []);
  assert.equal(getTransactionAudit(caught)?.finalState, "not-started");
});

test("update ignores naturally changing Issue, CI, and review context for concurrency", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.naturalContextDriftOnReadNumber = fixture.remote.currentReadCount + 1;

  const updated = await updateMergeRequest({
    request: fixture.request,
    initial: created.final,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(updated.final.draft, false);
  assert.equal(updated.transaction.finalState, "complete");
  assert.equal(fixture.remote.writes.length > 0, true);
});

test("a selected label renamed under the same stable ID stops the transaction", async () => {
  const fixture = await transactionFixture();
  fixture.remote.renameLabelAfterWrite = {
    kind: "write-fields",
    id: "gid://gitlab/ProjectLabel/20",
    name: "type::feature",
  };
  let caught: unknown;
  try {
    await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }

  assert.equal(errorCode(caught), "PARTIAL_REMOTE_STATE");
  assert.equal(getTransactionAudit(caught)?.finalState, "unknown");
  assert.equal(getTransactionFailureReceipt(caught)?.failedOperation, "fields-write");
  assert.equal(fixture.remote.writes.includes("write-description"), false);
});

test("a post-write identity drift records the successful read receipt before mismatch", async () => {
  const fixture = await transactionFixture();
  fixture.remote.renameLabelAfterWrite = {
    kind: "write-fields",
    id: "gid://gitlab/ProjectLabel/20",
    name: "type::feature",
  };
  let caught: unknown;
  try {
    await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }

  const fields = getTransactionAudit(caught)?.steps.find((step) => step.operation === "fields-write");
  assert.equal(fields?.mutation?.outcome, "confirmed");
  assert.equal(fields?.postRead.outcome, "succeeded");
  assert.equal(fields?.postRead.requestId, "req-read");
  assert.equal(fields?.postcondition, "mismatched");
});

test("update treats a successful write followed by failed readback as unknown remote state", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.failReadAfterWrite = "write-fields";

  await assert.rejects(
    updateMergeRequest({
      request: fixture.request,
      initial: created.final,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "PARTIAL_REMOTE_STATE",
  );
  assert.deepEqual(fixture.remote.writes, ["write-fields"]);
});

test("successful transactions expose a stable per-write audit journal", async () => {
  const fixture = await transactionFixture();
  const result = await updateHistoricalMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(result.transaction.journalVersion, 2);
  assert.equal(result.transaction.operation, "update");
  assert.equal(result.transaction.finalState, "complete");
  assert.match(result.transaction.candidateSelectionDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    result.transaction.steps.filter((step) => step.mutation !== null).map((step) => step.operation),
    [
      "labels-add",
      "fields-write",
      "description-write",
    ],
  );
  assert.equal(result.transaction.steps.every((step) => step.phase === "normal"), true);
  assert.equal(result.transaction.steps.every((step, index) => step.sequence === index + 1), true);
  assert.equal(result.transaction.steps.every((step) => step.postRead.outcome === "succeeded"), true);
  assert.equal(JSON.stringify(result.transaction).includes("week-token"), false);
});

test("failed transactions retain safe audit evidence outside enumerable ToolError fields", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failReadAfterWrite = "write-fields";
  let caught: unknown;
  try {
    await updateHistoricalMergeRequest({
      request: fixture.request,
      initialSnapshot: fixture.snapshot,
      resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle,
      releaseTag: "templates-v1.0.0",
      cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css",
      ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }
  assert.notEqual(caught, undefined);
  const audit = getTransactionAudit(caught);
  assert.notEqual(audit, null);
  assert.equal(audit?.finalState, "unknown");
  const failed = audit?.steps.find((step) => step.operation === "fields-write");
  assert.equal(failed?.mutation?.outcome, "confirmed");
  assert.equal(failed?.postRead.outcome, "failed");
  assert.equal(failed?.postcondition, "unavailable");
  assert.equal(JSON.stringify(caught).includes("steps"), false);
  assert.equal(JSON.stringify(audit).includes("week-token"), false);
});

test("every confirmed normal write preserves a failed readback in the audit", async () => {
  const cases = [
    { kind: "add-labels", occurrence: 1, operation: "labels-add" },
    { kind: "write-fields", occurrence: 1, operation: "fields-write" },
    { kind: "write-description", occurrence: 1, operation: "description-write" },
  ] as const;

  for (const scenario of cases) {
    const fixture = await transactionFixture();
    fixture.remote.failReadAfterWrite = scenario.kind;
    fixture.remote.failReadAfterWriteOccurrence = scenario.occurrence;
    let caught: unknown;
    try {
      await updateHistoricalMergeRequest({
        request: fixture.request,
        initialSnapshot: fixture.snapshot,
        resolvedCandidates: fixture.candidates,
        bundle: fixture.bundle,
        releaseTag: "templates-v1.0.0",
        cliVersion: "0.1.0-dev",
        sourceBranch: "fix/webengine-css",
        ...transactionRuntime(fixture.remote),
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(
      typeof caught === "object" && caught !== null && "code" in caught
        ? caught.code
        : null,
      "PARTIAL_REMOTE_STATE",
      scenario.operation,
    );
    const audit = getTransactionAudit(caught);
    assert.equal(audit?.finalState, "unknown", scenario.operation);
    const failed = audit?.steps.find((step) => step.operation === scenario.operation);
    assert.equal(failed?.mutation?.outcome, "confirmed", scenario.operation);
    assert.equal(failed?.postRead.outcome, "failed", scenario.operation);
    assert.equal(failed?.postcondition, "unavailable", scenario.operation);
  }
});

test("final transaction verification independently rejects out-of-pool labels even with an unchanged valid marker", async () => {
  const { assertTransactionStructure } = await import("../../src/app/verify-mr.ts");
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
  });
  const extraId = "gid://gitlab/ProjectLabel/999";
  const current = { ...created.final, labelIds: [...created.final.labelIds, extraId],
    snapshot: { ...created.final.snapshot,
      labelCandidates: [...created.final.snapshot.labelCandidates, { id: extraId, name: "week::retired" }],
      mergeRequest: { ...created.final.snapshot.mergeRequest, labelIds: [...created.final.labelIds, extraId] },
    },
  };
  assert.throws(() => assertTransactionStructure(current, created.final.description, fixture.bundle, "templates-v1.0.0"), { code: "POSTCONDITION_ERROR" });
});

for (const name of ["type::bug", "priority::p2", "status::review"]) {
  test(`a newly ambiguous planned name ${name} stops after label synchronization without further mutation`, async () => {
    const fixture = await transactionFixture();
    fixture.remote.duplicateLabelAfterWrite = { kind: "add-labels", name };
    await assert.rejects(updateHistoricalMergeRequest({
      request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
    }), { code: "PARTIAL_REMOTE_STATE" });
    assert.deepEqual(fixture.remote.writes, ["add-labels"]);
    assert.equal(fixture.remote.current?.draft, false);
    assert.equal(fixture.remote.current?.labelIds.length, 3);
  });
}
test("an update stops after a selected name becomes ambiguous", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
  });
  fixture.remote.writes.length = 0;
  fixture.remote.duplicateLabelAfterWrite = { kind: "write-fields", name: "type::bug" };
  let caught: unknown;
  try {
    await updateMergeRequest({
      request: fixture.request, initial: created.final, resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(errorCode(caught), "PARTIAL_REMOTE_STATE");
  assert.equal(getTransactionAudit(caught)?.finalState, "unknown");
  assert.deepEqual(fixture.remote.writes, ["write-fields"]);
  assert.equal(fixture.remote.current?.draft, false);
});
for (const gate of ["structure", "verify"] as const) {
  test(`${gate} independently rejects ambiguous live selected names with unchanged applied IDs`, async () => {
    const fixture = await transactionFixture();
    const created = await updateHistoricalMergeRequest({
      request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
      bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
      sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
    });
    const snapshot = validateExternalContextSnapshot({ ...created.final.snapshot,
      labelCandidates: [...created.final.snapshot.labelCandidates,
        { id: "gid://gitlab/ProjectLabel/999", name: "type::bug" }],
    });
    const current = { ...created.final, snapshot };
    assert.throws(() => {
      if (gate === "structure") assertTransactionStructure(current, created.final.description, fixture.bundle, "templates-v1.0.0");
      else verifyMergeRequest({ level: "ready", current, expected: created.verification, bundle: fixture.bundle });
    }, { code: "POSTCONDITION_ERROR" });
  });
}

test("stored verification rejects live name ambiguity under the mandatory-label policy", async () => {
  const fixture = await transactionFixture();
  const created = await updateHistoricalMergeRequest({
    request: fixture.request, initialSnapshot: fixture.snapshot, resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle, releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css", ...transactionRuntime(fixture.remote),
  });
  const receipt = buildVerificationReceipt({ gitlabOrigin: "https://gitlab.example.test",
    current: created.final, expected: created.verification, bundle: fixture.bundle });
  const current = { ...created.final, snapshot: validateExternalContextSnapshot({ ...created.final.snapshot,
    labelCandidates: [...created.final.snapshot.labelCandidates,
      { id: "gid://gitlab/ProjectLabel/999", name: "type::bug" }],
  }) };
  await assert.rejects(verifyStoredMergeRequest({
    level: "ready", current, gitlabOrigin: "https://gitlab.example.test",
    receiptLoader: { loadVerified: async () => ({ trusted: true as const, receipt }) },
    bundleLoader: { loadVerifiedExact: async () => ({ trusted: true as const, bundle: fixture.bundle }) },
  }), { code: "POSTCONDITION_ERROR" });
});
