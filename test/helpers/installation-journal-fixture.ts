import { createHash } from "node:crypto";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { validateReleaseSetRecord, type ReleaseSetRecord } from "../../src/update/cache.ts";
import { tupleDigest } from "../../src/update/journal.ts";
import type {
  InstallationJournal,
  InstallationJournalPhase,
  InstallationLaunchState,
  InstallationOperationEvidence,
  InstallationSettlement,
} from "../../src/update/installation-journal.ts";

type Mutable<T> = T extends readonly (infer V)[] ? Mutable<V>[] :
  T extends object ? { -readonly [K in keyof T]: Mutable<T[K]> } : T;
export type JournalFixture = Mutable<InstallationJournal>;
export const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
export const canonicalBytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${canonicalizeJson(value)}\n`);
export const checksum = (value: unknown): string => digest(canonicalizeJson(value));
export const randomId = (n: number): string => n.toString(16).padStart(32, "0");

/** Synthetic schema evidence, NOT signed fixtures, executable readiness or authentication. */
function release(platform: InstallationJournal["platform"], version: string, sequence: number) {
  const member = new Uint8Array(512).fill(sequence);
  // Distinct plausible native headers; these bytes are never executed.
  if (platform === "darwin-arm64") {
    const view = new DataView(member.buffer);
    view.setUint32(0, 0xfeedfacf, true);
    view.setUint32(4, 0x0100000c, true);
    view.setUint32(12, 2, true);
  } else {
    member[0] = 0x4d; member[1] = 0x5a;
    new DataView(member.buffer).setUint32(0x3c, 128, true);
    member.set([0x50, 0x45, 0, 0, 0x64, 0x86], 128);
  }
  const identity: Omit<ReleaseSetRecord, "transactionId"> = {
    cacheVersion: 1, recordType: "active-release-set", releaseSetId: `release-set-${sequence}`,
    cliVersion: version, cliSha256: digest(`synthetic zip:${platform}:${version}`),
    templateVersion: "0.1.5", templateSha256: digest("unchanged template archive 42"),
    manifestVersion: 1, inputSchema: 1, policySchema: 1, manifestSequence: sequence,
    receiptSha256: digest(`synthetic provenance:${platform}:${sequence}`),
  };
  const record = validateReleaseSetRecord({
    ...identity, transactionId: `release-${digest(canonicalBytes(identity)).slice(0, 32)}`,
  });
  const fields = {
    schemaVersion: 1 as const, repository: "example/harness-mrtool", tag: `cli-v${version}`,
    archiveSha256: record.cliSha256, executableSha256: digest(member),
  };
  const markerBytes = canonicalBytes(fields);
  return {
    record,
    evidence: {
      tupleSha256: tupleDigest(record), authorizationPayloadSha256: digest(`signed payload ${platform} ${sequence}`),
      native: { sha256: digest(member), size: member.length },
      marker: { fields, sha256: digest(markerBytes), size: markerBytes.length },
      snapshotId: record.transactionId,
    },
  };
}

export function sealOperation<T extends InstallationOperationEvidence>(operation: T): T {
  const { receiptSha256: _receipt, ...binding } = operation;
  return { ...operation, receiptSha256: checksum(binding) };
}

export function sealSettlement<T extends Extract<InstallationSettlement, { state: "settled" }>>(settlement: T): T {
  const { receiptSha256: _receipt, ...binding } = settlement;
  return { ...settlement, receiptSha256: checksum(binding) };
}

export function sealTerminal(journal: JournalFixture): JournalFixture {
  const { phase, revision: _revision, terminalEvidenceSha256: _digest, ...evidence } = journal;
  journal.terminalEvidenceSha256 = ["committed", "aborted", "retention-transfer"].includes(phase) ? checksum(evidence) : null;
  return journal;
}

export function withLaunch(journal: JournalFixture, state: InstallationLaunchState): JournalFixture {
  if (journal.windows === null) throw new Error("Windows fixture required");
  const target = journal.slots.find(s => s.name === "staged-executable");
  if (target?.state !== "created") throw new Error("Created target fixture required");
  const descriptorSha256 = digest("private descriptor bytes, never persisted in this journal");
  journal.slots = journal.slots.filter(s => s.name !== "launch-descriptor");
  journal.slots.push({ name: "launch-descriptor", state: "created", expectedSha256: descriptorSha256,
    expectedSize: 128, identity: { dev: "2", ino: "106" } });
  const parent = { pid: 200, startKey: "win:134000000000000000", launchNonce: randomId(90) };
  const child = state === "reserved" ? null : { pid: 201, startKey: "win:134000000000000001", launchNonce: randomId(91) };
  const launch = {
    launchId: randomId(80), reservationId: randomId(81), installationId: journal.installationId,
    enrollmentId: journal.enrollmentId, attemptId: journal.attemptId, transactionId: journal.transactionId,
    authorityEpoch: journal.control.authorityEpoch, expectedRevision: journal.revision,
    nextTupleSha256: journal.nextEvidence.tupleSha256, nextNativeSha256: journal.nextEvidence.native.sha256,
    targetIdentity: { ...target.identity }, descriptorSha256,
    grantSha256: ["ack-issued", "admitted", "completed", "outcome-unknown"].includes(state) ? digest("one-use grant") : null,
    parent, child, state, exitCode: state === "completed" ? 0 : null,
    settlement: { state: "unsettled" as const } as Mutable<InstallationSettlement>,
  };
  if (["completed", "outcome-unknown", "revoked"].includes(state)) {
    launch.settlement = sealSettlement({ state: "settled", launchId: launch.launchId,
      reservationId: launch.reservationId, descriptorSha256, targetIdentity: { ...target.identity },
      parent: { ...parent }, child: child === null ? null : { ...child }, receiptSha256: "" });
  }
  journal.windows.launch = launch;
  return sealTerminal(journal);
}

export function journalFixture(
  platform: InstallationJournal["platform"] = "darwin-arm64",
  phase: InstallationJournalPhase = "prepared",
): JournalFixture {
  const previous = release(platform, "0.1.6", 43);
  const next = release(platform, "0.1.7", 44);
  const journal: JournalFixture = {
    journalVersion: 1, attemptId: randomId(1), transactionId: next.record.transactionId,
    operation: "apply", platform, installationId: randomId(2), enrollmentId: randomId(3),
    roots: { installation: { dev: "2", ino: "100" }, state: { dev: "3", ino: "200" } },
    revision: 10, phase,
    outcome: phase === "committed" || phase === "retention-transfer" ? "next" :
      phase === "compensating" || phase === "aborted" ? "previous" : null,
    previous: { ...previous.record }, next: { ...next.record },
    previousEvidence: previous.evidence, nextEvidence: next.evidence,
    authorization: { sequence: next.record.manifestSequence,
      payloadSha256: next.evidence.authorizationPayloadSha256, trustStateSha256: digest("accepted state 44") },
    slots: [
      { name: "staged-executable", state: "created", expectedSha256: next.evidence.native.sha256,
        expectedSize: next.evidence.native.size, identity: { dev: "2", ino: "101" } },
      { name: "staged-marker", state: "created", expectedSha256: next.evidence.marker.sha256,
        expectedSize: next.evidence.marker.size, identity: { dev: "2", ino: "102" } },
      { name: "previous-executable", state: "created", expectedSha256: previous.evidence.native.sha256,
        expectedSize: previous.evidence.native.size, identity: { dev: "2", ino: "103" } },
      { name: "previous-marker", state: "created", expectedSha256: previous.evidence.marker.sha256,
        expectedSize: previous.evidence.marker.size, identity: { dev: "2", ino: "104" } },
    ],
    control: { authorityEpoch: 5, operations: [] },
    windows: platform === "windows-x64" ? { inner: null, launch: null } : null,
    terminalEvidenceSha256: null,
  };
  journal.control.operations.push(sealOperation({ authorityEpoch: 5, workerId: randomId(10), operationId: randomId(11),
    attemptId: journal.attemptId, transactionId: journal.transactionId, expectedRevision: journal.revision,
    previousTupleSha256: journal.previousEvidence.tupleSha256, nextTupleSha256: journal.nextEvidence.tupleSha256,
    admittedSlots: ["staged-executable", "staged-marker", "previous-executable", "previous-marker", "installation-journal"],
    status: "drained", receiptSha256: "" }));
  if (journal.windows !== null) {
    const identity = { dev: "2", ino: "105" }, sha256 = digest("synthetic inner journal evidence"), size = 1024;
    journal.slots.push({ name: "windows-inner-journal", state: "created", expectedSha256: sha256, expectedSize: size, identity });
    journal.windows.inner = { attemptId: journal.attemptId, transactionId: journal.transactionId,
      roots: structuredClone(journal.roots), previousTupleSha256: journal.previousEvidence.tupleSha256,
      nextTupleSha256: journal.nextEvidence.tupleSha256, previousNativeSha256: journal.previousEvidence.native.sha256,
      nextNativeSha256: journal.nextEvidence.native.sha256, slot: "windows-inner-journal", identity: { ...identity }, sha256, size };
    if (phase === "execution-pending") withLaunch(journal, "admitted");
  }
  return sealTerminal(journal);
}
