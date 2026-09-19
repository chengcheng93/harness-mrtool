import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openNativeMutationExecutor } from "../../src/platform/native-mutation-executor.ts";
import { coordinateWindowsInnerJournal } from "../../src/update/windows-installation-coordinator.ts";
import { validateInstallationJournal } from "../../src/update/installation-journal.ts";
import { digest, journalFixture } from "../helpers/installation-journal-fixture.ts";

const native = { skip: !(process.platform === "darwin" || (process.platform === "win32" && process.arch === "x64")) };

function preparedWithoutInner() {
  const fixture = journalFixture("windows-x64", "prepared");
  fixture.windows!.inner = null;
  fixture.slots = fixture.slots.filter((slot) => slot.name !== "windows-inner-journal");
  return validateInstallationJournal(fixture);
}

async function preparedWithoutInnerAt(root: string) {
  const fixture = journalFixture("windows-x64", "prepared");
  fixture.windows!.inner = null;
  fixture.slots = fixture.slots.filter((slot) => slot.name !== "windows-inner-journal");
  const identity = await lstat(root, { bigint: true });
  fixture.roots.installation = { dev: String(identity.dev), ino: String(identity.ino) };
  fixture.roots.state = { dev: String(identity.dev), ino: String(identity.ino + 1n) };
  return validateInstallationJournal(fixture);
}

function planFor(journal: ReturnType<typeof preparedWithoutInner>) {
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: journal.operation,
    installationId: journal.installationId,
    enrollmentId: journal.enrollmentId,
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    journalRevision: journal.revision,
    authorityEpoch: journal.control.authorityEpoch + 1,
    previous: Object.freeze({
      executableSha256: journal.previousEvidence.native.sha256,
      executableSize: journal.previousEvidence.native.size,
      markerSha256: journal.previousEvidence.marker.sha256,
      markerSize: journal.previousEvidence.marker.size,
    }),
    next: Object.freeze({
      executableSha256: journal.nextEvidence.native.sha256,
      executableSize: journal.nextEvidence.native.size,
      markerSha256: journal.nextEvidence.marker.sha256,
      markerSize: journal.nextEvidence.marker.size,
    }),
  });
}

test("coordinates native fixed-slot admission into one outer Windows inner-journal binding", native, async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-installation-coordinator-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());

  const current = await preparedWithoutInnerAt(root);
  const plan = planFor(current);
  const result = await coordinateWindowsInnerJournal({
    current,
    installationDirectory: root,
    executor,
    plan,
  });

  assert.deepEqual(result.observation.plan, plan);
  assert.equal(result.observation.sha256, digest(result.observation.bytes));
  assert.equal(result.journal.windows?.inner?.sha256, result.observation.sha256);
  assert.equal(result.journal.slots.some((slot) => slot.name === "windows-inner-journal"), true);
  assert.equal(result.journal.control.operations.length, current.control.operations.length + 1);
  assert.equal(result.receipt.bytesSha256, digest(result.observation.bytes));
  await executor.close();
});

test("rejects a plan drift before invoking native mutation authority", async () => {
  const current = preparedWithoutInner();
  const plan = { ...planFor(current), next: { ...planFor(current).next, executableSize: 999 } };
  let reserved = false;
  const executor = {
    epoch: { attemptId: "a".repeat(32) },
    async reserve() { reserved = true; },
    async admit() { throw new Error("must not admit"); },
    async revoke() {},
    async close() {},
  };
  await assert.rejects(coordinateWindowsInnerJournal({
    current,
    installationDirectory: "/private/var/tmp/not-used",
    executor,
    plan,
  }), { code: "UPDATE_SECURITY_ERROR" });
  assert.equal(reserved, false);
});

test("rejects an invalid installation root before native admission", async () => {
  const current = preparedWithoutInner();
  const plan = planFor(current);
  let reserved = false;
  const executor = {
    epoch: { attemptId: "a".repeat(32) },
    async reserve() { reserved = true; },
    async admit() { throw new Error("must not admit"); },
    async revoke() {},
    async close() {},
  };
  const missing = resolve("/private/var/tmp", `windows-coordinator-missing-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await assert.rejects(coordinateWindowsInnerJournal({
    current,
    installationDirectory: missing,
    executor,
    plan,
  }), { code: "UPDATE_SECURITY_ERROR" });
  assert.equal(reserved, false);
});

test("rejects a native root whose identity is not bound to the outer journal", async () => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-coordinator-root-mismatch-"));
  await chmod(root, 0o700);
  try {
    const current = preparedWithoutInner();
    const plan = planFor(current);
    let reserved = false;
    const executor = {
      epoch: { attemptId: "a".repeat(32) },
      async reserve() { reserved = true; },
      async admit() { throw new Error("must not admit"); },
      async revoke() {},
      async close() {},
    };
    await assert.rejects(coordinateWindowsInnerJournal({
      current,
      installationDirectory: root,
      executor,
      plan,
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(reserved, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
