import { copyJsonValue, type JsonValue } from "./jcs.ts";

export const ERROR_CODES = [
  "UPDATE_CHECK_WARNING",
  "UPDATE_SECURITY_ERROR",
  "UPDATE_REQUIRED",
  "REPOSITORY_ERROR",
  "AUTH_ERROR",
  "PROFILE_REQUIRED",
  "TEMPLATE_ERROR",
  "POLICY_ERROR",
  "LABEL_ERROR",
  "INPUT_ERROR",
  "INPUT_TOO_LARGE",
  "RENDER_ERROR",
  "GITLAB_ERROR",
  "CONCURRENT_UPDATE",
  "MANUAL_DESCRIPTION_CHANGE",
  "UNMANAGED_MR",
  "POSTCONDITION_ERROR",
  "PARTIAL_DRAFT",
  "PARTIAL_REMOTE_STATE",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
export type ResultCode = "OK" | ErrorCode;
export type FailureCode = Exclude<ErrorCode, "UPDATE_CHECK_WARNING">;

export interface ErrorDetails {
  readonly field: string | null;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
  readonly safeNextStep: string;
}

function normalizeDetails(details: ErrorDetails): ErrorDetails {
  if (details.field === undefined || (details.field !== null && typeof details.field !== "string")) {
    throw new TypeError("Error details field must be a string or null");
  }
  if (details.expected === undefined) {
    throw new TypeError("Error details expected must not be undefined");
  }
  if (details.actual === undefined) {
    throw new TypeError("Error details actual must not be undefined");
  }
  const expected = copyJsonValue(details.expected);
  const actual = copyJsonValue(details.actual);
  if (typeof details.safeNextStep !== "string" || details.safeNextStep.trim() === "") {
    throw new TypeError("Error details safeNextStep must be a non-empty string");
  }
  return {
    field: details.field,
    expected,
    actual,
    safeNextStep: details.safeNextStep.trim(),
  };
}

export class ToolError<Code extends ErrorCode = ErrorCode> extends Error {
  readonly code: Code;
  readonly details: ErrorDetails;

  constructor(
    code: Code,
    message: string,
    details: ErrorDetails,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    if (!(ERROR_CODES as readonly string[]).includes(code)) {
      throw new TypeError(`Unknown error code: ${String(code)}`);
    }
    this.name = "ToolError";
    this.code = code;
    this.details = normalizeDetails(details);
  }
}

export function isToolError<Code extends ErrorCode = ErrorCode>(
  error: unknown,
  code?: Code,
  messagePattern?: RegExp,
): error is ToolError<Code> {
  if (!(error instanceof ToolError)) {
    return false;
  }
  if (code !== undefined && error.code !== code) {
    return false;
  }
  if (messagePattern !== undefined) {
    messagePattern.lastIndex = 0;
    return messagePattern.test(error.message);
  }
  return true;
}
