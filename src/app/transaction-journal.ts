import type { Request } from "../contracts/request.ts";
import { copyJsonValue, sha256CanonicalJson, sha256Utf8 } from "../contracts/jcs.ts";
import type { RemoteWrite } from "../contracts/exit-codes.ts";
import type { Candidate } from "../context/types.ts";
import type { ExternalContextSnapshot } from "../render/marker.ts";
import { safeRequestId } from "./remote-receipt.ts";

export interface RemoteTransactionSnapshot {
  readonly iid: number;
  readonly webUrl: string;
  readonly title: string;
  readonly description: string;
  readonly draft: boolean;
  readonly state: "opened" | "closed" | "merged" | "locked";
  readonly sourceProjectId: string;
  readonly sourceBranch: string;
  readonly targetProjectId: string;
  readonly targetBranch: string;
  readonly sourceHeadSha: string;
  readonly labelIds: readonly string[];
  readonly assigneeUserId: string | null;
  readonly reviewerUserIds: readonly string[];
  readonly squash: boolean;
  readonly removeSourceBranch: boolean;
  readonly snapshot: unknown;
}

export type TransactionOperation = "create" | "update";
export type TransactionFinalState =
  | "not-started"
  | "draft-proven"
  | "ready-proven"
  | "compensated-draft"
  | "unknown";
export type TransactionPhase = "normal" | "recovery" | "compensation";
export type TransactionStepOperation =
  | "create-draft"
  | "labels-add"
  | "labels-remove"
  | "fields-write"
  | "description-write"
  | "lifecycle-status-ready-add"
  | "lifecycle-status-ready-remove"
  | "mark-ready"
  | "mark-draft"
  | "compensation-labels-add"
  | "compensation-labels-remove"
  | "compensation-fields"
  | "compensation-description"
  | "create-outcome-query";

export interface TransactionMutationAudit {
  readonly outcome: "confirmed" | "rejected" | "unknown";
  readonly requestId: string | null;
}

export interface TransactionStepAudit {
  readonly sequence: number;
  readonly phase: TransactionPhase;
  readonly operation: TransactionStepOperation;
  readonly preRead: TransactionReadAudit;
  readonly mutation: TransactionMutationAudit | null;
  readonly postRead: TransactionReadAudit;
  readonly postcondition: "matched" | "mismatched" | "unavailable" | "not-applicable";
}

export interface TransactionAuditV1 {
  readonly journalVersion: 1;
  readonly operation: TransactionOperation;
  readonly sourceHeadSha: string;
  readonly candidateSelectionDigest: string;
  readonly finalState: TransactionFinalState;
  readonly recoveredUnknownOutcome: boolean;
  readonly steps: readonly TransactionStepAudit[];
}

interface MutableStep {
  sequence: number;
  phase: TransactionPhase;
  operation: TransactionStepOperation;
  preRead: TransactionReadAudit;
  mutation: TransactionMutationAudit | null;
  postRead: TransactionReadAudit;
  postcondition: TransactionStepAudit["postcondition"];
}

const audits = new WeakMap<object, TransactionAuditV1>();
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set<TransactionOperation>(["create", "update"]);
const FINAL_STATES = new Set<TransactionFinalState>([
  "not-started",
  "draft-proven",
  "ready-proven",
  "compensated-draft",
  "unknown",
]);
const PHASES = new Set<TransactionPhase>(["normal", "recovery", "compensation"]);
const STEP_OPERATIONS = new Set<TransactionStepOperation>([
  "create-draft",
  "labels-add",
  "labels-remove",
  "fields-write",
  "description-write",
  "lifecycle-status-ready-add",
  "lifecycle-status-ready-remove",
  "mark-ready",
  "mark-draft",
  "compensation-labels-add",
  "compensation-labels-remove",
  "compensation-fields",
  "compensation-description",
  "create-outcome-query",
]);
const READ_OUTCOMES = new Set<TransactionReadAudit["outcome"]>([
  "not-attempted",
  "not-applicable",
  "succeeded",
  "failed",
]);
const MUTATION_OUTCOMES = new Set<TransactionMutationAudit["outcome"]>([
  "confirmed",
  "rejected",
  "unknown",
]);
const POSTCONDITIONS = new Set<TransactionStepAudit["postcondition"]>([
  "matched",
  "mismatched",
  "unavailable",
  "not-applicable",
]);
const AUDIT_FIELDS = new Set([
  "journalVersion",
  "operation",
  "sourceHeadSha",
  "candidateSelectionDigest",
  "finalState",
  "recoveredUnknownOutcome",
  "steps",
]);
const STEP_FIELDS = new Set([
  "sequence",
  "phase",
  "operation",
  "preRead",
  "mutation",
  "postRead",
  "postcondition",
]);
const READ_FIELDS = new Set(["outcome", "requestId", "snapshotDigest"]);
const MUTATION_FIELDS = new Set(["outcome", "requestId"]);
const COMPENSATION_ONLY = new Set<TransactionStepOperation>([
  "compensation-labels-add",
  "compensation-labels-remove",
  "compensation-fields",
  "compensation-description",
]);
const COMPENSATION_OPERATIONS = new Set<TransactionStepOperation>([
  "mark-draft",
  ...COMPENSATION_ONLY,
]);

export interface TransactionReadAudit {
  readonly outcome: "not-attempted" | "not-applicable" | "succeeded" | "failed";
  readonly requestId: string | null;
  readonly snapshotDigest: string | null;
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function contractError(reason: string): TypeError {
  return new TypeError(`Transaction audit contract is invalid: ${reason}`);
}

function assertPhaseOperation(
  phase: TransactionPhase,
  operation: TransactionStepOperation,
): void {
  if ((phase === "recovery") !== (operation === "create-outcome-query") ||
      (phase === "normal" && COMPENSATION_ONLY.has(operation)) ||
      (phase === "compensation" && !COMPENSATION_OPERATIONS.has(operation))) {
    throw contractError("transaction phase and operation are incompatible");
  }
}

function record(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw contractError(`${subject} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(
  value: Record<string, unknown>,
  expected: ReadonlySet<string>,
  subject: string,
): void {
  const fields = Object.keys(value);
  if (fields.length !== expected.size || fields.some((field) => !expected.has(field))) {
    throw contractError(`${subject} fields do not match V1`);
  }
}

function validateRequestId(value: unknown, subject: string): string | null {
  if (value === null) return null;
  const normalized = safeRequestId(value);
  if (normalized === null || normalized !== value) {
    throw contractError(`${subject} request ID is unsafe`);
  }
  return normalized;
}

function validateRead(value: unknown, subject: string): TransactionReadAudit {
  const input = record(value, subject);
  exactFields(input, READ_FIELDS, subject);
  if (!READ_OUTCOMES.has(input.outcome as TransactionReadAudit["outcome"])) {
    throw contractError(`${subject} outcome is invalid`);
  }
  const outcome = input.outcome as TransactionReadAudit["outcome"];
  const requestId = validateRequestId(input.requestId, subject);
  const snapshotDigest = input.snapshotDigest;
  if ((outcome === "succeeded" &&
       (typeof snapshotDigest !== "string" || !SHA256.test(snapshotDigest))) ||
      (outcome !== "succeeded" && snapshotDigest !== null)) {
    throw contractError(`${subject} snapshot digest is inconsistent`);
  }
  return { outcome, requestId, snapshotDigest: snapshotDigest as string | null };
}

function validateMutation(value: unknown, subject: string): TransactionMutationAudit | null {
  if (value === null) return null;
  const input = record(value, subject);
  exactFields(input, MUTATION_FIELDS, subject);
  if (!MUTATION_OUTCOMES.has(input.outcome as TransactionMutationAudit["outcome"])) {
    throw contractError(`${subject} outcome is invalid`);
  }
  return {
    outcome: input.outcome as TransactionMutationAudit["outcome"],
    requestId: validateRequestId(input.requestId, subject),
  };
}

function validateStep(value: unknown, sequence: number): TransactionStepAudit {
  const input = record(value, `step ${String(sequence)}`);
  exactFields(input, STEP_FIELDS, `step ${String(sequence)}`);
  if (input.sequence !== sequence || !Number.isSafeInteger(input.sequence)) {
    throw contractError("step sequence is not consecutive");
  }
  if (!PHASES.has(input.phase as TransactionPhase)) {
    throw contractError(`step ${String(sequence)} phase is invalid`);
  }
  if (!STEP_OPERATIONS.has(input.operation as TransactionStepOperation)) {
    throw contractError(`step ${String(sequence)} operation is invalid`);
  }
  if (!POSTCONDITIONS.has(input.postcondition as TransactionStepAudit["postcondition"])) {
    throw contractError(`step ${String(sequence)} postcondition is invalid`);
  }
  const operation = input.operation as TransactionStepOperation;
  const phase = input.phase as TransactionPhase;
  assertPhaseOperation(phase, operation);
  const mutation = validateMutation(input.mutation, `step ${String(sequence)} mutation`);
  if (operation === "create-outcome-query" && mutation !== null) {
    throw contractError("create outcome query must be read-only");
  }
  const postRead = validateRead(input.postRead, `step ${String(sequence)} post-read`);
  const postcondition = input.postcondition as TransactionStepAudit["postcondition"];
  if (["matched", "mismatched"].includes(postcondition) && postRead.outcome !== "succeeded") {
    throw contractError(`step ${String(sequence)} postcondition requires a successful read`);
  }
  return {
    sequence,
    phase,
    operation,
    preRead: validateRead(input.preRead, `step ${String(sequence)} pre-read`),
    mutation,
    postRead,
    postcondition,
  };
}

export function validateTransactionAudit(value: unknown): TransactionAuditV1 {
  let copied: unknown;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw contractError("value must be strict JSON");
  }
  const input = record(copied, "audit");
  exactFields(input, AUDIT_FIELDS, "audit");
  if (input.journalVersion !== 1 ||
      !OPERATIONS.has(input.operation as TransactionOperation) ||
      typeof input.sourceHeadSha !== "string" || !SHA.test(input.sourceHeadSha) ||
      typeof input.candidateSelectionDigest !== "string" || !SHA256.test(input.candidateSelectionDigest) ||
      !FINAL_STATES.has(input.finalState as TransactionFinalState) ||
      typeof input.recoveredUnknownOutcome !== "boolean" ||
      !Array.isArray(input.steps)) {
    throw contractError("audit scalar fields are invalid");
  }
  const steps = input.steps.map((step, index) => validateStep(step, index + 1));
  const finalState = input.finalState as TransactionFinalState;
  const matchedMutation = (operation?: TransactionStepOperation) => steps.some((step) =>
    (operation === undefined || step.operation === operation) &&
    step.mutation !== null && ["confirmed", "unknown"].includes(step.mutation.outcome) &&
    step.postRead.outcome === "succeeded" && step.postcondition === "matched");
  const recoveredUnknownOutcome = steps.some((step, index) =>
    step.mutation?.outcome === "unknown" &&
    ((step.postRead.outcome === "succeeded" && step.postcondition === "matched") ||
     (step.operation === "create-draft" && steps.slice(index + 1).some((later) =>
       later.phase === "recovery" && later.operation === "create-outcome-query" &&
       later.postRead.outcome === "succeeded" && later.postcondition === "matched"))));
  if ((finalState === "draft-proven" && !matchedMutation()) ||
      (finalState === "ready-proven" && !matchedMutation("mark-ready")) ||
      (finalState === "compensated-draft" && !steps.some((step) =>
        step.phase === "compensation" && step.mutation !== null &&
        ["confirmed", "unknown"].includes(step.mutation.outcome) &&
        step.postRead.outcome === "succeeded" && step.postcondition === "matched"))) {
    throw contractError("final state is not proven by the recorded steps");
  }
  if (input.recoveredUnknownOutcome !== recoveredUnknownOutcome) {
    throw contractError("recovered unknown outcome is not proven exactly by the recorded steps");
  }
  return deepFreeze({
    journalVersion: 1,
    operation: input.operation as TransactionOperation,
    sourceHeadSha: input.sourceHeadSha,
    candidateSelectionDigest: input.candidateSelectionDigest,
    finalState,
    recoveredUnknownOutcome: input.recoveredUnknownOutcome,
    steps,
  });
}

export function remoteWriteFromTransactionAudit(value: unknown): RemoteWrite {
  const audit = validateTransactionAudit(value);
  const operations = audit.steps
    .filter((step) => step.mutation !== null &&
      ["confirmed", "unknown"].includes(step.mutation.outcome))
    .map((step) => step.operation);
  if (operations.length === 0) {
    return Object.freeze({
      state: audit.steps.length === 0 ? "not-attempted" : "not-written",
      operations: Object.freeze([]),
    });
  }
  const state = audit.finalState === "compensated-draft"
    ? "compensated"
    : audit.finalState === "draft-proven" || audit.finalState === "ready-proven"
      ? "written"
      : "unknown";
  return Object.freeze({ state, operations: Object.freeze(operations) });
}

export function remoteSnapshotDigest(value: RemoteTransactionSnapshot): string {
  return sha256CanonicalJson({
    iid: value.iid,
    webUrlDigest: sha256Utf8(value.webUrl),
    title: value.title,
    descriptionDigest: sha256Utf8(value.description),
    draft: value.draft,
    state: value.state,
    sourceProjectId: value.sourceProjectId,
    sourceBranch: value.sourceBranch,
    targetProjectId: value.targetProjectId,
    targetBranch: value.targetBranch,
    sourceHeadSha: value.sourceHeadSha,
    labelIds: [...value.labelIds].sort(ordinal),
    assigneeUserId: value.assigneeUserId,
    reviewerUserIds: [...value.reviewerUserIds].sort(ordinal),
    squash: value.squash,
    removeSourceBranch: value.removeSourceBranch,
    externalSnapshotDigest: sha256CanonicalJson(value.snapshot),
  });
}

export function candidateSelectionDigest(
  request: Request,
  candidates: readonly Candidate[],
  externalSnapshot: ExternalContextSnapshot,
): string {
  const selections = [
    ...request.mergeRequest.labelCandidateTokens.map((token) => ({ kind: "label" as const, token })),
    ...(request.mergeRequest.assigneeCandidateToken === null
      ? []
      : [{ kind: "assignee" as const, token: request.mergeRequest.assigneeCandidateToken }]),
    ...request.review.reviewerCandidateTokens.map((token) => ({ kind: "reviewer" as const, token })),
  ];
  if (selections.length !== candidates.length ||
      selections.some((selection, index) => selection.kind !== candidates[index]?.kind)) {
    throw new TypeError("Resolved candidates are not paired with Request selections");
  }
  return sha256CanonicalJson({
    version: 1,
    contextIdDigest: sha256Utf8(request.contextId),
    externalSnapshotDigest: sha256CanonicalJson(externalSnapshot),
    selections: selections.map((selection, index) => ({
      ordinal: index,
      kind: selection.kind,
      tokenDigest: sha256Utf8(selection.token),
      candidateDigest: sha256CanonicalJson(candidates[index]),
    })),
  });
}


function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function snapshotAudit(value: TransactionAuditV1): TransactionAuditV1 {
  return validateTransactionAudit(value);
}

export class TransactionJournal {
  private readonly steps: MutableStep[] = [];
  private finalState: TransactionFinalState = "not-started";
  private recoveredUnknownOutcome = false;
  private normalWritesClosed = false;

  constructor(
    private readonly operation: TransactionOperation,
    private readonly sourceHeadSha: string,
    private readonly selectionDigest: string,
  ) {
    if (!OPERATIONS.has(operation)) throw contractError("operation is invalid");
    if (!SHA.test(sourceHeadSha)) throw contractError("sourceHeadSha is invalid");
    if (!SHA256.test(selectionDigest)) throw contractError("candidateSelectionDigest is invalid");
  }

  start(
    phase: TransactionPhase,
    operation: TransactionStepOperation,
    preState: RemoteTransactionSnapshot | null,
    preReadRequestId: unknown = null,
  ): TransactionStepRecorder {
    assertPhaseOperation(phase, operation);
    if (phase !== "compensation" && this.normalWritesClosed && operation !== "create-outcome-query") {
      throw new TypeError("Normal transaction writes are closed after mark-ready begins");
    }
    if (phase === "normal" && operation === "mark-ready") {
      this.normalWritesClosed = true;
    }
    const step: MutableStep = {
      sequence: this.steps.length + 1,
      phase,
      operation,
      preRead: Object.freeze(preState === null
        ? { outcome: "not-applicable", requestId: null, snapshotDigest: null }
        : {
            outcome: "succeeded",
            requestId: safeRequestId(preReadRequestId),
            snapshotDigest: remoteSnapshotDigest(preState),
          }),
      mutation: null,
      postRead: { outcome: "not-attempted", requestId: null, snapshotDigest: null },
      postcondition: "unavailable",
    };
    this.steps.push(step);
    return new TransactionStepRecorder(step, this);
  }

  assertMutationAllowed(step: MutableStep): void {
    if (step.operation === "create-outcome-query") {
      throw new TypeError("The create-outcome-query operation is read-only");
    }
    const markReadyStep = step.phase === "normal" && step.operation === "mark-ready";
    if (this.normalWritesClosed && step.phase !== "compensation" && !markReadyStep) {
      throw new TypeError("Normal transaction writes are closed after mark-ready begins");
    }
  }

  markRecoveredUnknown(): void {
    this.recoveredUnknownOutcome = true;
  }

  setFinalState(value: TransactionFinalState): void {
    this.finalState = value;
  }

  snapshot(): TransactionAuditV1 {
    return snapshotAudit({
      journalVersion: 1,
      operation: this.operation,
      sourceHeadSha: this.sourceHeadSha,
      candidateSelectionDigest: this.selectionDigest,
      finalState: this.finalState,
      recoveredUnknownOutcome: this.recoveredUnknownOutcome,
      steps: this.steps,
    });
  }
}

export class TransactionStepRecorder {
  private postconditionRecorded = false;

  constructor(
    private readonly step: MutableStep,
    private readonly journal: TransactionJournal,
  ) {}

  mutation(outcome: TransactionMutationAudit["outcome"], requestId: unknown): void {
    this.journal.assertMutationAllowed(this.step);
    if (this.step.mutation !== null) {
      throw new TypeError("Transaction mutation receipt is already recorded");
    }
    this.step.mutation = Object.freeze({ outcome, requestId: safeRequestId(requestId) });
  }

  readSucceeded(requestId: unknown, value: RemoteTransactionSnapshot): void {
    this.assertPostReadAvailable();
    this.step.postRead = Object.freeze({
      outcome: "succeeded",
      requestId: safeRequestId(requestId),
      snapshotDigest: remoteSnapshotDigest(value),
    });
  }

  readResultSucceeded(requestId: unknown, value: unknown): void {
    this.assertPostReadAvailable();
    this.step.postRead = Object.freeze({
      outcome: "succeeded",
      requestId: safeRequestId(requestId),
      snapshotDigest: sha256CanonicalJson(copyJsonValue(value)),
    });
  }

  preReadSucceeded(requestId: unknown, value: RemoteTransactionSnapshot): void {
    this.step.preRead = Object.freeze({
      outcome: "succeeded",
      requestId: safeRequestId(requestId),
      snapshotDigest: remoteSnapshotDigest(value),
    });
  }

  readFailed(requestId: unknown = null): void {
    this.assertPostReadAvailable();
    this.step.postRead = Object.freeze({ outcome: "failed", requestId: safeRequestId(requestId), snapshotDigest: null });
    this.step.postcondition = "unavailable";
  }

  preReadFailed(requestId: unknown = null): void {
    this.step.preRead = Object.freeze({ outcome: "failed", requestId: safeRequestId(requestId), snapshotDigest: null });
  }

  private assertPostReadAvailable(): void {
    if (this.step.postRead.outcome !== "not-attempted") {
      throw new TypeError("Transaction post-read receipt is already recorded");
    }
  }

  postcondition(value: TransactionStepAudit["postcondition"]): void {
    if (this.postconditionRecorded) {
      throw new TypeError("Transaction postcondition is already recorded");
    }
    this.postconditionRecorded = true;
    this.step.postcondition = value;
    if (value === "matched" && this.step.mutation?.outcome === "unknown" &&
        this.step.postRead.outcome === "succeeded") {
      this.journal.markRecoveredUnknown();
    }
  }
}

export function attachTransactionAudit(error: unknown, audit: TransactionAuditV1): void {
  if ((typeof error === "object" || typeof error === "function") && error !== null) {
    audits.set(error, snapshotAudit(audit));
  }
}

export function getTransactionAudit(error: unknown): TransactionAuditV1 | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  return audits.get(error) ?? null;
}
