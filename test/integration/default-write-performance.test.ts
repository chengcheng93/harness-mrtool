import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import packageMetadata from "../../package.json" with { type: "json" };
import { getContext } from "../../src/app/get-context.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createProductionReadOnlyDefaults } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { CandidateContextStore } from "../../src/context/store.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type { GitLabMergeRequest, GitLabUpdateMergeRequestInput, GitLabCreateMergeRequestInput } from "../../src/gitlab/types.ts";
import type { RepositorySnapshot } from "../../src/git/repository.ts";
import { runProductionMain } from "../../src/production-main.ts";

const root = resolve(import.meta.dirname, "../..");
const sourceSha = "b".repeat(40), targetSha = "a".repeat(40);
const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function setup(t: test.TestContext) {
  const stateDirectory = await mkdtemp(resolve(await realpath(tmpdir()), "mrtool-default-write-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const bundle = await loadTemplateBundle(resolve(root, "template-bundle"));
  const hash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  const currentBundle = { bundle, bundleManifestHash: hash, releaseSetId: `embedded:${hash}`, releaseTag: `templates-v${bundle.manifest.version}` };
  const user = { id: "42", globalId: "gid://gitlab/User/42", username: "author", displayName: "Author", state: "active" as const, accessLevel: 40 };
  const reviewer = { ...user, id: "43", globalId: "gid://gitlab/User/43", username: "reviewer", displayName: "Reviewer" };
  const project = { id: "7", fullPath: "group/project", defaultBranch: "develop", webUrl: "https://gitlab.example.test/group/project" };
  const labels = DEFAULT_LABEL_POOL.map((name, index) => ({ restId: index + 1, globalId: `gid://gitlab/ProjectLabel/${index + 1}`, name,
    description: name, color: "#123456", archived: false, scopeKind: "project" as const, scopeId: "7", scopePath: project.fullPath }));
  const state: { mr: GitLabMergeRequest | null; writes: string[]; drift: boolean; omitP2: boolean; wrongReadback: boolean; driftOnFind: boolean; driftAfterCreate: boolean; renameAfterFind: boolean; sourceMissing: boolean; sourceMissingOnFind: boolean; dirtyOnFind: boolean; driftAfterConsume: boolean; driftAfterLabels: boolean; duplicateAfterFields: boolean } = {
    mr: null, writes: [], drift: false, omitP2: false, wrongReadback: false, driftOnFind: false, driftAfterCreate: false, renameAfterFind: false, sourceMissing: false, sourceMissingOnFind: false, dirtyOnFind: false, driftAfterConsume: false, driftAfterLabels: false, duplicateAfterFields: false,
  };
  const calls = { mergeRequest: 0, mergeRequestReceipt: 0, inventory: 0, users: 0, review: 0, projects: 0, discover: 0, pushPlans: 0, diff: 0 };
  const guardConcurrency = { armed: false, rejectPush: false, diffSettled: false,
    pushRejected: deferred(), diffEntered: deferred(), releaseDiff: deferred() };
  let receiptSequence = 0;
  const receipt = <T>(value: T) => ({ value, requestId: `request-${++receiptSequence}` });
  const applied = (ids: readonly string[]) => ids.map((id) => {
    const label = labels.find((value) => value.globalId === id)!;
    return { restId: label.restId, name: label.name, archived: false };
  });
  const client = {
    origin: "https://gitlab.example.test", audit: () => ({ requestIds: ["request-test"] }),
    getProject: async () => { calls.projects++; return project; }, getBranchHead: async () => targetSha,
    getCurrentUser: async () => user, listUsers: async () => { calls.users++; return [user, reviewer]; },
    labelInventory: async () => { calls.inventory++; const effective = labels.filter((label) => !state.omitP2 || label.name !== "priority::p2"); return { all: effective, effective, audit: { requestIds: ["request-test"] } }; },
    getReviewState: async () => { calls.review++; return { approvedUserIds: [reviewer.id], unresolvedDiscussions: 0 }; },
    getMergeRequest: async () => { calls.mergeRequest++; return structuredClone(state.mr!); },
    getMergeRequestReceipt: async () => { calls.mergeRequestReceipt++; return receipt(structuredClone(state.mr!)); },
    listOpenMergeRequestReceipts: async () => {
      if (state.driftOnFind) state.drift = true;
      if (state.sourceMissingOnFind) state.sourceMissing = true;
      if (state.dirtyOnFind) (repo.worktree as { clean: boolean }).clean = false;
      if (state.renameAfterFind) labels.find((label) => label.name === "priority::p2")!.name = "priority::p1";
      return receipt(state.mr === null ? [] : [structuredClone(state.mr)]);
    },
    createMergeRequest: async (_target: unknown, input: GitLabCreateMergeRequestInput) => {
      state.writes.push("create");
      state.mr = { iid: 88, webUrl: `${project.webUrl}/-/merge_requests/88`, title: input.title, description: input.description,
        draft: true, state: "opened", sourceProjectId: "7", sourceBranch: "feature/labels", targetProjectId: "7", targetBranch: "develop",
        sha: sourceSha, author: user, assignees: [], reviewers: [], labels: [], squash: true, shouldRemoveSourceBranch: true, pipelineStatus: "passed" };
      if (state.driftAfterCreate) state.drift = true;
      return receipt({ iid: 88 });
    },
    mutateLabels: async (_target: unknown, _iid: number, ids: readonly string[], mode: string) => {
      state.writes.push(`labels:${mode}`);
      if (!state.wrongReadback) state.mr = { ...state.mr!, labels: mode === "ADD"
        ? [...state.mr!.labels.filter((label) => !applied(ids).some((value) => value.restId === label.restId)), ...applied(ids)]
        : state.mr!.labels.filter((label) => !applied(ids).some((value) => value.restId === label.restId)) };
      if (state.driftAfterLabels) state.drift = true;
      return receipt(null);
    },
    updateMergeRequest: async (_target: unknown, _iid: number, input: GitLabUpdateMergeRequestInput) => {
      state.writes.push(input.kind);
      state.mr = input.kind === "description" ? { ...state.mr!, description: input.description }
        : input.kind === "title" ? { ...state.mr!, title: input.title, draft: input.title.startsWith("Draft:") }
        : { ...state.mr!, title: input.title, draft: input.title.startsWith("Draft:"), targetBranch: input.targetBranch,
          assignees: input.assigneeIds.map((id) => id === 42 ? user : reviewer), reviewers: input.reviewerIds.map((id) => id === 42 ? user : reviewer),
          squash: input.squash, shouldRemoveSourceBranch: input.removeSourceBranch };
      if (state.duplicateAfterFields && input.kind === "managed-fields") {
        const original = labels.find((label) => label.name === "status::review")!;
        labels.push({ ...original, restId: 999, globalId: "gid://gitlab/ProjectLabel/999" });
      }
      return receipt(structuredClone(state.mr));
    },
  } as unknown as GitLabClient;
  const repo = { gitlabHost: "gitlab.example.test", sourceBranch: "feature/labels", sourceHeadSha: sourceSha, sourceProject: { host: "gitlab.example.test", path: project.fullPath },
    targetProject: { host: "gitlab.example.test", path: project.fullPath }, targetBranch: "develop", sourceRemote: "origin", sourceRemoteRef: "refs/heads/feature/labels",
    targetRemote: "origin", targetRef: "refs/remotes/origin/develop", targetRefSha: targetSha,
    worktree: { clean: true, staged: false, unstaged: false, untracked: false } } as unknown as RepositorySnapshot;
  const diff = { sourceHeadSha: sourceSha, targetRefSha: targetSha, mergeBaseSha: targetSha,
    items: [{ status: "modified" as const, newPath: "src/a.ts", oldPath: "src/a.ts", binary: false, submodule: false, before: "if (a > 0) return a;", after: "if (a >= 0) return a;" }] };
  const repository = { discover: async () => { calls.discover++; return repo; }, readChangeSet: async () => {
      calls.diff++;
      if (guardConcurrency.rejectPush) {
        guardConcurrency.diffEntered.resolve();
        await guardConcurrency.releaseDiff.promise;
        guardConcurrency.diffSettled = true;
      }
      return { ...diff, sourceHeadSha: state.drift ? "c".repeat(40) : sourceSha };
    },
    planPush: async () => {
      calls.pushPlans++;
      if (guardConcurrency.rejectPush) {
        guardConcurrency.pushRejected.resolve();
        throw new Error("Injected push-plan rejection after candidate consumption");
      }
      return ({ kind: state.sourceMissing ? "missing" as const : "up-to-date" as const, remote: "origin", ref: repo.sourceRemoteRef, sourceHeadSha: sourceSha, remoteSha: state.sourceMissing ? null : sourceSha, command: state.sourceMissing ? `git push --no-force origin ${sourceSha}:${repo.sourceRemoteRef}` : null }); } };
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.intent = "draft";
  raw.workItem = { relation: "none", noIssueReason: "A self-contained maintenance change." };
  raw.mergeRequest.labelCandidateTokens = [];
  const contextStore = new CandidateContextStore({ stateDirectory, windowsAclVerifier: allowTestAcl });
  const resolveCandidates = contextStore.resolve.bind(contextStore);
  contextStore.resolve = async (input) => {
    const result = await resolveCandidates(input);
    if (input.consume && state.driftAfterConsume) state.drift = true;
    if (input.consume && guardConcurrency.armed) guardConcurrency.rejectPush = true;
    return result;
  };
  const overrides = { stateDirectory, windowsAclVerifier: allowTestAcl, contextStore, repository, stdinIsTerminal: () => false,
    inputIo: { statFile: async () => ({ size: Buffer.byteLength(JSON.stringify(raw)) }), readFile: async () => Buffer.from(JSON.stringify(raw)), stdin: { async *[Symbol.asyncIterator]() {} } },
    targetSessionResolver: { resolve: async () => ({ origin: client.origin, gitlab: client, project, identity: { host: "gitlab.example.test", path: project.fullPath }, targetRemote: "origin", assertNoCredentialExposure: () => {} }) } };
  const defaults = createProductionReadOnlyDefaults({ ...overrides, cliVersion: packageMetadata.version, cwd: root, currentBundle, contextIssueIid: null });
  async function issue(iid: number | null = null, migrate = false) {
    const invocation = parseCliInvocation(["context", ...(iid === null ? [] : ["--mr", String(iid)]), ...(migrate ? ["--migrate-template"] : []), "--output", "json"]);
    const planned = await defaults.planner.prepare({ cliVersion: packageMetadata.version, command: "context", currentBundle, cwd: root, invocation, request: null, contextIssueIid: null });
    const context = await getContext({ ...planned.options, store: contextStore });
    raw.contextId = context.contextId;
    // Tokens come from the real private context store, not synthetic placeholders.
    const issued = context as unknown as { userCandidates: { kind: string; token: string; username: string }[] };
    raw.mergeRequest.assigneeCandidateToken = issued.userCandidates.find((value) => value.kind === "assignee" && value.username === "author")!.token;
    raw.review.reviewerCandidateTokens = [issued.userCandidates.find((value) => value.kind === "reviewer" && value.username === "reviewer")!.token];
  }
  async function run(args: string[]) {
    let stdout = "", stderr = "";
    const code = await runProductionMain([...args, ...(args[0] === "verify" ? [] : ["--input", "request.json"]), "--output", "json"], {
      cwd: root, loadCurrentBundle: async () => currentBundle, readOnlyDefaults: overrides,
      updatePreflight: { run: async () => {} } as never,
      stdout: { write: (text) => { stdout += text; return true; } }, stderr: { write: (text) => { stderr += text; return true; } },
    });
    return { code, stdout, stderr };
  }
  return { issue, run, state, raw, calls, guardConcurrency, resetCalls: () => { for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0; } };
}

// These exercise the default production adapter and transaction, not a fake
// readCurrentBinding implementation. The ACL adapter matches the existing
// production-default-label-flow fixture; native ACL behavior has its own tests.
test("default update rejects canonical-diff drift after candidate consumption before its first mutation", async (t) => {
  const f = await setup(t);
  await f.issue();
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
  await f.issue(88);
  const before = f.state.writes.length;
  f.state.driftAfterConsume = true;
  const result = await f.run(["update", "88"]);
  assert.equal(f.state.drift, true, "the injection must occur during candidate consumption");
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes.slice(before), [], "the first update mutation must not reach transport");
  assert.match(result.stdout, /CONCURRENT_UPDATE/);
});

test("default create detects canonical-diff drift immediately after the first mutation", async (t) => {
  const f = await setup(t);
  await f.issue();
  f.state.driftAfterCreate = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes, ["create"]);
});

for (const intent of ["draft", "ready"] as const) {
  test("default " + intent + " guards reject later local drift after label synchronization", async (t) => {
    const f = await setup(t);
    f.raw.intent = intent;
    await f.issue();
    f.state.driftAfterLabels = true;
    const result = await f.run(["create"]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.deepEqual(f.state.writes, ["create", "labels:ADD"], "fields/description/Ready writes must not follow drift");
  });
}

test("default Draft readback rejects a new duplicate lifecycle label even when applied IDs are unchanged", async (t) => {
  const f = await setup(t);
  await f.issue();
  f.state.duplicateAfterFields = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0, result.stdout);
  assert.deepEqual(f.state.writes, ["create", "labels:ADD", "managed-fields"]);
  assert.equal(f.state.mr!.labels.some((label) => label.name === "status::review"), false,
    "the newly ambiguous lifecycle name must remain unapplied in this regression");
});

for (const intent of ["draft", "ready"] as const) {
  test("default " + intent + " submission reuses each MR response while keeping inventory/member/review reads live", async (t) => {
    const f = await setup(t);
    f.raw.intent = intent;
    await f.issue();
    f.resetCalls();
    const result = await f.run(["create"]);
    assert.equal(result.code, 0, result.stdout);
    assert.ok(f.calls.mergeRequestReceipt > 0, "the real remote must perform standalone MR reads");
    assert.equal(f.calls.mergeRequest, 0, "a readback must not fetch the identical MR again during context discovery");
    t.diagnostic(JSON.stringify({ intent, apiCalls: f.calls }));
    assert.equal(f.calls.pushPlans, f.calls.discover, "every repository discovery retains push-plan verification");
    assert.ok(f.calls.pushPlans >= f.state.writes.length, "every mutation retains a write guard");
    assert.ok(f.calls.inventory >= f.calls.mergeRequestReceipt, "each readback still discovers the live label inventory");
    assert.ok(f.calls.users >= f.calls.mergeRequestReceipt, "each readback still discovers current project members");
    assert.ok(f.calls.review >= f.calls.mergeRequestReceipt, "each existing-MR readback still discovers approvals/discussions");
    assert.equal(f.state.mr!.draft, intent === "draft");
  });
}

test("default dry-run preserves candidate tokens for the later real submission", async (t) => {
  const f = await setup(t);
  await f.issue();
  const dry = await f.run(["create", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(f.state.writes, []);
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
});

test("default stored verification still refreshes inventory, members and review state", async (t) => {
  const f = await setup(t);
  await f.issue();
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
  f.resetCalls();
  const verified = await f.run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout);
  assert.ok(f.calls.inventory > 0);
  assert.ok(f.calls.users > 0);
  assert.ok(f.calls.review > 0);
});


test("default write guard drains the concurrent diff read before reporting a rejected push plan", { timeout: 60_000 }, async (t) => {
  const f = await setup(t);
  await f.issue();
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
  await f.issue(88);
  const before = f.state.writes.length;
  const gate = f.guardConcurrency;
  gate.armed = true;
  let commandSettled = false;
  let result: Awaited<ReturnType<typeof f.run>> | undefined;
  const command = f.run(["update", "88"]).finally(() => { commandSettled = true; });
  try {
    const reached = await Promise.race([
      Promise.all([gate.pushRejected.promise, gate.diffEntered.promise]).then(() => "concurrent-checks"),
      command.then((value) => "command-finished: " + value.stdout),
    ]);
    assert.equal(reached, "concurrent-checks", "both checks must start at the first write-time guard");
    // Let a fail-fast rejection traverse the adapter/domain promise chain. This
    // is an event-loop boundary, not a duration-based race against a timer.
    await nextEventLoopTurn();
    assert.equal(gate.diffSettled, false);
    assert.equal(commandSettled, false, "command cleanup must not race an in-flight repository read");
    assert.deepEqual(f.state.writes.slice(before), []);
  } finally {
    gate.releaseDiff.resolve();
    result = await command;
  }
  assert.equal(gate.diffSettled, true);
  assert.notEqual(result!.code, 0, result!.stdout);
  assert.match(result!.stdout, /CONCURRENT_UPDATE/);
  assert.deepEqual(f.state.writes.slice(before), []);
});
