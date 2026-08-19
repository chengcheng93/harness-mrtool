import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  defaultExternalContextReader,
  readExternalContext,
  type ExternalContextReader,
  type ExternalContextReadOptions,
} from "../../src/app/external-context.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import type { GitContextSnapshot } from "../../src/app/get-context.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type {
  GitLabLabel,
  GitLabProject,
  GitLabUser,
} from "../../src/gitlab/types.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const targetSha = "a".repeat(40);
const sourceSha = "b".repeat(40);

type Bundle = Awaited<ReturnType<typeof loadTemplateBundle>>;

function bundleManifestHash(bundle: Bundle): string {
  return sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
}

function mutableLabel(
  restId: number,
  name: string,
  scope: "project" | "group" = "project",
): GitLabLabel {
  return {
    restId,
    globalId: `gid://gitlab/${scope === "project" ? "ProjectLabel" : "GroupLabel"}/${String(restId)}`,
    name,
    description: `${name} description`,
    color: "#123456",
    archived: false,
    scopeKind: scope,
    scopeId: scope === "project" ? "7" : "11",
    scopePath: scope === "project" ? "group/project" : "group",
  };
}

function mutableUser(
  id: string,
  username: string,
  accessLevel: number,
): GitLabUser {
  return {
    id,
    username,
    displayName: username[0]!.toUpperCase() + username.slice(1),
    state: "active",
    accessLevel,
  };
}

class ReadOnlyGitLabFixture {
  readonly origin = "https://gitlab.example.test";
  readonly calls: string[] = [];
  readonly auditRequestIds = ["req-a", "req-z"];
  readonly labels: GitLabLabel[] = [
    mutableLabel(2, "priority::p1"),
    mutableLabel(3, "status::doing"),
    mutableLabel(4, "status::review"),
    mutableLabel(1, "type::bug"),
    mutableLabel(21, "week::2026-w32-0803-0809", "group"),
  ];
  readonly users: GitLabUser[] = [
    mutableUser("40", "author", 30),
    mutableUser("42", "developer", 30),
    mutableUser("41", "maintainer", 40),
  ];
  targetProject: GitLabProject = {
    id: "7",
    fullPath: "group/project",
    defaultBranch: "develop",
    webUrl: "https://gitlab.example.test/group/project",
  };
  sourceProject: GitLabProject | null = null;
  branchHeads = [targetSha, targetSha];
  branchReadIndex = 0;
  mutationCalls = 0;

  async getProject(reference: string): Promise<GitLabProject> {
    this.calls.push(`getProject:${reference}`);
    if (reference === "fork/project" && this.sourceProject !== null) return this.sourceProject;
    return this.targetProject;
  }

  async getBranchHead(project: string, branch: string): Promise<string> {
    this.calls.push(`getBranchHead:${project}:${branch}`);
    const index = Math.min(this.branchReadIndex, this.branchHeads.length - 1);
    this.branchReadIndex += 1;
    return this.branchHeads[index]!;
  }

  async labelInventory(project: string) {
    this.calls.push(`labelInventory:${project}`);
    return { all: this.labels, effective: this.labels, audit: { requestIds: this.auditRequestIds } };
  }

  async listUsers(project: string): Promise<readonly GitLabUser[]> {
    this.calls.push(`listUsers:${project}`);
    return this.users;
  }

  async getCurrentUser(): Promise<GitLabUser> {
    this.calls.push("getCurrentUser");
    return this.users[0]!;
  }

  async createMergeRequest(): Promise<never> {
    this.mutationCalls += 1;
    throw new Error("readExternalContext attempted a create mutation");
  }

  async updateMergeRequest(): Promise<never> {
    this.mutationCalls += 1;
    throw new Error("readExternalContext attempted an update mutation");
  }

  async setMergeRequestLabels(): Promise<never> {
    this.mutationCalls += 1;
    throw new Error("readExternalContext attempted a label mutation");
  }

  audit() {
    this.calls.push("audit");
    return { requestIds: this.auditRequestIds };
  }
}

function localChecks(): GitContextSnapshot["localChecks"] {
  return {
    commitConvention: { status: "passed", evidence: "Conventional commits were checked." },
    secretScan: { status: "passed", evidence: "Secret scan passed." },
    repositoryHygiene: { status: "passed", evidence: "Repository hygiene was checked." },
  };
}

function readOptions(
  api: ReadOnlyGitLabFixture,
  bundle: Bundle,
  gitOverrides: Partial<GitContextSnapshot> = {},
): ExternalContextReadOptions {
  return {
    operation: "create",
    gitlabOrigin: api.origin,
    targetProject: "group/project",
    mrIid: null,
    issueIid: null,
    git: {
      sourceProject: { id: "7", path: "group/project" },
      sourceBranch: "fix/51-labels",
      targetBranch: "develop",
      targetRefSha: targetSha,
      mergeBaseSha: targetSha,
      sourceHeadSha: sourceSha,
      localChecks: localChecks(),
      ...gitOverrides,
    },
    bundle,
    release: {
      releaseSetId: "stable-1",
      releaseTag: "templates-v1.0.0",
      bundleManifestHash: bundleManifestHash(bundle),
      cliVersion: "0.1.0-dev",
      skillProtocol: 1,
    },
    gitlab: api as unknown as GitLabClient,
  };
}

test("reads a canonical tokenless external context without using a caller store or remote mutation", async () => {
  const stateRoot = await mkdtemp(resolve(tmpdir(), "hmr-external-context-"));
  try {
    const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
    const api = new ReadOnlyGitLabFixture();
    const options = readOptions(api, bundle);
    const diskStore = new CandidateContextStore({
      stateDirectory: stateRoot,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const optionsWithUntrustedStore = { ...options, store: diskStore };

    const context = await readExternalContext(optionsWithUntrustedStore);

    assert.deepEqual(await readdir(stateRoot), []);
    assert.equal(api.mutationCalls, 0);
    assert.deepEqual(api.calls, [
      "getProject:group/project",
      "getBranchHead:7:develop",
      "labelInventory:7",
      "listUsers:7",
      "getCurrentUser",
      "getProject:group/project",
      "getBranchHead:7:develop",
      "audit",
    ]);
    assert.deepEqual(context.binding.targetProject, { id: "7", fullPath: "group/project" });
    assert.equal(context.snapshot.targetRefSha, targetSha);
    assert.deepEqual(context.requiredLabelCategories, ["week", "type", "priority"]);
    assert.deepEqual(context.lifecycleLabelNames, {
      draft: "status::doing",
      ready: "status::review",
      merge: "status::review",
    });
    assert.deepEqual(context.audit, { requestIds: ["req-a", "req-z"] });
    assert.deepEqual(context.candidates, [
      {
        kind: "label", restId: 2, globalId: "gid://gitlab/ProjectLabel/2",
        name: "priority::p1", description: "priority::p1 description", color: "#123456",
        scopeKind: "project", scopeId: "7", scopePath: "group/project", policyCategory: "priority",
      },
      {
        kind: "label", restId: 1, globalId: "gid://gitlab/ProjectLabel/1",
        name: "type::bug", description: "type::bug description", color: "#123456",
        scopeKind: "project", scopeId: "7", scopePath: "group/project", policyCategory: "type",
      },
      {
        kind: "label", restId: 21, globalId: "gid://gitlab/GroupLabel/21",
        name: "week::2026-w32-0803-0809", description: "week::2026-w32-0803-0809 description", color: "#123456",
        scopeKind: "group", scopeId: "11", scopePath: "group", policyCategory: "week",
      },
      { kind: "assignee", userId: "40", globalId: "gid://gitlab/User/40", username: "author", displayName: "Author" },
      { kind: "assignee", userId: "42", globalId: "gid://gitlab/User/42", username: "developer", displayName: "Developer" },
      { kind: "assignee", userId: "41", globalId: "gid://gitlab/User/41", username: "maintainer", displayName: "Maintainer" },
      { kind: "reviewer", userId: "42", globalId: "gid://gitlab/User/42", username: "developer", displayName: "Developer" },
      { kind: "reviewer", userId: "41", globalId: "gid://gitlab/User/41", username: "maintainer", displayName: "Maintainer" },
    ]);

    const serialized = JSON.stringify(context);
    assert.doesNotMatch(serialized, /(?:hmrc1_|hmrx1_)[A-Za-z0-9_-]{43}/u);
    assert.equal(serialized.includes("hmrc1_"), false);
    assert.equal(serialized.includes("hmrx1_"), false);
    assert.equal("contextId" in context, false);
    assert.equal(context.candidates.some((candidate) => "token" in candidate), false);

    assert.equal(Object.isFrozen(context), true);
    assert.equal(Object.isFrozen(context.binding), true);
    assert.equal(Object.isFrozen(context.binding.targetProject), true);
    assert.equal(Object.isFrozen(context.snapshot), true);
    assert.equal(Object.isFrozen(context.snapshot.localChecks.commitConvention), true);
    assert.equal(Object.isFrozen(context.candidates), true);
    assert.equal(context.candidates.every(Object.isFrozen), true);
    assert.equal(Object.isFrozen(context.lifecycleLabelNames), true);
    assert.equal(Object.isFrozen(context.audit.requestIds), true);
    assert.throws(() => {
      (context.binding.targetProject as { id: string }).id = "99";
    }, TypeError);
    assert.throws(() => {
      (context.candidates as unknown as unknown[]).push({});
    }, TypeError);

    (api.labels[0] as { name: string }).name = "priority::changed";
    (api.users[0] as { username: string }).username = "changed-author";
    (api.targetProject as { fullPath: string }).fullPath = "changed/project";
    api.auditRequestIds[0] = "req-changed";
    (options.git.localChecks.commitConvention as { evidence: string }).evidence = "Changed evidence.";
    const firstCandidate = context.candidates[0];
    assert.equal(firstCandidate?.kind === "label" ? firstCandidate.name : null, "priority::p1");
    assert.equal(context.snapshot.userCandidates[0]!.username, "author");
    assert.equal(context.binding.targetProject.fullPath, "group/project");
    assert.deepEqual(context.audit.requestIds, ["req-a", "req-z"]);
    assert.equal(context.snapshot.localChecks.commitConvention.evidence, "Conventional commits were checked.");
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("preserves getContext source-project identity failures", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const api = new ReadOnlyGitLabFixture();
  api.sourceProject = {
    id: "99",
    fullPath: "fork/wrong",
    defaultBranch: "develop",
    webUrl: "https://gitlab.example.test/fork/wrong",
  };

  await assert.rejects(readExternalContext(readOptions(api, bundle, {
    sourceProject: { id: "8", path: "fork/project" },
  })), (error: unknown) => typeof error === "object" && error !== null &&
    "code" in error && error.code === "GITLAB_ERROR" &&
    "message" in error && error.message === "Source project identity does not match the local Git snapshot");
  assert.deepEqual(api.calls, ["getProject:group/project", "getProject:fork/project"]);
  assert.equal(api.mutationCalls, 0);
});

test("exposes a readonly capture-backed reader port for production injection", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const api = new ReadOnlyGitLabFixture();
  const reader: ExternalContextReader = defaultExternalContextReader;

  const context = await reader.read(readOptions(api, bundle));

  assert.equal(Object.isFrozen(reader), true);
  assert.equal(context.candidates.length, 8);
  assert.doesNotMatch(JSON.stringify(context), /hmr[cx]1_/u);
});

test("preserves getContext final target-head drift failures", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const api = new ReadOnlyGitLabFixture();
  api.branchHeads = [targetSha, "f".repeat(40)];

  await assert.rejects(readExternalContext(readOptions(api, bundle)), (error: unknown) =>
    typeof error === "object" && error !== null &&
    "code" in error && error.code === "GITLAB_ERROR" &&
    "message" in error && error.message === "Target branch moved during context discovery");
  assert.equal(api.branchReadIndex, 2);
  assert.equal(api.calls.includes("audit"), false);
  assert.equal(api.mutationCalls, 0);
});
