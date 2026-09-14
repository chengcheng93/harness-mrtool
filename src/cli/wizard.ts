import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import type { InputFormat, InputIo } from "../input/load-input.ts";
import { decodeInputBytes, MAX_INPUT_BYTES } from "../input/load-input.ts";
import { normalizeProductionRequest, type InteractiveRequestWizard } from "./production-input.ts";
import { DEFAULT_LABEL_POOL } from "../app/label-defaults.ts";
import type { DiffTypeLabel } from "../app/diff-labels.ts";
import { selectMandatoryLabels, type MandatoryLabelInput, type LabelSelectionOptions } from "../app/mandatory-labels.ts";
import {
  clearWizardLabelOptions, labelOptionsForProductionInvocation, recordWizardLabelOptions,
  recordWizardUpdateConfirmations, type UpdateConfirmationEvidence,
} from "./production-invocation.ts";
import type { CliInvocation } from "./program.ts";
import { stringify as stringifyYaml } from "yaml";

export interface WizardChoice {
  readonly label: string;
}

export interface WizardConsole {
  readonly selectOne: (input: {
    readonly id: string;
    readonly prompt: string;
    readonly choices: readonly WizardChoice[];
    readonly defaultIndex?: number;
  }) => Promise<number>;
  readonly selectMany: (input: {
    readonly id: string;
    readonly prompt: string;
    readonly choices: readonly WizardChoice[];
    readonly defaultIndexes?: readonly number[];
    readonly min?: number;
    readonly max?: number;
  }) => Promise<readonly number[]>;
  readonly text: (input: {
    readonly id: string;
    readonly prompt: string;
    readonly defaultValue?: string;
  }) => Promise<string>;
  readonly confirm: (input: {
    readonly id: string;
    readonly prompt: string;
    readonly defaultValue: boolean;
  }) => Promise<boolean>;
  readonly close?: () => void | Promise<void>;
}

interface CatalogEntry {
  readonly id: string;
  readonly label: string;
}

export interface WizardCatalog {
  // Optional only for source compatibility with custom catalog ports. Collection
  // fails closed when absent; a legacy token catalog is never a fallback.
  readonly automaticLabels?: Omit<MandatoryLabelInput, "intent" | "options">;
  readonly contextId: string;
  readonly issueIid: number | null;
  readonly targetBranch: string;
  readonly profiles: readonly CatalogEntry[];
  readonly suggestedProfileIds: readonly string[];
  readonly titleTypes: readonly string[];
  readonly impactAreas: readonly CatalogEntry[];
  readonly verificationItems: readonly CatalogEntry[];
  readonly documentationItems: readonly CatalogEntry[];
  readonly profileFields: readonly (CatalogEntry & { readonly profileId: string })[];
  readonly labelCategories: readonly {
    readonly id: string;
    readonly required: boolean;
    readonly max: number;
  }[];
  readonly labelCandidates: readonly {
    readonly token: string;
    readonly category: string;
    readonly name: string;
    readonly description: string;
    readonly scopeKind: "project" | "group";
    readonly scopePath: string;
    readonly currentlyApplied: boolean;
    readonly defaultSelected: boolean;
  }[];
  readonly userCandidates: readonly {
    readonly token: string;
    readonly kind: "assignee" | "reviewer";
    readonly username: string;
    readonly displayName: string;
    readonly currentlyApplied: boolean;
    readonly defaultSelected: boolean;
    readonly qualifiedReviewer: boolean;
  }[];
  readonly confirmations: UpdateConfirmationEvidence | null;
}

export interface WizardCatalogSource {
  readonly load: (input: {
    readonly invocation: CliInvocation;
    readonly issueIid: number | null;
  }) => Promise<WizardCatalog>;
}

export interface WizardLongFormEditor {
  readonly edit: (input: { readonly initialBytes: Uint8Array }) => Promise<Uint8Array>;
}

export interface InteractiveRequestWizardOptions {
  readonly catalogSource: WizardCatalogSource;
  readonly console: WizardConsole;
  readonly editor: WizardLongFormEditor;
}

type WizardPort = "catalog" | "console" | "editor";

function wizardPortError(port: WizardPort): ToolError<"INPUT_ERROR"> {
  const messages = {
    catalog: "Interactive request catalog is unavailable",
    console: "Interactive request console is unavailable",
    editor: "Interactive request editor is unavailable",
  } as const;
  return new ToolError("INPUT_ERROR", messages[port], {
    field: `wizard.${port}`,
    expected: "one available deterministic interactive request port",
    actual: `interactive ${port} port failed`,
    safeNextStep: "Restart the wizard after checking the local interactive environment; no remote write was attempted.",
  });
}

async function callWizardPort<T>(port: WizardPort, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw wizardPortError(port);
  }
}

function guardedConsole(console: WizardConsole): WizardConsole {
  return Object.freeze({
    selectOne: (input: Parameters<WizardConsole["selectOne"]>[0]) =>
      callWizardPort("console", async () => console.selectOne(input)),
    selectMany: (input: Parameters<WizardConsole["selectMany"]>[0]) =>
      callWizardPort("console", async () => console.selectMany(input)),
    text: (input: Parameters<WizardConsole["text"]>[0]) =>
      callWizardPort("console", async () => console.text(input)),
    confirm: (input: Parameters<WizardConsole["confirm"]>[0]) =>
      callWizardPort("console", async () => console.confirm(input)),
    ...(console.close === undefined
      ? {}
      : { close: () => callWizardPort("console", async () => console.close!()) }),
  });
}

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SHA256_PAIR = /^[a-f0-9]{64}:[a-f0-9]{64}$/u;

function wizardError(reason: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Interactive request input is invalid", {
    field: "wizard",
    expected: "enumerated selections and one valid bounded long-form YAML document",
    actual: reason,
    safeNextStep: "Restart the wizard, choose only listed values, and complete every required field.",
  });
}

function scalar(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim() &&
    !/[\r\n\u0000\u2028\u2029]/u.test(value);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    throw wizardError("long-form document contains a non-object section");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const actual = Object.keys(descriptors);
  if (
    actual.length !== keys.length || keys.some((key) => !actual.includes(key)) ||
    Object.values(descriptors).some((descriptor) => !descriptor.enumerable || "get" in descriptor || "set" in descriptor)
  ) {
    throw wizardError("long-form document fields do not match the wizard contract");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, reason: string): readonly unknown[] {
  if (!Array.isArray(value)) throw wizardError(reason);
  return value;
}

function assertCatalogEntries(entries: readonly CatalogEntry[], subject: string): void {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!ID.test(entry.id) || !scalar(entry.label) || ids.has(entry.id)) {
      throw wizardError(`${subject} catalog is invalid`);
    }
    ids.add(entry.id);
  }
}

function catalogObject(
  value: JsonValue | undefined,
  required: readonly string[],
  optional: readonly string[] = [],
): JsonObject {
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    throw wizardError("catalog fields do not match the wizard contract");
  }
  const actual = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (required.some((key) => !actual.includes(key)) || actual.some((key) => !allowed.has(key))) {
    throw wizardError("catalog fields do not match the wizard contract");
  }
  return value;
}

function catalogArray(value: JsonValue | undefined): readonly JsonValue[] {
  if (!Array.isArray(value)) throw wizardError("catalog fields do not match the wizard contract");
  return value;
}

function deepFreezeCatalog<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value)) deepFreezeCatalog(child);
  return Object.freeze(value);
}

function snapshotCatalog(value: WizardCatalog): WizardCatalog {
  let copied: JsonValue;
  try {
    copied = copyJsonValue(value);
  } catch {
    throw wizardError("catalog fields do not match the wizard contract");
  }
  const root = catalogObject(copied, [
    "contextId", "issueIid", "targetBranch", "profiles", "suggestedProfileIds",
    "titleTypes", "impactAreas", "verificationItems", "documentationItems",
    "profileFields", "labelCategories", "labelCandidates", "userCandidates",
    "confirmations",
  ], ["automaticLabels"]);
  for (const entry of catalogArray(root.profiles)) catalogObject(entry, ["id", "label"]);
  for (const entry of catalogArray(root.impactAreas)) catalogObject(entry, ["id", "label"]);
  for (const entry of catalogArray(root.verificationItems)) catalogObject(entry, ["id", "label"]);
  for (const entry of catalogArray(root.documentationItems)) catalogObject(entry, ["id", "label"]);
  for (const entry of catalogArray(root.profileFields)) {
    catalogObject(entry, ["id", "label", "profileId"]);
  }
  for (const entry of catalogArray(root.labelCategories)) {
    catalogObject(entry, ["id", "required", "max"]);
  }
  for (const entry of catalogArray(root.labelCandidates)) {
    catalogObject(entry, [
      "token", "category", "name", "description", "scopeKind", "scopePath",
      "currentlyApplied", "defaultSelected",
    ]);
  }
  for (const entry of catalogArray(root.userCandidates)) {
    catalogObject(entry, [
      "token", "kind", "username", "displayName", "currentlyApplied",
      "defaultSelected", "qualifiedReviewer",
    ]);
  }
  catalogArray(root.suggestedProfileIds);
  catalogArray(root.titleTypes);
  if (root.confirmations !== null) {
    catalogObject(root.confirmations, ["updateMarkerDigest", "descriptionDigest"], ["migrationDigest"]);
  }
  return deepFreezeCatalog(root) as unknown as WizardCatalog;
}

function validateCatalog(catalogValue: WizardCatalog): WizardCatalog {
  const catalog = snapshotCatalog(catalogValue);
  if (!scalar(catalog.contextId) || !scalar(catalog.targetBranch) ||
      (catalog.issueIid !== null && (!Number.isSafeInteger(catalog.issueIid) || catalog.issueIid < 1))) {
    throw wizardError("wizard context binding is invalid");
  }
  assertCatalogEntries(catalog.profiles, "profile");
  assertCatalogEntries(catalog.impactAreas, "impact area");
  assertCatalogEntries(catalog.verificationItems, "verification");
  assertCatalogEntries(catalog.documentationItems, "documentation");
  assertCatalogEntries(catalog.profileFields, "profile field");
  if (catalog.profiles.length === 0 || catalog.titleTypes.length === 0 ||
      catalog.titleTypes.some((value) => !ID.test(value)) ||
      new Set(catalog.titleTypes).size !== catalog.titleTypes.length) {
    throw wizardError("profile or title type catalog is invalid");
  }
  const profileIds = new Set(catalog.profiles.map((entry) => entry.id));
  if (catalog.suggestedProfileIds.some((id) => !profileIds.has(id)) ||
      new Set(catalog.suggestedProfileIds).size !== catalog.suggestedProfileIds.length ||
      catalog.profileFields.some((field) => !profileIds.has(field.profileId))) {
    throw wizardError("profile catalog references an unknown profile");
  }
  const categoryIds = new Set<string>();
  for (const category of catalog.labelCategories) {
    if (!ID.test(category.id) || categoryIds.has(category.id) ||
        typeof category.required !== "boolean" ||
        !Number.isSafeInteger(category.max) || category.max < 1) {
      throw wizardError("label category catalog is invalid");
    }
    categoryIds.add(category.id);
  }
  const tokens = new Set<string>();
  for (const candidate of [...catalog.labelCandidates, ...catalog.userCandidates]) {
    if (!scalar(candidate.token) || tokens.has(candidate.token)) {
      throw wizardError("candidate catalog is invalid");
    }
    tokens.add(candidate.token);
  }
  if (catalog.labelCandidates.some((candidate) =>
    !categoryIds.has(candidate.category) || !scalar(candidate.name) ||
    (candidate.description !== "" && !scalar(candidate.description)) ||
    (candidate.scopeKind !== "project" && candidate.scopeKind !== "group") ||
    !scalar(candidate.scopePath) || typeof candidate.currentlyApplied !== "boolean" ||
    typeof candidate.defaultSelected !== "boolean"
  ) || catalog.userCandidates.some((candidate) =>
    (candidate.kind !== "assignee" && candidate.kind !== "reviewer") ||
    !scalar(candidate.username) || !scalar(candidate.displayName) ||
    typeof candidate.currentlyApplied !== "boolean" ||
    typeof candidate.defaultSelected !== "boolean" ||
    typeof candidate.qualifiedReviewer !== "boolean"
  )) {
    throw wizardError("candidate metadata is invalid");
  }
  if (catalog.confirmations !== null) {
    const confirmation = catalog.confirmations;
    if (
      (typeof confirmation.updateMarkerDigest !== "string" || !SHA256.test(confirmation.updateMarkerDigest)) ||
      (typeof confirmation.descriptionDigest !== "string" || !SHA256.test(confirmation.descriptionDigest)) ||
      (confirmation.migrationDigest !== undefined && !SHA256_PAIR.test(confirmation.migrationDigest))
    ) {
      throw wizardError("confirmation catalog is invalid");
    }
  }
  return catalog;
}

function confirmationMismatch(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Interactive confirmation did not match", {
    field: "confirmation",
    expected: "the exact marker or hash digest shown for this update",
    actual: "confirmation mismatch",
    safeNextStep: "Refresh update context, inspect the current state, and type the exact digest again.",
  });
}

async function assertExactConfirmation(
  console: WizardConsole,
  id: string,
  prompt: string,
  expected: string | undefined,
): Promise<void> {
  if (expected === undefined) throw wizardError("required update confirmation is unavailable");
  const actual = await console.text({ id, prompt });
  if (actual !== expected) throw confirmationMismatch();
}

async function confirmInteractiveUpdate(
  invocation: CliInvocation,
  catalog: WizardCatalog,
  console: WizardConsole,
): Promise<UpdateConfirmationEvidence | null> {
  const command = invocation.command;
  if (command.kind !== "update") return null;
  const evidence = catalog.confirmations;
  // Preflight the complete operation before asking for any partial approval.
  if (evidence === null || (command.migrateTemplate && evidence.migrationDigest === undefined)) {
    throw wizardError("required update confirmation is unavailable");
  }
  if (command.migrateTemplate && command.confirmation !== null && command.confirmation !== evidence.migrationDigest) {
    throw confirmationMismatch();
  }
  await assertExactConfirmation(
    console,
    "confirmation.update-marker",
    `Update MR !${command.iid}. Current description SHA-256: ${evidence.descriptionDigest}. ` +
      `Type the exact managed marker digest to update. Confirmation digest: ${evidence.updateMarkerDigest}`,
    evidence.updateMarkerDigest,
  );
  if (command.forceReplaceDescription) {
    await assertExactConfirmation(
      console,
      "confirmation.force-replace",
      `Replace the current description of MR !${command.iid}. Type its exact SHA-256. Confirmation digest: ${evidence.descriptionDigest}`,
      evidence.descriptionDigest,
    );
  }
  if (command.migrateTemplate) {
    await assertExactConfirmation(
      console,
      "confirmation.migration",
      `Migrate MR !${command.iid}. Type the exact old:new Bundle hash pair. Confirmation digest: ${evidence.migrationDigest}`,
      evidence.migrationDigest,
    );
  }
  return {
    updateMarkerDigest: evidence.updateMarkerDigest,
    descriptionDigest: evidence.descriptionDigest,
    ...(command.migrateTemplate ? { migrationDigest: evidence.migrationDigest! } : {}),
  };
}

function choices(values: readonly string[]): readonly WizardChoice[] {
  return values.map((label) => Object.freeze({ label }));
}

function selectedIndexes(
  value: readonly number[],
  length: number,
  min: number,
  max: number,
): readonly number[] {
  if (
    value.length < min || value.length > max || new Set(value).size !== value.length ||
    value.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= length)
  ) {
    throw wizardError("a multiple-choice answer is outside the enumerated candidates");
  }
  return [...value];
}

function selectedIndex(value: number, length: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw wizardError("a single-choice answer is outside the enumerated candidates");
  }
  return value;
}

async function chooseOne<T>(
  console: WizardConsole,
  id: string,
  prompt: string,
  values: readonly T[],
  label: (value: T) => string,
  defaultIndex?: number,
): Promise<T> {
  const index = selectedIndex(await console.selectOne({
    id,
    prompt,
    choices: choices(values.map(label)),
    ...(defaultIndex === undefined ? {} : { defaultIndex }),
  }), values.length);
  return values[index]!;
}

async function chooseMany<T>(
  console: WizardConsole,
  id: string,
  prompt: string,
  values: readonly T[],
  label: (value: T) => string,
  min: number,
  max = values.length,
  defaultIndexes?: readonly number[],
): Promise<readonly T[]> {
  const indexes = selectedIndexes(await console.selectMany({
    id,
    prompt,
    choices: choices(values.map(label)),
    min,
    max,
    ...(defaultIndexes === undefined ? {} : { defaultIndexes }),
  }), values.length, min, max);
  return indexes.map((index) => values[index]!);
}

function emptyLongForm(selectedVerificationCount: number, selectedProfileFieldCount: number): JsonObject {
  return {
    changes: { summary: [], technicalChanges: [], outOfScope: [] },
    motivation: { background: [], whyNeeded: [] },
    noIssueReason: null,
    impact: { details: [] },
    verification: {
      items: Array.from({ length: selectedVerificationCount }, () => ({
        state: "pending",
        evidenceKind: "pending-reason",
        command: null,
        result: null,
        evidence: "",
      })),
      acceptanceEvidence: [],
      knownGaps: [],
    },
    documentation: { details: [] },
    risk: { items: [], compatibilityImpact: [], rollbackPlan: [] },
    profileFieldValues: Array.from({ length: selectedProfileFieldCount }, () => []),
    review: { reviewerFocus: [], additionalNotes: [] },
  };
}

interface ParsedLongForm {
  readonly changes: Record<string, unknown>;
  readonly motivation: Record<string, unknown>;
  readonly noIssueReason: unknown;
  readonly impact: Record<string, unknown>;
  readonly verification: Record<string, unknown>;
  readonly documentation: Record<string, unknown>;
  readonly risk: Record<string, unknown>;
  readonly profileFieldValues: readonly unknown[];
  readonly review: Record<string, unknown>;
}

function parseLongForm(bytes: Uint8Array, format: InputFormat = "yaml"): ParsedLongForm {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_INPUT_BYTES) {
    throw wizardError("editor output is not a bounded byte sequence");
  }
  const root = exactObject(decodeInputBytes(bytes, format), [
    "changes", "motivation", "noIssueReason", "impact", "verification",
    "documentation", "risk", "profileFieldValues", "review",
  ]);
  return {
    changes: exactObject(root.changes, ["summary", "technicalChanges", "outOfScope"]),
    motivation: exactObject(root.motivation, ["background", "whyNeeded"]),
    noIssueReason: root.noIssueReason,
    impact: exactObject(root.impact, ["details"]),
    verification: exactObject(root.verification, ["items", "acceptanceEvidence", "knownGaps"]),
    documentation: exactObject(root.documentation, ["details"]),
    risk: exactObject(root.risk, ["items", "compatibilityImpact", "rollbackPlan"]),
    profileFieldValues: array(root.profileFieldValues, "profile field values must be an array"),
    review: exactObject(root.review, ["reviewerFocus", "additionalNotes"]),
  };
}

function verificationItems(
  parsed: ParsedLongForm,
  selected: readonly CatalogEntry[],
): JsonValue[] {
  const values = array(parsed.verification.items, "verification items must be an array");
  if (values.length !== selected.length) throw wizardError("verification item slot count changed");
  return values.map((value, index) => ({
    id: selected[index]!.id,
    ...exactObject(value, ["state", "evidenceKind", "command", "result", "evidence"]),
  } as JsonObject));
}

function profileFields(
  parsed: ParsedLongForm,
  selected: readonly (CatalogEntry & { readonly profileId: string })[],
): JsonObject {
  if (parsed.profileFieldValues.length !== selected.length) {
    throw wizardError("profile field slot count changed");
  }
  const result: Record<string, JsonValue> = {};
  for (const [index, field] of selected.entries()) {
    result[field.id] = array(
      parsed.profileFieldValues[index],
      "profile field slot must be an array",
    ) as JsonValue[];
  }
  return result;
}

async function explicitOrSelectedProfiles(
  invocation: CliInvocation,
  catalog: WizardCatalog,
  console: WizardConsole,
): Promise<readonly CatalogEntry[]> {
  if (invocation.options.profile?.kind === "explicit") {
    const byId = new Map(catalog.profiles.map((profile) => [profile.id, profile]));
    const selected = invocation.options.profile.ids.map((id) => byId.get(id));
    if (selected.some((entry) => entry === undefined)) throw wizardError("CLI profile is not enumerated");
    return selected as readonly CatalogEntry[];
  }
  const suggested = new Set(catalog.suggestedProfileIds);
  const defaultIndexes = catalog.profiles.flatMap((profile, index) => suggested.has(profile.id) ? [index] : []);
  return chooseMany(
    console,
    "profiles",
    "Select request profiles",
    catalog.profiles,
    (entry) => entry.label,
    1,
    catalog.profiles.length,
    defaultIndexes,
  );
}

interface WorkItemSelection {
  readonly relation: "none" | "related" | "closes";
  readonly iid: number | null;
}

async function collectWorkItem(console: WizardConsole): Promise<WorkItemSelection> {
  const relation = await chooseOne(
    console,
    "workItem.relation",
    "Select work item relation",
    ["none", "related", "closes"] as const,
    String,
  );
  if (relation === "none") return Object.freeze({ relation, iid: null });
  const raw = await console.text({ id: "workItem.iid", prompt: "Enter work item IID" });
  if (!/^[1-9][0-9]*$/u.test(raw)) throw wizardError("work item IID is invalid");
  const iid = Number(raw);
  if (!Number.isSafeInteger(iid)) throw wizardError("work item IID is invalid");
  return Object.freeze({ relation, iid });
}

interface CollectedRequest {
  readonly request: JsonObject;
  readonly labelOptions: LabelSelectionOptions;
  readonly updateConfirmations: UpdateConfirmationEvidence | null;
}

async function collectAutomaticLabels(
  invocation: CliInvocation,
  catalog: WizardCatalog,
  intent: "draft" | "ready",
  console: WizardConsole,
) {
  const evidence = catalog.automaticLabels;
  if (evidence === undefined) throw wizardError("canonical automatic-label evidence is unavailable");
  let options = labelOptionsForProductionInvocation(invocation);
  const select = () => selectMandatoryLabels({ ...evidence, intent, options });
  let selection;
  try {
    selection = select();
  } catch (error) {
    // Only this precise ambiguity is recoverable interactively. Stale evidence,
    // stale CLI confirmations and inventory failures must not become a fallback.
    const actual = error instanceof ToolError ? error.details.actual : undefined;
    if (error instanceof ToolError && error.code === "LABEL_ERROR" &&
        actual !== null && typeof actual === "object" && !Array.isArray(actual) &&
        actual.reason === "diff type requires confirmation" && typeof actual.diffDigest === "string") {
      const digest = actual.diffDigest;
      const types = DEFAULT_LABEL_POOL.filter((name) => name.startsWith("type::"))
        .map((name) => name.slice("type::".length) as DiffTypeLabel);
      const confirmedType = await chooseOne(console, "labels.confirm-type",
        `Diff type is ambiguous. Review the committed diff and confirm its type. Diff digest: ${digest}`,
        types, String);
      await assertExactConfirmation(console, "labels.confirm-digest",
        `Type the exact diff digest to bind your type confirmation: ${digest}`, digest);
      options = { ...options, confirmedType, confirmationDigest: digest };
      selection = select();
    } else {
      throw error;
    }
  }
  if (invocation.options.priority === null && await console.confirm({
    id: "labels.escalate",
    prompt: `Automatic labels: ${selection.names.join(", ")}. Diff digest: ${selection.diffDigest}. Escalate priority above p2?`,
    defaultValue: false,
  })) {
    const priority = await chooseOne(console, "labels.priority", "Select explicit priority escalation",
      ["p1", "p0"] as const, String);
    const priorityReason = (await console.text({ id: "labels.priority-reason", prompt: "Explain why this priority escalation is required" })).trim();
    options = { ...options, priority, priorityReason };
    selection = select();
  }
  if (!await console.confirm({
    id: "labels.accept",
    prompt: `Automatic labels: ${selection.names.join(", ")}. Diff digest: ${selection.diffDigest}. Continue?`,
    defaultValue: true,
  })) throw wizardError("automatic labels were not accepted");
  return { selection, options };
}

async function collectRequest(
  invocation: CliInvocation,
  catalogValue: WizardCatalog,
  console: WizardConsole,
  editor: WizardLongFormEditor,
  workItemSelection: WorkItemSelection,
): Promise<CollectedRequest> {
  const catalog = validateCatalog(catalogValue);
  if (catalog.issueIid !== workItemSelection.iid) {
    throw wizardError("wizard context issue binding changed");
  }
  const updateConfirmations = await confirmInteractiveUpdate(invocation, catalog, console);
  const profiles = await explicitOrSelectedProfiles(invocation, catalog, console);
  const profileIds = profiles.map((profile) => profile.id);
  const intent = await chooseOne(console, "intent", "Select merge request intent", ["draft", "ready"] as const, String);
  const automaticLabels = await collectAutomaticLabels(invocation, catalog, intent, console);
  const titleType = automaticLabels.selection.titleType;
  const module = invocation.options.module ?? await console.text({ id: "title.module", prompt: "Enter title module" });
  const titleSummary = invocation.options.titleSummary ?? await console.text({
    id: "title.titleSummary",
    prompt: "Enter title summary",
  });
  const impactAreas = await chooseMany(
    console,
    "impact.areaIds",
    "Select impact areas",
    catalog.impactAreas,
    (entry) => entry.label,
    0,
  );
  const impactNature = await chooseOne(
    console,
    "impact.nature",
    "Select impact nature",
    ["functional", "non-functional", "docs-only"] as const,
    String,
  );
  const selectedVerification = await chooseMany(
    console,
    "verification.itemIds",
    "Select verification items",
    catalog.verificationItems,
    (entry) => entry.label,
    0,
  );
  const selectedDocumentation = await chooseMany(
    console,
    "documentation.itemIds",
    "Select documentation items",
    catalog.documentationItems,
    (entry) => entry.label,
    0,
  );
  const riskLevel = await chooseOne(
    console,
    "risk.level",
    "Select risk level",
    ["low", "medium", "high"] as const,
    String,
  );
  const assignees = catalog.userCandidates.filter((candidate) => candidate.kind === "assignee");
  const assigneeOptions = [null, ...assignees] as const;
  const defaultAssignee = Math.max(0, assignees.findIndex((candidate) => candidate.defaultSelected) + 1);
  const assignee = await chooseOne(
    console,
    "assignee",
    "Select assignee",
    assigneeOptions,
    (candidate) => candidate === null ? "None" : `${candidate.displayName} (@${candidate.username})`,
    defaultAssignee,
  );
  const reviewers = catalog.userCandidates.filter((candidate) => candidate.kind === "reviewer");
  const selectedReviewers = await chooseMany(
    console,
    "reviewers",
    "Select reviewers",
    reviewers,
    (candidate) => `${candidate.displayName} (@${candidate.username})`,
    0,
    reviewers.length,
    reviewers.flatMap((candidate, index) => candidate.currentlyApplied ? [index] : []),
  );
  const removeSourceBranch = await console.confirm({
    id: "mergeRequest.removeSourceBranch",
    prompt: "Remove source branch after merge",
    defaultValue: true,
  });
  const squash = await console.confirm({
    id: "mergeRequest.squash",
    prompt: "Squash commits",
    defaultValue: true,
  });
  const selectedProfileFields = catalog.profileFields.filter((field) => profileIds.includes(field.profileId));
  const initial = Buffer.from(stringifyYaml(
    emptyLongForm(selectedVerification.length, selectedProfileFields.length),
    { lineWidth: 0 },
  ), "utf8");
  const parsed = parseLongForm(await editor.edit({ initialBytes: initial }));
  const workItem = workItemSelection.relation === "none"
    ? { relation: workItemSelection.relation, noIssueReason: parsed.noIssueReason }
    : { relation: workItemSelection.relation, iid: workItemSelection.iid };
  const request = {
    schemaVersion: 1,
    contextId: catalog.contextId,
    intent,
    profileIds,
    targetBranch: catalog.targetBranch,
    title: { type: titleType, module, titleSummary },
    changes: parsed.changes as JsonObject,
    motivation: parsed.motivation as JsonObject,
    workItem,
    impact: {
      areaIds: impactAreas.map((entry) => entry.id),
      nature: impactNature,
      details: parsed.impact.details,
    },
    verification: {
      items: verificationItems(parsed, selectedVerification),
      acceptanceEvidence: parsed.verification.acceptanceEvidence,
      knownGaps: parsed.verification.knownGaps,
    },
    documentation: {
      itemIds: selectedDocumentation.map((entry) => entry.id),
      details: parsed.documentation.details,
    },
    risk: {
      level: riskLevel,
      items: parsed.risk.items,
      compatibilityImpact: parsed.risk.compatibilityImpact,
      rollbackPlan: parsed.risk.rollbackPlan,
    },
    profileFields: profileFields(parsed, selectedProfileFields),
    review: {
      reviewerCandidateTokens: selectedReviewers.map((candidate) => candidate.token),
      reviewerFocus: parsed.review.reviewerFocus,
      additionalNotes: parsed.review.additionalNotes,
    },
    mergeRequest: {
      assigneeCandidateToken: assignee?.token ?? null,
      labelCandidateTokens: [],
      removeSourceBranch,
      squash,
    },
  } as JsonObject;
  return { request, labelOptions: automaticLabels.options, updateConfirmations };
}

export function createInteractiveRequestWizard(
  options: InteractiveRequestWizardOptions,
): InteractiveRequestWizard {
  const console = guardedConsole(options.console);
  const editor: WizardLongFormEditor = Object.freeze({
    edit: (input: Parameters<WizardLongFormEditor["edit"]>[0]) =>
      callWizardPort("editor", async () => options.editor.edit(input)),
  });
  return Object.freeze({
    collect: async ({ invocation }: Parameters<InteractiveRequestWizard["collect"]>[0]) => {
      clearWizardLabelOptions(invocation);
      recordWizardUpdateConfirmations(invocation, null);
      let collected: CollectedRequest;
      try {
        const workItem = await collectWorkItem(console);
        collected = await collectRequest(
          invocation,
          await callWizardPort("catalog", async () =>
            options.catalogSource.load({ invocation, issueIid: workItem.iid })),
          console,
          editor,
          workItem,
        );
        // Do not publish decisions from an invalid editor document.
        normalizeProductionRequest(collected.request);
      } finally {
        await console.close?.();
      }
      recordWizardLabelOptions(invocation, collected.labelOptions);
      recordWizardUpdateConfirmations(invocation, collected.updateConfirmations);
      return collected.request;
    },
  });
}

// This exported alias keeps the transport port discoverable without exposing process stdin.
export type WizardInputIo = Pick<InputIo, "readFile" | "statFile">;
