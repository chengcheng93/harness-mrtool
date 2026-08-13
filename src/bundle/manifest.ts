import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { canonicalizeJson } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import {
  TEMPLATE_BUNDLE_PAYLOAD_PATHS,
  type TemplateBundleManifest,
} from "./types.ts";

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function manifestError(reason: string): ToolError<"TEMPLATE_ERROR"> {
  return new ToolError("TEMPLATE_ERROR", `Invalid template bundle: ${reason}`, {
    field: null,
    expected: "bundle-manifest.json plus the exact nine payload files",
    actual: reason,
    safeNextStep: "Remove unknown files or restore missing template bundle payloads.",
  });
}

async function assertExactBuilderFileSet(bundleDirectory: string): Promise<void> {
  const expected = new Set(["bundle-manifest.json", ...TEMPLATE_BUNDLE_PAYLOAD_PATHS]);
  let entries;
  try {
    entries = await readdir(bundleDirectory, { recursive: true, withFileTypes: true });
  } catch {
    throw manifestError("bundle file set cannot be enumerated");
  }
  const files = new Set<string>();
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw manifestError("bundle file set contains a symbolic link");
    }
    if (!entry.isFile()) {
      continue;
    }
    const path = resolve(entry.parentPath, entry.name);
    const portablePath = relative(bundleDirectory, path).split(sep).join("/");
    files.add(portablePath);
  }
  if (
    files.size !== expected.size ||
    [...files].some((path) => !expected.has(path)) ||
    [...expected].some((path) => !files.has(path))
  ) {
    throw manifestError("bundle file set contains an unknown or missing entry");
  }
}

export async function buildTemplateBundleManifest(
  bundleDirectory: string,
): Promise<{
  readonly manifest: TemplateBundleManifest;
  readonly serialized: string;
  readonly sha256: string;
}> {
  await assertExactBuilderFileSet(bundleDirectory);
  const files = await Promise.all(
    TEMPLATE_BUNDLE_PAYLOAD_PATHS.map(async (path) => {
      const bytes = await readFile(resolve(bundleDirectory, path));
      return { path, size: bytes.byteLength, sha256: sha256(bytes) };
    }),
  );
  const manifest: TemplateBundleManifest = {
    manifestVersion: 1,
    bundleId: "harness-mr-default",
    version: "1.0.0",
    inputSchema: 1,
    policySchema: 1,
    files,
  };
  const serialized = `${canonicalizeJson(manifest)}\n`;
  return { manifest, serialized, sha256: sha256(serialized) };
}
