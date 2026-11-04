import { createHash, randomBytes } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { resolve } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import { writeAnchoredFile } from "../platform/anchored-file-writer.ts";
import { samePhysicalPath } from "../platform/windows-path.ts";
import { validateWindowsInstallationRoot } from "./windows-inner-journal.ts";
import { validateInstallationJournal, type InstallationJournal, type InstallationProcessIdentity } from "./installation-journal.ts";
import {
  decodeWindowsPersistenceDescriptor,
  encodeWindowsPersistenceDescriptor,
  type WindowsPersistenceDescriptor,
} from "./windows-persistence-descriptor.ts";
import type { WindowsLaunchReservationInput } from "./windows-installation-transition.ts";
import type { WindowsMutationPlan } from "./windows-mutation-plan.ts";

/** Fixed private slot used to hand one deferred Windows persistence operation to its helper. */
export const WINDOWS_LAUNCH_DESCRIPTOR_FILENAME = ".harness-mrtool-launch.json" as const;

function failure(actual: string): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Windows persistence handoff is unsafe", {
    field: "update.windowsHandoff",
    expected: "one journal-bound, path-free Windows persistence handoff",
    actual,
    safeNextStep: "Preserve the installation journal and run self-update repair.",
  });
}

function id(): string {
  return randomBytes(16).toString("hex");
}

function requireWindowsPreparedJournal(value: unknown): InstallationJournal {
  let journal: InstallationJournal;
  try {
    journal = validateInstallationJournal(value);
  } catch {
    throw failure("journal-invalid");
  }
  if (journal.platform !== "windows-x64" || journal.windows === null ||
      journal.phase !== "prepared" || journal.windows.inner === null || journal.windows.launch !== null ||
      journal.slots.some((slot) => slot.name === "launch-descriptor")) {
    throw failure("journal-not-ready-for-handoff");
  }
  return journal;
}

/** Create the bounded path-free native mutation intent bound to one prepared outer journal. */
export function createWindowsMutationPlan(value: unknown): WindowsMutationPlan {
  const journal = requireWindowsPreparedJournal(value);
  return Object.freeze({
    schemaVersion: 1 as const,
    operation: journal.operation,
    installationId: journal.installationId,
    enrollmentId: journal.enrollmentId,
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    journalRevision: journal.revision,
    authorityEpoch: journal.control.authorityEpoch + 1,
    previous: Object.freeze({
      executableSha256: journal.previousEvidence.native.sha256,
      executableSize: journal.previousEvidence.native.size,
      markerSha256: journal.previousEvidence.marker.sha256,
      markerSize: journal.previousEvidence.marker.size,
    }),
    next: Object.freeze({
      executableSha256: journal.nextEvidence.native.sha256,
      executableSize: journal.nextEvidence.native.size,
      markerSha256: journal.nextEvidence.marker.sha256,
      markerSize: journal.nextEvidence.marker.size,
    }),
  });
}

export interface WindowsPersistenceDescriptorDraft {
  readonly launchId: string;
  readonly reservationId: string;
  readonly descriptor: WindowsPersistenceDescriptor;
  readonly bytes: Uint8Array;
}

/** Create descriptor bytes before they are exclusively written and identity-observed. */
export function createWindowsPersistenceDescriptor(
  value: unknown,
  parent: InstallationProcessIdentity,
): WindowsPersistenceDescriptorDraft {
  const journal = requireWindowsPreparedJournal(value);
  if (parent === null || typeof parent !== "object" ||
      !Number.isSafeInteger(parent.pid) || parent.pid < 1 ||
      typeof parent.startKey !== "string" || !/^win:[1-9][0-9]{0,19}$/u.test(parent.startKey) ||
      typeof parent.launchNonce !== "string" || !/^[a-f0-9]{32}$/u.test(parent.launchNonce)) {
    throw failure("parent-identity-invalid");
  }
  const descriptor: WindowsPersistenceDescriptor = Object.freeze({
    schemaVersion: 1,
    launchId: id(),
    reservationId: id(),
    attemptId: journal.attemptId,
    transactionId: journal.transactionId,
    expectedRevision: journal.revision + 1,
    parent: Object.freeze({
      pid: parent.pid,
      startKey: parent.startKey,
      launchNonce: parent.launchNonce,
    }),
  });
  return Object.freeze({
    launchId: descriptor.launchId,
    reservationId: descriptor.reservationId,
    descriptor,
    bytes: encodeWindowsPersistenceDescriptor(descriptor),
  });
}

export function createWindowsLaunchReservationInput(
  value: unknown,
  parent: InstallationProcessIdentity,
  descriptor: WindowsPersistenceDescriptorDraft,
  identity: { readonly dev: string; readonly ino: string },
): WindowsLaunchReservationInput {
  const journal = requireWindowsPreparedJournal(value);
  if (descriptor === null || typeof descriptor !== "object" ||
      descriptor.launchId !== descriptor.descriptor.launchId ||
      descriptor.reservationId !== descriptor.descriptor.reservationId ||
      !(descriptor.bytes instanceof Uint8Array) ||
      identity === null || typeof identity !== "object" ||
      !/^(?:0|[1-9][0-9]{0,19})$/u.test(identity.dev) ||
      !/^[1-9][0-9]{0,19}$/u.test(identity.ino)) {
    throw failure("descriptor-observation-invalid");
  }
  if (descriptor.descriptor.attemptId !== journal.attemptId ||
      descriptor.descriptor.transactionId !== journal.transactionId ||
      descriptor.descriptor.expectedRevision !== journal.revision + 1) {
    throw failure("descriptor-journal-binding-mismatch");
  }
  return Object.freeze({
    launchId: descriptor.launchId,
    reservationId: descriptor.reservationId,
    descriptor: Object.freeze({
      identity: Object.freeze({ dev: identity.dev, ino: identity.ino }),
      sha256: createHash("sha256").update(descriptor.bytes).digest("hex"),
      size: descriptor.bytes.byteLength,
      bytes: Uint8Array.from(descriptor.bytes),
    }),
    parent: Object.freeze({ ...parent }),
  });
}



export interface WindowsPersistenceDescriptorObservation {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly size: number;
  readonly identity: { readonly dev: string; readonly ino: string };
}

/** Exclusively create the fixed descriptor file under the already validated root. */
export async function writeWindowsPersistenceDescriptor(
  installationDirectory: string,
  draft: WindowsPersistenceDescriptorDraft,
): Promise<void> {
  const root = await validateWindowsInstallationRoot(installationDirectory);
  await writeAnchoredFile({
    directory: installationDirectory,
    expectedIdentity: { dev: BigInt(root.dev), ino: BigInt(root.ino) },
    name: WINDOWS_LAUNCH_DESCRIPTOR_FILENAME,
    bytes: draft.bytes,
  });
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size;
}

/** Read the fixed descriptor with an identity-pinned, bounded observation. */
export async function observeWindowsPersistenceDescriptor(
  installationDirectory: string,
): Promise<WindowsPersistenceDescriptorObservation> {
  const root = await validateWindowsInstallationRoot(installationDirectory);
  const path = resolve(installationDirectory, WINDOWS_LAUNCH_DESCRIPTOR_FILENAME);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await lstat(path, { bigint: true }) as BigIntStats;
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size < 1n || before.size > 8n * 1024n) {
      throw failure("descriptor-file-invalid");
    }
    handle = await open(path, constants.O_RDONLY | ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
    const opened = await handle.stat({ bigint: true }) as BigIntStats;
    if (!sameIdentity(before, opened) || opened.isSymbolicLink() || !opened.isFile() || opened.nlink !== 1n) {
      throw failure("descriptor-identity-changed");
    }
    const bytes = new Uint8Array(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead <= 0) throw failure("descriptor-truncated");
      offset += result.bytesRead;
    }
    const extra = new Uint8Array(1);
    if ((await handle.read(extra, 0, 1, bytes.byteLength)).bytesRead !== 0) throw failure("descriptor-grew");
    const after = await handle.stat({ bigint: true }) as BigIntStats;
    const named = await lstat(path, { bigint: true }) as BigIntStats;
    if (!sameIdentity(opened, after) || !sameIdentity(opened, named) || named.isSymbolicLink() || named.nlink !== 1n ||
        !samePhysicalPath(await realpath(installationDirectory), installationDirectory) ||
        String(root.dev) !== String((await lstat(installationDirectory, { bigint: true })).dev) ||
        String(root.ino) !== String((await lstat(installationDirectory, { bigint: true })).ino)) {
      throw failure("descriptor-raced");
    }
    decodeWindowsPersistenceDescriptor(bytes);
    return Object.freeze({
      bytes: Uint8Array.from(bytes),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
      identity: Object.freeze({ dev: String(opened.dev), ino: String(opened.ino) }),
    });
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw failure("descriptor-read-failed");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
