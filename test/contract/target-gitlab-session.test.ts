import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import {
  createGitLabTargetProjectResolver,
  createGitLabTargetSessionResolver,
} from "../../src/cli/target-project.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabHttpRequest } from "../../src/gitlab/http.ts";
import { FakeGitLab } from "../helpers/fake-gitlab.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

const projectResponse = {
  id: 7,
  path_with_namespace: "group/project",
  default_branch: "develop",
  web_url: "https://gitlab.example.test/group/project",
};

for (const remote of [
  "git@gitlab.example.test:group/project.git",
  "ssh://git@gitlab.example.test/group/project.git",
  "git://gitlab.example.test/group/project.git",
  "http://gitlab.example.test/group/project.git",
]) {
  test(`target session prefers HTTP for ${remote}`, async (t) => {
    const fixture = await GitFixture.create();
    t.after(() => fixture.dispose());
    await fixture.git(["remote", "set-url", "origin", remote]);
    const fake = new FakeGitLab();
    fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
      body: { ...projectResponse, web_url: "http://gitlab.example.test/group/project" },
    });
    const session = await createGitLabTargetSessionResolver({
      credentials: { tokenForHost: async () => "http-project-token" }, transport: fake,
    }).resolve({ cwd: fixture.worktreePath });
    assert.equal(session.origin, "http://gitlab.example.test");
    assert.equal(session.gitlab.origin, session.origin);
    assert.deepEqual(fake.requests.map((request) => request.url), [
      "http://gitlab.example.test/api/v4/projects/group%2Fproject",
    ]);
  });
}

test("inferred HTTP API falls back to HTTPS when its read-only project lookup cannot connect", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "git@gitlab.example.test:group/project.git"]);
  const urls: string[] = [];
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const session = await createGitLabTargetSessionResolver({
    credentials: { tokenForHost: async () => "fallback-project-token" },
    transport: { request: async (request: GitLabHttpRequest) => {
      urls.push(request.url);
      if (request.url.startsWith("http://")) throw new Error("HTTP listener unavailable");
      return fake.request(request);
    } },
  }).resolve({ cwd: fixture.worktreePath });
  assert.deepEqual(urls, [
    "http://gitlab.example.test/api/v4/projects/group%2Fproject",
    "https://gitlab.example.test/api/v4/projects/group%2Fproject",
  ]);
  assert.equal(session.origin, "https://gitlab.example.test");
});

test("HTTPS fallback errors redact the credential already used for HTTP discovery", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "git@gitlab.example.test:group/project.git"]);
  const originalCredential = "fallback-original-credential-canary";
  const rotatedCredential = "fallback-rotated-credential-canary";
  let credentialReads = 0;
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { status: 404, body: {} });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
    status: 500, headers: { "x-request-id": originalCredential }, body: {},
  });
  const resolver = createGitLabTargetSessionResolver({
    credentials: {
      tokenForHost: async () => credentialReads++ === 0 ? originalCredential : rotatedCredential,
    },
    transport: fake,
  });

  await assert.rejects(resolver.resolve({ cwd: fixture.worktreePath }), (error: unknown) => {
    assert.equal(isToolError(error, "GITLAB_ERROR"), true);
    for (const credential of [originalCredential, rotatedCredential]) {
      assert.equal(JSON.stringify(error).includes(credential), false);
      assert.equal(inspect(error, { depth: 10 }).includes(credential), false);
    }
    return true;
  });
  assert.deepEqual(fake.requests.map((request) => request.headers["private-token"]), [originalCredential, originalCredential]);
  assert.equal(credentialReads, 1);
});

test("HTTPS fallback reuses only the discovery credential and later session requests obtain rotated credentials", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "git@gitlab.example.test:group/project.git"]);
  const originalCredential = "fallback-original-credential-canary";
  const rotatedCredential = "fallback-rotated-credential-canary";
  let credentialReads = 0;
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { status: 404, body: {} });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const resolver = createGitLabTargetSessionResolver({
    credentials: {
      tokenForHost: async () => credentialReads++ === 0 ? originalCredential : rotatedCredential,
    },
    transport: fake,
  });

  const session = await resolver.resolve({ cwd: fixture.worktreePath });
  const project = await session.gitlab.getProject("group/project");

  assert.equal(session.origin, "https://gitlab.example.test");
  assert.equal(project.id, "7");
  assert.equal(credentialReads, 2);
  assert.deepEqual(fake.requests.map((request) => request.headers["private-token"]), [
    originalCredential, originalCredential, rotatedCredential,
  ]);
  assert.deepEqual(fake.requests.map((request) => new URL(request.url).origin), [
    "http://gitlab.example.test", "https://gitlab.example.test", "https://gitlab.example.test",
  ]);
});

for (const remote of ["http://gitlab.example.test/group/project.git", "https://gitlab.example.test/group/project.git"]) {
  test(`explicit API scheme does not change on a failed lookup: ${remote}`, async (t) => {
    const fixture = await GitFixture.create();
    t.after(() => fixture.dispose());
    await fixture.git(["remote", "set-url", "origin", remote]);
    const urls: string[] = [];
    await assert.rejects(createGitLabTargetSessionResolver({
      credentials: { tokenForHost: async () => "fixed-project-token" },
      transport: { request: async (request: GitLabHttpRequest) => {
        urls.push(request.url);
        throw new Error("listener unavailable");
      } },
    }).resolve({ cwd: fixture.worktreePath }), (error: unknown) => isToolError(error, "GITLAB_ERROR"));
    assert.deepEqual(urls, [`${new URL(remote).origin}/api/v4/projects/group%2Fproject`]);
  });
}

test("inferred HTTP authentication rejection is returned without trying HTTPS", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "git@gitlab.example.test:group/project.git"]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { status: 401, body: { message: "Unauthorized" } });
  await assert.rejects(createGitLabTargetSessionResolver({
    credentials: { tokenForHost: async () => "rejected-project-token" }, transport: fake,
  }).resolve({ cwd: fixture.worktreePath }), (error: unknown) => isToolError(error, "AUTH_ERROR"));
  assert.deepEqual(fake.requests.map((request) => request.url), [
    "http://gitlab.example.test/api/v4/projects/group%2Fproject",
  ]);
});

test("HTTP upgrade redirects only select HTTPS on the same inferred host", async (t) => {
  const fixture = await GitFixture.create();
  t.after(() => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "git@gitlab.example.test:group/project.git"]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
    status: 301, headers: { location: "https://unrelated.example.test/steal" }, body: {},
  });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const session = await createGitLabTargetSessionResolver({
    credentials: { tokenForHost: async () => "redirect-project-token" }, transport: fake,
  }).resolve({ cwd: fixture.worktreePath });
  assert.equal(session.origin, "https://gitlab.example.test");
  assert.deepEqual(fake.requests.map((request) => request.url), [
    "http://gitlab.example.test/api/v4/projects/group%2Fproject",
    "https://gitlab.example.test/api/v4/projects/group%2Fproject",
  ]);
});

test("target GitLab session exposes one immutable canonical capability without credentials", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git([
    "remote",
    "set-url",
    "origin",
    "https://GitLab.Example.Test:443/group/project.git",
  ]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const resolver = createGitLabTargetSessionResolver({
    credentials: { tokenForHost: async () => "credential-canary-token" },
    transport: fake,
  });

  const session = await resolver.resolve({ cwd: fixture.worktreePath });

  assert.deepEqual(Object.keys(session).sort(), [
    "assertNoCredentialExposure",
    "gitlab",
    "identity",
    "origin",
    "project",
    "targetRemote",
  ]);
  assert.equal(session.origin, "https://gitlab.example.test");
  assert.deepEqual(session.identity, { host: "gitlab.example.test", path: "group/project" });
  assert.deepEqual(session.project, {
    id: "7",
    fullPath: "group/project",
    defaultBranch: "develop",
    webUrl: "https://gitlab.example.test/group/project",
  });
  assert.equal(session.targetRemote, "origin");
  assert.ok(session.gitlab instanceof GitLabClient);
  assert.equal("token" in session, false);
  assert.equal("tokenProvider" in session, false);
  assert.equal("credentials" in session, false);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.identity), true);
  assert.equal(Object.isFrozen(session.project), true);
  assert.equal(fake.requests.length, 1);
});

test("target GitLab session resolver rejects credentials in its canonical project before returning", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/7.git"]);
  const credential = "s3cr3t-canary-abc123";
  const reflectedProjects = [
    {
      ...projectResponse,
      path_with_namespace: `group/${credential}`,
    },
    {
      ...projectResponse,
      path_with_namespace: "group/project",
      default_branch: credential,
    },
    {
      ...projectResponse,
      path_with_namespace: "group/project",
      web_url: `https://gitlab.example.test/${credential}`,
    },
  ] as const;
  const fake = new FakeGitLab();
  for (const body of reflectedProjects) {
    fake.enqueue("GET", "/api/v4/projects/7", { body });
  }
  const resolver = createGitLabTargetSessionResolver({
    credentials: { tokenForHost: async () => credential },
    transport: fake,
  });

  for (const _body of reflectedProjects) {
    await assert.rejects(
      resolver.resolve({ cwd: fixture.worktreePath }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR") &&
        !`${error.message}\n${JSON.stringify(error.details)}`.includes(credential),
    );
  }
});

test("target GitLab session rejects local path remotes before reading credentials", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  const localRemotes = [
    String.raw`C:\repo\project.git`,
    "C:/repo/project.git",
    String.raw`C:repo\project.git`,
    "C:repo/project.git",
    String.raw`\\server\share\project.git`,
    "//server/share/project.git",
    "../project.git",
    "/var/tmp/project.git",
    "file:///C:/repo/project.git",
  ] as const;

  for (const remote of localRemotes) {
    await t.test(remote, async () => {
      await fixture.git(["remote", "set-url", "origin", remote]);
      let credentialReads = 0;
      const fake = new FakeGitLab();
      const resolver = createGitLabTargetSessionResolver({
        credentials: {
          tokenForHost: async () => {
            credentialReads += 1;
            return "credential-canary-token";
          },
        },
        transport: fake,
      });

      await assert.rejects(
        resolver.resolve({ cwd: fixture.worktreePath }),
        (error: unknown) => isToolError(error, "REPOSITORY_ERROR"),
      );
      assert.equal(credentialReads, 0);
      assert.equal(fake.requests.length, 0);
    });
  }
});

test("target GitLab session rejects current and rotated credentials without reflecting them", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/group/project.git"]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const credentials = ["s3cr3t-canary-abc123", "rotated-canary-def456"] as const;
  let reads = 0;
  const resolver = createGitLabTargetSessionResolver({
    credentials: {
      tokenForHost: async () => credentials[Math.min(reads++, credentials.length - 1)]!,
    },
    transport: fake,
  });

  const session = await resolver.resolve({ cwd: fixture.worktreePath });
  await session.gitlab.getProject("group/project");
  session.assertNoCredentialExposure({ detail: "ordinary diagnostic", nested: ["safe"] });

  for (const credential of credentials) {
    for (const reflected of [
      { description: credential },
      { [`response-${credential}`]: "safe" },
      { nested: [`Bearer ${credential}`] },
    ]) {
      assert.throws(
        () => session.assertNoCredentialExposure(reflected),
        (error: unknown) => isToolError(error, "INTERNAL_ERROR") &&
          !`${error.message}\n${JSON.stringify(error.details)}`.includes(credential),
      );
    }
  }
  assert.equal(reads, 2);
});

test("legacy target project resolver projects the session without exposing GitLab capability", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/group/project.git"]);
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", { body: projectResponse });
  const resolver = createGitLabTargetProjectResolver({
    credentials: { tokenForHost: async () => "credential-canary-token" },
    transport: fake,
  });

  const target = await resolver.resolve({ cwd: fixture.worktreePath });

  assert.deepEqual(Object.keys(target).sort(), ["identity", "project", "targetRemote"]);
  assert.equal("origin" in target, false);
  assert.equal("gitlab" in target, false);
});

test("legacy target projection checks credentials before dropping the session capability", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git(["remote", "set-url", "origin", "https://gitlab.example.test/group/project.git"]);
  const credential = "s3cr3t-canary-abc123";
  const fake = new FakeGitLab();
  fake.enqueue("GET", "/api/v4/projects/group%2Fproject", {
    body: { ...projectResponse, web_url: `https://gitlab.example.test/${credential}` },
  });
  const resolver = createGitLabTargetProjectResolver({
    credentials: { tokenForHost: async () => credential },
    transport: fake,
  });

  await assert.rejects(
    resolver.resolve({ cwd: fixture.worktreePath }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes(credential),
  );
});
