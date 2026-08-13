import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { build } from "esbuild";

// @ts-expect-error The build helper intentionally has no declaration file.
import { createApplicationBuildOptions } from "../../scripts/build.mjs";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { runProcess } from "../helpers/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const templateBundlePath = resolve(repositoryRoot, "template-bundle");

test("application bundle executes Bundle validation without external modules", async (context) => {
  const outputDirectory = mkdtempSync(join(tmpdir(), "harness-app-bundle-"));
  context.after(() => rmSync(outputDirectory, { recursive: true, force: true }));
  const outputPath = resolve(outputDirectory, "main.cjs");
  await build({
    ...createApplicationBuildOptions("0.1.0-test"),
    outfile: outputPath,
    logLevel: "silent",
  });

  const result = runProcess(
    process.execPath,
    [outputPath, "internal", "validate-bundle", templateBundlePath],
    { cwd: outputDirectory },
  );
  const diagnostic = JSON.stringify(result, undefined, 2);
  const manifest = JSON.parse(readFileSync(
    resolve(templateBundlePath, "bundle-manifest.json"),
    "utf8",
  )) as unknown;
  const expectedBundleHash = createHash("sha256")
    .update(`${canonicalizeJson(manifest)}\n`, "utf8")
    .digest("hex");
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: true,
    code: "OK",
    message: "Template bundle validation passed",
    versions: {
      cliVersion: "0.1.0-test",
      templateVersion: "1.0.0",
      bundleHash: expectedBundleHash,
      releaseSetId: null,
      inputSchema: 1,
      policySchema: 1,
      loadedSkillVersion: null,
      loadedSkillProtocol: null,
      installedSkillVersion: null,
      stagedSkillVersion: null,
      manifestSequence: null,
    },
    update: {
      checked: false,
      reachable: null,
      usingLastKnownGood: false,
      latestVersionConfirmed: false,
      warning: null,
      securityAnomaly: false,
      activationRequired: false,
      hostRefreshMayBeRequired: false,
      persistencePending: false,
      executedVersion: "0.1.0-test",
      installedVersion: "0.1.0-test",
    },
    validation: { valid: true, issues: [] },
    remoteWrite: { state: "not-attempted", operations: [] },
    warnings: [],
    error: null,
    data: { bundleId: "harness-mr-default", payloadCount: 9 },
  });
  assert.equal(result.stdout.trimEnd().split(/\r?\n/u).length, 1, diagnostic);
});
