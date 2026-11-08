import assert from "node:assert/strict";
import test from "node:test";

import {
  TransactionJournal,
  attachTransactionAudit,
  attachTransactionFailure,
  candidateSelectionDigest,
  getTransactionAudit,
  getTransactionFailureReceipt,
  validateTransactionFailureReceipt,
  remoteSnapshotDigest,
  remoteWriteFromTransactionAudit,
  validateTransactionAudit,
} from "../../src/app/transaction-journal.ts";
import {
  mutationReceipt,
  safeRequestId,
  valueReceipt,
} from "../../src/app/remote-receipt.ts";
import {
  RemoteMutationError,
  RemoteReadError,
  isRemoteMutationError,
  isRemoteReadError,
  remoteFailureToolError,
} from "../../src/app/remote-outcome.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import type { Request } from "../../src/contracts/request.ts";
import type { Candidate } from "../../src/context/types.ts";
import type { ExternalContextSnapshot } from "../../src/render/marker.ts";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

function emptyAudit() {
  return {
    journalVersion: 2 as const,
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
    operation: "create",
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
    title: "[fix][app] Deterministic journal",
    description: "Description\n",
    draft: false,
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
      lifecycle: "ready",
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

test("an empty transaction audit has an exact frozen journal-version-2 JCS contract", () => {
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
    { ...emptyAudit(), journalVersion: 1 },
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
    { ...completedStep(), operation: "create-draft" },
    { ...completedStep(), operation: "mark-ready" },
    { ...completedStep(), phase: "compensation" },
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
    finalState: "partial",
    steps: [completedStep()],
  });

  assert.deepEqual(remoteWriteFromTransactionAudit(audit), {
    state: "written",
    operations: ["create"],
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
    operations: ["create"],
  });
});

test("journal snapshots use the same exact journal contract", () => {
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
    const journal = new TransactionJournal("update", SHA, DIGEST);
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
  const rejected = new TransactionJournal("update", SHA, DIGEST);
  const rejectedStep = rejected.start("normal", "labels-add", snapshotState(), "rejected-pre-read");
  rejectedStep.mutation("rejected", "rejected-request");
  assert.deepEqual(remoteWriteFromTransactionAudit(rejected.snapshot()), {
    state: "not-written",
    operations: [],
  });

  const unreadable = new TransactionJournal("update", SHA, DIGEST);
  const unreadableStep = unreadable.start("normal", "fields-write", snapshotState());
  unreadableStep.preReadFailed("failed-read");
  assert.deepEqual(remoteWriteFromTransactionAudit(unreadable.snapshot()), {
    state: "not-written",
    operations: [],
  });
});

test("final state complete requires description-write as the last matched step", () => {
  const prefix = () => {
    const journal = new TransactionJournal("create", SHA, DIGEST);
    const create = journal.start("normal", "create", null);
    create.mutation("confirmed", "create-request");
    create.readSucceeded("create-read", snapshotState());
    create.postcondition("matched");
    for (const operation of ["labels-add", "fields-write"] as const) {
      const step = journal.start("normal", operation, snapshotState(), `${operation}-pre-read`);
      step.mutation("confirmed", `${operation}-request`);
      step.readSucceeded(`${operation}-read`, snapshotState());
      step.postcondition("matched");
    }
    return journal;
  };

  const incomplete = prefix();
  incomplete.setFinalState("complete");
  assert.throws(() => incomplete.snapshot(), /final state complete requires description-write/i);
  incomplete.setFinalState("partial");
  assert.deepEqual(remoteWriteFromTransactionAudit(incomplete.snapshot()), {
    state: "written",
    operations: ["create", "labels-add", "fields-write"],
  });

  const unreadable = prefix();
  const failedDescription = unreadable.start("normal", "description-write", snapshotState(), "description-pre-read");
  failedDescription.mutation("confirmed", "description-request");
  failedDescription.readFailed("description-read");
  unreadable.setFinalState("complete");
  assert.throws(() => unreadable.snapshot(), /final state complete requires description-write/i);
  unreadable.setFinalState("unknown");
  assert.equal(remoteWriteFromTransactionAudit(unreadable.snapshot()).state, "unknown");

  const complete = prefix();
  const description = complete.start("normal", "description-write", snapshotState(), "description-pre-read");
  description.mutation("unknown", "description-request");
  description.readSucceeded("description-read", snapshotState());
  description.postcondition("matched");
  complete.setFinalState("complete");
  const audit = complete.snapshot();
  assert.equal(audit.finalState, "complete");
  assert.equal(audit.recoveredUnknownOutcome, true);
  assert.deepEqual(remoteWriteFromTransactionAudit(audit), {
    state: "written",
    operations: ["create", "labels-add", "fields-write", "description-write"],
  });
});

test("partial requires a matched normal write and not-started forbids any possible write", () => {
  const journal = new TransactionJournal("update", SHA, DIGEST);
  const labels = journal.start("normal", "labels-add", snapshotState(), "labels-pre-read");
  labels.mutation("confirmed", "labels-request");
  labels.readFailed("labels-read");
  journal.setFinalState("partial");
  assert.throws(() => journal.snapshot(), /partial final state requires a matched remote write/i);
  journal.setFinalState("not-started");
  assert.throws(() => journal.snapshot(), /not-started cannot contain a possible remote write/i);
  journal.setFinalState("unknown");
  assert.deepEqual(remoteWriteFromTransactionAudit(journal.snapshot()), {
    state: "unknown",
    operations: ["labels-add"],
  });

  const matched = new TransactionJournal("update", SHA, DIGEST);
  const fields = matched.start("normal", "fields-write", snapshotState(), "fields-pre-read");
  fields.mutation("confirmed", "fields-request");
  fields.readSucceeded("fields-read", snapshotState());
  fields.postcondition("matched");
  matched.setFinalState("partial");
  assert.deepEqual(remoteWriteFromTransactionAudit(matched.snapshot()), {
    state: "written",
    operations: ["fields-write"],
  });
});

test("failure receipts derive the failed operation and field from the incomplete step", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const create = journal.start("normal", "create", null);
  create.mutation("confirmed", "create-request");
  create.readSucceeded("create-read", snapshotState());
  create.postcondition("matched");
  const labels = journal.start("normal", "labels-add", snapshotState(), "labels-pre-read");
  labels.mutation("unknown", "labels-request");
  labels.readFailed("labels-read");
  journal.setFinalState("unknown");
  const audit = journal.snapshot();
  const webUrl = "https://gitlab.example.test/project/-/merge_requests/88";

  const derived = new Error("labels unknown");
  attachTransactionFailure(derived, { audit, iid: 88, webUrl, completedSteps: ["create"], retry: "update" });
  assert.deepEqual(getTransactionFailureReceipt(derived), {
    receiptVersion: 1,
    iid: 88,
    iidUnavailable: false,
    webUrl,
    webUrlUnavailable: false,
    completedSteps: ["create"],
    failedOperation: "labels-add",
    failedField: "mergeRequest.labels",
    retryCommand: "harness-mrtool update 88 --input - --non-interactive --output json",
  });

  for (const [failedOperation, failedField] of [
    ["create", "mergeRequest"],
    ["labels-remove", "mergeRequest.labels"],
    ["fields-write", "mergeRequest.fields"],
    ["description-write", "mergeRequest.description"],
    ["create-outcome-query", "mergeRequest.createOutcome"],
    ["verification-receipt-stage", "verificationReceipt"],
  ] as const) {
    const error = new Error(failedOperation);
    attachTransactionFailure(error, {
      audit, iid: 88, webUrl: null, completedSteps: ["create"], retry: "verify", failedOperation,
    });
    const receipt = getTransactionFailureReceipt(error);
    assert.equal(receipt?.failedOperation, failedOperation);
    assert.equal(receipt?.failedField, failedField);
    assert.equal(receipt?.webUrlUnavailable, true);
    assert.equal(receipt?.retryCommand, "harness-mrtool verify 88 --level structure --output json");
  }
  assert.equal(getTransactionFailureReceipt({}), null);
});

test("create-outcome-query is structurally read-only", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const query = journal.start("recovery", "create-outcome-query", null);
  assert.throws(() => query.mutation("confirmed", "bad-write"), /read-only/i);
});

test("transaction phase and operation pairs cannot disguise a normal write", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  for (const [phase, operation] of [
    ["recovery", "create"],
    ["recovery", "labels-add"],
    ["recovery", "description-write"],
    ["normal", "create-outcome-query"],
  ] as const) {
    assert.throws(
      () => journal.start(phase, operation, snapshotState()),
      /phase.*operation|operation.*phase/i,
    );
  }
  assert.doesNotThrow(() => journal.start("normal", "create", null));
  assert.doesNotThrow(() => journal.start("recovery", "create-outcome-query", null));
});

test("a read-only create outcome query records an empty successful result after unknown create", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const create = journal.start("normal", "create", null);
  create.mutation("unknown", "unknown-create");
  const query = journal.start("recovery", "create-outcome-query", null);
  query.readResultSucceeded("query-request", []);
  query.postcondition("mismatched");

  const audit = journal.snapshot();
  assert.equal(audit.steps[1]?.mutation, null);
  assert.equal(audit.steps[1]?.postRead.outcome, "succeeded");
  assert.match(audit.steps[1]?.postRead.snapshotDigest ?? "", /^[a-f0-9]{64}$/u);
  assert.equal(audit.steps[1]?.postcondition, "mismatched");
});

test("a recorder cannot overwrite an earlier mutation or read receipt", () => {
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const recorder = journal.start("normal", "create", snapshotState(), "first-pre-read");
  assert.throws(() => recorder.preReadSucceeded("second-pre-read", snapshotState(89)), /already recorded/i);
  assert.throws(() => recorder.preReadFailed("third-pre-read"), /already recorded/i);
  recorder.mutation("confirmed", "first-write");
  assert.throws(() => recorder.mutation("unknown", "second-write"), /already recorded/i);
  recorder.readSucceeded("first-read", snapshotState());
  assert.throws(() => recorder.readFailed("second-read"), /already recorded/i);
  assert.throws(() => recorder.readResultSucceeded("third-read", []), /already recorded/i);
  recorder.postcondition("matched");
  assert.throws(() => recorder.postcondition("mismatched"), /already recorded/i);
});

test("transaction audit validation rejects impossible operation histories", () => {
  const step = (
    sequence: number,
    operation: ReturnType<typeof completedStep>["operation"],
    overrides: Record<string, unknown> = {},
  ) => completedStep({
    sequence,
    operation,
    ...(operation === "create" || operation === "create-outcome-query"
      ? {}
      : {
          preRead: {
            outcome: "succeeded",
            requestId: `pre-read-${String(sequence)}`,
            snapshotDigest: "d".repeat(64),
          },
        }),
    ...overrides,
  });

  const unknownCreate = (sequence = 1) => step(sequence, "create", {
    mutation: { outcome: "unknown", requestId: "unknown-create" },
    postRead: { outcome: "failed", requestId: "failed-create-read", snapshotDigest: null },
    postcondition: "unavailable",
  });
  const recoveryQuery = (sequence: number, postcondition = "mismatched") =>
    step(sequence, "create-outcome-query", { phase: "recovery", mutation: null, postcondition });

  const impossible = [
    // a create audit must begin with create
    { ...emptyAudit(), finalState: "partial", steps: [step(1, "labels-add")] },
    // an update audit cannot create a merge request
    { ...emptyAudit(), operation: "update", finalState: "partial", steps: [step(1, "create")] },
    // create is unique and first
    { ...emptyAudit(), finalState: "partial", steps: [step(1, "create"), step(2, "create")] },
    // normal operation order cannot run backwards
    {
      ...emptyAudit(),
      finalState: "partial",
      steps: [step(1, "create"), step(2, "fields-write"), step(3, "labels-add")],
    },
    // normal operations cannot repeat
    {
      ...emptyAudit(),
      operation: "update",
      finalState: "partial",
      steps: [step(1, "fields-write"), step(2, "fields-write")],
    },
    // the recovery query cannot precede the unknown create it recovers
    {
      ...emptyAudit(),
      finalState: "partial",
      recoveredUnknownOutcome: true,
      steps: [recoveryQuery(1, "matched"), unknownCreate(2)],
    },
    // an unknown create must be recovered before any later normal step
    { ...emptyAudit(), finalState: "unknown", steps: [unknownCreate(), recoveryQuery(2), step(3, "fields-write")] },
    // the recovery query cannot repeat
    { ...emptyAudit(), finalState: "unknown", steps: [unknownCreate(), recoveryQuery(2), recoveryQuery(3)] },
    // a recovery query cannot follow a confirmed create
    { ...emptyAudit(), finalState: "partial", steps: [step(1, "create"), recoveryQuery(2)] },
    // an update audit has no create to recover
    { ...emptyAudit(), operation: "update", finalState: "unknown", steps: [recoveryQuery(1)] },
    // only create may mutate without a successful pre-read
    {
      ...emptyAudit(),
      operation: "update",
      finalState: "unknown",
      steps: [step(1, "labels-add", {
        preRead: { outcome: "failed", requestId: null, snapshotDigest: null },
        postRead: { outcome: "not-attempted", requestId: null, snapshotDigest: null },
        postcondition: "unavailable",
      })],
    },
    // unknown requires a possible remote write
    { ...emptyAudit(), finalState: "unknown", steps: [] },
    // not-started forbids any possible remote write
    { ...emptyAudit(), finalState: "not-started", steps: [step(1, "create")] },
  ];

  for (const [index, audit] of impossible.entries()) {
    assert.throws(() => validateTransactionAudit(audit), /transaction audit/i, `case ${String(index)}`);
  }
});

test("final states cannot claim proof without a matching successful step", () => {
  for (const finalState of ["partial", "complete", "unknown"] as const) {
    assert.throws(
      () => validateTransactionAudit({ ...emptyAudit(), finalState }),
      /final state/i,
    );
  }
  const descriptionWrite = (postcondition: "matched" | "mismatched") => completedStep({
    sequence: 2,
    operation: "description-write",
    preRead: { outcome: "succeeded", requestId: "pre-read-2", snapshotDigest: "d".repeat(64) },
    postcondition,
  });
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "complete",
      steps: [completedStep()],
    }),
    /final state/i,
  );
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "complete",
      steps: [completedStep(), descriptionWrite("mismatched")],
    }),
    /final state/i,
  );
  assert.throws(
    () => validateTransactionAudit({
      ...emptyAudit(),
      finalState: "partial",
      steps: [completedStep({
        postRead: { outcome: "failed", requestId: "failed-read", snapshotDigest: null },
        postcondition: "unavailable",
      })],
    }),
    /final state/i,
  );
  assert.doesNotThrow(() => validateTransactionAudit({
    ...emptyAudit(),
    finalState: "complete",
    steps: [completedStep(), descriptionWrite("matched")],
  }));
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
      finalState: "partial",
      steps: [unknownMatched],
    }),
    /recovered unknown/i,
  );
  assert.doesNotThrow(() => validateTransactionAudit({
    ...emptyAudit(),
    finalState: "partial",
    recoveredUnknownOutcome: true,
    steps: [unknownMatched],
  }));
  assert.doesNotThrow(() => validateTransactionAudit({
    ...emptyAudit(),
    finalState: "unknown",
    recoveredUnknownOutcome: true,
    steps: [
      completedStep({
        operation: "create",
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
  const recorder = journal.start("normal", "create", null);
  const before = journal.snapshot();

  recorder.mutation("confirmed", "create-request");
  recorder.readSucceeded("create-read", snapshotState());
  recorder.postcondition("matched");
  journal.setFinalState("partial");
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

test("partial failure receipts use an exact token-free identity and retry contract", () => {
  const unavailable = validateTransactionFailureReceipt({
    receiptVersion: 1,
    iid: null,
    iidUnavailable: true,
    webUrl: null,
    webUrlUnavailable: true,
    completedSteps: [],
    failedOperation: "create-outcome-query",
    failedField: "mergeRequest.createOutcome",
    retryCommand: "harness-mrtool context --output json",
  });
  assert.equal(Object.isFrozen(unavailable), true);
  assert.equal(unavailable.iid, null);

  const valid = {
    receiptVersion: 1,
    iid: 88,
    iidUnavailable: false,
    webUrl: "https://gitlab.example.test/project/-/merge_requests/88",
    webUrlUnavailable: false,
    completedSteps: ["create", "labels-add"],
    failedOperation: "fields-write",
    failedField: "mergeRequest.fields",
    retryCommand: "harness-mrtool update 88 --input - --non-interactive --output json",
  };
  assert.doesNotThrow(() => validateTransactionFailureReceipt(valid));
  const httpReceipt = validateTransactionFailureReceipt({
    ...valid,
    webUrl: "http://gitlab.example.test:8080/project/-/merge_requests/88",
  });
  assert.equal(httpReceipt.webUrl, "http://gitlab.example.test:8080/project/-/merge_requests/88");
  for (const malformed of [
    { ...valid, extra: true },
    { ...valid, iidUnavailable: true },
    { ...valid, webUrl: null },
    { ...valid, webUrl: "ftp://gitlab.example.test/project/-/merge_requests/88" },
    { ...valid, webUrl: "http://gitlab.example.test/project/-/merge_requests/88\n" },
    { ...valid, retryCommand: "harness-mrtool update 89 --input - --non-interactive --output json" },
    { ...valid, failedField: `mergeRequest.${"hmrc1_"}${"a".repeat(43)}` },
    { ...valid, completedSteps: ["create", "create"] },
    { ...valid, failedOperation: "mark-ready" },
    { ...valid, failedOperation: "ready-gate" },
  ]) {
    assert.throws(() => validateTransactionFailureReceipt(malformed), /failure receipt/i);
  }
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

test("remote mutation failures expose only closed outcomes and safe audit fields", () => {
  const rejected = new RemoteMutationError("rejected", "validation", "safe-request");
  const unknown = new RemoteMutationError("unknown", "timeout", `hmrc1_${"A".repeat(43)}`);

  assert.equal(isRemoteMutationError(rejected, "rejected"), true);
  assert.equal(isRemoteMutationError(unknown, "unknown"), true);
  assert.deepEqual(
    { outcome: rejected.outcome, reason: rejected.reason, requestId: rejected.requestId },
    { outcome: "rejected", reason: "validation", requestId: "safe-request" },
  );
  assert.equal(unknown.requestId, null);
  assert.equal(JSON.stringify(rejected).includes("response"), false);
  assert.throws(
    () => new RemoteMutationError("maybe" as never, "network", null),
    /outcome/i,
  );
  assert.throws(
    () => new RemoteMutationError("rejected", "maybe" as never, null),
    /reason/i,
  );
  assert.throws(
    () => new RemoteMutationError("unknown", "auth", null),
    /outcome.*reason|reason.*outcome/i,
  );
});

test("remote read failures retain only a safe request ID and map to stable ToolErrors", () => {
  const authentication = new RemoteReadError("auth", "auth-request");
  const timeout = new RemoteReadError("timeout", `glpat-${"x".repeat(24)}`);

  assert.equal(isRemoteReadError(authentication), true);
  assert.equal(isRemoteReadError({ reason: "auth" }), false);
  assert.equal(authentication.requestId, "auth-request");
  assert.equal(timeout.requestId, null);
  assert.equal(remoteFailureToolError(authentication).code, "AUTH_ERROR");
  assert.equal(remoteFailureToolError(timeout).code, "GITLAB_ERROR");
  assert.equal(
    remoteFailureToolError(new RemoteMutationError("rejected", "conflict", "conflict-request")).code,
    "CONCURRENT_UPDATE",
  );
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
    { ...snapshot, mergeRequest: { ...snapshot.mergeRequest, lifecycle: "closed" } },
    { ...snapshot, localChecks: { ...snapshot.localChecks, secretScan: { status: "failed", evidence: "failed" } } },
    { ...snapshot, metadataRead: { status: "unavailable", evidence: "offline" } },
    { ...snapshot, ci: { status: "running" } },
    { ...snapshot, review: { ...snapshot.review, unresolvedDiscussions: 1 } },
  ];
  for (const variant of variants) {
    assert.notEqual(candidateSelectionDigest(request, candidates, variant), digest);
  }
});

test("the transaction concurrency digest ignores naturally changing live context", () => {
  const current = snapshotState() as unknown as { snapshot: ExternalContextSnapshot };
  current.snapshot = externalContextSnapshot();
  const changed = structuredClone(current);
  if (changed.snapshot.issue.kind !== "linked" || changed.snapshot.issue.readStatus !== "available") {
    throw new Error("Test fixture must use an available linked issue");
  }
  changed.snapshot = {
    ...changed.snapshot,
    issue: {
      ...changed.snapshot.issue,
      milestone: "A later milestone",
      dueDate: "2026-09-01",
    },
    ci: { status: "running" },
    review: {
      ...changed.snapshot.review,
      approvedByUserIds: [],
      unresolvedDiscussions: 3,
    },
  };

  assert.equal(remoteSnapshotDigest(changed as never), remoteSnapshotDigest(current as never));
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
