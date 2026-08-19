import type { BigIntStats } from "node:fs";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  ProcessLockError,
  systemProcessLockProvider,
  type ProcessLockLease,
  type ProcessLockProvider,
} from "./process-lock.ts";

export interface UpdateLockOptions {
  readonly timeoutMs?: number;
  readonly provider?: ProcessLockProvider;
}

// Cache mutations may be invoked by the activation transaction while its
// outer lock is already held.  The binding is kept private to this module so
// a structurally similar object cannot forge an in-lock capability.
const activeLeaseRoots = new WeakMap<object, string>();

export function assertUpdateLockLease(
  lease: ProcessLockLease,
  stateDirectory: string,
): void {
  if (lease === null || typeof lease !== "object") {
    throw new ProcessLockError("unsafe");
  }
  const root = activeLeaseRoots.get(lease as object);
  if (root === undefined || pathKey(root) !== pathKey(stateDirectory)) {
    throw new ProcessLockError("unsafe");
  }
  lease.assertHeld();
}

function pathKey(path: string): string {
  const normalized = resolve(path);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function assertNoLinkedAncestors(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    try {
      const item = await lstat(current);
      const physical = await realpath(current);
      if (item.isSymbolicLink() || pathKey(physical) !== pathKey(current)) {
        throw new ProcessLockError("unsafe");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error instanceof ProcessLockError ? error : new ProcessLockError("unsafe");
      }
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function assertPlainStateDirectory(path: string): Promise<BigIntStats> {
  try {
    const before = await lstat(path, { bigint: true }) as BigIntStats;
    const physical = await realpath(path);
    const after = await lstat(path, { bigint: true }) as BigIntStats;
    if (before.isSymbolicLink() || !before.isDirectory() || after.isSymbolicLink() ||
        !after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino ||
        pathKey(physical) !== pathKey(path)) {
      throw new ProcessLockError("unsafe");
    }
    return before;
  } catch (error) {
    throw error instanceof ProcessLockError ? error : new ProcessLockError("unsafe");
  }
}

export async function withUpdateLock<T>(
  stateDirectory: string,
  callback: (lease: ProcessLockLease) => Promise<T>,
  options: UpdateLockOptions = {},
): Promise<T> {
  if (typeof stateDirectory !== "string" || stateDirectory.trim() === "" ||
      typeof callback !== "function") {
    throw new ProcessLockError("unsafe");
  }
  const root = resolve(stateDirectory);
  const provider = options.provider ?? systemProcessLockProvider;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new ProcessLockError("unsafe");
  }
  try {
    await assertNoLinkedAncestors(root);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await assertNoLinkedAncestors(root);
  } catch (error) {
    throw error instanceof ProcessLockError ? error : new ProcessLockError("unsafe");
  }
  const rootIdentity = await assertPlainStateDirectory(root);
  const lease = await provider.acquire(resolve(root, ".update.lock"), timeoutMs);
  activeLeaseRoots.set(lease as object, root);
  try {
    const currentRoot = await assertPlainStateDirectory(root);
    if (rootIdentity.dev !== currentRoot.dev || rootIdentity.ino !== currentRoot.ino) {
      throw new ProcessLockError("unsafe");
    }
    lease.assertHeld();
    return await callback(lease);
  } finally {
    activeLeaseRoots.delete(lease as object);
    await lease.release();
  }
}
