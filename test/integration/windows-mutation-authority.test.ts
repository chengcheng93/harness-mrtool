import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { openNativeMutationExecutor } from "../../src/platform/native-mutation-executor.ts";
import { admitWindowsMutationPlan } from "../../src/update/windows-mutation-authority.ts";
import { decodeWindowsMutationPlan } from "../../src/update/windows-mutation-plan.ts";

const native = { skip: !(process.platform === "darwin" || (process.platform === "win32" && process.arch === "x64")) };

const plan = Object.freeze({
  schemaVersion: 1 as const,
  operation: "rollback" as const,
  installationId: "a".repeat(32),
  enrollmentId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  journalRevision: 7,
  authorityEpoch: 8,
  previous: Object.freeze({ executableSha256: "e".repeat(64), executableSize: 101, markerSha256: "f".repeat(64), markerSize: 201 }),
  next: Object.freeze({ executableSha256: "1".repeat(64), executableSize: 102, markerSha256: "2".repeat(64), markerSize: 202 }),
});

test("native fixed transaction slot contains the exact admitted Windows mutation plan", native, async (t) => {
  const root = await mkdtemp(resolve(await realpath(tmpdir()), "windows-mutation-authority-"));
  await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const executor = await openNativeMutationExecutor(root);
  t.after(() => executor.close());
  const admitted = await admitWindowsMutationPlan(executor, plan);
  assert.deepEqual(decodeWindowsMutationPlan(await readFile(resolve(root, "installation-transaction.json"))), plan);
  assert.equal(admitted.receipt.bytesSha256, createHashSha256(admitted.bytes));
  await executor.close();
});

function createHashSha256(bytes: Uint8Array): string {
  // Keep this test-side helper independent from the authority implementation.
  return createHash("sha256").update(bytes).digest("hex");
}
