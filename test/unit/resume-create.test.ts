import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { sha256CanonicalJson, sha256Utf8, canonicalizeJson, copyJsonValue } from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import type { Candidate, ContextBinding, ResolvedContext } from "../../src/context/types.ts";
import type { RemoteMergeRequest } from "../../src/app/create-mr.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import * as resume from "../../src/app/resume-create.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const root = resolve(import.meta.dirname, "../..");

async function fixture(intent: "draft" | "ready" = "draft") {
  const [rawRequest, rawSnapshot, bundle] = await Promise.all([
    readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(root, "template-bundle")),
  ]);
  rawRequest.intent = intent;
  rawRequest.mergeRequest.labelCandidateTokens = [];
  rawRequest.mergeRequest.assigneeCandidateToken = "original-assignee";
  rawRequest.review.reviewerCandidateTokens = ["original-reviewer"];
  const originalRequest = normalizeAndValidateRequest(rawRequest);
  const request = normalizeAndValidateRequest({ ...originalRequest, contextId: "fresh-context",
    mergeRequest: { ...originalRequest.mergeRequest, assigneeCandidateToken: "fresh-assignee" },
    review: { ...originalRequest.review, reviewerCandidateTokens: ["fresh-reviewer"] } });
  rawSnapshot.labelCandidates = [
    { id: "gid://gitlab/ProjectLabel/20", name: "type::bug" },
    { id: "gid://gitlab/ProjectLabel/30", name: "priority::p2" },
    { id: "gid://gitlab/ProjectLabel/40", name: "status::doing" },
    { id: "gid://gitlab/ProjectLabel/50", name: "status::review" },
  ];
  rawSnapshot.mergeRequest = { ...rawSnapshot.mergeRequest, iid: null, lifecycle: "new",
    labelIds: [], assigneeUserId: null, reviewerUserIds: [] };
  const snapshot = validateExternalContextSnapshot(rawSnapshot);
  const resolvedCandidates: readonly Candidate[] = [{ kind: "assignee", userId: "user:10",
    globalId: "gid://gitlab/User/10", username: "alice", displayName: "Alice Zhang" },
  { kind: "reviewer", userId: "user:20", globalId: "gid://gitlab/User/20",
    username: "bob", displayName: "Bob Chen" }];
  const releaseTag = `templates-v${bundle.manifest.version}`;
  const binding: ContextBinding = { operation: "create", gitlabOrigin: "https://gitlab.example.test",
    sourceProject: { id: snapshot.sourceProject.id, fullPath: snapshot.sourceProject.path },
    targetProject: { id: snapshot.targetProject.id, fullPath: snapshot.targetProject.path },
    sourceBranch: "feature/resume", targetBranch: "develop", sourceHeadSha: snapshot.sourceHeadSha,
    targetRefSha: snapshot.targetRefSha, mrIid: null, releaseSetId: "embedded:test", cliVersion: "0.1.8",
    bundle: { id: bundle.manifest.bundleId, version: bundle.manifest.version, releaseTag,
      manifestHash: sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`) },
    protocols: { inputSchema: 1, policySchema: 1, skillProtocol: 1 } };
  const originalContext: ResolvedContext = { contextId: originalRequest.contextId, createdAtMs: 0,
    expiresAtMs: 1, binding: { ...binding, cliVersion: "0.1.7" },
    externalSnapshotDigest: sha256CanonicalJson(snapshot), snapshot: copyJsonValue(snapshot), candidates: resolvedCandidates };
  const labelDiff = bugLabelDiff(snapshot);
  const oldPlan = buildWritePlan({ request: originalRequest, snapshot, bundle, resolvedCandidates, labelDiff });
  const description = renderDescription({ request: originalRequest, snapshot, writePlan: oldPlan.desired,
    bundle, releaseTag, cliVersion: "0.1.7", renderPhase: "provisional" });
  const current: RemoteMergeRequest = { iid: 157,
    webUrl: "https://gitlab.example.test/luban/luban-studio/-/merge_requests/157",
    title: oldPlan.provisional.title, description, draft: true, state: "opened",
    sourceProjectId: snapshot.sourceProject.id, targetProjectId: snapshot.targetProject.id,
    sourceBranch: binding.sourceBranch, targetBranch: "develop", sourceHeadSha: snapshot.sourceHeadSha,
    labelIds: [], assigneeUserId: null, reviewerUserIds: [], squash: oldPlan.provisional.squash,
    removeSourceBranch: oldPlan.provisional.removeSourceBranch,
    snapshot: validateExternalContextSnapshot({ ...snapshot, mergeRequest: { ...snapshot.mergeRequest,
      iid: 157, lifecycle: "draft" } }) };
  return { iid: 157, originalRequest, originalContext, request, binding, initialSnapshot: snapshot,
    resolvedCandidates, current, bundle, releaseTag, labelDiff };
}

function remoteState(current: RemoteMergeRequest, patch: Partial<RemoteMergeRequest>): RemoteMergeRequest {
  const next = { ...current, ...patch };
  return { ...next, snapshot: { ...next.snapshot, mergeRequest: { ...next.snapshot.mergeRequest,
    labelIds: next.labelIds, assigneeUserId: next.assigneeUserId, reviewerUserIds: next.reviewerUserIds } } };
}

test("authorizes an exact pristine Draft with renewed tickets for the same candidate identities", async () => {
  const input = await fixture();
  const authorization = resume.validatePristineCreateResume(input);
  assert.equal(authorization.iid, 157);
  assert.equal(authorization.createInput.description, input.current.description);
  assert.equal(authorization.writePlan.desired.assigneeUserId, "user:10");
  resume.assertPristineResumeAuthorization(authorization, input.current);
  assert.throws(() => resume.assertPristineResumeAuthorization({ ...authorization }, input.current),
    (error: unknown) => isToolError(error, "INPUT_ERROR"));
});

for (const intent of ["draft", "ready"] as const) {
  test(`authorizes only complete pre-description label and metadata prefixes for ${intent}`, async () => {
    const input = await fixture(intent);
    const plan = buildWritePlan({ request: input.request, snapshot: input.initialSnapshot,
      resolvedCandidates: input.resolvedCandidates, bundle: input.bundle, labelDiff: input.labelDiff });
    for (const metadata of [false, true]) {
      const current = remoteState(input.current, { labelIds: [...plan.draft.labelIds].reverse(),
        ...(metadata ? { assigneeUserId: plan.draft.assigneeUserId, reviewerUserIds: plan.draft.reviewerUserIds } : {}) });
      const authorization = resume.validatePristineCreateResume({ ...input, current });
      assert.equal(authorization.createInput.description, input.current.description);
      assert.deepEqual(authorization.writePlan.desired, plan.desired);
      resume.assertPristineResumeAuthorization(authorization, current);
      assert.throws(() => resume.assertPristineResumeAuthorization(authorization, input.current),
        (error: unknown) => isToolError(error, "INPUT_ERROR"));
    }
  });
}

test("rejects partial, extra, final-status, mixed-metadata, and edited-description prefixes", async () => {
  const input = await fixture("ready");
  const plan = buildWritePlan({ request: input.request, snapshot: input.initialSnapshot,
    resolvedCandidates: input.resolvedCandidates, bundle: input.bundle, labelDiff: input.labelDiff });
  for (const patch of [
    { labelIds: plan.draft.labelIds.slice(0, 2) },
    { labelIds: [...plan.draft.labelIds, plan.readyStatusLabelId] },
    { labelIds: plan.desired.labelIds },
    { labelIds: [...plan.draft.labelIds, plan.draft.labelIds[0]!] },
    { assigneeUserId: plan.draft.assigneeUserId, reviewerUserIds: plan.draft.reviewerUserIds },
    { labelIds: plan.draft.labelIds, assigneeUserId: plan.draft.assigneeUserId },
    { labelIds: plan.draft.labelIds, reviewerUserIds: plan.draft.reviewerUserIds },
    { labelIds: plan.draft.labelIds, assigneeUserId: "user:20", reviewerUserIds: plan.draft.reviewerUserIds },
    { labelIds: plan.draft.labelIds, assigneeUserId: plan.draft.assigneeUserId, reviewerUserIds: ["user:10"] },
    { labelIds: plan.draft.labelIds, description: `${input.current.description}edited` },
    { labelIds: plan.draft.labelIds, title: plan.desired.title },
    { labelIds: plan.draft.labelIds, squash: !input.current.squash },
    { labelIds: plan.draft.labelIds, removeSourceBranch: !input.current.removeSourceBranch },
  ]) assert.throws(() => resume.validatePristineCreateResume({ ...input, current: remoteState(input.current, patch) }),
    (error: unknown) => isToolError(error, "INPUT_ERROR"));
  const current = remoteState(input.current, { labelIds: plan.draft.labelIds });
  assert.throws(() => resume.validatePristineCreateResume({ ...input, current: { ...current,
    snapshot: input.current.snapshot } }), (error: unknown) => isToolError(error, "INPUT_ERROR"));
});

test("rejects changed prose, candidate identities, scope, and original proof digests", async () => {
  const input = await fixture();
  const cases = [
    { ...input, request: { ...input.request, changes: { ...input.request.changes, summary: ["Changed request"] } } },
    { ...input, resolvedCandidates: [{ ...input.resolvedCandidates[0]!, displayName: "Changed user" }] },
    { ...input, binding: { ...input.binding, sourceHeadSha: "f".repeat(40) } },
    { ...input, binding: { ...input.binding, gitlabOrigin: "https://other.example.test" } },
    { ...input, originalContext: { ...input.originalContext, externalSnapshotDigest: "f".repeat(64) } },
    { ...input, originalRequest: { ...input.originalRequest, contextId: "another-context" } },
  ];
  for (const value of cases) assert.throws(() => resume.validatePristineCreateResume(value),
    (error: unknown) => isToolError(error, "INPUT_ERROR"));
});

test("derives title type from the committed diff as normal create does", async () => {
  const input = await fixture();
  const authorization = resume.validatePristineCreateResume({ ...input,
    request: { ...input.request, title: { ...input.request.title, type: "chore" } },
    originalRequest: { ...input.originalRequest, title: { ...input.originalRequest.title, type: "chore" } },
  });
  assert.equal(authorization.createInput.title.startsWith("Draft: [fix]"), true);
});

test("resume authorization cannot be reused for changed write intent", async () => {
  const input = await fixture();
  const authorization = resume.validatePristineCreateResume(input);
  const intent = { request: input.request, resolvedCandidates: input.resolvedCandidates, bundle: input.bundle,
    releaseTag: input.releaseTag, sourceBranch: input.binding.sourceBranch, cliVersion: input.binding.cliVersion,
    labelDiff: input.labelDiff };
  resume.assertPristineResumeAuthorization(authorization, input.current, intent);
  for (const patch of [
    { request: { ...input.request, contextId: "different-fresh-context" } },
    { resolvedCandidates: [{ ...input.resolvedCandidates[0]!, userId: "user:20" }] },
    { releaseTag: "templates-v999.0.0" }, { sourceBranch: "feature/other" },
  ]) assert.throws(() => resume.assertPristineResumeAuthorization(authorization, input.current, { ...intent, ...patch }),
    (error: unknown) => isToolError(error, "INPUT_ERROR"));
});

test("rejects edits and any partial metadata writes before granting or reusing authorization", async () => {
  const input = await fixture();
  const authorization = resume.validatePristineCreateResume(input);
  for (const patch of [ { iid: 158 }, { description: `${input.current.description}edited` },
    { title: "Draft: changed" }, { labelIds: ["gid://gitlab/ProjectLabel/20"] },
    { assigneeUserId: "user:10" }, { reviewerUserIds: ["user:20"] }, { draft: false },
    { sourceHeadSha: "f".repeat(40) },
    { snapshot: { ...input.current.snapshot, mergeRequest: { ...input.current.snapshot.mergeRequest,
      authorUserId: "user:20" } } },
  ]) {
    const current = { ...input.current, ...patch };
    assert.throws(() => resume.validatePristineCreateResume({ ...input, current }),
      (error: unknown) => isToolError(error, "INPUT_ERROR"));
    assert.throws(() => resume.assertPristineResumeAuthorization(authorization, current),
      (error: unknown) => isToolError(error, "INPUT_ERROR"));
  }
});
