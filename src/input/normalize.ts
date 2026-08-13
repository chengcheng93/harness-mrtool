import { Ajv, type ErrorObject } from "ajv";

import requestSchema from "../../schemas/request-v1.schema.json" with { type: "json" };
import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";

type MutableObject = Record<string, JsonValue>;

const requestValidator = new Ajv({ allErrors: true, strict: true }).compile<Request>(
  requestSchema,
);

function inputError(field: string | null, expected: JsonValue, actual: JsonValue): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Structured request validation failed", {
    field,
    expected,
    actual,
    safeNextStep: "Correct the reported request field and submit the structured input again.",
  });
}

function asObject(value: JsonValue | undefined): MutableObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as MutableObject
    : undefined;
}

function normalizeLineEndings(value: JsonValue): JsonValue {
  if (typeof value === "string") {
    return value.replace(/\r\n?/gu, "\n");
  }
  if (Array.isArray(value)) {
    return value.map(normalizeLineEndings);
  }
  if (value !== null && typeof value === "object") {
    const normalized: MutableObject = {};
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        value: normalizeLineEndings(child),
        writable: true,
      });
    }
    return normalized;
  }
  return value;
}

function trimScalar(object: MutableObject | undefined, key: string): void {
  if (object === undefined) {
    return;
  }
  const value = object[key];
  if (typeof value === "string") {
    object[key] = value.trim();
  }
}

function trimStringArray(object: MutableObject | undefined, key: string): void {
  if (object === undefined) {
    return;
  }
  const value = object[key];
  if (Array.isArray(value)) {
    object[key] = value.map((item) => typeof item === "string" ? item.trim() : item);
  }
}

function defaultArray(object: MutableObject | undefined, key: string): void {
  if (object !== undefined && object[key] === undefined) {
    object[key] = [];
  }
}

function normalizeProfileFields(root: MutableObject): void {
  if (root.profileFields === undefined) {
    root.profileFields = {};
    return;
  }
  const fields = asObject(root.profileFields);
  if (fields === undefined) {
    return;
  }
  const normalized: MutableObject = {};
  for (const [key, value] of Object.entries(fields)) {
    const normalizedKey = key.trim();
    if (["__proto__", "prototype", "constructor"].includes(normalizedKey)) {
      throw inputError("/profileFields", "safe profile field IDs", "reserved property name");
    }
    if (Object.hasOwn(normalized, normalizedKey)) {
      throw inputError("/profileFields", "unique canonical field IDs", "duplicate canonical field ID");
    }
    Object.defineProperty(normalized, normalizedKey, {
      configurable: true,
      enumerable: true,
      value,
      writable: true,
    });
  }
  root.profileFields = normalized;
}

function normalizeRequestShape(value: JsonValue): JsonValue {
  const normalized = normalizeLineEndings(value);
  const root = asObject(normalized);
  if (root === undefined) {
    return normalized;
  }

  trimScalar(root, "contextId");
  trimScalar(root, "intent");
  trimScalar(root, "targetBranch");
  trimStringArray(root, "profileIds");

  const title = asObject(root.title);
  for (const field of ["type", "module", "titleSummary"]) {
    trimScalar(title, field);
  }

  const changes = asObject(root.changes);
  for (const field of ["summary", "technicalChanges", "outOfScope"]) {
    defaultArray(changes, field);
  }
  const motivation = asObject(root.motivation);
  for (const field of ["background", "whyNeeded"]) {
    defaultArray(motivation, field);
  }

  const workItem = asObject(root.workItem);
  trimScalar(workItem, "relation");

  const impact = asObject(root.impact);
  defaultArray(impact, "areaIds");
  defaultArray(impact, "details");
  trimStringArray(impact, "areaIds");
  trimScalar(impact, "nature");

  const verification = asObject(root.verification);
  for (const field of ["items", "acceptanceEvidence", "knownGaps"]) {
    defaultArray(verification, field);
  }
  if (Array.isArray(verification?.items)) {
    for (const itemValue of verification.items) {
      const item = asObject(itemValue);
      trimScalar(item, "id");
      trimScalar(item, "state");
      for (const field of ["command", "result"]) {
        const optional = item?.[field];
        if (item !== undefined && (optional === undefined || optional === null ||
          (typeof optional === "string" && optional.trim() === ""))) {
          item[field] = null;
        }
      }
    }
  }

  const documentation = asObject(root.documentation);
  for (const field of ["itemIds", "details"]) {
    defaultArray(documentation, field);
  }
  trimStringArray(documentation, "itemIds");

  const risk = asObject(root.risk);
  trimScalar(risk, "level");
  for (const field of ["items", "compatibilityImpact", "rollbackPlan"]) {
    defaultArray(risk, field);
  }

  normalizeProfileFields(root);

  const review = asObject(root.review);
  for (const field of ["reviewerCandidateTokens", "reviewerFocus", "additionalNotes"]) {
    defaultArray(review, field);
  }
  trimStringArray(review, "reviewerCandidateTokens");

  const mergeRequest = asObject(root.mergeRequest);
  defaultArray(mergeRequest, "labelCandidateTokens");
  trimStringArray(mergeRequest, "labelCandidateTokens");
  const assignee = mergeRequest?.assigneeCandidateToken;
  if (mergeRequest !== undefined) {
    mergeRequest.assigneeCandidateToken =
      assignee === undefined || assignee === null ||
      (typeof assignee === "string" && assignee.trim() === "")
        ? null
        : typeof assignee === "string" ? assignee.trim() : assignee;
  }

  return normalized;
}

function safeField(error: ErrorObject): string | null {
  if (error.instancePath === "") {
    return null;
  }
  return error.instancePath.startsWith("/profileFields/")
    ? "/profileFields/*"
    : error.instancePath;
}

function isPlaceholder(value: string): boolean {
  const trimmed = value.trim();
  const compactAscii = trimmed.replace(/\s/gu, "").toUpperCase();
  return trimmed === "\u65e0" || compactAscii === "N/A" || compactAscii === "NA" ||
    compactAscii === "TBD" || compactAscii === "NOTAPPLICABLE";
}

function assertProse(value: string, field: string): void {
  if (value.trim() === "" || isPlaceholder(value)) {
    throw inputError(field, "specific non-placeholder text", "blank or placeholder text");
  }
}

function assertProseArray(values: readonly string[], field: string): void {
  values.forEach((value, index) => assertProse(value, `${field}/${index}`));
}

function assertSemanticContent(request: Request): void {
  const arrays: readonly [readonly string[], string][] = [
    [request.changes.summary, "/changes/summary"],
    [request.changes.technicalChanges, "/changes/technicalChanges"],
    [request.changes.outOfScope, "/changes/outOfScope"],
    [request.motivation.background, "/motivation/background"],
    [request.motivation.whyNeeded, "/motivation/whyNeeded"],
    [request.impact.details, "/impact/details"],
    [request.verification.acceptanceEvidence, "/verification/acceptanceEvidence"],
    [request.verification.knownGaps, "/verification/knownGaps"],
    [request.documentation.details, "/documentation/details"],
    [request.risk.items, "/risk/items"],
    [request.risk.compatibilityImpact, "/risk/compatibilityImpact"],
    [request.risk.rollbackPlan, "/risk/rollbackPlan"],
    [request.review.reviewerFocus, "/review/reviewerFocus"],
    [request.review.additionalNotes, "/review/additionalNotes"],
  ];
  for (const [values, field] of arrays) {
    assertProseArray(values, field);
  }
  for (const [fieldId, values] of Object.entries(request.profileFields)) {
    assertProseArray(values, "/profileFields/*");
  }
  if (request.workItem.relation === "none") {
    assertProse(request.workItem.noIssueReason, "/workItem/noIssueReason");
  }
  for (const [index, item] of request.verification.items.entries()) {
    assertProse(item.evidence, `/verification/items/${index}/evidence`);
    assertVerificationEvidence(item.state, item.evidence, index);
    if (item.command !== null) {
      assertProse(item.command, `/verification/items/${index}/command`);
    }
    if (item.result !== null) {
      assertProse(item.result, `/verification/items/${index}/result`);
    }
  }
}

const GENERIC_AFFIRMATIONS = new Set(["yes", "pass", "passed", "ok", "success"]);
const MINIMUM_REASON_SCALARS = 8;

function normalizedWords(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function assertVerificationEvidence(
  state: Request["verification"]["items"][number]["state"],
  evidence: string,
  index: number,
): void {
  const field = `/verification/items/${index}/evidence`;
  const normalized = normalizedWords(evidence);
  const affirmation = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
  if (state === "checked" && GENERIC_AFFIRMATIONS.has(affirmation)) {
    throw inputError(field, "specific verification evidence", "generic affirmation");
  }
  if (state === "not-applicable") {
    const compact = normalized.replace(/[^\p{L}\p{N}]+/gu, "");
    if (isPlaceholder(evidence) || /^n\s*\/\s*a\b/iu.test(normalized) ||
        normalized.startsWith("not applicable") ||
        normalized.startsWith("does not apply") ||
        [...compact].length < MINIMUM_REASON_SCALARS) {
      throw inputError(
        field,
        "a substantive reason explaining why the check is not applicable",
        "missing or generic not-applicable reason",
      );
    }
  }
}

function assertTitle(titleSummary: string): void {
  if (isPlaceholder(titleSummary)) {
    throw inputError("/title/titleSummary", "specific non-placeholder text", "placeholder text");
  }
  if ([...titleSummary].length > 72) {
    throw inputError("/title/titleSummary", "at most 72 Unicode scalar values", "too many Unicode scalar values");
  }
  if (/^(?:draft\s*:\s*)?\[[^\]\r\n]+\]\[[^\]\r\n]+\]/iu.test(titleSummary) ||
      /^draft\s*:/iu.test(titleSummary)) {
    throw inputError("/title/titleSummary", "summary without a rendered title prefix", "existing title prefix");
  }
  if (containsConservativeV1TitleMarkup(titleSummary)) {
    throw inputError("/title/titleSummary", "plain single-line text without Markdown", "Markdown syntax");
  }
}

// V1 titles intentionally reject Markdown-capable punctuation instead of
// attempting to embed a full CommonMark parser in the input contract.
const DISALLOWED_TITLE_CHARACTERS = new Set(["*", "_", "~", "`", "<", ">", "\\", "&"]);

function containsConservativeV1TitleMarkup(title: string): boolean {
  if ([...title].some((character) => DISALLOWED_TITLE_CHARACTERS.has(character))) {
    return true;
  }
  if (/^\s{0,3}(?:#{1,6}\s|>|[-+]\s|\d{1,9}[.)]\s|\[[^\]\r\n]+\]:)/u.test(title) ||
      /^\s{0,3}(?:-\s*){3,}$/u.test(title)) {
    return true;
  }
  return /!?\[[^\]\r\n]+\](?:\([^\r\n)]*\)|\[[^\]\r\n]*\])/u.test(title);
}

function assertImpactAreas(request: Request): void {
  if (request.impact.nature !== "docs-only" && request.impact.areaIds.length === 0) {
    throw inputError(
      "/impact/areaIds",
      "at least one impact area for functional or non-functional changes",
      "empty impact area selection",
    );
  }
}

function assertCanonicalScalar(value: string, field: string): void {
  if (isPlaceholder(value)) {
    throw inputError(field, "specific non-placeholder identifier", "placeholder identifier");
  }
}

function assertCanonicalScalars(request: Request): void {
  assertCanonicalScalar(request.contextId, "/contextId");
  assertCanonicalScalar(request.targetBranch, "/targetBranch");
  assertCanonicalScalar(request.title.type, "/title/type");
  assertCanonicalScalar(request.title.module, "/title/module");
  request.profileIds.forEach((value, index) =>
    assertCanonicalScalar(value, `/profileIds/${index}`));
  request.impact.areaIds.forEach((value, index) =>
    assertCanonicalScalar(value, `/impact/areaIds/${index}`));
  request.documentation.itemIds.forEach((value, index) =>
    assertCanonicalScalar(value, `/documentation/itemIds/${index}`));
  request.review.reviewerCandidateTokens.forEach((value, index) =>
    assertCanonicalScalar(value, `/review/reviewerCandidateTokens/${index}`));
  request.mergeRequest.labelCandidateTokens.forEach((value, index) =>
    assertCanonicalScalar(value, `/mergeRequest/labelCandidateTokens/${index}`));
  if (request.mergeRequest.assigneeCandidateToken !== null) {
    assertCanonicalScalar(
      request.mergeRequest.assigneeCandidateToken,
      "/mergeRequest/assigneeCandidateToken",
    );
  }
  request.verification.items.forEach((item, index) =>
    assertCanonicalScalar(item.id, `/verification/items/${index}/id`));
  Object.keys(request.profileFields).forEach((fieldId) =>
    assertCanonicalScalar(fieldId, "/profileFields/*"));
}

function assertUniqueVerificationIds(request: Request): void {
  const ids = new Set<string>();
  for (const item of request.verification.items) {
    if (ids.has(item.id)) {
      throw inputError("/verification/items", "unique verification IDs", "duplicate verification ID");
    }
    ids.add(item.id);
  }
}

export function normalizeAndValidateRequest(value: unknown): Request {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch (error) {
    throw inputError(null, "JSON-compatible structured request", "non-JSON request value");
  }
  const normalized = normalizeRequestShape(copied);
  if (!requestValidator(normalized)) {
    const issue = requestValidator.errors?.[0];
    throw inputError(
      issue === undefined ? null : safeField(issue),
      issue?.keyword ?? "request-v1 schema",
      "invalid request value",
    );
  }
  assertTitle(normalized.title.titleSummary);
  assertImpactAreas(normalized);
  assertCanonicalScalars(normalized);
  assertSemanticContent(normalized);
  assertUniqueVerificationIds(normalized);
  return normalized;
}
