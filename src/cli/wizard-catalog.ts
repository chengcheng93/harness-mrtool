import type { DiscoveredContext } from "../app/get-context.ts";
import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { ToolError } from "../contracts/errors.ts";
import type { JsonObject, JsonValue } from "../contracts/jcs.ts";
import type { WizardCatalog } from "./wizard.ts";

export interface BuildWizardCatalogInput {
  readonly bundle: LoadedTemplateBundle;
  readonly discovered: DiscoveredContext;
  readonly suggestedProfileIds: readonly string[];
  readonly confirmations: WizardCatalog["confirmations"];
}

const PROFILE_LABELS = Object.freeze({
  code: "Code",
  docs: "Documentation",
  general: "General",
  ops: "Operations",
});

function catalogError(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Interactive request catalog is unavailable", {
    field: "wizard",
    expected: "one verified Bundle registry and one current enumerated candidate context",
    actual: "interactive catalog composition failed",
    safeNextStep: "Refresh context and retry the wizard; no remote write was attempted.",
  });
}

function record(value: JsonValue | undefined): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw catalogError();
  }
  return value;
}

function list(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) throw catalogError();
  return value;
}

function text(value: JsonValue | undefined): string {
  if (typeof value !== "string") throw catalogError();
  return value;
}

function bool(value: JsonValue | undefined): boolean {
  if (typeof value !== "boolean") throw catalogError();
  return value;
}

function integer(value: JsonValue | undefined): number {
  if (!Number.isSafeInteger(value)) throw catalogError();
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function buildWizardCatalog(input: BuildWizardCatalogInput): WizardCatalog {
  try {
    validateTemplateBundle(input.bundle);
    const fieldsRegistry = input.bundle.registries.fields;
    const checkboxRegistry = input.bundle.registries.checkboxes;
    const titleTypes = list(fieldsRegistry.titleTypes).map(text);
    const fields = list(fieldsRegistry.fields).map(record);
    const checkboxes = list(checkboxRegistry.checkboxes).map(record);
    const labelsPolicy = record(input.bundle.policy.labels);
    const categories = record(labelsPolicy.categories);
    const lifecycle = record(labelsPolicy.lifecycle);
    const statusCategory = text(lifecycle.statusCategory);

    const entries = (sectionSlot: string, kind: string) => checkboxes
      .filter((entry) => entry.sectionSlot === sectionSlot && entry.kind === kind)
      .map((entry) => ({ id: text(entry.id), label: text(entry.label) }));

    const catalog: WizardCatalog = {
      contextId: input.discovered.contextId,
      issueIid: input.discovered.snapshot.issue.kind === "linked"
        ? input.discovered.snapshot.issue.iid
        : null,
      targetBranch: input.discovered.binding.targetBranch,
      profiles: Object.entries(PROFILE_LABELS).map(([id, label]) => ({ id, label })),
      suggestedProfileIds: [...input.suggestedProfileIds],
      titleTypes,
      impactAreas: entries("impact.area", "categorical"),
      verificationItems: entries("verification", "evidence-state"),
      documentationItems: entries("documentation", "categorical"),
      profileFields: fields.map((field) => ({
        id: text(field.id),
        profileId: text(field.profile),
        label: text(field.h3),
      })),
      labelCategories: Object.entries(categories)
        .filter(([id]) => id !== statusCategory)
        .map(([id, value]) => {
          const category = record(value);
          return { id, required: bool(category.required), max: integer(category.max) };
        }),
      labelCandidates: input.discovered.labelCandidates.map((candidate) => ({
        token: candidate.token,
        category: candidate.category,
        name: candidate.name,
        description: candidate.description,
        scopeKind: candidate.scopeKind,
        scopePath: candidate.scopePath,
        currentlyApplied: candidate.currentlyApplied,
      })),
      userCandidates: input.discovered.userCandidates.map((candidate) => ({ ...candidate })),
      confirmations: input.confirmations === null ? null : { ...input.confirmations },
    };
    return deepFreeze(catalog);
  } catch (error) {
    if (error instanceof ToolError && error.message === "Interactive request catalog is unavailable") {
      throw error;
    }
    throw catalogError();
  }
}
