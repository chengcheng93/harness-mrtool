import { createHash, randomBytes } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { canonicalizeJson } from "../contracts/jcs.ts";
import { parseStrictJson } from "../input/strict-json.ts";
import {
  validateReleaseSetRecord,
  type ReleaseSetRecord,
} from "./cache.ts";

export const ACTIVATION_JOURNAL_VERSION = 1 as const;
export const MAX_ACTIVATION_JOURNAL_BYTES = 64 * 1024;
export const ACTIVATION_PHASES = ["staging", "committed"] as const;
export type ActivationPhase = (typeof ACTIVATION_PHASES)[number];
export type ReleaseSetTuple = ReleaseSetRecord;

export interface ActivationJournal {
  readonly journalVersion: 1;
  readonly phase: ActivationPhase;
  readonly transactionId: string;
  readonly previous: ReleaseSetRecord | null;
  readonly next: ReleaseSetRecord;
}

const JOURNAL_FIELDS = ["journalVersion", "phase", "transactionId", "previous", "next"] as const;

function securityFailure(message = "activation journal is invalid"): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", message, {
    field: "activationJournal",
    expected: "a bounded canonical activation journal",
    actual: "invalid",
    safeNextStep: "Run self-update repair.",
  });
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) throw securityFailure();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw securityFailure();
  }
  if (keys.some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !descriptor.enumerable || !("value" in descriptor) ||
      descriptor.get !== undefined || descriptor.set !== undefined;
  })) throw securityFailure();
  return value as Record<string, unknown>;
}

export function validateActivationJournal(value: unknown): ActivationJournal {
  const item = exactRecord(value, JOURNAL_FIELDS);
  if (item.journalVersion !== 1 || typeof item.phase !== "string" ||
      !(ACTIVATION_PHASES as readonly string[]).includes(item.phase)) throw securityFailure();
  const next = validateReleaseSetRecord(item.next);
  const previous = item.previous === null ? null : validateReleaseSetRecord(item.previous);
  if (item.transactionId !== next.transactionId) throw securityFailure();
  return Object.freeze({
    journalVersion: 1,
    phase: item.phase as ActivationPhase,
    transactionId: next.transactionId,
    previous,
    next,
  });
}

export function canonicalActivationJournal(value: ActivationJournal): string {
  try {
    return `${canonicalizeJson(validateActivationJournal(value))}\n`;
  } catch (error) {
    throw error instanceof ToolError ? error : securityFailure();
  }
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

async function readBounded(path: string): Promise<Uint8Array | null> {
  let before: BigIntStats;
  try {
    before = await lstat(path, { bigint: true }) as BigIntStats;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw securityFailure();
  }
  if (before.isSymbolicLink() || !before.isFile() || before.size < 1n ||
      before.size > BigInt(MAX_ACTIVATION_JOURNAL_BYTES)) throw securityFailure();
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let primary: unknown;
  try {
    handle = await open(path, "r");
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!opened.isFile() || !sameIdentity(before, opened)) throw securityFailure();
    const result = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < result.byteLength) {
      const chunk = await handle.read(result, offset, result.byteLength - offset, offset);
      if (chunk.bytesRead <= 0) throw securityFailure();
      offset += chunk.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, result.byteLength)).bytesRead !== 0) throw securityFailure();
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const current = await lstat(path, { bigint: true }) as BigIntStats;
    if (current.isSymbolicLink() || !sameIdentity(opened, after) || !sameIdentity(opened, current)) {
      throw securityFailure();
    }
    return result;
  } catch (error) {
    primary = error;
    throw error instanceof ToolError ? error : securityFailure();
  } finally {
    try {
      await handle?.close();
    } catch {
      if (primary === undefined) throw securityFailure();
    }
  }
}

async function syncDirectory(path: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, "r");
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EPERM") throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function writeActivationJournal(path: string, journal: ActivationJournal): Promise<void> {
  const bytes = new TextEncoder().encode(canonicalActivationJournal(journal));
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp.${randomBytes(12).toString("hex")}`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.write(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesWritten <= 0) throw securityFailure();
      offset += result.bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error instanceof ToolError ? error : securityFailure();
  }
}

export async function readActivationJournal(path: string): Promise<ActivationJournal | null> {
  const bytes = await readBounded(path);
  if (bytes === null) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const journal = validateActivationJournal(parseStrictJson(text));
    if (text !== canonicalActivationJournal(journal)) throw securityFailure();
    return journal;
  } catch (error) {
    throw error instanceof ToolError ? error : securityFailure();
  }
}

export async function removeActivationJournal(path: string): Promise<void> {
  try {
    await rm(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw securityFailure("activation journal cleanup failed");
  }
}

export function tupleDigest(tuple: ReleaseSetRecord): string {
  return createHash("sha256").update(canonicalizeJson(validateReleaseSetRecord(tuple))).digest("hex");
}
