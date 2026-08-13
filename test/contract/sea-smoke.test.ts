import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";
// The build helper is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build helper intentionally has no declaration file.
import { expectedSeaSelfTestStdout } from "../../scripts/sea-verification.mjs";
// @ts-expect-error The receipt helper intentionally has no declaration file.
import { collectSeaBuildInputs, verifySeaBuildReceipt } from "../../scripts/sea-build-receipt.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const executablePath = resolve(repositoryRoot, "dist/harness-mrtool.exe");
const receiptPath = resolve(repositoryRoot, "dist/sea-build-receipt.json");
const packageVersion = (
  JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
    version: string;
  }
).version;
const expectedStdout = expectedSeaSelfTestStdout(packageVersion);

function processDiagnostic(result: ReturnType<typeof runProcess>): string {
  return JSON.stringify(
    {
      error:
        result.error === undefined
          ? undefined
          : { message: result.error.message, name: result.error.name },
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    },
    undefined,
    2,
  );
}

test("SEA executable runs self-test from an empty working directory", (context) => {
  verifySeaBuildReceipt(
    repositoryRoot,
    executablePath,
    collectSeaBuildInputs(repositoryRoot),
    receiptPath,
  );
  const emptyWorkingDirectory = mkdtempSync(join(tmpdir(), "harness-mrtool-sea-"));
  context.after(() => rmSync(emptyWorkingDirectory, { recursive: true, force: true }));

  const result = runProcess(executablePath, ["self-test", "--output", "json"], {
    cwd: emptyWorkingDirectory,
    env: {
      NO_COLOR: "1",
      SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    },
  });

  const diagnostic = processDiagnostic(result);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.ok(
    result.stdout === expectedStdout ||
      result.stdout === `${expectedStdout}\n` ||
      result.stdout === `${expectedStdout}\r\n`,
    `stdout must contain exactly one JSON document:\n${diagnostic}`,
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    code: "OK",
    sea: true,
    version: packageVersion,
  });
});

test("SEA executable runs the embedded output contract probe", (context) => {
  verifySeaBuildReceipt(
    repositoryRoot,
    executablePath,
    collectSeaBuildInputs(repositoryRoot),
    receiptPath,
  );
  const emptyWorkingDirectory = mkdtempSync(
    join(tmpdir(), "harness-mrtool-sea-contract-"),
  );
  context.after(() =>
    rmSync(emptyWorkingDirectory, { recursive: true, force: true }),
  );

  const result = runProcess(
    executablePath,
    ["self-test", "--contract-probe", "--output", "json"],
    {
      cwd: emptyWorkingDirectory,
      env: {
        NO_COLOR: "1",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      },
    },
  );

  const diagnostic = processDiagnostic(result);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    code: "CONTRACT_PROBE_OK",
    sea: true,
    version: packageVersion,
    validOutputAccepted: true,
    invalidOutputRejected: true,
    requestValidAccepted: true,
    requestInvalidRejected: true,
  });
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});
