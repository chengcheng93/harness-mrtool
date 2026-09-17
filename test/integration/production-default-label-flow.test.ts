import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
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
  const state: { mr: GitLabMergeRequest | null; writes: string[]; drift: boolean; omitP2: boolean; wrongReadback: boolean; driftOnFind: boolean; driftAfterCreate: boolean; renameAfterFind: boolean; sourceMissing: boolean; sourceMissingOnFind: boolean; dirtyOnFind: boolean } = {
    mr: null, writes: [], drift: false, omitP2: false, wrongReadback: false, driftOnFind: false, driftAfterCreate: false, renameAfterFind: false, sourceMissing: false, sourceMissingOnFind: false, dirtyOnFind: false,
  };
  let receiptSequence = 0;
  const receipt = <T>(value: T) => ({ value, requestId: `request-${++receiptSequence}` });
  const applied = (ids: readonly string[]) => ids.map((id) => {
    const label = labels.find((value) => value.globalId === id)!;
    return { restId: label.restId, name: label.name, archived: false };
  });
  const client = {
    origin: "https://gitlab.example.test", audit: () => ({ requestIds: ["request-test"] }),
    getProject: async () => project, getBranchHead: async () => targetSha,
    getCurrentUser: async () => user, listUsers: async () => [user, reviewer],
    labelInventory: async () => { const effective = labels.filter((label) => !state.omitP2 || label.name !== "priority::p2"); return { all: effective, effective, audit: { requestIds: ["request-test"] } }; },
    getReviewState: async () => ({ approvedUserIds: [reviewer.id], unresolvedDiscussions: 0 }),
    getMergeRequest: async () => structuredClone(state.mr!),
    getMergeRequestReceipt: async () => receipt(structuredClone(state.mr!)),
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
      return receipt(null);
    },
    updateMergeRequest: async (_target: unknown, _iid: number, input: GitLabUpdateMergeRequestInput) => {
      state.writes.push(input.kind);
      state.mr = input.kind === "description" ? { ...state.mr!, description: input.description }
        : input.kind === "title" ? { ...state.mr!, title: input.title, draft: input.title.startsWith("Draft:") }
        : { ...state.mr!, title: input.title, draft: input.title.startsWith("Draft:"), targetBranch: input.targetBranch,
          assignees: input.assigneeIds.map((id) => id === 42 ? user : reviewer), reviewers: input.reviewerIds.map((id) => id === 42 ? user : reviewer),
          squash: input.squash, shouldRemoveSourceBranch: input.removeSourceBranch };
      return receipt(structuredClone(state.mr));
    },
  } as unknown as GitLabClient;
  const repo = { gitlabHost: "gitlab.example.test", sourceBranch: "feature/labels", sourceHeadSha: sourceSha, sourceProject: { host: "gitlab.example.test", path: project.fullPath },
    targetProject: { host: "gitlab.example.test", path: project.fullPath }, targetBranch: "develop", sourceRemote: "origin", sourceRemoteRef: "refs/heads/feature/labels",
    targetRemote: "origin", targetRef: "refs/remotes/origin/develop", targetRefSha: targetSha,
    worktree: { clean: true, staged: false, unstaged: false, untracked: false } } as unknown as RepositorySnapshot;
  const diff = { sourceHeadSha: sourceSha, targetRefSha: targetSha, mergeBaseSha: targetSha,
    items: [{ status: "modified" as const, newPath: "src/a.ts", oldPath: "src/a.ts", binary: false, submodule: false, before: "if (a > 0) return a;", after: "if (a >= 0) return a;" }] };
  const repository = { discover: async () => repo, readChangeSet: async () => ({ ...diff, sourceHeadSha: state.drift ? "c".repeat(40) : sourceSha }),
    planPush: async () => ({ kind: state.sourceMissing ? "missing" as const : "up-to-date" as const, remote: "origin", ref: repo.sourceRemoteRef, sourceHeadSha: sourceSha, remoteSha: state.sourceMissing ? null : sourceSha, command: state.sourceMissing ? `git push --no-force origin ${sourceSha}:${repo.sourceRemoteRef}` : null }) };
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.intent = "draft";
  raw.workItem = { relation: "none", noIssueReason: "A self-contained maintenance change." };
  raw.mergeRequest.labelCandidateTokens = [];
  const contextStore = new CandidateContextStore({ stateDirectory });
  const overrides = { stateDirectory, contextStore, repository, stdinIsTerminal: () => false,
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
  async function runInteractive(args: string[], driftAfterApproval = false) {
    let stdout = "", stderr = "";
    const prompts: string[] = [];
    const code = await runProductionMain([...args, "--output", "json"], {
      cwd: root, loadCurrentBundle: async () => currentBundle,
      readOnlyDefaults: { ...overrides, stdinIsTerminal: () => true,
        wizardConsole: {
          selectOne: async ({ id, choices }) => {
            prompts.push(id);
            if (id === "intent") return 0;
            if (id === "workItem.relation") return 0;
            if (id === "impact.nature") return 1;
            if (id === "risk.level") return 1;
            if (id === "assignee") return 1;
            return 0;
          },
          selectMany: async ({ id }) => {
            prompts.push(id);
            if (id === "profiles") return [0, 1];
            if (id === "impact.areaIds") return [0];
            if (id === "verification.itemIds") return [0, 1, 2, 3, 4];
            if (id === "documentation.itemIds") return [2];
            if (id === "reviewers") return [0];
            throw new Error(`Unexpected manual selection ${id}`);
          },
          text: async ({ id, prompt }) => {
            prompts.push(id);
            if (id.startsWith("confirmation.")) return /Confirmation digest: ([a-f0-9:]+)/u.exec(prompt)![1]!;
            if (id === "title.module") return raw.title.module;
            if (id === "title.titleSummary") return raw.title.titleSummary;
            throw new Error(`Unexpected text ${id}`);
          },
          confirm: async ({ id, defaultValue }) => { prompts.push(id); return id === "labels.escalate" ? false : id === "labels.accept" ? true : defaultValue; },
        },
        wizardEditor: { edit: async () => {
          if (driftAfterApproval && state.mr !== null) state.mr = { ...state.mr, description: `Changed after approval.\n${state.mr.description}` };
          return Buffer.from(JSON.stringify({ changes: raw.changes, motivation: raw.motivation,
            noIssueReason: "A self-contained maintenance change.", impact: { details: raw.impact.details },
            verification: { items: raw.verification.items.map(({ id: _id, ...item }: Record<string, unknown>) => item), acceptanceEvidence: raw.verification.acceptanceEvidence, knownGaps: raw.verification.knownGaps },
            documentation: { details: raw.documentation.details }, risk: { items: raw.risk.items, compatibilityImpact: raw.risk.compatibilityImpact, rollbackPlan: raw.risk.rollbackPlan },
            profileFieldValues: [raw.profileFields["docs.target-audience"], raw.profileFields["docs.content-impact"]],
            review: { reviewerFocus: raw.review.reviewerFocus, additionalNotes: raw.review.additionalNotes } }));
        } },
      },
      updatePreflight: { run: async () => {} },
      stdout: { write: (text) => { stdout += text; return true; } }, stderr: { write: (text) => { stderr += text; return true; } },
    });
    return { code, stdout, stderr, prompts };
  }
  return { issue, run, runInteractive, state, raw, diff, currentBundle, removeReceipts: () => rm(resolve(stateDirectory, "verification-receipts"), { recursive: true, force: true }) };
}

test("production main default create writes and reads back exactly three automatic labels with no caller label tokens", async (t) => {
  const f = await setup(t); await f.issue();
  const result = await f.run(["create"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.deepEqual(f.state.mr!.labels.map((label) => label.name).sort(), ["priority::p2", "status::doing", "type::bug"]);
  assert.ok(f.state.writes.includes("create"));
});

test("production main default create rejects missing p2 with zero mutations", async (t) => {
  const f = await setup(t); await f.issue(); f.state.omitP2 = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.match(result.stdout, /LABEL_ERROR/); assert.deepEqual(f.state.writes, []);
});

test("production main default update and verify use the durable receipt and exact bundle", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  await f.issue(88);
  f.raw.changes.summary = ["Update the previously created merge request."];
  const updated = await f.run(["update", "88"]);
  assert.equal(updated.code, 0, updated.stdout + updated.stderr);
  const verified = await f.run(["verify", "88", "--level", "structure"]);
  assert.equal(verified.code, 0, verified.stdout + verified.stderr);
  assert.deepEqual(f.state.mr!.labels.map((label) => label.name).sort(), ["priority::p2", "status::doing", "type::bug"]);
});

test("production main rejects ambiguous source intent and stale confirmation before mutation", async (t) => {
  const f = await setup(t);
  f.diff.items[0]!.after = "export const changed = 42;";
  await f.issue();
  const unknown = await f.run(["create"]);
  assert.notEqual(unknown.code, 0); assert.match(unknown.stdout, /LABEL_ERROR/); assert.deepEqual(f.state.writes, []);
  const stale = await f.run(["create", "--confirm-label-type", "bug", "--label-diff-digest", "0".repeat(64)]);
  assert.notEqual(stale.code, 0); assert.match(stale.stdout, /LABEL_ERROR/); assert.deepEqual(f.state.writes, []);
});

test("production main never reports success when remote label readback differs", async (t) => {
  const f = await setup(t); await f.issue(); f.state.wrongReadback = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.ok(f.state.writes.includes("create"));
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test("production main upsert updates an existing MR without a second create", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  await f.issue();
  const result = await f.run(["create", "--upsert"]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(f.state.writes.filter((operation) => operation === "create").length, 1);
  assert.equal(JSON.parse(result.stdout).data.command, "update");
});

test("production main accepts an explicit type only for the current ambiguous diff digest", async (t) => {
  const f = await setup(t); f.diff.items[0]!.after = "export const changed = 42;"; await f.issue();
  const unknown = await f.run(["create"]);
  const parsed = JSON.parse(unknown.stdout);
  const digest = parsed.error.actual.diffDigest;
  assert.match(digest, /^[a-f0-9]{64}$/u);
  const result = await f.run(["create", "--confirm-label-type", "bug", "--label-diff-digest", digest]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.mandatoryLabels.source, "confirmed");
});

test("production main create dry-run validates labels without writing or consuming the context", async (t) => {
  const f = await setup(t); await f.issue();
  const dry = await f.run(["create", "--dry-run"]);
  assert.equal(dry.code, 0, dry.stdout);
  assert.deepEqual(f.state.writes, []);
  assert.equal(JSON.parse(dry.stdout).remoteWrite.state, "not-attempted");
  const created = await f.run(["create"]);
  assert.equal(created.code, 0, created.stdout);
});

test("default production gate re-reads the local diff after open-MR lookup and prevents first mutation", async (t) => {
  const f = await setup(t); await f.issue(); f.state.driftOnFind = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, []);
  assert.match(result.stdout, /CONCURRENT_UPDATE/);
});

test("default production gate checks automatically chosen label identities just before mutation", async (t) => {
  const f = await setup(t); await f.issue(); f.state.renameAfterFind = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, []);
});

test("default production revalidates the canonical diff before later mutations too", async (t) => {
  const f = await setup(t); await f.issue(); f.state.driftAfterCreate = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, ["create"]);
  assert.equal(JSON.parse(result.stdout).ok, false);
});

test("upsert authenticates the existing MR receipt before updating", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  await f.issue(); await f.removeReceipts();
  const before = f.state.writes.length;
  const result = await f.run(["create", "--upsert"]);
  assert.notEqual(result.code, 0, "upsert must not bypass ownership authentication");
  assert.equal(f.state.writes.length, before);
});

test("explicit force replacement permits body edits but still authenticates marker and receipt", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  await f.issue(88);
  f.state.mr = { ...f.state.mr!, description: `Manual note.\n${f.state.mr!.description}` };
  const result = await f.run(["update", "88", "--force-replace-description"]);
  assert.equal(result.code, 0, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.forcedDescriptionReplacement, true);
  assert.equal(f.state.mr!.description.startsWith("Manual note."), false);
});

test("actual TTY create and update display automatic labels without managed-token selection", async (t) => {
  const f = await setup(t);
  const created = await f.runInteractive(["create"]);
  assert.equal(created.code, 0, created.stdout + created.stderr);
  assert.ok(created.prompts.includes("labels.accept"));
  assert.equal(created.prompts.includes("labels.type"), false);
  const updated = await f.runInteractive(["update", "88"]);
  assert.equal(updated.code, 0, updated.stdout + updated.stderr);
  assert.ok(updated.prompts.includes("confirmation.update-marker"));
  assert.equal(updated.prompts.includes("labels.type"), false);
});

test("TTY update refuses description drift after the displayed approval", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  const before = f.state.writes.length;
  const result = await f.runInteractive(["update", "88", "--force-replace-description"], true);
  assert.notEqual(result.code, 0); assert.equal(f.state.writes.length, before);
  assert.match(result.stdout, /CONCURRENT_UPDATE/);
});

test("API create refuses offline mode before any live mutation", async (t) => {
  const f = await setup(t); await f.issue();
  const result = await f.run(["create", "--offline"]);
  assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, []);
});

test("default production migration consumes migration-bound context only after exact hash confirmation", async (t) => {
  const f = await setup(t); await f.issue();
  const created = await f.run(["create"]); assert.equal(created.code, 0, created.stdout);
  await f.issue(88, true);
  const before = f.state.writes.length;
  const stale = await f.run(["update", "88", "--migrate-template", "--confirm-migration", `${"0".repeat(64)}:${"0".repeat(64)}`]);
  assert.notEqual(stale.code, 0); assert.equal(f.state.writes.length, before);
  const hash = f.currentBundle.bundleManifestHash;
  const result = await f.run(["update", "88", "--migrate-template", "--confirm-migration", `${hash}:${hash}`]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).data.command, "update");
});

test("default API create rejects an unpublished source branch before MR mutation", async (t) => {
  const f = await setup(t); await f.issue(); f.state.sourceMissing = true;
  const result = await f.run(["create"]);
  assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, []);
  assert.match(result.stdout, /REPOSITORY_ERROR/);
});

for (const flag of ["sourceMissingOnFind", "dirtyOnFind"] as const) {
  test(`production rechecks ${flag} after preflight without any MR mutation`, async (t) => {
    const f = await setup(t); await f.issue(); f.state[flag] = true;
    const result = await f.run(["create"]);
    assert.notEqual(result.code, 0); assert.deepEqual(f.state.writes, []);
  });
}
