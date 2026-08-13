import { isToolError, ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import type { LoadedTemplateBundle } from "./load.ts";

export const COMPOSABLE_PROFILE_ORDER = ["code", "docs", "ops"] as const;
export type ComposableProfileId = (typeof COMPOSABLE_PROFILE_ORDER)[number];
export type ProfileId = ComposableProfileId | "general";
export type ImpactNatureForProfileComposition =
  | "functional"
  | "non-functional"
  | "docs-only";

export interface ComposedProfile {
  readonly profileIds: readonly ProfileId[];
  readonly requiredBaseFields: readonly string[];
  readonly requiredFieldIds: readonly string[];
  readonly requiredCheckboxIds: readonly string[];
  readonly constraints: readonly string[];
  readonly suggestedTitleTypes: readonly string[];
}

export interface ComposeProfileOptions {
  readonly impactNature?: ImpactNatureForProfileComposition;
}

const ALL_PROFILE_IDS = new Set<string>([...COMPOSABLE_PROFILE_ORDER, "general"]);

function policyError(reason: string): ToolError<"POLICY_ERROR"> {
  return new ToolError("POLICY_ERROR", `Invalid Profile selection: ${reason}`, {
    field: "profileIds",
    expected: "general or a non-empty subset of code, docs, and ops",
    actual: reason,
    safeNextStep: "Select one supported Profile or a supported code+docs+ops combination.",
  });
}

function asRecord(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw policyError(`${subject} is not an object`);
  }
  return value;
}

function asStringArray(value: JsonValue | undefined, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw policyError(`${subject} is not a string array`);
  }
  return value as string[];
}

function registryOrder(
  entries: JsonValue | undefined,
  subject: string,
): ReadonlyMap<string, number> {
  if (!Array.isArray(entries)) {
    throw policyError(`${subject} registry is missing`);
  }
  const order = new Map<string, number>();
  const usedOrders = new Set<number>();
  for (const entryValue of entries) {
    const entry = asRecord(entryValue, subject);
    if (
      typeof entry.id !== "string" ||
      !Number.isSafeInteger(entry.order) ||
      (entry.order as number) < 1 ||
      order.has(entry.id) ||
      usedOrders.has(entry.order as number)
    ) {
      throw policyError(`${subject} registry IDs and orders must be unique`);
    }
    order.set(entry.id, entry.order as number);
    usedOrders.add(entry.order as number);
  }
  return order;
}

function orderedUnion(
  values: readonly string[],
  knownOrder: ReadonlyMap<string, number>,
  subject: string,
): readonly string[] {
  const unique = [...new Set(values)];
  for (const value of unique) {
    if (!knownOrder.has(value)) {
      throw policyError(`Profile references unknown ${subject} ID`);
    }
  }
  return unique.sort(
    (left, right) =>
      (knownOrder.get(left) as number) - (knownOrder.get(right) as number),
  );
}

function stableUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function freezeComposition(value: ComposedProfile): ComposedProfile {
  for (const child of Object.values(value)) {
    Object.freeze(child);
  }
  return Object.freeze(value);
}

function compose(
  bundle: JsonObject,
  requestedIds: readonly string[],
  options: ComposeProfileOptions,
): ComposedProfile {
  if (requestedIds.length === 0) {
    throw policyError("at least one Profile is required");
  }
  if (new Set(requestedIds).size !== requestedIds.length) {
    throw policyError("duplicate Profile IDs are not permitted");
  }
  for (const id of requestedIds) {
    if (!ALL_PROFILE_IDS.has(id)) {
      throw policyError("unknown Profile ID");
    }
  }
  if (requestedIds.includes("general") && requestedIds.length !== 1) {
    throw policyError("general cannot be combined with another Profile");
  }

  const profileIds = requestedIds.includes("general")
    ? (["general"] as const)
    : COMPOSABLE_PROFILE_ORDER.filter((id) => requestedIds.includes(id));
  if (options.impactNature === "docs-only" &&
      !(profileIds.length === 1 && profileIds[0] === "docs")) {
    throw policyError("Documentation Only impact requires the standalone docs Profile");
  }

  const profiles = asRecord(bundle.profiles, "profiles");
  const registries = asRecord(bundle.registries, "registries");
  const fields = asRecord(registries.fields, "field registry");
  const checkboxes = asRecord(registries.checkboxes, "checkbox registry");
  const fieldOrder = registryOrder(fields.fields, "field");
  const checkboxOrder = registryOrder(checkboxes.checkboxes, "checkbox");
  const titleTypes = asStringArray(fields.titleTypes, "title type registry");
  const titleOrder = new Map(titleTypes.map((id, index) => [id, index]));

  const requiredBaseFields: string[] = [];
  const requiredFieldIds: string[] = [];
  const requiredCheckboxIds: string[] = [];
  const constraints: string[] = [];
  const suggestedTitleTypes: string[] = [];
  for (const id of profileIds) {
    const profile = asRecord(profiles[id], `Profile ${id}`);
    if (profile.id !== id) {
      throw policyError(`Profile ${id} has a mismatched ID`);
    }
    requiredBaseFields.push(...asStringArray(profile.requiredBaseFields, `${id}.requiredBaseFields`));
    requiredFieldIds.push(...asStringArray(profile.requiredFieldIds, `${id}.requiredFieldIds`));
    requiredCheckboxIds.push(...asStringArray(profile.requiredCheckboxIds, `${id}.requiredCheckboxIds`));
    constraints.push(...asStringArray(profile.constraints, `${id}.constraints`));
    suggestedTitleTypes.push(...asStringArray(profile.suggestedTitleTypes, `${id}.suggestedTitleTypes`));
  }

  return freezeComposition({
    profileIds,
    requiredBaseFields: stableUnique(requiredBaseFields),
    requiredFieldIds: orderedUnion(requiredFieldIds, fieldOrder, "field"),
    requiredCheckboxIds: orderedUnion(requiredCheckboxIds, checkboxOrder, "checkbox"),
    constraints: stableUnique(constraints),
    suggestedTitleTypes: orderedUnion(suggestedTitleTypes, titleOrder, "title type"),
  });
}

export function composeProfiles(
  bundle: LoadedTemplateBundle | unknown,
  profileIds: readonly string[],
  options: ComposeProfileOptions = {},
): ComposedProfile {
  try {
    if (!Array.isArray(profileIds) || profileIds.some((id) => typeof id !== "string")) {
      throw policyError("Profile IDs must be a string array");
    }
    if (
      options.impactNature !== undefined &&
      !["functional", "non-functional", "docs-only"].includes(options.impactNature)
    ) {
      throw policyError("impact nature is unsupported");
    }
    return compose(
      asRecord(copyJsonValue(bundle), "bundle"),
      [...profileIds],
      options,
    );
  } catch (error) {
    if (isToolError(error, "POLICY_ERROR")) {
      throw error;
    }
    throw policyError("Profile data could not be evaluated safely");
  }
}
