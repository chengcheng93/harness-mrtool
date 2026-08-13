import assert from "node:assert/strict";
import test from "node:test";

import {
  TransactionJournal,
  attachTransactionAudit,
  candidateSelectionDigest,
  getTransactionAudit,
  remoteWriteFromTransactionAudit,
  validateTransactionAudit,
} from "../../src/app/transaction-journal.ts";
import {
  mutationReceipt,
  safeRequestId,
  valueReceipt,
} from "../../src/app/remote-receipt.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import type { Request } from "../../src/contracts/request.ts";
import type { Candidate } from "../../src/context/types.ts";
import type { ExternalContextSnapshot } from "../../src/render/marker.ts";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function emptyAudit() {
  return {
    journalVersion: 1 as const,
    operation: "create" as const,
    sourceHeadSha: SHA,
    candidateSelectionDigest: DIGEST,
    finalState: "not-started" as const,
    recoveredUnknownOutcome: false,
    steps: [],
  };
}

function completedStep(overrides: Record<string, unknown> = {}) {
  return {
    sequence: 1,
    phase: "normal",
    operation: "create-draft",
    preRead: {
      outcome: "not-applicable",
      requestId: null,
      snapshotDigest: null,
    },
    mutation: {
      outcome: "confirmed",
      requestId: "01J.TEST/request-1",
    },
    postRead: {
      outcome: "succeeded",
      requestId: "01J.TEST/read-1",
      snapshotDigest: "c".repeat(64),
    },
    postcondition: "matched",
    ...overrides,
  };
}

function snapshotState(id = 88) {
  return {
    iid: id,
    webUrl: `https://gitlab.example.test/project/-/merge_requests/${String(id)}`,
    title: "Draft: [fix][app] Deterministic journal",
    description: "Description\n",
    draft: true,
    state: "opened" as const,
    sourceProjectId: "100",
    sourceBranch: "fix/journal",
    targetProjectId: "100",
    targetBranch: "develop",
    sourceHeadSha: SHA,
    labelIds: ["gid://gitlab/ProjectLabel/1"],
    assigneeUserId: null,
    reviewerUserIds: [],
    squash: true,
    removeSourceBranch: true,
    snapshot: {
      snapshotVersion: 1,
      opaque: "test snapshot",
    },
  } as never;
}

function externalContextSnapshot(): ExternalContextSnapshot {
  const author = { id: "user:1", username: "author", displayName: "Author" };
  const assignee = { id: "user:2", username: "assignee", displayName: "Assignee" };
  const reviewer = { id: "user:3", username: "reviewer", displayName: "Reviewer" };
  const label = { id: "label:1", name: "type::feature" };
  return {
    snapshotVersion: 1,
    targetProject: { id: "100", path: "group/target" },
    sourceProject: { id: "101", path: "group/source" },
    targetRefSha: "1".repeat(40),
    mergeBaseSha: "2".repeat(40),
    sourceHeadSha: SHA,
    issue: {
      kind: "linked",
      iid: 51,
      readStatus: "available",
      milestone: "2026-09 DVT Prototype",
      assignees: [assignee],
      dueDate: "2026-08-07",
      labels: [label],
    },
    labelCandidates: [label],
    userCandidates: [author, assignee, reviewer],
    mergeRequest: {
      iid: 88,
      authorUserId: author.id,
      lifecycle: "draft",
      labelIds: [label.id],
      assigneeUserId: assignee.id,
      reviewerUserIds: [reviewer.id],
    },
    localChecks: {
      commitConvention: { status: "passed", evidence: "checked" },
      secretScan: { status: "passed", evidence: "checked" },
      repositoryHygiene: { status: "passed", evidence: "checked" },
    },
    metadataRead: { status: "available", evidence: "read" },
    ci: { status: "passed" },
    review: {
      approvedByUserIds: [reviewer.id],
      qualifiedReviewerUserIds: [reviewer.id],
      unresolvedDiscussions: 0,
    },
  };
}

test("an empty transaction audit has an exact frozen V1 JCS contract", () => {
  const input = emptyAudit();
  const audit = validateTransactionAudit(input);

  assert.deepEqual(audit, input);
  assert.deepEqual(Object.keys(audit), [
    "journalVersion",
    "operation",
    "sourceHeadSha",
    "candidateSelectionDigest",
    "finalState",
    "recoveredUnknownOutcome",
    "steps",
  ]);
  assert.equal(Object.isFrozen(audit), true);
  assert.equal(Object.isFrozen(audit.steps), true);
  assert.equal(
    canonicalizeJson(audit),
    canonicalizeJson(validateTransactionAudit(structuredClone(input))),
  );
  assert.deepEqual(remoteWriteFromTransactionAudit(audit), {
    state: "not-attempted",
    operations: [],
  });
});

test("transaction audit validation rejects extra fields and malformed scalar contracts", () => {
  for (const value of [
    { ...emptyAudit(), extra: true },
    { ...emptyAudit(), journalVersion: 2 },
    { ...emptyAudit(), operation: "delete" },
    { ...emptyAudit(), sourceHeadSha: "not-a-sha" },
    { ...emptyAudit(), candidateSelectionDigest: "not-a-digest" },
    { ...emptyAudit(), finalState: "success" },
    { ...emptyAudit(), recoveredUnknownOutcome: "false" },
  ]) {
    assert.throws(() => validateTransactionAudit(value), /transaction audit/i);
  }
});

test("transaction audit validation rejects malformed steps and non-consecutive sequence numbers", () => {
  for (const step of [
    { ...completedStep(), extra: true },
    { ...completedStep(), sequence: 2 },
    { ...completedStep(), phase: "other" },
    { ...completedStep(), operation: "delete-mr" },
    { ...completedStep(), mutation: { outcome: "confirmed", requestId: "bad\r\nid" } },
    {
      ...completedStep(),
      postRead: { outcome: "succeeded", requestId: null, snapshotDigest: "short" },
    },
    {
      ...completedStep(),
      postRead: { outcome: "failed", requestId: null, snapshotDigest: "c".repeat(64) },
    },
  ]) {
    assert.throws(
      () => validateTransactionAudit({ ...emptyAudit(), steps: [step] }),
      /transaction audit/i,
    );
  }

  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      steps: [completedStep(), { ...completedStep(), sequence: 1 }],
    }),
    /transaction audit/i,
  );
});

test("a confirmed mutation with a matching readback derives a written result", () => {
  const audit = validateTransactionAudit({
    ...emptyAudit(),
    finalState: "draft-proven",
    steps: [completedStep()],
  });

  assert.deepEqual(remoteWriteFromTransactionAudit(audit), {
    state: "written",
    operations: ["create-draft"],
  });
});

test("a confirmed mutation followed by a failed read remains auditable and unknown", () => {
  const audit = validateTransactionAudit({
    ...emptyAudit(),
    finalState: "unknown",
    steps: [completedStep({
      postRead: { outcome: "failed", requestId: "read-failure", snapshotDigest: null },
      postcondition: "unavailable",
    })],
  });

  assert.deepEqual(audit.steps[0]?.mutation, {
    outcome: "confirmed",
    requestId: "01J.TEST/request-1",
  });
  assert.deepEqual(audit.steps[0]?.postRead, {
    outcome: "failed",
    requestId: "read-failure",
    snapshotDigest: null,
  });
  assert.deepEqual(remoteWriteFromTransactionAudit(audit), {
    state: "unknown",
    operations: ["create-draft"],
  });
});

test("journal snapshots use the same exact V1 contract", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  assert.deepEqual(journal.snapshot(), validateTransactionAudit(emptyAudit()));
});

test("journal construction rejects invalid operation, source SHA, or selection digest before recording", () => {
  assert.throws(() => new TransactionJournal("delete" as never, SHA, DIGEST), /transaction audit/i);
  assert.throws(() => new TransactionJournal("create", "bad-sha", DIGEST), /transaction audit/i);
  assert.throws(() => new TransactionJournal("create", SHA, "bad-digest"), /transaction audit/i);
});

test("an unknown mutation is recovered only by a matching successful read", () => {
  const record = (postcondition: "matched" | "mismatched") => {
    const journal = new TransactionJournal("create", SHA, DIGEST);
    const recorder = journal.start("normal", "labels-add", snapshotState(), "pre-read");
    recorder.mutation("unknown", "write-request");
    assert.equal(journal.snapshot().recoveredUnknownOutcome, false);
    recorder.readSucceeded("post-read", snapshotState());
    recorder.postcondition(postcondition);
    return journal.snapshot();
  };

  assert.equal(record("mismatched").recoveredUnknownOutcome, false);
  assert.equal(record("matched").recoveredUnknownOutcome, true);
});

test("a rejected mutation and a failed pre-read do not count as remote writes", () => {
  const rejected = new TransactionJournal("create", SHA, DIGEST);
  const rejectedStep = rejected.start("normal", "labels-add", snapshotState());
  rejectedStep.mutation("rejected", "rejected-request");
  assert.deepEqual(remoteWriteFromTransactionAudit(rejected.snapshot()), {
    state: "not-written",
    operations: [],
  });

  const unreadable = new TransactionJournal("update", SHA, DIGEST);
  const unreadableStep = unreadable.start("normal", "fields-write", null);
  unreadableStep.preReadFailed("failed-read");
  assert.deepEqual(remoteWriteFromTransactionAudit(unreadable.snapshot()), {
    state: "not-written",
    operations: [],
  });
});

test("a proven compensation is distinguished from an unproven compensation", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const normal = journal.start("normal", "mark-ready", snapshotState());
  normal.mutation("unknown", "mark-ready-request");
  normal.readFailed("mark-ready-read");

  const compensation = journal.start("compensation", "mark-draft", snapshotState());
  compensation.mutation("confirmed", "mark-draft-request");
  compensation.readSucceeded("mark-draft-read", snapshotState());
  compensation.postcondition("matched");
  journal.setFinalState("compensated-draft");
  assert.deepEqual(remoteWriteFromTransactionAudit(journal.snapshot()), {
    state: "compensated",
    operations: ["mark-ready", "mark-draft"],
  });

  const failed = journal.start("compensation", "compensation-description", snapshotState());
  failed.mutation("confirmed", "description-request");
  failed.readFailed("description-read");
  journal.setFinalState("unknown");
  assert.equal(remoteWriteFromTransactionAudit(journal.snapshot()).state, "unknown");
});

test("mark-ready seals later normal or recovery mutations but permits reads and compensation", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  journal.start("normal", "mark-ready", snapshotState());

  assert.throws(
    () => journal.start("normal", "description-write", snapshotState()),
    /closed after mark-ready/i,
  );
  assert.throws(
    () => journal.start("recovery", "labels-add", snapshotState()),
    /closed after mark-ready|phase.*operation/i,
  );
  assert.doesNotThrow(() => {
    const query = journal.start("recovery", "create-outcome-query", null);
    query.readSucceeded("query-read", snapshotState());
    query.postcondition("matched");
  });
  assert.doesNotThrow(() => {
    journal.start("compensation", "mark-draft", snapshotState());
  });
});

test("create-outcome-query is structurally read-only", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const query = journal.start("recovery", "create-outcome-query", null);
  assert.throws(() => query.mutation("confirmed", "bad-write"), /read-only/i);
});

test("transaction phase and operation pairs cannot disguise a normal write", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  for (const [phase, operation] of [
    ["recovery", "labels-add"],
    ["normal", "create-outcome-query"],
    ["compensation", "mark-ready"],
    ["compensation", "labels-add"],
    ["normal", "compensation-description"],
  ] as const) {
    assert.throws(
      () => journal.start(phase, operation, snapshotState()),
      /phase.*operation|operation.*phase/i,
    );
  }
  assert.doesNotThrow(() => journal.start("normal", "mark-draft", snapshotState()));
  assert.doesNotThrow(() => journal.start("compensation", "mark-draft", snapshotState()));
});

test("a read-only create outcome query records an empty successful result", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const query = journal.start("recovery", "create-outcome-query", null);
  query.readResultSucceeded("query-request", []);
  query.postcondition("mismatched");

  const audit = journal.snapshot();
  assert.equal(audit.steps[0]?.mutation, null);
  assert.equal(audit.steps[0]?.postRead.outcome, "succeeded");
  assert.match(audit.steps[0]?.postRead.snapshotDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(audit.steps[0]?.postcondition, "mismatched");
});

test("a recorder cannot overwrite an earlier mutation or read receipt", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const recorder = journal.start("normal", "create-draft", null);
  recorder.mutation("confirmed", "first-write");
  assert.throws(() => recorder.mutation("unknown", "second-write"), /already recorded/i);
  recorder.readSucceeded("first-read", snapshotState());
  assert.throws(() => recorder.readFailed("second-read"), /already recorded/i);
  assert.throws(() => recorder.readResultSucceeded("third-read", []), /already recorded/i);
  recorder.postcondition("matched");
  assert.throws(() => recorder.postcondition("mismatched"), /already recorded/i);
});

test("final states cannot claim proof without a matching successful step", () => {
  for (const finalState of ["draft-proven", "ready-proven", "compensated-draft"] as const) {
    assert.throws(
      () => validateTransactionAudit({ ...emptyAudit(), finalState }),
      /final state/i,
    );
  }
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "ready-proven",
      steps: [completedStep()],
    }),
    /final state/i,
  );
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "compensated-draft",
      steps: [completedStep()],
    }),
    /final state/i,
  );
});

test("recovered unknown outcome must be proven exactly by the recorded steps", () => {
  assert.throws(
    () => validateTransactionAudit({ ...emptyAudit(), recoveredUnknownOutcome: true }),
    /recovered unknown/i,
  );
  const unknownMatched = completedStep({
    mutation: { outcome: "unknown", requestId: "unknown-write" },
  });
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "draft-proven",
      steps: [unknownMatched],
    }),
    /recovered unknown/i,
  );
  assert.doesNotThrow(() => validateTransactionAudit({
    ...emptyAudit(),
    finalState: "draft-proven",
    recoveredUnknownOutcome: true,
    steps: [unknownMatched],
  }));
  assert.doesNotThrow(() => validateTransactionAudit({
    ...emptyAudit(),
    finalState: "unknown",
    recoveredUnknownOutcome: true,
    steps: [
      completedStep({
        operation: "create-draft",
        mutation: { outcome: "unknown", requestId: "unknown-create" },
        postRead: { outcome: "not-attempted", requestId: null, snapshotDigest: null },
        postcondition: "unavailable",
      }),
      completedStep({
        sequence: 2,
        phase: "recovery",
        operation: "create-outcome-query",
        mutation: null,
      }),
    ],
  }));
});

test("journal snapshots are deeply frozen copies isolated from later recording", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const recorder = journal.start("normal", "create-draft", null);
  const before = journal.snapshot();

  recorder.mutation("confirmed", "create-request");
  recorder.readSucceeded("create-read", snapshotState());
  recorder.postcondition("matched");
  journal.setFinalState("draft-proven");
  const after = journal.snapshot();

  assert.equal(before.finalState, "not-started");
  assert.equal(before.steps[0]?.mutation, null);
  assert.equal(before.steps[0]?.postRead.outcome, "not-attempted");
  assert.equal(after.steps[0]?.mutation?.outcome, "confirmed");
  assert.equal(Object.isFrozen(after.steps[0]), true);
  assert.equal(Object.isFrozen(after.steps[0]?.postRead), true);
  assert.throws(() => {
    (after.steps as unknown as unknown[]).push("mutation");
  }, TypeError);
});

test("transaction audits attach through a WeakMap without becoming error JSON", () => {
  const syntheticBearer = `hmrc1_${"A".repeat(43)}`;
  const error = new Error("Safe public failure", { cause: new Error(syntheticBearer) });
  const journal = new TransactionJournal("create", SHA, DIGEST);
  attachTransactionAudit(error, journal.snapshot());
  journal.setFinalState("unknown");

  const attached = getTransactionAudit(error);
  assert.deepEqual(attached, emptyAudit());
  assert.equal(Object.isFrozen(attached), true);
  assert.equal(getTransactionAudit({}), null);
  assert.equal(JSON.stringify(error).includes("journalVersion"), false);
  assert.equal(JSON.stringify(error).includes(syntheticBearer), false);
});

test("request IDs retain safe opaque identifiers and discard reflected secrets", () => {
  const credential = "private-credential-123";
  const candidate = `prefix-${credential}-suffix`;
  assert.equal(safeRequestId("01J9Q7A3V5/request:99"), "01J9Q7A3V5/request:99");
  for (const unsafe of [
    "bad\r\nid",
    "x".repeat(129),
    "请求-id",
    "glpat-secret-token",
    `hmrc1_${"A".repeat(43)}`,
    `hmrx1_${"B".repeat(43)}`,
  ]) {
    assert.equal(safeRequestId(unsafe), null, unsafe);
  }
  assert.equal(safeRequestId(candidate, [credential]), null);
  assert.deepEqual(mutationReceipt("safe-request"), { requestId: "safe-request" });
  assert.deepEqual(mutationReceipt(candidate, [credential]), { requestId: null });
  assert.deepEqual(valueReceipt({ iid: 88 }, "safe-read"), {
    requestId: "safe-read",
    value: { iid: 88 },
  });
  assert.equal(Object.isFrozen(mutationReceipt()), true);
  assert.equal(Object.isFrozen(valueReceipt(88)), true);
});

function selectionRequest(
  contextId: string,
  labelTokens: readonly string[],
  assigneeToken: string | null,
  reviewerTokens: readonly string[],
): Request {
  return {
    contextId,
    mergeRequest: {
      labelCandidateTokens: [...labelTokens],
      assigneeCandidateToken: assigneeToken,
    },
    review: { reviewerCandidateTokens: [...reviewerTokens] },
  } as unknown as Request;
}

function candidate(kind: Candidate["kind"], id: string): Candidate {
  if (kind === "label") {
    return {
      kind,
      restId: Number(id),
      globalId: `gid://gitlab/ProjectLabel/${id}`,
      name: `type::${id}`,
      description: "",
      color: "#000000",
      scopeKind: "project",
      scopeId: "100",
      scopePath: "group/project",
      policyCategory: "type",
    };
  }
  return {
    kind,
    userId: id,
    globalId: `gid://gitlab/User/${id}`,
    username: `user-${id}`,
    displayName: `User ${id}`,
  };
}

test("candidate selection digest binds token, candidate, kind, ordinal, and context without leaking bearer", () => {
  const context = `hmrx1_${"C".repeat(43)}`;
  const labelOne = `hmrc1_${"D".repeat(43)}`;
  const labelTwo = `hmrc1_${"E".repeat(43)}`;
  const reviewer = `hmrc1_${"F".repeat(43)}`;
  const request = selectionRequest(context, [labelOne, labelTwo], null, [reviewer]);
  const candidates = [
    candidate("label", "1"),
    candidate("label", "2"),
    candidate("reviewer", "3"),
  ] as const;
  const snapshot = externalContextSnapshot();

  const digest = candidateSelectionDigest(request, candidates, snapshot);
  assert.match(digest, /^[a-f0-9]{64}$/u);
  assert.equal(
    candidateSelectionDigest(structuredClone(request), structuredClone(candidates), structuredClone(snapshot)),
    digest,
  );
  assert.notEqual(
    candidateSelectionDigest(
      selectionRequest(context, [labelTwo, labelOne], null, [reviewer]),
      candidates,
      snapshot,
    ),
    digest,
  );
  assert.notEqual(candidateSelectionDigest(request, [candidates[1], candidates[0], candidates[2]], snapshot), digest);
  assert.notEqual(
    candidateSelectionDigest(
      selectionRequest(`${context.slice(0, -1)}G`, [labelOne, labelTwo], null, [reviewer]),
      candidates,
      snapshot,
    ),
    digest,
  );
  assert.equal(JSON.stringify({ candidateSelectionDigest: digest }).includes("hmr"), false);
  for (const bearer of [context, labelOne, labelTwo, reviewer]) {
    assert.equal(JSON.stringify({ candidateSelectionDigest: digest }).includes(bearer), false);
  }
});

test("candidate selection digest binds the complete external context snapshot", () => {
  const request = selectionRequest("context", ["label"], null, []);
  const candidates = [candidate("label", "1")];
  const snapshot = externalContextSnapshot();
  if (snapshot.issue.kind !== "linked") throw new Error("Test fixture must use a linked issue");
  const digest = candidateSelectionDigest(request, candidates, snapshot);
  const variants: ExternalContextSnapshot[] = [
    { ...snapshot, targetProject: { ...snapshot.targetProject, path: "group/other-target" } },
    { ...snapshot, sourceProject: { ...snapshot.sourceProject, path: "group/other-source" } },
    { ...snapshot, targetRefSha: "3".repeat(40) },
    { ...snapshot, mergeBaseSha: "4".repeat(40) },
    { ...snapshot, sourceHeadSha: "5".repeat(40) },
    { ...snapshot, issue: { ...snapshot.issue, iid: 52 } },
    { ...snapshot, labelCandidates: [{ ...snapshot.labelCandidates[0]!, name: "type::bug" }] },
    { ...snapshot, userCandidates: [{ ...snapshot.userCandidates[0]!, displayName: "Changed" }, ...snapshot.userCandidates.slice(1)] },
    { ...snapshot, mergeRequest: { ...snapshot.mergeRequest, lifecycle: "ready" } },
    { ...snapshot, localChecks: { ...snapshot.localChecks, secretScan: { status: "failed", evidence: "failed" } } },
    { ...snapshot, metadataRead: { status: "unavailable", evidence: "offline" } },
    { ...snapshot, ci: { status: "running" } },
    { ...snapshot, review: { ...snapshot.review, unresolvedDiscussions: 1 } },
  ];
  for (const variant of variants) {
    assert.notEqual(candidateSelectionDigest(request, candidates, variant), digest);
  }
});

test("candidate selection digest rejects unpaired candidates and kind mismatches", () => {
  const request = selectionRequest("context", ["label"], null, ["reviewer"]);
  const snapshot = externalContextSnapshot();
  assert.throws(
    () => candidateSelectionDigest(request, [candidate("label", "1")], snapshot),
    /paired/i,
  );
  assert.throws(
    () => candidateSelectionDigest(
      request,
      [candidate("reviewer", "1"), candidate("label", "2")],
      snapshot,
    ),
    /paired/i,
  );
});
