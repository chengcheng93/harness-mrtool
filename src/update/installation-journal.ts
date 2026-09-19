/**
 * Untrusted, data-only installation evidence. This codec performs no I/O and
 * grants no authority. Checksums, identities, phases and receipts do NOT prove
 * authentication, physical state, writer/launch settlement or installed truth.
 * Native re-observation, policy/provenance verification and cross-write revision
 * fencing belong to the future coordinator, not this parser or the classifier.
 */
import { types } from "node:util";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson, sha256Utf8 } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import { MAX_CACHE_CLI_BYTES, validateReleaseSetRecord, type ReleaseSetRecord } from "./cache.ts";

export const MAX_INSTALLATION_JOURNAL_BYTES = 64 * 1024;
export const INSTALLATION_JOURNAL_PHASES = Object.freeze([
  "preparing", "prepared", "execution-pending", "publish-intent", "canonical-published",
  "marker-published", "commit-intent", "committed", "compensating", "aborted", "blocked", "retention-transfer",
] as const);
export type InstallationJournalPhase = (typeof INSTALLATION_JOURNAL_PHASES)[number];
export type InstallationLaunchState = "reserved" | "registered" | "claimed" | "ack-issued" |
  "admitted" | "completed" | "outcome-unknown" | "revoked";

/** Decimal uint64 evidence, never a filesystem handle or permission. */
export interface InstallationFileIdentity {
  readonly dev: string;
  readonly ino: string;
}
export interface InstallationJournalRoots {
  readonly installation: InstallationFileIdentity;
  readonly state: InstallationFileIdentity;
}
export interface InstallationMarkerFields {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly tag: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
}
export interface InstallationReleaseEvidence {
  readonly tupleSha256: string;
  readonly authorizationPayloadSha256: string;
  readonly native: { readonly sha256: string; readonly size: number };
  readonly marker: {
    readonly fields: InstallationMarkerFields;
    readonly sha256: string;
    readonly size: number;
  };
  readonly snapshotId: string;
}
const OWNED_SLOTS = ["staged-executable", "staged-marker", "previous-executable", "previous-marker",
  "windows-inner-journal", "launch-descriptor"] as const;
export type InstallationOwnedSlot = (typeof OWNED_SLOTS)[number];
const MUTATION_SLOTS = [...OWNED_SLOTS, "canonical-executable", "canonical-marker", "active-pointer",
  "installation-journal", "installation-control", "retention-catalog"] as const;
export type InstallationMutationSlot = (typeof MUTATION_SLOTS)[number];
type SlotContent = {
  readonly name: InstallationOwnedSlot;
  readonly expectedSha256: string;
  readonly expectedSize: number;
};
export type InstallationSlot =
  | (SlotContent & { readonly state: "intent" })
  | (SlotContent & { readonly state: "created"; readonly identity: InstallationFileIdentity });

export interface InstallationOperationEvidence {
  readonly authorityEpoch: number;
  readonly workerId: string;
  readonly operationId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly expectedRevision: number;
  readonly previousTupleSha256: string;
  readonly nextTupleSha256: string;
  readonly admittedSlots: readonly InstallationMutationSlot[];
  readonly status: "running" | "drained" | "revoked";
  readonly receiptSha256: string;
}
export interface InstallationProcessIdentity {
  readonly pid: number;
  readonly startKey: string;
  readonly launchNonce: string;
}
export type InstallationSettlement =
  | { readonly state: "unsettled" }
  | {
      readonly state: "settled";
      readonly launchId: string;
      readonly reservationId: string;
      readonly descriptorSha256: string;
      readonly targetIdentity: InstallationFileIdentity;
      readonly parent: InstallationProcessIdentity;
      readonly child: InstallationProcessIdentity | null;
      readonly receiptSha256: string;
    };
export interface InstallationLaunchEvidence {
  readonly launchId: string;
  readonly reservationId: string;
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly authorityEpoch: number;
  readonly expectedRevision: number;
  readonly nextTupleSha256: string;
  readonly nextNativeSha256: string;
  readonly targetIdentity: InstallationFileIdentity;
  readonly descriptorSha256: string;
  readonly grantSha256: string | null;
  readonly parent: InstallationProcessIdentity;
  readonly child: InstallationProcessIdentity | null;
  readonly state: InstallationLaunchState;
  readonly exitCode: number | null;
  readonly settlement: InstallationSettlement;
}
export interface InstallationInnerEvidence {
  readonly attemptId: string;
  readonly transactionId: string;
  readonly roots: InstallationJournalRoots;
  readonly previousTupleSha256: string;
  readonly nextTupleSha256: string;
  readonly previousNativeSha256: string;
  readonly nextNativeSha256: string;
  readonly slot: "windows-inner-journal";
  readonly identity: InstallationFileIdentity;
  readonly sha256: string;
  readonly size: number;
}
export interface InstallationJournal {
  readonly journalVersion: 1;
  readonly attemptId: string;
  readonly transactionId: string;
  readonly operation: "apply" | "rollback";
  readonly platform: "darwin-arm64" | "windows-x64";
  readonly installationId: string;
  readonly enrollmentId: string;
  readonly roots: InstallationJournalRoots;
  readonly revision: number;
  readonly phase: InstallationJournalPhase;
  readonly outcome: "previous" | "next" | null;
  readonly previous: ReleaseSetRecord;
  readonly next: ReleaseSetRecord;
  readonly previousEvidence: InstallationReleaseEvidence;
  readonly nextEvidence: InstallationReleaseEvidence;
  readonly authorization: {
    readonly sequence: number;
    readonly payloadSha256: string;
    readonly trustStateSha256: string;
  };
  readonly slots: readonly InstallationSlot[];
  readonly control: { readonly authorityEpoch: number; readonly operations: readonly InstallationOperationEvidence[] };
  readonly windows: { readonly inner: InstallationInnerEvidence | null; readonly launch: InstallationLaunchEvidence | null } | null;
  readonly terminalEvidenceSha256: string | null;
}

const JOURNAL_FIELDS = ["journalVersion", "attemptId", "transactionId", "operation", "platform", "installationId", "enrollmentId",
  "roots", "revision", "phase", "outcome", "previous", "next", "previousEvidence", "nextEvidence", "authorization", "slots",
  "control", "windows", "terminalEvidenceSha256"] as const;
const RELEASE_FIELDS = ["cacheVersion", "recordType", "releaseSetId", "cliVersion", "cliSha256", "templateVersion", "templateSha256",
  "manifestVersion", "inputSchema", "policySchema", "manifestSequence", "transactionId", "receiptSha256"] as const;
const SLOT_FIELDS = ["name", "state", "expectedSha256", "expectedSize"] as const;
const OPERATION_FIELDS = ["authorityEpoch", "workerId", "operationId", "attemptId", "transactionId", "expectedRevision",
  "previousTupleSha256", "nextTupleSha256", "admittedSlots", "status", "receiptSha256"] as const;
const LAUNCH_FIELDS = ["launchId", "reservationId", "installationId", "enrollmentId", "attemptId", "transactionId", "authorityEpoch",
  "expectedRevision", "nextTupleSha256", "nextNativeSha256", "targetIdentity", "descriptorSha256", "grantSha256", "parent", "child",
  "state", "exitCode", "settlement"] as const;
const SETTLEMENT_FIELDS = ["state", "launchId", "reservationId", "descriptorSha256", "targetIdentity", "parent", "child", "receiptSha256"] as const;
const SHA256 = /^[a-f0-9]{64}$/u;
const RANDOM_ID = /^[a-f0-9]{32}$/u;
const TRANSACTION_ID = /^release-[a-f0-9]{32}$/u;
const MAX_OPERATIONS = 16;
const MAX_MARKER_BYTES = 4096;
const terminalPhases: readonly InstallationJournalPhase[] = ["committed", "aborted", "retention-transfer"];
const preparedPhases: readonly InstallationJournalPhase[] = ["prepared", "execution-pending", "publish-intent", "canonical-published",
  "marker-published", "commit-intent", "committed"];
const publicationPhases: readonly InstallationJournalPhase[] = ["publish-intent", "canonical-published", "marker-published", "commit-intent", "committed"];

function fail(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "installation journal is invalid", {
    field: "installationJournal", expected: "bounded canonical installation evidence", actual: "invalid",
    safeNextStep: "Preserve installation evidence and run self-update repair.",
  });
}

/** Never read caller properties or walk proxies before descriptor/prototype checks. */
function record<const K extends readonly string[]>(value: unknown, keys: K): { readonly [P in K[number]]: unknown } {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail();
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) fail();
  const copy: { [P in K[number]]?: unknown } = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
    Object.defineProperty(copy, key, { enumerable: true, value: descriptor.value });
  }
  return copy as { readonly [P in K[number]]: unknown };
}

/** Inspect the discriminant without ever invoking an accessor; record() closes the schema next. */
function discriminant(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || types.isProxy(value) || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype) fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
  return descriptor.value;
}

function list<T>(value: unknown, minimum: number, maximum: number, read: (value: unknown) => T): readonly T[] {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype) fail();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (lengthDescriptor === undefined || !("value" in lengthDescriptor)) fail();
  const length = integer(lengthDescriptor.value, minimum, maximum);
  if (Reflect.ownKeys(value).length !== length + 1) fail();
  const result: T[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
    result.push(read(descriptor.value));
  }
  return Object.freeze(result);
}

function integer(value: unknown, minimum = 1, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) fail();
  return value;
}
function text(value: unknown, pattern: RegExp, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || !pattern.test(value)) fail();
  return value;
}
const hash = (value: unknown): string => text(value, SHA256, 64);
const id = (value: unknown): string => text(value, RANDOM_ID, 32);
const transaction = (value: unknown): string => text(value, TRANSACTION_ID, 40);
const canonicalHash = (value: unknown): string => sha256Utf8(canonicalizeJson(value));
function choice<const T extends readonly string[]>(value: unknown, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) fail();
  return value as T[number];
}
function equal(left: unknown, right: unknown): void { if (left !== right) fail(); }
function equalData(left: unknown, right: unknown): void { equal(canonicalizeJson(left), canonicalizeJson(right)); }

function fileIdentity(value: unknown): InstallationFileIdentity {
  const item = record(value, ["dev", "ino"]);
  const dev = text(item.dev, /^(?:0|[1-9][0-9]{0,19})$/u, 20);
  const ino = text(item.ino, /^[1-9][0-9]{0,19}$/u, 20);
  if (BigInt(dev) > 0xffffffffffffffffn || BigInt(ino) > 0xffffffffffffffffn) fail();
  return Object.freeze({ dev, ino });
}
const identityKey = (value: InstallationFileIdentity): string => `${value.dev}:${value.ino}`;
function roots(value: unknown): InstallationJournalRoots {
  const item = record(value, ["installation", "state"]);
  const installation = fileIdentity(item.installation), state = fileIdentity(item.state);
  if (identityKey(installation) === identityKey(state)) fail();
  return Object.freeze({ installation, state });
}

function releaseRecord(value: unknown): ReleaseSetRecord {
  const guarded = record(value, RELEASE_FIELDS);
  // The source validator receives a detached ordinary data record, never caller getters/proxies.
  const result = validateReleaseSetRecord(guarded);
  const { transactionId, ...identity } = result;
  equal(transactionId, `release-${sha256Utf8(`${canonicalizeJson(identity)}\n`).slice(0, 32)}`);
  return result;
}
function releaseEvidence(value: unknown, release: ReleaseSetRecord): InstallationReleaseEvidence {
  const item = record(value, ["tupleSha256", "authorizationPayloadSha256", "native", "marker", "snapshotId"]);
  equal(item.tupleSha256, sha256Utf8(canonicalizeJson(release)));
  equal(item.snapshotId, release.transactionId);
  const rawNative = record(item.native, ["sha256", "size"]);
  const native = Object.freeze({ sha256: hash(rawNative.sha256), size: integer(rawNative.size, 1, MAX_CACHE_CLI_BYTES) });
  const rawMarker = record(item.marker, ["fields", "sha256", "size"]);
  const marker = record(rawMarker.fields, ["schemaVersion", "repository", "tag", "archiveSha256", "executableSha256"]);
  equal(marker.schemaVersion, 1);
  equal(marker.tag, `cli-v${release.cliVersion}`);
  equal(marker.archiveSha256, release.cliSha256);
  equal(marker.executableSha256, native.sha256);
  const fields: InstallationMarkerFields = Object.freeze({ schemaVersion: 1,
    repository: text(marker.repository, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/u, 201),
    tag: `cli-v${release.cliVersion}`, archiveSha256: release.cliSha256, executableSha256: native.sha256 });
  const markerText = `${canonicalizeJson(fields)}\n`;
  equal(rawMarker.sha256, sha256Utf8(markerText));
  equal(rawMarker.size, new TextEncoder().encode(markerText).length);
  return Object.freeze({ tupleSha256: hash(item.tupleSha256), authorizationPayloadSha256: hash(item.authorizationPayloadSha256),
    native, marker: Object.freeze({ fields, sha256: hash(rawMarker.sha256), size: integer(rawMarker.size, 1, MAX_MARKER_BYTES) }),
    snapshotId: transaction(item.snapshotId) });
}
function slot(value: unknown): InstallationSlot {
  const state = choice(discriminant(value, "state"), ["intent", "created"]);
  const item = record(value, state === "intent" ? SLOT_FIELDS : [...SLOT_FIELDS, "identity"] as const);
  const content = { name: choice(item.name, OWNED_SLOTS), expectedSha256: hash(item.expectedSha256),
    expectedSize: integer(item.expectedSize, 1, MAX_CACHE_CLI_BYTES) };
  return state === "intent" ? Object.freeze({ ...content, state }) :
    Object.freeze({ ...content, state, identity: fileIdentity(item.identity) });
}
function operation(value: unknown): InstallationOperationEvidence {
  const item = record(value, OPERATION_FIELDS);
  const admittedSlots = list(item.admittedSlots, 1, MUTATION_SLOTS.length, value => choice(value, MUTATION_SLOTS));
  if (new Set(admittedSlots).size !== admittedSlots.length) fail();
  const binding = {
    authorityEpoch: integer(item.authorityEpoch), workerId: id(item.workerId), operationId: id(item.operationId),
    attemptId: id(item.attemptId), transactionId: transaction(item.transactionId), expectedRevision: integer(item.expectedRevision),
    previousTupleSha256: hash(item.previousTupleSha256), nextTupleSha256: hash(item.nextTupleSha256), admittedSlots,
    status: choice(item.status, ["running", "drained", "revoked"]),
  };
  equal(item.receiptSha256, canonicalHash(binding));
  return Object.freeze({ ...binding, receiptSha256: hash(item.receiptSha256) });
}
function processIdentity(value: unknown): InstallationProcessIdentity {
  const item = record(value, ["pid", "startKey", "launchNonce"]);
  return Object.freeze({ pid: integer(item.pid, 1, 0xffffffff),
    startKey: text(item.startKey, /^win:[1-9][0-9]{0,19}$/u, 24), launchNonce: id(item.launchNonce) });
}
function settlement(value: unknown): InstallationSettlement {
  const state = choice(discriminant(value, "state"), ["unsettled", "settled"]);
  if (state === "unsettled") { record(value, ["state"]); return Object.freeze({ state }); }
  const item = record(value, SETTLEMENT_FIELDS);
  const binding = { state, launchId: id(item.launchId), reservationId: id(item.reservationId),
    descriptorSha256: hash(item.descriptorSha256), targetIdentity: fileIdentity(item.targetIdentity),
    parent: processIdentity(item.parent), child: item.child === null ? null : processIdentity(item.child) };
  equal(item.receiptSha256, canonicalHash(binding));
  return Object.freeze({ ...binding, receiptSha256: hash(item.receiptSha256) });
}
function launch(value: unknown): InstallationLaunchEvidence {
  const item = record(value, LAUNCH_FIELDS);
  const state = choice(item.state, ["reserved", "registered", "claimed", "ack-issued", "admitted", "completed", "outcome-unknown", "revoked"]);
  const parent = processIdentity(item.parent), child = item.child === null ? null : processIdentity(item.child);
  const grantSha256 = item.grantSha256 === null ? null : hash(item.grantSha256);
  const exitCode = item.exitCode === null ? null : integer(item.exitCode, 0, 255);
  if (child !== null && (child.pid === parent.pid || child.launchNonce === parent.launchNonce)) fail();
  if (state === "reserved") { if (child !== null || grantSha256 !== null) fail(); }
  else if (state === "registered" || state === "claimed") { if (child === null || grantSha256 !== null) fail(); }
  else if (state !== "revoked") { if (child === null || grantSha256 === null) fail(); }
  else if (grantSha256 !== null && child === null) fail();
  if (state === "completed" ? exitCode === null : exitCode !== null) fail();
  const result: InstallationLaunchEvidence = Object.freeze({
    launchId: id(item.launchId), reservationId: id(item.reservationId), installationId: id(item.installationId), enrollmentId: id(item.enrollmentId),
    attemptId: id(item.attemptId), transactionId: transaction(item.transactionId), authorityEpoch: integer(item.authorityEpoch),
    expectedRevision: integer(item.expectedRevision), nextTupleSha256: hash(item.nextTupleSha256), nextNativeSha256: hash(item.nextNativeSha256),
    targetIdentity: fileIdentity(item.targetIdentity), descriptorSha256: hash(item.descriptorSha256), grantSha256,
    parent, child, state, exitCode, settlement: settlement(item.settlement),
  });
  if (result.settlement.state === "settled") {
    if (!["completed", "outcome-unknown", "revoked"].includes(state)) fail();
    const bound = result.settlement;
    equal(bound.launchId, result.launchId); equal(bound.reservationId, result.reservationId);
    equal(bound.descriptorSha256, result.descriptorSha256); equalData(bound.targetIdentity, result.targetIdentity);
    equalData(bound.parent, parent); equalData(bound.child, child);
  }
  return result;
}
export function validateInstallationLaunchEvidence(value: unknown): InstallationLaunchEvidence {
  try { return launch(value); } catch { return fail(); }
}

function inner(value: unknown): InstallationInnerEvidence {
  const item = record(value, ["attemptId", "transactionId", "roots", "previousTupleSha256", "nextTupleSha256", "previousNativeSha256",
    "nextNativeSha256", "slot", "identity", "sha256", "size"]);
  equal(item.slot, "windows-inner-journal");
  return Object.freeze({ attemptId: id(item.attemptId), transactionId: transaction(item.transactionId), roots: roots(item.roots),
    previousTupleSha256: hash(item.previousTupleSha256), nextTupleSha256: hash(item.nextTupleSha256),
    previousNativeSha256: hash(item.previousNativeSha256), nextNativeSha256: hash(item.nextNativeSha256),
    slot: "windows-inner-journal", identity: fileIdentity(item.identity), sha256: hash(item.sha256),
    size: integer(item.size, 1, 32 * 1024) });
}

function readJournal(value: unknown): InstallationJournal {
  const item = record(value, JOURNAL_FIELDS);
  equal(item.journalVersion, 1);
  const previous = releaseRecord(item.previous), next = releaseRecord(item.next);
  const authorization = record(item.authorization, ["sequence", "payloadSha256", "trustStateSha256"]);
  const control = record(item.control, ["authorityEpoch", "operations"]);
  const rawWindows = item.windows === null ? null : record(item.windows, ["inner", "launch"]);
  const result: InstallationJournal = Object.freeze({ journalVersion: 1, attemptId: id(item.attemptId),
    transactionId: transaction(item.transactionId), operation: choice(item.operation, ["apply", "rollback"]),
    platform: choice(item.platform, ["darwin-arm64", "windows-x64"]), installationId: id(item.installationId), enrollmentId: id(item.enrollmentId),
    roots: roots(item.roots), revision: integer(item.revision), phase: choice(item.phase, INSTALLATION_JOURNAL_PHASES),
    outcome: item.outcome === null ? null : choice(item.outcome, ["previous", "next"]), previous, next,
    previousEvidence: releaseEvidence(item.previousEvidence, previous), nextEvidence: releaseEvidence(item.nextEvidence, next),
    authorization: Object.freeze({ sequence: integer(authorization.sequence), payloadSha256: hash(authorization.payloadSha256),
      trustStateSha256: hash(authorization.trustStateSha256) }),
    slots: list(item.slots, 4, OWNED_SLOTS.length, slot),
    control: Object.freeze({ authorityEpoch: integer(control.authorityEpoch), operations: list(control.operations, 1, MAX_OPERATIONS, operation) }),
    windows: rawWindows === null ? null : Object.freeze({ inner: rawWindows.inner === null ? null : inner(rawWindows.inner),
      launch: rawWindows.launch === null ? null : launch(rawWindows.launch) }),
    terminalEvidenceSha256: item.terminalEvidenceSha256 === null ? null : hash(item.terminalEvidenceSha256),
  });
  checkBindings(result);
  return result;
}

function createdSlot(journal: InstallationJournal, name: InstallationOwnedSlot): Extract<InstallationSlot, { state: "created" }> {
  const found = journal.slots.find(slot => slot.name === name);
  if (found === undefined || found.state !== "created") fail();
  return found;
}
function checkInventory(journal: InstallationJournal): void {
  const names = new Set<InstallationOwnedSlot>();
  const physical = new Set([identityKey(journal.roots.installation), identityKey(journal.roots.state)]);
  for (const slot of journal.slots) {
    if (names.has(slot.name)) fail();
    names.add(slot.name);
    if (slot.state === "created") {
      const key = identityKey(slot.identity);
      if (physical.has(key)) fail();
      physical.add(key);
    }
    const expected = slot.name === "staged-executable" ? journal.nextEvidence.native :
      slot.name === "staged-marker" ? journal.nextEvidence.marker :
      slot.name === "previous-executable" ? journal.previousEvidence.native :
      slot.name === "previous-marker" ? journal.previousEvidence.marker : null;
    if (expected !== null) { equal(slot.expectedSha256, expected.sha256); equal(slot.expectedSize, expected.size); }
    if (journal.platform === "darwin-arm64" && (slot.name === "windows-inner-journal" || slot.name === "launch-descriptor")) fail();
  }
  for (const name of OWNED_SLOTS.slice(0, 4)) {
    if (!names.has(name)) fail();
    if (preparedPhases.includes(journal.phase) || (journal.phase === "retention-transfer" && journal.outcome === "next")) createdSlot(journal, name);
  }
}
function checkControl(journal: InstallationJournal): void {
  const workers = new Set<string>(), operations = new Set<string>();
  let revision = 0, epoch = 0;
  const receipts = journal.control.operations;
  for (const [index, op] of receipts.entries()) {
    equal(op.attemptId, journal.attemptId); equal(op.transactionId, journal.transactionId);
    equal(op.previousTupleSha256, journal.previousEvidence.tupleSha256); equal(op.nextTupleSha256, journal.nextEvidence.tupleSha256);
    if (op.authorityEpoch < epoch || op.authorityEpoch > journal.control.authorityEpoch ||
      op.expectedRevision <= revision || op.expectedRevision > journal.revision || workers.has(op.workerId) || operations.has(op.operationId)) fail();
    epoch = op.authorityEpoch; revision = op.expectedRevision;
    workers.add(op.workerId); operations.add(op.operationId);
    if (op.status === "running" && (index !== receipts.length - 1 || op.authorityEpoch !== journal.control.authorityEpoch ||
      op.expectedRevision !== journal.revision || terminalPhases.includes(journal.phase))) fail();
    for (const name of op.admittedSlots) {
      if ((OWNED_SLOTS as readonly string[]).includes(name) && !journal.slots.some(slot => slot.name === name)) fail();
    }
  }
}
function checkWindows(journal: InstallationJournal): void {
  const windows = journal.windows;
  if (journal.platform === "darwin-arm64") {
    if (windows !== null || journal.phase === "execution-pending") fail();
    return;
  }
  if (windows === null) fail();
  if (windows.inner !== null) {
    const bound = windows.inner, slot = createdSlot(journal, "windows-inner-journal");
    equal(bound.attemptId, journal.attemptId); equal(bound.transactionId, journal.transactionId);
    equalData(bound.roots, journal.roots);
    equal(bound.previousTupleSha256, journal.previousEvidence.tupleSha256); equal(bound.nextTupleSha256, journal.nextEvidence.tupleSha256);
    equal(bound.previousNativeSha256, journal.previousEvidence.native.sha256); equal(bound.nextNativeSha256, journal.nextEvidence.native.sha256);
    equalData(bound.identity, slot.identity); equal(bound.sha256, slot.expectedSha256); equal(bound.size, slot.expectedSize);
  } else if (journal.slots.some(slot => slot.name === "windows-inner-journal" && slot.state === "created") ||
    ["canonical-published", "marker-published", "commit-intent", "committed"].includes(journal.phase) ||
    (journal.phase === "retention-transfer" && journal.outcome === "next")) fail();
  const bound = windows.launch;
  if (bound === null) {
    if (journal.phase === "execution-pending" || journal.slots.some(slot => slot.name === "launch-descriptor")) fail();
    return;
  }
  equal(bound.installationId, journal.installationId); equal(bound.enrollmentId, journal.enrollmentId);
  equal(bound.attemptId, journal.attemptId); equal(bound.transactionId, journal.transactionId);
  equal(bound.nextTupleSha256, journal.nextEvidence.tupleSha256); equal(bound.nextNativeSha256, journal.nextEvidence.native.sha256);
  if (bound.authorityEpoch > journal.control.authorityEpoch || bound.expectedRevision > journal.revision) fail();
  equalData(bound.targetIdentity, createdSlot(journal, "staged-executable").identity);
  equal(bound.descriptorSha256, createdSlot(journal, "launch-descriptor").expectedSha256);
  if (journal.phase === "execution-pending" && !["admitted", "completed", "outcome-unknown"].includes(bound.state)) fail();
  if ((publicationPhases.includes(journal.phase) || terminalPhases.includes(journal.phase)) && bound.settlement.state !== "settled") fail();
}
function checkBindings(journal: InstallationJournal): void {
  equal(journal.transactionId, journal.next.transactionId);
  if (journal.attemptId === journal.next.transactionId || journal.attemptId === journal.previous.transactionId ||
    journal.next.manifestSequence <= journal.previous.manifestSequence) fail();
  equal(journal.authorization.sequence, journal.next.manifestSequence);
  equal(journal.authorization.payloadSha256, journal.nextEvidence.authorizationPayloadSha256);
  equal(journal.previousEvidence.marker.fields.repository, journal.nextEvidence.marker.fields.repository);
  const { phase, outcome } = journal;
  if (phase === "committed") equal(outcome, "next");
  else if (phase === "compensating" || phase === "aborted") equal(outcome, "previous");
  else if (phase === "retention-transfer") { if (outcome === null) fail(); }
  else if (phase !== "blocked") equal(outcome, null);
  checkInventory(journal); checkControl(journal); checkWindows(journal);
  if (terminalPhases.includes(phase)) {
    const { phase: _phase, revision: _revision, terminalEvidenceSha256: _digest, ...evidence } = journal;
    equal(journal.terminalEvidenceSha256, canonicalHash(evidence));
  } else equal(journal.terminalEvidenceSha256, null);
}

function encodeChecked(journal: InstallationJournal): Uint8Array {
  const bytes = new TextEncoder().encode(`${canonicalizeJson(journal)}\n`);
  if (bytes.length > MAX_INSTALLATION_JOURNAL_BYTES) fail();
  return bytes;
}

/** Validate syntax/bindings only, returning detached deep-frozen plain data. */
export function validateInstallationJournal(value: unknown): InstallationJournal {
  try {
    const journal = readJournal(value);
    encodeChecked(journal);
    return journal;
  } catch { return fail(); }
}

/** Deterministic UTF-8 JCS + LF. Output bytes are newly owned by the caller. */
export function encodeInstallationJournal(value: unknown): Uint8Array {
  try { return encodeChecked(readJournal(value)); } catch { return fail(); }
}

function ownedBytes(value: unknown): Uint8Array {
  if (value === null || typeof value !== "object" || types.isProxy(value) || !types.isUint8Array(value)) fail();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) fail();
  // Intrinsic getters ignore malicious own byteLength/buffer properties.
  const typedArray = Object.getPrototypeOf(Uint8Array.prototype) as object;
  const length = integer(Object.getOwnPropertyDescriptor(typedArray, "byteLength")!.get!.call(value), 1, MAX_INSTALLATION_JOURNAL_BYTES);
  const buffer: unknown = Object.getOwnPropertyDescriptor(typedArray, "buffer")!.get!.call(value);
  if (!types.isArrayBuffer(buffer) || types.isSharedArrayBuffer(buffer) ||
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "resizable")!.get!.call(buffer)) fail();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== length) fail();
  for (let index = 0; index < length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) fail();
  }
  const copy = new Uint8Array(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

/** Strict canonical bytes only; no fallback, quarantine, mutation or authentication. */
export function parseInstallationJournal(bytes: Uint8Array): InstallationJournal {
  try {
    const owned = ownedBytes(bytes);
    // ignoreBOM:true preserves a BOM, allowing strict JSON/canonical equality to reject it.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(owned);
    const journal = readJournal(parseStrictJson(text));
    equal(text, new TextDecoder().decode(encodeChecked(journal)));
    return journal;
  } catch { return fail(); }
}
