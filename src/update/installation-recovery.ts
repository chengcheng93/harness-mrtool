/**
 * Pure recovery planning only: no I/O, process launch, lock acquisition, policy
 * authentication or authority factories. These inputs are evidence projections,
 * not capabilities. A future executor must independently authenticate the full
 * journal, re-observe physical files under a fenced epoch, and validate every
 * expected identity before acting on any decision returned here.
 */
export type InstallationPhase =
  | "preparing" | "prepared" | "execution-pending" | "publish-intent"
  | "canonical-published" | "marker-published" | "commit-intent"
  | "committed" | "cleanup" | "compensating" | "aborted" | "retention-transfer" | "blocked";

/** A closed projection of a future validated full journal, never the journal itself. */
export interface InstallationRecoveryState {
  readonly phase: InstallationPhase;
  readonly outcome: "previous" | "next" | null;
  readonly platform: "darwin-arm64" | "windows-x64";
}

export type FileMatch = "previous" | "next" | "both" | "absent" | "invalid";
export interface RecoveryFacts {
  readonly canonical: FileMatch;
  readonly marker: FileMatch;
  readonly active: "previous" | "next" | "absent" | "invalid";
  readonly previousComplete: boolean;
  readonly nextComplete: boolean;
  readonly enrollment: "enrolled" | "unenrolled" | "enrolling" | "inconsistent";
  readonly policyContinuity: "current" | "exact-checkpoint-repair" | "unprovable";
  readonly writerAuthority: "fenced-current-epoch" | "held-elsewhere" | "unproven";
  readonly launch: "none" | "pre-admission" | "admitted-live" |
    "settled-completed" | "settled-outcome-unknown" | "unsettled";
  readonly retention: "current" | "transfer-pending" | "transferred" | "invalid";
  readonly knownPolicyAllowsPrevious: boolean;
  readonly knownPolicyAllowsNext: boolean;
  readonly innerBinding: "none" | "matching" | "mismatched";
}

/** No result here reports installed, releases business work, or requests replay. */
export type RecoveryDecision =
  | "verify-stable-previous" | "verify-stable-next" | "abort-preparation"
  | "restore-previous" | "finish-previous" | "finish-next" | "wait-owner" | "finish-cleanup" | "block";

const phases: readonly InstallationPhase[] = [
  "preparing", "prepared", "execution-pending", "publish-intent", "canonical-published",
  "marker-published", "commit-intent", "committed", "cleanup", "compensating", "aborted", "retention-transfer", "blocked",
];
const fileMatches: readonly FileMatch[] = ["previous", "next", "both", "absent", "invalid"];
const factEnums = {
  canonical: fileMatches,
  marker: fileMatches,
  active: ["previous", "next", "absent", "invalid"],
  enrollment: ["enrolled", "unenrolled", "enrolling", "inconsistent"],
  policyContinuity: ["current", "exact-checkpoint-repair", "unprovable"],
  writerAuthority: ["fenced-current-epoch", "held-elsewhere", "unproven"],
  launch: ["none", "pre-admission", "admitted-live", "settled-completed", "settled-outcome-unknown", "unsettled"],
  retention: ["current", "transfer-pending", "transferred", "invalid"],
  innerBinding: ["none", "matching", "mismatched"],
} as const;
const booleanFacts = ["previousComplete", "nextComplete", "knownPolicyAllowsPrevious", "knownPolicyAllowsNext"] as const;

function ownData(input: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (input === null || typeof input !== "object") return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== fields.length || keys.some(key => typeof key !== "string" || !fields.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(input, field);
    if (descriptor === undefined || !("value" in descriptor)) return null;
    copy[field] = descriptor.value;
  }
  return copy;
}

function readFacts(input: unknown): RecoveryFacts | null {
  const copy = ownData(input, [...Object.keys(factEnums), ...booleanFacts]);
  if (copy === null) return null;
  for (const [field, values] of Object.entries(factEnums)) {
    if (!(values as readonly unknown[]).includes(copy[field])) return null;
  }
  if (booleanFacts.some(field => typeof copy[field] !== "boolean")) return null;
  return copy as unknown as RecoveryFacts;
}

function readState(input: unknown): InstallationRecoveryState | null {
  const copy = ownData(input, ["phase", "outcome", "platform"]);
  if (copy === null || !(phases as readonly unknown[]).includes(copy.phase) ||
      !["darwin-arm64", "windows-x64"].includes(copy.platform as string)) return null;
  const { phase, outcome } = copy;
  if (phase === "committed" ? outcome !== "next" :
      phase === "compensating" || phase === "aborted" ? outcome !== "previous" :
      phase === "retention-transfer" ? outcome !== "next" && outcome !== "previous" :
      phase === "cleanup" ? outcome !== "next" && outcome !== "previous" : outcome !== null) return null;
  if (phase === "execution-pending" && copy.platform !== "windows-x64") return null;
  return copy as unknown as InstallationRecoveryState;
}

function matches(file: FileMatch, target: "previous" | "next"): boolean {
  return file === target || file === "both";
}

function decide(state: InstallationRecoveryState | null, facts: RecoveryFacts): RecoveryDecision {
  if (facts.enrollment !== "enrolled" || facts.policyContinuity !== "current" ||
      facts.writerAuthority === "unproven" || facts.retention === "invalid" ||
      facts.innerBinding === "mismatched" || facts.canonical === "invalid" ||
      facts.marker === "invalid" || facts.active === "invalid" || facts.active === "absent" ||
      state?.phase === "blocked") return "block";
  if (state?.platform === "darwin-arm64" && facts.innerBinding !== "none") return "block";
  if (facts.writerAuthority === "held-elsewhere") return "wait-owner";

  const previousAllowed = facts.previousComplete && facts.knownPolicyAllowsPrevious;
  const nextAllowed = facts.nextComplete && facts.knownPolicyAllowsNext;
  const previousFiles = matches(facts.canonical, "previous") && matches(facts.marker, "previous");
  const nextFiles = matches(facts.canonical, "next") && matches(facts.marker, "next");

  if (state === null) {
    if (facts.innerBinding !== "none" || facts.launch !== "none" || facts.retention === "transfer-pending") return "block";
    if (facts.active === "previous" && previousFiles && previousAllowed) return "verify-stable-previous";
    if (facts.active === "next" && nextFiles && nextAllowed) return "verify-stable-next";
    return "block";
  }
  // Ownership can transfer only from a frozen terminal journal. A catalog
  // receipt claiming otherwise contradicts this projected transaction.
  if ((facts.retention === "transferred" || facts.retention === "transfer-pending") &&
      !["committed", "aborted", "cleanup", "retention-transfer"].includes(state.phase)) return "block";
  if (["pre-admission", "admitted-live", "unsettled"].includes(facts.launch)) return "wait-owner";
  if (facts.canonical === "absent" && (state.platform !== "windows-x64" || facts.innerBinding !== "matching")) return "block";

  // Terminal/compensation intent cannot be contradicted by a different active
  // pointer. In particular no decision ever resets a committed N pointer to P.
  if ((state.outcome === "previous" && facts.active !== "previous") ||
      (state.outcome === "next" && facts.active !== "next")) return "block";
  if (state.outcome === "previous") {
    if (!previousAllowed) return "block";
    if (!previousFiles || state.phase === "compensating") return "restore-previous";
    // Like finish-next, finish-previous still requires final observation and
    // durable ownership transfer; neither is public installed truth.
    return facts.retention === "transferred" ? "finish-cleanup" : "finish-previous";
  }
  if (facts.active === "next") {
    if (["preparing", "prepared", "execution-pending"].includes(state.phase) || !nextAllowed) return "block";
    return nextFiles && facts.retention === "transferred" &&
      (state.phase === "committed" || state.phase === "cleanup" || state.phase === "retention-transfer") ? "finish-cleanup" : "finish-next";
  }
  if (state.phase === "preparing" || state.phase === "prepared") {
    return previousFiles && previousAllowed ? "abort-preparation" : "block";
  }
  // Before A=N, preserve a verified predecessor/backup pair. Its validity is
  // independent of whether current policy would permit executing that old CLI.
  if (!facts.previousComplete) return "block";
  if (state.phase === "execution-pending") {
    if (!previousFiles) return "block";
    return nextAllowed ? "finish-next" : previousAllowed ? "abort-preparation" : "block";
  }
  return nextAllowed ? "finish-next" : previousAllowed ? "restore-previous" : "block";
}

export function decideInstallationRecovery(
  state: InstallationRecoveryState | null,
  facts: RecoveryFacts,
): RecoveryDecision {
  try {
    const checkedFacts = readFacts(facts);
    const checkedState = state === null ? null : readState(state);
    if (checkedFacts === null || (state !== null && checkedState === null)) return "block";
    return decide(checkedState, checkedFacts);
  } catch {
    // Throwing Proxy traps/accessors cannot turn malformed evidence into work.
    return "block";
  }
}
