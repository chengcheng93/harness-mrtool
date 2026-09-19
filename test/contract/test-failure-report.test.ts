import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parse } from "yaml";

import { runProcess } from "../helpers/process.ts";

const root = resolve(import.meta.dirname, "../..");
const tempRoot = realpathSync(tmpdir());
const reporter = resolve(root, "scripts/report-test-failures.mjs");
const knownName = "test runner exits nonzero when a name pattern matches no test cases";
const otherName = "test runner still accepts a caller reporter without a name filter";

function report(log: string, status = "1") {
  const directory = mkdtempSync(join(tempRoot, "test-failure-report-"));
  try {
    const path = join(directory, "spec.log");
    writeFileSync(path, log);
    const result = runProcess(process.execPath, [reporter, path, status], { cwd: root });
    return {
      ...result,
      stdout: result.stdout.replaceAll("\r\n", "\n"),
      stderr: result.stderr.replaceAll("\r\n", "\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function evaluate(expression: string): unknown {
  const result = runProcess(process.execPath, [
    "--input-type=module", "-e",
    `import * as reporter from ${JSON.stringify(pathToFileURL(reporter).href)};\nprocess.stdout.write(JSON.stringify(${expression}));`,
  ], { cwd: root });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}

test("failure reporter emits only known failed names and exact numeric summary lines", () => {
  const result = report([
    `\u001b[31m✖ ${knownName} (1.23ms)\u001b[39m`,
    `✔ ${otherName} (2ms)`,
    "ℹ tests 2", "ℹ suites 0", "ℹ pass 1", "ℹ fail 1",
    "ℹ duration_ms 42.25", "✖ failing tests:",
    "test at /private/SECRET_PATH.test.ts:1:1",
    `✖ ${knownName} (1.23ms)`,
    "  AssertionError: SECRET_ASSERTION",
    "  actual: SECRET_ACTUAL", "  expected: SECRET_EXPECTED",
    "  at SECRET_STACK", "TOKEN=SECRET_ENV",
    "::error::SECRET_COMMAND", "",
  ].join("\r\n"));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, [
    `::error::Test failed: ${knownName}`,
    "::error::Test command failed; safe numeric spec summary:%0Aℹ tests 2%0Aℹ pass 1%0Aℹ fail 1", "",
  ].join("\n"));
});

test("failure reporter suppresses forged headers, paths, controls, and dynamic names", () => {
  const result = report([
    "✖ SECRET_TOKEN (1ms)",
    "✖ /private/SECRET_PATH.test.ts (1ms)",
    "✖ C:\\SECRET_PATH\\test.ts (1ms)",
    "✖ TOKEN=SECRET_ENV (1ms)",
    `✖ ${knownName} SECRET_SUFFIX (1ms)`,
    `✖ ${knownName}\r::error::SECRET_CR (1ms)`,
    `✖ ${knownName}\u0000 (1ms)`,
    `✖ ${knownName} (1ms) SECRET_TRAILER`,
    "ℹ tests 3 ::error::SECRET_COUNT", "ℹ pass 2", "ℹ fail 1",
  ].join("\n"));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "::error::Test command failed; no allowlisted failure names found in bounded spec diagnostics.\n");
});

test("failure reporter escapes workflow command data without double-escaping CR or LF", () => {
  assert.equal(evaluate('reporter.escapeWorkflowData("name%0A\\r\\n::error::injected")'),
    "name%250A%0D%0A::error::injected");
});

test("failure reporter bounds unique name count and length after duplicate summaries", () => {
  const names = Array.from({ length: 30 }, (_, index) => `case ${index} ${"x".repeat(400)}`);
  const lines = names.flatMap((name) => [`✖ ${name} (1ms)`, `✖ ${name} (2ms)`]).join("\n");
  const parsed = evaluate(`reporter.parseFailureReport([${JSON.stringify(lines)}], new Set(${JSON.stringify(names)}))`) as { names: string[] };
  assert.equal(parsed.names.length, 20);
  assert.ok(parsed.names.every((name) => name.length <= 200));
  assert.equal(new Set(parsed.names).size, 20);
});

test("failure reporter rejects incomplete, conflicting, oversized, or nonnumeric counts", () => {
  for (const counts of [
    "ℹ tests 1\nℹ pass 0",
    "ℹ tests 1\nℹ pass 0\nℹ fail 1 SECRET",
    "ℹ tests 1\nℹ pass 0\nℹ fail 1\nℹ fail 0",
    "ℹ tests 1\nℹ pass 2\nℹ fail 1",
    "ℹ tests 999999999999999999999\nℹ pass 0\nℹ fail 1",
    "ℹ tests 1\nℹ pass -1\nℹ fail 1",
  ]) {
    const parsed = evaluate(`reporter.parseFailureReport([${JSON.stringify(counts)}], new Set())`) as { summary: string[] };
    assert.deepEqual(parsed.summary, []);
  }
});

test("failure reporter zero exit is diagnostic-only and cannot claim a passing suite", () => {
  for (const log of ["", "unrecognized SECRET format", "ℹ tests 0\nℹ pass 0\nℹ fail 0"]) {
    const result = report(log);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Test command failed/);
    assert.doesNotMatch(result.stdout, /success|all tests pass|SECRET/i);
    assert.equal(result.stderr, "");
  }
  const success = report(`✖ ${knownName} (1ms)`, "0");
  assert.equal(success.status, 0);
  assert.equal(success.stdout, "");
  assert.equal(success.stderr, "");
});

test("failure reporter never reflects missing log paths or invalid status input", () => {
  for (const args of [["/SECRET_MISSING_PATH", "1"], [root, "1"], ["/SECRET_PATH", "SECRET_STATUS"], []]) {
    const result = runProcess(process.execPath, [reporter, ...args], { cwd: root });
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /^::error::Test command failed;/);
    assert.doesNotMatch(result.stdout, /SECRET|ENOENT|EISDIR|Error:|file:\/\//);
  }
});

test("failure reporter reads bounded head and tail without joining partial lines", () => {
  const directory = mkdtempSync(join(tempRoot, "test-failure-bound-"));
  try {
    const path = join(directory, "spec.log");
    // Place a forged header across each read boundary; neither partial line is a record.
    const head = `✖ ${knownName} (1ms)\n`;
    const tail = `\n✖ ${otherName} (2ms)\nℹ tests 2\nℹ pass 0\nℹ fail 2\n`;
    writeFileSync(path, head + "x".repeat(3 * 1024 * 1024) + tail);
    const chunks = evaluate(`reporter.readBoundedLog(${JSON.stringify(path)})`) as string[];
    assert.ok(chunks.reduce((size, chunk) => size + Buffer.byteLength(chunk), 0) <= 2 * 1024 * 1024);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks, [head, tail.slice(1)]);
    const result = runProcess(process.execPath, [reporter, path, "1"], { cwd: root });
    assert.equal(result.status, 0);
    assert.match(result.stdout, new RegExp(knownName));
    assert.match(result.stdout, new RegExp(otherName));
    assert.doesNotMatch(result.stdout, /xxx/);
    assert.equal(result.stderr, "");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("macOS diagnostics capture spec privately and preserve npm exit independently of parsing", () => {
  const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
  const steps = workflow.jobs["macos-arm64"].steps as { run?: string; shell?: string }[];
  const step = steps.find((entry) => entry.run?.includes("report-test-failures.mjs"));
  assert.ok(step);
  assert.equal(step.shell, "bash");
  assert.match(step.run!, /set -euo pipefail/);
  assert.match(step.run!, /umask 077/);
  assert.match(step.run!, /mktemp "\$RUNNER_TEMP\//);
  assert.match(step.run!, /npm test -- --test-concurrency=1 --test-reporter=spec >"\$log" 2>&1 \|\| status=\$\?/);
  assert.match(step.run!, /if \(\( status != 0 \)\); then/);
  assert.match(step.run!, /exit "\$status"/);
  assert.match(step.run!, /report-test-failures\.mjs "\$log" "\$status" 2>\/dev\/null/);
  assert.doesNotMatch(step.run!, /tee|cat |upload|continue-on-error|retry|skip/);
  assert.ok(workflow.jobs["windows-sea"].steps.some((entry: { run?: string }) => entry.run?.includes("windows-suite-group.mjs")));
});

test("failure reporter keeps 100%0A::error:: text on one annotation line", () => {
  const name = "failure reporter keeps 100%0A::error:: text on one annotation line";
  const result = report(`✖ ${name} (0.12ms)\n`);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, "::error::Test failed: failure reporter keeps 100%250A::error:: text on one annotation line\n");
});

test("failure reporter accepts actual pinned Node spec output without assertion details", () => {
  const directory = mkdtempSync(join(tempRoot, "test-failure-spec-"));
  try {
    const fixture = join(directory, "fixture.test.mjs");
    writeFileSync(fixture, `import test from "node:test";
import assert from "node:assert/strict";
test(${JSON.stringify(knownName)}, () => assert.equal("SECRET_ACTUAL", "SECRET_EXPECTED"));
`);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const run = runProcess(process.execPath, ["--test", "--test-reporter=spec", fixture], { env });
    assert.equal(run.status, 1);
    const spec = run.stdout + run.stderr;
    assert.match(spec, /SECRET_ACTUAL/);
    const result = report(spec, String(run.status));
    assert.equal(result.status, 0);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, [
      `::error::Test failed: ${knownName}`,
      "::error::Test command failed; safe numeric spec summary:%0Aℹ tests 1%0Aℹ pass 0%0Aℹ fail 1", "",
    ].join("\n"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Windows native CI retains the complete serial suite in bounded parallel groups", () => {
  const workflow = parse(readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8"));
  const job = workflow.jobs["windows-sea"];
  assert.equal(job["timeout-minutes"], 45);
  assert.equal(job["continue-on-error"], undefined);
  assert.deepEqual(job.strategy.matrix.group, [0, 1, 2, 3]);
  assert.ok(job.steps.some((entry: {run?: string}) => entry.run?.includes("windows-suite-group.mjs")));
});
