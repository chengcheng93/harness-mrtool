import { spawnSync } from "node:child_process";
import { copyFile, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertExactNodeVersion, buildApplication } from "./build.mjs";
import {
  collectSeaBuildInputs,
  createSeaBuildReceipt,
  writeSeaBuildReceipt,
} from "./sea-build-receipt.mjs";
import {
  finalizeSeaExecutable,
  verifySeaExecutable,
} from "./sea-verification.mjs";

const require = createRequire(import.meta.url);
const { inject } = require("postject");

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = resolve(repositoryRoot, "dist");
const seaConfigPath = resolve(repositoryRoot, "sea-config.json");
const blobPath = resolve(distDirectory, "harness-mrtool.blob");
const executablePath = resolve(distDirectory, "harness-mrtool.exe");
const receiptPath = resolve(distDirectory, "sea-build-receipt.json");
const sentinelFuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

function runBlobGeneration() {
  const result = spawnSync(
    process.execPath,
    ["--experimental-sea-config", seaConfigPath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      windowsHide: true,
    },
  );

  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `SEA blob generation failed with exit ${String(result.status)}:\n${result.stderr}`,
    );
  }
}

export async function buildSeaExecutable() {
  assertExactNodeVersion();
  await rm(distDirectory, { recursive: true, force: true });
  await buildApplication();
  runBlobGeneration();
  await copyFile(process.execPath, executablePath);
  try {
    await finalizeSeaExecutable(executablePath, {
      injectBlob: async () =>
        inject(executablePath, "NODE_SEA_BLOB", await readFile(blobPath), {
          sentinelFuse,
        }),
      removeArtifact: (path) => rm(path, { force: true }),
      verifyExecutable: verifySeaExecutable,
    });
    writeSeaBuildReceipt(
      receiptPath,
      createSeaBuildReceipt(
        repositoryRoot,
        executablePath,
        collectSeaBuildInputs(repositoryRoot),
      ),
    );
  } catch (error) {
    await Promise.all([
      rm(executablePath, { force: true }),
      rm(receiptPath, { force: true }),
    ]);
    throw error;
  }
}

await buildSeaExecutable();
