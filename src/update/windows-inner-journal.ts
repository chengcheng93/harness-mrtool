import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { samePhysicalPath } from "../platform/windows-path.ts";
import { decodeWindowsMutationPlan, encodeWindowsMutationPlan, type WindowsMutationPlan } from "./windows-mutation-plan.ts";

export const WINDOWS_INNER_JOURNAL_FILENAME = "installation-transaction.json" as const;
const MAX_BYTES = 16 * 1024;
const NOFOLLOW = (constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

export interface WindowsInnerJournalObservation {
  readonly plan: WindowsMutationPlan;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly identity: { readonly dev: string; readonly ino: string };
}

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Windows inner journal is not coherent", {
    field: "update.windowsInnerJournal",
    expected: "the exact bounded native transaction plan in the fixed private slot",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function absoluteRoot(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") ||
      !isAbsolute(value) || resolve(value) !== value) throw failure("unsafe-root");
  return value;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readFixedFile(path: string): Promise<{ readonly bytes: Uint8Array; readonly stat: BigIntStats }> {
  let handle;
  try {
    const namedBefore = await lstat(path, { bigint: true }) as BigIntStats;
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1n || namedBefore.size < 1n || namedBefore.size > BigInt(MAX_BYTES)) {
      throw failure("unsafe-inner-journal-file");
    }
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || !sameIdentity(namedBefore, opened)) {
      throw failure("inner-journal-identity-changed");
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead <= 0) throw failure("inner-journal-truncated");
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) throw failure("inner-journal-grew");
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const namedAfter = await lstat(path, { bigint: true }) as BigIntStats;
    if (!sameIdentity(opened, after) || after.nlink !== 1n || namedAfter.isSymbolicLink() ||
        namedAfter.nlink !== 1n || !sameIdentity(opened, namedAfter)) {
      throw failure("inner-journal-raced");
    }
    return Object.freeze({ bytes: Uint8Array.from(bytes), stat: opened });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("inner-journal-read");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function assertSafeInstallationRoot(root: string): Promise<void> {
  const rootBefore = await lstat(root, { bigint: true }) as BigIntStats;
  const physical = await realpath(root);
  const rootAfter = await lstat(root, { bigint: true }) as BigIntStats;
  if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !rootAfter.isDirectory() || rootAfter.isSymbolicLink() ||
      !samePhysicalPath(physical, root) || !sameIdentity(rootBefore, rootAfter)) {
    throw failure("unsafe-installation-root");
  }
}

/** Validate the fixed managed root before any native mutation is admitted. */
export async function validateWindowsInstallationRoot(installationDirectory: string): Promise<void> {
  const root = absoluteRoot(installationDirectory);
  try {
    await assertSafeInstallationRoot(root);
  } catch (error) {
    throw error instanceof ToolError ? error : failure("unsafe-installation-root");
  }
}

/**
 * Re-observes the fixed native transaction slot and binds it to the expected
 * plan. This is evidence only; it neither publishes canonical files nor
 * changes the outer journal.
 */
export async function observeWindowsInnerJournal(
  installationDirectory: string,
  expectedPlan: WindowsMutationPlan,
): Promise<WindowsInnerJournalObservation> {
  const root = absoluteRoot(installationDirectory);
  try {
    await assertSafeInstallationRoot(root);
    const expected = encodeWindowsMutationPlan(expectedPlan);
    const file = await readFixedFile(resolve(root, WINDOWS_INNER_JOURNAL_FILENAME));
    if (file.bytes.length !== expected.length || file.bytes.some((byte, index) => byte !== expected[index])) {
      throw failure("inner-journal-plan-mismatch");
    }
    const plan = decodeWindowsMutationPlan(file.bytes);
    return Object.freeze({
      plan,
      bytes: file.bytes,
      sha256: createHash("sha256").update(file.bytes).digest("hex"),
      size: file.bytes.length,
      identity: Object.freeze({ dev: String(file.stat.dev), ino: String(file.stat.ino) }),
    });
  } catch (error) {
    throw error instanceof ToolError ? error : failure("inner-journal-observation-failed");
  }
}
