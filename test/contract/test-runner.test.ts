import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testRunnerPath = resolve(repositoryRoot, "scripts/test.mjs");

test("test runner exits nonzero when a name pattern matches no test cases", () => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  const result = runProcess(
    process.execPath,
    [testRunnerPath, "--test-name-pattern=definitely-does-not-exist"],
    { cwd: repositoryRoot, env: childEnvironment },
  );

  assert.equal(result.error, undefined);
  assert.notEqual(
    result.status,
    0,
    `runner unexpectedly succeeded:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});
