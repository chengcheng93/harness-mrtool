import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import {
  loadInputTransport,
  type InputIo,
  type InputTransport,
} from "../input/load-input.ts";
import type { CliOptions } from "./options.ts";

type MutableObject = Record<string, JsonValue>;

function conflictError(field: string | null): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Structured input conflicts with a command-line flag", {
    field,
    expected: "the same canonical value in both input sources",
    actual: "conflicting input sources",
    safeNextStep: "Remove one source for the field or make both values identical.",
  });
}

function asObject(value: JsonValue | undefined): MutableObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as MutableObject
    : undefined;
}

function ensureObject(parent: MutableObject, key: string): MutableObject {
  const existing = parent[key];
  if (existing === undefined) {
    const created: MutableObject = {};
    parent[key] = created;
    return created;
  }
  const object = asObject(existing);
  if (object === undefined) {
    throw conflictError(`/${key}`);
  }
  return object;
}

function mergeScalar(
  object: MutableObject,
  key: string,
  flagValue: string | null,
  field: string,
): void {
  if (flagValue === null) {
    return;
  }
  const existing = object[key];
  if (existing === undefined) {
    object[key] = flagValue;
    return;
  }
  if (typeof existing !== "string" || existing.trim() !== flagValue) {
    throw conflictError(field);
  }
}

function mergeProfileIds(root: MutableObject, options: CliOptions): void {
  if (options.profile === null || options.profile.kind === "auto") {
    return;
  }
  const profileIds = options.profile.ids;
  const existing = root.profileIds;
  if (existing === undefined) {
    root.profileIds = [...profileIds];
    return;
  }
  if (!Array.isArray(existing)) {
    throw conflictError("/profileIds");
  }
  const canonical = existing.map((item) => typeof item === "string" ? item.trim() : null);
  if (
    canonical.length !== profileIds.length ||
    canonical.some((item, index) => item !== profileIds[index])
  ) {
    throw conflictError("/profileIds");
  }
}

function mergeCliPrefills(value: JsonValue, options: CliOptions): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    if (
      options.profile !== null || options.type !== null || options.module !== null ||
      options.titleSummary !== null
    ) {
      throw conflictError(null);
    }
    return value;
  }
  const root = copyJsonValue(value) as MutableObject;
  mergeProfileIds(root, options);
  if (options.type !== null || options.module !== null || options.titleSummary !== null) {
    const title = ensureObject(root, "title");
    mergeScalar(title, "type", options.type, "/title/type");
    mergeScalar(title, "module", options.module, "/title/module");
    mergeScalar(title, "titleSummary", options.titleSummary, "/title/titleSummary");
  }
  return root as JsonObject;
}

export function resolveCliInputTransport(options: CliOptions): InputTransport | null {
  if (options.input === null) {
    return null;
  }
  if (options.input === "-") {
    if (options.inputFormat === null) {
      throw new ToolError("INPUT_ERROR", "Stdin input requires an explicit format", {
        field: "--input-format",
        expected: "json or yaml",
        actual: "missing stdin format",
        safeNextStep: "Pass --input-format json or --input-format yaml with --input -.",
      });
    }
    return { kind: "stdin", format: options.inputFormat };
  }
  return options.inputFormat === null
    ? { kind: "file", path: options.input }
    : { kind: "file", path: options.input, format: options.inputFormat };
}

export async function loadCliInput(
  options: CliOptions,
  io?: InputIo,
): Promise<JsonValue | null> {
  const transport = resolveCliInputTransport(options);
  if (transport === null) {
    return null;
  }
  const value = io === undefined
    ? await loadInputTransport(transport)
    : await loadInputTransport(transport, io);
  return mergeCliPrefills(value, options);
}
