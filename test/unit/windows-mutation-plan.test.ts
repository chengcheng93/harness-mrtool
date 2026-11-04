import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeWindowsMutationPlan,
  encodeWindowsMutationPlan,
  type WindowsMutationPlan,
} from "../../src/update/windows-mutation-plan.ts";

const plan: WindowsMutationPlan = Object.freeze({
  schemaVersion: 1,
  operation: "apply",
  installationId: "a".repeat(32),
  enrollmentId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  journalRevision: 7,
  authorityEpoch: 8,
  previous: Object.freeze({
    executableSha256: "e".repeat(64),
    executableSize: 101,
    markerSha256: "f".repeat(64),
    markerSize: 201,
  }),
  next: Object.freeze({
    executableSha256: "1".repeat(64),
    executableSize: 102,
    markerSha256: "2".repeat(64),
    markerSize: 202,
  }),
});

test("Windows mutation plan encodes and decodes a bounded canonical path-free intent", () => {
  const bytes = encodeWindowsMutationPlan(plan);
  assert.equal(new TextDecoder().decode(bytes), `${JSON.stringify({
    attemptId: "c".repeat(32),
    authorityEpoch: 8,
    enrollmentId: "b".repeat(32),
    installationId: "a".repeat(32),
    journalRevision: 7,
    next: {
      executableSha256: "1".repeat(64),
      executableSize: 102,
      markerSha256: "2".repeat(64),
      markerSize: 202,
    },
    operation: "apply",
    previous: {
      executableSha256: "e".repeat(64),
      executableSize: 101,
      markerSha256: "f".repeat(64),
      markerSize: 201,
    },
    schemaVersion: 1,
    transactionId: `release-${"d".repeat(32)}`,
  })}\n`);
  assert.deepEqual(decodeWindowsMutationPlan(bytes), plan);
});

test("Windows mutation plan rejects paths, payloads, invalid identity, and impossible sizes", () => {
  const parsed = JSON.parse(new TextDecoder().decode(encodeWindowsMutationPlan(plan))) as Record<string, unknown>;
  for (const value of [
    { ...parsed, path: "C:\\\\secret" },
    { ...parsed, bytes: "business-payload" },
    { ...parsed, authorityEpoch: 0 },
    { ...parsed, journalRevision: 0 },
    { ...parsed, operation: "resume" },
    { ...parsed, transactionId: "release-" + "d".repeat(31) },
    { ...parsed, previous: { ...(parsed.previous as object), executableSize: 0 } },
    { ...parsed, next: { ...(parsed.next as object), markerSha256: "z".repeat(64) } },
  ]) {
    assert.throws(
      () => decodeWindowsMutationPlan(new TextEncoder().encode(JSON.stringify(value))),
      /windows mutation plan is invalid/u,
    );
  }
});

test("Windows mutation plan is detached and bounded", () => {
  const bytes = encodeWindowsMutationPlan(plan);
  const copy = Uint8Array.from(bytes);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  assert.deepEqual(decodeWindowsMutationPlan(copy), plan);
  assert.throws(() => decodeWindowsMutationPlan(new TextEncoder().encode(" {" + new TextDecoder().decode(copy).trim().slice(1))), /windows mutation plan is invalid/u);
  assert.throws(() => decodeWindowsMutationPlan(new Uint8Array(16 * 1024 + 1)), /windows mutation plan is invalid/u);
});
