import { ToolError } from "../contracts/errors.ts";
import { sha256CanonicalJson, copyJsonValue } from "../contracts/jcs.ts";
import type { RequestIntent } from "../contracts/request.ts";
import type { CanonicalLabelChangeSet } from "../git/change-set.ts";
import { typeLabelFromDiff, type DiffTypeLabel } from "./diff-labels.ts";
import { DEFAULT_LABEL_POOL } from "./label-defaults.ts";

export interface LabelSelectionOptions {
  readonly priority?: "p0" | "p1" | "p2";
  readonly priorityReason?: string;
  readonly confirmedType?: DiffTypeLabel;
  readonly confirmationDigest?: string;
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
  readonly intent: RequestIntent;
  readonly options?: LabelSelectionOptions;
}
export interface MandatoryLabelSelection {
  readonly names: readonly string[];
  readonly ids: readonly string[];
  readonly titleType: string;
  readonly source: "diff" | "confirmed";
  readonly diffDigest: string;
}
const TITLE_TYPES: Readonly<Record<DiffTypeLabel, string>> = Object.freeze({
  feature: "feat", bug: "fix", doc: "docs", test: "test", refactor: "refactor",
  performance: "perf", build: "build", ci: "ci", chore: "chore",
});
const POOL = new Set<string>(DEFAULT_LABEL_POOL);

function labelError(reason: string, digest?: string): ToolError<"LABEL_ERROR"> {
  return new ToolError("LABEL_ERROR", `Mandatory MR labels: ${reason}`, {
    field: "labels", expected: "one fixed-pool type, priority and lifecycle status derived from the current committed diff",
    actual: digest === undefined ? reason : { reason, diffDigest: digest },
    safeNextStep: digest === undefined ? "Refresh repository/context and retry with existing fixed-pool labels."
      : "Review the committed diff and explicitly confirm a type with this diff digest; do not use a title or a fallback label as confirmation.",
  });
}

export function labelDiffDigest(diff: CanonicalLabelChangeSet): string {
  return sha256CanonicalJson(copyJsonValue(diff));
}

export function assertMandatoryLabelNames(names: readonly string[], intent: RequestIntent): void {
  if (!["draft", "ready"].includes(intent) || !Array.isArray(names) || names.length !== 3 ||
      names.some((name) => !POOL.has(name)) ||
      ["type::", "priority::", "status::"].some((prefix) => names.filter((name) => name.startsWith(prefix)).length !== 1) ||
      !names.includes(intent === "draft" ? "status::doing" : "status::review")) {
    throw labelError("fixed pool, cardinality or lifecycle mismatch");
  }
}

export function selectMandatoryLabels(input: MandatoryLabelInput): MandatoryLabelSelection {
  // Clone plain JSON before inspection so accessors/prototypes do not become trusted evidence.
  let safe: MandatoryLabelInput;
  try { safe = copyJsonValue(input) as unknown as MandatoryLabelInput; }
  catch { throw labelError("invalid label selection input"); }
  const { diff, binding, inventory, intent, options = {} } = safe;
  if (diff === undefined || diff === null || binding === undefined || binding === null ||
      !Array.isArray(diff.items) || diff.items.length === 0 || !Array.isArray(inventory) ||
      !["draft", "ready"].includes(intent) || options === null || typeof options !== "object" || Array.isArray(options) ||
      ["sourceHeadSha", "targetRefSha", "mergeBaseSha"].some((key) => {
        const field = key as keyof LabelDiffBinding;
        return typeof diff[field] !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(diff[field]) || diff[field] !== binding[field];
      })) throw labelError("missing, empty or stale canonical diff");
  if (Object.keys(options).some((key) => !["priority", "priorityReason", "confirmedType", "confirmationDigest"].includes(key))) {
    throw labelError("unknown label selection option");
  }
  const digest = labelDiffDigest(diff);
  const detected = typeLabelFromDiff(diff.items);
  const confirmed = options.confirmedType;
  if (confirmed !== undefined && (!Object.hasOwn(TITLE_TYPES, confirmed) || options.confirmationDigest !== digest)) {
    throw labelError("invalid or stale type confirmation", digest);
  }
  if ((options.confirmationDigest !== undefined && confirmed === undefined) ||
      (confirmed !== undefined && detected !== null && detected !== `type::${confirmed}`)) {
    throw labelError("type confirmation conflicts with diff classification", digest);
  }
  if (detected === null && confirmed === undefined) throw labelError("diff type requires confirmation", digest);
  const typeName = detected ?? `type::${confirmed!}`;
  const priority = options.priority ?? "p2";
  if (!["p0", "p1", "p2"].includes(priority) || (priority !== "p2" &&
      (typeof options.priorityReason !== "string" || options.priorityReason.trim().length === 0))) {
    throw labelError("priority elevation requires an explicit choice and reason");
  }
  const names = Object.freeze([typeName, `priority::${priority}`, intent === "draft" ? "status::doing" : "status::review"]);
  assertMandatoryLabelNames(names, intent);
  if (inventory.some((label) => label === null || typeof label !== "object" ||
      typeof label.id !== "string" || label.id.trim() === "" || typeof label.name !== "string") ||
      new Set(inventory.map((label) => label.id)).size !== inventory.length) throw labelError("invalid label inventory identity");
  const ids = Object.freeze(names.map((name) => {
    const matches = inventory.filter((label) => label.name === name);
    if (matches.length !== 1) throw labelError("required label missing or ambiguous in the live inventory");
    return matches[0]!.id;
  }));
  const selectedType = typeName.slice("type::".length) as DiffTypeLabel;
  return Object.freeze({ names, ids, titleType: TITLE_TYPES[selectedType], source: detected === null ? "confirmed" : "diff", diffDigest: digest });
}
