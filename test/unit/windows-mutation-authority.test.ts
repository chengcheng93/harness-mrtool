import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  admitWindowsMutationPlan,
} from "../../src/update/windows-mutation-authority.ts";
import type { NativeMutationExecutor } from "../../src/platform/native-mutation-executor.ts";
import type { WindowsMutationPlan } from "../../src/update/windows-mutation-plan.ts";

const plan: WindowsMutationPlan = Object.freeze({
  schemaVersion: 1,
  operation: "apply",
  installationId: "a".repeat(32),
  enrollmentId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  journalRevision: 7,
  authorityEpoch: 8,
  previous: Object.freeze({ executableSha256: "e".repeat(64), executableSize: 101, markerSha256: "f".repeat(64), markerSize: 201 }),
  next: Object.freeze({ executableSha256: "1".repeat(64), executableSize: 102, markerSha256: "2".repeat(64), markerSize: 202 }),
});

function executorFor(calls: string[]): NativeMutationExecutor {
  const epoch = Object.freeze({ attemptId: "9".repeat(36) });
  return {
    epoch,
    async reserve(mutation) { calls.push(`reserve:${mutation.operationId}:${mutation.bytes.length}`); },
    async admit(mutation) {
      calls.push(`admit:${mutation.operationId}`);
      return Object.freeze({
        slot: "transaction" as const,
        operationId: mutation.operationId,
        epochId: epoch.attemptId,
        operationSequence: 1,
        bytesSha256: createHash("sha256").update(mutation.bytes).digest("hex"),
      });
    },
    async revoke(mutation) { calls.push(`revoke:${mutation.operationId}`); },
    async close() { calls.push("close"); },
  };
}

test("Windows mutation authority admits one canonical plan through the fixed transaction slot", async () => {
  const calls: string[] = [];
  const admitted = await admitWindowsMutationPlan(executorFor(calls), plan);
  assert.equal(admitted.receipt.operationId.length, 36);
  assert.equal(admitted.receipt.bytesSha256, createHash("sha256").update(admitted.bytes).digest("hex"));
  assert.deepEqual(calls, [`reserve:${admitted.receipt.operationId}:${admitted.bytes.length}`, `admit:${admitted.receipt.operationId}`]);
});

test("Windows mutation authority revokes a reservation when admission fails", async () => {
  const calls: string[] = [];
  const epoch = Object.freeze({ attemptId: "9".repeat(36) });
  const executor: NativeMutationExecutor = {
    epoch,
    async reserve() { calls.push("reserve"); },
    async admit() { calls.push("admit"); throw new Error("refused"); },
    async revoke() { calls.push("revoke"); },
    async close() { calls.push("close"); },
  };
  await assert.rejects(admitWindowsMutationPlan(executor, plan), { code: "UPDATE_SECURITY_ERROR" });
  assert.deepEqual(calls, ["reserve", "admit", "revoke"]);
});

test("Windows mutation authority rejects a receipt that does not bind its prepared bytes", async () => {
  const calls: string[] = [];
  const epoch = Object.freeze({ attemptId: "9".repeat(36) });
  const executor: NativeMutationExecutor = {
    epoch,
    async reserve() { calls.push("reserve"); },
    async admit() {
      calls.push("admit");
      return Object.freeze({
        slot: "transaction" as const,
        operationId: "0".repeat(36),
        epochId: epoch.attemptId,
        operationSequence: 0,
        bytesSha256: "0".repeat(64),
      });
    },
    async revoke() { calls.push("revoke"); },
    async close() { calls.push("close"); },
  };
  await assert.rejects(admitWindowsMutationPlan(executor, plan), { code: "UPDATE_SECURITY_ERROR" });
  assert.deepEqual(calls, ["reserve", "admit", "revoke"]);
});
