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

test("JSON usage errors flush one complete output-v1 document to stdout", () => {
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
  const output = JSON.parse(result.stdout) as {
    readonly schemaVersion?: unknown;
    readonly ok?: unknown;
    readonly code?: unknown;
    readonly data?: unknown;
  };
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, false);
  assert.equal(output.code, "INPUT_ERROR");
  assert.equal(output.data, null);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});

test("the public version command uses the same output-v1 process boundary", () => {
  const result = runProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntrypoint,
      "version",
      "--output",
      "json",
    ],
    { cwd: repositoryRoot },
  );

  const diagnostic = JSON.stringify(result, undefined, 2);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  const output = JSON.parse(result.stdout) as {
    readonly schemaVersion?: unknown;
    readonly ok?: unknown;
    readonly code?: unknown;
    readonly versions?: { readonly cliVersion?: unknown };
    readonly data?: { readonly version?: unknown };
  };
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, true);
  assert.equal(output.code, "OK");
  assert.equal(output.versions?.cliVersion, output.data?.version);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});
