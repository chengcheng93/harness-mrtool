import { extname, matchesGlob } from "node:path";

import { copyJsonValue, type JsonObject, type JsonValue } from "../contracts/jcs.ts";
import {
  COMPOSABLE_PROFILE_ORDER,
  type ProfileId,
} from "./compose.ts";
import type { LoadedTemplateBundle } from "./load.ts";

export type DiffStatus = "added" | "modified" | "deleted" | "renamed";

interface DiffItemCommon {
  readonly binary: boolean;
  readonly submodule: boolean;
}

export type DiffItem =
  | (DiffItemCommon & {
      readonly status: "added" | "modified";
      readonly newPath: string;
    })
  | (DiffItemCommon & {
      readonly status: "deleted";
      readonly oldPath: string;
    })
  | (DiffItemCommon & {
      readonly status: "renamed";
      readonly oldPath: string;
      readonly newPath: string;
    });

export type ProfileDetectionReason =
  | "empty-diff"
  | "invalid-change-set"
  | "invalid-item"
  | "unsupported-status"
  | "invalid-path"
  | "binary"
  | "submodule"
  | "unknown-path"
  | "general-mixed"
  | "invalid-rules";

export type ProfileDetectionResult =
  | {
      readonly kind: "detected";
      readonly profileIds: readonly ProfileId[];
    }
  | {
      readonly kind: "ambiguous";
      readonly reason: ProfileDetectionReason;
      readonly itemIndex: number | null;
    };

interface ProfileRules {
  readonly paths: readonly string[];
  readonly extensions: readonly string[];
}

const STATUS_FIELDS = {
  added: ["binary", "newPath", "status", "submodule"],
  modified: ["binary", "newPath", "status", "submodule"],
  deleted: ["binary", "oldPath", "status", "submodule"],
  renamed: ["binary", "newPath", "oldPath", "status", "submodule"],
} as const;
const PROFILE_ORDER = [...COMPOSABLE_PROFILE_ORDER, "general"] as const;

function ambiguous(
  reason: ProfileDetectionReason,
  itemIndex: number | null,
): ProfileDetectionResult {
  return Object.freeze({ kind: "ambiguous", reason, itemIndex });
}

function detected(profileIds: readonly ProfileId[]): ProfileDetectionResult {
  return Object.freeze({
    kind: "detected",
    profileIds: Object.freeze([...profileIds]),
  });
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function asUniqueStrings(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    return null;
  }
  const strings = value as string[];
  return new Set(strings).size === strings.length ? strings : null;
}

function readRules(bundle: JsonValue): ReadonlyMap<ProfileId, ProfileRules> | null {
  const root = asRecord(bundle);
  const profiles = root === null ? null : asRecord(root.profiles);
  if (profiles === null) {
    return null;
  }
  const result = new Map<ProfileId, ProfileRules>();
  for (const id of PROFILE_ORDER) {
    const profile = asRecord(profiles[id]);
    const matchRules = profile === null ? null : asRecord(profile.matchRules);
    const paths = matchRules === null ? null : asUniqueStrings(matchRules.paths);
    const extensions = matchRules === null ? null : asUniqueStrings(matchRules.extensions);
    if (
      profile?.id !== id ||
      paths === null ||
      paths.length === 0 ||
      extensions === null ||
      [...paths, ...extensions].some((rule) => rule === "" || rule !== rule.trim())
    ) {
      return null;
    }
    result.set(id, { paths, extensions });
  }
  return result;
}

function normalizePath(value: string): string | null {
  if (
    value === "" ||
    /[\u0000-\u001f\u007f\u2028\u2029]/u.test(value) ||
    /^[a-z]:[\\/]/iu.test(value)
  ) {
    return null;
  }
  const normalized = value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.endsWith("/") ||
    normalized.includes("//")
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return normalized.toLowerCase();
}

function classifyPath(
  path: string,
  rules: ReadonlyMap<ProfileId, ProfileRules>,
): readonly ProfileId[] {
  const extension = extname(path).toLowerCase();
  return PROFILE_ORDER.filter((id) => {
    const rule = rules.get(id);
    if (rule === undefined) {
      return false;
    }
    return rule.paths.some((glob) => matchesGlob(path, glob.toLowerCase())) ||
      rule.extensions.some((candidate) => candidate.toLowerCase() === extension);
  });
}

function readItem(
  value: JsonValue,
): { readonly item: DiffItem } | { readonly reason: ProfileDetectionReason } {
  const record = asRecord(value);
  if (record === null) {
    return { reason: "invalid-item" };
  }
  if (typeof record.status !== "string") {
    return { reason: "invalid-item" };
  }
  if (!["added", "modified", "deleted", "renamed"].includes(record.status)) {
    return { reason: "unsupported-status" };
  }
  const status = record.status as DiffStatus;
  const keys = Object.keys(record).sort();
  const expectedFields = STATUS_FIELDS[status];
  if (
    keys.length !== expectedFields.length ||
    keys.some((key, index) => key !== expectedFields[index]) ||
    typeof record.binary !== "boolean" ||
    typeof record.submodule !== "boolean"
  ) {
    return { reason: "invalid-item" };
  }
  if (status === "added" || status === "modified") {
    return typeof record.newPath === "string"
      ? { item: { status, newPath: record.newPath, binary: record.binary, submodule: record.submodule } }
      : { reason: "invalid-item" };
  }
  if (status === "deleted") {
    return typeof record.oldPath === "string"
      ? { item: { status, oldPath: record.oldPath, binary: record.binary, submodule: record.submodule } }
      : { reason: "invalid-item" };
  }
  return typeof record.oldPath === "string" && typeof record.newPath === "string"
    ? {
        item: {
          status,
          oldPath: record.oldPath,
          newPath: record.newPath,
          binary: record.binary,
          submodule: record.submodule,
        },
      }
    : { reason: "invalid-item" };
}

function pathsForItem(item: DiffItem): readonly string[] {
  switch (item.status) {
    case "added":
      return [item.newPath];
    case "deleted":
      return [item.oldPath];
    case "renamed":
      return [item.oldPath, item.newPath];
    case "modified":
      return [item.newPath];
  }
}

function detect(bundle: JsonValue, changeSet: JsonValue): ProfileDetectionResult {
  const rules = readRules(bundle);
  if (rules === null) {
    return ambiguous("invalid-rules", null);
  }
  if (!Array.isArray(changeSet)) {
    return ambiguous("invalid-change-set", null);
  }
  if (changeSet.length === 0) {
    return ambiguous("empty-diff", null);
  }

  const aggregate = new Set<ProfileId>();
  for (const [index, value] of changeSet.entries()) {
    const parsed = readItem(value);
    if (!("item" in parsed)) {
      return ambiguous(parsed.reason, index);
    }
    const item = parsed.item;
    if (item.submodule) {
      return ambiguous("submodule", index);
    }
    if (item.binary) {
      return ambiguous("binary", index);
    }

    const itemProfiles = new Set<ProfileId>();
    for (const rawPath of pathsForItem(item)) {
      const path = normalizePath(rawPath);
      if (path === null) {
        return ambiguous("invalid-path", index);
      }
      const classified = classifyPath(path, rules);
      if (classified.length === 0) {
        return ambiguous("unknown-path", index);
      }
      for (const profileId of classified) {
        itemProfiles.add(profileId);
      }
    }
    for (const profileId of itemProfiles) {
      aggregate.add(profileId);
    }
    if (aggregate.has("general") && aggregate.size > 1) {
      return ambiguous("general-mixed", index);
    }
  }

  const profileIds = PROFILE_ORDER.filter((id) => aggregate.has(id));
  return profileIds.length === 0
    ? ambiguous("unknown-path", null)
    : detected(profileIds);
}

export function detectProfiles(
  bundle: LoadedTemplateBundle | unknown,
  changeSet: unknown,
): ProfileDetectionResult {
  try {
    return detect(copyJsonValue(bundle), copyJsonValue(changeSet));
  } catch {
    return ambiguous("invalid-change-set", null);
  }
}
