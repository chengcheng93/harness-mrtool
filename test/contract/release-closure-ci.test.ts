import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

test("release closure branch can reach native CI without modifying main or releasing assets", () => {
  const workflow = parse(readFileSync(resolve(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8"));
  assert.ok(workflow.on.push.branches.includes("codex/release-closure-20260918"));
  assert.ok(workflow.on.push.branches.includes("main"));
  assert.equal(workflow.on.push.tags, undefined);
  assert.deepEqual(workflow.permissions, {contents: "read"});
  const windows = workflow.jobs["windows-sea"];
  assert.equal(windows["continue-on-error"], undefined);
  assert.ok(windows.steps.some((step: {run?: string}) => step.run ===
    "npm test -- --test-concurrency=1 --test-reporter=./scripts/ci-test-progress-reporter.mjs"));
});
