import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";
import type { CliCommandExecution } from "./execute.ts";

export type ReadOnlySuccessCommand = "doctor" | "context" | "labels.list" | "preview";

const CONTEXT_BEARER = /^hmrx1_[A-Za-z0-9_-]{43}$/u;
const CANDIDATE_BEARER = /^hmrc1_[A-Za-z0-9_-]{43}$/u;
const RAW_BEARER = /hmr[ctx]1_[A-Za-z0-9_-]{20,}/iu;
const SENSITIVE_KEY = /(?:authorization|private[-_ ]?token|job[-_ ]?token|bearer|credential)/iu;
const SENSITIVE_VALUE = /(?:glpat-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|(?:authorization|private[-_ ]?token|job[-_ ]?token|bearer|credential)\s*[:=]\s*\S+|bearer\s+\S+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;
const SENSITIVE_COMPACT_KEY_PARTS = [
  "authorization",
  "bearer",
  "credential",
  "passphrase",
  "password",
  "secret",
  "token",
] as const;

function unsafeSuccess(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Read-only success output failed the security policy", {
    field: "output",
    expected: "a canonical success projection without credentials or unauthorized bearers",
    actual: "unsafe structured success data",
    safeNextStep: "Retry after removing credential-shaped data from command inputs and remote metadata.",
  });
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function samePath(
  actual: readonly (string | number)[],
  expected: readonly (string | number)[],
): boolean {
  return actual.length === expected.length &&
    actual.every((part, index) => part === expected[index]);
}

function authorizedContextBearer(
  command: ReadOnlySuccessCommand,
  value: string,
  path: readonly (string | number)[],
): boolean {
  if (command !== "context") return false;
  if (CONTEXT_BEARER.test(value)) {
    return samePath(path, ["output", "data", "contextId"]);
  }
  if (!CANDIDATE_BEARER.test(value) || path.length !== 5 || path[4] !== "token") {
    return false;
  }
  return path[0] === "output" && path[1] === "data" &&
    (path[2] === "labelCandidates" || path[2] === "userCandidates") &&
    typeof path[3] === "number";
}

function sensitiveObjectKey(key: string): boolean {
  const compatible = key.normalize("NFKC");
  const compact = compatible.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return RAW_BEARER.test(compatible) || SENSITIVE_KEY.test(compatible) || SENSITIVE_VALUE.test(compatible) ||
    SENSITIVE_COMPACT_KEY_PARTS.some((part) => compact.includes(part));
}

function exactSchemaOption(value: JsonValue, key: "type" | "$ref", expected: string): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 1 && value[key] === expected;
}

function authorizedContextSchemaTokenProperty(
  command: ReadOnlySuccessCommand,
  key: string,
  child: JsonValue,
  path: readonly (string | number)[],
): boolean {
  if (command !== "context") {
    return false;
  }
  if (
    key === "assigneeCandidateToken" &&
    samePath(path, ["output", "data", "inputSchema", "definitions", "mergeRequest", "properties"]) &&
    child !== null && typeof child === "object" && !Array.isArray(child) &&
    Object.keys(child).length === 1 && Array.isArray(child.anyOf) && child.anyOf.length === 2
  ) {
    const [nullable, opaque] = child.anyOf;
    return nullable !== undefined && opaque !== undefined &&
      exactSchemaOption(nullable, "type", "null") &&
      exactSchemaOption(opaque, "$ref", "#/definitions/opaque");
  }
  const idArrayPath = key === "labelCandidateTokens"
    ? ["output", "data", "inputSchema", "definitions", "mergeRequest", "properties"] as const
    : key === "reviewerCandidateTokens"
      ? ["output", "data", "inputSchema", "definitions", "review", "properties"] as const
      : null;
  return idArrayPath !== null && samePath(path, idArrayPath) &&
    exactSchemaOption(child, "$ref", "#/definitions/idArray");
}

function authorizedContextTokenProperty(
  command: ReadOnlySuccessCommand,
  key: string,
  child: JsonValue,
  path: readonly (string | number)[],
): boolean {
  return key === "token" && typeof child === "string" &&
    authorizedContextBearer(command, child, [...path, key]);
}

function assertSafe(
  command: ReadOnlySuccessCommand,
  value: JsonValue,
  path: readonly (string | number)[],
): void {
  if (typeof value === "string") {
    if (authorizedContextBearer(command, value, path)) return;
    if (RAW_BEARER.test(value) || SENSITIVE_VALUE.test(value)) throw unsafeSuccess();
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertSafe(command, child, [...path, index]));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (
        sensitiveObjectKey(key) &&
        !authorizedContextTokenProperty(command, key, child, path) &&
        !authorizedContextSchemaTokenProperty(command, key, child, path)
      ) {
        throw unsafeSuccess();
      }
      assertSafe(command, child, [...path, key]);
    }
  }
}

export function guardReadOnlySuccess<T extends CliCommandExecution>(
  command: ReadOnlySuccessCommand,
  execution: T,
): T {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(execution, "$success");
  } catch {
    throw unsafeSuccess();
  }
  assertSafe(command, copied, []);
  return deepFreeze(copied) as unknown as T;
}
