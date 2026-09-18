import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceInstallationJournal,
  type InstallationJournalTransition,
} from "../../src/update/installation-journal-transition.ts";
import { journalFixture } from "../helpers/installation-journal-fixture.ts";

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
