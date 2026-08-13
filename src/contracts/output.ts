import { Ajv, type ErrorObject } from "ajv";

import outputSchema from "../../schemas/output-v1.schema.json" with { type: "json" };
import {
  type ErrorDetails,
  type FailureCode,
  isToolError,
  type ResultCode,
  ToolError,
} from "./errors.ts";
import {
  type RemoteWrite,
  type RemoteWriteState,
} from "./exit-codes.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  type JsonObject,
  type JsonValue,
} from "./jcs.ts";

export const OUTPUT_SCHEMA_VERSION = 1 as const;

export interface VersionInfo {
  readonly cliVersion: string;
  readonly templateVersion: string | null;
  readonly bundleHash: string | null;
  readonly releaseSetId: string | null;
  readonly inputSchema: number | null;
  readonly policySchema: number | null;
  readonly loadedSkillVersion: string | null;
  readonly loadedSkillProtocol: number | null;
  readonly installedSkillVersion: string | null;
  readonly stagedSkillVersion: string | null;
  readonly manifestSequence: number | null;
}

export interface UpdateState {
  readonly checked: boolean;
  readonly reachable: boolean | null;
  readonly usingLastKnownGood: boolean;
  readonly latestVersionConfirmed: boolean;
  readonly warning: string | null;
  readonly securityAnomaly: boolean;
  readonly activationRequired: boolean;
  readonly hostRefreshMayBeRequired: boolean;
  readonly persistencePending: boolean;
  readonly executedVersion: string;
  readonly installedVersion: string;
}

export interface ValidationIssue {
  readonly code: string;
  readonly field: string | null;
  readonly message: string;
  readonly expected: JsonValue;
  readonly actual: JsonValue;
  readonly safeNextStep: string;
}

export interface ValidationState {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface OutputWarning {
  readonly code: "UPDATE_CHECK_WARNING";
  readonly message: string;
}

export interface OutputContext {
  readonly cliVersion: string;
  readonly versions?: Partial<Omit<VersionInfo, "cliVersion">>;
  readonly update?: Partial<UpdateState>;
  readonly validation?: ValidationState;
  readonly remoteWrite?: RemoteWrite;
  readonly warnings?: readonly OutputWarning[];
}

interface OutputBase {
  readonly schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
  readonly ok: boolean;
  readonly code: ResultCode;
  readonly message: string;
  readonly versions: VersionInfo;
  readonly update: UpdateState;
  readonly validation: ValidationState;
  readonly remoteWrite: {
    readonly state: RemoteWriteState;
    readonly operations: readonly string[];
  };
  readonly warnings: readonly OutputWarning[];
  readonly error: ErrorDetails | null;
  readonly data: JsonObject | null;
}

export interface SuccessOutput extends OutputBase {
  readonly ok: true;
  readonly code: "OK";
  readonly error: null;
}

export interface FailureOutput extends OutputBase {
  readonly ok: false;
  readonly code: FailureCode;
  readonly error: ErrorDetails;
}

export type OutputEnvelope = SuccessOutput | FailureOutput;

export interface SuccessOptions {
  readonly message?: string;
  readonly data?: JsonObject | null;
}

const outputValidator = new Ajv({ allErrors: true, strict: true }).compile(
  outputSchema,
);

function contractViolation(errors: ErrorObject[] | null | undefined): TypeError {
  const locations = [
    ...new Set(
      (errors ?? []).map((error) =>
        error.instancePath === "" ? "/" : error.instancePath,
      ),
    ),
  ].slice(0, 3);
  const locationSummary = locations.length === 0
    ? "output envelope"
    : locations.join(", ");
  return new TypeError(`Output contract violation at ${locationSummary}`);
}

function assertOutputContract(value: unknown): asserts value is OutputEnvelope {
  if (!outputValidator(value)) {
    throw contractViolation(outputValidator.errors);
  }
}

function assertOnlyFields(
  value: unknown,
  allowedFields: ReadonlySet<string>,
  location: string,
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Output contract violation at ${location}`);
  }
  if (Object.keys(value).some((field) => !allowedFields.has(field))) {
    throw new TypeError(
      `Output contract violation: unsupported field in ${location}`,
    );
  }
}

const CONTEXT_FIELDS = new Set([
  "cliVersion",
  "versions",
  "update",
  "validation",
  "remoteWrite",
  "warnings",
]);
const VERSION_FIELDS = new Set([
  "templateVersion",
  "bundleHash",
  "releaseSetId",
  "inputSchema",
  "policySchema",
  "loadedSkillVersion",
  "loadedSkillProtocol",
  "installedSkillVersion",
  "stagedSkillVersion",
  "manifestSequence",
]);
const UPDATE_FIELDS = new Set([
  "checked",
  "reachable",
  "usingLastKnownGood",
  "latestVersionConfirmed",
  "warning",
  "securityAnomaly",
  "activationRequired",
  "hostRefreshMayBeRequired",
  "persistencePending",
  "executedVersion",
  "installedVersion",
]);
const VALIDATION_FIELDS = new Set(["valid", "issues"]);
const REMOTE_WRITE_FIELDS = new Set(["state", "operations"]);
const SUCCESS_OPTION_FIELDS = new Set(["message", "data"]);
const ERROR_DETAIL_FIELDS = new Set([
  "field",
  "expected",
  "actual",
  "safeNextStep",
]);

function ownDataProperty(
  value: object,
  field: string,
  location: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`Output contract violation at ${location}/${field}`);
  }
  return descriptor.value;
}

function validateFactoryInput(value: unknown): void {
  try {
    canonicalizeJson(value);
  } catch (error) {
    throw new TypeError("Output factory input must contain only valid JSON", {
      cause: error,
    });
  }
}

function snapshotJson<T extends JsonValue>(value: T): T {
  return copyJsonValue(value) as T;
}

function assertVersionCounters(versions: VersionInfo): void {
  for (const [field, value] of [
    ["inputSchema", versions.inputSchema],
    ["policySchema", versions.policySchema],
  ] as const) {
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      throw new TypeError(`Output version ${field} must be a positive integer or null`);
    }
  }
  if (
    versions.loadedSkillProtocol !== null &&
    (!Number.isInteger(versions.loadedSkillProtocol) ||
      versions.loadedSkillProtocol < 0)
  ) {
    throw new TypeError(
      "Output version loadedSkillProtocol must be a non-negative integer or null",
    );
  }
  if (
    versions.manifestSequence !== null &&
    (!Number.isInteger(versions.manifestSequence) || versions.manifestSequence < 1)
  ) {
    throw new TypeError(
      "Output version manifestSequence must be a positive integer or null",
    );
  }
}

function commonOutput(context: OutputContext): Omit<OutputBase, "schemaVersion" | "ok" | "code" | "message" | "error" | "data"> {
  validateFactoryInput(context);
  assertOnlyFields(context, CONTEXT_FIELDS, "output context");
  if (context.versions !== undefined) {
    assertOnlyFields(context.versions, VERSION_FIELDS, "versions");
  }
  if (context.update !== undefined) {
    assertOnlyFields(context.update, UPDATE_FIELDS, "update");
  }
  if (context.validation !== undefined) {
    assertOnlyFields(context.validation, VALIDATION_FIELDS, "validation");
  }
  if (context.remoteWrite !== undefined) {
    assertOnlyFields(context.remoteWrite, REMOTE_WRITE_FIELDS, "remoteWrite");
  }
  if (typeof context.cliVersion !== "string" || context.cliVersion === "") {
    throw new TypeError("Output context cliVersion must be a non-empty string");
  }

  const versions: VersionInfo = {
    cliVersion: context.cliVersion,
    templateVersion: null,
    bundleHash: null,
    releaseSetId: null,
    inputSchema: null,
    policySchema: null,
    loadedSkillVersion: null,
    loadedSkillProtocol: null,
    installedSkillVersion: null,
    stagedSkillVersion: null,
    manifestSequence: null,
    ...context.versions,
  };
  const update: UpdateState = {
    checked: false,
    reachable: null,
    usingLastKnownGood: false,
    latestVersionConfirmed: false,
    warning: null,
    securityAnomaly: false,
    activationRequired: false,
    hostRefreshMayBeRequired: false,
    persistencePending: false,
    executedVersion: context.cliVersion,
    installedVersion: context.cliVersion,
    ...context.update,
  };
  assertVersionCounters(versions);
  const validation: ValidationState = context.validation === undefined
    ? { valid: true, issues: [] }
    : {
        valid: context.validation.valid,
        issues: context.validation.issues.map((issue) => ({
          ...issue,
          expected: snapshotJson(issue.expected),
          actual: snapshotJson(issue.actual),
        })),
      };
  const remoteWrite = context.remoteWrite === undefined
    ? { state: "not-attempted" as const, operations: [] }
    : {
        state: context.remoteWrite.state,
        operations: [...context.remoteWrite.operations],
      };
  const warnings = context.warnings?.map((warning) => ({ ...warning })) ?? [];

  const common = { versions, update, validation, remoteWrite, warnings };
  validateFactoryInput(common);
  return common;
}

export function createSuccessOutput(
  context: OutputContext,
  options: SuccessOptions = {},
): SuccessOutput {
  validateFactoryInput(options);
  assertOnlyFields(options, SUCCESS_OPTION_FIELDS, "success options");
  const output: SuccessOutput = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    ok: true,
    code: "OK",
    message: options.message ?? "Command completed successfully",
    ...commonOutput(context),
    error: null,
    data: options.data === undefined || options.data === null
      ? null
      : snapshotJson(options.data),
  };
  assertOutputContract(output);
  return output;
}

export function createFailureOutput(
  context: OutputContext,
  error: ToolError<FailureCode>,
  data: JsonObject | null = null,
): FailureOutput {
  if (!isToolError(error)) {
    throw new TypeError("Failure output requires a genuine ToolError instance");
  }
  const candidateCode = ownDataProperty(error, "code", "error") as string;
  const candidateMessage = ownDataProperty(error, "message", "error") as string;
  const candidateDetails = ownDataProperty(error, "details", "error");
  assertOnlyFields(candidateDetails, ERROR_DETAIL_FIELDS, "error details");
  const detailsSnapshot = snapshotJson(candidateDetails as JsonObject);
  const failureCodes = [
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
  ] as const satisfies readonly FailureCode[];
  if (!(failureCodes as readonly string[]).includes(candidateCode)) {
    throw new TypeError(`${String(error.code)} is not a valid failure code`);
  }
  validateFactoryInput(data);
  const output: FailureOutput = {
    schemaVersion: OUTPUT_SCHEMA_VERSION,
    ok: false,
    code: candidateCode as FailureCode,
    message: candidateMessage,
    ...commonOutput(context),
    error: detailsSnapshot as unknown as ErrorDetails,
    data: data === null ? null : snapshotJson(data),
  };
  assertOutputContract(output);
  return output;
}

export function serializeOutput(output: OutputEnvelope): string {
  validateFactoryInput(output);
  assertOutputContract(output);
  return `${JSON.stringify(output)}\n`;
}
