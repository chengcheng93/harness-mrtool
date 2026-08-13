import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const delayedStdoutFixture = resolve(
  repositoryRoot,
  "test/fixtures/delayed-stdout.cjs",
);
const sourceEntrypoint = resolve(repositoryRoot, "src/main.ts");

test("JSON usage errors flush completely to a child-process stdout pipe", () => {
  const result = runProcess(
    process.execPath,
    [
      "--require",
      delayedStdoutFixture,
      "--import",
      "tsx",
      sourceEntrypoint,
      "unknown-command",
      "--output",
      "json",
    ],
    { cwd: repositoryRoot },
  );

  const diagnostic = JSON.stringify(result, undefined, 2);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 2, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  const output = JSON.parse(result.stdout) as unknown;
  assert.deepEqual(output, {
    ok: false,
    code: "USAGE_ERROR",
    message: "Usage: harness-mrtool self-test --output json",
  });
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});
