import assert from "node:assert/strict";
import test from "node:test";

// The build entrypoint is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build script intentionally has no declaration file.
import { assertExactNodeVersion } from "../../scripts/build.mjs";

test("build accepts only the pinned Node release", () => {
  assert.doesNotThrow(() => assertExactNodeVersion("24.16.0"));
  assert.throws(
    () => assertExactNodeVersion("24.15.0"),
    /Node 24\.16\.0 is required to build harness-mrtool; found 24\.15\.0\./,
  );
});
