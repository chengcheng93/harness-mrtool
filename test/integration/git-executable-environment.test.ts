import assert from "node:assert/strict";
import { chmod, copyFile, mkdir } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import test from "node:test";

import { GitRunner } from "../../src/git/runner.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

test("default GitRunner reads a repository using the environment's Git", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());

  const result = await new GitRunner(fixture.worktreePath).run(["rev-parse", "HEAD"]);

  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(result.stdout.toString().trim(), await fixture.head());
});

test("default GitRunner follows PATH outside system installation directories", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  const directory = resolve(fixture.root, "portable-tools");
  await mkdir(directory);
  const executable = resolve(directory, process.platform === "win32" ? "git.exe" : "git");
  await copyFile(process.execPath, executable);
  if (process.platform !== "win32") await chmod(executable, 0o755);

  const result = await new GitRunner(fixture.worktreePath, undefined, {
    environment: { PATH: [directory, process.env.PATH ?? ""].join(delimiter) },
  }).run(["--version"]);

  assert.equal(result.exitCode, 0, result.stderr.toString());
  // A differently named Node executable proves the first PATH entry was used.
  assert.equal(result.stdout.toString().trim(), process.version);
});

test("production GitRunner accepts a caller-selected executable", async () => {
  const result = await new GitRunner(process.cwd(), undefined, {
    gitExecutable: process.execPath,
  }).run(["--version"]);

  assert.equal(result.exitCode, 0, result.stderr.toString());
  assert.equal(result.stdout.toString().trim(), process.version);
});

test("missing Git reports the native process lookup failure", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());

  await assert.rejects(
    new GitRunner(fixture.worktreePath, undefined, { environment: { PATH: "" } }).run(["--version"]),
    { code: "ENOENT" },
  );
});
