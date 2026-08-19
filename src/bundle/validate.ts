import { Ajv } from "ajv";

import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  copyJsonValue,
  sha256CanonicalJson,
  sha256Utf8,
  type JsonObject,
  type JsonValue,
} from "../contracts/jcs.ts";
import { COMPOSABLE_PROFILE_ORDER, composeProfiles } from "./compose.ts";
import { REQUIRED_H2_HEADINGS, type LoadedTemplateBundle } from "./load.ts";

const PROFILE_IDS = ["code", "docs", "general", "ops"] as const;
const TITLE_TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "refactor",
  "perf",
  "build",
  "ci",
  "chore",
] as const;
const CHECKBOX_IDS = [
  "app", "platform", "cloud", "controller-app", "motion-control", "fpga",
  "cad-cam", "vision-ai", "process", "shared-schema-protocol", "qa", "release",
  "devops", "hardware-manufacturing", "functional", "non-functional", "docs-only",
  "no-documentation-changes", "interface-schema-protocol-documentation",
  "design-documentation", "test-documentation", "release-notes", "readme",
  "documentation-policy-reviewed", "low", "medium", "high", "local-build",
  "unit-tests", "integration-tests", "core-behavior", "docs-links-format",
  "deployment-pipeline", "source-branch-synced", "commit-convention",
  "work-item-reviewed", "metadata-reviewed", "secret-scan-reviewed",
  "repository-hygiene-reviewed", "ci-status", "reviewer-requested",
  "high-risk-reviewers", "blocking-issues",
] as const;
const CHECKBOX_REGISTRY_V1_SHA256 =
  "7de0a2e0bfd867a9670e350d905541371898307cde31f00c7895c439c53d5fdf";
const LAYOUT_V1_SHA256 =
  "1c505761b5cd3114be41782c3309b292eb064681117d19c3f22b7ebde6cff114";
const REQUEST_SCHEMA_V1_CANONICAL_SHA256 =
  "ee80e940cb4bb97575bd204fc5ab00cfb68da18836cde48a19d766befccb7559";
const FIELD_IDS = [
  "docs.target-audience",
  "docs.content-impact",
  "ops.affected-environments",
  "ops.deployment-plan",
  "ops.configuration-compatibility",
] as const;
const FIELD_CONTRACTS = [
  {
    id: "docs.target-audience",
    profile: "docs",
    h3: "Target Audience",
    sectionSlot: "motivation",
    type: "non-empty-string-list",
  },
  {
    id: "docs.content-impact",
    profile: "docs",
    h3: "Content Impact",
    sectionSlot: "changes",
    type: "non-empty-string-list",
  },
  {
    id: "ops.affected-environments",
    profile: "ops",
    h3: "Affected Environments",
    sectionSlot: "impact",
    type: "non-empty-enum-or-string-list",
  },
  {
    id: "ops.deployment-plan",
    profile: "ops",
    h3: "Deployment Plan",
    sectionSlot: "changes",
    type: "non-empty-step-list",
  },
  {
    id: "ops.configuration-compatibility",
    profile: "ops",
    h3: "Configuration Compatibility",
    sectionSlot: "risk",
    type: "non-empty-string-list",
  },
] as const;
const REQUIRED_PLACEHOLDERS = [
  "changes.summary", "changes.technicalChanges", "changes.outOfScope",
  "profileFields.changes", "motivation.background", "motivation.whyNeeded",
  "profileFields.motivation", "workItem.canonicalRelationLines",
  "issueSnapshot.milestone", "issueSnapshot.assignees", "issueSnapshot.dueDate",
  "issueSnapshot.labels", "mergeRequest.labels", "impact.checkboxes", "impact.details",
  "profileFields.impact", "verification.checkboxes", "verification.rows",
  "verification.acceptanceEvidence", "verification.knownGaps", "documentation.checkboxes",
  "documentation.details", "profileFields.documentation", "risk.levelCheckboxes",
  "risk.items", "risk.compatibilityImpact", "risk.rollbackPlan", "profileFields.risk",
  "review.checkboxes", "review.reviewerFocus", "review.additionalNotes", "diagnosticMarker",
] as const;
const REQUIRED_H3_HEADINGS = [
  "### Summary", "### Technical Changes", "### Out of Scope", "### Background",
  "### Why This Change Is Needed", "### Acceptance Evidence", "### Known Gaps",
  "### Risk Level", "### Risks", "### Compatibility Impact", "### Rollback Plan",
  "### Reviewer Focus", "### Additional Notes",
] as const;
const PROFILE_FIELDS = new Set([
  "id", "requiredBaseFields", "requiredFieldIds", "requiredCheckboxIds",
  "constraints", "matchRules", "suggestedTitleTypes",
]);
const FIELD_FIELDS = new Set([
  "id", "profile", "h3", "sectionSlot", "type", "cardinality",
  "defaultRequired", "order",
]);
const CHECKBOX_FIELDS = new Set([
  "id", "label", "kind", "source", "applicableProfiles", "applicableLifecycles",
  "sectionSlot", "order", "evidenceSchema",
]);
const BASE_FIELD_IDS = [
  "changes.summary", "changes.technicalChanges", "changes.outOfScope",
  "motivation.background", "motivation.whyNeeded", "workItem", "impact.details",
  "verification.items", "verification.acceptanceEvidence", "verification.knownGaps",
  "documentation.details", "risk.items", "risk.compatibilityImpact", "risk.rollbackPlan",
  "review.reviewerFocus", "review.additionalNotes",
] as const;
const BASE_FIELDS: ReadonlySet<string> = new Set(BASE_FIELD_IDS);
const SUPPORTED_CONSTRAINTS = new Set([
  "verification-evidence-state-required",
  "documentation-change-required",
  "deployment-evidence-state-required",
  "at-least-one-verification-evidence-state",
]);
const PROFILE_MINIMUMS = {
  code: {
    requiredBaseFields: ["changes.technicalChanges", "risk.compatibilityImpact"],
    requiredFieldIds: [],
    requiredCheckboxIds: ["local-build", "unit-tests", "integration-tests", "core-behavior"],
    constraints: ["verification-evidence-state-required"],
  },
  docs: {
    requiredBaseFields: [],
    requiredFieldIds: ["docs.target-audience", "docs.content-impact"],
    requiredCheckboxIds: ["docs-links-format"],
    constraints: ["documentation-change-required"],
  },
  general: {
    requiredBaseFields: BASE_FIELD_IDS,
    requiredFieldIds: [],
    requiredCheckboxIds: [],
    constraints: ["at-least-one-verification-evidence-state"],
  },
  ops: {
    requiredBaseFields: ["risk.rollbackPlan"],
    requiredFieldIds: [
      "ops.affected-environments",
      "ops.deployment-plan",
      "ops.configuration-compatibility",
    ],
    requiredCheckboxIds: ["deployment-pipeline"],
    constraints: ["deployment-evidence-state-required"],
  },
} as const;
const PROFILE_MATCH_RULES = {
  code: {
    paths: ["src/**", "test/**", "tests/**"],
    extensions: [
      ".c", ".cc", ".cpp", ".cxx", ".h", ".hh", ".hpp", ".hxx", ".java",
      ".js", ".jsx", ".mjs", ".mts", ".py", ".qml", ".rs", ".ts", ".tsx",
    ],
  },
  docs: {
    paths: ["docs/**", "README*", "CHANGELOG*", ".gitlab/*_templates/**"],
    extensions: [".md", ".mdx"],
  },
  general: {
    paths: [
      "LICENSE", "LICENSE.*", "NOTICE", "NOTICE.*", "CODEOWNERS", ".editorconfig",
      ".gitattributes", ".gitignore",
    ],
    extensions: [],
  },
  ops: {
    paths: [
      ".github/**", ".gitlab-ci.yml", ".gitlab/ci/**", "Dockerfile*",
      "docker-compose*.yml", "deploy/**", "helm/**", "k8s/**",
    ],
    extensions: [".dockerfile"],
  },
} as const;
const LABEL_EXAMPLES: Readonly<Record<(typeof TITLE_TYPES)[number], string>> = {
  feat: "type::feature",
  fix: "type::bug",
  docs: "type::doc",
  test: "type::test",
  refactor: "type::refactor",
  perf: "type::performance",
  build: "type::build",
  ci: "type::ci",
  chore: "type::chore",
};

function templateError(reason: string): ToolError<"TEMPLATE_ERROR"> {
  return new ToolError("TEMPLATE_ERROR", `Invalid template bundle: ${reason}`, {
    field: null,
    expected: "a semantically consistent template bundle",
    actual: reason,
    safeNextStep: "Correct the Bundle source and rebuild its manifest before publishing.",
  });
}

function asRecord(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw templateError(`${subject} must be an object`);
  }
  return value;
}

function exactFields(value: JsonObject, expected: ReadonlySet<string>, subject: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((field, index) => field !== wanted[index])) {
    throw templateError(`${subject} has missing or unknown fields`);
  }
}

function stringArray(value: JsonValue | undefined, subject: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw templateError(`${subject} must be a string array`);
  }
  const strings = value as string[];
  if (new Set(strings).size !== strings.length) {
    throw templateError(`${subject} contains duplicate IDs`);
  }
  return strings;
}

function exactArray(actual: readonly string[], expected: readonly string[], subject: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw templateError(`${subject} does not match the fixed contract`);
  }
}

function positiveOrder(value: JsonValue | undefined, subject: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw templateError(`${subject} order must be a positive integer`);
  }
  return value as number;
}

function validateLayout(bundle: JsonObject): void {
  const layout = asRecord(bundle.layout, "layout");
  exactFields(layout, new Set(["markdown", "h2Headings"]), "layout");
  if (typeof layout.markdown !== "string") {
    throw templateError("layout markdown must be a string");
  }
  if (sha256Utf8(layout.markdown) !== LAYOUT_V1_SHA256) {
    throw templateError("layout markdown does not match the exact V1 contract");
  }
  exactArray(stringArray(layout.h2Headings, "layout headings"), REQUIRED_H2_HEADINGS, "layout headings");
  exactArray(layout.markdown.match(/^## .+$/gm) ?? [], REQUIRED_H2_HEADINGS, "layout H2 headings");
  exactArray(layout.markdown.match(/^### .+$/gm) ?? [], REQUIRED_H3_HEADINGS, "layout H3 headings");
  const placeholders = [...layout.markdown.matchAll(/\{\{([A-Za-z][A-Za-z0-9.]*)\}\}/g)]
    .map((match) => match[1] as string);
  exactArray(placeholders, REQUIRED_PLACEHOLDERS, "layout placeholders");
  if (!layout.markdown.includes("| Check | Command / Method | Result | Evidence |") ||
      !layout.markdown.trimEnd().endsWith("{{diagnosticMarker}}")) {
    throw templateError("layout table or final diagnostic marker is invalid");
  }
}

function validateFields(bundle: JsonObject): ReadonlyMap<string, JsonObject> {
  const registries = asRecord(bundle.registries, "registries");
  exactFields(registries, new Set(["checkboxes", "fields"]), "registries");
  const registry = asRecord(registries.fields, "field registry");
  exactFields(registry, new Set(["schemaVersion", "titleTypes", "fields"]), "field registry");
  if (registry.schemaVersion !== 1) {
    throw templateError("field registry schema version must be 1");
  }
  exactArray(stringArray(registry.titleTypes, "title types"), TITLE_TYPES, "title types");
  if (!Array.isArray(registry.fields)) {
    throw templateError("field registry entries must be an array");
  }
  const entries = new Map<string, JsonObject>();
  const orders = new Set<number>();
  for (const [index, value] of registry.fields.entries()) {
    const entry = asRecord(value, "field entry");
    exactFields(entry, FIELD_FIELDS, "field entry");
    const expected = FIELD_CONTRACTS[index];
    if (expected === undefined || entry.id !== expected.id || entry.h3 !== expected.h3 ||
        entry.profile !== expected.profile || entry.sectionSlot !== expected.sectionSlot ||
        entry.type !== expected.type ||
        entry.defaultRequired !== true) {
      throw templateError("field registry entry does not match its fixed contract");
    }
    const cardinality = asRecord(entry.cardinality, "field cardinality");
    exactFields(cardinality, new Set(["min"]), "field cardinality");
    if (cardinality.min !== 1) {
      throw templateError("field cardinality must require one value");
    }
    const order = positiveOrder(entry.order, "field");
    if (order !== index + 1 || orders.has(order)) {
      throw templateError("field registry order is duplicated or unstable");
    }
    orders.add(order);
    entries.set(expected.id, entry);
  }
  if (entries.size !== FIELD_IDS.length) {
    throw templateError("field registry is incomplete");
  }
  return entries;
}

function validateCheckboxes(bundle: JsonObject): ReadonlyMap<string, JsonObject> {
  const registry = asRecord(asRecord(bundle.registries, "registries").checkboxes, "checkbox registry");
  exactFields(registry, new Set(["schemaVersion", "checkboxes"]), "checkbox registry");
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.checkboxes)) {
    throw templateError("checkbox registry schema or entries are invalid");
  }
  if (sha256CanonicalJson(registry) !== CHECKBOX_REGISTRY_V1_SHA256) {
    throw templateError("checkbox registry does not match the V1 semantic contract");
  }
  const entries = new Map<string, JsonObject>();
  for (const [index, value] of registry.checkboxes.entries()) {
    const entry = asRecord(value, "checkbox entry");
    exactFields(entry, CHECKBOX_FIELDS, "checkbox entry");
    const expectedId = CHECKBOX_IDS[index];
    if (expectedId === undefined || entry.id !== expectedId || positiveOrder(entry.order, "checkbox") !== index + 1 ||
        typeof entry.label !== "string" || entry.label.trim() === "" ||
        typeof entry.kind !== "string" || typeof entry.source !== "string" ||
        typeof entry.sectionSlot !== "string") {
      throw templateError("checkbox registry ID, label, or order is invalid");
    }
    const applicableProfiles = stringArray(entry.applicableProfiles, "checkbox applicableProfiles");
    if (applicableProfiles.some((id) => !PROFILE_IDS.includes(id as never))) {
      throw templateError("checkbox references an unknown Profile");
    }
    const lifecycles = stringArray(entry.applicableLifecycles, "checkbox applicableLifecycles");
    if (lifecycles.some((id) => !["structure", "ready", "merge"].includes(id))) {
      throw templateError("checkbox references an unknown lifecycle");
    }
    entries.set(expectedId, entry);
  }
  if (entries.size !== CHECKBOX_IDS.length) {
    throw templateError("checkbox registry is incomplete");
  }
  return entries;
}

function validateProfiles(
  bundle: JsonObject,
  fields: ReadonlyMap<string, JsonObject>,
  checkboxes: ReadonlyMap<string, JsonObject>,
): void {
  const profiles = asRecord(bundle.profiles, "profiles");
  exactFields(profiles, new Set(PROFILE_IDS), "profiles");
  for (const id of PROFILE_IDS) {
    const profile = asRecord(profiles[id], `Profile ${id}`);
    exactFields(profile, PROFILE_FIELDS, `Profile ${id}`);
    if (profile.id !== id) {
      throw templateError(`Profile ${id} has a mismatched ID`);
    }
    const baseFields = stringArray(profile.requiredBaseFields, `${id}.requiredBaseFields`);
    const requiredFieldIds = stringArray(profile.requiredFieldIds, `${id}.requiredFieldIds`);
    const requiredCheckboxIds = stringArray(
      profile.requiredCheckboxIds,
      `${id}.requiredCheckboxIds`,
    );
    const constraints = stringArray(profile.constraints, `${id}.constraints`);
    const minimum = PROFILE_MINIMUMS[id];
    for (const [subject, actual, required] of [
      ["base fields", baseFields, minimum.requiredBaseFields],
      ["fields", requiredFieldIds, minimum.requiredFieldIds],
      ["checkboxes", requiredCheckboxIds, minimum.requiredCheckboxIds],
      ["constraints", constraints, minimum.constraints],
    ] as const) {
      if (required.some((value) => !actual.includes(value))) {
        throw templateError(`Profile ${id} is missing required V1 ${subject}`);
      }
    }
    if (baseFields.some((field) => !BASE_FIELDS.has(field))) {
      throw templateError(`Profile ${id} references an unknown base field`);
    }
    for (const fieldId of requiredFieldIds) {
      const field = fields.get(fieldId);
      if (field === undefined) {
        throw templateError(`Profile ${id} references an unknown field ID`);
      }
      if (field.profile !== id) {
        throw templateError(`Profile ${id} references another Profile's field`);
      }
    }
    for (const checkboxId of requiredCheckboxIds) {
      const checkbox = checkboxes.get(checkboxId);
      if (checkbox === undefined) {
        throw templateError(`Profile ${id} references an unknown checkbox ID`);
      }
      if (!stringArray(checkbox.applicableProfiles, "checkbox applicableProfiles").includes(id)) {
        throw templateError(`Profile ${id} references an inapplicable checkbox`);
      }
    }
    if (constraints.some((value) => !SUPPORTED_CONSTRAINTS.has(value))) {
      throw templateError(`Profile ${id} references an unknown constraint`);
    }
    const matchRules = asRecord(profile.matchRules, `${id}.matchRules`);
    exactFields(matchRules, new Set(["paths", "extensions"]), `${id}.matchRules`);
    const paths = stringArray(matchRules.paths, `${id}.matchRules.paths`);
    const extensions = stringArray(matchRules.extensions, `${id}.matchRules.extensions`);
    if (paths.length === 0 || [...paths, ...extensions].some((rule) => rule.trim() !== rule || rule === "")) {
      throw templateError(`Profile ${id} match rules are invalid`);
    }
    if (extensions.some((extension) => !/^\.[a-z0-9]+$/.test(extension))) {
      throw templateError(`Profile ${id} extension rules are invalid`);
    }
    exactArray(paths, PROFILE_MATCH_RULES[id].paths, `${id}.matchRules.paths`);
    exactArray(extensions, PROFILE_MATCH_RULES[id].extensions, `${id}.matchRules.extensions`);
    if (stringArray(profile.suggestedTitleTypes, `${id}.suggestedTitleTypes`)
      .some((type) => !TITLE_TYPES.includes(type as never))) {
      throw templateError(`Profile ${id} references an unknown title type`);
    }
  }

  const combinations = [
    ["general"], ["code"], ["docs"], ["ops"], ["code", "docs"],
    ["code", "ops"], ["docs", "ops"], [...COMPOSABLE_PROFILE_ORDER],
  ] as const;
  for (const combination of combinations) {
    try {
      composeProfiles(bundle, combination);
    } catch {
      throw templateError("Profile composition contains a registry conflict");
    }
  }
}

function validatePolicy(bundle: JsonObject): void {
  const policy = asRecord(bundle.policy, "policy");
  exactFields(policy, new Set(["policySchema", "labels", "title", "review"]), "policy");
  if (policy.policySchema !== 1) {
    throw templateError("policy schema version must be 1");
  }
  const labels = asRecord(policy.labels, "label policy");
  exactFields(labels, new Set(["categories", "lifecycle"]), "label policy");
  const categories = asRecord(labels.categories, "label categories");
  exactFields(categories, new Set(["week", "type", "priority", "status"]), "label categories");
  for (const id of ["week", "type", "priority", "status"] as const) {
    const category = asRecord(categories[id], `label category ${id}`);
    exactFields(category, new Set(["match", "required", "max"]), `label category ${id}`);
    if (category.match !== `^${id}::` || category.required !== true || category.max !== 1) {
      throw templateError(`label category ${id} is invalid`);
    }
  }
  const lifecycle = asRecord(labels.lifecycle, "label lifecycle");
  exactFields(lifecycle, new Set(["statusCategory", "expectedNames"]), "label lifecycle");
  const expectedNames = asRecord(lifecycle.expectedNames, "lifecycle names");
  exactFields(expectedNames, new Set(["draft", "ready", "merge"]), "lifecycle names");
  if (lifecycle.statusCategory !== "status" || expectedNames.draft !== "status::doing" ||
      expectedNames.ready !== "status::review" || expectedNames.merge !== "status::review") {
    throw templateError("lifecycle exact label names are invalid");
  }
  const title = asRecord(policy.title, "title policy");
  exactFields(title, new Set(["typeRegistry", "typeLabelCompatibility"]), "title policy");
  if (title.typeRegistry !== "registries/fields.json#titleTypes") {
    throw templateError("title type registry pointer is invalid");
  }
  const compatibility = asRecord(title.typeLabelCompatibility, "title label compatibility");
  exactFields(compatibility, new Set(TITLE_TYPES), "title label compatibility");
  for (const type of TITLE_TYPES) {
    const expectedExpression = `^${LABEL_EXAMPLES[type]}$`;
    if (compatibility[type] !== expectedExpression) {
      throw templateError("title label compatibility does not match the exact V1 mapping");
    }
  }
  const review = asRecord(policy.review, "review policy");
  exactFields(review, new Set([
    "draftMinimumReviewers", "readyMinimumReviewers", "highRiskMinimumReviewers",
  ]), "review policy");
  if (review.draftMinimumReviewers !== 0 || review.readyMinimumReviewers !== 1 ||
      review.highRiskMinimumReviewers !== 2) {
    throw templateError("review defaults are invalid");
  }
}

function validateSchemaVersions(bundle: JsonObject): void {
  const manifest = asRecord(bundle.manifest, "manifest");
  const schema = asRecord(bundle.schema, "request schema");
  if (sha256CanonicalJson(schema) !== REQUEST_SCHEMA_V1_CANONICAL_SHA256) {
    throw templateError("request schema does not match the canonical V1 contract");
  }
  const properties = asRecord(schema.properties, "request schema properties");
  const schemaVersion = asRecord(properties.schemaVersion, "request schema version");
  if (manifest.inputSchema !== schemaVersion.const || manifest.inputSchema !== 1) {
    throw templateError("manifest and request schema versions do not match");
  }
  const policy = asRecord(bundle.policy, "policy");
  if (manifest.policySchema !== policy.policySchema || manifest.policySchema !== 1) {
    throw templateError("manifest and policy schema versions do not match");
  }
  const definitions = asRecord(schema.definitions, "request schema definitions");
  const title = asRecord(definitions.title, "request title schema");
  const titleProperties = asRecord(title.properties, "request title properties");
  const titleType = asRecord(titleProperties.type, "request title type");
  if (Object.hasOwn(titleType, "enum")) {
    throw templateError("request schema must reference the central title type registry at runtime");
  }
  try {
    new Ajv({ allErrors: true, strict: true }).compile(schema);
  } catch {
    throw templateError("request schema cannot be compiled as strict JSON Schema");
  }
}

function validate(value: JsonObject): void {
  exactFields(
    value,
    new Set(["manifest", "layout", "schema", "policy", "registries", "profiles"]),
    "loaded bundle",
  );
  validateLayout(value);
  const fields = validateFields(value);
  const checkboxes = validateCheckboxes(value);
  validateProfiles(value, fields, checkboxes);
  validatePolicy(value);
  validateSchemaVersions(value);
}

export function validateTemplateBundle(bundle: LoadedTemplateBundle | unknown): void {
  try {
    validate(asRecord(copyJsonValue(bundle), "loaded bundle"));
  } catch (error) {
    if (isToolError(error, "TEMPLATE_ERROR")) {
      throw error;
    }
    throw templateError("semantic validation failed safely");
  }
}
