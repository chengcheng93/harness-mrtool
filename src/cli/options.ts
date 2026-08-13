import { valid as validSemver } from "semver";

import { ToolError } from "../contracts/errors.ts";
import type { JsonValue } from "../contracts/jcs.ts";
import type { InputFormat } from "../input/load-input.ts";

export type CliClient = "manual" | "codex-skill" | "script";
export type CliOutput = "json";
export type CliProfileSelection =
  | { readonly kind: "auto" }
  | { readonly kind: "explicit"; readonly ids: readonly string[] };

export interface CliOptions {
  readonly input: string | null;
  readonly inputFormat: InputFormat | null;
  readonly nonInteractive: boolean;
  readonly output: CliOutput | null;
  readonly client: CliClient;
  readonly clientVersion: string | null;
  readonly skillProtocol: number | null;
  readonly push: boolean;
  readonly dryRun: boolean;
  readonly offline: boolean;
  readonly noUpdate: boolean;
  readonly profile: CliProfileSelection | null;
  readonly type: string | null;
  readonly module: string | null;
  readonly titleSummary: string | null;
}

interface MutableOptions {
  input: string | null;
  inputFormat: InputFormat | null;
  nonInteractive: boolean;
  output: CliOutput | null;
  client: CliClient;
  clientVersion: string | null;
  skillProtocol: number | null;
  push: boolean;
  dryRun: boolean;
  offline: boolean;
  noUpdate: boolean;
  profile: CliProfileSelection | null;
  type: string | null;
  module: string | null;
  titleSummary: string | null;
}

const BOOLEAN_FLAGS = new Set([
  "--non-interactive",
  "--push",
  "--dry-run",
  "--offline",
  "--no-update",
]);

const VALUE_FLAGS = new Set([
  "--input",
  "--input-format",
  "--output",
  "--client",
  "--client-version",
  "--skill-protocol",
  "--profile",
  "--type",
  "--module",
  "--title-summary",
]);

const EXACT_SEMVER =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function cliInputError(
  field: string | null,
  expected: JsonValue,
  actual: JsonValue,
): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Invalid command-line input", {
    field,
    expected,
    actual,
    safeNextStep: "Correct the command-line flags and run the command again.",
  });
}

function invalidFlag(flag: string | null, expected: JsonValue, actual: JsonValue): never {
  throw cliInputError(flag, expected, actual);
}

function parseProfile(raw: string): CliProfileSelection {
  if (raw === "auto") {
    return { kind: "auto" };
  }
  const ids = raw.split("+");
  if (
    ids.length === 0 ||
    ids.some((id) => !/^[a-z][a-z0-9-]*$/u.test(id)) ||
    new Set(ids).size !== ids.length
  ) {
    invalidFlag(
      "--profile",
      "auto or unique lowercase profile IDs joined by +",
      "invalid profile selection",
    );
  }
  return { kind: "explicit", ids };
}

function assertScalar(flag: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed !== value) {
    invalidFlag(flag, "a non-empty value without outer whitespace", "invalid scalar value");
  }
  return value;
}

function parseSkillProtocol(raw: string): number {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    invalidFlag("--skill-protocol", "a positive integer", "invalid protocol");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    invalidFlag("--skill-protocol", "a safe positive integer", "invalid protocol");
  }
  return value;
}

function applyBoolean(options: MutableOptions, flag: string): void {
  switch (flag) {
    case "--non-interactive": options.nonInteractive = true; break;
    case "--push": options.push = true; break;
    case "--dry-run": options.dryRun = true; break;
    case "--offline": options.offline = true; break;
    case "--no-update": options.noUpdate = true; break;
    default: invalidFlag(null, "a supported flag", "unsupported flag");
  }
}

function applyValue(options: MutableOptions, flag: string, value: string): void {
  switch (flag) {
    case "--input":
      options.input = assertScalar(flag, value);
      break;
    case "--input-format":
      if (value !== "json" && value !== "yaml") {
        invalidFlag(flag, "json or yaml", "unsupported input format");
      }
      options.inputFormat = value;
      break;
    case "--output":
      if (value !== "json") {
        invalidFlag(flag, "json", "unsupported output format");
      }
      options.output = value;
      break;
    case "--client":
      if (value !== "manual" && value !== "codex-skill" && value !== "script") {
        invalidFlag(flag, "manual, codex-skill, or script", "unsupported client");
      }
      options.client = value;
      break;
    case "--client-version":
      options.clientVersion = assertScalar(flag, value);
      break;
    case "--skill-protocol":
      options.skillProtocol = parseSkillProtocol(value);
      break;
    case "--profile":
      options.profile = parseProfile(value);
      break;
    case "--type":
      options.type = assertScalar(flag, value);
      break;
    case "--module":
      options.module = assertScalar(flag, value);
      break;
    case "--title-summary":
      options.titleSummary = assertScalar(flag, value);
      break;
    default:
      invalidFlag(null, "a supported flag", "unsupported flag");
  }
}

function assertClientTuple(options: MutableOptions): void {
  if (
    options.clientVersion !== null &&
    (!EXACT_SEMVER.test(options.clientVersion) || validSemver(options.clientVersion) === null)
  ) {
    invalidFlag("--client-version", "an exact semantic version", "invalid semantic version");
  }
  if (options.client === "codex-skill") {
    if (options.clientVersion === null) {
      invalidFlag("--client-version", "required for codex-skill", "missing client version");
    }
    if (options.skillProtocol === null) {
      invalidFlag("--skill-protocol", "required for codex-skill", "missing skill protocol");
    }
    return;
  }
  if (options.client === "manual" && options.clientVersion !== null) {
    invalidFlag("--client-version", "omitted for manual clients", "unexpected client version");
  }
  if (options.skillProtocol !== null) {
    invalidFlag("--skill-protocol", "only valid for codex-skill", "unexpected skill protocol");
  }
}

export function parseCliOptions(arguments_: readonly string[]): CliOptions {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw cliInputError(null, "an array of command-line strings", "invalid argument vector");
  }
  const options: MutableOptions = {
    input: null,
    inputFormat: null,
    nonInteractive: false,
    output: null,
    client: "manual",
    clientVersion: null,
    skillProtocol: null,
    push: false,
    dryRun: false,
    offline: false,
    noUpdate: false,
    profile: null,
    type: null,
    module: null,
    titleSummary: null,
  };
  const seen = new Set<string>();

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    const equals = argument.indexOf("=");
    const flag = equals < 0 ? argument : argument.slice(0, equals);
    const inlineValue = equals < 0 ? null : argument.slice(equals + 1);
    if (!BOOLEAN_FLAGS.has(flag) && !VALUE_FLAGS.has(flag)) {
      throw cliInputError(null, "a supported command-line flag", "unknown or positional argument");
    }
    if (seen.has(flag)) {
      invalidFlag(flag, "provided at most once", "duplicate flag");
    }
    seen.add(flag);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== null) {
        invalidFlag(flag, "a flag without a value", "unexpected flag value");
      }
      applyBoolean(options, flag);
      continue;
    }

    const value = inlineValue ?? arguments_[index + 1];
    if (value === undefined || (inlineValue === null && value.startsWith("--"))) {
      invalidFlag(flag, "a following value", "missing flag value");
    }
    if (inlineValue === null) {
      index += 1;
    }
    applyValue(options, flag, value);
  }

  if (options.input === null && options.inputFormat !== null) {
    invalidFlag("--input-format", "used together with --input", "input source is missing");
  }
  if (options.input === "-" && options.inputFormat === null) {
    invalidFlag("--input-format", "json or yaml for stdin", "stdin format is missing");
  }
  if (options.offline && options.noUpdate) {
    throw cliInputError(null, "either --offline or --no-update", "conflicting update modes");
  }
  assertClientTuple(options);
  return options;
}

export function mayPrompt(options: CliOptions, stdinIsTerminal: boolean): boolean {
  return options.client === "manual" &&
    !options.nonInteractive &&
    options.input !== "-" &&
    stdinIsTerminal;
}
