import assert from "node:assert/strict";
import test from "node:test";

import { preprocessProductionInvocation } from "../../src/cli/production-invocation.ts";
import { isToolError } from "../../src/contracts/errors.ts";

test("production invocation strips one context issue and freezes the invocation snapshot", () => {
  const invocation = preprocessProductionInvocation([
    "context",
    "--issue",
    "42",
    "--format",
    "json",
  ]);

  assert.deepEqual(invocation, {
    arguments: ["context", "--format", "json"],
    contextIssueIid: 42,
  });
  assert.equal(Object.isFrozen(invocation), true);
  assert.equal(Object.isFrozen(invocation.arguments), true);
});

test("production invocation leaves unrelated arguments unchanged in an immutable copy", () => {
  const source = ["preview", "--format", "json"];
  const invocation = preprocessProductionInvocation(source);
  source[0] = "doctor";

  assert.deepEqual(invocation, {
    arguments: ["preview", "--format", "json"],
    contextIssueIid: null,
  });
});

for (const arguments_ of [
  ["context", "--issue"],
  ["context", "--issue", "0"],
  ["context", "--issue", "-1"],
  ["context", "--issue", "+1"],
  ["context", "--issue", "1.0"],
  ["context", "--issue", "9007199254740992"],
  ["context", "--issue", "1", "--issue", "2"],
  ["preview", "--issue", "1"],
  ["doctor", "--issue", "1"],
] as const) {
  test(`production invocation rejects invalid or out-of-scope issue arguments: ${JSON.stringify(arguments_)}`, () => {
    assert.throws(
      () => preprocessProductionInvocation(arguments_),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
  });
}

test("production invocation never reflects a rejected issue value", () => {
  const secret = "credential-canary-value";
  assert.throws(
    () => preprocessProductionInvocation(["context", "--issue", secret]),
    (error: unknown) =>
      isToolError(error, "INPUT_ERROR") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes(secret),
  );
});

test("production label option handoff preserves CLI options and isolates invocation snapshots", async () => {
  const { labelOptionsForProductionInvocation, recordWizardLabelOptions, clearWizardLabelOptions } = await import("../../src/cli/production-invocation.ts");
  const { parseCliInvocation } = await import("../../src/cli/program.ts");
  const invocation = parseCliInvocation(["preview", "--priority", "p1", "--priority-reason", "Incident"]);
  assert.deepEqual(labelOptionsForProductionInvocation(invocation), { priority: "p1", priorityReason: "Incident" });
  const options = { priority: "p0" as const, priorityReason: "Confirmed outage" };
  recordWizardLabelOptions(invocation, options);
  options.priorityReason = "mutated";
  assert.deepEqual(labelOptionsForProductionInvocation(invocation), { priority: "p0", priorityReason: "Confirmed outage" });
  assert.equal(Object.isFrozen(labelOptionsForProductionInvocation(invocation)), true);
  assert.deepEqual(labelOptionsForProductionInvocation({ ...invocation }), { priority: "p1", priorityReason: "Incident" });
  clearWizardLabelOptions(invocation);
  assert.deepEqual(labelOptionsForProductionInvocation(invocation), { priority: "p1", priorityReason: "Incident" });
});
