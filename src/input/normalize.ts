import { Ajv, type ErrorObject } from "ajv";

import requestSchema from "../../schemas/request-v1.schema.json" with { type: "json" };
import { isToolError, ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";

type MutableObject = Record<string, JsonValue>;

export const MAX_STRUCTURED_VALUE_DEPTH = 256;

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

function structuredBoundaryError(actual: string): ToolError<"INPUT_ERROR"> {
  return inputError(null, "a plain JSON value no deeper than 256 levels", actual);
}

function assertStructuredValueBoundary(root: unknown): void {
  const pending: { readonly depth: number; readonly value: unknown }[] = [
    { depth: 0, value: root },
  ];
  const greatestVisitedDepth = new WeakMap<object, number>();

  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    const { depth, value } = current;
    if (depth > MAX_STRUCTURED_VALUE_DEPTH) {
      throw structuredBoundaryError("structured value exceeds 256 levels");
    }
    if (value === null || typeof value !== "object") {
      continue;
    }

    const previousDepth = greatestVisitedDepth.get(value);
    if (previousDepth !== undefined && previousDepth >= depth) {
      continue;
    }
    greatestVisitedDepth.set(value, depth);

    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (prototype !== Array.prototype) {
        throw structuredBoundaryError("structured value contains a non-plain array");
      }
    } else if (prototype !== Object.prototype && prototype !== null) {
      throw structuredBoundaryError("structured value contains a non-plain object");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw structuredBoundaryError("structured value contains symbol keys");
    }

    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const descriptor of Object.values(descriptors)) {
      if ("get" in descriptor || "set" in descriptor) {
        throw structuredBoundaryError("structured value contains an accessor property");
      }
      if (descriptor.enumerable && "value" in descriptor) {
        pending.push({ depth: depth + 1, value: descriptor.value });
      }
    }
  }
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
      trimScalar(item, "evidenceKind");
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
    compactAscii === "TBD";
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
    assertVerificationEvidence(item, index);
    if (item.command !== null) {
      assertMinimumText(item.command, `/verification/items/${index}/command`, 1, "a non-empty command");
    }
    if (item.result !== null) {
      assertMinimumText(item.result, `/verification/items/${index}/result`, 8, "a specific verification result");
    }
  }
}

function assertMinimumText(
  value: string,
  field: string,
  minimumScalars: number,
  expected: string,
): void {
  if ([...value.trim()].length < minimumScalars) {
    throw inputError(field, expected, "text is blank or too short");
  }
}

function assertVerificationEvidence(
  item: Request["verification"]["items"][number],
  index: number,
): void {
  const base = `/verification/items/${index}`;
  assertMinimumText(item.evidence, `${base}/evidence`, 16, "specific verification evidence or reason");
  if (item.state === "checked") {
    if (!["command-output", "file-inspection", "manual-verification"].includes(item.evidenceKind)) {
      throw inputError(`${base}/evidenceKind`, "a checked evidence source", "state and evidence kind conflict");
    }
    if (item.evidenceKind === "command-output" &&
        (item.command === null || item.result === null)) {
      throw inputError(base, "command and result for command output", "incomplete command output evidence");
    }
    if (item.evidenceKind !== "command-output" && item.result === null) {
      throw inputError(`${base}/result`, "a verification result", "missing result");
    }
    return;
  }
  if (item.state === "pending") {
    if (item.evidenceKind !== "pending-reason" || item.command !== null || item.result !== null) {
      throw inputError(base, "pending-reason with null command and result", "invalid pending evidence fields");
    }
    return;
  }
  if (item.evidenceKind !== "not-applicable-reason" ||
      item.command !== null || item.result !== null) {
    throw inputError(
      base,
      "not-applicable-reason with null command and result",
      "invalid not-applicable evidence fields",
    );
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

function containsConservativeV1TitleMarkup(title: string): boolean {
  if (/^\s{0,3}(?:#{1,6}\s|>|[-+]\s|\d{1,9}[.)]\s|\[[^\]\r\n]+\]:)/u.test(title) ||
      /^\s{0,3}(?:`{3,}|~{3,})/u.test(title) ||
      /^\s{0,3}(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,})$/u.test(title)) {
    return true;
  }
  return /!?\[[^\]\r\n]+\](?:\([^\r\n)]*\)|\[[^\]\r\n]*\])/u.test(title) ||
    /&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z][A-Za-z0-9]+);/u.test(title) ||
    /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^ <>\r\n]*|[^ <>@\r\n]+@[^ <>\r\n]+)>/u.test(title) ||
    /<!--|<\?|<![A-Z]|<!\[CDATA\[/u.test(title) ||
    /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s+[^<>\r\n]*)?\s*\/?>/u.test(title) ||
    /\\[!"#$%&'()*+,./:;<=>?@[\]^_`{|}~-]/u.test(title) ||
    /~~[^~\r\n]+~~/u.test(title) ||
    hasMatchingCodeSpanRuns(title) ||
    hasMatchingEmphasisRuns(title);
}

function hasMatchingCodeSpanRuns(title: string): boolean {
  const runs: { readonly start: number; readonly end: number }[] = [];
  for (let index = 0; index < title.length;) {
    if (title[index] !== "`") {
      index += 1;
      continue;
    }
    const start = index;
    while (title[index] === "`") {
      index += 1;
    }
    runs.push({ start, end: index });
  }
  return runs.some((opener, index) => runs.slice(index + 1).some((closer) =>
    closer.start > opener.end && closer.end - closer.start === opener.end - opener.start));
}

interface EmphasisDelimiterRun {
  readonly marker: "*" | "_";
  readonly length: number;
  readonly canOpen: boolean;
  readonly canClose: boolean;
}

function isCommonMarkWhitespace(value: string | undefined): boolean {
  return value === undefined || /^[\t\n\f\r \p{Zs}]$/u.test(value);
}

function isCommonMarkPunctuation(value: string | undefined): boolean {
  return value !== undefined && /^[\p{P}\p{S}]$/u.test(value);
}

function emphasisDelimiterRuns(title: string): EmphasisDelimiterRun[] {
  const characters = [...title];
  const runs: EmphasisDelimiterRun[] = [];
  for (let index = 0; index < characters.length;) {
    const marker = characters[index];
    if (marker !== "*" && marker !== "_") {
      index += 1;
      continue;
    }
    const start = index;
    while (characters[index] === marker) {
      index += 1;
    }
    const before = characters[start - 1];
    const after = characters[index];
    const beforeWhitespace = isCommonMarkWhitespace(before);
    const afterWhitespace = isCommonMarkWhitespace(after);
    const beforePunctuation = isCommonMarkPunctuation(before);
    const afterPunctuation = isCommonMarkPunctuation(after);
    const leftFlanking = !afterWhitespace &&
      (!afterPunctuation || beforeWhitespace || beforePunctuation);
    const rightFlanking = !beforeWhitespace &&
      (!beforePunctuation || afterWhitespace || afterPunctuation);
    runs.push({
      marker,
      length: index - start,
      canOpen: marker === "*"
        ? leftFlanking
        : leftFlanking && (!rightFlanking || beforePunctuation),
      canClose: marker === "*"
        ? rightFlanking
        : rightFlanking && (!leftFlanking || afterPunctuation),
    });
  }
  return runs;
}

function hasMatchingEmphasisRuns(title: string): boolean {
  const runs = emphasisDelimiterRuns(title);
  for (let openerIndex = 0; openerIndex < runs.length; openerIndex += 1) {
    const opener = runs[openerIndex];
    if (opener === undefined || !opener.canOpen) {
      continue;
    }
    for (const closer of runs.slice(openerIndex + 1)) {
      if (closer.marker !== opener.marker || !closer.canClose) {
        continue;
      }
      const violatesRuleOfThree = (opener.canClose || closer.canOpen) &&
        (opener.length + closer.length) % 3 === 0 &&
        (opener.length % 3 !== 0 || closer.length % 3 !== 0);
      if (!violatesRuleOfThree) {
        return true;
      }
    }
  }
  return false;
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
  try {
    assertStructuredValueBoundary(value);
    const copied = copyJsonValue(value);
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
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw inputError(
      null,
      "JSON-compatible structured request",
      "structured request processing failed",
    );
  }
}
