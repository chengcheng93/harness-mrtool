import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";
import { assertArtifactIsFresh } from "../helpers/sea-artifact.ts";

// The build helper is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build helper intentionally has no declaration file.
import { EXPECTED_SEA_SELF_TEST_STDOUT } from "../../scripts/sea-verification.mjs";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const executablePath = resolve(repositoryRoot, "dist/harness-mrtool.exe");

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => resolve(entry.parentPath, entry.name));
}

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
  assertArtifactIsFresh(executablePath, [
    ...filesUnder(resolve(repositoryRoot, "src")),
    resolve(repositoryRoot, "scripts/build.mjs"),
    resolve(repositoryRoot, "scripts/build-sea.mjs"),
    resolve(repositoryRoot, "scripts/sea-verification.mjs"),
    resolve(repositoryRoot, "sea-config.json"),
    resolve(repositoryRoot, "package.json"),
    resolve(repositoryRoot, "package-lock.json"),
  ]);
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
    result.stdout === EXPECTED_SEA_SELF_TEST_STDOUT ||
      result.stdout === `${EXPECTED_SEA_SELF_TEST_STDOUT}\n` ||
      result.stdout === `${EXPECTED_SEA_SELF_TEST_STDOUT}\r\n`,
    `stdout must contain exactly one JSON document:\n${diagnostic}`,
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    code: "OK",
    sea: true,
    version: "0.1.0-dev",
  });
});
