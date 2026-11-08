import { ToolError } from "../contracts/errors.ts";
import { sha256CanonicalJson, copyJsonValue } from "../contracts/jcs.ts";
import type { CanonicalLabelChangeSet } from "../git/change-set.ts";
import { typeLabelFromDiff, type DiffTypeLabel } from "./diff-labels.ts";
import { DEFAULT_LABEL_POOL } from "./label-defaults.ts";

export interface LabelSelectionOptions {
  readonly priority?: "p0" | "p1" | "p2";
  readonly priorityReason?: string;
}
export interface LabelDiffBinding {
  readonly sourceHeadSha: string;
  readonly targetRefSha: string;
  readonly mergeBaseSha: string;
}
export interface MandatoryLabelInput {
  readonly diff: CanonicalLabelChangeSet;
  readonly binding: LabelDiffBinding;
  readonly inventory: readonly { readonly id: string; readonly name: string }[];
  readonly options?: LabelSelectionOptions;
}
export interface MandatoryLabelSelection {
  readonly names: readonly string[];
  readonly ids: readonly string[];
  readonly titleType: string;
  readonly source: "diff" | "fallback";
  readonly diffDigest: string;
}
const TITLE_TYPES: Readonly<Record<DiffTypeLabel, string>> = Object.freeze({
  feature: "feat", bug: "fix", doc: "docs", test: "test", refactor: "refactor",
  performance: "perf", build: "build", ci: "ci", chore: "chore",
});
const POOL = new Set<string>(DEFAULT_LABEL_POOL);
/** Every merge request carries the review lifecycle status; there is no Draft stage. */
export const MANDATORY_STATUS_LABEL = "status::review";

function labelError(reason: string, digest?: string): ToolError<"LABEL_ERROR"> {
  return new ToolError("LABEL_ERROR", `Mandatory MR labels: ${reason}`, {
    field: "labels", expected: "one fixed-pool type, priority and lifecycle status derived from the current committed diff",
    actual: digest === undefined ? reason : { reason, diffDigest: digest },
    safeNextStep: "Refresh repository/context and retry with the current committed diff and existing fixed-pool labels.",
  });
}

export function labelDiffDigest(diff: CanonicalLabelChangeSet): string {
  return sha256CanonicalJson(copyJsonValue(diff));
}

export function assertMandatoryLabelNames(names: readonly string[]): void {
  if (!Array.isArray(names) || names.length !== 3 ||
      names.some((name) => !POOL.has(name)) ||
      ["type::", "priority::", "status::"].some((prefix) => names.filter((name) => name.startsWith(prefix)).length !== 1) ||
      !names.includes(MANDATORY_STATUS_LABEL)) {
    throw labelError("fixed pool, cardinality or lifecycle mismatch");
  }
}

export function selectMandatoryLabels(input: MandatoryLabelInput): MandatoryLabelSelection {
  // Clone plain JSON before inspection so accessors/prototypes do not become trusted evidence.
  let safe: MandatoryLabelInput;
  try { safe = copyJsonValue(input) as unknown as MandatoryLabelInput; }
  catch { throw labelError("invalid label selection input"); }
  const { diff, binding, inventory, options = {} } = safe;
  if (diff === undefined || diff === null || binding === undefined || binding === null ||
      !Array.isArray(diff.items) || diff.items.length === 0 || !Array.isArray(inventory) ||
      options === null || typeof options !== "object" || Array.isArray(options) ||
      ["sourceHeadSha", "targetRefSha", "mergeBaseSha"].some((key) => {
        const field = key as keyof LabelDiffBinding;
        return typeof diff[field] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(diff[field]) || diff[field] !== binding[field];
      })) throw labelError("missing, empty or stale canonical diff");
  if (Object.keys(options).some((key) => !["priority", "priorityReason"].includes(key))) {
    throw labelError("unknown label selection option");
  }
  if (diff.items.some((item) => {
    if (item === null || typeof item !== "object" || !["added", "modified", "deleted", "renamed"].includes(item.status) ||
        typeof item.binary !== "boolean" || typeof item.submodule !== "boolean" ||
        (item.unsupported !== undefined && typeof item.unsupported !== "boolean") ||
        (item.before !== undefined && typeof item.before !== "string") ||
        (item.after !== undefined && typeof item.after !== "string")) return true;
    const paths = item.status === "renamed" ? [item.oldPath, item.newPath]
      : item.status === "deleted" ? [item.oldPath] : [item.newPath];
    return paths.some((path) => typeof path !== "string" || path === "" || /[\r\n\u0000]/u.test(path));
  })) throw labelError("invalid canonical diff item");
  const digest = labelDiffDigest(diff);
  const detected = typeLabelFromDiff(diff.items);
  const typeName = detected ?? "type::chore";
  const priority = options.priority ?? "p2";
  if (!["p0", "p1", "p2"].includes(priority) || (priority !== "p2" &&
      (typeof options.priorityReason !== "string" || options.priorityReason.trim().length === 0))) {
    throw labelError("priority elevation requires an explicit choice and reason");
  }
  const names = Object.freeze([typeName, `priority::${priority}`, MANDATORY_STATUS_LABEL]);
  assertMandatoryLabelNames(names);
  if (inventory.some((label) => label === null || typeof label !== "object" ||
      typeof label.id !== "string" || label.id.trim() === "" || typeof label.name !== "string") ||
      new Set(inventory.map((label) => label.id)).size !== inventory.length) throw labelError("invalid label inventory identity");
  const ids = Object.freeze(names.map((name) => {
    const matches = inventory.filter((label) => label.name === name);
    if (matches.length !== 1) throw labelError("required label missing or ambiguous in the live inventory");
    return matches[0]!.id;
  }));
  const selectedType = typeName.slice("type::".length) as DiffTypeLabel;
  return Object.freeze({ names, ids, titleType: TITLE_TYPES[selectedType], source: detected === null ? "fallback" : "diff", diffDigest: digest });
}
