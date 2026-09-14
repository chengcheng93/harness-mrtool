import { spawnSync } from "node:child_process";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertExactNodeVersion, buildApplication } from "./build.mjs";
import { orchestrateSeaBuild } from "./sea-build-orchestrator.mjs";
import { collectSeaBuildInputs } from "./sea-build-receipt.mjs";
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

// Receives only the build-owned executable copy; never process.execPath.
export async function injectCopiedSeaExecutable(artifactPath, blob, dependencies = {}) {
  if (resolve(artifactPath) === resolve(process.execPath)) {
    throw new Error("SEA injection requires an owned copy, not the active Node runtime.");
  }
  // Path spelling (even realpath) cannot distinguish hard links or APFS aliases
  // from owned copies. Require usable filesystem identities before any mutation.
  const readIdentity = dependencies.stat ?? stat;
  let artifactIdentity;
  let runtimeIdentity;
  try {
    [artifactIdentity, runtimeIdentity] = await Promise.all([
      readIdentity(artifactPath, { bigint: true }),
      readIdentity(process.execPath, { bigint: true }),
    ]);
    for (const identity of [artifactIdentity, runtimeIdentity]) {
      if (!identity.isFile() || typeof identity.dev !== "bigint" || identity.dev < 0n ||
          typeof identity.ino !== "bigint" || identity.ino <= 0n) {
        throw new Error("A regular file with usable device/inode identity is required.");
      }
    }
  } catch (cause) {
    throw new Error("SEA executable identity could not be established safely.", { cause });
  }
  if (artifactIdentity.dev === runtimeIdentity.dev && artifactIdentity.ino === runtimeIdentity.ino) {
    throw new Error("SEA injection requires an owned copy, not an alias of the active Node runtime.");
  }
  const platform = dependencies.platform ?? process.platform;
  const injectBlob = dependencies.inject ?? inject;
  const runProcess = dependencies.runProcess ?? spawnSync;
  function codesign(arguments_) {
    const result = runProcess("/usr/bin/codesign", [...arguments_, artifactPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.error !== undefined) throw result.error;
    if (result.status !== 0) {
      throw new Error(`SEA codesign ${arguments_[0]} failed with exit ${String(result.status)} (${String(result.signal)}):\n${result.stderr}`);
    }
  }
  // Node 24 SEA's Mach-O injection invalidates the copied Node signature.
  // Strip it before injection, then sign the modified copy before any execution.
  if (platform === "darwin") codesign(["--remove-signature"]);
  await injectBlob(artifactPath, "NODE_SEA_BLOB", blob, {
    sentinelFuse,
    ...(platform === "darwin" ? { machoSegmentName: "NODE_SEA" } : {}),
  });
  if (platform === "darwin") codesign(["--sign", "-"]);
}

export async function buildSeaExecutable() {
  assertExactNodeVersion();
  await orchestrateSeaBuild({
    artifactPath: executablePath,
    buildArtifact: async () => {
      await rm(distDirectory, { recursive: true, force: true });
      await buildApplication();
      runBlobGeneration();
      await copyFile(process.execPath, executablePath);
      await finalizeSeaExecutable(executablePath, {
        injectBlob: async () =>
          injectCopiedSeaExecutable(executablePath, await readFile(blobPath)),
        removeArtifact: (path) => rm(path, { force: true }),
        verifyExecutable: verifySeaExecutable,
      });
    },
    collectBuildInputPaths: () => collectSeaBuildInputs(repositoryRoot),
    receiptPath,
    repositoryRoot,
  });
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  await buildSeaExecutable();
}
