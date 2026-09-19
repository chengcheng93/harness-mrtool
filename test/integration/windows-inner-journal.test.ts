import assert from "node:assert/strict";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { openNativeMutationExecutor } from "../../src/platform/native-mutation-executor.ts";
import { observeWindowsInnerJournal } from "../../src/update/windows-inner-journal.ts";
import { admitWindowsMutationPlan } from "../../src/update/windows-mutation-authority.ts";

const native = { skip: !(process.platform === "darwin" || (process.platform === "win32" && process.arch === "x64")) };

const plan = Object.freeze({
  schemaVersion: 1 as const,
  operation: "apply" as const,
  installationId: "a".repeat(32),
  enrollmentId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  journalRevision: 7,
  authorityEpoch: 8,
  previous: Object.freeze({ executableSha256: "e".repeat(64), executableSize: 101, markerSha256: "f".repeat(64), markerSize: 201 }),
  next: Object.freeze({ executableSha256: "1".repeat(64), executableSize: 102, markerSha256: "2".repeat(64), markerSize: 202 }),
});

test("observes the fixed Windows inner journal only after exact canonical plan verification", native, async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-inner-journal-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());
  await admitWindowsMutationPlan(executor, plan);
  const observed = await observeWindowsInnerJournal(root, plan);
  assert.deepEqual(observed.plan, plan);
  assert.equal(observed.size, observed.bytes.length);
  assert.match(observed.sha256, /^[0-9a-f]{64}$/u);
  await executor.close();
});

test("inner journal observation rejects a link or mismatched plan", native, async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-inner-journal-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  await symlink(resolve(root, "outside"), resolve(root, "installation-transaction.json"));
  await assert.rejects(observeWindowsInnerJournal(root, plan), { code: "UPDATE_SECURITY_ERROR" });
  await rm(resolve(root, "installation-transaction.json"), { force: true });
  await writeFile(resolve(root, "installation-transaction.json"), Buffer.from("{}\n"));
  await assert.rejects(observeWindowsInnerJournal(root, plan), { code: "UPDATE_SECURITY_ERROR" });
});
