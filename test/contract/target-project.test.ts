import assert from "node:assert/strict";
import test from "node:test";

import { createGitLabTargetProjectResolver } from "../../src/cli/target-project.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

test("target project resolver reads canonical remote identity and pins GitLab defaultBranch", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/group/project.git"]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: {
    id: 7,
    path_with_namespace: "group/project",
    default_branch: "develop",
    web_url: "https://gitlab.example.test/group/project",
  } });
  const credentialHosts: string[] = [];
  const resolver = createGitLabTargetProjectResolver({
    credentials: {
      tokenForHost: async (host) => {
        credentialHosts.push(host);
        return "credential-canary-token";
      },
    },
    transport: fake,
  });

  const target = await resolver.resolve({ cwd: fixture.worktreePath });

  assert.deepEqual(target, {
    identity: { host: "gitlab.example.test", path: "group/project" },
    project: {
      id: "7",
      fullPath: "group/project",
      defaultBranch: "develop",
      webUrl: "https://gitlab.example.test/group/project",
    },
    targetRemote: "origin",
  });
  assert.deepEqual(credentialHosts, ["gitlab.example.test"]);
  assert.equal(fake.requests.length, 1);
  assert.equal(fake.requests[0]?.headers["private-token"], "credential-canary-token");
});

test("target project resolver rejects ambiguous remotes before reading credentials", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "add", "backup", "https://gitlab.example.test/other/project.git"]);
  let credentialReads = 0;
  const resolver = createGitLabTargetProjectResolver({
    credentials: {
      tokenForHost: async () => {
        credentialReads += 1;
        return "credential-canary-token";
      },
    },
    transport: new FakeGitLab(),
  });

  await assert.rejects(
    resolver.resolve({ cwd: fixture.worktreePath }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /ambiguous/i),
  );
  assert.equal(credentialReads, 0);
});

test("target project resolver does not guess an HTTPS API origin from an SSH port", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git([
    "remote",
    "set-url",
    "origin",
    "ssh://git@gitlab.example.test:2222/group/project.git",
  ]);
  let credentialReads = 0;
  const resolver = createGitLabTargetProjectResolver({
    credentials: {
      tokenForHost: async () => {
        credentialReads += 1;
        return "credential-canary-token";
      },
    },
    transport: new FakeGitLab(),
  });

  await assert.rejects(
    resolver.resolve({ cwd: fixture.worktreePath }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR", /remote URL/i),
  );
  assert.equal(credentialReads, 0);
});

test("target project resolver does not reflect rejected credential-bearing remote URLs", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git([
    "remote",
    "set-url",
    "origin",
    "https://credential-canary@gitlab.example.test/group/project.git",
  ]);
  const resolver = createGitLabTargetProjectResolver({
    credentials: { tokenForHost: async () => "unused" },
    transport: new FakeGitLab(),
  });

  await assert.rejects(
    resolver.resolve({ cwd: fixture.worktreePath }),
    (error: unknown) =>
      isToolError(error, "REPOSITORY_ERROR") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes("credential-canary"),
  );
});
