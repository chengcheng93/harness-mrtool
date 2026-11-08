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
/**
 * `complete` means every planned remote write was confirmed by an independent
 * readback; `partial` means the merge request exists and its current state was
 * read back, but the transaction stopped before the final description write;
 * `unknown` means a remote write may have happened but the state could not be
 * proven. There is no Draft stage and no compensation.
 */
export type TransactionFinalState = "not-started" | "partial" | "complete" | "unknown";
export type TransactionPhase = "normal" | "recovery";
export type TransactionStepOperation =
  | "create"
  | "labels-add"
  | "labels-remove"
  | "fields-write"
  | "description-write"
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

export const TRANSACTION_JOURNAL_VERSION = 2 as const;

export interface TransactionAudit {
  readonly journalVersion: typeof TRANSACTION_JOURNAL_VERSION;
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

const audits = new WeakMap<object, TransactionAudit>();
const failureReceipts = new WeakMap<object, TransactionFailureReceiptV1>();
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPERATIONS = new Set<TransactionOperation>(["create", "update"]);
const FINAL_STATES = new Set<TransactionFinalState>(["not-started", "partial", "complete", "unknown"]);
const PHASES = new Set<TransactionPhase>(["normal", "recovery"]);
const STEP_OPERATIONS = new Set<TransactionStepOperation>([
  "create",
  "labels-add",
  "labels-remove",
  "fields-write",
  "description-write",
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

export interface TransactionFailureReceiptV1 {
  readonly receiptVersion: 1;
  readonly iid: number | null;
  readonly iidUnavailable: boolean;
  readonly webUrl: string | null;
  readonly webUrlUnavailable: boolean;
  readonly completedSteps: readonly string[];
  readonly failedOperation: TransactionFailureOperation;
  readonly failedField: string;
  readonly retryCommand: string;
}

export type TransactionFailureOperation =
  | TransactionStepOperation
  | "verification-receipt-stage";

const FAILURE_RECEIPT_FIELDS = new Set([
  "receiptVersion",
  "iid",
  "iidUnavailable",
  "webUrl",
  "webUrlUnavailable",
  "completedSteps",
  "failedOperation",
  "failedField",
  "retryCommand",
]);
const SAFE_AUDIT_TEXT = /^[\x20-\x7E]{1,512}$/u;
const SAFE_RETRY_COMMAND = /^harness-mrtool (?:update [1-9][0-9]* --input - --non-interactive --output json|verify [1-9][0-9]* --level structure --output json|context --output json)$/u;
const SECRET_SHAPE = /(?:glpat-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|hmr[ctx]1_[A-Za-z0-9_-]+)/iu;
const FAILURE_OPERATIONS = new Set<TransactionFailureOperation>([
  ...STEP_OPERATIONS,
  "verification-receipt-stage",
]);
const NORMAL_OPERATION_ORDER = new Map<TransactionStepOperation, number>([
  ["create", 0],
  ["labels-add", 1],
  ["labels-remove", 2],
  ["fields-write", 3],
  ["description-write", 4],
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

export function validateTransactionFailureReceipt(value: unknown): TransactionFailureReceiptV1 {
  let copied: unknown;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw contractError("failure receipt must be strict JSON");
  }
  const input = record(copied, "failure receipt");
  exactFields(input, FAILURE_RECEIPT_FIELDS, "failure receipt");
  const expectedRetryCommands = input.iid === null
    ? ["harness-mrtool context --output json"]
    : [
        `harness-mrtool update ${String(input.iid)} --input - --non-interactive --output json`,
        `harness-mrtool verify ${String(input.iid)} --level structure --output json`,
      ];
  const auditText = [
    ...(Array.isArray(input.completedSteps) ? input.completedSteps : []),
    input.failedField,
    input.retryCommand,
    input.webUrl,
  ].filter((entry): entry is string => typeof entry === "string");
  if (input.receiptVersion !== 1 ||
      (input.iid !== null && (!Number.isSafeInteger(input.iid) || (input.iid as number) < 1)) ||
      typeof input.iidUnavailable !== "boolean" || input.iidUnavailable !== (input.iid === null) ||
      typeof input.webUrlUnavailable !== "boolean" ||
      (input.webUrl !== null && (typeof input.webUrl !== "string" ||
        input.webUrl === "" || !/^https?:\/\/[^\s]+$/u.test(input.webUrl))) ||
      input.webUrlUnavailable !== (input.webUrl === null) || !Array.isArray(input.completedSteps) ||
      input.completedSteps.some((step) => typeof step !== "string" || !SAFE_AUDIT_TEXT.test(step)) ||
      new Set(input.completedSteps).size !== input.completedSteps.length ||
      !FAILURE_OPERATIONS.has(input.failedOperation as TransactionFailureOperation) ||
      typeof input.failedField !== "string" || !SAFE_AUDIT_TEXT.test(input.failedField) ||
      typeof input.retryCommand !== "string" || !SAFE_RETRY_COMMAND.test(input.retryCommand) ||
      !expectedRetryCommands.includes(input.retryCommand) ||
      auditText.some((entry) => SECRET_SHAPE.test(entry))) {
    throw contractError("failure receipt fields are invalid or unsafe");
  }
  return deepFreeze({
    receiptVersion: 1,
    iid: input.iid as number | null,
    iidUnavailable: input.iidUnavailable,
    webUrl: input.webUrl as string | null,
    webUrlUnavailable: input.webUrlUnavailable,
    completedSteps: input.completedSteps as string[],
    failedOperation: input.failedOperation as TransactionFailureOperation,
    failedField: input.failedField,
    retryCommand: input.retryCommand,
  });
}

function assertPhaseOperation(
  phase: TransactionPhase,
  operation: TransactionStepOperation,
): void {
  if ((phase === "recovery") !== (operation === "create-outcome-query")) {
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
    throw contractError(`${subject} fields do not match the journal contract`);
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
  const preRead = validateRead(input.preRead, `step ${String(sequence)} pre-read`);
  if (mutation !== null && operation !== "create" && preRead.outcome !== "succeeded") {
    throw contractError(`step ${String(sequence)} mutation requires a successful pre-read`);
  }
  if (["matched", "mismatched"].includes(postcondition) && postRead.outcome !== "succeeded") {
    throw contractError(`step ${String(sequence)} postcondition requires a successful read`);
  }
  if (postcondition === "matched" && operation !== "create-outcome-query" &&
      (mutation === null || !["confirmed", "unknown"].includes(mutation.outcome))) {
    throw contractError(`step ${String(sequence)} matched without a possible remote write`);
  }
  return {
    sequence,
    phase,
    operation,
    preRead,
    mutation,
    postRead,
    postcondition,
  };
}

function isMatchedWrite(step: TransactionStepAudit): boolean {
  return step.mutation !== null && ["confirmed", "unknown"].includes(step.mutation.outcome) &&
    step.postRead.outcome === "succeeded" && step.postcondition === "matched";
}

function replayTransaction(
  operation: TransactionOperation,
  finalState: TransactionFinalState,
  steps: readonly TransactionStepAudit[],
): void {
  let normalRank = -1;
  let sawCreate = false;
  let pendingUnknownCreate = false;
  let sawRecoveryQuery = false;
  const seenNormalOperations = new Set<TransactionStepOperation>();

  for (const step of steps) {
    if (step.phase === "normal") {
      if (operation === "update" && step.operation === "create") {
        throw contractError("an update audit cannot create a merge request");
      }
      if (operation === "create" && !sawCreate && step.operation !== "create") {
        throw contractError("a create audit must begin with create");
      }
      if (step.operation === "create") {
        if (operation !== "create" || sawCreate || step.sequence !== 1) {
          throw contractError("create must be the first and unique create step");
        }
        sawCreate = true;
        pendingUnknownCreate = step.mutation?.outcome === "unknown" &&
          !(step.postRead.outcome === "succeeded" && step.postcondition === "matched");
      } else if (pendingUnknownCreate) {
        throw contractError("unknown create must be recovered successfully before later normal steps");
      }
      const rank = NORMAL_OPERATION_ORDER.get(step.operation);
      if (rank === undefined || rank < normalRank) {
        throw contractError("normal operation order is invalid");
      }
      if (seenNormalOperations.has(step.operation)) {
        throw contractError("normal transaction operations cannot repeat");
      }
      seenNormalOperations.add(step.operation);
      normalRank = rank;
    } else {
      const previous = steps[step.sequence - 2];
      if (operation !== "create" || !pendingUnknownCreate || sawRecoveryQuery ||
          previous?.operation !== "create" || previous.mutation?.outcome !== "unknown") {
        throw contractError("create recovery must immediately follow an unknown create");
      }
      sawRecoveryQuery = true;
      if (step.postRead.outcome === "succeeded" && step.postcondition === "matched") {
        pendingUnknownCreate = false;
      }
    }
  }

  const last = steps.at(-1);
  const possibleWrite = steps.some((step) =>
    step.mutation !== null && ["confirmed", "unknown"].includes(step.mutation.outcome));
  if (finalState === "not-started" && possibleWrite) {
    throw contractError("not-started cannot contain a possible remote write");
  }
  if (finalState === "unknown" && !possibleWrite) {
    throw contractError("unknown final state requires a possible remote write");
  }
  if (finalState === "partial" && !steps.some((step) => step.phase === "normal" && isMatchedWrite(step))) {
    throw contractError("partial final state requires a matched remote write");
  }
  if (finalState === "complete" &&
      !(last?.phase === "normal" && last.operation === "description-write" && isMatchedWrite(last))) {
    throw contractError("final state complete requires description-write as the final matched step");
  }
}

export function validateTransactionAudit(value: unknown): TransactionAudit {
  let copied: unknown;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw contractError("value must be strict JSON");
  }
  const input = record(copied, "audit");
  exactFields(input, AUDIT_FIELDS, "audit");
  if (input.journalVersion !== TRANSACTION_JOURNAL_VERSION ||
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
  replayTransaction(input.operation as TransactionOperation, finalState, steps);
  const recoveredUnknownOutcome = steps.some((step, index) =>
    step.mutation?.outcome === "unknown" &&
    ((step.postRead.outcome === "succeeded" && step.postcondition === "matched") ||
     (step.operation === "create" && steps.slice(index + 1).some((later) =>
       later.phase === "recovery" && later.operation === "create-outcome-query" &&
       later.postRead.outcome === "succeeded" && later.postcondition === "matched"))));
  if (finalState === "complete" && !steps.some((step) =>
    step.operation === "description-write" && isMatchedWrite(step))) {
    throw contractError("final state is not proven by the recorded steps");
  }
  if (input.recoveredUnknownOutcome !== recoveredUnknownOutcome) {
    throw contractError("recovered unknown outcome is not proven exactly by the recorded steps");
  }
  return deepFreeze({
    journalVersion: TRANSACTION_JOURNAL_VERSION,
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
  const state = audit.finalState === "complete" || audit.finalState === "partial" ? "written" : "unknown";
  return Object.freeze({ state, operations: Object.freeze(operations) });
}

export function remoteSnapshotDigest(value: RemoteTransactionSnapshot): string {
  const external = value.snapshot as Partial<ExternalContextSnapshot>;
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
    authorUserId: external.mergeRequest?.authorUserId ?? null,
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

function snapshotAudit(value: TransactionAudit): TransactionAudit {
  return validateTransactionAudit(value);
}

export class TransactionJournal {
  private readonly steps: MutableStep[] = [];
  private finalState: TransactionFinalState = "not-started";
  private recoveredUnknownOutcome = false;

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
    preReadRequestId: unknown = undefined,
  ): TransactionStepRecorder {
    assertPhaseOperation(phase, operation);
    const step: MutableStep = {
      sequence: this.steps.length + 1,
      phase,
      operation,
      preRead: Object.freeze(preState === null
        ? { outcome: "not-applicable", requestId: null, snapshotDigest: null }
        : preReadRequestId === undefined
          ? { outcome: "not-attempted", requestId: null, snapshotDigest: null }
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
  }

  markRecoveredUnknown(): void {
    this.recoveredUnknownOutcome = true;
  }

  markPossibleWrite(): void {
    if (this.finalState === "not-started") this.finalState = "unknown";
  }

  setFinalState(value: TransactionFinalState): void {
    this.finalState = value;
  }

  snapshot(): TransactionAudit {
    return snapshotAudit({
      journalVersion: TRANSACTION_JOURNAL_VERSION,
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
    if (this.step.operation !== "create" && this.step.preRead.outcome !== "succeeded") {
      throw new TypeError("Transaction mutation requires a successful pre-read receipt");
    }
    this.step.mutation = Object.freeze({ outcome, requestId: safeRequestId(requestId) });
    if (outcome === "confirmed" || outcome === "unknown") this.journal.markPossibleWrite();
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
    this.assertPreReadAvailable();
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
    this.assertPreReadAvailable();
    this.step.preRead = Object.freeze({ outcome: "failed", requestId: safeRequestId(requestId), snapshotDigest: null });
  }

  private assertPreReadAvailable(): void {
    if (this.step.preRead.outcome !== "not-attempted") {
      throw new TypeError("Transaction pre-read receipt is already recorded");
    }
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

export function attachTransactionAudit(error: unknown, audit: TransactionAudit): void {
  if ((typeof error === "object" || typeof error === "function") && error !== null) {
    audits.set(error, snapshotAudit(audit));
  }
}

export function getTransactionAudit(error: unknown): TransactionAudit | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  return audits.get(error) ?? null;
}

export function attachTransactionFailureReceipt(
  error: unknown,
  receipt: TransactionFailureReceiptV1,
): void {
  if ((typeof error === "object" || typeof error === "function") && error !== null) {
    failureReceipts.set(error, validateTransactionFailureReceipt(receipt));
  }
}

function failedField(operation: TransactionFailureOperation): string {
  if (operation === "labels-add" || operation === "labels-remove") return "mergeRequest.labels";
  if (operation === "fields-write") return "mergeRequest.fields";
  if (operation === "description-write") return "mergeRequest.description";
  if (operation === "verification-receipt-stage") return "verificationReceipt";
  if (operation === "create-outcome-query") return "mergeRequest.createOutcome";
  return "mergeRequest";
}

export function attachTransactionFailure(
  error: unknown,
  input: {
    readonly audit: TransactionAudit;
    readonly iid: number | null;
    readonly webUrl: string | null;
    readonly completedSteps: readonly string[];
    readonly retry: "update" | "verify";
    readonly failedOperation?: TransactionFailureOperation;
    readonly failedField?: string;
  },
): void {
  const audit = validateTransactionAudit(input.audit);
  const incomplete = [...audit.steps].reverse().find((step) =>
    step.mutation?.outcome === "rejected" || step.postRead.outcome === "failed" ||
    step.postcondition === "mismatched" ||
    (step.mutation?.outcome === "unknown" && step.postcondition !== "matched"));
  const operation = input.failedOperation ?? incomplete?.operation ?? audit.steps.at(-1)?.operation;
  if (operation === undefined) return;
  attachTransactionFailureReceipt(error, {
    receiptVersion: 1,
    iid: input.iid,
    iidUnavailable: input.iid === null,
    webUrl: input.webUrl,
    webUrlUnavailable: input.webUrl === null,
    completedSteps: input.completedSteps,
    failedOperation: operation,
    failedField: input.failedField ?? failedField(operation),
    retryCommand: input.iid === null
      ? "harness-mrtool context --output json"
      : input.retry === "update"
        ? `harness-mrtool update ${String(input.iid)} --input - --non-interactive --output json`
        : `harness-mrtool verify ${String(input.iid)} --level structure --output json`,
  });
}

export function getTransactionFailureReceipt(error: unknown): TransactionFailureReceiptV1 | null {
  if ((typeof error !== "object" && typeof error !== "function") || error === null) return null;
  return failureReceipts.get(error) ?? null;
}
