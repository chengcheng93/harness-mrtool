import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createDefaultWriteServices } from "../../src/cli/default-write-services.ts";
import { createProductionRuntime } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation, type CliInvocation } from "../../src/cli/program.ts";
import { canonicalizeJson, copyJsonValue, sha256CanonicalJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import type { ReadOnlyCommandDependencies, PreparedReadOnlyContext } from "../../src/cli/commands/readonly.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import type { ContextBinding, ResolvedContext } from "../../src/context/types.ts";
import { GitLabRequestError } from "../../src/gitlab/http.ts";
import type { GitLabMergeRequest } from "../../src/gitlab/types.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const root = resolve(import.meta.dirname, "../..");
async function fixture() {
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const hash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  const currentBundle = { bundle, bundleManifestHash: hash, releaseSetId: `embedded:${hash}`, releaseTag: `templates-v${bundle.manifest.version}` };
  const request = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  const snapshot = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8"));
  const options = { targetSessionResolver: { resolve: async () => { throw new Error("unexpected second session resolution"); } }, cliVersion: "0.1.5", cwd: root, currentBundle, contextIssueIid: null };
  return { currentBundle, request, snapshot, options };
}

test("default write service construction is lazy for unrelated commands", async () => {
  const { currentBundle, options } = await fixture();
  const readOnly = {} as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  assert.doesNotThrow(() => createDefaultWriteServices({ options, currentBundle, readOnly }));
});

test("default create consumes the shared prepared canonical diff, not an unavailable second repository", async () => {
  const { currentBundle, request, snapshot, options } = await fixture();
  request.workItem = { relation: "new" };
  request.mergeRequest.labelCandidateTokens = [];
  let plans = 0;
  const readOnly = {
    requestSource: { read: async () => request },
    planner: { prepare: async () => {
      plans++;
      return {
        selection: currentBundle,
        labelDiff: { items: [], sourceHeadSha: snapshot.sourceHeadSha, targetRefSha: snapshot.targetRefSha, mergeBaseSha: snapshot.mergeBaseSha },
        options: { gitlabOrigin: "https://gitlab.example.test", gitlab: {}, git: { sourceBranch: "feature/x" } },
        assertNoCredentialExposure: () => {},
      } as unknown as PreparedReadOnlyContext;
    } },
    externalContextReader: { read: async () => ({ snapshot, binding: {}, candidates: [] }) },
    contextStore: { resolve: async () => { throw new Error("must fail before candidate consumption"); } },
  } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  const handlers = createProductionRuntime({ ...options, readOnly, writeDefaults: options,
    profileRepository: {} as never, targetProjectResolver: {} as never });
  await assert.rejects(async () => handlers.create!(parseCliInvocation(["create", "--input", "request.json", "--output", "json"]) as Parameters<NonNullable<typeof handlers.create>>[0]),
    (error: unknown) => isToolError(error, "LABEL_ERROR"));
  assert.equal(plans, 1);
});

test("resume refuses missing private history before repository discovery or remote writes", async () => {
  const { currentBundle, request, options } = await fixture();
  let plans = 0;
  const readOnly = {
    requestSource: { read: async () => request },
    contextStore: {},
    planner: { prepare: async () => { plans++; throw new Error("must not discover without original proof"); } },
  } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  const services = createDefaultWriteServices({ options, currentBundle, readOnly });
  await assert.rejects(async () => services.create!(parseCliInvocation([
    "create", "--resume", "157", "--resume-from", "original.json", "--input", "fresh.json",
  ])), (error: unknown) => isToolError(error, "INPUT_ERROR"));
  assert.equal(plans, 0);
});

test("resume loads old request as proof separately from the fresh write request", async () => {
  const { currentBundle, request, options } = await fixture();
  const inputs: { input: string | null; format: string | null; type: string | null }[] = [];
  let selections: readonly { kind: string }[] | undefined;
  let plans = 0;
  const readOnly = {
    requestSource: { read: async (invocation: CliInvocation) => {
      inputs.push({ input: invocation.options.input, format: invocation.options.inputFormat, type: invocation.options.type });
      return request;
    } },
    contextStore: { loadRecoveryProof: async (input: { selections: readonly { kind: string }[] }) => {
      selections = input.selections;
      throw new ToolError("INPUT_ERROR", "Original recovery context is unavailable", {
        field: "contextId", expected: "original private proof", actual: "missing", safeNextStep: "Restore original proof.",
      });
    } },
    planner: { prepare: async () => { plans++; throw new Error("must not discover without original proof"); } },
  } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  const services = createDefaultWriteServices({ options, currentBundle, readOnly });
  await assert.rejects(async () => services.create!(parseCliInvocation([
    "create", "--resume", "157", "--resume-from", "original.yaml", "--input", "fresh.json", "--input-format", "json", "--type", "docs",
  ])), (error: unknown) => isToolError(error, "INPUT_ERROR"));
  assert.deepEqual(inputs, [{ input: "fresh.json", format: "json", type: "docs" }, { input: "original.yaml", format: null, type: null }]);
  assert.equal(selections?.some((selection) => selection.kind === "assignee"), request.mergeRequest.assigneeCandidateToken !== null);
  assert.equal(selections?.filter((selection) => selection.kind === "label").length, request.mergeRequest.labelCandidateTokens.length);
  assert.equal(plans, 0);
});

async function dryRunResumeFixture(failedRead: "read" | "findOpen" | null, readError?: Error) {
  const base = await fixture();
  const rawSnapshot = base.snapshot;
  rawSnapshot.targetProject.id = "100";
  rawSnapshot.sourceProject.id = "100";
  rawSnapshot.userCandidates = rawSnapshot.userCandidates.map((user: { id: string }) => ({ ...user, id: user.id.replace("user:", "") }));
  rawSnapshot.mergeRequest = { ...rawSnapshot.mergeRequest, iid: null, lifecycle: "new",
    authorUserId: "30", labelIds: [], assigneeUserId: null, reviewerUserIds: [] };
  rawSnapshot.review.qualifiedReviewerUserIds = ["20"];
  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
  ];
  const snapshot = validateExternalContextSnapshot(rawSnapshot);
  const originalRequest = normalizeAndValidateRequest({ ...base.request, contextId: "original-context",
    mergeRequest: { ...base.request.mergeRequest, labelCandidateTokens: [], assigneeCandidateToken: null },
    review: { ...base.request.review, reviewerCandidateTokens: [] } });
  const request = normalizeAndValidateRequest({ ...originalRequest, contextId: "fresh-context" });
  const binding: ContextBinding = {
    operation: "create", gitlabOrigin: "https://gitlab.example.test",
    sourceProject: { id: "100", fullPath: snapshot.sourceProject.path },
    targetProject: { id: "100", fullPath: snapshot.targetProject.path },
    sourceBranch: "feature/resume", targetBranch: request.targetBranch, sourceHeadSha: snapshot.sourceHeadSha,
    targetRefSha: snapshot.targetRefSha, mrIid: null, releaseSetId: base.currentBundle.releaseSetId,
    cliVersion: base.options.cliVersion,
    bundle: { id: base.currentBundle.bundle.manifest.bundleId, version: base.currentBundle.bundle.manifest.version,
      releaseTag: base.currentBundle.releaseTag, manifestHash: base.currentBundle.bundleManifestHash },
    protocols: { inputSchema: 1, policySchema: 1, skillProtocol: null },
  };
  const originalContext: ResolvedContext = { contextId: originalRequest.contextId, createdAtMs: 0, expiresAtMs: 1,
    binding, externalSnapshotDigest: sha256CanonicalJson(snapshot), snapshot: copyJsonValue(snapshot), candidates: [] };
  const labelDiff = bugLabelDiff(snapshot);
  const plan = buildWritePlan({ request: originalRequest, snapshot, resolvedCandidates: [],
    bundle: base.currentBundle.bundle, labelDiff });
  // An interrupted create leaves a normal (non-Draft) MR with the provisional description.
  const currentSnapshot = validateExternalContextSnapshot({ ...snapshot,
    mergeRequest: { ...snapshot.mergeRequest, iid: 157, lifecycle: "ready" } });
  const current: GitLabMergeRequest = {
    iid: 157, webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/157",
    title: plan.provisional.title,
    description: renderDescription({ request: originalRequest, snapshot, writePlan: plan.desired,
      bundle: base.currentBundle.bundle, releaseTag: base.currentBundle.releaseTag,
      cliVersion: base.options.cliVersion, renderPhase: "provisional" }),
    draft: false, state: "opened", sourceProjectId: "100", sourceBranch: binding.sourceBranch,
    targetProjectId: "100", targetBranch: binding.targetBranch, sha: binding.sourceHeadSha,
    author: { id: "30", username: "author", displayName: "Author User", state: "active", accessLevel: 40 },
    assignees: [], reviewers: [], labels: [], squash: plan.provisional.squash,
    shouldRemoveSourceBranch: plan.provisional.removeSourceBranch, pipelineStatus: currentSnapshot.ci.status,
  };
  const calls: string[] = [];
  const git = { sourceBranch: binding.sourceBranch, sourceProject: { path: binding.sourceProject.fullPath },
    sourceRemote: "origin", sourceRemoteRef: "refs/heads/feature/resume", targetRemote: "origin", targetBranch: binding.targetBranch };
  const gitlab = {
    getMergeRequestReceipt: async () => {
      calls.push("read");
      if (failedRead === "read") throw readError;
      return { value: current, requestId: "req-resume-read" };
    },
    listOpenMergeRequestReceipts: async () => {
      calls.push("findOpen");
      if (failedRead === "findOpen") throw readError;
      return { value: [current], requestId: "req-resume-find" };
    },
  };
  const options = { ...base.options, repository: {
    discover: async () => ({ sourceBranch: binding.sourceBranch,
      sourceProject: { path: binding.sourceProject.fullPath }, sourceRemote: git.sourceRemote,
      sourceRemoteRef: git.sourceRemoteRef, targetProject: { host: "gitlab.example.test", path: binding.targetProject.fullPath },
      targetRemote: git.targetRemote }),
    readChangeSet: async () => labelDiff,
  } };
  const readOnly = {
    requestSource: { read: async (invocation: CliInvocation) => invocation.options.input === "original.json" ? originalRequest : request },
    contextStore: {
      loadRecoveryProof: async () => originalContext,
      resolve: async (input: { consume: boolean }) => {
        calls.push(`candidate:${String(input.consume)}`);
        return { ...originalContext, contextId: request.contextId };
      },
    },
    planner: { prepare: async () => ({ selection: base.currentBundle, labelDiff,
      options: { gitlabOrigin: binding.gitlabOrigin, targetProject: binding.targetProject.fullPath, gitlab, git },
      pushPlan: { kind: "up-to-date" }, assertNoCredentialExposure: () => {} }) },
    externalContextReader: { read: async (input: { operation?: string }) => ({
      snapshot: input.operation === "update" ? currentSnapshot : snapshot, binding, candidates: [],
    }) },
  } as unknown as Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
  const services = createDefaultWriteServices({ options: options as never, currentBundle: base.currentBundle, readOnly });
  return { calls, current, run: async () => services.create!(parseCliInvocation([
    "create", "--resume", "157", "--resume-from", "original.json", "--input", "fresh.json", "--dry-run",
  ])) };
}

for (const operation of ["read", "findOpen"] as const) {
  for (const failure of ["auth", "network", "timeout", "http"] as const) {
    test(`resume dry-run maps ${operation} ${failure} failures to a safe ToolError without consuming candidates`, async () => {
      const requestId = `req-${operation}-${failure}`;
      const readError = new GitLabRequestError(failure, failure === "auth" ? 401 : failure === "http" ? 503 : null, requestId);
      Object.defineProperty(readError, "cause", { value: new Error("private-read-error-detail") });
      const f = await dryRunResumeFixture(operation, readError);
      await assert.rejects(f.run, (error: unknown) => {
        assert.ok(isToolError(error, failure === "auth" ? "AUTH_ERROR" : "GITLAB_ERROR"));
        assert.match(error.details.actual as string, new RegExp(requestId, "u"));
        assert.doesNotMatch(JSON.stringify(error), /private-read-error-detail/u);
        return true;
      });
      assert.deepEqual(f.calls, operation === "read" ? ["candidate:false", "read"] : ["candidate:false", "read", "findOpen"]);
    });
  }
}

test("resume dry-run preserves pristine-proof validation errors", async () => {
  const f = await dryRunResumeFixture(null);
  (f.current as { description: string }).description = "A human replaced the provisional description.";
  await assert.rejects(f.run, (error: unknown) => isToolError(error, "INPUT_ERROR") && error.details.field === "--resume");
  assert.deepEqual(f.calls, ["candidate:false", "read"]);
});
