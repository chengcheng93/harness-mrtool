import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeInstallationControl,
  encodeInstallationControl,
  type InstallationControl,
} from "../../src/update/installation-control.ts";

const operation = Object.freeze({
  workerId: "a".repeat(32),
  operationId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  expectedRevision: 4,
  operation: "apply" as const,
  tupleSha256: "e".repeat(64),
  admittedSlots: ["staged-executable", "staged-marker"] as const,
  status: "scheduled" as const,
});

const control: InstallationControl = Object.freeze({
  schemaVersion: 1,
  installationId: "f".repeat(32),
  enrollmentId: "1".repeat(32),
  authorityEpoch: 7,
  current: operation,
  queued: [],
});

test("installation control encodes and decodes a bounded canonical operation record", () => {
  const bytes = encodeInstallationControl(control);
  assert.equal(new TextDecoder().decode(bytes), `${JSON.stringify({
    authorityEpoch: 7,
    current: {
      admittedSlots: ["staged-executable", "staged-marker"],
      attemptId: "c".repeat(32),
      expectedRevision: 4,
      operation: "apply",
      operationId: "b".repeat(32),
      status: "scheduled",
      transactionId: `release-${"d".repeat(32)}`,
      tupleSha256: "e".repeat(64),
      workerId: "a".repeat(32),
    },
    enrollmentId: "1".repeat(32),
    installationId: "f".repeat(32),
    queued: [],
    schemaVersion: 1,
  })}\n`);
  assert.deepEqual(decodeInstallationControl(bytes), control);
});

test("installation control rejects paths, business payload, stale status, and queue overflow", () => {
  const parsed = JSON.parse(new TextDecoder().decode(encodeInstallationControl(control))) as Record<string, unknown>;
  for (const value of [
    {...parsed, path: "C:\\\\secret"},
    {...parsed, token: "secret"},
    {...parsed, authorityEpoch: 0},
    {...parsed, queued: [operation, {...operation, operationId: "0".repeat(31) + "1"}]},
  ]) {
    assert.throws(() => decodeInstallationControl(new TextEncoder().encode(JSON.stringify(value))), /installation control is invalid/u);
  }
  const duplicate = {...parsed, queued: [operation]};
  const current = (duplicate as Record<string, unknown>).current as Record<string, unknown>;
  assert.throws(() => decodeInstallationControl(new TextEncoder().encode(JSON.stringify({...duplicate, current: {...current, status: "running"}, queued: [operation]}))), /installation control is invalid/u);
});

test("installation control is detached and rejects non-canonical or oversized input", () => {
  const bytes = encodeInstallationControl(control);
  const copy = Uint8Array.from(bytes);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  assert.deepEqual(decodeInstallationControl(copy), control);
  assert.throws(() => decodeInstallationControl(new TextEncoder().encode(" {" + new TextDecoder().decode(copy).trim().slice(1))), /installation control is invalid/u);
  assert.throws(() => decodeInstallationControl(new Uint8Array(16 * 1024 + 1)), /installation control is invalid/u);
});
