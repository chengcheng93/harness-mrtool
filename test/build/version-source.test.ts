import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// The build entrypoint is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build script intentionally has no declaration file.
import { createApplicationBuildOptions } from "../../scripts/build.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("build injects the package version and verified Bundle as compile-time constants", () => {
  const options = createApplicationBuildOptions("9.8.7-test");

  assert.equal(options.define.__HARNESS_MRTOOL_VERSION__, '"9.8.7-test"');
  const embeddedBundle = JSON.parse(
    options.define.__HARNESS_MRTOOL_BOOTSTRAP_BUNDLE__,
  ) as {
    readonly manifest: {
      readonly bundleId: string;
      readonly version: string;
      readonly files: readonly unknown[];
    };
  };
  assert.equal(embeddedBundle.manifest.bundleId, "harness-mr-default");
  assert.equal(embeddedBundle.manifest.version, "1.0.0");
  assert.equal(embeddedBundle.manifest.files.length, 9);
});

test("runtime source does not hardcode the package version", () => {
  const packageMetadata = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { version: string };
  const source = readFileSync(resolve(repositoryRoot, "src/main.ts"), "utf8");

  assert.doesNotMatch(source, new RegExp(packageMetadata.version.replaceAll(".", "\\.")));
  assert.match(source, /__HARNESS_MRTOOL_VERSION__/);
});
