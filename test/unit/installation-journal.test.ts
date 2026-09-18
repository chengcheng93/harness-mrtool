import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { validateReleaseSetRecord } from "../../src/update/cache.ts";
import { tupleDigest } from "../../src/update/journal.ts";
import {
  encodeInstallationJournal, parseInstallationJournal, validateInstallationJournal,
  INSTALLATION_JOURNAL_PHASES, MAX_INSTALLATION_JOURNAL_BYTES,
  type InstallationJournal, type InstallationLaunchState,
} from "../../src/update/installation-journal.ts";
import {
  canonicalBytes, checksum, digest, journalFixture, randomId, sealOperation, sealSettlement,
  sealTerminal, withLaunch, type JournalFixture,
} from "../helpers/installation-journal-fixture.ts";

const SECRET = "NEVER-REFLECT-token-stdin-/outside/secret";
function reject(call: () => unknown): void {
  assert.throws(call, (error: unknown) => {
    assert.ok(error instanceof ToolError);
    assert.equal(error.code, "UPDATE_SECURITY_ERROR");
    assert.equal(error.message, "installation journal is invalid");
    assert.deepEqual(error.details, { field: "installationJournal", expected: "bounded canonical installation evidence",
      actual: "invalid", safeNextStep: "Preserve installation evidence and run self-update repair." });
    assert.equal(Object.hasOwn(error, "cause"), false);
    assert.ok(!inspect(error).includes(SECRET));
    return true;
  });
}
function bad(change: (j: JournalFixture) => void, platform: InstallationJournal["platform"] = "darwin-arm64"): void {
  const value = journalFixture(platform);
  change(value);
  reject(() => validateInstallationJournal(value));
  reject(() => encodeInstallationJournal(value));
  reject(() => parseInstallationJournal(canonicalBytes(value)));
}
function assertFrozen(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  assert.ok(Object.isFrozen(value));
  assert.equal(Object.getPrototypeOf(value), Array.isArray(value) ? Array.prototype : Object.prototype);
  for (const child of Object.values(value)) assertFrozen(child);
}

for (const platform of ["darwin-arm64", "windows-x64"] as const) {
  for (const phase of ["preparing", "prepared", "execution-pending", "publish-intent", "canonical-published",
    "marker-published", "commit-intent", "committed", "compensating", "aborted", "blocked", "retention-transfer"] as const) {
    if (platform === "darwin-arm64" && phase === "execution-pending") continue;
    test(`${platform} ${phase}: complete evidence has a canonical frozen roundtrip`, () => {
      const fixture = journalFixture(platform, phase);
      const actual = validateInstallationJournal(fixture);
      assert.deepEqual(actual, fixture);
      assertFrozen(actual);
      const encoded = encodeInstallationJournal(fixture);
      assert.deepEqual(encoded, canonicalBytes(fixture));
      assert.deepEqual(parseInstallationJournal(encoded), actual);
      assert.deepEqual(encodeInstallationJournal(parseInstallationJournal(encoded)), encoded);
      assert.ok(encoded.length <= 65536);
      assert.notEqual(actual.attemptId, actual.transactionId);
      assert.equal(actual.transactionId, actual.next.transactionId);
      assert.equal(actual.previousEvidence.tupleSha256, tupleDigest(validateReleaseSetRecord(actual.previous)));
      assert.equal(actual.nextEvidence.tupleSha256, tupleDigest(validateReleaseSetRecord(actual.next)));
      assert.notEqual(actual.next.cliSha256, actual.nextEvidence.native.sha256);
      assert.equal("installed" in actual, false);
    });
  }
}

test("closed phases exclude catalog-only/derived states, not confused with the recovery projection", () => {
  assert.equal(MAX_INSTALLATION_JOURNAL_BYTES, 64 * 1024);
  assert.deepEqual(INSTALLATION_JOURNAL_PHASES, ["preparing", "prepared", "execution-pending", "publish-intent",
    "canonical-published", "marker-published", "commit-intent", "committed", "compensating", "aborted", "blocked", "retention-transfer"]);
  assert.ok(Object.isFrozen(INSTALLATION_JOURNAL_PHASES));
  for (const phase of ["cleanup", "ownership-transferred", "journal-retired", "installed", "staging", "future"]) {
    bad(j => { Object.assign(j, { phase }); });
  }
});

test("validation detaches every nested record, byte output and arrays; input is not frozen or mutated", () => {
  const fixture = withLaunch(journalFixture("windows-x64"), "completed");
  const before = structuredClone(fixture), result = validateInstallationJournal(fixture);
  assert.deepEqual(fixture, before);
  assert.equal(Object.isFrozen(fixture), false);
  assertFrozen(result);
  fixture.previous.cliVersion = "9.9.9";
  fixture.nextEvidence.marker.fields.tag = "v9.9.9";
  fixture.roots.installation.ino = "999";
  fixture.slots.pop();
  fixture.control.operations[0]!.admittedSlots.pop();
  fixture.windows!.launch!.parent.pid = 999;
  assert.deepEqual(result, before);
  const bytes = encodeInstallationJournal(result), decoded = parseInstallationJournal(bytes);
  bytes.fill(0);
  assert.deepEqual(decoded, before);
  assert.deepEqual(encodeInstallationJournal(result), canonicalBytes(before));
  assertFrozen(decoded);
});

test("canonical encoding does not depend on input object key insertion order", () => {
  const value = journalFixture();
  const reverse = (v: unknown): unknown => v === null || typeof v !== "object" ? v : Array.isArray(v) ? v.map(reverse) :
    Object.fromEntries(Object.entries(v).reverse().map(([k, child]) => [k, reverse(child)]));
  assert.deepEqual(encodeInstallationJournal(reverse(value)), canonicalBytes(value));
});

test("strict bytes reject BOM, UTF-8 errors, duplicate/escaped keys, trailing input and noncanonical JSON", () => {
  const text = new TextDecoder().decode(canonicalBytes(journalFixture()));
  const variants = ["", "null\n", "[]\n", "{}\n", text.trimEnd(), `${text}\n`, `${text} `, ` ${text}`,
    `${text}{}`, `${text}\0`, `\ufeff${text}`, text.replace('"journalVersion":1', '"journalVersion":1.0'),
    text.replace('"journalVersion":1', '"journalVersion":1e0'), text.replace('"apply"', '"\\u0061pply"'),
    text.replace('"journalVersion":1', '"journalVersion":1,"journalVersion":1'),
    text.replace('"journalVersion":1', '"journalVersion":1,"\\u006aournalVersion":1'),
    text.replace('"dev":"2"', '"dev":"2","dev":"2"'), text.replace('{', '{/*comment*/'),
    text.replace(/\}\n$/u, ',}\n'), `${JSON.stringify(journalFixture(), null, 2)}\n`,
    `${JSON.stringify(Object.fromEntries(Object.entries(journalFixture()).reverse()))}\n`,
    text.replace('"apply"', '"\\ud800"'), `[${"[".repeat(257)}0${"]".repeat(257)}]\n`,
    text.replace('"apply"', `"${SECRET}"`),
  ];
  for (const variant of variants) reject(() => parseInstallationJournal(new TextEncoder().encode(variant)));
  for (const bytes of [Uint8Array.of(0xc0, 0xaf), Uint8Array.of(0xed, 0xa0, 0x80), Uint8Array.of(0xf0, 0x9f),
    Uint8Array.from([...canonicalBytes(journalFixture()), 0xff]), new Uint8Array(65537),
    new Uint8Array(65536).fill(32), Buffer.from([0xff, 0xfe, 123, 0])]) reject(() => parseInstallationJournal(bytes));
  assert.deepEqual(parseInstallationJournal(Buffer.from(text)), journalFixture());
  const padded = new Uint8Array(text.length + 10);
  padded.set(new TextEncoder().encode(text), 5);
  assert.deepEqual(parseInstallationJournal(padded.subarray(5, -5)), journalFixture());
});

test("unknown values and oversized in-process strings fail without leaking input", () => {
  for (const value of [undefined, null, 1, true, SECRET, Symbol(SECRET), 1n, () => true, [], {}, new Date(), new Map()]) {
    reject(() => validateInstallationJournal(value));
    reject(() => encodeInstallationJournal(value));
  }
  bad(j => { j.next.cliVersion = "1.2.3+" + "a".repeat(65536); });
  for (const key of ["path", "url", "grant", "token", "request", "stdin", "installed", "__proto__", "constructor"]) {
    const j = journalFixture();
    Object.defineProperty(j, key, { enumerable: true, value: SECRET });
    reject(() => validateInstallationJournal(j));
  }
});

// Test every nested boundary, including input arrays and nested source release records.
type Path = (string | number)[];
function objectPaths(value: unknown, path: Path = []): Path[] {
  if (value === null || typeof value !== "object") return [];
  return [path, ...Object.entries(value).flatMap(([key, child]) => objectPaths(child, [...path, key]))];
}
function at(root: unknown, path: Path): object {
  let result = root;
  for (const key of path) result = (result as Record<string | number, unknown>)[key];
  return result as object;
}
function replace(root: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const parent = at(root, path.slice(0, -1));
  Object.defineProperty(parent, path.at(-1)!, { enumerable: true, configurable: true, writable: true, value });
  return root;
}
const full = (): JournalFixture => withLaunch(journalFixture("windows-x64"), "completed");
for (const path of objectPaths(full())) {
  test(`exact own-property/proxy boundary: ${path.join(".") || "root"}`, () => {
    for (const kind of ["extra", "hidden", "symbol", "accessor", "prototype", "proxy", "revoked"] as const) {
      const j = full(), target = at(j, path);
      let calls = 0;
      let input: unknown = j;
      if (kind === "extra") Object.defineProperty(target, "unexpected", { enumerable: true, value: SECRET });
      if (kind === "hidden") Object.defineProperty(target, "hidden", { enumerable: false, value: SECRET });
      if (kind === "symbol") Object.defineProperty(target, Symbol(SECRET), { value: SECRET });
      if (kind === "accessor") {
        const key = Object.keys(target)[0]!;
        Object.defineProperty(target, key, { enumerable: true, get() { calls++; throw new Error(SECRET); } });
      }
      if (kind === "prototype") Object.setPrototypeOf(target, { secret: SECRET });
      if (kind === "proxy") {
        const trap = (): never => { calls++; throw new Error(SECRET); };
        input = replace(j, path, new Proxy(target, { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap }));
      }
      if (kind === "revoked") {
        const proxy = Proxy.revocable(target, {}); proxy.revoke(); input = replace(j, path, proxy.proxy);
      }
      reject(() => validateInstallationJournal(input));
      reject(() => encodeInstallationJournal(input));
      assert.equal(calls, 0);
    }
  });
}

test("no property coercion, shared-memory byte source, accessor or proxy byte traps", () => {
  let calls = 0;
  const trap = (): never => { calls++; throw new Error(SECRET); };
  const bytes = canonicalBytes(journalFixture());
  const byteProxy = new Proxy(bytes, { get: trap, getPrototypeOf: trap, ownKeys: trap });
  reject(() => parseInstallationJournal(byteProxy));
  const accessor = canonicalBytes(journalFixture());
  Object.defineProperty(accessor, "byteLength", { get: trap });
  reject(() => parseInstallationJournal(accessor));
  const shared = new Uint8Array(new SharedArrayBuffer(bytes.length)); shared.set(bytes);
  reject(() => parseInstallationJournal(shared));
  const resizable = new Uint8Array(Reflect.construct(ArrayBuffer, [bytes.length, { maxByteLength: bytes.length + 1 }])); resizable.set(bytes);
  reject(() => parseInstallationJournal(resizable));
  class Bytes extends Uint8Array {}
  reject(() => parseInstallationJournal(new Bytes(bytes)));
  const poisoned = journalFixture(); Object.assign(poisoned, { revision: { valueOf: trap } });
  reject(() => validateInstallationJournal(poisoned));
  reject(() => encodeInstallationJournal(poisoned));
  assert.equal(calls, 0);
});

test("closed nested schemas reject omissions, symbols, hidden fields, bad numeric/identifier domains", () => {
  for (const path of objectPaths(full()).filter(p => !Array.isArray(at(full(), p)))) {
    const j = full(), target = at(j, path) as Record<string, unknown>;
    delete target[Object.keys(target)[0]!];
    reject(() => validateInstallationJournal(j));
  }
  for (const value of [0, -1, -0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1", null]) {
    const j = journalFixture(); Object.assign(j, { revision: value }); reject(() => validateInstallationJournal(j));
  }
  for (const id of ["", "../escape", "/tmp/a", "C:\\outside", "https://example.test/", "a".repeat(31), "A".repeat(32), SECRET]) {
    bad(j => { j.attemptId = id; });
    bad(j => { j.installationId = id; });
    bad(j => { j.nextEvidence.snapshotId = id; });
  }
  for (const ino of ["00", "01", "-1", "0", "18446744073709551616", "1.1", "1e1", " 1", SECRET]) {
    bad(j => { j.roots.installation.ino = ino; });
  }
  bad(j => { j.roots.installation.dev = "-1"; });
  bad(j => { j.roots.state = { ...j.roots.installation }; });
  bad(j => { Object.assign(j, { journalVersion: 2 }); });
  bad(j => { Object.assign(j, { operation: "install" }); });
  bad(j => { Object.assign(j, { platform: "linux-x64" }); });
  const nullPrototype = Object.setPrototypeOf(journalFixture(), null);
  reject(() => validateInstallationJournal(nullPrototype));
});

test("release and accepted-authorization crossbindings fail closed", () => {
  const changes: ((j: JournalFixture) => void)[] = [
    j => { j.transactionId = j.previous.transactionId; },
    j => { j.attemptId = j.next.transactionId; },
    j => { j.next.transactionId = "release-" + "f".repeat(32); j.transactionId = j.next.transactionId; },
    j => { j.previous.transactionId = "release-" + "f".repeat(32); },
    j => { j.nextEvidence.tupleSha256 = digest("wrong"); },
    j => { j.previousEvidence.tupleSha256 = digest("wrong"); },
    j => { j.nextEvidence.snapshotId = j.previous.transactionId; },
    j => { j.authorization.sequence++; },
    j => { j.authorization.payloadSha256 = digest("wrong"); },
    j => { j.authorization.trustStateSha256 = SECRET; },
    j => { j.nextEvidence.authorizationPayloadSha256 = SECRET; },
    j => { j.nextEvidence.native.size = 0; },
    j => { j.nextEvidence.native.size = 256 * 1024 * 1024 + 1; },
    j => { j.nextEvidence.marker.fields.archiveSha256 = j.nextEvidence.native.sha256; },
    j => { j.nextEvidence.marker.fields.executableSha256 = j.next.cliSha256; },
    j => { j.nextEvidence.marker.fields.tag = "v0.1.6"; },
    j => { j.nextEvidence.marker.fields.repository = "https://example.test/repo"; },
    j => { j.nextEvidence.marker.fields.repository = "other/repo"; },
    j => { j.nextEvidence.marker.sha256 = digest("wrong"); },
    j => { j.nextEvidence.marker.size++; },
    j => { j.next.cliSha256 = "A".repeat(64); },
    j => { j.next.inputSchema = 0; },
    j => { j.previous.cliVersion = "01.2.3"; },
  ];
  for (const change of changes) bad(change);
});

test("rollback is a newly authorized higher sequence; same native bytes do not erase distinct tuples", () => {
  const rollback = journalFixture(); rollback.operation = "rollback";
  // The codec cannot authenticate whether assets are an older retained release.
  assert.equal(validateInstallationJournal(rollback).operation, "rollback");
  for (const operation of ["apply", "rollback"] as const) {
    const j = journalFixture(); j.operation = operation;
    j.next = { ...j.previous }; j.nextEvidence = structuredClone(j.previousEvidence);
    j.transactionId = j.next.transactionId; j.authorization.sequence = j.next.manifestSequence;
    j.authorization.payloadSha256 = j.nextEvidence.authorizationPayloadSha256;
    reject(() => validateInstallationJournal(j));
  }
  const j = journalFixture();
  j.nextEvidence.native = { ...j.previousEvidence.native };
  j.nextEvidence.marker.fields.executableSha256 = j.nextEvidence.native.sha256;
  j.nextEvidence.marker.sha256 = digest(canonicalBytes(j.nextEvidence.marker.fields));
  j.nextEvidence.marker.size = canonicalBytes(j.nextEvidence.marker.fields).length;
  j.slots[0]!.expectedSha256 = j.nextEvidence.native.sha256;
  j.slots[1]!.expectedSha256 = j.nextEvidence.marker.sha256;
  j.slots[1]!.expectedSize = j.nextEvidence.marker.size;
  const parsed = validateInstallationJournal(j);
  assert.equal(parsed.previousEvidence.native.sha256, parsed.nextEvidence.native.sha256);
  assert.notEqual(parsed.previousEvidence.tupleSha256, parsed.nextEvidence.tupleSha256);
});

test("outcome and terminal evidence cannot contradict phase or live writer/launch", () => {
  for (const phase of INSTALLATION_JOURNAL_PHASES) {
    if (phase === "execution-pending") continue;
    for (const outcome of [null, "next", "previous"] as const) {
      const valid = phase === "blocked" || (phase === "committed" ? outcome === "next" :
        phase === "aborted" || phase === "compensating" ? outcome === "previous" :
        phase === "retention-transfer" ? outcome !== null : outcome === null);
      const j = journalFixture("darwin-arm64", phase); j.outcome = outcome; sealTerminal(j);
      if (valid) assert.equal(validateInstallationJournal(j).outcome, outcome);
      else reject(() => validateInstallationJournal(j));
    }
  }
  const terminal = journalFixture("darwin-arm64", "committed"); terminal.terminalEvidenceSha256 = null;
  reject(() => validateInstallationJournal(terminal));
  bad(j => { j.terminalEvidenceSha256 = digest("not terminal"); });
  const changed = journalFixture("darwin-arm64", "aborted"); changed.installationId = randomId(77);
  reject(() => validateInstallationJournal(changed));
  const running = journalFixture("darwin-arm64", "committed");
  running.control.operations[0]!.status = "running";
  running.control.operations[0] = sealOperation(running.control.operations[0]!); sealTerminal(running);
  reject(() => validateInstallationJournal(running));
});

test("bounded intent/created inventory is exact, linked to content, and never aliases physical roles", () => {
  const preparing = journalFixture("darwin-arm64", "preparing");
  preparing.slots = preparing.slots.map(({ name, expectedSha256, expectedSize }) => ({ name, state: "intent", expectedSha256, expectedSize }));
  assert.equal(validateInstallationJournal(preparing).slots[0]!.state, "intent");
  preparing.phase = "prepared"; reject(() => validateInstallationJournal(preparing));
  for (const change of [
    (j: JournalFixture) => { j.slots.pop(); },
    (j: JournalFixture) => { j.slots.push(structuredClone(j.slots[0]!)); },
    (j: JournalFixture) => { j.slots[0]!.expectedSha256 = digest("wrong"); },
    (j: JournalFixture) => { j.slots[0]!.expectedSize++; },
    (j: JournalFixture) => { Object.assign(j.slots[0]!, { name: "../file" }); },
    (j: JournalFixture) => { Object.assign(j.slots[0]!, { identity: j.roots.installation }); },
    (j: JournalFixture) => { Object.assign(j.slots[1]!, { identity: (j.slots[0] as { identity: object }).identity }); },
    (j: JournalFixture) => { Object.assign(j.slots[0]!, { state: "intent" }); },
  ]) bad(change);
  const sparse = journalFixture(); delete sparse.slots[1]; reject(() => validateInstallationJournal(sparse));
  const huge = journalFixture(); huge.slots.length = 1_000_000; reject(() => validateInstallationJournal(huge));
  const hidden = journalFixture(); Object.defineProperty(hidden.slots, "0", { enumerable: false });
  reject(() => validateInstallationJournal(hidden));
});

test("control receipts bind every field, revisions, epochs and enumerated admission slots", () => {
  const mutate = (change: (op: JournalFixture["control"]["operations"][number], j: JournalFixture) => void) => {
    bad(j => { change(j.control.operations[0]!, j); j.control.operations[0] = sealOperation(j.control.operations[0]!); });
  };
  bad(j => { j.control.operations[0]!.receiptSha256 = digest("wrong"); });
  mutate(op => { op.attemptId = randomId(88); });
  mutate(op => { op.transactionId = "release-" + "b".repeat(32); });
  mutate(op => { op.previousTupleSha256 = digest("wrong"); });
  mutate(op => { op.nextTupleSha256 = digest("wrong"); });
  mutate(op => { op.authorityEpoch = 6; });
  mutate(op => { op.expectedRevision = 11; });
  mutate(op => { op.expectedRevision = 0; });
  mutate(op => { op.workerId = SECRET; });
  mutate(op => { op.operationId = SECRET; });
  mutate(op => { op.admittedSlots = []; });
  mutate(op => { op.admittedSlots.push(op.admittedSlots[0]!); });
  mutate(op => { Object.assign(op, { admittedSlots: ["/arbitrary"] }); });
  mutate(op => { op.admittedSlots = ["windows-inner-journal"]; });
  mutate(op => { op.status = "running"; op.expectedRevision--; });
  bad(j => { j.control.operations = []; });
  bad(j => { j.control.operations = Array.from({ length: 17 }, () => structuredClone(j.control.operations[0]!)); });
  bad(j => { j.control.operations.push(structuredClone(j.control.operations[0]!)); });
  const j = journalFixture();
  const op = j.control.operations[0]!;
  j.control.operations = [sealOperation({ ...op, authorityEpoch: 4, expectedRevision: 9, status: "revoked", workerId: randomId(98), operationId: randomId(99) }),
    sealOperation({ ...op, status: "running" })];
  assert.equal(validateInstallationJournal(j).control.operations[1]!.status, "running");
  j.control.operations.reverse(); reject(() => validateInstallationJournal(j));
});

test("Windows inner evidence has exact outer/native/root/inventory bindings; Darwin forbids it", () => {
  bad(j => { j.windows = journalFixture("windows-x64").windows; });
  bad(j => { Object.assign(j, { phase: "execution-pending" }); });
  for (const change of [
    (j: JournalFixture) => { j.windows = null; },
    (j: JournalFixture) => { j.windows!.inner!.attemptId = randomId(99); },
    (j: JournalFixture) => { j.windows!.inner!.transactionId = j.previous.transactionId; },
    (j: JournalFixture) => { j.windows!.inner!.nextTupleSha256 = digest("wrong"); },
    (j: JournalFixture) => { j.windows!.inner!.previousTupleSha256 = digest("wrong"); },
    (j: JournalFixture) => { j.windows!.inner!.nextNativeSha256 = j.next.cliSha256; },
    (j: JournalFixture) => { j.windows!.inner!.previousNativeSha256 = j.previous.cliSha256; },
    (j: JournalFixture) => { j.windows!.inner!.roots.state.ino = "999"; },
    (j: JournalFixture) => { j.windows!.inner!.identity.ino = "999"; },
    (j: JournalFixture) => { j.windows!.inner!.sha256 = digest("wrong"); },
    (j: JournalFixture) => { j.windows!.inner!.size++; },
    (j: JournalFixture) => { j.windows!.inner = null; },
  ]) bad(change, "windows-x64");
  const noInner = journalFixture("windows-x64", "preparing");
  noInner.windows!.inner = null; noInner.slots.pop();
  assert.equal(validateInstallationJournal(noInner).windows!.inner, null);
});

for (const state of ["reserved", "registered", "claimed", "ack-issued", "admitted", "completed", "outcome-unknown", "revoked"] as const) {
  test(`Windows launch ${state} retains only descriptor/grant digests and settlement evidence`, () => {
    const j = withLaunch(journalFixture("windows-x64"), state);
    const parsed = parseInstallationJournal(encodeInstallationJournal(j));
    assert.equal(parsed.windows!.launch!.state, state);
    assertFrozen(parsed.windows!.launch!);
    assert.equal("grant" in parsed.windows!.launch!, false);
    const launch = parsed.windows!.launch!;
    if (launch.settlement.state === "settled") assert.equal(launch.settlement.launchId, launch.launchId);
  });
}

test("Windows launch crossbindings, lifecycle and settlement reject contradictions, not just malformed hashes", () => {
  const mutate = (change: (j: JournalFixture) => void, state: InstallationLaunchState = "completed") => {
    const j = withLaunch(journalFixture("windows-x64"), state); change(j);
    reject(() => validateInstallationJournal(j));
  };
  for (const field of ["attemptId", "installationId", "enrollmentId"] as const) mutate(j => { j.windows!.launch![field] = randomId(99); });
  mutate(j => { j.windows!.launch!.transactionId = j.previous.transactionId; });
  mutate(j => { j.windows!.launch!.nextTupleSha256 = digest("wrong"); });
  mutate(j => { j.windows!.launch!.nextNativeSha256 = j.next.cliSha256; });
  mutate(j => { j.windows!.launch!.descriptorSha256 = digest("wrong"); });
  mutate(j => { j.windows!.launch!.targetIdentity.ino = "999"; });
  mutate(j => { j.windows!.launch!.authorityEpoch = 6; });
  mutate(j => { j.windows!.launch!.expectedRevision = 11; });
  mutate(j => { j.windows!.launch!.parent.pid = 0; });
  mutate(j => { j.windows!.launch!.parent.startKey = SECRET; });
  mutate(j => { j.windows!.launch!.child = { ...j.windows!.launch!.parent }; });
  mutate(j => { j.windows!.launch!.child = null; });
  mutate(j => { j.windows!.launch!.grantSha256 = null; });
  mutate(j => { j.windows!.launch!.exitCode = null; });
  mutate(j => { j.windows!.launch!.exitCode = -1; });
  mutate(j => { j.windows!.launch!.exitCode = 0; }, "outcome-unknown");
  mutate(j => { j.windows!.launch!.grantSha256 = digest("raw would not be accepted"); }, "reserved");
  mutate(j => { j.windows!.launch!.child = null; }, "registered");
  mutate(j => { j.windows!.launch!.grantSha256 = digest("unexpected"); }, "claimed");
  mutate(j => { j.windows!.launch!.state = "registered"; }, "ack-issued");
  mutate(j => { j.phase = "execution-pending"; }, "claimed");
  mutate(j => { j.phase = "publish-intent"; }, "admitted");
  mutate(j => { j.phase = "aborted"; j.outcome = "previous"; sealTerminal(j); }, "admitted");
  mutate(j => { j.slots = j.slots.filter(s => s.name !== "launch-descriptor"); });
  for (const field of ["launchId", "reservationId", "descriptorSha256"] as const) {
    mutate(j => {
      const settlement = j.windows!.launch!.settlement;
      assert.equal(settlement.state, "settled");
      if (settlement.state === "settled") {
        settlement[field] = field === "descriptorSha256" ? digest("wrong") : randomId(99);
        j.windows!.launch!.settlement = sealSettlement(settlement);
      }
    });
  }
  mutate(j => {
    const s = j.windows!.launch!.settlement;
    if (s.state === "settled") { s.child!.startKey = "win:999"; j.windows!.launch!.settlement = sealSettlement(s); }
  });
  const finished = withLaunch(journalFixture("windows-x64", "committed"), "completed");
  assert.equal(validateInstallationJournal(finished).outcome, "next");
});


test("source marker contract is cli-v; archive/member roles bind independently without an inequality rule", () => {
  const j = journalFixture();
  assert.equal(j.nextEvidence.marker.fields.tag, `cli-v${j.next.cliVersion}`);
  assert.equal(validateInstallationJournal(j).nextEvidence.marker.fields.tag, "cli-v0.1.7");
  j.nextEvidence.marker.fields.tag = `v${j.next.cliVersion}`;
  j.nextEvidence.marker.sha256 = digest(canonicalBytes(j.nextEvidence.marker.fields));
  j.nextEvidence.marker.size = canonicalBytes(j.nextEvidence.marker.fields).length;
  j.slots[1]!.expectedSha256 = j.nextEvidence.marker.sha256;
  j.slots[1]!.expectedSize = j.nextEvidence.marker.size;
  reject(() => validateInstallationJournal(j));

  const equalHash = journalFixture();
  equalHash.nextEvidence.native.sha256 = equalHash.next.cliSha256;
  equalHash.nextEvidence.marker.fields.executableSha256 = equalHash.next.cliSha256;
  equalHash.nextEvidence.marker.sha256 = digest(canonicalBytes(equalHash.nextEvidence.marker.fields));
  equalHash.nextEvidence.marker.size = canonicalBytes(equalHash.nextEvidence.marker.fields).length;
  equalHash.slots[0]!.expectedSha256 = equalHash.nextEvidence.native.sha256;
  equalHash.slots[1]!.expectedSha256 = equalHash.nextEvidence.marker.sha256;
  equalHash.slots[1]!.expectedSize = equalHash.nextEvidence.marker.size;
  assert.equal(validateInstallationJournal(equalHash).nextEvidence.native.sha256, equalHash.next.cliSha256);
});
