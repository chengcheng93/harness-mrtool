import { ToolError } from "../contracts/errors.ts";
import type { JsonValue } from "../contracts/jcs.ts";
import {
  cliOptionArity,
  isExactCliSemver,
  parseCliOptions,
  type CliOptions,
} from "./options.ts";


type VerificationLevel = "structure" | "ready" | "merge";
type ProjectTemplateProfile = "general" | "code" | "docs" | "ops";


export type CliCommand =
  | { readonly kind: "doctor" }
  | { readonly kind: "context"; readonly mrIid: number | null; readonly migrateTemplate: boolean }
  | { readonly kind: "create"; readonly upsert: boolean }
  | {
      readonly kind: "update";
      readonly iid: number | null;
      readonly migrateTemplate: boolean;
      readonly confirmation: string | null;
      readonly forceReplaceDescription: boolean;
    }
  | { readonly kind: "verify"; readonly iid: number | null; readonly level: VerificationLevel }
  | { readonly kind: "preview" }
  | { readonly kind: "manual"; readonly sshMergeRequest: boolean }
  | { readonly kind: "schema.show"; readonly fromMrIid: number | null }
  | { readonly kind: "profiles.list" }
  | { readonly kind: "profiles.detect" }
  | { readonly kind: "labels.list" }
  | { readonly kind: "template.show" }
  | { readonly kind: "template.refresh" }
  | { readonly kind: "template.export"; readonly profile: ProjectTemplateProfile; readonly destination: string }
  | { readonly kind: "self-update.check"; readonly force: boolean }
  | { readonly kind: "self-update.status" }
  | { readonly kind: "self-update.apply"; readonly timeoutSeconds: number | null }
  | { readonly kind: "self-update.rollback"; readonly version: string }
  | { readonly kind: "skill.install"; readonly path: string }
  | { readonly kind: "skill.activate"; readonly version: string; readonly path: string }
  | { readonly kind: "skill.status" }
  | { readonly kind: "version" };


export interface CliInvocation {
  readonly command: CliCommand;
  readonly options: CliOptions;
}


type CommandKind = CliCommand["kind"];
type FlagArity = "boolean" | "value";


const BASE_COMMON_FLAGS = new Set([
  "--output",
  "--client",
  "--client-version",
  "--auth",
  "--skill-protocol",
  "--offline",
  "--no-update",
]);
const REQUEST_COMMON_FLAGS = new Set([
  ...BASE_COMMON_FLAGS,
  "--input",
  "--input-format",
  "--non-interactive",
  "--push",
  "--dry-run",
  "--profile",
  "--type",
  "--module",
  "--title-summary",
]);
const LOCAL_COMMON_FLAGS = new Set([
  ...BASE_COMMON_FLAGS,
]);


const SPECIFIC_FLAGS: Readonly<Partial<Record<CommandKind, Readonly<Record<string, FlagArity>>>>> = {
  manual: { "--ssh-mr": "boolean" },
  create: { "--upsert": "boolean" },
  context: { "--mr": "value", "--migrate-template": "boolean" },
  update: {
    "--migrate-template": "boolean",
    "--confirm-migration": "value",
    "--force-replace-description": "boolean",
  },
  verify: { "--level": "value" },
  "schema.show": { "--from-mr": "value" },
  "template.export": { "--destination": "value" },
  "self-update.check": { "--force": "boolean" },
  "self-update.apply": { "--timeout": "value" },
  "self-update.rollback": { "--version": "value" },
  "skill.install": { "--path": "value" },
  "skill.activate": { "--version": "value", "--path": "value" },
};


function commandInputError(
  field: string | null,
  expected: JsonValue,
  actual: JsonValue,
): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Invalid command invocation", {
    field,
    expected,
    actual,
    safeNextStep: "Use a documented harness-mrtool command and provide only its supported arguments.",
  });
}


function invalid(
  field: string | null,
  expected: JsonValue,
  actual: JsonValue,
): never {
  throw commandInputError(field, expected, actual);
}


function route(arguments_: readonly string[]): { readonly kind: CommandKind; readonly offset: number } {
  const first = arguments_[0];
  if (first === undefined || first.startsWith("-")) {
    invalid("command", "a V1 command", "missing command");
  }
  const groups: Readonly<Record<string, ReadonlySet<string>>> = {
    schema: new Set(["show"]),
    profiles: new Set(["list", "detect"]),
    labels: new Set(["list"]),
    template: new Set(["show", "refresh", "export"]),
    "self-update": new Set(["check", "status", "apply", "rollback"]),
    skill: new Set(["install", "activate", "status"]),
  };
  const group = groups[first];
  if (group !== undefined) {
    const second = arguments_[1];
    if (second === undefined || !group.has(second)) {
      invalid("command", `a supported ${first} subcommand`, "invalid subcommand");
    }
    return { kind: `${first}.${second}` as CommandKind, offset: 2 };
  }
  const standalone = new Set<CommandKind>([
    "doctor", "context", "create", "update", "verify", "preview", "manual", "version",
  ]);
  if (!standalone.has(first as CommandKind)) {
    invalid("command", "a V1 command", "unknown command");
  }
  return { kind: first as CommandKind, offset: 1 };
}


function commonFlagsFor(kind: CommandKind): ReadonlySet<string> {
  if (kind === "create" || kind === "update" || kind === "preview" || kind === "manual") {
    return REQUEST_COMMON_FLAGS;
  }
  if (kind === "template.export") {
    return new Set([...BASE_COMMON_FLAGS, "--profile"]);
  }
  if (
    kind === "self-update.check" || kind === "self-update.status" ||
    kind === "self-update.apply" || kind === "self-update.rollback" ||
    kind === "skill.install" || kind === "skill.activate" ||
    kind === "skill.status" || kind === "version"
  ) {
    return LOCAL_COMMON_FLAGS;
  }
  return BASE_COMMON_FLAGS;
}


function parsePositiveInteger(raw: string, field: string): number {
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    invalid(field, "a positive integer without leading zeroes", "invalid integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    invalid(field, "a safe positive integer", "integer is out of range");
  }
  return value;
}


function scalar(raw: string | undefined, field: string): string {
  if (raw === undefined || raw === "" || raw !== raw.trim() || /[\r\n\u0000]/u.test(raw)) {
    invalid(field, "a non-empty single-line value without outer whitespace", "invalid value");
  }
  return raw;
}


function optionalIid(positionals: readonly string[], field: string): number | null {
  if (positionals.length > 1) invalid(field, "zero or one MR IID", "too many positional arguments");
  return positionals.length === 0 ? null : parsePositiveInteger(positionals[0]!, field);
}


function requireNoPositionals(positionals: readonly string[]): void {
  if (positionals.length !== 0) {
    invalid("arguments", "no positional arguments", "unexpected positional argument");
  }
}


function specificValue(values: ReadonlyMap<string, string | true>, flag: string): string | undefined {
  const value = values.get(flag);
  return typeof value === "string" ? value : undefined;
}


function commandFor(
  kind: CommandKind,
  positionals: readonly string[],
  specific: ReadonlyMap<string, string | true>,
  options: CliOptions,
): CliCommand {
  switch (kind) {
    case "doctor":
      requireNoPositionals(positionals);
      return Object.freeze({ kind });
    case "create": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      return Object.freeze({ kind, upsert: specific.has("--upsert") });
    }
    case "preview":
    case "profiles.list":
    case "profiles.detect":
    case "labels.list":
    case "template.show":
    case "template.refresh":
    case "self-update.status":
    case "skill.status":
    case "version":
      requireNoPositionals(positionals);
      return Object.freeze({ kind });
    case "manual":
      requireNoPositionals(positionals);
      return Object.freeze({ kind, sshMergeRequest: specific.has("--ssh-mr") });
    case "context": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const mrRaw = specificValue(specific, "--mr");
      const mrIid = mrRaw === undefined ? null : parsePositiveInteger(mrRaw, "--mr");
      const migrateTemplate = specific.has("--migrate-template");
      if (migrateTemplate && mrIid === null) {
        invalid("--migrate-template", "used together with --mr", "MR IID is missing");
      }
      return Object.freeze({ kind, mrIid, migrateTemplate });
    }
    case "update": { // eslint-disable-line no-case-declarations
      const iid = optionalIid(positionals, "iid");
      const migrateTemplate = specific.has("--migrate-template");
      const confirmationRaw = specificValue(specific, "--confirm-migration");
      const confirmation = confirmationRaw === undefined ? null : scalar(confirmationRaw, "--confirm-migration");
      if (confirmation !== null && !migrateTemplate) {
        invalid("--confirm-migration", "used only with --migrate-template", "migration is disabled");
      }
      if (confirmation !== null && !/^[a-f0-9]{64}:[a-f0-9]{64}$/u.test(confirmation)) {
        invalid("--confirm-migration", "<old-sha256>:<new-sha256>", "invalid confirmation hash pair");
      }
      if (migrateTemplate && options.nonInteractive && confirmation === null) {
        invalid("--confirm-migration", "required for non-interactive migration", "confirmation is missing");
      }
      return Object.freeze({
        kind,
        iid,
        migrateTemplate,
        confirmation,
        forceReplaceDescription: specific.has("--force-replace-description"),
      });
    }
    case "verify": { // eslint-disable-line no-case-declarations
      const iid = optionalIid(positionals, "iid");
      const raw = specificValue(specific, "--level");
      if (raw !== "structure" && raw !== "ready" && raw !== "merge") {
        invalid("--level", "structure, ready, or merge", "invalid or missing verification level");
      }
      return Object.freeze({ kind, iid, level: raw });
    }
    case "schema.show": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const raw = specificValue(specific, "--from-mr");
      return Object.freeze({
        kind,
        fromMrIid: raw === undefined ? null : parsePositiveInteger(raw, "--from-mr"),
      });
    }
    case "template.export": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const profile = options.profile;
      if (profile === null || profile.kind !== "explicit" || profile.ids.length !== 1 ||
          !["general", "code", "docs", "ops"].includes(profile.ids[0]!)) {
        invalid("--profile", "exactly one of general, code, docs, or ops", "invalid export profile");
      }
      const destination = scalar(specificValue(specific, "--destination"), "--destination");
      return Object.freeze({
        kind,
        profile: profile.ids[0] as ProjectTemplateProfile,
        destination,
      });
    }
    case "self-update.check":
      requireNoPositionals(positionals);
      return Object.freeze({ kind, force: specific.has("--force") });
    case "self-update.apply": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const raw = specificValue(specific, "--timeout");
      return Object.freeze({
        kind,
        timeoutSeconds: raw === undefined ? null : parsePositiveInteger(raw, "--timeout"),
      });
    }
    case "self-update.rollback": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const version = scalar(specificValue(specific, "--version"), "--version");
      if (!isExactCliSemver(version)) {
        invalid("--version", "an exact semantic version", "invalid semantic version");
      }
      return Object.freeze({ kind, version });
    }
    case "skill.install": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      return Object.freeze({ kind, path: scalar(specificValue(specific, "--path"), "--path") });
    }
    case "skill.activate": { // eslint-disable-line no-case-declarations
      requireNoPositionals(positionals);
      const version = scalar(specificValue(specific, "--version"), "--version");
      if (!isExactCliSemver(version)) {
        invalid("--version", "an exact semantic version", "invalid semantic version");
      }
      return Object.freeze({
        kind,
        version,
        path: scalar(specificValue(specific, "--path"), "--path"),
      });
    }
  }
}


export function parseCliInvocation(arguments_: readonly string[]): CliInvocation {
  if (!Array.isArray(arguments_) || arguments_.some((argument) => typeof argument !== "string")) {
    throw commandInputError("arguments", "an array of command-line strings", "invalid argument vector");
  }
  const selected = route(arguments_);
  const specificSpec = SPECIFIC_FLAGS[selected.kind] ?? {};
  const specific = new Map<string, string | true>();
  const commonArguments: string[] = [];
  const usedCommon = new Set<string>();
  const positionals: string[] = [];


  for (let index = selected.offset; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const flag = equalsIndex < 0 ? argument : argument.slice(0, equalsIndex);
    const inline = equalsIndex < 0 ? undefined : argument.slice(equalsIndex + 1);
    const commonArity = cliOptionArity(flag);
    if (commonArity !== null) {
      usedCommon.add(flag);
      commonArguments.push(argument);
      if (commonArity === "value" && inline === undefined) {
        const next = arguments_[index + 1];
        if (next !== undefined && !next.startsWith("--")) {
          commonArguments.push(next);
          index += 1;
        }
      }
      continue;
    }
    const arity = specificSpec[flag];
    if (arity === undefined) {
      invalid(flag, `a flag supported by ${selected.kind}`, "unsupported command flag");
    }
    if (specific.has(flag)) {
      invalid(flag, "provided at most once", "duplicate flag");
    }
    if (arity === "boolean") {
      if (inline !== undefined) invalid(flag, "a flag without a value", "unexpected flag value");
      specific.set(flag, true);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = arguments_[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        index += 1;
      }
    }
    specific.set(flag, scalar(value, flag));
  }


  const options = parseCliOptions(commonArguments);
  const allowedCommon = commonFlagsFor(selected.kind);
  if ([...usedCommon].some((flag) => !allowedCommon.has(flag))) {
    invalid("arguments", `only flags supported by ${selected.kind}`, "inapplicable common flag");
  }
  return Object.freeze({
    command: commandFor(selected.kind, positionals, specific, options),
    options,
  });
}
