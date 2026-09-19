import assert from "node:assert/strict";
import test from "node:test";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { validateInstallationJournal } from "../../src/update/installation-journal.ts";
import {
  createWindowsLaunchReservationInput,
  createWindowsMutationPlan,
  createWindowsPersistenceDescriptor,
  WINDOWS_LAUNCH_DESCRIPTOR_FILENAME,
  observeWindowsPersistenceDescriptor,
  writeWindowsPersistenceDescriptor,
} from "../../src/update/windows-persistence-handoff.ts";
import { decodeWindowsPersistenceDescriptor } from "../../src/update/windows-persistence-descriptor.ts";
import { journalFixture } from "../helpers/installation-journal-fixture.ts";

const parent = Object.freeze({
  pid: 1234,
  startKey: "win:134000000000000000",
  launchNonce: "a".repeat(32),
});

test("Windows persistence handoff factories bind plan and descriptor to a prepared journal", () => {
  const fixture = journalFixture("windows-x64", "prepared");
  const journal = validateInstallationJournal(fixture);
  const plan = createWindowsMutationPlan(journal);
  assert.equal(plan.journalRevision, journal.revision);
  assert.equal(plan.authorityEpoch, journal.control.authorityEpoch + 1);
  assert.equal(plan.transactionId, journal.transactionId);

  const draft = createWindowsPersistenceDescriptor(journal, parent);
  assert.equal(WINDOWS_LAUNCH_DESCRIPTOR_FILENAME, ".harness-mrtool-launch.json");
  assert.deepEqual(decodeWindowsPersistenceDescriptor(draft.bytes), draft.descriptor);
  const reservation = createWindowsLaunchReservationInput(journal, parent, draft, { dev: "2", ino: "501" });
  assert.equal(reservation.launchId, draft.launchId);
  assert.equal(reservation.descriptor.size, draft.bytes.byteLength);
  assert.equal(reservation.descriptor.sha256.length, 64);
});

test("Windows persistence handoff factories reject an unprepared or mismatched journal", () => {
  const fixture = journalFixture("darwin-arm64", "prepared");
  assert.throws(() => createWindowsMutationPlan(fixture), { code: "UPDATE_SECURITY_ERROR" });

  const windows = journalFixture("windows-x64", "prepared");
  windows.windows!.inner = null;
  windows.slots = windows.slots.filter((slot) => slot.name !== "windows-inner-journal");
  assert.throws(() => createWindowsPersistenceDescriptor(windows, parent), { code: "UPDATE_SECURITY_ERROR" });
});


test("Windows persistence descriptor is exclusively written and identity-observed", async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-persistence-descriptor-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const journal = validateInstallationJournal(journalFixture("windows-x64", "prepared"));
  const draft = createWindowsPersistenceDescriptor(journal, parent);
  await writeWindowsPersistenceDescriptor(root, draft);
  const observed = await observeWindowsPersistenceDescriptor(root);
  const stat = await lstat(resolve(root, WINDOWS_LAUNCH_DESCRIPTOR_FILENAME), { bigint: true });
  assert.deepEqual(observed.bytes, draft.bytes);
  assert.equal(observed.sha256, draft.bytes.length > 0 ? observed.sha256 : "");
  assert.equal(observed.size, draft.bytes.byteLength);
  assert.equal(observed.identity.dev, String(stat.dev));
  assert.equal(observed.identity.ino, String(stat.ino));
  await assert.rejects(writeWindowsPersistenceDescriptor(root, draft), { code: "UPDATE_SECURITY_ERROR" });
});
