import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  createMergeRequest,
  UnknownRemoteOutcomeError,
  type CreateDraftInput,
  type ManagedFieldsInput,
  type MergeRequestRemote,
  type RemoteMergeRequest,
} from "../../src/app/create-mr.ts";
import {
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
import type { Candidate } from "../../src/context/types.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import {
  parseDiagnosticMarker,
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../../src/render/marker.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

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

test("WritePlan resolves opaque selections, derives lifecycle labels, and preserves manual labels", async () => {
  const fixture = (name: string) => resolve(repositoryRoot, "test/golden/fixtures", name);
  const [rawRequest, rawSnapshot, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  rawRequest.mergeRequest.labelCandidateTokens = [
    "hmrc1_week-token",
    "hmrc1_type-token",
    "hmrc1_priority-token",
  ];
  rawRequest.mergeRequest.assigneeCandidateToken = "hmrc1_assignee-token";
  rawRequest.review.reviewerCandidateTokens = ["hmrc1_reviewer-token"];
  const request = normalizeAndValidateRequest(rawRequest);

  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/10", name: "week::2026-w32-0803-0809" },
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p1" },
    { id: "gid://gitlab/ProjectLabel/40", name: "status::doing" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
    { id: "gid://gitlab/ProjectLabel/60", name: "manual::keep" },
    { id: "gid://gitlab/ProjectLabel/70", name: "type::feature" },
  ];
  rawSnapshot.mergeRequest.labelIds = [
    "gid://gitlab/ProjectLabel/60",
    "gid://gitlab/ProjectLabel/70",
  ];
  rawSnapshot.mergeRequest.lifecycle = "draft";
  rawSnapshot.mergeRequest.iid = 88;
  const snapshot = validateExternalContextSnapshot(rawSnapshot);
  const candidates: readonly Candidate[] = [
    labelCandidate(10, "gid://gitlab/ProjectLabel/10", "week::2026-w32-0803-0809", "week"),
    labelCandidate(20, "gid://gitlab/ProjectLabel/20", "type::bug", "type"),
    labelCandidate(30, "gid://gitlab/ProjectLabel/30", "priority::p1", "priority"),
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

  const plan = buildWritePlan({ request, snapshot, resolvedCandidates: candidates, bundle });

  assert.equal(plan.intent, "ready");
  assert.equal(plan.provisional.title.startsWith("Draft: "), true);
  assert.equal(plan.desired.title, "[fix][luban-studio] Preserve WebEngine-compatible CSS output");
  assert.deepEqual(plan.draft.labelIds, [
    "gid://gitlab/ProjectLabel/10",
    "gid://gitlab/ProjectLabel/20",
    "gid://gitlab/ProjectLabel/30",
    "gid://gitlab/ProjectLabel/40",
    "gid://gitlab/ProjectLabel/60",
  ]);
  assert.deepEqual(plan.desired.labelIds, [
    "gid://gitlab/ProjectLabel/10",
    "gid://gitlab/ProjectLabel/20",
    "gid://gitlab/ProjectLabel/30",
    "gid://gitlab/ProjectLabel/50",
    "gid://gitlab/ProjectLabel/60",
  ]);
  assert.equal(plan.draftStatusLabelId, "gid://gitlab/ProjectLabel/40");
  assert.equal(plan.readyStatusLabelId, "gid://gitlab/ProjectLabel/50");
  assert.equal(plan.managedLabelIds.includes("gid://gitlab/ProjectLabel/70"), true);
  assert.deepEqual(plan.preservedLabelIds, ["gid://gitlab/ProjectLabel/60"]);
  assert.equal(plan.desired.assigneeUserId, "user:10");
  assert.deepEqual(plan.desired.reviewerUserIds, ["user:20"]);
});

test("a high-risk Draft uses the Draft reviewer minimum", async () => {
  const fixture = await transactionFixture();
  const request = normalizeAndValidateRequest({
    ...structuredClone(fixture.request),
    intent: "draft",
    risk: { ...fixture.request.risk, level: "high" },
    review: { ...fixture.request.review, reviewerCandidateTokens: [] },
  });
  const candidates = fixture.candidates.filter((candidate) => candidate.kind !== "reviewer");

  const plan = buildWritePlan({
    request,
    snapshot: fixture.snapshot,
    resolvedCandidates: candidates,
    bundle: fixture.bundle,
  });

  assert.equal(plan.intent, "draft");
  assert.deepEqual(plan.desired.reviewerUserIds, []);
});

type WriteKind =
  | "create-draft"
  | "add-labels"
  | "remove-labels"
  | "write-fields"
  | "write-description"
  | "mark-ready"
  | "mark-draft";

class FakeMergeRequestRemote implements MergeRequestRemote {
  readonly writes: WriteKind[] = [];
  readonly stagedVerificationReceipts: VerificationReceiptV1[] = [];
  readonly baseSnapshot: ExternalContextSnapshot;
  findOpenCalls = 0;
  current: RemoteMergeRequest | null = null;
  failWrite: WriteKind | null = null;
  unknownReady: "none" | "applied" | "applied-with-mismatch" = "none";
  unknownCreate: "none" | "applied" = "none";
  createRecovery: "exact" | "none" | "mismatch" | "multiple" = "exact";
  mismatchConfirmedCreateReadback = false;
  unknownAfterWrite: WriteKind | null = null;
  unclassifiedAfterWrite: WriteKind | null = null;
  driftDescriptionBeforeRead: string | null = null;
  driftDescriptionOnReadNumber: { readonly number: number; readonly description: string } | null = null;
  naturalContextDriftOnReadNumber: number | null = null;
  dropReviewerQualificationAfterWrite: WriteKind | null = null;
  renameLabelAfterWrite: { readonly kind: WriteKind; readonly id: string; readonly name: string } | null = null;
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

  constructor(snapshot: ExternalContextSnapshot) {
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
    if (this.dropReviewerQualificationAfterWrite === null) {
      // No live qualification override is active.
    } else {
      const review = snapshot.review as { qualifiedReviewerUserIds: string[] | null };
      review.qualifiedReviewerUserIds = [];
    }
    if (this.renameLabelAfterWrite !== null) {
      const mutable = snapshot as unknown as { labelCandidates: Array<{ id: string; name: string }> };
      mutable.labelCandidates = snapshot.labelCandidates.map((label) =>
        label.id === this.renameLabelAfterWrite?.id
          ? { ...label, name: this.renameLabelAfterWrite.name }
          : label);
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
    if (this.dropReviewerQualificationAfterWrite === kind) {
      this.dropReviewerQualificationAfterWrite = "create-draft";
    }
    if (this.renameLabelAfterWrite?.kind === kind) {
      this.renameLabelAfterWrite = { ...this.renameLabelAfterWrite, kind: "create-draft" };
    }
  }

  private failNextReadAfter(kind: WriteKind): void {
    if (this.failReadAfterWrite === kind) this.failReadSeen += 1;
    if (this.failReadAfterWrite === kind && this.failReadSeen === this.failReadAfterWriteOccurrence) {
      this.failReadAfterWrite = null;
      this.failReads += 1;
    }
  }

  async createDraft(input: CreateDraftInput) {
    this.record("create-draft");
    assert.equal(input.sourceBranch, "fix/webengine-css");
    const provisional: RemoteMergeRequest = {
      iid: 88,
      webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
      title: input.title,
      description: input.description,
      draft: true,
      state: "opened",
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
      snapshot: this.baseSnapshot,
    };
    this.current = Object.freeze({ ...provisional, snapshot: this.snapshotFor(provisional) });
    if (this.unknownCreate === "applied") {
      throw new UnknownRemoteOutcomeError("create outcome is unknown");
    }
    if (this.mismatchConfirmedCreateReadback) {
      this.replace({ title: "Concurrent provisional title" });
    }
    return valueReceipt({ iid: this.current.iid }, "req-create");
  }

  async findOpen(input: CreateDraftInput) {
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
      ? Object.freeze({ ...current, description: "A different Draft" })
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

  async markReady(_iid: number, title: string) {
    this.record("mark-ready");
    if (this.unknownReady !== "none") {
      this.replace({
        draft: false,
        title: this.unknownReady === "applied" ? title : "Concurrent title",
      });
      throw new UnknownRemoteOutcomeError("mark-ready outcome is unknown");
    }
    this.replace({ draft: false, title });
    this.failNextReadAfter("mark-ready");
    this.throwUnknownAfter("mark-ready");
    return mutationReceipt("req-ready");
  }

  async markDraft(_iid: number, title: string) {
    this.record("mark-draft");
    this.replace({ draft: true, title });
    this.failNextReadAfter("mark-draft");
    this.throwUnknownAfter("mark-draft");
    return mutationReceipt("req-draft");
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
    remote,
    gitlabOrigin: "https://gitlab.example.test",
    verificationReceiptWriter: {
      stageAuthenticated: async (receipt: VerificationReceiptV1) => {
        remote.stagedVerificationReceipts.push(structuredClone(receipt));
      },
    },
  };
}

test("create queries open merge requests before its first remote write", async () => {
  const fixture = await transactionFixture();

  await createMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(fixture.remote.findOpenCalls, 1);
  assert.equal(fixture.remote.writes[0], "create-draft");
});

test("create refuses one or multiple existing open merge requests before writing", async () => {
  for (const count of [1, 2]) {
    const fixture = await transactionFixture();
    await createMergeRequest({
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
  const created = await createMergeRequest({
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
  assert.equal(fixture.remote.writes.includes("create-draft"), false);
});

async function transactionFixture(): Promise<{
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
  rawRequest.mergeRequest.labelCandidateTokens = ["week-token", "type-token", "priority-token"];
  rawRequest.mergeRequest.assigneeCandidateToken = "assignee-token";
  rawRequest.review.reviewerCandidateTokens = ["reviewer-token"];
  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/10", name: "week::2026-w32-0803-0809" },
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p1" },
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
    labelCandidate(10, "gid://gitlab/ProjectLabel/10", "week::2026-w32-0803-0809", "week"),
    labelCandidate(20, "gid://gitlab/ProjectLabel/20", "type::bug", "type"),
    labelCandidate(30, "gid://gitlab/ProjectLabel/30", "priority::p1", "priority"),
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
    remote: new FakeMergeRequestRemote(snapshot),
  };
}

test("Ready is the final normal write and the final marker is read back", async () => {
  const fixture = await transactionFixture();
  const result = await createMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(fixture.remote.writes.at(-1), "mark-ready");
  assert.equal(fixture.remote.current?.draft, false);
  assert.equal(fixture.remote.current?.title, result.writePlan.desired.title);
  assert.equal(parseDiagnosticMarker(fixture.remote.current?.description ?? "").renderPhase, "final");
  assert.equal(result.recoveredUnknownOutcome, false);
});

test("an unknown Ready outcome is accepted only after exact readback", async () => {
  const fixture = await transactionFixture();
  fixture.remote.unknownReady = "applied";

  const result = await createMergeRequest({
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
  assert.equal(fixture.remote.current?.draft, false);
  assert.equal(fixture.remote.writes.at(-1), "mark-ready");
});

test("unknown label, field, and description writes continue only after exact readback", async () => {
  for (const kind of ["add-labels", "write-fields", "write-description"] as const) {
    const fixture = await transactionFixture();
    fixture.remote.unknownAfterWrite = kind;
    const result = await createMergeRequest({
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
  }
});

test("an unclassified adapter failure is treated as unknown until exact readback", async () => {
  const fixture = await transactionFixture();
  fixture.remote.unclassifiedAfterWrite = "write-fields";

  const result = await createMergeRequest({
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

test("an unknown create outcome is recovered by exact source and target identity", async () => {
  const fixture = await transactionFixture();
  fixture.remote.unknownCreate = "applied";

  const result = await createMergeRequest({
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
  assert.equal(result.final.draft, false);
  assert.equal(result.completedWrites.includes("create-draft.recovered"), true);
});

test("unknown create recovery refuses zero, multiple, or non-identical Draft candidates", async () => {
  for (const recovery of ["none", "mismatch", "multiple"] as const) {
    const fixture = await transactionFixture();
    fixture.remote.unknownCreate = "applied";
    fixture.remote.createRecovery = recovery;
    let caught: unknown;
    try {
      await createMergeRequest({
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
      typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
      "PARTIAL_REMOTE_STATE",
    );
    const receipt = getTransactionFailureReceipt(caught);
    if (recovery === "mismatch") {
      assert.equal(receipt?.iid, 88);
      assert.equal(receipt?.iidUnavailable, false);
      assert.equal(receipt?.webUrlUnavailable, false);
      assert.equal(receipt?.retryCommand, "harness-mrtool verify 88 --level structure --output json");
    } else {
      assert.equal(receipt?.iid, null);
      assert.equal(receipt?.iidUnavailable, true);
      assert.equal(receipt?.webUrl, null);
      assert.equal(receipt?.webUrlUnavailable, true);
      assert.equal(receipt?.retryCommand, "harness-mrtool context --output json");
    }
    assert.equal(receipt?.failedOperation, "create-outcome-query");
    assert.equal(receipt?.failedField, "mergeRequest.createOutcome");
    assert.deepEqual(receipt?.completedSteps, []);
    assert.deepEqual(fixture.remote.writes, ["create-draft"]);
  }
});

test("a Ready request whose provisional Draft title exceeds GitLab's limit writes nothing", async () => {
  const fixture = await transactionFixture();
  const raw = structuredClone(fixture.request);
  const mutableTitle = raw.title as { module: string; titleSummary: string };
  mutableTitle.module = "m".repeat(32);
  mutableTitle.titleSummary = "S".repeat(60);
  const request = normalizeAndValidateRequest(raw);

  await assert.rejects(
    createMergeRequest({
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

test("a rejected Draft create maps to a stable zero-write error with an audit receipt", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failWrite = "create-draft";
  let caught: unknown;
  try {
    await createMergeRequest({
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
    typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
    "GITLAB_ERROR",
  );
  const audit = getTransactionAudit(caught);
  assert.equal(audit?.finalState, "not-started");
  assert.equal(audit?.steps[0]?.mutation?.outcome, "rejected");
});

test("an inconsistent unknown Ready outcome is compensated to Draft and reported partial", async () => {
  const fixture = await transactionFixture();
  fixture.remote.unknownReady = "applied-with-mismatch";

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
      error.code === "PARTIAL_REMOTE_STATE",
  );
  assert.equal(fixture.remote.current?.draft, true);
  assert.equal(fixture.remote.current?.snapshot.mergeRequest.labelIds.includes(
    "gid://gitlab/ProjectLabel/40",
  ), true);
  assert.equal(fixture.remote.current?.snapshot.mergeRequest.labelIds.includes(
    "gid://gitlab/ProjectLabel/50",
  ), false);
});

test("a deterministic post-create write failure reports a provable partial Draft", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failWrite = "add-labels";
  let caught: unknown;
  try {
    await createMergeRequest({
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
    typeof caught === "object" && caught !== null && "code" in caught ? caught.code : null,
    "PARTIAL_DRAFT",
  );
  assert.equal(fixture.remote.current?.draft, true);
  assert.equal(fixture.remote.current?.state, "opened");
  assert.deepEqual(getTransactionFailureReceipt(caught), {
    receiptVersion: 1,
    iid: 88,
    iidUnavailable: false,
    webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/88",
    webUrlUnavailable: false,
    completedSteps: ["create-draft"],
    failedOperation: "labels-add",
    failedField: "mergeRequest.labels",
    retryCommand: "harness-mrtool update 88 --input - --non-interactive --output json",
  });
  assert.equal(JSON.stringify(getTransactionFailureReceipt(caught)).includes("week-token"), false);
});

test("create readback failure preserves the known IID and explicitly marks its URL unavailable", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failReads = 1;
  let caught: unknown;

  try {
    await createMergeRequest({
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

  assert.deepEqual(getTransactionFailureReceipt(caught), {
    receiptVersion: 1,
    iid: 88,
    iidUnavailable: false,
    webUrl: null,
    webUrlUnavailable: true,
    completedSteps: [],
    failedOperation: "create-draft",
    failedField: "mergeRequest.readback",
    retryCommand: "harness-mrtool verify 88 --level structure --output json",
  });
});

test("a confirmed create readback mismatch is recorded as a mismatched postcondition", async () => {
  const fixture = await transactionFixture();
  fixture.remote.mismatchConfirmedCreateReadback = true;
  let caught: unknown;

  try {
    await createMergeRequest({
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

  const createStep = getTransactionAudit(caught)?.steps.find((step) => step.operation === "create-draft");
  assert.equal(createStep?.postRead.outcome, "succeeded");
  assert.equal(createStep?.postcondition, "mismatched");
});

test("structure and ready verification allow pending live gates while merge verification does not", async () => {
  const fixture = await transactionFixture();
  const created = await createMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(verifyMergeRequest({
    level: "structure",
    current: created.final,
    bundle: fixture.bundle,
    expected: created.verification,
  }).valid, true);
  assert.equal(verifyMergeRequest({
    level: "ready",
    current: created.final,
    bundle: fixture.bundle,
    expected: created.verification,
  }).valid, true);
  assert.throws(
    () => verifyMergeRequest({
      level: "merge",
      current: created.final,
      bundle: fixture.bundle,
      expected: created.verification,
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "POSTCONDITION_ERROR",
  );
});

test("the durable verification receipt is staged before the final description write", async () => {
  const fixture = await transactionFixture();
  const staged: VerificationReceiptV1[] = [];

  const created = await createMergeRequest({
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
    await createMergeRequest({
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
    "PARTIAL_DRAFT",
  );
  assert.equal(getTransactionFailureReceipt(caught)?.failedOperation, "verification-receipt-stage");
  assert.equal(getTransactionFailureReceipt(caught)?.failedField, "verificationReceipt");
  assert.equal(fixture.remote.writes.includes("write-description"), false);
  assert.equal(fixture.remote.writes.includes("mark-ready"), false);
});

test("standalone verification reloads a trusted durable receipt and exact historical Bundle", async () => {
  const fixture = await transactionFixture();
  const created = await createMergeRequest({
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

test("standalone verification fails closed for a missing or untrusted durable receipt", async () => {
  const fixture = await transactionFixture();
  const created = await createMergeRequest({
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
  const created = await createMergeRequest({
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
  const created = await createMergeRequest({
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
  const created = await createMergeRequest({
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
  const created = await createMergeRequest({
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

test("a readback failure after a write reports unknown remote state", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failReads = 1;
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
      error.code === "PARTIAL_REMOTE_STATE",
  );
  assert.equal(fixture.remote.current?.draft, true);
});

test("persistent readback failure after Draft creation reports unknown remote state", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failReads = 10;
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
      error.code === "PARTIAL_REMOTE_STATE",
  );
});

test("structure verification detects body drift without writing the MR", async () => {
  const fixture = await transactionFixture();
  const created = await createMergeRequest({
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

test("verification classifies unmanaged and manually edited descriptions without writes", async () => {
  const fixture = await transactionFixture();
  const created = await createMergeRequest({
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
  await createMergeRequest({
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
  const draftRequest = normalizeAndValidateRequest({ ...structuredClone(fixture.request), intent: "draft" });
  const created = await createMergeRequest({
    request: draftRequest,
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
      request: draftRequest,
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
  await createMergeRequest({
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

test("a managed Ready MR update returns to Draft and makes Ready the final write", async () => {
  const fixture = await transactionFixture();
  await createMergeRequest({
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

  assert.equal(fixture.remote.writes[0], "mark-draft");
  assert.equal(fixture.remote.writes.at(-1), "mark-ready");
  assert.equal(updated.final.draft, false);
});

test("update re-reads ownership and rejects description drift before its first write", async () => {
  const fixture = await transactionFixture();
  await createMergeRequest({
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
  const draftRequest = normalizeAndValidateRequest({ ...structuredClone(fixture.request), intent: "draft" });
  const created = await createMergeRequest({
    request: draftRequest,
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
      request: draftRequest,
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
  const draftRequest = normalizeAndValidateRequest({ ...structuredClone(fixture.request), intent: "draft" });
  const created = await createMergeRequest({
    request: draftRequest,
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
    request: draftRequest,
    initial: created.final,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(updated.final.draft, true);
  assert.equal(updated.transaction.finalState, "draft-proven");
  assert.equal(fixture.remote.writes.length > 0, true);
});

test("Ready transition stops when the selected reviewer loses qualification", async () => {
  const fixture = await transactionFixture();
  fixture.remote.dropReviewerQualificationAfterWrite = "write-description";

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
      (error.code === "PARTIAL_DRAFT" || error.code === "PARTIAL_REMOTE_STATE"),
  );
  assert.equal(fixture.remote.writes.includes("mark-ready"), false);
  assert.equal(fixture.remote.current?.draft, true);
});

test("Ready gate is repeated after lifecycle status readback", async () => {
  const fixture = await transactionFixture();
  fixture.remote.dropReviewerQualificationAfterWrite = "remove-labels";

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
      (error.code === "PARTIAL_DRAFT" || error.code === "PARTIAL_REMOTE_STATE"),
  );
  assert.equal(fixture.remote.writes.includes("mark-ready"), false);
  assert.equal(fixture.remote.current?.draft, true);
  assert.equal(fixture.remote.current?.labelIds.includes("gid://gitlab/ProjectLabel/40"), true);
  assert.equal(fixture.remote.current?.labelIds.includes("gid://gitlab/ProjectLabel/50"), false);
});

test("a selected label renamed under the same stable ID stops the transaction", async () => {
  const fixture = await transactionFixture();
  fixture.remote.renameLabelAfterWrite = {
    kind: "write-fields",
    id: "gid://gitlab/ProjectLabel/10",
    name: "week::2026-w33-0810-0816",
  };

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
      (error.code === "PARTIAL_DRAFT" || error.code === "PARTIAL_REMOTE_STATE"),
  );
  assert.equal(fixture.remote.writes.includes("write-description"), false);
  assert.equal(fixture.remote.current?.draft, true);
});

test("update treats a successful write followed by failed readback as unknown remote state", async () => {
  const fixture = await transactionFixture();
  const draftRequest = normalizeAndValidateRequest({ ...structuredClone(fixture.request), intent: "draft" });
  const created = await createMergeRequest({
    request: draftRequest,
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
      request: draftRequest,
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
  const result = await createMergeRequest({
    request: fixture.request,
    initialSnapshot: fixture.snapshot,
    resolvedCandidates: fixture.candidates,
    bundle: fixture.bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    sourceBranch: "fix/webengine-css",
    ...transactionRuntime(fixture.remote),
  });

  assert.equal(result.transaction.journalVersion, 1);
  assert.equal(result.transaction.operation, "create");
  assert.equal(result.transaction.finalState, "ready-proven");
  assert.match(result.transaction.candidateSelectionDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    result.transaction.steps.filter((step) => step.mutation !== null).map((step) => step.operation),
    [
      "create-draft",
      "labels-add",
      "fields-write",
      "description-write",
      "lifecycle-status-ready-add",
      "lifecycle-status-ready-remove",
      "mark-ready",
    ],
  );
  assert.equal(result.transaction.steps.every((step, index) => step.sequence === index + 1), true);
  assert.equal(result.transaction.steps.every((step) => step.postRead.outcome === "succeeded"), true);
  assert.equal(JSON.stringify(result.transaction).includes("week-token"), false);
});

test("failed transactions retain safe audit evidence outside enumerable ToolError fields", async () => {
  const fixture = await transactionFixture();
  fixture.remote.failReadAfterWrite = "write-fields";
  let caught: unknown;
  try {
    await createMergeRequest({
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
    { kind: "add-labels", occurrence: 2, operation: "lifecycle-status-ready-add" },
    { kind: "remove-labels", occurrence: 1, operation: "lifecycle-status-ready-remove" },
    { kind: "mark-ready", occurrence: 1, operation: "mark-ready" },
  ] as const;

  for (const scenario of cases) {
    const fixture = await transactionFixture();
    fixture.remote.failReadAfterWrite = scenario.kind;
    fixture.remote.failReadAfterWriteOccurrence = scenario.occurrence;
    let caught: unknown;
    try {
      await createMergeRequest({
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
    const failed = audit?.steps.find((step) => step.operation === scenario.operation);
    assert.equal(failed?.mutation?.outcome, "confirmed", scenario.operation);
    assert.equal(failed?.postRead.outcome, "failed", scenario.operation);
    assert.equal(failed?.postcondition, "unavailable", scenario.operation);
  }
});

test("every confirmed compensation write preserves a failed readback in the audit", async () => {
  const cases = [
    { kind: "mark-draft", occurrence: 1, operation: "mark-draft" },
    { kind: "add-labels", occurrence: 3, operation: "compensation-labels-add" },
    { kind: "remove-labels", occurrence: 2, operation: "compensation-labels-remove" },
    { kind: "write-fields", occurrence: 2, operation: "compensation-fields" },
    { kind: "write-description", occurrence: 2, operation: "compensation-description" },
  ] as const;

  for (const scenario of cases) {
    const fixture = await transactionFixture();
    fixture.remote.unknownReady = "applied-with-mismatch";
    fixture.remote.failReadAfterWrite = scenario.kind;
    fixture.remote.failReadAfterWriteOccurrence = scenario.occurrence;
    let caught: unknown;
    try {
      await createMergeRequest({
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
    const failed = audit?.steps.find((step) =>
      step.phase === "compensation" && step.operation === scenario.operation);
    assert.equal(failed?.mutation?.outcome, "confirmed", scenario.operation);
    assert.equal(failed?.postRead.outcome, "failed", scenario.operation);
    assert.equal(failed?.postcondition, "unavailable", scenario.operation);
    assert.equal(audit?.finalState, "unknown", scenario.operation);
  }
});
