import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { defaultExternalContextReader } from "../../src/app/external-context.ts";
import { getContext } from "../../src/app/get-context.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import {
  createReadOnlyCommandServices,
  type PreparedReadOnlyContext,
  type ReadOnlyCommandDependencies,
} from "../../src/cli/commands/readonly.ts";
import { createProductionCommandHandlers } from "../../src/cli/commands/production.ts";
import { executeCliJson } from "../../src/cli/execute.ts";
import { normalizeProductionRequest } from "../../src/cli/production-input.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import type { Candidate, IssueContextInput, IssuedContext, ResolvedContext } from "../../src/context/types.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabLabel, GitLabProject, GitLabUser } from "../../src/gitlab/types.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { runProductionMain } from "../../src/production-main.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const targetSha = "a".repeat(40);
const sourceSha = "b".repeat(40);
const contextId = `hmrx1_${"x".repeat(43)}`;

function candidateToken(index: number): string {
  return `hmrc1_${String(index).padStart(43, "0")}`;
}

function label(
  restId: number,
  name: string,
  scopeKind: "project" | "group" = "project",
): GitLabLabel {
  return {
    restId,
    globalId: `gid://gitlab/${scopeKind === "project" ? "ProjectLabel" : "GroupLabel"}/${String(restId)}`,
    name,
    description: `${name} description`,
    color: "#123456",
    archived: false,
    scopeKind,
    scopeId: scopeKind === "project" ? "7" : "11",
    scopePath: scopeKind === "project" ? "group/project" : "group",
  };
}

function user(id: string, username: string, accessLevel: number): GitLabUser {
  return {
    id,
    username,
    displayName: username[0]!.toUpperCase() + username.slice(1),
    state: "active",
    accessLevel,
  };
}

class ReadOnlyGitLab {
  readonly origin = "https://gitlab.example.test";
  readonly credentialCanary = "glpat-production-readonly-canary";
  readonly calls: string[] = [];
  readonly labels: GitLabLabel[] = [
    label(30, "priority::p1"),
    label(40, "status::doing"),
    label(50, "status::review"),
    label(20, "type::bug"),
    label(10, "week::2026-w32-0803-0809", "group"),
  ];
  readonly users: GitLabUser[] = [
    user("40", "author", 30),
    user("42", "developer", 30),
    user("41", "maintainer", 40),
  ];
  readonly requestIds: string[] = ["request-a", "request-z"];
  mutationCalls = 0;

  async getProject(reference: string): Promise<GitLabProject> {
    this.calls.push(`getProject:${reference}`);
    return {
      id: "7",
      fullPath: "group/project",
      defaultBranch: "develop",
      webUrl: "https://gitlab.example.test/group/project",
    };
  }

  async getBranchHead(project: string, branch: string): Promise<string> {
    this.calls.push(`getBranchHead:${project}:${branch}`);
    return targetSha;
  }

  async labelInventory(project: string) {
    this.calls.push(`labelInventory:${project}`);
    return {
      all: this.labels,
      effective: this.labels,
      audit: { requestIds: this.requestIds },
    };
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
    throw new Error("read-only command attempted a create mutation");
  }

  async updateMergeRequest(): Promise<never> {
    this.mutationCalls += 1;
    throw new Error("read-only command attempted an update mutation");
  }

  async setMergeRequestLabels(): Promise<never> {
    this.mutationCalls += 1;
    throw new Error("read-only command attempted a label mutation");
  }

  audit() {
    this.calls.push("audit");
    return { requestIds: this.requestIds };
  }
}

interface CapturedOutput {
  readonly code: string;
  readonly data: Record<string, unknown> | null;
  readonly ok: boolean;
  readonly remoteWrite: { readonly operations: readonly string[]; readonly state: string };
}

function bearerPaths(value: unknown): readonly string[] {
  const paths: string[] = [];
  const visit = (entry: unknown, path: readonly (string | number)[]): void => {
    if (typeof entry === "string" && /^(?:hmrc1_|hmrx1_)[A-Za-z0-9_-]{43}$/u.test(entry)) {
      paths.push(path.join("."));
      return;
    }
    if (Array.isArray(entry)) {
      entry.forEach((child, index) => visit(child, [...path, index]));
    } else if (entry !== null && typeof entry === "object") {
      for (const [key, child] of Object.entries(entry)) visit(child, [...path, key]);
    }
  };
  visit(value, []);
  return paths;
}

async function fixture() {
  const [bundle, rawRequest] = await Promise.all([
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
    readFile(resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"), "utf8").then(JSON.parse),
  ]);
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  const selection = {
    bundle,
    bundleManifestHash,
    releaseSetId: `embedded:${bundleManifestHash}`,
    releaseTag: `templates-v${bundle.manifest.version}`,
  } as const;
  const api = new ReadOnlyGitLab();
  const issuedByToken = new Map<string, Candidate>();
  const storeCalls = {
    issue: 0,
    resolve: [] as boolean[],
  };
  let capturedInput: IssueContextInput | null = null;
  const store = {
    async issue(input: IssueContextInput): Promise<IssuedContext> {
      storeCalls.issue += 1;
      capturedInput = input;
      const candidates = input.candidates.map((metadata, index) => {
        const token = candidateToken(index);
        issuedByToken.set(token, metadata);
        return { kind: metadata.kind, token, metadata };
      });
      return {
        contextId,
        createdAtMs: 1_000,
        expiresAtMs: 1_801_000,
        externalSnapshotDigest: sha256Utf8(canonicalizeJson(input.snapshot)),
        candidates,
      };
    },
    async resolve(input: {
      readonly contextId: string;
      readonly expectedBinding: IssueContextInput["binding"];
      readonly selections: readonly { readonly token: string; readonly kind: Candidate["kind"] }[];
      readonly consume?: boolean;
    }): Promise<ResolvedContext> {
      storeCalls.resolve.push(input.consume === true);
      assert.equal(input.contextId, contextId);
      assert.ok(capturedInput);
      assert.equal(canonicalizeJson(input.expectedBinding), canonicalizeJson(capturedInput.binding));
      const candidates = input.selections.map((selection_) => {
        const candidate = issuedByToken.get(selection_.token);
        assert.ok(candidate);
        assert.equal(candidate.kind, selection_.kind);
        return candidate;
      });
      return {
        contextId,
        createdAtMs: 1_000,
        expiresAtMs: 1_801_000,
        binding: capturedInput.binding,
        externalSnapshotDigest: sha256Utf8(canonicalizeJson(capturedInput.snapshot)),
        snapshot: capturedInput.snapshot,
        candidates,
      };
    },
  };
  const options = {
    operation: "create" as const,
    gitlabOrigin: api.origin,
    targetProject: "group/project",
    mrIid: null,
    issueIid: null,
    git: {
      sourceProject: { id: "7", path: "group/project" },
      sourceBranch: "feature/read-only",
      sourceRemote: "origin",
      sourceRemoteRef: "refs/heads/feature/read-only",
      targetBranch: "develop",
      targetRemote: "origin",
      targetRef: "refs/remotes/origin/develop",
      targetRefSha: targetSha,
      mergeBaseSha: targetSha,
      sourceHeadSha: sourceSha,
      localChecks: {
        commitConvention: { status: "passed" as const, evidence: "Commit convention checked." },
        secretScan: { status: "passed" as const, evidence: "Secret scan checked." },
        repositoryHygiene: { status: "passed" as const, evidence: "Repository hygiene checked." },
      },
    },
    bundle,
    release: {
      releaseSetId: selection.releaseSetId,
      releaseTag: selection.releaseTag,
      bundleManifestHash,
      cliVersion: "0.1.0-test",
      skillProtocol: 1,
    },
    gitlab: api as unknown as GitLabClient,
  };
  const plan: PreparedReadOnlyContext = {
    assertNoCredentialExposure: () => {},
    selection,
    options,
    profileDetection: {
      kind: "detected",
      profileIds: ["code", "docs"],
      reasons: [
        { code: "matched-versioned-profile-rules", profileId: "code" },
        { code: "matched-versioned-profile-rules", profileId: "docs" },
      ],
    },
    gitDiffSummary: {
      changedFileCount: 2,
      targetRefSha: targetSha,
      mergeBaseSha: targetSha,
      sourceHeadSha: sourceSha,
    },
    pushPlan: {
      kind: "up-to-date",
      remote: "origin",
      ref: "refs/heads/feature/read-only",
      sourceHeadSha: sourceSha,
      remoteSha: sourceSha,
      command: null,
    },
    mergeRequestPlan: { action: "create", iid: null, webUrl: null },
  };
  const plannerCalls: string[] = [];
  const planner = {
    pushes: 0,
    async prepare(input: { readonly command: string }): Promise<PreparedReadOnlyContext> {
      plannerCalls.push(input.command);
      return plan;
    },
    async push(): Promise<void> {
      this.pushes += 1;
    },
  };
  const doctorCalls: string[] = [];
  const doctorProbe = {
    async inspect(): Promise<{
      readonly checks: readonly { readonly id: string; readonly status: "passed"; readonly detail: string }[];
      readonly capabilities: { readonly labelIdMutation: boolean; readonly graphQlMutation: boolean };
    }> {
      doctorCalls.push("doctor");
      return {
        checks: [
          { id: "repository", status: "passed", detail: "Git repository detected." },
          { id: "gitlab-auth", status: "passed", detail: "GitLab read access verified." },
        ],
        capabilities: { labelIdMutation: true, graphQlMutation: true },
      };
    },
  };
  const request = normalizeAndValidateRequest({
    ...rawRequest,
    contextId,
    targetBranch: "develop",
    workItem: {
      relation: "none",
      noIssueReason: "This production composition test has no linked issue.",
    },
    mergeRequest: {
      ...rawRequest.mergeRequest,
      labelCandidateTokens: [candidateToken(2), candidateToken(1), candidateToken(0)],
      assigneeCandidateToken: candidateToken(3),
    },
    review: {
      ...rawRequest.review,
      reviewerCandidateTokens: [candidateToken(7)],
    },
  });
  let externalContextReads = 0;
  const dependencies: ReadOnlyCommandDependencies = {
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle: selection,
    contextStore: store,
    planner,
    doctorProbe,
    requestSource: { read: async () => request },
    externalContextReader: {
      read: async (input) => {
        externalContextReads += 1;
        return defaultExternalContextReader.read(input);
      },
    },
    resolveCandidates: async ({ request: request_, expectedBinding, store: store_, consume }) => {
      const resolved = await store_.resolve({
        contextId: request_.contextId,
        expectedBinding,
        selections: [
          ...request_.mergeRequest.labelCandidateTokens.map((token) => ({ kind: "label" as const, token })),
          ...(request_.mergeRequest.assigneeCandidateToken === null
            ? []
            : [{ kind: "assignee" as const, token: request_.mergeRequest.assigneeCandidateToken }]),
          ...request_.review.reviewerCandidateTokens.map((token) => ({ kind: "reviewer" as const, token })),
        ],
        consume,
      });
      return {
        binding: resolved.binding,
        snapshot: resolved.snapshot,
        candidates: resolved.candidates,
        candidateSelectionDigest: sha256Utf8(canonicalizeJson({
          contextId: request_.contextId,
          selections: request_.mergeRequest.labelCandidateTokens,
        })),
      };
    },
  };
  const handlers = createProductionCommandHandlers({
    cliVersion: dependencies.cliVersion,
    ...createReadOnlyCommandServices(dependencies),
  });

  async function run(
    arguments_: readonly string[],
    selectedHandlers: typeof handlers = handlers,
  ): Promise<{ readonly output: CapturedOutput; readonly serialized: string }> {
    const chunks: string[] = [];
    const result = await executeCliJson(arguments_, {
      cliVersion: dependencies.cliVersion,
      handlers: selectedHandlers,
      stdout: {
        write(chunk, callback) {
          chunks.push(chunk);
          callback();
          return true;
        },
      },
    });
    const serialized = chunks.join("");
    const output = JSON.parse(serialized) as CapturedOutput;
    assert.equal(result.exitCode === 0, output.ok, serialized);
    return { output, serialized };
  }

  return {
    api,
    dependencies,
    doctorCalls,
    handlers,
    planner,
    plannerCalls,
    plan,
    request,
    run,
    selection,
    storeCalls,
    externalContextReads: () => externalContextReads,
  };
}

test("doctor, context, labels.list, and preview stay read-only while context alone issues bearers", async () => {
  const harness = await fixture();

  const doctor = await harness.run(["doctor", "--output", "json"]);
  const context = await harness.run(["context", "--output", "json"]);
  const labels = await harness.run(["labels", "list", "--output", "json"]);
  const preview = await harness.run(["preview", "--input", "request.json", "--output", "json"]);
  const repeatedPreview = await harness.run(["preview", "--input", "request.json", "--output", "json"]);

  assert.equal(doctor.output.ok, true);
  assert.equal(context.output.ok, true);
  assert.equal(labels.output.ok, true);
  assert.equal(preview.output.ok, true);
  assert.equal(repeatedPreview.output.ok, true);
  const contextData = context.output.data;
  const inputSchema = contextData?.inputSchema as {
    readonly definitions?: {
      readonly mergeRequest?: { readonly properties?: Record<string, unknown> };
    };
  };
  assert.deepEqual(
    inputSchema.definitions?.mergeRequest?.properties?.assigneeCandidateToken,
    { anyOf: [{ type: "null" }, { $ref: "#/definitions/opaque" }] },
  );
  const snapshot = contextData?.snapshot as {
    readonly localChecks?: Record<string, unknown>;
  };
  assert.equal("secretScan" in (snapshot.localChecks ?? {}), false);
  assert.deepEqual(snapshot.localChecks?.contentSafetyScan, {
    status: "passed",
    evidence: "Secret scan checked.",
  });
  assert.deepEqual(harness.doctorCalls, ["doctor"]);
  assert.deepEqual(harness.plannerCalls, ["context", "labels.list", "preview", "preview"]);
  assert.equal(harness.storeCalls.issue, 1);
  assert.deepEqual(harness.storeCalls.resolve, [false, false]);
  assert.equal(harness.externalContextReads(), 3);
  assert.equal(harness.api.mutationCalls, 0);
  assert.equal(harness.planner.pushes, 0);
  assert.equal(harness.api.calls.filter((call) => call === "audit").length, 4);
  for (const result of [doctor, context, labels, preview, repeatedPreview]) {
    assert.equal(result.output.remoteWrite.state, "not-attempted");
    assert.deepEqual(result.output.remoteWrite.operations, []);
    assert.doesNotMatch(result.serialized, /glpat-production-readonly-canary/u);
  }

  assert.deepEqual(bearerPaths(context.output.data), [
    "contextId",
    "labelCandidates.0.token",
    "labelCandidates.1.token",
    "labelCandidates.2.token",
    "userCandidates.0.token",
    "userCandidates.1.token",
    "userCandidates.2.token",
    "userCandidates.3.token",
    "userCandidates.4.token",
  ]);
  assert.deepEqual(bearerPaths(labels.output.data), []);
  assert.deepEqual(bearerPaths(preview.output.data), []);

  const previewData = preview.output.data!;
  assert.equal(typeof previewData.title, "string");
  assert.equal((previewData.description as string).match(/^## /gmu)?.length, 8);
  assert.deepEqual(previewData.profileSelectionReasons, [
    { code: "matched-versioned-profile-rules", profileId: "code" },
    { code: "matched-versioned-profile-rules", profileId: "docs" },
  ]);
  assert.deepEqual(previewData.mergeRequestPlan, { action: "create", iid: null, webUrl: null });
  assert.deepEqual((previewData.labels as readonly { readonly name: string }[]).map((entry) => entry.name), [
    "week::2026-w32-0803-0809",
    "type::bug",
    "priority::p1",
    "status::review",
  ]);
});

test("text presentation invokes context once and never prints bearer or credential values", async () => {
  const harness = await fixture();
  const packageVersion = (JSON.parse(await readFile(
    resolve(repositoryRoot, "package.json"),
    "utf8",
  )) as { readonly version: string }).version;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const readOnly = {
    ...harness.dependencies,
    planner: {
      ...harness.dependencies.planner,
      prepare: async (input: Parameters<typeof harness.dependencies.planner.prepare>[0]) => {
        const prepared = await harness.dependencies.planner.prepare(input);
        return {
          ...prepared,
          options: {
            ...prepared.options,
            release: { ...prepared.options.release, cliVersion: packageVersion },
          },
        };
      },
    },
  };
  const exitCode = await runProductionMain(["context"], {
    cwd: harness.dependencies.cwd,
    loadCurrentBundle: async () => harness.selection,
    profileRepository: {
      discover: async (): Promise<never> => { throw new Error("profile detection must remain lazy"); },
      readChangeSet: async (): Promise<never> => { throw new Error("change set must remain lazy"); },
    },
    targetProjectResolver: {
      resolve: async (): Promise<never> => { throw new Error("target resolution must remain lazy"); },
    },
    readOnly,
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
  });

  const text = stdout.join("");
  assert.equal(exitCode, 0, `${stderr.join("") || text}\n${JSON.stringify({
    plannerCalls: harness.plannerCalls,
    storeCalls: harness.storeCalls,
    gitlabCalls: harness.api.calls,
  })}`);
  assert.equal(text, "Command: context\nStatus: completed\n");
  assert.equal(stderr.join(""), "");
  assert.deepEqual(harness.plannerCalls, ["context"]);
  assert.equal(harness.storeCalls.issue, 1);
  assert.doesNotMatch(text, /(?:hmrc1_|hmrx1_)[A-Za-z0-9_-]{43}/u);
  assert.equal(text.includes(harness.api.credentialCanary), false);
});

test("text presentation reports only the sanitized failure code and message", async () => {
  const harness = await fixture();
  const credential = "glpat-text-failure-must-not-leak";
  const stderr: string[] = [];

  const exitCode = await runProductionMain(["context"], {
    cwd: harness.dependencies.cwd,
    loadCurrentBundle: async () => harness.selection,
    profileRepository: {
      discover: async (): Promise<never> => { throw new Error("profile detection must remain lazy"); },
      readChangeSet: async (): Promise<never> => { throw new Error("change set must remain lazy"); },
    },
    targetProjectResolver: {
      resolve: async (): Promise<never> => { throw new Error("target resolution must remain lazy"); },
    },
    readOnly: {
      ...harness.dependencies,
      planner: {
        prepare: async (): Promise<never> => {
          throw new ToolError("REPOSITORY_ERROR", `Repository failed: ${credential}`, {
            field: "repository",
            expected: "a safe repository snapshot",
            actual: credential,
            safeNextStep: `Remove ${credential} and retry.`,
          });
        },
      },
    },
    stdout: { write: () => true },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
  });

  assert.equal(exitCode, 7);
  assert.equal(stderr.join(""), "INTERNAL_ERROR: The command failed safely\n");
  assert.doesNotMatch(stderr.join(""), /glpat-text-failure-must-not-leak|REPOSITORY_ERROR/u);
});

test("context, labels.list, and preview reject arbitrary reflected GitLab credentials", async () => {
  const harness = await fixture();
  const credential = "s3cr3t-canary-abc123";
  (harness.api.labels[0] as { description: string }).description = credential;
  (harness.api.users[0] as { displayName: string }).displayName = credential;
  harness.api.requestIds[0] = credential;
  const guardedPlan: PreparedReadOnlyContext = {
    ...harness.plan,
    assertNoCredentialExposure: (value) => {
      if (JSON.stringify(value).includes(credential)) {
        throw new ToolError("INTERNAL_ERROR", "GitLab response failed credential isolation", {
          field: "gitlab.response",
          expected: "credential-free canonical GitLab response data",
          actual: "unsafe GitLab response data",
          safeNextStep: "Retry after removing credential reflection from GitLab metadata.",
        });
      }
    },
  };
  const handlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      planner: { prepare: async () => guardedPlan },
    }),
  });

  const results = [
    await harness.run(["context", "--output", "json"], handlers),
    await harness.run(["labels", "list", "--output", "json"], handlers),
    await harness.run(["preview", "--input", "request.json", "--output", "json"], handlers),
  ];

  for (const result of results) {
    assert.equal(result.output.ok, false);
    assert.equal(result.output.code, "INTERNAL_ERROR");
    assert.doesNotMatch(result.serialized, new RegExp(credential, "u"));
    assert.deepEqual(result.output.remoteWrite, { state: "not-attempted", operations: [] });
  }
  assert.equal(harness.api.mutationCalls, 0);
  assert.equal(harness.planner.pushes, 0);
});

test("unexpected dependency failures cannot reflect credentials", async () => {
  const harness = await fixture();
  const credential = "glpat-never-reflect-this-value";
  const handlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      doctorProbe: { inspect: async () => { throw new Error(credential); } },
    }),
  });
  const chunks: string[] = [];

  const result = await executeCliJson(["doctor", "--output", "json"], {
    cliVersion: harness.dependencies.cliVersion,
    handlers,
    stdout: {
      write(chunk, callback) {
        chunks.push(chunk);
        callback();
        return true;
      },
    },
  });

  assert.equal(result.exitCode, 7);
  assert.doesNotMatch(chunks.join(""), new RegExp(credential, "u"));
  assert.equal((JSON.parse(chunks.join("")) as CapturedOutput).code, "INTERNAL_ERROR");
  assert.equal(harness.api.mutationCalls, 0);
  assert.equal(harness.planner.pushes, 0);
});

test("context bearer output is rejected outside the authorized data paths", async () => {
  const harness = await fixture();
  harness.api.requestIds[0] = candidateToken(99);

  const result = await harness.run(["context", "--output", "json"]);

  assert.equal(result.output.ok, false);
  assert.equal(result.output.code, "INTERNAL_ERROR");
  assert.deepEqual(bearerPaths(result.output), []);
  assert.doesNotMatch(result.serialized, new RegExp(candidateToken(99), "u"));
  assert.equal(harness.api.mutationCalls, 0);
  assert.equal(harness.planner.pushes, 0);
});

test("context fails closed when an injected issuer returns an invalid bearer contract", async () => {
  const harness = await fixture();
  const handlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      issueContext: async (options) => ({
        ...await getContext(options),
        contextId: "invalid-context-id",
      }),
    }),
  });
  const chunks: string[] = [];

  const result = await executeCliJson(["context", "--output", "json"], {
    cliVersion: harness.dependencies.cliVersion,
    handlers,
    stdout: {
      write(chunk, callback) {
        chunks.push(chunk);
        callback();
        return true;
      },
    },
  });

  assert.equal(result.exitCode, 7);
  const output = JSON.parse(chunks.join("")) as CapturedOutput;
  assert.equal(output.ok, false);
  assert.equal(output.code, "INTERNAL_ERROR");
  assert.doesNotMatch(chunks.join(""), /invalid-context-id/u);
  assert.equal(harness.api.mutationCalls, 0);
  assert.equal(harness.planner.pushes, 0);
});

test("preview normalizes its Request before planning and passes only the normalized snapshot", async () => {
  const harness = await fixture();
  assert.equal((await harness.run(["context", "--output", "json"])).output.ok, true);
  const order: string[] = [];
  const services = createReadOnlyCommandServices({
    ...harness.dependencies,
    requestSource: {
      read: async () => {
        order.push("request");
        return JSON.parse(JSON.stringify(harness.request)) as unknown;
      },
    },
    planner: {
      prepare: async (input) => {
        order.push("planner");
        const plannerInput = input as typeof input & {
          readonly contextIssueIid?: number | null;
          readonly request?: unknown;
        };
        assert.deepEqual(plannerInput.request, harness.request);
        assert.equal(Object.isFrozen(plannerInput.request), true);
        assert.equal(plannerInput.contextIssueIid, null);
        return harness.plan;
      },
    },
  });

  const execution = await services.preview!(
    parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]) as never,
  );

  assert.equal(execution.output?.data?.command, "preview");
  assert.deepEqual(order, ["request", "planner"]);
});

test("preview reuses the production-normalized Request without rebuilding it", async () => {
  const harness = await fixture();
  assert.equal((await harness.run(["context", "--output", "json"])).output.ok, true);
  const request = normalizeProductionRequest(JSON.parse(JSON.stringify(harness.request)) as unknown);
  const services = createReadOnlyCommandServices({
    ...harness.dependencies,
    requestSource: { read: async () => request },
    planner: {
      prepare: async (input) => {
        assert.strictEqual(input.request, request);
        assert.equal(Object.isFrozen(input.request), true);
        return harness.plan;
      },
    },
  });

  const execution = await services.preview!(
    parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]) as never,
  );

  assert.equal(execution.output?.data?.command, "preview");
});

test("every read-only success projection rejects secret-shaped keys and values without reflection", async () => {
  const harness = await fixture();
  const canary = "credential-canary-never-reflect";
  const maliciousPlan: PreparedReadOnlyContext = {
    ...harness.plan,
    gitDiffSummary: {
      ...harness.plan.gitDiffSummary,
      Authorization: `Bearer ${canary}`,
    },
  };
  const commandCases = [
    ["context", "--output", "json"],
    ["labels", "list", "--output", "json"],
    ["preview", "--input", "request.json", "--output", "json"],
  ] as const;

  for (const arguments_ of commandCases) {
    const handlers = createProductionCommandHandlers({
      cliVersion: harness.dependencies.cliVersion,
      ...createReadOnlyCommandServices({
        ...harness.dependencies,
        planner: { prepare: async () => maliciousPlan },
      }),
    });
    const result = await harness.run(arguments_, handlers);
    assert.equal(result.output.ok, false, `${arguments_.join(" ")} unexpectedly succeeded`);
    assert.equal(result.output.code, "INTERNAL_ERROR");
    assert.doesNotMatch(result.serialized, new RegExp(canary, "u"));
  }

  const doctorHandlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      doctorProbe: {
        inspect: async () => ({
          checks: [{ id: "gitlab", status: "passed", detail: `Private-Token: ${canary}` }],
          capabilities: {
            [`credential-${canary}`]: true,
            [`hmrc1_${"k".repeat(43)}`]: true,
          },
          audit: { requestIds: [`Job-Token: ${canary}`] },
        }),
      },
    }),
  });
  const doctor = await harness.run(["doctor", "--output", "json"], doctorHandlers);
  assert.equal(doctor.output.ok, false);
  assert.equal(doctor.output.code, "INTERNAL_ERROR");
  assert.doesNotMatch(doctor.serialized, new RegExp(canary, "u"));

  const bearerKey = `hmrc1_${"k".repeat(43)}`;
  const bearerKeyHandlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      doctorProbe: {
        inspect: async () => ({
          checks: [{ id: "gitlab", status: "passed", detail: "GitLab read completed." }],
          capabilities: { [bearerKey]: true },
        }),
      },
    }),
  });
  const bearerKeyDoctor = await harness.run(["doctor", "--output", "json"], bearerKeyHandlers);
  assert.equal(bearerKeyDoctor.output.ok, false);
  assert.equal(bearerKeyDoctor.output.code, "INTERNAL_ERROR");
  assert.doesNotMatch(bearerKeyDoctor.serialized, new RegExp(bearerKey, "u"));
});

test("read-only ports reject unknown fields instead of accepting partial structural matches", async () => {
  const harness = await fixture();
  const cases = [
    createProductionCommandHandlers({
      cliVersion: harness.dependencies.cliVersion,
      ...createReadOnlyCommandServices({
        ...harness.dependencies,
        doctorProbe: {
          inspect: async () => ({
            checks: [{
              id: "repository",
              status: "passed" as const,
              detail: "Repository is readable.",
              unexpected: true,
            }],
            capabilities: { labelIdMutation: true },
          }),
        },
      }),
    }),
    createProductionCommandHandlers({
      cliVersion: harness.dependencies.cliVersion,
      ...createReadOnlyCommandServices({
        ...harness.dependencies,
        planner: {
          prepare: async () => ({
            ...harness.plan,
            pushPlan: { ...harness.plan.pushPlan, unexpected: true },
          }),
        },
      }),
    }),
    createProductionCommandHandlers({
      cliVersion: harness.dependencies.cliVersion,
      ...createReadOnlyCommandServices({
        ...harness.dependencies,
        externalContextReader: {
          read: async (options) => ({
            ...await defaultExternalContextReader.read(options),
            unexpected: true,
          }),
        },
      }),
    }),
  ] as const;
  const arguments_ = [
    ["doctor", "--output", "json"],
    ["context", "--output", "json"],
    ["labels", "list", "--output", "json"],
  ] as const;

  for (let index = 0; index < cases.length; index += 1) {
    const result = await harness.run(arguments_[index]!, cases[index]!);
    assert.equal(result.output.ok, false, `${arguments_[index]!.join(" ")} accepted an unknown field`);
    assert.equal(result.output.code, "INTERNAL_ERROR");
  }
});

test("read-only port validation rejects accessors without invoking them", async () => {
  const harness = await fixture();
  let reads = 0;
  const capabilities: Record<string, boolean> = {};
  Object.defineProperty(capabilities, "labelsList", {
    enumerable: true,
    get() {
      reads += 1;
      return true;
    },
  });
  const handlers = createProductionCommandHandlers({
    cliVersion: harness.dependencies.cliVersion,
    ...createReadOnlyCommandServices({
      ...harness.dependencies,
      doctorProbe: {
        inspect: async () => ({
          checks: [{ id: "repository", status: "passed", detail: "Repository is readable." }],
          capabilities,
        }),
      },
    }),
  });

  const result = await harness.run(["doctor", "--output", "json"], handlers);
  assert.equal(result.output.ok, false);
  assert.equal(result.output.code, "INTERNAL_ERROR");
  assert.equal(reads, 0);
});

test("MR plan URLs are bound to the GitLab origin while same-origin loopback HTTP is allowed", async () => {
  const harness = await fixture();
  const invocation = parseCliInvocation(["context", "--mr", "88", "--output", "json"]);
  let issueCalls = 0;
  const crossOrigin = createReadOnlyCommandServices({
    ...harness.dependencies,
    planner: {
      prepare: async () => ({
        ...harness.plan,
        options: { ...harness.plan.options, operation: "update", mrIid: 88 },
        mergeRequestPlan: {
          action: "update",
          iid: 88,
          webUrl: "https://other.example.test/group/project/-/merge_requests/88",
        },
      }),
    },
    issueContext: async () => {
      issueCalls += 1;
      throw new Error("cross-origin plan reached context issuance");
    },
  });
  await assert.rejects(
    async () => crossOrigin.context!(invocation as never),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
  );
  assert.equal(issueCalls, 0);

  const loopbackOrigin = "http://127.0.0.1:43123";
  const loopback = createReadOnlyCommandServices({
    ...harness.dependencies,
    planner: {
      prepare: async () => ({
        ...harness.plan,
        options: {
          ...harness.plan.options,
          operation: "update",
          gitlabOrigin: loopbackOrigin,
          mrIid: 88,
          gitlab: { origin: loopbackOrigin } as GitLabClient,
        },
        mergeRequestPlan: {
          action: "update",
          iid: 88,
          webUrl: `${loopbackOrigin}/group/project/-/merge_requests/88`,
        },
      }),
    },
    issueContext: async () => {
      issueCalls += 1;
      throw new ToolError("GITLAB_ERROR", "Loopback context probe reached issuance", {
        field: "probe",
        expected: "URL validation to accept the same loopback origin",
        actual: "issuance probe",
        safeNextStep: "Stop after the URL validation probe.",
      });
    },
  });
  await assert.rejects(
    async () => loopback.context!(invocation as never),
    (error: unknown) => isToolError(error, "GITLAB_ERROR"),
  );
  assert.equal(issueCalls, 1);
});

test("prepared diff summaries and push plans are bound to the prepared Git snapshot", async () => {
  const harness = await fixture();
  const invocation = parseCliInvocation(["labels", "list", "--output", "json"]);
  let externalReads = 0;
  const otherSha = "c".repeat(40);
  const driftedPlans: readonly PreparedReadOnlyContext[] = [
    {
      ...harness.plan,
      gitDiffSummary: { ...harness.plan.gitDiffSummary, sourceHeadSha: otherSha },
    },
    {
      ...harness.plan,
      pushPlan: {
        ...harness.plan.pushPlan,
        sourceHeadSha: otherSha,
        remoteSha: otherSha,
      },
    },
    {
      ...harness.plan,
      pushPlan: {
        ...harness.plan.pushPlan,
        ref: "refs/heads/feature/other",
      },
    },
  ];

  for (const plan of driftedPlans) {
    const services = createReadOnlyCommandServices({
      ...harness.dependencies,
      planner: { prepare: async () => plan },
      externalContextReader: {
        read: async () => {
          externalReads += 1;
          throw new Error("cross-binding validation reached GitLab reads");
        },
      },
    });
    await assert.rejects(
      async () => services.labelsList!(invocation as never),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
  }
  assert.equal(externalReads, 0);
});

test("accepted planner and live-context values are immutable snapshots", async () => {
  const harness = await fixture();
  assert.equal((await harness.run(["context", "--output", "json"])).output.ok, true);
  const mutableSummary = { ...harness.plan.gitDiffSummary } as Record<string, unknown>;
  const mutablePlan: PreparedReadOnlyContext = {
    ...harness.plan,
    gitDiffSummary: mutableSummary as PreparedReadOnlyContext["gitDiffSummary"],
  };
  let mutableAudit: { requestIds: string[] } | undefined;
  const originalResolver = harness.dependencies.resolveCandidates;
  const services = createReadOnlyCommandServices({
    ...harness.dependencies,
    planner: { prepare: async () => mutablePlan },
    externalContextReader: {
      read: async (options) => {
        mutableSummary.changedFileCount = 999;
        const live = await defaultExternalContextReader.read(options);
        mutableAudit = { requestIds: [...live.audit.requestIds] };
        return { ...live, audit: mutableAudit };
      },
    },
    resolveCandidates: async (input) => {
      assert.ok(mutableAudit);
      mutableAudit.requestIds[0] = "mutated-after-validation";
      return originalResolver(input);
    },
  });

  const execution = await services.preview!(
    parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]) as never,
  );

  const data = execution.output!.data!;
  assert.equal((data.gitDiffSummary as { readonly changedFileCount: number }).changedFileCount, 2);
  assert.deepEqual(data.audit, { requestIds: ["request-a", "request-z"] });
});
