import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  open,
  realpath,
  unlink,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";


import { isToolError, ToolError } from "../contracts/errors.ts";


const MAX_PROJECT_TEMPLATE_BYTES = 2 * 1024 * 1024;


export interface ProjectTemplateWriterHooks {
  readonly beforePublish?: () => Promise<void> | void;
}


function inputError(reason: string): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "Project template export failed safely", {
    field: "--destination",
    expected: "a new regular file in an existing direct directory",
    actual: reason,
    safeNextStep: "Choose a new destination in an existing trusted directory and retry the export.",
  });
}


function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}


async function assertSafeParent(parent: string): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  let canonicalMetadata: Awaited<ReturnType<typeof lstat>>;
  let canonical: string;
  try {
    [metadata, canonical] = await Promise.all([lstat(parent), realpath(parent)]);
    canonicalMetadata = await lstat(canonical);
  } catch {
    throw inputError("destination directory is missing or unreadable");
  }
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev !== canonicalMetadata.dev ||
    metadata.ino !== canonicalMetadata.ino ||
    (process.platform !== "win32" && !samePath(canonical, parent))
  ) {
    throw inputError("destination directory is indirect or not a regular directory");
  }
}

async function assertDestinationAbsent(destination: string): Promise<void> {
  try {
    await lstat(destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw inputError("destination cannot be inspected safely");
  }
  throw inputError("destination already exists");
}


async function syncDirectory(parent: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(parent, constants.O_RDONLY);
  let failure: unknown;
  try {
    await handle.sync();
  } catch (error) {
    failure = error;
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) throw failure;
}


function validateInputs(destination: string, contents: string): {
  readonly destination: string;
  readonly contents: Uint8Array;
} {
  if (
    typeof destination !== "string" ||
    destination === "" ||
    destination !== destination.trim() ||
    /[\r\n\u0000]/u.test(destination)
  ) {
    throw inputError("destination value is invalid");
  }
  if (typeof contents !== "string") {
    throw inputError("template contents are invalid");
  }
  const bytes = new TextEncoder().encode(contents);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PROJECT_TEMPLATE_BYTES) {
    throw inputError("template contents exceed the export size contract");
  }
  return { destination: resolve(destination), contents: bytes };
}


export async function writeProjectTemplate(
  destinationValue: string,
  contentsValue: string,
  hooks: ProjectTemplateWriterHooks = {},
): Promise<void> {
  const validated = validateInputs(destinationValue, contentsValue);
  const destination = validated.destination;
  const parent = dirname(destination);
  let temporaryPath: string | null = null;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | null = null;
  let published = false;
  try {
    await assertSafeParent(parent);
    await assertDestinationAbsent(destination);
    temporaryPath = resolve(
      parent,
      `.${basename(destination)}.harness-mrtool-${randomBytes(16).toString("hex")}.tmp`,
    );
    temporaryHandle = await open(temporaryPath, "wx", 0o600);
    await temporaryHandle.writeFile(validated.contents);
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = null;
    await hooks.beforePublish?.();
    await assertSafeParent(parent);
    try {
      await link(temporaryPath, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw inputError("destination already exists");
      }
      throw error;
    }
    published = true;
    await syncDirectory(parent);
  } catch (error) {
    if (isToolError(error, "INPUT_ERROR")) throw error;
    throw inputError(published
      ? "destination persistence could not be proven"
      : "destination could not be published safely");
  } finally {
    if (temporaryHandle !== null) {
      await temporaryHandle.close().catch(() => undefined);
    }
    if (temporaryPath !== null) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
