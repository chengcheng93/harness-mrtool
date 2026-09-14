import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { exactReleaseFixture } from "../helpers/default-historical-fixture.ts";
import { canonicalPayload, signedEnvelope } from "../helpers/signing.ts";
import { createProductionHistoricalBundleSource } from "../../src/update/production-historical-source.ts";
import { createTrustState } from "../../src/update/envelope.ts";
import { verifyChannelEnvelope } from "../../src/update/manifest.ts";
import { UpdateStateStore } from "../../src/update/state-store.ts";
import { updateTrustConfigSha256 } from "../../src/update/trust-config.ts";
import type { MergeRequestRemote, RemoteMergeRequest, ManagedFieldsInput } from "../../src/app/create-mr.ts";
import { resolveRequestCandidates } from "../../src/app/resolve-candidates.ts";
import { loadMrBundle } from "../../src/app/load-mr-bundle.ts";
import { mutationReceipt, valueReceipt } from "../../src/app/remote-receipt.ts";
import { buildVerificationReceipt, verifyStoredMergeRequest } from "../../src/app/verify-mr.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createMergeRequestCommandAdapter, type PreparedUpdateMergeRequestCommand } from "../../src/cli/commands/merge-request.ts";
import { createDefaultHistoricalBundleLoader } from "../../src/cli/default-historical-bundles.ts";
import { canonicalizeJson, sha256Utf8, sha256CanonicalJson, type JsonValue, type JsonObject } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import type { Candidate, ContextBinding } from "../../src/context/types.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { VerificationReceiptStore } from "../../src/platform/verification-receipt-store.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { parseDiagnosticMarker, validateDesiredWritePlan, validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { historicalManifest, historicalPolicy } from "../helpers/historical-template-bundle.ts";
import { bugLabelDiff } from "../helpers/label-diff.ts";

const root = resolve(import.meta.dirname, "../..");
const origin = "https://gitlab.example.test";
const hash = (bundle: Awaited<ReturnType<typeof loadTemplateBundle>>) => sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);

/** Only the external MR transport is simulated; adapter, tokens, ownership and receipts are real. */
class MigrationRemote implements MergeRequestRemote {
  writes: string[] = [];
  private sequence = 0;
  private requestId() { return `request-${++this.sequence}`; }
  constructor(public current: RemoteMergeRequest) {}
  private replace(patch: Partial<RemoteMergeRequest>) {
    const next = { ...this.current, ...patch };
    this.current = { ...next, snapshot: validateExternalContextSnapshot({ ...next.snapshot, mergeRequest: {
      ...next.snapshot.mergeRequest, lifecycle: next.draft ? "draft" : "ready", labelIds: next.labelIds,
      assigneeUserId: next.assigneeUserId, reviewerUserIds: next.reviewerUserIds,
    } }) };
  }
  async read() { return valueReceipt(structuredClone(this.current), this.requestId()); }
  async findOpen(): Promise<never> { throw new Error("Migration must not discover or create an MR"); }
  async createDraft(): Promise<never> { throw new Error("Migration must not create an MR"); }
  async addLabels(_iid: number, ids: readonly string[]) {
    this.writes.push("add-labels"); this.replace({ labelIds: [...new Set([...this.current.labelIds, ...ids])].sort() });
    return mutationReceipt(this.requestId());
  }
  async removeLabels(_iid: number, ids: readonly string[]) {
    this.writes.push("remove-labels"); this.replace({ labelIds: this.current.labelIds.filter((id) => !ids.includes(id)) });
    return mutationReceipt(this.requestId());
  }
  async writeManagedFields(_iid: number, fields: ManagedFieldsInput) {
    this.writes.push("fields"); this.replace({ ...fields, draft: fields.title.startsWith("Draft: ") });
    return mutationReceipt(this.requestId());
  }
  async writeDescription(_iid: number, description: string) {
    this.writes.push("description"); this.replace({ description }); return mutationReceipt(this.requestId());
  }
  async markDraft(_iid: number, title: string) {
    this.writes.push("draft"); this.replace({ title, draft: true }); return mutationReceipt(this.requestId());
  }
  async markReady(_iid: number, title: string) {
    this.writes.push("ready"); this.replace({ title, draft: false }); return mutationReceipt(this.requestId());
  }
}

async function fixture(t: test.TestContext, productionIds = false) {
  const stateDirectory = await mkdtemp(resolve(await realpath(tmpdir()), "mrtool-migration-adapter-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const oldPath = resolve(stateDirectory, "old-bundle");
  await cp(resolve(root, "template-bundle"), oldPath, { recursive: true });
  await writeFile(resolve(oldPath, "policy.yml"), historicalPolicy);
  await writeFile(resolve(oldPath, "bundle-manifest.json"), historicalManifest);
  const previousBundle = await loadTemplateBundle(oldPath);
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const previousReleaseTag = "templates-v1.0.0", releaseTag = "templates-v1.1.0";
  const identities: Record<string, string> = {
    "project:100": "7", "user:10": "42", "user:20": "43", "user:30": "44",
    "label:type": "gid://gitlab/ProjectLabel/2", "label:priority": "gid://gitlab/ProjectLabel/11",
    "label:status": "gid://gitlab/ProjectLabel/14", "label:week": "gid://gitlab/ProjectLabel/15",
    "label:p2": "gid://gitlab/ProjectLabel/12", "label:doing": "gid://gitlab/ProjectLabel/13",
  };
  const id = (value: string) => productionIds ? identities[value] ?? value : value;
  const json = async (name: string) => {
    let text = await readFile(resolve(root, "test/golden/fixtures", name), "utf8");
    if (productionIds) for (const [key, value] of Object.entries(identities)) text = text.replaceAll(JSON.stringify(key), JSON.stringify(value));
    return JSON.parse(text);
  };
  const rawRequest = await json("code-docs-request.json");
  if (productionIds) rawRequest.workItem = { relation: "none", noIssueReason: "Self-contained migration." };
  const oldRequest = normalizeAndValidateRequest(rawRequest);
  const rawSnapshot = await json("code-docs-snapshot.json");
  if (productionIds) rawSnapshot.issue = { kind: "none" };
  const oldSnapshot = validateExternalContextSnapshot(rawSnapshot);
  const writePlan = validateDesiredWritePlan(await json("code-docs-write-plan.json"));
  const cliVersion = "0.1.5", sourceBranch = "fix/webengine-css";
  const description = renderDescription({ request: oldRequest, snapshot: oldSnapshot, writePlan,
    bundle: previousBundle, releaseTag: previousReleaseTag, cliVersion, renderPhase: "final" });
  const oldCurrent: RemoteMergeRequest = {
    iid: 88, webUrl: `${origin}/luban/luban-studio/-/merge_requests/88`, title: writePlan.title,
    labelIds: writePlan.labelIds, assigneeUserId: writePlan.assigneeUserId, reviewerUserIds: writePlan.reviewerUserIds,
    squash: writePlan.squash, removeSourceBranch: writePlan.removeSourceBranch,
    description, draft: false, state: "opened", sourceProjectId: oldSnapshot.sourceProject.id,
    sourceBranch, targetProjectId: oldSnapshot.targetProject.id, targetBranch: oldRequest.targetBranch,
    sourceHeadSha: oldSnapshot.sourceHeadSha, snapshot: oldSnapshot,
  };
  const receipts = new VerificationReceiptStore({ stateDirectory });
  const oldReceipt = buildVerificationReceipt({ gitlabOrigin: origin, current: oldCurrent, bundle: previousBundle,
    expected: { request: oldRequest, snapshot: oldSnapshot, writePlan, releaseTag: previousReleaseTag, cliVersion, description, sourceBranch } });
  await receipts.stageAuthenticated(oldReceipt);
  const oldLoader = createDefaultHistoricalBundleLoader({ bundle: previousBundle, releaseTag: previousReleaseTag,
    releaseSetId: "authenticated-old", bundleManifestHash: hash(previousBundle) });
  const authenticated = await loadMrBundle({ current: oldCurrent, source: {
    gitlabOrigin: origin, receiptLoader: receipts, bundleLoader: oldLoader,
  } });
  const snapshot = validateExternalContextSnapshot({ ...oldSnapshot, labelCandidates: [
    ...oldSnapshot.labelCandidates, { id: id("label:p2"), name: "priority::p2" }, { id: id("label:doing"), name: "status::doing" },
  ] });
  const remote = new MigrationRemote({ ...oldCurrent, snapshot });
  const binding: ContextBinding = {
    operation: "migrate", gitlabOrigin: origin,
    targetProject: { id: snapshot.targetProject.id, fullPath: snapshot.targetProject.path },
    sourceProject: { id: snapshot.sourceProject.id, fullPath: snapshot.sourceProject.path },
    targetBranch: oldRequest.targetBranch, sourceBranch, sourceHeadSha: snapshot.sourceHeadSha,
    targetRefSha: snapshot.targetRefSha, mrIid: 88, cliVersion, releaseSetId: "destination-release",
    bundle: { id: bundle.manifest.bundleId, version: bundle.manifest.version, releaseTag, manifestHash: hash(bundle) },
    protocols: { inputSchema: 1, policySchema: 1, skillProtocol: null },
  };
  const candidates: Candidate[] = snapshot.userCandidates.filter((user) => user.id !== id("user:30")).map((user) => ({
    kind: user.id === id("user:10") ? "assignee" : "reviewer", userId: user.id, globalId: null,
    username: user.username, displayName: user.displayName,
  }));
  const store = new CandidateContextStore({ stateDirectory });
  const issued = await store.issue({ binding, snapshot: snapshot as unknown as JsonValue, candidates });
  rawRequest.contextId = issued.contextId;
  rawRequest.mergeRequest.labelCandidateTokens = [];
  rawRequest.mergeRequest.assigneeCandidateToken = issued.candidates.find((candidate) => candidate.kind === "assignee")!.token;
  rawRequest.review.reviewerCandidateTokens = [issued.candidates.find((candidate) => candidate.kind === "reviewer")!.token];
  const oldHash = authenticated.bundleManifestHash, newHash = hash(bundle);
  const prepared: PreparedUpdateMergeRequestCommand = {
    request: normalizeAndValidateRequest(rawRequest), binding, bundle, releaseTag, cliVersion, sourceBranch, remote,
    initial: structuredClone(remote.current), labelDiff: bugLabelDiff(snapshot),
    migration: { previousBundle: authenticated.bundle, previousReleaseTag: authenticated.reference.releaseTag,
      oldHash, newHash, confirmation: `${oldHash}:${newHash}` },
  };
  const operations: string[] = [];
  const hooks: { bindingRead?: () => void } = {};
  const newLoader = createDefaultHistoricalBundleLoader({ bundle, releaseTag, releaseSetId: binding.releaseSetId, bundleManifestHash: newHash });
  const adapter = createMergeRequestCommandAdapter({ gitlabOrigin: origin, candidateStore: store,
    readCurrentBinding: async ({ operation }) => { operations.push(operation); hooks.bindingRead?.(); return structuredClone(binding); },
    verifyLiveCandidateIdentities: async () => {}, verificationReceiptWriter: receipts,
    verificationReceiptLoader: receipts, historicalBundleLoader: newLoader,
  });
  const run = () => adapter.update({ forceReplaceDescription: false, prepare: async () => prepared });
  return { prepared, adapter, remote, run, receipts, oldReceipt, newLoader, operations, binding, hooks, store, stateDirectory, oldLoader, oldPath };
}

test("migration consumes migrate tokens, checks old ownership and completes the new fixed3 transaction with durable receipts", async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.ok(f.operations.length >= 2);
  assert.ok(f.operations.every((operation) => operation === "migrate"));
  assert.ok(f.remote.writes.includes("description"));
  assert.deepEqual(f.remote.current.labelIds, ["label:p2", "label:status", "label:type"]);
  assert.equal(parseDiagnosticMarker(f.remote.current.description).bundleVersion, "1.1.0");
  assert.ok(result.output?.data?.mandatoryLabels);
  assert.equal((await verifyStoredMergeRequest({ level: "structure", current: f.remote.current,
    gitlabOrigin: origin, receiptLoader: f.receipts, bundleLoader: f.newLoader })).valid, true);
  const old = await f.receipts.loadVerified({ gitlabOrigin: origin, targetProjectId: f.oldReceipt.targetProject.id,
    iid: 88, markerDigest: sha256CanonicalJson(f.oldReceipt.marker) });
  assert.equal(old?.trusted, true);
  assert.deepEqual(old?.receipt, f.oldReceipt);
});

test("stale migration confirmation and mismatched hashes fail before any writes", async (t) => {
  for (const field of ["confirmation", "oldHash", "newHash"] as const) {
    await t.test(field, async (t) => {
      const f = await fixture(t);
      (f.prepared.migration as any)[field] = "0".repeat(64);
      await assert.rejects(f.run(), (error: any) => error.code === "INPUT_ERROR");
      assert.deepEqual(f.remote.writes, []);
    });
  }
});

test("migration cannot use update tokens or omit the explicit migration contract", async (t) => {
  const wrong = await fixture(t);
  (wrong.prepared.binding as any).operation = "update";
  await assert.rejects(wrong.run());
  assert.deepEqual(wrong.remote.writes, []);
  const missing = await fixture(t);
  delete (missing.prepared as any).migration;
  await assert.rejects(missing.run());
  assert.deepEqual(missing.remote.writes, []);
});

test("migration retains old marker identity and manual description ownership checks", async (t) => {
  for (const change of ["tag", "body", "bundle"] as const) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      if (change === "tag") (f.prepared.migration as any).previousReleaseTag = "templates-v9.0.0";
      else if (change === "bundle") {
        Object.assign(f.prepared.migration!, { previousBundle: f.prepared.bundle,
          previousReleaseTag: f.prepared.releaseTag, oldHash: f.prepared.migration!.newHash,
          confirmation: `${f.prepared.migration!.newHash}:${f.prepared.migration!.newHash}` });
      } else {
        f.remote.current = { ...f.remote.current, description: `Manual note\n${f.remote.current.description}` };
        (f.prepared as any).initial = structuredClone(f.remote.current);
      }
      await assert.rejects(f.run(), (error: any) => ["TEMPLATE_ERROR", "MANUAL_DESCRIPTION_CHANGE"].includes(error.code));
      assert.deepEqual(f.remote.writes, []);
    });
  }
});


test("changing the migration contract at the mutation gate cannot write or consume a stale approval", async (t) => {
  const f = await fixture(t);
  f.hooks.bindingRead = () => {
    if (f.operations.length === 2) {
      // This replacement is internally hash-consistent: only the immutable prepared
      // fingerprint, not the old:new syntax check, can catch its late substitution.
      Object.assign(f.prepared.migration!, { previousBundle: f.prepared.bundle,
        previousReleaseTag: f.prepared.releaseTag, oldHash: f.prepared.migration!.newHash,
        confirmation: `${f.prepared.migration!.newHash}:${f.prepared.migration!.newHash}` });
    }
  };
  await assert.rejects(f.run());
  assert.equal(f.operations.length, 2);
  assert.deepEqual(f.remote.writes, []);
  const reusable = await resolveRequestCandidates({ request: f.prepared.request,
    expectedBinding: f.binding, store: f.store, consume: false });
  assert.equal(reusable.candidates.length, 2);
});


// Only transports and an explicit in-process test signing root are substituted.
// Historical lookup, state persistence, signatures, receipts and ZIP validation stay real.
test("production route authenticates signed 1.0.0 history before migrating week policy to 1.1.0", async (t) => {
  const f = await fixture(t, true);
  const signed = await exactReleaseFixture(f.oldPath);
  const currentRelease = await exactReleaseFixture();
  const currentAnchor = (currentRelease.channelPayload.templateHistory as JsonObject[])[0]!;
  const oldAnchor = (signed.channelPayload.templateHistory as JsonObject[])[0]!;
  const channelWithoutOldAnchor = { ...currentRelease.channelPayload, templateHistory: [currentAnchor] };
  const channelWithOldAnchor = { ...currentRelease.channelPayload, sequence: 43, templateHistory: [oldAnchor, currentAnchor] };
  // This is an otherwise valid authenticated channel. Its CURRENT release is
  // anchored; only the requested historical 1.0.0 anchor is missing.
  const currentOnly = verifyChannelEnvelope(signedEnvelope(canonicalPayload(channelWithoutOldAnchor), [signed.signingKey]),
    createTrustState(signed.bootstrapKeys), signed.trustConfig.repository, signed.bootstrapKeys);
  assert.deepEqual(currentOnly.nextTrustState.bundleReceiptAnchors.map((anchor) => anchor.releaseTag), ["templates-v1.1.0"]);
  const historyRequests: string[] = [];
  let missingAnchor = true;
  let tamper = false;
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Uninjected network is forbidden in this test"); });
  const historicalBundleDefaults = {
    trustConfig: signed.trustConfig,
    channelUrl: "https://fixture.example.test/harness-mrtool/stable.envelope.json",
    channelTransport: { request: async (request: { url: string }) => {
      historyRequests.push(request.url);
      const payload = missingAnchor
        ? channelWithoutOldAnchor
        : channelWithOldAnchor;
      return { status: 200, headers: {}, body: Buffer.from(signedEnvelope(canonicalPayload(payload), [signed.signingKey])) };
    } },
    releaseAssets: createProductionHistoricalBundleSource({
      repository: signed.trustConfig.repository,
      fetch: async (url) => {
        historyRequests.push(String(url));
        const payload = Object.fromEntries(signed.assets.files);
        if (tamper) payload["policy.yml"] = Buffer.from("untrusted policy replacement");
        return new Response(String(url).endsWith(".zip") ? Buffer.from(zipSync(payload)) : String(signed.assets.receiptEnvelope));
      },
    }),
  };
  const { runProductionMain } = await import("../../src/production-main.ts");
  const { DEFAULT_LABEL_POOL } = await import("../../src/app/label-defaults.ts");
  const labels = [...DEFAULT_LABEL_POOL, "week::2026-w32-0803-0809"].map((name, index) => ({
    restId: index + 1, globalId: `gid://gitlab/ProjectLabel/${index + 1}`, name, description: name,
    color: "#123456", archived: false, scopeKind: "project" as const, scopeId: "7", scopePath: "luban/luban-studio",
  }));
  const users = f.remote.current.snapshot.userCandidates.map((user) => ({ ...user,
    state: "active" as const, accessLevel: 40,
  }));
  const user = (id: string) => users.find((value) => value.id === id)!;
  const project = { id: "7", fullPath: "luban/luban-studio", defaultBranch: "develop", webUrl: `${origin}/luban/luban-studio` };
  const sourceSha = f.remote.current.sourceHeadSha, targetSha = f.remote.current.snapshot.targetRefSha;
  let sequence = 0;
  const receipt = <T>(value: T) => ({ value, requestId: `gitlab-${++sequence}` });
  const currentMr = () => {
    const current = f.remote.current;
    return { iid: 88, webUrl: current.webUrl, title: current.title, description: current.description,
      draft: current.draft, state: current.state, sourceProjectId: "7", sourceBranch: current.sourceBranch,
      targetProjectId: "7", targetBranch: current.targetBranch, sha: current.sourceHeadSha,
      author: user(current.snapshot.mergeRequest.authorUserId), assignees: current.assigneeUserId === null ? [] : [user(current.assigneeUserId)],
      reviewers: current.reviewerUserIds.map(user), labels: current.labelIds.map((id) => {
        const label = labels.find((entry) => entry.globalId === id)!;
        return { restId: label.restId, name: label.name, archived: false };
      }), squash: current.squash, shouldRemoveSourceBranch: current.removeSourceBranch, pipelineStatus: "passed" as const,
    };
  };
  const client = {
    origin, audit: () => ({ requestIds: [] }), getProject: async () => project, getBranchHead: async () => targetSha,
    getCurrentUser: async () => user("42"), listUsers: async () => users,
    labelInventory: async () => ({ all: labels, effective: labels, audit: { requestIds: [] } }),
    getReviewState: async () => ({ approvedUserIds: ["43"], unresolvedDiscussions: 0 }),
    getMergeRequest: async () => structuredClone(currentMr()), getMergeRequestReceipt: async () => receipt(structuredClone(currentMr())),
    listOpenMergeRequestReceipts: async () => receipt([structuredClone(currentMr())]),
    mutateLabels: async (_target: unknown, iid: number, ids: readonly string[], mode: string) => {
      if (mode === "ADD") await f.remote.addLabels(iid, ids); else await f.remote.removeLabels(iid, ids);
      return receipt(null);
    },
    updateMergeRequest: async (_target: unknown, iid: number, input: import("../../src/gitlab/types.ts").GitLabUpdateMergeRequestInput) => {
      if (input.kind === "description") await f.remote.writeDescription(iid, input.description);
      else if (input.kind === "title") {
        if (input.title.startsWith("Draft:")) await f.remote.markDraft(iid, input.title); else await f.remote.markReady(iid, input.title);
      } else await f.remote.writeManagedFields(iid, { title: input.title, targetBranch: input.targetBranch,
        assigneeUserId: input.assigneeIds[0] === undefined ? null : String(input.assigneeIds[0]),
        reviewerUserIds: input.reviewerIds.map(String), squash: input.squash, removeSourceBranch: input.removeSourceBranch });
      return receipt(structuredClone(currentMr()));
    },
  } as unknown as import("../../src/gitlab/client.ts").GitLabClient;
  const repo = { gitlabHost: "gitlab.example.test", sourceBranch: f.prepared.sourceBranch, sourceHeadSha: sourceSha,
    sourceProject: { host: "gitlab.example.test", path: project.fullPath }, targetProject: { host: "gitlab.example.test", path: project.fullPath },
    targetBranch: "develop", sourceRemote: "origin", sourceRemoteRef: `refs/heads/${f.prepared.sourceBranch}`,
    targetRemote: "origin", targetRef: "refs/remotes/origin/develop", targetRefSha: targetSha,
    worktree: { clean: true, staged: false, unstaged: false, untracked: false },
  } as unknown as import("../../src/git/repository.ts").RepositorySnapshot;
  const raw = structuredClone(f.prepared.request);
  const overrides = { stateDirectory: f.stateDirectory, contextStore: f.store, historicalBundleDefaults,
    repository: { discover: async () => repo, readChangeSet: async () => f.prepared.labelDiff,
      planPush: async () => ({ kind: "up-to-date" as const, remote: "origin", ref: repo.sourceRemoteRef, sourceHeadSha: sourceSha, remoteSha: sourceSha, command: null }) },
    stdinIsTerminal: () => false,
    inputIo: { statFile: async () => ({ size: Buffer.byteLength(JSON.stringify(raw)) }), readFile: async () => Buffer.from(JSON.stringify(raw)),
      stdin: { async *[Symbol.asyncIterator]() {} } },
    targetSessionResolver: { resolve: async () => ({ origin, gitlab: client, project, identity: { host: "gitlab.example.test", path: project.fullPath },
      targetRemote: "origin", assertNoCredentialExposure: () => {} }) },
  };
  const currentBundle = { bundle: f.prepared.bundle, releaseTag: f.prepared.releaseTag,
    releaseSetId: f.binding.releaseSetId, bundleManifestHash: f.prepared.migration!.newHash };
  const run = async (args: string[]) => {
    let stdout = "", stderr = "";
    const code = await runProductionMain([...args, "--output", "json"], { cwd: root, loadCurrentBundle: async () => currentBundle,
      readOnlyDefaults: overrides, updatePreflight: { run: async () => {} } as never,
      stdout: { write: (text) => { stdout += text; return true; } }, stderr: { write: (text) => { stderr += text; return true; } },
    });
    return { code, stdout, stderr, json: JSON.parse(stdout) };
  };
  const unanchored = await run(["context", "--mr", "88", "--migrate-template"]);
  assert.notEqual(unanchored.code, 0, "a signed channel without the exact historical anchor cannot authorize migration");
  assert.equal(unanchored.json.code, "UPDATE_SECURITY_ERROR");
  assert.deepEqual(f.remote.writes, []);
  assert.ok(historyRequests.some((url) => url.endsWith("stable.envelope.json")), `must enter the real historical trust path: ${unanchored.stdout} ${unanchored.stderr}`);
  const currentOnlyState = await new UpdateStateStore({ stateDirectory: f.stateDirectory,
    trustConfigSha256: updateTrustConfigSha256(signed.trustConfig), bootstrapKeys: signed.bootstrapKeys }).load();
  assert.deepEqual(currentOnlyState?.trustState.bundleReceiptAnchors.map((anchor) => anchor.releaseTag), ["templates-v1.1.0"]);
  assert.ok(historyRequests.some((url) => url.endsWith("/templates-v1.0.0/bundle-receipt.envelope.json")),
    "must reach requested historical receipt authentication, not fail channel parsing");
  missingAnchor = false;
  const context = await run(["context", "--mr", "88", "--migrate-template"]);
  assert.equal(context.code, 0, context.stdout + context.stderr);
  const issued = context.json.data;
  Object.assign(raw, { contextId: issued.contextId });
  Object.assign(raw.mergeRequest, { assigneeCandidateToken: issued.userCandidates.find((value: any) => value.kind === "assignee" && value.username === "alice").token });
  Object.assign(raw.review, { reviewerCandidateTokens: [issued.userCandidates.find((value: any) => value.kind === "reviewer" && value.username === "bob").token] });
  const args = ["update", "88", "--migrate-template", "--input", "request.json", "--confirm-migration"];
  const stale = await run([...args, `${"0".repeat(64)}:${f.prepared.migration!.newHash}`]);
  assert.notEqual(stale.code, 0);
  assert.deepEqual(f.remote.writes, []);
  assert.equal(f.remote.current.description, f.oldReceipt.expected.description);
  tamper = true;
  const corrupted = await run([...args, f.prepared.migration!.confirmation]);
  assert.notEqual(corrupted.code, 0, "tampered historical bytes must fail before migration writes");
  assert.equal(corrupted.json.code, "UPDATE_SECURITY_ERROR");
  assert.deepEqual(f.remote.writes, []);
  assert.equal(f.remote.current.description, f.oldReceipt.expected.description);
  tamper = false;
  // Reuse exactly the same issued context: a failed historical check must not consume it.
  const migrated = await run([...args, f.prepared.migration!.confirmation]);
  assert.equal(migrated.code, 0, migrated.stdout + migrated.stderr);
  assert.deepEqual(migrated.json.data.mandatoryLabels.names, ["type::bug", "priority::p2", "status::review"]);
  assert.equal(parseDiagnosticMarker(f.remote.current.description).bundleVersion, "1.1.0");
  assert.equal(f.remote.current.labelIds.some((id) => id === "gid://gitlab/ProjectLabel/15"), false);
  const verified = await run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  const retained = await f.receipts.loadVerified({ gitlabOrigin: origin, targetProjectId: "7", iid: 88,
    markerDigest: sha256CanonicalJson(f.oldReceipt.marker) });
  assert.deepEqual(retained?.receipt, f.oldReceipt);
  for (const asset of ["harness-mr-templates.zip", "bundle-receipt.envelope.json"]) {
    assert.ok(historyRequests.some((url) => url.endsWith(`/templates-v1.0.0/${asset}`)), `historical ${asset} must actually be retrieved`);
  }
  const persisted = await new UpdateStateStore({ stateDirectory: f.stateDirectory,
    trustConfigSha256: updateTrustConfigSha256(signed.trustConfig), bootstrapKeys: signed.bootstrapKeys }).load();
  assert.ok(persisted, "authenticated historical trust transition must be persisted");
  assert.ok(JSON.stringify(persisted.trustState).includes(signed.reference.bundleManifestHash));
});
