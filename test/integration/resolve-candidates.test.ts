import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  resolveRequestCandidates,
  type ResolveRequestCandidatesInput,
} from "../../src/app/resolve-candidates.ts";
import { candidateSelectionDigest } from "../../src/app/transaction-journal.ts";
import type { Request } from "../../src/contracts/request.ts";
import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import { sha256CanonicalJson } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import type {
  Candidate,
  ContextBinding,
  ResolvedContext,
} from "../../src/context/types.ts";
import type { ExternalContextSnapshot } from "../../src/render/marker.ts";

const CONTEXT = `hmrx1_${"A".repeat(43)}`;
const LABEL_ONE = `hmrc1_${"B".repeat(43)}`;
const LABEL_TWO = `hmrc1_${"C".repeat(43)}`;
const ASSIGNEE = `hmrc1_${"D".repeat(43)}`;
const REVIEWER_ONE = `hmrc1_${"E".repeat(43)}`;
const REVIEWER_TWO = `hmrc1_${"F".repeat(43)}`;
const BEARERS = [CONTEXT, LABEL_ONE, LABEL_TWO, ASSIGNEE, REVIEWER_ONE, REVIEWER_TWO];
const CREDENTIAL_CANARY = "CANARYCANARY";

const binding: ContextBinding = {
  operation: "create",
  gitlabOrigin: "https://gitlab.example.test",
  targetProject: { id: "100", fullPath: "group/project" },
  targetBranch: "develop",
  sourceProject: { id: "200", fullPath: "fork/project" },
  sourceBranch: "feature/resolve-candidates",
  sourceHeadSha: "a".repeat(40),
  targetRefSha: "b".repeat(40),
  mrIid: null,
  releaseSetId: "stable-42",
  cliVersion: "0.1.0-dev",
  bundle: {
    id: "harness-mr-default",
    version: "1.0.0",
    releaseTag: "templates-v1.0.0",
    manifestHash: "c".repeat(64),
  },
  protocols: { inputSchema: 1, policySchema: 1, skillProtocol: 1 },
};

function labelCandidate(id: number, name: string): Candidate {
  return {
    kind: "label",
    restId: id,
    globalId: `gid://gitlab/ProjectLabel/${String(id)}`,
    name,
    description: `${name} description`,
    color: "#123456",
    scopeKind: "project",
    scopeId: "100",
    scopePath: "group/project",
    policyCategory: name.split("::", 1)[0]!,
  };
}

function userCandidate(kind: "assignee" | "reviewer", id: string): Candidate {
  return {
    kind,
    userId: id,
    globalId: `gid://gitlab/User/${id}`,
    username: `user-${id}`,
    displayName: `User ${id}`,
  };
}

const candidates = [
  labelCandidate(10, "type::bug"),
  labelCandidate(11, "priority::p1"),
  userCandidate("assignee", "20"),
  userCandidate("reviewer", "21"),
  userCandidate("reviewer", "22"),
] as const;

function snapshotValue(): ExternalContextSnapshot {
  return {
    snapshotVersion: 1,
    targetProject: { id: "100", path: "group/project" },
    sourceProject: { id: "200", path: "fork/project" },
    targetRefSha: binding.targetRefSha,
    mergeBaseSha: "d".repeat(40),
    sourceHeadSha: binding.sourceHeadSha,
    issue: { kind: "none" },
    labelCandidates: [
      { id: "gid://gitlab/ProjectLabel/10", name: "type::bug" },
      { id: "gid://gitlab/ProjectLabel/11", name: "priority::p1" },
    ],
    userCandidates: [
      { id: "20", username: "user-20", displayName: "User 20" },
      { id: "21", username: "user-21", displayName: "User 21" },
      { id: "22", username: "user-22", displayName: "User 22" },
      { id: "30", username: "author", displayName: "Author" },
    ],
    mergeRequest: {
      iid: null,
      authorUserId: "30",
      lifecycle: "new",
      labelIds: [],
      assigneeUserId: null,
      reviewerUserIds: [],
    },
    localChecks: {
      commitConvention: { status: "passed", evidence: "checked" },
      secretScan: { status: "passed", evidence: "checked" },
      repositoryHygiene: { status: "passed", evidence: "checked" },
    },
    metadataRead: { status: "available", evidence: "checked" },
    ci: { status: "pending" },
    review: {
      approvedByUserIds: [],
      qualifiedReviewerUserIds: ["21", "22"],
      unresolvedDiscussions: 0,
    },
  };
}

function requestValue(overrides: {
  readonly contextId?: string;
  readonly labels?: readonly string[];
  readonly assignee?: string | null;
  readonly reviewers?: readonly string[];
} = {}): Request {
  return {
    schemaVersion: 1,
    contextId: overrides.contextId ?? CONTEXT,
    intent: "ready",
    profileIds: ["code"],
    targetBranch: "develop",
    title: { type: "fix", module: "runtime", titleSummary: "Resolve selected candidates" },
    changes: { summary: ["Resolve selected candidates."], technicalChanges: ["Bind selections."], outOfScope: [] },
    motivation: { background: ["Candidate tokens are opaque."], whyNeeded: ["Writes need exact identities."] },
    workItem: { relation: "none", noIssueReason: "No tracking issue is required for this fixture." },
    impact: { areaIds: ["app"], nature: "functional", details: ["Candidate resolution only."] },
    verification: { items: [], acceptanceEvidence: ["Resolution is deterministic."], knownGaps: [] },
    documentation: { itemIds: [], details: [] },
    risk: { level: "low", items: [], compatibilityImpact: [], rollbackPlan: ["Revert the resolver."] },
    profileFields: {},
    review: {
      reviewerCandidateTokens: [...(overrides.reviewers ?? [REVIEWER_ONE, REVIEWER_TWO])],
      reviewerFocus: [],
      additionalNotes: [],
    },
    mergeRequest: {
      assigneeCandidateToken: overrides.assignee === undefined ? ASSIGNEE : overrides.assignee,
      labelCandidateTokens: [...(overrides.labels ?? [LABEL_ONE, LABEL_TWO])],
      removeSourceBranch: true,
      squash: true,
    },
  };
}

function resolvedValue(overrides: Partial<ResolvedContext> = {}): ResolvedContext {
  const snapshot = snapshotValue();
  return {
    contextId: CONTEXT,
    createdAtMs: 1,
    expiresAtMs: 2,
    binding,
    externalSnapshotDigest: sha256CanonicalJson(snapshot),
    snapshot: snapshot as never,
    candidates,
    ...overrides,
  };
}

function serializedError(error: unknown): string {
  if (isToolError(error)) {
    return JSON.stringify({ code: error.code, message: error.message, details: error.details });
  }
  return String(error);
}

function assertNoBearer(value: unknown): void {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const bearer of BEARERS) assert.equal(serialized.includes(bearer), false);
  assert.doesNotMatch(serialized, /hmr[cx]1_[A-Za-z0-9_-]{43}/u);
  assert.equal(serialized.includes(CREDENTIAL_CANARY), false);
}

function hasInternalCode(error: unknown): boolean {
  assertNoBearer(serializedError(error));
  return isToolError(error, "INTERNAL_ERROR");
}

test("resolves once in Request order, passes consume exactly, and returns only detached frozen values", async () => {
  const request = requestValue();
  const mutableResolved = structuredClone(resolvedValue());
  const calls: Parameters<ResolveRequestCandidatesInput["store"]["resolve"]>[0][] = [];
  const store: ResolveRequestCandidatesInput["store"] = {
    resolve: async (input) => {
      calls.push(structuredClone(input));
      return mutableResolved;
    },
  };

  const result = await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    contextId: CONTEXT,
    expectedBinding: binding,
    selections: [
      { kind: "label", token: LABEL_ONE },
      { kind: "label", token: LABEL_TWO },
      { kind: "assignee", token: ASSIGNEE },
      { kind: "reviewer", token: REVIEWER_ONE },
      { kind: "reviewer", token: REVIEWER_TWO },
    ],
    consume: false,
  });
  assert.deepEqual(Object.keys(result).sort(), [
    "binding", "candidateSelectionDigest", "candidates", "snapshot",
  ]);
  assert.equal(result.candidateSelectionDigest, candidateSelectionDigest(request, candidates, result.snapshot));
  assertNoBearer(result);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.binding), true);
  assert.equal(Object.isFrozen(result.binding.targetProject), true);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.localChecks.commitConvention), true);
  assert.equal(Object.isFrozen(result.candidates), true);
  assert.equal(result.candidates.every(Object.isFrozen), true);

  (mutableResolved.binding.targetProject as { id: string }).id = "changed";
  (mutableResolved.candidates[0] as { name: string }).name = "changed";
  (mutableResolved.snapshot as { targetProject: { id: string } }).targetProject.id = "changed";
  assert.equal(result.binding.targetProject.id, "100");
  assert.equal(result.candidates[0]?.kind === "label" ? result.candidates[0].name : null, "type::bug");
  assert.equal(result.snapshot.targetProject.id, "100");
});

test("passes an empty canonical selection list and consume true without inventing candidates", async () => {
  const request = requestValue({ labels: [], assignee: null, reviewers: [] });
  const calls: unknown[] = [];
  const store: ResolveRequestCandidatesInput["store"] = {
    resolve: async (input) => {
      calls.push(structuredClone(input));
      return resolvedValue({ candidates: [] });
    },
  };

  const result = await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: true });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    contextId: CONTEXT,
    expectedBinding: binding,
    selections: [],
    consume: true,
  });
  assert.deepEqual(result.candidates, []);
  assert.match(result.candidateSelectionDigest, /^[a-f0-9]{64}$/u);
});

test("fails closed when a successful store result drifts from the requested context contract", async () => {
  const request = requestValue();
  const differentContext = `hmrx1_${"G".repeat(43)}`;
  const variants: readonly [string, ResolvedContext][] = [
    ["contextId", resolvedValue({ contextId: differentContext })],
    ["binding", resolvedValue({ binding: { ...binding, targetBranch: "main" } })],
    ["snapshot digest", resolvedValue({ externalSnapshotDigest: "0".repeat(64) })],
    ["candidate count", resolvedValue({ candidates: candidates.slice(0, -1) })],
    ["candidate kind", resolvedValue({
      candidates: [candidates[0], candidates[1], userCandidate("reviewer", "20"), candidates[3], candidates[4]],
    })],
  ];

  for (const [name, value] of variants) {
    let calls = 0;
    const store: ResolveRequestCandidatesInput["store"] = {
      resolve: async () => {
        calls += 1;
        return value;
      },
    };
    await assert.rejects(
      resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false }),
      hasInternalCode,
      name,
    );
    assert.equal(calls, 1, name);
  }
});

test("rejects malformed or credential-bearing successful store values as INTERNAL_ERROR", async () => {
  const request = requestValue();
  const cyclicCandidate = structuredClone(candidates[0]) as unknown as Record<string, unknown>;
  cyclicCandidate.self = cyclicCandidate;
  const malformedValues: readonly unknown[] = [
    { ...resolvedValue(), snapshot: { ...snapshotValue(), snapshotVersion: 2 } },
    { ...resolvedValue(), candidates: [{ ...candidates[0], unexpected: true }, ...candidates.slice(1)] },
    { ...resolvedValue(), candidates: [cyclicCandidate, ...candidates.slice(1)] },
    {
      ...resolvedValue(),
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        displayName: `Bearer ${"secret".repeat(3)}`,
      }, candidates[3], candidates[4]],
    },
    {
      ...resolvedValue(),
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        displayName: `Private-Token: ${CREDENTIAL_CANARY}`,
      }, candidates[3], candidates[4]],
    },
    {
      ...resolvedValue(),
      candidates: [candidates[0], candidates[1], {
        ...candidates[2],
        displayName: `Job-Token=${CREDENTIAL_CANARY}`,
      }, candidates[3], candidates[4]],
    },
  ];

  for (const value of malformedValues) {
    const store: ResolveRequestCandidatesInput["store"] = {
      resolve: async () => value as ResolvedContext,
    };
    await assert.rejects(
      resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false }),
      hasInternalCode,
    );
  }
});

test("delegates duplicate bearer rejection once and never reflects store errors", async () => {
  const duplicate = LABEL_ONE;
  const request = requestValue({ reviewers: [duplicate] });
  let calls = 0;
  const store: ResolveRequestCandidatesInput["store"] = {
    resolve: async (input) => {
      calls += 1;
      assert.deepEqual(input.selections.map((selection) => selection.token), [
        LABEL_ONE, LABEL_TWO, ASSIGNEE, duplicate,
      ]);
      throw new ToolError("INPUT_ERROR", `Rejected duplicate ${duplicate}`, {
        field: "candidateTokens",
        expected: "unique tokens",
        actual: duplicate,
        safeNextStep: `Replace ${duplicate}.`,
      });
    },
  };

  let caught: unknown;
  try {
    await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: true });
  } catch (error) {
    caught = error;
  }
  assert.equal(calls, 1);
  assert.equal(isToolError(caught, "INPUT_ERROR"), true);
  assertNoBearer(serializedError(caught));
});

test("maps an unclassified throwing store to a bearer-free INTERNAL_ERROR", async () => {
  const store: ResolveRequestCandidatesInput["store"] = {
    resolve: async () => {
      throw new Error(`adapter failed for ${CONTEXT} and ${LABEL_ONE}`);
    },
  };

  await assert.rejects(
    resolveRequestCandidates({ request: requestValue(), expectedBinding: binding, store, consume: false }),
    hasInternalCode,
  );
});

test("redacts GitLab credential headers from classified store errors", async () => {
  for (const header of ["Private-Token", "Job-Token"] as const) {
    const store: ResolveRequestCandidatesInput["store"] = {
      resolve: async () => {
        throw new ToolError("INPUT_ERROR", `${header}: ${CREDENTIAL_CANARY}`, {
          field: "candidateTokens",
          expected: "current candidates",
          actual: `${header}=${CREDENTIAL_CANARY}`,
          safeNextStep: "Run context again.",
        });
      },
    };

    let caught: unknown;
    try {
      await resolveRequestCandidates({
        request: requestValue(),
        expectedBinding: binding,
        store,
        consume: false,
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(isToolError(caught, "INPUT_ERROR"), true);
    assertNoBearer(serializedError(caught));
  }
});

test("does not trust structured credential keys or causes from store errors", async () => {
  const variants = [
    new ToolError("INPUT_ERROR", "Candidate lookup failed", {
      field: "candidateTokens",
      expected: "current candidates",
      actual: { "Private-Token": CREDENTIAL_CANARY },
      safeNextStep: "Run context again.",
    }),
    new ToolError("LABEL_ERROR", "Candidate lookup failed", {
      field: "candidateTokens",
      expected: "current candidates",
      actual: { nested: { "Job-Token": CREDENTIAL_CANARY } },
      safeNextStep: "Run context again.",
    }),
    new ToolError("INPUT_ERROR", "Candidate lookup failed", {
      field: "candidateTokens",
      expected: "current candidates",
      actual: "candidate unavailable",
      safeNextStep: "Run context again.",
    }, new Error(`Private-Token: ${CREDENTIAL_CANARY}`)),
  ] as const;

  for (const original of variants) {
    const store: ResolveRequestCandidatesInput["store"] = {
      resolve: async () => { throw original; },
    };
    let caught: unknown;
    try {
      await resolveRequestCandidates({
        request: requestValue(),
        expectedBinding: binding,
        store,
        consume: false,
      });
    } catch (error) {
      caught = error;
    }
    assert.equal(isToolError(caught, "INPUT_ERROR"), true);
    assert.notEqual(caught, original);
    assert.equal((caught as Error).cause, undefined);
    assertNoBearer(serializedError(caught));
    assert.equal(String((caught as Error).cause).includes(CREDENTIAL_CANARY), false);
  }
});

test("malformed validation result leaves real candidate tokens reusable", async () => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "hmr-resolve-candidates-malformed-"));
  try {
    const realStore = new CandidateContextStore({
      stateDirectory,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const snapshot = snapshotValue();
    const issued = await realStore.issue({ binding, snapshot: snapshot as never, candidates });
    const assigneeToken = issued.candidates.find((candidate) => candidate.kind === "assignee")?.token;
    assert.ok(assigneeToken);
    const request = requestValue({
      contextId: issued.contextId,
      labels: issued.candidates.filter((candidate) => candidate.kind === "label")
        .map((candidate) => candidate.token),
      assignee: assigneeToken,
      reviewers: issued.candidates.filter((candidate) => candidate.kind === "reviewer")
        .map((candidate) => candidate.token),
    });
    const malformedStore: ResolveRequestCandidatesInput["store"] = {
      resolve: async (input) => ({
        ...await realStore.resolve(input),
        candidates: [],
      }),
    };

    await assert.rejects(
      resolveRequestCandidates({ request, expectedBinding: binding, store: malformedStore, consume: true }),
      hasInternalCode,
    );
    await resolveRequestCandidates({ request, expectedBinding: binding, store: realStore, consume: false });
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("a malformed successful consume receipt cannot turn a committed selection into failure", async () => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "hmr-resolve-candidates-commit-"));
  try {
    const realStore = new CandidateContextStore({
      stateDirectory,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const snapshot = snapshotValue();
    const issued = await realStore.issue({ binding, snapshot: snapshot as never, candidates });
    const assigneeToken = issued.candidates.find((candidate) => candidate.kind === "assignee")?.token;
    assert.ok(assigneeToken);
    const request = requestValue({
      contextId: issued.contextId,
      labels: issued.candidates.filter((candidate) => candidate.kind === "label")
        .map((candidate) => candidate.token),
      assignee: assigneeToken,
      reviewers: issued.candidates.filter((candidate) => candidate.kind === "reviewer")
        .map((candidate) => candidate.token),
    });
    const consumeCalls: boolean[] = [];
    const malformedCommitReceiptStore: ResolveRequestCandidatesInput["store"] = {
      resolve: async (input) => {
        consumeCalls.push(input.consume === true);
        const value = await realStore.resolve(input);
        return input.consume ? { ...value, candidates: [] } : value;
      },
    };

    const result = await resolveRequestCandidates({
      request,
      expectedBinding: binding,
      store: malformedCommitReceiptStore,
      consume: true,
    });

    assert.deepEqual(consumeCalls, [false, true]);
    assert.equal(result.candidates.length, candidates.length);
    assertNoBearer(result);
    await assert.rejects(
      resolveRequestCandidates({ request, expectedBinding: binding, store: realStore, consume: false }),
      (error: unknown) => isToolError(error) && ["INPUT_ERROR", "LABEL_ERROR"].includes(error.code),
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});

test("real CandidateContextStore keeps consume=false reusable and consume=true one-shot", async () => {
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "hmr-resolve-candidates-"));
  try {
    const store = new CandidateContextStore({
      stateDirectory,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const snapshot = snapshotValue();
    const issued = await store.issue({ binding, snapshot: snapshot as never, candidates });
    const labelTokens = issued.candidates
      .filter((candidate) => candidate.kind === "label")
      .map((candidate) => candidate.token);
    const assigneeToken = issued.candidates.find((candidate) => candidate.kind === "assignee")?.token;
    const reviewerTokens = issued.candidates
      .filter((candidate) => candidate.kind === "reviewer")
      .map((candidate) => candidate.token);
    assert.ok(assigneeToken);
    const request = requestValue({
      contextId: issued.contextId,
      labels: labelTokens,
      assignee: assigneeToken,
      reviewers: reviewerTokens,
    });

    await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false });
    await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false });
    await resolveRequestCandidates({ request, expectedBinding: binding, store, consume: true });
    await assert.rejects(
      resolveRequestCandidates({ request, expectedBinding: binding, store, consume: false }),
      (error: unknown) => isToolError(error) && ["INPUT_ERROR", "LABEL_ERROR"].includes(error.code),
    );
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
});
