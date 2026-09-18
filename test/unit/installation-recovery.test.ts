import assert from "node:assert/strict";
import test from "node:test";
import {
  decideInstallationRecovery,
  type InstallationRecoveryState,
  type RecoveryFacts,
} from "../../src/update/installation-recovery.ts";

const stable: RecoveryFacts = Object.freeze({
  canonical: "previous", marker: "previous", active: "previous",
  previousComplete: true, nextComplete: true,
  enrollment: "enrolled", policyContinuity: "current",
  writerAuthority: "fenced-current-epoch", launch: "none", retention: "current",
  knownPolicyAllowsPrevious: true, knownPolicyAllowsNext: true, innerBinding: "none",
});
const state = (phase: InstallationRecoveryState["phase"],
  outcome: InstallationRecoveryState["outcome"] = null,
  platform: InstallationRecoveryState["platform"] = "darwin-arm64"): InstallationRecoveryState => ({ phase, outcome, platform });
const facts = (overrides: Partial<RecoveryFacts> = {}): RecoveryFacts => ({ ...stable, ...overrides });

test("stable selection follows the complete active tuple, not identical executable bytes", () => {
  assert.equal(decideInstallationRecovery(null, stable), "verify-stable-previous");
  assert.equal(decideInstallationRecovery(null, facts({ canonical: "both", marker: "both" })), "verify-stable-previous");
  assert.equal(decideInstallationRecovery(null, facts({ canonical: "both", marker: "both", active: "next" })), "verify-stable-next");
  assert.equal(decideInstallationRecovery(null, facts({ canonical: "next", marker: "previous" })), "block");
  assert.equal(decideInstallationRecovery(null, facts({ active: "absent" })), "block");
  assert.equal(decideInstallationRecovery(null, facts({ nextComplete: false, active: "next", canonical: "next", marker: "next" })), "block");
});

for (const [name, override] of Object.entries({
  unenrolled: { enrollment: "unenrolled" }, enrolling: { enrollment: "enrolling" }, conflictingRoots: { enrollment: "inconsistent" },
  missingTrust: { policyContinuity: "unprovable" }, unrepairedCheckpoint: { policyContinuity: "exact-checkpoint-repair" },
  unknownWriter: { writerAuthority: "unproven" }, foreignMarker: { marker: "invalid" },
  foreignExecutable: { canonical: "invalid" }, invalidPointer: { active: "invalid" },
  foreignInner: { innerBinding: "mismatched" }, invalidRetention: { retention: "invalid" },
})) {
  test(`recovery blocks ${name} before selecting a mutation`, () => {
    assert.equal(decideInstallationRecovery(state("publish-intent"), facts(override as Partial<RecoveryFacts>)), "block");
  });
}

test("held writer authority and unsettled launch users cannot be treated as dead", () => {
  assert.equal(decideInstallationRecovery(state("prepared"), facts({ writerAuthority: "held-elsewhere" })), "wait-owner");
  for (const launch of ["pre-admission", "admitted-live", "unsettled"] as const) {
    assert.equal(decideInstallationRecovery(state("execution-pending", null, "windows-x64"), facts({ launch })), "wait-owner");
  }
  assert.equal(decideInstallationRecovery(state("prepared"), facts({ writerAuthority: "held-elsewhere", policyContinuity: "unprovable" })), "block");
});

test("prepared old state aborts without falsely declaring the new release installed", () => {
  for (const phase of ["preparing", "prepared"] as const) {
    assert.equal(decideInstallationRecovery(state(phase), stable), "abort-preparation");
    assert.equal(decideInstallationRecovery(state(phase), facts({ nextComplete: false })), "abort-preparation");
    assert.equal(decideInstallationRecovery(state(phase), facts({ previousComplete: false })), "block");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next" })), "block");
  }
});

test("post-intent recovery accounts for physical changes whose progress write lagged", () => {
  for (const phase of ["publish-intent", "canonical-published", "marker-published", "commit-intent"] as const) {
    assert.equal(decideInstallationRecovery(state(phase), stable), "finish-next");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next" })), "finish-next");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next", marker: "next" })), "finish-next");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next", marker: "next", active: "next" })), "finish-next");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next", nextComplete: false })), "restore-previous");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next", knownPolicyAllowsNext: false })), "restore-previous");
    assert.equal(decideInstallationRecovery(state(phase), facts({ canonical: "next", nextComplete: false, previousComplete: false })), "block");
  }
});

test("a committed next pointer cannot be reset to a predecessor", () => {
  const committed = state("committed", "next");
  assert.equal(decideInstallationRecovery(committed, facts({ canonical: "next", marker: "next", active: "next" })), "finish-next");
  assert.equal(decideInstallationRecovery(committed, facts({ canonical: "next", marker: "next", active: "next", retention: "transferred" })), "finish-cleanup");
  assert.equal(decideInstallationRecovery(committed, facts({ canonical: "next", marker: "next", active: "next", knownPolicyAllowsNext: false })), "block");
  assert.equal(decideInstallationRecovery(committed, facts({ canonical: "next", marker: "next", active: "next", nextComplete: false })), "block");
  assert.equal(decideInstallationRecovery(committed, stable), "block");
  assert.equal(decideInstallationRecovery(state("compensating", "previous"), facts({ active: "next" })), "block");
});

test("explicit compensation never opportunistically flips back to candidate promotion", () => {
  const compensating = state("compensating", "previous");
  assert.equal(decideInstallationRecovery(compensating, facts({ canonical: "next", marker: "next" })), "restore-previous");
  assert.equal(decideInstallationRecovery(compensating, facts({ previousComplete: false })), "block");
  assert.equal(decideInstallationRecovery(compensating, facts({ knownPolicyAllowsPrevious: false })), "block");
  assert.equal(decideInstallationRecovery(state("aborted", "previous"), facts({ retention: "transferred" })), "finish-cleanup");
  assert.equal(decideInstallationRecovery(state("cleanup", "previous"), facts({ retention: "transferred" })), "finish-cleanup");
});

test("Windows pending can settle without ever returning a business replay action", () => {
  const pending = state("execution-pending", null, "windows-x64");
  for (const launch of ["none", "settled-completed", "settled-outcome-unknown"] as const) {
    assert.equal(decideInstallationRecovery(pending, facts({ launch })), "finish-next");
  }
  assert.equal(decideInstallationRecovery(pending, facts({ knownPolicyAllowsNext: false })), "abort-preparation");
  assert.equal(decideInstallationRecovery(pending, facts({ knownPolicyAllowsNext: false, knownPolicyAllowsPrevious: false })), "block");
  assert.equal(decideInstallationRecovery(state("execution-pending"), stable), "block");
  assert.equal(decideInstallationRecovery(state("publish-intent", null, "windows-x64"), facts({ canonical: "absent", innerBinding: "matching" })), "finish-next");
  assert.equal(decideInstallationRecovery(state("publish-intent", null, "windows-x64"), facts({ canonical: "absent" })), "block");
  assert.equal(decideInstallationRecovery(state("publish-intent"), facts({ canonical: "absent" })), "block");
});

test("strict evidence projections reject malformed input without invoking getters or coercion", () => {
  const poison = { get phase() { throw new Error("must not run"); } };
  for (const malformed of [poison, {}, [], { ...state("prepared"), phase: "future" }, { ...state("prepared"), path: "/outside" }, state("committed"), state("aborted", "next")]) {
    assert.equal(decideInstallationRecovery(malformed as InstallationRecoveryState, stable), "block");
  }
  for (const malformed of [{ ...stable, previousComplete: "yes" }, { ...stable, path: "/outside" }, Object.defineProperty({ ...stable }, "canonical", { get() { throw new Error("must not run"); } })]) {
    assert.equal(decideInstallationRecovery(state("prepared"), malformed as unknown as RecoveryFacts), "block");
  }
  assert.equal(decideInstallationRecovery(state("blocked"), stable), "block");
  assert.equal(decideInstallationRecovery(null, facts({ retention: "transfer-pending" })), "block");
  assert.equal(decideInstallationRecovery(state("prepared"), facts({ innerBinding: "matching" })), "block");
});

test("classification is repeatable and never mutates evidence or implies executable authority", () => {
  const journal = Object.freeze(state("commit-intent"));
  const observed = Object.freeze(facts({ canonical: "next", marker: "next" }));
  const before = JSON.stringify({ journal, observed });
  assert.equal(decideInstallationRecovery(journal, observed), "finish-next");
  assert.equal(decideInstallationRecovery(journal, observed), "finish-next");
  assert.equal(JSON.stringify({ journal, observed }), before);
});


test("terminal predecessor outcomes must transfer ownership before cleanup", () => {
  for (const phase of ["aborted", "cleanup"] as const) {
    for (const retention of ["current", "transfer-pending"] as const) {
      assert.equal(decideInstallationRecovery(state(phase, "previous"), facts({ retention })), "finish-previous");
    }
    assert.equal(decideInstallationRecovery(state(phase, "previous"), facts({ retention: "transferred" })), "finish-cleanup");
  }
  for (const phase of ["preparing", "prepared", "publish-intent", "canonical-published", "marker-published", "commit-intent", "compensating"] as const) {
    assert.equal(decideInstallationRecovery(state(phase, phase === "compensating" ? "previous" : null), facts({ retention: "transferred" })), "block");
  }
});

test("precommit promotion requires intact predecessor backups but not rollback policy permission", () => {
  for (const phase of ["publish-intent", "canonical-published", "marker-published", "commit-intent"] as const) {
    assert.equal(decideInstallationRecovery(state(phase), facts({ previousComplete: false })), "block");
    assert.equal(decideInstallationRecovery(state(phase), facts({ knownPolicyAllowsPrevious: false })), "finish-next");
    assert.equal(decideInstallationRecovery(state(phase), facts({ active: "next", canonical: "next", marker: "next", previousComplete: false })), "finish-next");
  }
  assert.equal(decideInstallationRecovery(state("execution-pending", null, "windows-x64"), facts({ previousComplete: false })), "block");
});

test("complete-shaped input accessors are never invoked even if their exceptions could be caught", () => {
  let calls = 0;
  const journal = Object.defineProperty({ ...state("prepared") }, "phase", { get() { calls += 1; throw new Error("secret"); } });
  const observed = Object.defineProperty({ ...stable }, "canonical", { get() { calls += 1; throw new Error("secret"); } });
  assert.equal(decideInstallationRecovery(journal, stable), "block");
  assert.equal(decideInstallationRecovery(state("prepared"), observed), "block");
  assert.equal(calls, 0);
});
