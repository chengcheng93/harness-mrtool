import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeWindowsPersistenceDescriptor,
  encodeWindowsPersistenceDescriptor,
  type WindowsPersistenceDescriptor,
} from "../../src/update/windows-persistence-descriptor.ts";

const descriptor: WindowsPersistenceDescriptor = Object.freeze({
  schemaVersion: 1,
  launchId: "a".repeat(32),
  reservationId: "b".repeat(32),
  attemptId: "c".repeat(32),
  transactionId: `release-${"d".repeat(32)}`,
  expectedRevision: 4,
  parent: Object.freeze({ pid: 4242, startKey: "win:123", launchNonce: "e".repeat(32) }),
});

test("Windows persistence descriptor encodes and decodes canonical bounded evidence", () => {
  const bytes = encodeWindowsPersistenceDescriptor(descriptor);
  assert.equal(new TextDecoder().decode(bytes), `${JSON.stringify({
    attemptId: descriptor.attemptId,
    expectedRevision: descriptor.expectedRevision,
    launchId: descriptor.launchId,
    parent: { launchNonce: descriptor.parent.launchNonce, pid: descriptor.parent.pid, startKey: descriptor.parent.startKey },
    reservationId: descriptor.reservationId,
    schemaVersion: 1,
    transactionId: descriptor.transactionId,
  })}\n`);
  assert.deepEqual(decodeWindowsPersistenceDescriptor(bytes), descriptor);
});

test("Windows persistence descriptor rejects paths, payload-shaped fields, and malformed identities", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({
    ...descriptor,
    path: "C:\\secret",
  }));
  assert.throws(() => decodeWindowsPersistenceDescriptor(bytes), /installation journal is invalid/u);
  for (const value of [
    { ...descriptor, parent: { ...descriptor.parent, startKey: "darwin:abc" } },
    { ...descriptor, transactionId: "release-" + "f".repeat(31) },
    { ...descriptor, expectedRevision: 0 },
    { ...descriptor, parent: { ...descriptor.parent, pid: 0 } },
  ]) {
    assert.throws(() => decodeWindowsPersistenceDescriptor(new TextEncoder().encode(JSON.stringify(value))), /installation journal is invalid/u);
  }
});

test("Windows persistence descriptor is bounded and detached from caller bytes", () => {
  const bytes = encodeWindowsPersistenceDescriptor(descriptor);
  const copy = Uint8Array.from(bytes);
  bytes[0] = (bytes[0] ?? 0) ^ 1;
  assert.deepEqual(decodeWindowsPersistenceDescriptor(copy), descriptor);
  assert.throws(() => decodeWindowsPersistenceDescriptor(new Uint8Array(64 * 1024 + 1)), /installation journal is invalid/u);
});
