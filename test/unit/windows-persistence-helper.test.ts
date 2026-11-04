import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyWindowsPersistenceRecovery,
} from "../../src/update/windows-persistence-helper.ts";
import { advanceInstallationJournalPhase, sealInstallationSettlement } from "../../src/update/installation-journal-coordination.ts";
import { validateInstallationJournal } from "../../src/update/installation-journal.ts";
import { advanceWindowsLaunchInJournal } from "../../src/update/windows-installation-transition.ts";
import { journalFixture, withLaunch, type JournalFixture } from "../helpers/installation-journal-fixture.ts";

function completedExecutionPending(): JournalFixture {
  const journal = withLaunch(journalFixture("windows-x64", "execution-pending"), "admitted");
  const launch = journal.windows?.launch;
  if (launch === null || launch === undefined || launch.child === null) throw new Error("missing launch fixture");
  const completed = {
    ...launch,
    authorityEpoch: journal.control.authorityEpoch + 1,
    expectedRevision: journal.revision + 1,
    state: "completed" as const,
    exitCode: 0,
    settlement: sealInstallationSettlement({
      state: "settled",
      launchId: launch.launchId,
      reservationId: launch.reservationId,
      descriptorSha256: launch.descriptorSha256,
      targetIdentity: launch.targetIdentity,
      parent: launch.parent,
      child: launch.child,
    }),
  };
  return advanceWindowsLaunchInJournal(journal, completed) as JournalFixture;
}

test("Windows persistence recovery classifies every resumable durable phase", () => {
  const pending = validateInstallationJournal(withLaunch(journalFixture("windows-x64", "execution-pending"), "admitted"));
  assert.equal(classifyWindowsPersistenceRecovery(pending), "settle-admitted");
  assert.throws(
    () => advanceInstallationJournalPhase(pending, "publish-intent", null),
    /installation journal transition is unsafe/u,
  );

  const completed = completedExecutionPending();
  assert.equal(classifyWindowsPersistenceRecovery(completed), "resume-publication");
  const publishIntent = advanceInstallationJournalPhase(completed, "publish-intent", null);
  assert.equal(publishIntent.windows?.launch?.expectedRevision, publishIntent.revision);
  assert.equal(classifyWindowsPersistenceRecovery(publishIntent), "resume-publication");
  const canonicalPublished = advanceInstallationJournalPhase(publishIntent, "canonical-published", null);
  assert.equal(classifyWindowsPersistenceRecovery(canonicalPublished), "resume-publication");
  const markerPublished = advanceInstallationJournalPhase(canonicalPublished, "marker-published", null);
  assert.equal(classifyWindowsPersistenceRecovery(markerPublished), "resume-publication");
  const commitIntent = advanceInstallationJournalPhase(markerPublished, "commit-intent", null);
  assert.equal(classifyWindowsPersistenceRecovery(commitIntent), "resume-commit");
  const committed = advanceInstallationJournalPhase(commitIntent, "committed", "next");
  assert.equal(classifyWindowsPersistenceRecovery(committed), "cleanup-committed");
});

test("Windows persistence recovery rejects an unadmitted or non-Windows handoff", () => {
  const reserved = validateInstallationJournal(withLaunch(journalFixture("windows-x64", "prepared"), "reserved"));
  assert.throws(() => classifyWindowsPersistenceRecovery(reserved), /windows persistence recovery is unsafe/u);
  assert.throws(() => classifyWindowsPersistenceRecovery(journalFixture("darwin-arm64", "prepared")), /windows persistence recovery is unsafe/u);
});
