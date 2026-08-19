import assert from "node:assert/strict";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { discoverProfileDetectionRepository } from "../../src/git/target-branch.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

const targetProject = Object.freeze({ host: "gitlab.example.test", path: "group/project" });

async function configureGitLabRemote(fixture: GitFixture): Promise<void> {
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/group/project.git"]);
}

test("profile detection uses the GitLab default branch and treats matching remote HEAD as a check", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await configureGitLabRemote(fixture);
  await fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);

  const repository = await discoverProfileDetectionRepository({
    cwd: fixture.worktreePath,
    expectedTargetProject: targetProject,
    targetBranch: "main",
    targetRemote: "origin",
  });

  assert.equal(repository.targetRemote, "origin");
  assert.equal(repository.targetBranch, "main");
  assert.equal(repository.targetRef, "refs/remotes/origin/main");
  assert.equal(repository.targetRefSha, await fixture.targetHead());
});

test("profile detection accepts a missing remote HEAD because GitLab remains authoritative", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await configureGitLabRemote(fixture);

  const repository = await discoverProfileDetectionRepository({
    cwd: fixture.worktreePath,
    expectedTargetProject: targetProject,
    targetBranch: "main",
    targetRemote: "origin",
  });

  assert.equal(repository.targetBranch, "main");
});

test("profile detection rejects remote HEAD main when GitLab defaultBranch is develop", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await configureGitLabRemote(fixture);
  const main = await fixture.targetHead();
  await fixture.git(["update-ref", "refs/remotes/origin/develop", main]);
  await fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);

  await assert.rejects(
    discoverProfileDetectionRepository({
      cwd: fixture.worktreePath,
      expectedTargetProject: targetProject,
      targetBranch: "develop",
      targetRemote: "origin",
    }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /remote HEAD/i),
  );
});

test("profile detection rejects a non-canonical remote HEAD without disclosing its ref", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await configureGitLabRemote(fixture);
  await fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/heads/credential-canary",
  ]);

  await assert.rejects(
    discoverProfileDetectionRepository({
      cwd: fixture.worktreePath,
      expectedTargetProject: targetProject,
      targetBranch: "main",
      targetRemote: "origin",
    }),
    (error: unknown) => {
      if (!isToolError(error, "REPOSITORY_ERROR", /remote HEAD/i)) return false;
      return !`${error.message}\n${JSON.stringify(error.details)}`.includes("credential-canary");
    },
  );
});

test("profile detection rejects a target project identity inconsistent with the selected remote", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await configureGitLabRemote(fixture);

  await assert.rejects(
    discoverProfileDetectionRepository({
      cwd: fixture.worktreePath,
      expectedTargetProject: { host: "gitlab.example.test", path: "rejected/credential-canary" },
      targetBranch: "main",
      targetRemote: "origin",
    }),
    (error: unknown) => {
      if (!isToolError(error, "REPOSITORY_ERROR", /target project/i)) return false;
      return !`${error.message}\n${JSON.stringify(error.details)}`.includes("credential-canary");
    },
  );
});
