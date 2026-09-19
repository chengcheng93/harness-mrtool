import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceInstallationJournal,
  type InstallationJournalTransition,
} from "../../src/update/installation-journal-transition.ts";
import { journalFixture, withLaunch } from "../helpers/installation-journal-fixture.ts";

type MutableJournal = {
  -readonly [K in keyof InstallationJournalTransition]: InstallationJournalTransition[K]
};

function candidate(phase: InstallationJournalTransition["phase"]): InstallationJournalTransition {
  const journal = journalFixture("darwin-arm64", "prepared");
  journal.phase = phase;
  journal.revision += 1;
  return journal;
}

test("advances only a contiguous legal journal transition", () => {
  const current = journalFixture("darwin-arm64", "prepared");
  const next = candidate("publish-intent");
  const advanced = advanceInstallationJournal(current, next);
  assert.equal(advanced.revision, current.revision + 1);
  assert.equal(advanced.phase, "publish-intent");
  assert.equal(advanced.attemptId, current.attemptId);
});

test("rejects gaps, foreign transactions, and illegal phase changes", () => {
  const current = journalFixture("darwin-arm64", "prepared");
  for (const mutate of [
    (next: MutableJournal) => { next.revision += 2; },
    (next: MutableJournal) => { next.attemptId = "f".repeat(32); },
    (next: MutableJournal) => { next.phase = "committed"; next.outcome = "next"; },
  ]) {
    const next = candidate("publish-intent");
    mutate(next as unknown as MutableJournal);
    assert.throws(() => advanceInstallationJournal(current, next), { code: "UPDATE_SECURITY_ERROR" });
  }
});

test("does not mutate either caller journal", () => {
  const current = journalFixture("darwin-arm64", "prepared");
  const next = candidate("publish-intent");
  const before = structuredClone(current);
  const result = advanceInstallationJournal(current, next);
  assert.deepEqual(current, before);
  assert.notEqual(result, next);
});

test("integrates the Windows launch lifecycle guard into journal transitions", () => {
  const current = journalFixture("windows-x64", "prepared");
  withLaunch(current, "reserved");
  const next = structuredClone(current) as MutableDeep<InstallationJournalTransition>;
  next.revision += 1;
  next.control.authorityEpoch += 1;
  next.windows!.launch!.authorityEpoch += 1;
  next.windows!.launch!.expectedRevision += 1;
  next.windows!.launch!.state = "registered";
  next.windows!.launch!.child = { pid: 201, startKey: "win:134000000000000001", launchNonce: "1".repeat(32) };
  assert.equal(advanceInstallationJournal(current, next).windows!.launch!.state, "registered");

  const bypass = structuredClone(current) as MutableDeep<InstallationJournalTransition>;
  bypass.revision += 1;
  bypass.control.authorityEpoch += 1;
  bypass.windows!.launch!.authorityEpoch += 1;
  bypass.windows!.launch!.expectedRevision += 1;
  bypass.windows!.launch!.state = "admitted";
  bypass.windows!.launch!.child = { pid: 201, startKey: "win:134000000000000001", launchNonce: "1".repeat(32) };
  bypass.windows!.launch!.grantSha256 = "2".repeat(64);
  assert.throws(() => advanceInstallationJournal(current, bypass), { code: "UPDATE_SECURITY_ERROR" });
});


type MutableDeep<T> = T extends readonly (infer V)[] ? MutableDeep<V>[] :
  T extends object ? { -readonly [K in keyof T]: MutableDeep<T[K]> } : T;
