import type { LoadedTemplateBundle } from "../bundle/load.ts";
import { composeProfiles, type ProfileId } from "../bundle/compose.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";

export type ProjectTemplateProfile = "general" | "code" | "docs" | "ops";

interface CheckboxEntry {
  readonly id: string;
  readonly label: string;
  readonly sectionSlot: string;
  readonly kind: string;
  readonly applicableProfiles: readonly string[];
  readonly order: number;
}

interface FieldEntry {
  readonly id: string;
  readonly h3: string;
  readonly sectionSlot: string;
  readonly order: number;
}

function projectionError(reason: string): ToolError<"RENDER_ERROR"> {
  return new ToolError("RENDER_ERROR", `GitLab project template projection failed: ${reason}`, {
    field: "profile",
    expected: "exactly one of general, code, docs, or ops",
    actual: reason,
    safeNextStep: "Select one supported project template Profile and retry the export.",
  });
}

function asObject(value: JsonValue | undefined, subject: string): JsonObject {
  if (value === undefined || value === null || typeof value !== "object" || Array.isArray(value)) {
    throw projectionError(`${subject} must be an object`);
  }
  return value;
}

function checkboxEntries(bundle: LoadedTemplateBundle): readonly CheckboxEntry[] {
  const value = asObject(bundle.registries.checkboxes, "checkbox registry").checkboxes;
  if (!Array.isArray(value)) {
    throw projectionError("checkbox registry is missing");
  }
  return value.map((item) => {
    const entry = asObject(item, "checkbox entry");
    if (typeof entry.id !== "string" || typeof entry.label !== "string" ||
        typeof entry.sectionSlot !== "string" || typeof entry.kind !== "string" ||
        !Array.isArray(entry.applicableProfiles) ||
        entry.applicableProfiles.some((profile) => typeof profile !== "string") ||
        !Number.isSafeInteger(entry.order)) {
      throw projectionError("checkbox registry entry is invalid");
    }
    return {
      id: entry.id,
      label: entry.label,
      sectionSlot: entry.sectionSlot,
      kind: entry.kind,
      applicableProfiles: entry.applicableProfiles as string[],
      order: entry.order as number,
    };
  }).sort((left, right) => left.order - right.order);
}

function fieldEntries(bundle: LoadedTemplateBundle): readonly FieldEntry[] {
  const value = asObject(bundle.registries.fields, "field registry").fields;
  if (!Array.isArray(value)) {
    throw projectionError("field registry is missing");
  }
  return value.map((item) => {
    const entry = asObject(item, "field entry");
    if (typeof entry.id !== "string" || typeof entry.h3 !== "string" ||
        typeof entry.sectionSlot !== "string" || !Number.isSafeInteger(entry.order)) {
      throw projectionError("field registry entry is invalid");
    }
    return {
      id: entry.id,
      h3: entry.h3,
      sectionSlot: entry.sectionSlot,
      order: entry.order as number,
    };
  }).sort((left, right) => left.order - right.order);
}

function unchecked(entries: readonly CheckboxEntry[], slot: string): string {
  return entries.filter((entry) => entry.sectionSlot === slot)
    .map((entry) => `- [ ] ${entry.label}`)
    .join("\n");
}

function profileSlots(
  fields: readonly FieldEntry[],
  requiredIds: readonly string[],
): Readonly<Record<string, string>> {
  const slots: Record<string, string[]> = {
    changes: [], motivation: [], impact: [], documentation: [], risk: [],
  };
  for (const field of fields.filter((entry) => requiredIds.includes(entry.id))) {
    slots[field.sectionSlot]?.push(`### ${field.h3}\n\n- _Enter ${field.h3.toLowerCase()}._`);
  }
  return Object.fromEntries(Object.entries(slots).map(([slot, values]) => [slot, values.join("\n\n")]));
}

function replaceLayout(layout: string, replacements: Readonly<Record<string, string>>): string {
  let result = layout;
  for (const [id, value] of Object.entries(replacements)) {
    result = result.replace(`{{${id}}}`, value);
  }
  if (/\{\{[^{}]+\}\}/u.test(result)) {
    throw projectionError("layout contains an unresolved placeholder");
  }
  return `${result.replace(/\r\n?/gu, "\n").replace(/\n{3,}/gu, "\n\n").trimEnd()}\n`;
}

export function renderProjectTemplate(
  profileValue: ProjectTemplateProfile | string,
  bundleValue: LoadedTemplateBundle | unknown,
): string {
  try {
    if (!["general", "code", "docs", "ops"].includes(profileValue)) {
      throw projectionError("unsupported or combined Profile");
    }
    const bundle = copyJsonValue(bundleValue) as unknown as LoadedTemplateBundle;
    validateTemplateBundle(bundle);
    const profile = profileValue as ProfileId;
    const composition = composeProfiles(bundle, [profile]);
    const entries = checkboxEntries(bundle);
    const fields = profileSlots(fieldEntries(bundle), composition.requiredFieldIds);
    const verificationIds = profile === "general"
      ? entries.filter((entry) => entry.kind === "evidence-state" &&
          entry.applicableProfiles.includes("general")).map((entry) => entry.id)
      : composition.requiredCheckboxIds;
    const verification = entries.filter((entry) => verificationIds.includes(entry.id));
    const rows = verification.length === 0
      ? "| None | Not applicable | Not run | No evidence |"
      : verification.map((entry) =>
        `| ${entry.label} | _Enter command or method._ | _Enter result or status._ | _Enter evidence or reason._ |`).join("\n");
    return replaceLayout(bundle.layout.markdown, {
      "changes.summary": "- _Enter the change summary._",
      "changes.technicalChanges": "- _Enter technical changes, or `None.`._",
      "changes.outOfScope": "None.",
      "profileFields.changes": fields.changes ?? "",
      "motivation.background": "- _Enter the background._",
      "motivation.whyNeeded": "- _Enter why this change is needed._",
      "profileFields.motivation": fields.motivation ?? "",
      "workItem.canonicalRelationLines": "- Relation: _Enter `Closes #<iid>`, `Related #<iid>`, or `None`._\n- Reason: _Required when Relation is `None`._",
      "issueSnapshot.milestone": "_Enter current Issue snapshot value._",
      "issueSnapshot.assignees": "_Enter current Issue snapshot value._",
      "issueSnapshot.dueDate": "_Enter current Issue snapshot value._",
      "issueSnapshot.labels": "_Enter current Issue snapshot value._",
      "mergeRequest.labels": "_Select labels from the target project._",
      "impact.checkboxes": `${unchecked(entries, "impact.area")}\n${unchecked(entries, "impact.nature")}`,
      "impact.details": "- _Enter impact details._",
      "profileFields.impact": fields.impact ?? "",
      "verification.checkboxes": verification.map((entry) => `- [ ] ${entry.label}`).join("\n"),
      "verification.rows": rows,
      "verification.acceptanceEvidence": "- _Enter acceptance evidence._",
      "verification.knownGaps": "None.",
      "documentation.checkboxes": unchecked(entries, "documentation"),
      "documentation.details": "- _Enter documentation details, or `None.`._",
      "profileFields.documentation": fields.documentation ?? "",
      "risk.levelCheckboxes": unchecked(entries, "risk.level"),
      "risk.items": "- _Enter risks._",
      "risk.compatibilityImpact": "- _Enter compatibility impact._",
      "risk.rollbackPlan": "- _Enter the rollback plan._",
      "profileFields.risk": fields.risk ?? "",
      "review.checkboxes": unchecked(entries, "review"),
      "review.reviewerFocus": "- _Enter reviewer focus._",
      "review.additionalNotes": "None.",
      diagnosticMarker: "",
    });
  } catch (error) {
    if (isToolError(error, "RENDER_ERROR")) {
      throw error;
    }
    throw projectionError("Bundle or projection data is invalid");
  }
}
