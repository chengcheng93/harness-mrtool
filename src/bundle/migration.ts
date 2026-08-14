import { ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  copyJsonValue,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";

/** The only description sections that a migration is allowed to rewrite. */
export const MANAGED_MIGRATION_FIELDS = Object.freeze([
  "changes",
  "motivation",
  "workItem",
  "impact",
  "verification",
  "documentation",
  "risk",
  "review",
] as const);

export type ManagedMigrationField = (typeof MANAGED_MIGRATION_FIELDS)[number];

const SECTION_HEADINGS: Readonly<Record<ManagedMigrationField, string>> = Object.freeze({
  changes: "## 1. Changes",
  motivation: "## 2. Motivation",
  workItem: "## 3. Related Issue / Work Item",
  impact: "## 4. Impact Scope",
  verification: "## 5. Verification",
  documentation: "## 6. Documentation",
  risk: "## 7. Risks and Rollback",
  review: "## 8. Review / CI Checklist",
});

const HEADING_TO_FIELD = new Map<string, ManagedMigrationField>(
  MANAGED_MIGRATION_FIELDS.map((field) => [SECTION_HEADINGS[field], field]),
);

export interface MigrationFieldReport {
  readonly field: string;
  readonly status: "mapped" | "preserved" | "unchanged" | "conflict" | "missing" | "unmapped";
  readonly reason: string;
}

export interface MigrationConflict {
  readonly field: string;
  readonly reason: "manual-edit-conflict" | "malformed-section" | "schema-conflict";
}

export interface ThreeWayMergeInput {
  readonly base: JsonObject;
  readonly current: JsonObject;
  readonly proposed: JsonObject;
  readonly fields?: readonly string[];
}

export interface ThreeWayMergeResult {
  readonly value: JsonObject;
  readonly reports: readonly MigrationFieldReport[];
  readonly conflicts: readonly MigrationConflict[];
  readonly manualFields: readonly string[];
}

export interface MigrationDescriptionInput {
  readonly base: string;
  readonly current: string;
  readonly proposed: string;
}

export interface DescriptionMergeResult {
  /** The merged body, without a diagnostic marker. */
  readonly description: string;
  readonly reports: readonly MigrationFieldReport[];
  readonly conflicts: readonly MigrationConflict[];
  readonly manualFields: readonly string[];
  readonly diff: readonly MarkdownDiffEntry[];
}

export interface MarkdownDiffEntry {
  readonly field: string;
  readonly before: string;
  readonly after: string;
  readonly kind: "unchanged" | "added" | "removed" | "changed";
}

export interface BuildMigrationPlanInput {
  readonly oldSchema: unknown;
  readonly newSchema: unknown;
  readonly oldValues?: JsonObject;
  readonly newValues?: JsonObject;
  readonly currentValues?: JsonObject;
  readonly proposedValues?: JsonObject;
  readonly description?: MigrationDescriptionInput;
}

export interface MigrationPlan {
  readonly oldSchema: JsonValue;
  readonly newSchema: JsonValue;
  readonly mappedFields: readonly string[];
  readonly unmappedFields: readonly string[];
  readonly missingFields: readonly string[];
  readonly reports: readonly MigrationFieldReport[];
  readonly conflicts: readonly MigrationConflict[];
  readonly manualFields: readonly string[];
  readonly description: DescriptionMergeResult | null;
  readonly diff: readonly MarkdownDiffEntry[];
  readonly blocked: boolean;
}

function migrationError(reason: string): ToolError<"TEMPLATE_ERROR"> {
  return new ToolError("TEMPLATE_ERROR", `Template migration contract is invalid: ${reason}`, {
    field: "migration",
    expected: "the canonical eight-section Template Bundle migration contract",
    actual: "invalid migration input",
    safeNextStep: "Refresh both verified Bundles and resolve the reported migration fields before retrying.",
  });
}

function object(value: unknown, subject: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw migrationError(`${subject} must be an object`);
  }
  return value as JsonObject;
}

function normalizeLf(value: string): string {
  return value.replace(/\r\n?/gu, "\n");
}

function withoutMarker(value: string): string {
  const normalized = normalizeLf(value);
  return normalized.replace(/<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n$/u, "");
}

function equalJson(left: unknown, right: unknown): boolean {
  try {
    return canonicalizeJson(left as JsonValue) === canonicalizeJson(right as JsonValue);
  } catch {
    return Object.is(left, right);
  }
}

function cloned(value: unknown): JsonValue {
  try {
    return copyJsonValue(value as JsonValue);
  } catch {
    throw migrationError("migration values must be strict JSON");
  }
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

function fieldValue(objectValue: JsonObject, field: string): JsonValue | undefined {
  return Object.hasOwn(objectValue, field) ? objectValue[field] : undefined;
}

/**
 * Merge only explicitly managed top-level fields. Unknown keys are retained from
 * the current value and surfaced as manual fields; they are never guessed.
 */
export function mergeManagedFields(input: ThreeWayMergeInput): ThreeWayMergeResult {
  const base = object(cloned(input.base), "base values");
  const current = object(cloned(input.current), "current values");
  const proposed = object(cloned(input.proposed), "proposed values");
  const fields = [...(input.fields ?? MANAGED_MIGRATION_FIELDS)];
  const managed = new Set(fields);
  const value = { ...current } as Record<string, JsonValue>;
  const reports: MigrationFieldReport[] = [];
  const conflicts: MigrationConflict[] = [];
  const manualFields: string[] = [];

  for (const field of fields) {
    const baseValue = fieldValue(base, field);
    const currentValue = fieldValue(current, field);
    const proposedValue = fieldValue(proposed, field);
    const currentChanged = !equalJson(currentValue, baseValue);
    const proposedChanged = !equalJson(proposedValue, baseValue);

    if (!Object.hasOwn(proposed, field) && Object.hasOwn(current, field)) {
      reports.push({ field, status: "preserved", reason: "the proposed Bundle has no value" });
      continue;
    }
    if (!currentChanged) {
      if (Object.hasOwn(proposed, field)) value[field] = cloned(proposedValue);
      reports.push({
        field,
        status: proposedChanged ? "mapped" : "unchanged",
        reason: proposedChanged ? "current value matched the old Bundle base" : "both sides match the base",
      });
      continue;
    }
    if (!proposedChanged || equalJson(currentValue, proposedValue)) {
      if (Object.hasOwn(current, field)) value[field] = cloned(currentValue);
      reports.push({
        field,
        status: proposedChanged ? "unchanged" : "preserved",
        reason: proposedChanged ? "manual and proposed values agree" : "the proposed value matches the base",
      });
      continue;
    }
    // Both sides changed differently. Keep the user's current value and report it.
    if (Object.hasOwn(current, field)) value[field] = cloned(currentValue);
    conflicts.push({ field, reason: "schema-conflict" });
    reports.push({ field, status: "conflict", reason: "current and proposed values diverged from the base" });
  }

  for (const field of new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(proposed)])) {
    if (managed.has(field)) continue;
    if (Object.hasOwn(current, field) && !equalJson(current[field], base[field])) {
      manualFields.push(field);
      reports.push({ field, status: "preserved", reason: "unknown field is manual-owned" });
    }
  }
  return freezeDeep({
    value,
    reports,
    conflicts,
    manualFields: [...new Set(manualFields)].sort(),
  });
}

interface ParsedSection {
  readonly field: ManagedMigrationField;
  readonly heading: string;
  readonly body: string;
}

function parseSections(description: string): readonly ParsedSection[] {
  if (typeof description !== "string" || description.includes("\r")) {
    throw migrationError("description must use LF line endings");
  }
  const body = withoutMarker(description).replace(/\n*$/u, "\n");
  const lines = body.split("\n");
  const headings: { readonly field: ManagedMigrationField; readonly index: number; readonly heading: string }[] = [];
  lines.forEach((line, index) => {
    const field = HEADING_TO_FIELD.get(line);
    if (field !== undefined) headings.push({ field, index, heading: line });
  });
  if (headings.length !== MANAGED_MIGRATION_FIELDS.length ||
      headings.some((entry, index) => entry.field !== MANAGED_MIGRATION_FIELDS[index])) {
    throw migrationError("description must contain the canonical eight managed sections in order");
  }
  const seen = new Set<string>();
  return headings.map((entry, index) => {
    if (seen.has(entry.field)) throw migrationError("description contains duplicate managed sections");
    seen.add(entry.field);
    const end = headings[index + 1]?.index ?? lines.length;
    const sectionBody = lines.slice(entry.index + 1, end).join("\n").replace(/\n+$/u, "");
    return { field: entry.field, heading: entry.heading, body: sectionBody };
  });
}

function sectionMap(value: string): Map<ManagedMigrationField, ParsedSection> {
  return new Map(parseSections(value).map((section) => [section.field, section]));
}

function diffKind(before: string, after: string): MarkdownDiffEntry["kind"] {
  if (before === after) return "unchanged";
  if (before === "") return "added";
  if (after === "") return "removed";
  return "changed";
}

/** Merge canonical Markdown sections while preserving manual prose and conflicts. */
export function mergeManagedDescriptions(input: MigrationDescriptionInput): DescriptionMergeResult {
  const base = sectionMap(input.base);
  const current = sectionMap(input.current);
  const proposed = sectionMap(input.proposed);
  const reports: MigrationFieldReport[] = [];
  const conflicts: MigrationConflict[] = [];
  const manualFields: string[] = [];
  const sections: string[] = [];
  const diff: MarkdownDiffEntry[] = [];

  for (const field of MANAGED_MIGRATION_FIELDS) {
    const baseSection = base.get(field);
    const currentSection = current.get(field);
    const proposedSection = proposed.get(field);
    if (baseSection === undefined || currentSection === undefined || proposedSection === undefined) {
      throw migrationError(`managed section ${field} is missing`);
    }
    const before = currentSection.body;
    const baseBody = baseSection.body;
    const proposedBody = proposedSection.body;
    const currentChanged = before !== baseBody;
    const proposedChanged = proposedBody !== baseBody;
    let selected = proposedBody;
    let status: MigrationFieldReport["status"] = proposedChanged ? "mapped" : "unchanged";
    let reason = "current body matched the base";
    if (currentChanged && !proposedChanged) {
      selected = before;
      status = "preserved";
      reason = "manual prose was preserved because the new Bundle did not change this field";
      manualFields.push(field);
    } else if (currentChanged && proposedChanged && before !== proposedBody) {
      selected = before;
      status = "conflict";
      reason = "manual prose and the new Bundle changed this field differently";
      conflicts.push({ field, reason: "manual-edit-conflict" });
      manualFields.push(field);
    } else if (currentChanged && proposedChanged) {
      status = "unchanged";
      reason = "manual prose and the new Bundle agree";
    }
    reports.push({ field, status, reason });
    diff.push({ field, before, after: selected, kind: diffKind(before, selected) });
    sections.push(`${SECTION_HEADINGS[field]}\n${selected}`.replace(/\n*$/u, ""));
  }
  return freezeDeep({
    description: `${sections.join("\n\n")}\n`,
    reports,
    conflicts,
    manualFields: [...new Set(manualFields)],
    diff,
  });
}

function schemaRequired(value: unknown): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const objectValue = value as Record<string, unknown>;
  const direct = objectValue.required;
  const required = Array.isArray(direct)
    ? direct.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : [];
  const custom = objectValue.requiredFields;
  if (Array.isArray(custom)) {
    required.push(...custom.filter((entry): entry is string => typeof entry === "string" && entry.length > 0));
  }
  return [...new Set(required)].sort();
}

function schemaProperties(value: unknown): ReadonlySet<string> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Set();
  const properties = (value as Record<string, unknown>).properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return new Set();
  return new Set(Object.keys(properties));
}

/** Build a loss-aware migration plan without guessing any missing required value. */
export function buildMigrationPlan(input: BuildMigrationPlanInput): MigrationPlan {
  const oldSchema = cloned(input.oldSchema);
  const newSchema = cloned(input.newSchema);
  const oldValues = object(cloned(input.oldValues ?? {}), "old values");
  const proposedValues = object(cloned(input.proposedValues ?? input.newValues ?? {}), "new values");
  const currentValues = object(cloned(input.currentValues ?? input.oldValues ?? {}), "current values");
  const oldProperties = schemaProperties(oldSchema);
  const newProperties = schemaProperties(newSchema);
  const oldKeys = oldProperties.size > 0 ? [...oldProperties] : Object.keys(oldValues);
  const newKeys = newProperties.size > 0 ? [...newProperties] : Object.keys(proposedValues);
  const mappedFields = oldKeys.filter((field) => newKeys.includes(field) &&
    Object.hasOwn(oldValues, field) && Object.hasOwn(proposedValues, field)).sort();
  const unmappedFields = oldKeys.filter((field) => !newKeys.includes(field)).sort();
  const required = schemaRequired(newSchema);
  const missingFields = required.filter((field) => !Object.hasOwn(proposedValues, field) ||
    proposedValues[field] === null || proposedValues[field] === "");

  let mergedValues: ThreeWayMergeResult = {
    value: currentValues,
    reports: [],
    conflicts: [],
    manualFields: [],
  };
  if (input.oldValues !== undefined || input.currentValues !== undefined || input.proposedValues !== undefined || input.newValues !== undefined) {
    mergedValues = mergeManagedFields({
      base: oldValues,
      current: currentValues,
      proposed: proposedValues,
      fields: MANAGED_MIGRATION_FIELDS,
    });
  }
  let description: DescriptionMergeResult | null = null;
  const conflicts = [...mergedValues.conflicts];
  const reports = [...mergedValues.reports];
  const manualFields = [...mergedValues.manualFields];
  const diffs: MarkdownDiffEntry[] = [];
  if (input.description !== undefined) {
    try {
      description = mergeManagedDescriptions(input.description);
      conflicts.push(...description.conflicts);
      reports.push(...description.reports);
      manualFields.push(...description.manualFields);
      diffs.push(...description.diff);
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw migrationError("description merge failed");
    }
  }
  return freezeDeep({
    oldSchema,
    newSchema,
    mappedFields,
    unmappedFields,
    missingFields,
    reports,
    conflicts,
    manualFields: [...new Set(manualFields)].sort(),
    description,
    diff: diffs,
    blocked: missingFields.length > 0 || conflicts.length > 0,
  });
}

export const threeWayMergeManagedFields = mergeManagedFields;
export const threeWayMergeDescriptions = mergeManagedDescriptions;
