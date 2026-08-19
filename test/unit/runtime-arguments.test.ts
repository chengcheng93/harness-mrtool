import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRuntimeArguments } from "../../src/runtime-arguments.ts";

test("normalizes ordinary Node argv without changing application arguments", () => {
  assert.deepEqual(
    normalizeRuntimeArguments([
      "C:\\Program Files\\nodejs\\node.exe",
      "C:\\source tree\\src\\main.ts",
      "self-test",
      "--note",
      "value with spaces",
    ]),
    ["self-test", "--note", "value with spaces"],
  );
});

test("normalizes the observed SEA duplicate-executable argv shape", () => {
  const executable = "C:\\Program Files\\Harness MR Tool\\harness-mrtool.exe";

  assert.deepEqual(
    normalizeRuntimeArguments([
      executable,
      executable,
      "self-test",
      "--note",
      "value with spaces",
    ]),
    ["self-test", "--note", "value with spaces"],
  );
});
