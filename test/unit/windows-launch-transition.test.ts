import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceWindowsLaunchEvidence,
  type WindowsLaunchTransition,
} from "../../src/update/windows-launch-transition.ts";
import { journalFixture, sealSettlement, withLaunch } from "../helpers/installation-journal-fixture.ts";
import { validateInstallationJournal } from "../../src/update/installation-journal.ts";

function launch(state: WindowsLaunchTransition["from"]["state"]): WindowsLaunchTransition["from"] {
  const journal = withLaunch(journalFixture("windows-x64", "prepared"), state);
  return validateInstallationJournal(journal).windows!.launch!;
}

type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] :
  T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;

function copy(value: WindowsLaunchTransition["from"]): Mutable<WindowsLaunchTransition["to"]> {
  return structuredClone(value) as Mutable<WindowsLaunchTransition["to"]>;
}

test("Windows launch transition allows one-way gated admission and completion", () => {
  const from = launch("reserved");
  const registered = copy(from);
  registered.state = "registered";
  registered.child = { pid: 201, startKey: "win:134000000000000001", launchNonce: "1".repeat(32) };
  registered.authorityEpoch += 1;
  registered.expectedRevision += 1;
  const claimed = copy(registered);
  claimed.state = "claimed";
  claimed.authorityEpoch += 1;
  claimed.expectedRevision += 1;
  const ack = copy(claimed);
  ack.state = "ack-issued";
  ack.grantSha256 = "2".repeat(64);
  ack.authorityEpoch += 1;
  ack.expectedRevision += 1;
  const admitted = copy(ack);
  admitted.state = "admitted";
  admitted.authorityEpoch += 1;
  admitted.expectedRevision += 1;
  const completed = copy(admitted);
  completed.state = "completed";
  completed.exitCode = 0;
  completed.authorityEpoch += 1;
  completed.expectedRevision += 1;

  assert.equal(advanceWindowsLaunchEvidence(from, registered).state, "registered");
  assert.equal(advanceWindowsLaunchEvidence(registered, claimed).state, "claimed");
  assert.equal(advanceWindowsLaunchEvidence(claimed, ack).state, "ack-issued");
  assert.equal(advanceWindowsLaunchEvidence(ack, admitted).state, "admitted");
  assert.equal(advanceWindowsLaunchEvidence(admitted, completed).state, "completed");
});

test("Windows launch transition rejects bypass, replay, binding drift, and premature settlement", () => {
  const from = launch("reserved");
  const bypass = copy(from);
  bypass.state = "admitted";
  bypass.child = { pid: 201, startKey: "win:134000000000000001", launchNonce: "1".repeat(32) };
  bypass.grantSha256 = "2".repeat(64);
  bypass.authorityEpoch += 1;
  bypass.expectedRevision += 1;
  assert.throws(() => advanceWindowsLaunchEvidence(from, bypass), /windows launch transition is unsafe/u);

  const replay = copy(from);
  assert.throws(() => advanceWindowsLaunchEvidence(from, replay), /windows launch transition is unsafe/u);

  const drift = copy(from);
  drift.transactionId = "release-" + "f".repeat(32);
  drift.authorityEpoch += 1;
  drift.expectedRevision += 1;
  assert.throws(() => advanceWindowsLaunchEvidence(from, drift), /windows launch transition is unsafe/u);

  const settled = copy(from);
  settled.settlement = sealSettlement({
    state: "settled",
    launchId: settled.launchId,
    reservationId: settled.reservationId,
    descriptorSha256: settled.descriptorSha256,
    targetIdentity: settled.targetIdentity,
    parent: settled.parent,
    child: null,
    receiptSha256: "",
  });
  settled.authorityEpoch += 1;
  settled.expectedRevision += 1;
  assert.throws(() => advanceWindowsLaunchEvidence(from, settled), /windows launch transition is unsafe/u);
});

test("Windows launch transition permits only final settlement after outcome is durable", () => {
  const completed = launch("completed");
  const unsettled = structuredClone(completed) as Mutable<WindowsLaunchTransition["to"]>;
  unsettled.settlement = { state: "unsettled" };
  const settled = structuredClone(completed) as Mutable<WindowsLaunchTransition["to"]>;
  settled.authorityEpoch += 1;
  settled.expectedRevision += 1;
  assert.equal(advanceWindowsLaunchEvidence(unsettled, settled).settlement.state, "settled");

  const changed = structuredClone(settled) as Mutable<WindowsLaunchTransition["to"]>;
  changed.exitCode = 1;
  changed.authorityEpoch += 1;
  changed.expectedRevision += 1;
  assert.throws(() => advanceWindowsLaunchEvidence(settled, changed), /windows launch transition is unsafe/u);
});
