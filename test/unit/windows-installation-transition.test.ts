import assert from "node:assert/strict";
import test from "node:test";

import {
  attachWindowsInnerJournal,
  reserveWindowsLaunch,
  advanceWindowsLaunchInJournal,
  markWindowsExecutionPending,
} from "../../src/update/windows-installation-transition.ts";
import { validateInstallationJournal } from "../../src/update/installation-journal.ts";
import { encodeWindowsPersistenceDescriptor } from "../../src/update/windows-persistence-descriptor.ts";
import { journalFixture, randomId, digest, withLaunch } from "../helpers/installation-journal-fixture.ts";

function preparedWithoutInner() {
  const fixture = journalFixture("windows-x64", "prepared");
  fixture.windows!.inner = null;
  fixture.slots = fixture.slots.filter((slot) => slot.name !== "windows-inner-journal");
  return validateInstallationJournal(fixture);
}

function planFor(journal: ReturnType<typeof preparedWithoutInner>) {
  return {
    schemaVersion: 1 as const,
    operation: journal.operation,
    installationId: journal.installationId,
    enrollmentId: journal.enrollmentId,
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    journalRevision: journal.revision,
    authorityEpoch: journal.control.authorityEpoch + 1,
    previous: {
      executableSha256: journal.previousEvidence.native.sha256,
      executableSize: journal.previousEvidence.native.size,
      markerSha256: journal.previousEvidence.marker.sha256,
      markerSize: journal.previousEvidence.marker.size,
    },
    next: {
      executableSha256: journal.nextEvidence.native.sha256,
      executableSize: journal.nextEvidence.native.size,
      markerSha256: journal.nextEvidence.marker.sha256,
      markerSize: journal.nextEvidence.marker.size,
    },
  } as const;
}

test("attaching an observed Windows inner journal creates one identity-bound slot", () => {
  const journal = preparedWithoutInner();
  const plan = planFor(journal);
  const next = attachWindowsInnerJournal(journal, plan, {
    identity: { dev: "2", ino: "105" },
    sha256: digest("inner"),
    size: 512,
  });
  assert.equal(next.revision, journal.revision + 1);
  assert.equal(next.windows?.inner?.sha256, digest("inner"));
  assert.equal(next.slots.filter((slot) => slot.name === "windows-inner-journal").length, 1);
  assert.equal(next.control.operations.length, journal.control.operations.length + 1);
  assert.equal(next.control.operations.at(-1)?.authorityEpoch, journal.control.authorityEpoch + 1);
  assert.deepEqual(next.control.operations.at(-1)?.admittedSlots, ["windows-inner-journal", "installation-journal"]);
});

test("Windows inner attachment rejects a plan that drifts from the outer journal", () => {
  const journal = preparedWithoutInner();
  const plan = { ...planFor(journal), next: { ...planFor(journal).next, executableSize: 999 } };
  assert.throws(() => attachWindowsInnerJournal(journal, plan, {
    identity: { dev: "2", ino: "105" }, sha256: digest("inner"), size: 512,
  }), /windows installation transition is unsafe/u);
});

test("reserving a Windows launch records an unsettled reserved lifecycle and descriptor slot", () => {
  const journal = preparedWithoutInner();
  const withInner = attachWindowsInnerJournal(journal, planFor(journal), {
    identity: { dev: "2", ino: "105" }, sha256: digest("inner"), size: 512,
  });
  const launchId = randomId(20);
  const reservationId = randomId(21);
  const parent = { pid: 200, startKey: "win:134000000000000000", launchNonce: randomId(22) };
  const bytes = encodeWindowsPersistenceDescriptor({
    schemaVersion: 1, launchId, reservationId, attemptId: withInner.attemptId,
    transactionId: withInner.transactionId, expectedRevision: withInner.revision + 1, parent,
  });
  const next = reserveWindowsLaunch(withInner, {
    launchId,
    reservationId,
    descriptor: { identity: { dev: "3", ino: "205" }, sha256: digest(bytes), size: bytes.length, bytes },
    parent,
  });
  assert.equal(next.windows?.launch?.state, "reserved");
  assert.equal(next.windows?.launch?.settlement.state, "unsettled");
  assert.equal(next.slots.some((slot) => slot.name === "launch-descriptor" && slot.state === "created"), true);
  assert.equal(next.control.operations.length, withInner.control.operations.length + 1);
  assert.equal(next.control.operations.at(-1)?.authorityEpoch, withInner.control.authorityEpoch + 1);
  assert.deepEqual(next.control.operations.at(-1)?.admittedSlots, ["launch-descriptor", "installation-journal"]);
});


test("outer journal advances one Windows launch lifecycle step with a new control receipt", () => {
  const journal = validateInstallationJournal(withLaunch(journalFixture("windows-x64", "prepared"), "reserved"));
  const current = journal.windows!.launch!;
  const next = {
    ...current,
    authorityEpoch: current.authorityEpoch + 1,
    expectedRevision: current.expectedRevision + 1,
    state: "registered" as const,
    child: { pid: 201, startKey: "win:134000000000000001", launchNonce: randomId(91) },
  };
  const advanced = advanceWindowsLaunchInJournal(journal, next);
  assert.equal(advanced.windows?.launch?.state, "registered");
  assert.equal(advanced.revision, journal.revision + 1);
  assert.equal(advanced.control.operations.length, journal.control.operations.length + 1);
});

test("admitted Windows launch can enter execution-pending only through a durable journal step", () => {
  const journal = validateInstallationJournal(withLaunch(journalFixture("windows-x64", "prepared"), "admitted"));
  const pending = markWindowsExecutionPending(journal);
  assert.equal(pending.phase, "execution-pending");
  assert.equal(pending.windows?.launch?.state, "admitted");
  assert.equal(pending.windows?.launch?.settlement.state, "unsettled");
  assert.equal(pending.control.operations.length, journal.control.operations.length + 1);
});


test("Windows launch reservation rejects descriptor bytes whose digest or binding drifts", () => {
  const journal = preparedWithoutInner();
  const withInner = attachWindowsInnerJournal(journal, planFor(journal), {
    identity: { dev: "2", ino: "105" }, sha256: digest("inner"), size: 512,
  });
  const launchId = randomId(23);
  const reservationId = randomId(24);
  const parent = { pid: 200, startKey: "win:134000000000000000", launchNonce: randomId(25) };
  const bytes = encodeWindowsPersistenceDescriptor({
    schemaVersion: 1, launchId, reservationId, attemptId: withInner.attemptId,
    transactionId: withInner.transactionId, expectedRevision: withInner.revision + 1, parent,
  });
  assert.throws(() => reserveWindowsLaunch(withInner, {
    launchId, reservationId, parent,
    descriptor: { identity: { dev: "3", ino: "205" }, sha256: digest("wrong"), size: bytes.length, bytes },
  }), /windows installation transition is unsafe/u);
});
