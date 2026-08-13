import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { DiffItem } from "../bundle/detect-profile.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  assertObjectId,
  type RepositorySnapshot,
  readGitText,
  runGitChecked,
} from "./repository.ts";

interface RawDiffRecord {
  readonly binary: boolean;
  readonly newMode: string;
  readonly newPath: string | null;
  readonly oldMode: string;
  readonly oldPath: string | null;
  readonly status: "A" | "D" | "M" | "R";
}

export interface CanonicalChangeSet {
  readonly items: readonly DiffItem[];
  readonly mergeBaseSha: string;
  readonly sourceHeadSha: string;
  readonly targetRefSha: string;
}

function changeSetError(message: string): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError("REPOSITORY_ERROR", `Cannot read canonical ChangeSet: ${message}`, {
    field: "changeSet",
    expected: "a complete NUL-delimited committed Git diff",
    actual: "malformed or unsupported Git diff",
    safeNextStep: "Inspect the committed diff and repository history with Git, then retry.",
  });
}

async function assertDeterministicAttributes(
  repository: RepositorySnapshot,
): Promise<void> {
  let configuredAttributes;
  try {
    configuredAttributes = await repository.runner.run([
      "config",
      "--null",
      "--get-all",
      "core.attributesFile",
    ]);
  } catch (error) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Cannot read canonical ChangeSet: Git attribute configuration is unavailable",
      {
        field: "changeSet.attributes",
        expected: "no configured core.attributesFile",
        actual: "Git process failure",
        safeNextStep: "Inspect Git attribute configuration and retry.",
      },
      error,
    );
  }
  if (configuredAttributes.timedOut ||
      ![0, 1].includes(configuredAttributes.exitCode ?? -1)) {
    throw changeSetError("Git attribute configuration could not be read");
  }
  if (configuredAttributes.exitCode === 0) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Cannot read canonical ChangeSet: core.attributesFile may alter committed diff classification",
      {
        field: "changeSet.attributes",
        expected: "core.attributesFile unset",
        actual: "configured",
        safeNextStep: "Unset core.attributesFile for this invocation and retry.",
      },
    );
  }
  if (configuredAttributes.stdout.length !== 0) {
    throw changeSetError("Git returned malformed attribute configuration output");
  }

  const infoAttributesPath = resolve(
    repository.root,
    await readGitText(
      repository.runner,
      ["rev-parse", "--git-path", "info/attributes"],
      "repository attribute override path",
    ),
  );
  let infoAttributes: Buffer;
  try {
    infoAttributes = await readFile(infoAttributesPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Cannot read canonical ChangeSet: repository attribute overrides are unreadable",
      {
        field: "changeSet.attributes",
        expected: "an absent or empty info/attributes file",
        actual: "unreadable",
        safeNextStep: "Inspect .git/info/attributes permissions and retry.",
      },
      error,
    );
  }
  if (infoAttributes.length !== 0) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Cannot read canonical ChangeSet: info/attributes may alter committed diff classification",
      {
        field: "changeSet.attributes",
        expected: "an absent or empty info/attributes file",
        actual: "non-empty",
        safeNextStep: "Remove repository-local attribute overrides and retry.",
      },
    );
  }
}

function decodePath(value: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch (error) {
    throw new ToolError(
      "REPOSITORY_ERROR",
      "Cannot read canonical ChangeSet: a path is not valid UTF-8",
      {
        field: "changeSet.path",
        expected: "valid UTF-8 Git path",
        actual: "invalid bytes",
        safeNextStep: "Rename the path to valid UTF-8 and retry.",
      },
      error,
    );
  }
}

function splitNul(buffer: Buffer): Buffer[] {
  const result: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      result.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.length) {
    throw changeSetError("Git output is missing a final NUL delimiter");
  }
  if (result.at(-1)?.length === 0) {
    result.pop();
  }
  return result;
}

function parseRawDiff(output: Buffer): RawDiffRecord[] {
  const fields = splitNul(output);
  const records: RawDiffRecord[] = [];
  for (let index = 0; index < fields.length;) {
    const headerBuffer = fields[index];
    if (headerBuffer === undefined) {
      throw changeSetError("raw diff header is missing");
    }
    const header = headerBuffer.toString("ascii");
    const match = /^:([0-7]{6}) ([0-7]{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d{0,3})$/u.exec(header);
    if (match === null) {
      throw changeSetError("raw diff header is malformed");
    }
    const oldMode = match[1];
    const newMode = match[2];
    const rawStatus = match[5];
    if (
      oldMode === undefined ||
      newMode === undefined ||
      rawStatus === undefined ||
      !["A", "D", "M", "R"].includes(rawStatus)
    ) {
      throw changeSetError(`diff status ${rawStatus ?? "unknown"} is unsupported`);
    }
    const status = rawStatus as RawDiffRecord["status"];
    const firstPath = fields[index + 1];
    if (firstPath === undefined) {
      throw changeSetError("raw diff path is missing");
    }
    if (status === "R") {
      const secondPath = fields[index + 2];
      if (secondPath === undefined) {
        throw changeSetError("rename destination is missing");
      }
      records.push({
        binary: false,
        oldMode,
        newMode,
        oldPath: decodePath(firstPath),
        newPath: decodePath(secondPath),
        status,
      });
      index += 3;
    } else {
      const path = decodePath(firstPath);
      records.push({
        binary: false,
        oldMode,
        newMode,
        oldPath: status === "D" ? path : null,
        newPath: status === "D" ? null : path,
        status,
      });
      index += 2;
    }
  }
  return records;
}

function numstatKey(oldPath: string | null, newPath: string | null): string {
  return `${oldPath ?? ""}\u0000${newPath ?? ""}`;
}

function parseNumstat(output: Buffer): Map<string, boolean> {
  const fields = splitNul(output);
  const result = new Map<string, boolean>();
  for (let index = 0; index < fields.length;) {
    const field = fields[index];
    if (field === undefined) {
      throw changeSetError("numstat record is missing");
    }
    const firstTab = field.indexOf(9);
    const secondTab = firstTab < 0 ? -1 : field.indexOf(9, firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) {
      throw changeSetError("numstat record is malformed");
    }
    const added = field.subarray(0, firstTab).toString("ascii");
    const deleted = field.subarray(firstTab + 1, secondTab).toString("ascii");
    const inlinePath = field.subarray(secondTab + 1);
    const binary = added === "-" && deleted === "-";
    if (!binary && (!/^\d+$/u.test(added) || !/^\d+$/u.test(deleted))) {
      throw changeSetError("numstat counts are malformed");
    }
    if (inlinePath.length === 0) {
      const oldField = fields[index + 1];
      const newField = fields[index + 2];
      if (oldField === undefined || newField === undefined) {
        throw changeSetError("numstat rename paths are missing");
      }
      const key = numstatKey(decodePath(oldField), decodePath(newField));
      if (result.has(key)) {
        throw changeSetError("numstat contains a duplicate path pair");
      }
      result.set(key, binary);
      index += 3;
    } else {
      const path = decodePath(inlinePath);
      const key = numstatKey(path, path);
      if (result.has(key)) {
        throw changeSetError("numstat contains a duplicate path");
      }
      result.set(key, binary);
      index += 1;
    }
  }
  return result;
}

function itemFor(record: RawDiffRecord, binary: boolean): DiffItem {
  const submodule = record.oldMode === "160000" || record.newMode === "160000";
  switch (record.status) {
    case "A":
      if (record.newPath === null) throw changeSetError("added path is missing");
      return Object.freeze({ status: "added", newPath: record.newPath, binary, submodule });
    case "M":
      if (record.newPath === null) throw changeSetError("modified path is missing");
      return Object.freeze({ status: "modified", newPath: record.newPath, binary, submodule });
    case "D":
      if (record.oldPath === null) throw changeSetError("deleted path is missing");
      return Object.freeze({ status: "deleted", oldPath: record.oldPath, binary, submodule });
    case "R":
      if (record.oldPath === null || record.newPath === null) {
        throw changeSetError("rename path is missing");
      }
      return Object.freeze({
        status: "renamed",
        oldPath: record.oldPath,
        newPath: record.newPath,
        binary,
        submodule,
      });
  }
}

function compareItems(left: DiffItem, right: DiffItem): number {
  const rank = { added: 0, modified: 1, deleted: 2, renamed: 3 } as const;
  const leftOld = "oldPath" in left ? left.oldPath : "";
  const rightOld = "oldPath" in right ? right.oldPath : "";
  const leftNew = "newPath" in left ? left.newPath : "";
  const rightNew = "newPath" in right ? right.newPath : "";
  return rank[left.status] - rank[right.status] ||
    Buffer.compare(Buffer.from(leftOld), Buffer.from(rightOld)) ||
    Buffer.compare(Buffer.from(leftNew), Buffer.from(rightNew));
}

export async function readCanonicalChangeSet(
  repository: RepositorySnapshot,
): Promise<CanonicalChangeSet> {
  await assertDeterministicAttributes(repository);
  const mergeBases = (await readGitText(
    repository.runner,
    ["merge-base", "--all", repository.targetRefSha, repository.sourceHeadSha],
    "merge base",
  )).split(/\r?\n/u).filter((value) => value !== "");
  if (mergeBases.length !== 1 || mergeBases[0] === undefined) {
    throw changeSetError("repository history does not have one unique merge base");
  }
  const mergeBaseSha = assertObjectId(mergeBases[0], "merge base");
  const commonArguments = [
    `--attr-source=${repository.sourceHeadSha}`,
    "-c",
    `core.attributesFile=${process.platform === "win32" ? "NUL" : "/dev/null"}`,
    "-c",
    "diff.renames=true",
    "-c",
    "diff.renameLimit=0",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames=50%",
    "--ignore-submodules=none",
  ] as const;
  const [raw, numstat] = await Promise.all([
    runGitChecked(
      repository.runner,
      [...commonArguments, "--raw", "-z", "--no-abbrev", mergeBaseSha, repository.sourceHeadSha, "--"],
      "raw committed diff",
    ),
    runGitChecked(
      repository.runner,
      [...commonArguments, "--numstat", "-z", mergeBaseSha, repository.sourceHeadSha, "--"],
      "numstat committed diff",
    ),
  ]);
  await assertDeterministicAttributes(repository);
  const rawRecords = parseRawDiff(raw);
  const binaryByPath = parseNumstat(numstat);
  const items = rawRecords.map((record) => {
    const key = record.status === "R"
      ? numstatKey(record.oldPath, record.newPath)
      : numstatKey(record.oldPath ?? record.newPath, record.oldPath ?? record.newPath);
    const binary = binaryByPath.get(key);
    if (binary === undefined) {
      throw changeSetError("raw and numstat diff records do not match");
    }
    binaryByPath.delete(key);
    return itemFor(record, binary);
  }).sort(compareItems);
  if (binaryByPath.size !== 0) {
    throw changeSetError("numstat contains records absent from raw diff");
  }
  return Object.freeze({
    items: Object.freeze(items),
    mergeBaseSha,
    sourceHeadSha: repository.sourceHeadSha,
    targetRefSha: repository.targetRefSha,
  });
}
