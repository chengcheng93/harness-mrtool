import type { Request } from "../contracts/request.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  sha256CanonicalJson,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import type { CandidateContextStore } from "../context/store.ts";
import type {
  Candidate,
  CandidateKind,
  CandidateSelection,
  ContextBinding,
  ResolvedContext,
} from "../context/types.ts";
import {
  validateExternalContextSnapshot,
  type ExternalContextSnapshot,
} from "../render/marker.ts";
import { candidateSelectionDigest } from "./transaction-journal.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const CREDENTIAL_SHAPE = /(?:hmr[ctx]1_[A-Za-z0-9_-]{43}|glpat-[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|(?:authorization|bearer)\s*(?::|=|\s)\s*[A-Za-z0-9._~+/=-]{8,}|(?:private|job)[-_]?token\s*(?::|=)\s*[A-Za-z0-9._~+/=-]{8,}|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;
const CREDENTIAL_HEADER_KEY = /^(?:authorization|proxy-authorization|private[-_]?token|job[-_]?token|x-gitlab-token)$/iu;

export interface ResolveRequestCandidatesInput {
  readonly request: Request;
  readonly expectedBinding: ContextBinding;
  readonly store: Pick<CandidateContextStore, "resolve">;
  readonly consume: boolean;
}

export interface ResolvedRequestCandidates {
  readonly binding: ContextBinding;
  readonly snapshot: ExternalContextSnapshot;
  readonly candidates: readonly Candidate[];
  readonly candidateSelectionDigest: string;
}

function inputFailure(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Candidate resolution failed", {
    field: "candidateTokens",
    expected: "candidate tokens issued for the exact current context",
    actual: "candidate selection validation failed",
    safeNextStep: "Run context again and retry with the newly issued candidate values.",
  });
}

function internalFailure(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Candidate resolution failed safely", {
    field: null,
    expected: "one valid candidate-context result matching the exact request binding",
    actual: "the candidate context adapter violated its local contract",
    safeNextStep: "Retry the command; if the problem persists, repair the local state and installation.",
  });
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function record(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function exactFields(value: JsonObject, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((field, index) => field === wanted[index]);
}

function scalar(value: JsonValue | undefined): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim() &&
    !/[\r\n\u2028\u2029]/u.test(value);
}

function positiveInteger(value: JsonValue | undefined): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function selectionSnapshot(requestValue: Request): {
  readonly request: Request;
  readonly selections: readonly CandidateSelection[];
} {
  try {
    const request = copyJsonValue(requestValue, "$request") as unknown as Request;
    if (typeof request.contextId !== "string" ||
        !Array.isArray(request.mergeRequest?.labelCandidateTokens) ||
        !Array.isArray(request.review?.reviewerCandidateTokens) ||
        (request.mergeRequest.assigneeCandidateToken !== null &&
          typeof request.mergeRequest.assigneeCandidateToken !== "string") ||
        request.mergeRequest.labelCandidateTokens.some((token) => typeof token !== "string") ||
        request.review.reviewerCandidateTokens.some((token) => typeof token !== "string")) {
      throw inputFailure();
    }
    const selections: CandidateSelection[] = [
      ...request.mergeRequest.labelCandidateTokens.map((token) => ({ kind: "label" as const, token })),
      ...(request.mergeRequest.assigneeCandidateToken === null
        ? []
        : [{ kind: "assignee" as const, token: request.mergeRequest.assigneeCandidateToken }]),
      ...request.review.reviewerCandidateTokens.map((token) => ({ kind: "reviewer" as const, token })),
    ];
    return deepFreeze({ request, selections });
  } catch (error) {
    if (isToolError(error, "INPUT_ERROR")) throw error;
    throw inputFailure();
  }
}

function copiedBinding(value: ContextBinding, code: "INPUT_ERROR" | "INTERNAL_ERROR"): ContextBinding {
  try {
    return deepFreeze(copyJsonValue(value, "$binding") as unknown as ContextBinding);
  } catch {
    throw code === "INPUT_ERROR" ? inputFailure() : internalFailure();
  }
}

function valueContainsCredential(root: unknown): boolean {
  const pending: unknown[] = [root];
  const seen = new Set<object>();
  let visited = 0;
  while (pending.length > 0) {
    if (visited++ > 1_024) return true;
    const value = pending.pop();
    if (typeof value === "string") {
      if (CREDENTIAL_SHAPE.test(value)) return true;
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (seen.has(value)) return true;
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
      if (CREDENTIAL_HEADER_KEY.test(key) || CREDENTIAL_SHAPE.test(key)) return true;
      pending.push(child);
    }
  }
  return false;
}

function toolErrorContainsCredential(error: ToolError): boolean {
  try {
    return error.cause !== undefined ||
      valueContainsCredential(error.message) ||
      valueContainsCredential(error.details);
  } catch {
    return true;
  }
}

function rethrowStoreFailure(error: unknown): never {
  if (!isToolError(error)) throw internalFailure();
  if (!toolErrorContainsCredential(error)) throw error;
  if (error.code === "INPUT_ERROR" || error.code === "LABEL_ERROR") throw inputFailure();
  throw internalFailure();
}

function validateCandidate(value: JsonValue, expectedKind: CandidateKind): Candidate {
  const candidate = record(value);
  if (candidate === undefined || candidate.kind !== expectedKind) throw internalFailure();
  if (expectedKind === "label") {
    if (!exactFields(candidate, [
      "kind", "restId", "globalId", "name", "description", "color", "scopeKind",
      "scopeId", "scopePath", "policyCategory",
    ]) || !positiveInteger(candidate.restId) || !scalar(candidate.globalId) ||
        !scalar(candidate.name) || typeof candidate.description !== "string" ||
        !scalar(candidate.color) || !["project", "group"].includes(candidate.scopeKind as string) ||
        !scalar(candidate.scopeId) || !scalar(candidate.scopePath) || !scalar(candidate.policyCategory)) {
      throw internalFailure();
    }
  } else if (!exactFields(candidate, [
    "kind", "userId", "globalId", "username", "displayName",
  ]) || !scalar(candidate.userId) ||
      (candidate.globalId !== null && !scalar(candidate.globalId)) ||
      !scalar(candidate.username) || !scalar(candidate.displayName)) {
    throw internalFailure();
  }
  if (CREDENTIAL_SHAPE.test(canonicalizeJson(candidate))) throw internalFailure();
  return candidate as unknown as Candidate;
}

function validateSuccessfulResult(
  value: unknown,
  request: Request,
  expectedBinding: ContextBinding,
  expectedKinds: readonly CandidateKind[],
): ResolvedRequestCandidates {
  try {
    const copied = copyJsonValue(value, "$resolvedContext");
    const resolved = record(copied);
    if (resolved === undefined || !exactFields(resolved, [
      "contextId", "createdAtMs", "expiresAtMs", "binding", "externalSnapshotDigest",
      "snapshot", "candidates",
    ]) || resolved.contextId !== request.contextId ||
        !Number.isSafeInteger(resolved.createdAtMs) || (resolved.createdAtMs as number) < 0 ||
        !Number.isSafeInteger(resolved.expiresAtMs) ||
        (resolved.expiresAtMs as number) <= (resolved.createdAtMs as number) ||
        !SHA256.test(resolved.externalSnapshotDigest as string) ||
        !Array.isArray(resolved.candidates) || resolved.candidates.length !== expectedKinds.length) {
      throw internalFailure();
    }
    const returnedBinding = copiedBinding(resolved.binding as unknown as ContextBinding, "INTERNAL_ERROR");
    if (canonicalizeJson(returnedBinding) !== canonicalizeJson(expectedBinding)) throw internalFailure();

    let snapshot: ExternalContextSnapshot;
    try {
      snapshot = validateExternalContextSnapshot(resolved.snapshot);
    } catch {
      throw internalFailure();
    }
    if (sha256CanonicalJson(snapshot) !== resolved.externalSnapshotDigest) throw internalFailure();

    const candidates = deepFreeze(resolved.candidates.map((candidate, index) => {
      const kind = expectedKinds[index];
      if (kind === undefined) throw internalFailure();
      return validateCandidate(candidate, kind);
    }));
    const digest = candidateSelectionDigest(request, candidates, snapshot);
    const result = deepFreeze({
      binding: returnedBinding,
      snapshot,
      candidates,
      candidateSelectionDigest: digest,
    });
    if (CREDENTIAL_SHAPE.test(canonicalizeJson(result))) throw internalFailure();
    return result;
  } catch (error) {
    if (isToolError(error, "INTERNAL_ERROR")) throw error;
    throw internalFailure();
  }
}

export async function resolveRequestCandidates(
  input: ResolveRequestCandidatesInput,
): Promise<ResolvedRequestCandidates> {
  const selection = selectionSnapshot(input.request);
  const expectedBinding = copiedBinding(input.expectedBinding, "INPUT_ERROR");
  if (typeof input.consume !== "boolean" || input.store === null ||
      typeof input.store !== "object" || typeof input.store.resolve !== "function") {
    throw inputFailure();
  }
  const expectedKinds = selection.selections.map((item) => item.kind);
  const resolveStore = async (consume: boolean): Promise<ResolvedContext> => {
    let resolved: ResolvedContext;
    try {
      resolved = await input.store.resolve({
        contextId: selection.request.contextId,
        expectedBinding,
        selections: selection.selections,
        consume,
      });
    } catch (error) {
      rethrowStoreFailure(error);
    }
    return resolved;
  };
  const resolveAndValidate = async (consume: boolean): Promise<ResolvedRequestCandidates> =>
    validateSuccessfulResult(
      await resolveStore(consume),
      selection.request,
      expectedBinding,
      expectedKinds,
    );

  if (!input.consume || selection.selections.length === 0) {
    return resolveAndValidate(input.consume);
  }
  const validated = await resolveAndValidate(false);
  await resolveStore(true);
  return validated;
}
