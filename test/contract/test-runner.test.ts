import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const testRunnerPath = resolve(repositoryRoot, "scripts/test.mjs");

function environmentOutsideNodeTest(): NodeJS.ProcessEnv {
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  return childEnvironment;
}

test("test runner exits nonzero when a name pattern matches no test cases", () => {
  const result = runProcess(
    process.execPath,
    [testRunnerPath, "--test-name-pattern=definitely-does-not-exist"],
    { cwd: repositoryRoot, env: environmentOutsideNodeTest() },
  );

  assert.equal(result.error, undefined);
  assert.notEqual(
    result.status,
    0,
    `runner unexpectedly succeeded:\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

for (const [name, arguments_] of [
  [
    "equals reporter",
    ["--test-name-pattern=build accepts", "--test-reporter=tap"],
  ],
  [
    "separate reporter",
    ["--test-name-pattern", "build accepts", "--test-reporter", "tap"],
  ],
  [
    "equals reporter destination",
    ["--test-name-pattern=build accepts", "--test-reporter-destination=stdout"],
  ],
  [
    "separate reporter destination",
    [
      "--test-name-pattern",
      "build accepts",
      "--test-reporter-destination",
      "stdout",
    ],
  ],
] as const) {
  test(`test runner rejects name filters combined with ${name}`, () => {
    const result = runProcess(process.execPath, [testRunnerPath, ...arguments_], {
      cwd: repositoryRoot,
      env: environmentOutsideNodeTest(),
    });

    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, "");
    assert.equal(
      result.stderr,
      "--test-name-pattern cannot be combined with --test-reporter or --test-reporter-destination.\n",
    );
  });
}

test("test runner still accepts a caller reporter without a name filter", () => {
  const result = runProcess(
    process.execPath,
    [testRunnerPath, "test/build/node-version.test.ts", "--test-reporter=tap"],
    { cwd: repositoryRoot, env: environmentOutsideNodeTest() },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^TAP version 13/m);
  assert.equal(result.stderr, "");
});
