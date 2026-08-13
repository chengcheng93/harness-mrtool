import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

// The build entrypoint is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build script intentionally has no declaration file.
import { createApplicationBuildOptions } from "../../scripts/build.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("build injects the package version as a compile-time constant", () => {
  const options = createApplicationBuildOptions("9.8.7-test");

  assert.deepEqual(options.define, {
    __HARNESS_MRTOOL_VERSION__: '"9.8.7-test"',
  });
});

test("runtime source does not hardcode the package version", () => {
  const packageMetadata = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as { version: string };
  const source = readFileSync(resolve(repositoryRoot, "src/main.ts"), "utf8");

  assert.doesNotMatch(source, new RegExp(packageMetadata.version.replaceAll(".", "\\.")));
  assert.match(source, /__HARNESS_MRTOOL_VERSION__/);
});
