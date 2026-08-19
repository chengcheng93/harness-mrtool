import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import type { LoadedMrBundle } from "../../src/app/load-mr-bundle.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { validateTemplateBundle } from "../../src/bundle/validate.ts";
import type { TrustedBundleSelection } from "../../src/cli/commands/local.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { createProductionReadOnlyDefaults } from "../../src/cli/production-runtime.ts";
import type { TargetGitLabSession } from "../../src/cli/target-project.ts";
import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson, sha256CanonicalJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import type { IssueContextInput, IssuedContext } from "../../src/context/types.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";
import type { RepositorySnapshot } from "../../src/git/repository.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { runProductionMain } from "../../src/production-main.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const targetSha = "a".repeat(40);
const sourceSha = "b".repeat(40);

function runProductionProcess(
  arguments_: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, [
    "--import",
    import.meta.resolve("tsx"),
    resolve(repositoryRoot, "src/production-main.ts"),
    ...arguments_,
  ], {
    cwd,
    encoding: "utf8",
    env: environment,
    windowsHide: true,
  });
}

async function currentSelection(): Promise<TrustedBundleSelection> {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return {
    bundle,
    bundleManifestHash,
    releaseSetId: `embedded:${bundleManifestHash}`,
    releaseTag: `templates-v${bundle.manifest.version}`,
  };
}

async function linkedRequest() {
  const raw = JSON.parse(await readFile(
    resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"),
    "utf8",
  )) as Record<string, unknown>;
  return normalizeAndValidateRequest({
    ...raw,
    workItem: { relation: "related", iid: 37 },
  });
}

test("default production request source returns one normalized immutable Request", async () => {
  const [currentBundle, expected] = await Promise.all([currentSelection(), linkedRequest()]);
  const bytes = Buffer.from(JSON.stringify(expected), "utf8");
  let fileReads = 0;
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    inputIo: {
      statFile: async () => ({ size: bytes.byteLength }),
      readFile: async () => {
        fileReads += 1;
        return bytes;
      },
      stdin: {
        [Symbol.asyncIterator]() {
          throw new Error("stdin must not be read for an explicit file");
        },
      },
    },
  });

  const request = await defaults.requestSource.read(
    parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]),
  );

  assert.deepEqual(request, expected);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(Object.isFrozen((request as typeof expected).changes.summary), true);
  assert.equal(fileReads, 1);
});

test("default production request source starts one TTY wizard without pre-reading stdin", async () => {
  const [currentBundle, expected] = await Promise.all([currentSelection(), linkedRequest()]);
  let wizardCalls = 0;
  let ioCalls = 0;
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    stdinIsTerminal: () => true,
    wizard: {
      collect: async ({ invocation }) => {
        wizardCalls += 1;
        assert.equal(invocation.command.kind, "preview");
        return JSON.parse(JSON.stringify(expected)) as unknown;
      },
    },
    inputIo: {
      statFile: async () => { ioCalls += 1; throw new Error("file stat must not run"); },
      readFile: async () => { ioCalls += 1; throw new Error("file read must not run"); },
      stdin: {
        [Symbol.asyncIterator]() {
          ioCalls += 1;
          throw new Error("TTY stdin must not be pre-read");
        },
      },
    },
  });

  const request = await defaults.requestSource.read(
    parseCliInvocation(["preview", "--output", "json"]),
  );

  assert.deepEqual(request, expected);
  assert.equal(Object.isFrozen(request), true);
  assert.equal(wizardCalls, 1);
  assert.equal(ioCalls, 0);
});

test("default TTY wizard issues one context through the same readonly planner with the selected issue", async () => {
  const [currentBundle, expected] = await Promise.all([currentSelection(), linkedRequest()]);
  const repositoryCalls: string[] = [];
  const sessionFixture = fixtureSession({
    getBranchHead: async () => targetSha,
    listUsers: async () => [
      {
        id: "42",
        username: "doctor",
        displayName: "Doctor",
        state: "active" as const,
        accessLevel: 40,
      },
      {
        id: "43",
        username: "reviewer",
        displayName: "Reviewer",
        state: "active" as const,
        accessLevel: 40,
      },
    ],
    getIssue: async (_project: string, iid: number) => ({
      iid,
      milestone: null,
      assignees: [],
      dueDate: null,
      labels: [],
    }),
  });
  let issueCalls = 0;
  let issuedInput: IssueContextInput | undefined;
  const contextStore = {
    issue: async (input: IssueContextInput): Promise<IssuedContext> => {
      issueCalls += 1;
      issuedInput = input;
      return {
        contextId: `hmrx1_${"x".repeat(43)}`,
        createdAtMs: 1_000,
        expiresAtMs: 1_001,
        externalSnapshotDigest: sha256CanonicalJson(input.snapshot),
        candidates: input.candidates.map((metadata, index) => ({
          kind: metadata.kind,
          token: `hmrc1_${String(index).padStart(43, "0")}`,
          metadata,
        })),
      };
    },
    resolve: async (): Promise<never> => { throw new Error("resolve must remain lazy"); },
  };
  const selected: Readonly<Record<string, number>> = {
    "workItem.relation": 1,
    intent: 1,
    "title.type": 1,
    "impact.nature": 1,
    "risk.level": 1,
    assignee: 1,
  };
  const selectedMany: Readonly<Record<string, readonly number[]>> = {
    profiles: [0, 1],
    "impact.areaIds": [0],
    "verification.itemIds": [0, 1, 2, 3, 4],
    "documentation.itemIds": [2],
    "labels.week": [0],
    "labels.type": [0],
    "labels.priority": [0],
    reviewers: [0],
  };
  let editorCalls = 0;
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    contextStore,
    repository: repositoryPort(repositoryCalls),
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    stdinIsTerminal: () => true,
    wizardConsole: {
      selectOne: async ({ id }) => selected[id]!,
      selectMany: async ({ id }) => selectedMany[id]!,
      text: async ({ id }) => ({
        "workItem.iid": "37",
        "title.module": expected.title.module,
        "title.titleSummary": expected.title.titleSummary,
      } as const)[id]!,
      confirm: async () => true,
    },
    wizardEditor: {
      edit: async () => {
        editorCalls += 1;
        return Buffer.from(JSON.stringify({
          changes: expected.changes,
          motivation: expected.motivation,
          noIssueReason: null,
          impact: { details: expected.impact.details },
          verification: {
            items: expected.verification.items.map(({ id: _id, ...item }) => item),
            acceptanceEvidence: expected.verification.acceptanceEvidence,
            knownGaps: expected.verification.knownGaps,
          },
          documentation: { details: expected.documentation.details },
          risk: {
            items: expected.risk.items,
            compatibilityImpact: expected.risk.compatibilityImpact,
            rollbackPlan: expected.risk.rollbackPlan,
          },
          profileFieldValues: [
            expected.profileFields["docs.target-audience"],
            expected.profileFields["docs.content-impact"],
          ],
          review: {
            reviewerFocus: expected.review.reviewerFocus,
            additionalNotes: expected.review.additionalNotes,
          },
        }), "utf8");
      },
    },
  });

  const request = await defaults.requestSource.read(
    parseCliInvocation(["preview", "--output", "json"]),
  );

  assert.equal(issueCalls, 1);
  assert.equal(editorCalls, 1);
  assert.equal((issuedInput?.snapshot as { readonly issue?: { readonly iid?: number } }).issue?.iid, 37);
  assert.deepEqual((request as typeof expected).workItem, { relation: "related", iid: 37 });
  assert.deepEqual(repositoryCalls.map((entry) => entry.split(":", 1)[0]), [
    "discover",
    "change-set",
    "push-plan",
  ]);
});

test("production text mode fails closed before request input without production trust roots", () => {
  const result = runProductionProcess(["preview"], repositoryRoot, process.env);

  assert.equal(result.error, undefined);
  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "UPDATE_SECURITY_ERROR: Signed update metadata could not be verified: trusted key state is invalid\n",
  );
  assert.doesNotMatch(result.stderr, /requires --output json/u);
});

test("production source fails closed before private state bootstrap without trust roots", {
  skip: process.platform !== "win32",
}, async (t) => {
  const cwd = await mkdtemp(resolve(tmpdir(), "harness-mrtool-no-state-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const environment = { ...process.env };
  delete environment.LOCALAPPDATA;

  const version = runProductionProcess(["version", "--output", "json"], cwd, environment);
  assert.equal(version.error, undefined);
  assert.equal(version.status, 5, version.stderr || version.stdout);
  assert.equal((JSON.parse(version.stdout) as { readonly code: string }).code, "UPDATE_SECURITY_ERROR");

  const doctor = runProductionProcess(["doctor", "--output", "json"], cwd, environment);
  assert.equal(doctor.error, undefined);
  assert.equal(doctor.status, 5, doctor.stderr || doctor.stdout);
  assert.equal((JSON.parse(doctor.stdout) as { readonly code: string }).code, "UPDATE_SECURITY_ERROR");

  const context = runProductionProcess(["context", "--output", "json"], cwd, environment);
  assert.equal(context.error, undefined);
  assert.equal(context.status, 5, context.stderr || context.stdout);
  assert.equal((JSON.parse(context.stdout) as { readonly code: string }).code, "UPDATE_SECURITY_ERROR");
  assert.doesNotMatch(`${version.stdout}\n${version.stderr}\n${doctor.stdout}\n${doctor.stderr}\n${context.stdout}\n${context.stderr}`, /LOCALAPPDATA|bootstrap/iu);
});

test("default context state is resolved once per production composition", async () => {
  const currentBundle = await currentSelection();
  let firstReads = 0;
  let secondReads = 0;
  const first = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    get stateDirectory() {
      firstReads += 1;
      return resolve(repositoryRoot, ".state-first");
    },
  });
  const second = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    get stateDirectory() {
      secondReads += 1;
      return resolve(repositoryRoot, ".state-second");
    },
  });

  assert.equal(firstReads, 0);
  assert.equal(secondReads, 0);
  await assert.rejects(first.contextStore.resolve({} as never), (error: unknown) =>
    isToolError(error, "INPUT_ERROR"));
  await assert.rejects(first.contextStore.resolve({} as never), (error: unknown) =>
    isToolError(error, "INPUT_ERROR"));
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 0);
  await assert.rejects(second.contextStore.resolve({} as never), (error: unknown) =>
    isToolError(error, "INPUT_ERROR"));
  assert.equal(firstReads, 1);
  assert.equal(secondReads, 1);
});

function repositorySnapshot(): RepositorySnapshot {
  return {
    gitlabHost: "gitlab.example.test",
    sourceBranch: "feature/read-only",
    sourceHeadSha: sourceSha,
    sourceProject: { host: "gitlab.example.test", path: "group/project" },
    sourceRemote: "origin",
    sourceRemoteRef: "refs/heads/feature/read-only",
    targetBranch: "develop",
    targetProject: { host: "gitlab.example.test", path: "group/project" },
    targetRefSha: targetSha,
    targetRef: "refs/remotes/origin/develop",
    targetRemote: "origin",
    worktree: { clean: true, staged: false, unstaged: false, untracked: false },
  } as unknown as RepositorySnapshot;
}

function fixtureSession(
  overrides: Record<string, unknown> = {},
  assertNoCredentialExposure: TargetGitLabSession["assertNoCredentialExposure"] = () => {},
): {
  readonly calls: string[];
  readonly session: TargetGitLabSession;
} {
  const calls: string[] = [];
  const gitlab = {
    origin: "https://gitlab.example.test",
    audit: () => ({ requestIds: ["request-a"] }),
    getCurrentUser: async () => {
      calls.push("current-user");
      return {
        id: "42",
        username: "doctor",
        displayName: "Doctor",
        state: "active" as const,
        accessLevel: 40,
      };
    },
    listUsers: async (project: string) => {
      calls.push(`members:${project}`);
      return [{
        id: "42",
        username: "doctor",
        displayName: "Doctor",
        state: "active" as const,
        accessLevel: 40,
      }];
    },
    probeCapabilities: async () => {
      calls.push("capabilities");
      return {
        version: "18.2.0",
        revision: "fixture",
        mergeRequestSetLabels: true as const,
        labelOperationModes: ["ADD", "REMOVE"] as const,
      };
    },
    labelInventory: async (project: string) => {
      calls.push(`labels:${project}`);
      const effective = [
        [1, "week::2026-w33"],
        [2, "type::feature"],
        [3, "priority::p1"],
        [4, "status::doing"],
        [5, "status::review"],
      ].map(([restId, name]) => ({
        restId: restId as number,
        globalId: `gid://gitlab/ProjectLabel/${String(restId)}`,
        name: name as string,
        description: "Policy label",
        color: "#123456",
        archived: false,
        scopeKind: "project" as const,
        scopeId: "7",
        scopePath: "group/project",
      }));
      return { all: effective, effective, audit: { requestIds: ["request-a"] } };
    },
    getProject: async (reference: string) => {
      calls.push(`project:${reference}`);
      return {
        id: "7",
        fullPath: "group/project",
        defaultBranch: "develop",
        webUrl: "https://gitlab.example.test/group/project",
      };
    },
    getMergeRequest: async (project: string, iid: number) => {
      calls.push(`mr:${project}:${String(iid)}`);
      return {
        iid,
        webUrl: `https://gitlab.example.test/group/project/-/merge_requests/${String(iid)}`,
        title: "feat(read-only): exercise the historical path",
        description: "marker-owned-description",
        draft: false,
        state: "opened" as const,
        sourceProjectId: "7",
        sourceBranch: "feature/read-only",
        targetProjectId: "7",
        targetBranch: "develop",
        sha: sourceSha,
        author: {
          id: "42",
          globalId: "gid://gitlab/User/42",
          username: "author",
          displayName: "Author",
          state: "active" as const,
          accessLevel: 40,
        },
        assignees: [],
        reviewers: [],
        labels: [],
        squash: true,
        shouldRemoveSourceBranch: true,
        pipelineStatus: "pending" as const,
      };
    },
    ...overrides,
  };
  return {
    calls,
    session: Object.freeze({
      assertNoCredentialExposure,
      gitlab: gitlab as unknown as GitLabClient,
      identity: Object.freeze({ host: "gitlab.example.test", path: "group/project" }),
      origin: "https://gitlab.example.test",
      project: Object.freeze({
        id: "7",
        fullPath: "group/project",
        defaultBranch: "develop",
        webUrl: "https://gitlab.example.test/group/project",
      }),
      targetRemote: "origin",
    }),
  };
}

function repositoryPort(calls: string[]) {
  return {
    discover: async (input: unknown) => {
      calls.push(`discover:${JSON.stringify(input)}`);
      return repositorySnapshot();
    },
    readChangeSet: async () => {
      calls.push("change-set");
      return {
        items: [
          { status: "added" as const, newPath: "src/read-only.ts", binary: false, submodule: false },
          { status: "added" as const, newPath: "docs/read-only.md", binary: false, submodule: false },
        ],
        mergeBaseSha: targetSha,
        sourceHeadSha: sourceSha,
        targetRefSha: targetSha,
      };
    },
    planPush: async () => {
      calls.push("push-plan");
      return {
        kind: "up-to-date" as const,
        remote: "origin",
        ref: "refs/heads/feature/read-only",
        sourceHeadSha: sourceSha,
        remoteSha: sourceSha,
        command: null,
      };
    },
  };
}

async function historicalBundle(current: TrustedBundleSelection): Promise<LoadedMrBundle> {
  const bundle = structuredClone(current.bundle);
  (bundle.manifest as { version: string }).version = "0.9.0";
  validateTemplateBundle(bundle);
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return {
    bundle,
    marker: { renderPhase: "final" } as LoadedMrBundle["marker"],
    receipt: {} as LoadedMrBundle["receipt"],
    reference: {
      releaseTag: "templates-v0.9.0",
      bundleId: bundle.manifest.bundleId,
      bundleVersion: bundle.manifest.version,
      bundleManifestHash,
      policySchema: bundle.manifest.policySchema,
    },
    bundleManifestHash,
    eol: false,
  };
}

test("default read-only planner resolves one session and derives preview issue from normalized Request", async () => {
  const [currentBundle, request] = await Promise.all([currentSelection(), linkedRequest()]);
  const sessionFixture = fixtureSession();
  let sessionResolutions = 0;
  const repositoryCalls: string[] = [];
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: {
      resolve: async () => {
        sessionResolutions += 1;
        return sessionFixture.session;
      },
    },
    repository: repositoryPort(repositoryCalls),
  });

  const prepared = await defaults.planner.prepare({
    cliVersion: "0.1.0-test",
    command: "preview",
    currentBundle,
    cwd: "C:\\fixture",
    invocation: parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]),
    request,
    contextIssueIid: null,
  });

  assert.equal(sessionResolutions, 1);
  assert.equal(prepared.selection.bundleManifestHash, currentBundle.bundleManifestHash);
  assert.equal(prepared.options.issueIid, 37);
  assert.equal(prepared.options.mrIid, null);
  assert.equal(prepared.options.targetProject, "group/project");
  assert.deepEqual(prepared.profileDetection.profileIds, ["code", "docs"]);
  assert.deepEqual(prepared.mergeRequestPlan, { action: "create", iid: null, webUrl: null });
  assert.deepEqual(repositoryCalls.map((entry) => entry.split(":", 1)[0]), [
    "discover",
    "change-set",
    "push-plan",
  ]);
});

test("default planner binds the exact target-session credential assertion", async () => {
  const [currentBundle, request] = await Promise.all([currentSelection(), linkedRequest()]);
  const credential = "s3cr3t-canary-abc123";
  let assertions = 0;
  const assertion: TargetGitLabSession["assertNoCredentialExposure"] = (value) => {
    assertions += 1;
    if (JSON.stringify(value).includes(credential)) {
      throw new ToolError("INTERNAL_ERROR", "GitLab response failed credential isolation", {
        field: "gitlab.response",
        expected: "credential-free canonical GitLab response data",
        actual: "unsafe GitLab response data",
        safeNextStep: "Retry after removing credential reflection from GitLab metadata.",
      });
    }
  };
  const sessionFixture = fixtureSession({}, assertion);
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort([]),
  });

  const prepared = await defaults.planner.prepare({
    cliVersion: "0.1.0-test",
    command: "preview",
    currentBundle,
    cwd: "C:\\fixture",
    invocation: parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]),
    request,
    contextIssueIid: null,
  });
  const bound = (prepared as typeof prepared & {
    readonly assertNoCredentialExposure?: TargetGitLabSession["assertNoCredentialExposure"];
  }).assertNoCredentialExposure;

  assert.equal(typeof bound, "function");
  const before = assertions;
  assert.throws(() => bound?.({ description: credential }), (error: unknown) =>
    isToolError(error, "INTERNAL_ERROR") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes(credential));
  assert.equal(assertions, before + 1);
});

test("default planner fails closed when an injected target session lacks credential isolation", async () => {
  const [currentBundle, request] = await Promise.all([currentSelection(), linkedRequest()]);
  const sessionFixture = fixtureSession();
  const { assertNoCredentialExposure: omitted, ...unprotected } = sessionFixture.session;
  assert.equal(typeof omitted, "function");
  const repositoryCalls: string[] = [];
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: {
      resolve: async () => unprotected as unknown as TargetGitLabSession,
    },
    repository: repositoryPort(repositoryCalls),
  });

  await assert.rejects(defaults.planner.prepare({
    cliVersion: "0.1.0-test",
    command: "preview",
    currentBundle,
    cwd: "C:\\fixture",
    invocation: parseCliInvocation(["preview", "--input", "request.json", "--output", "json"]),
    request,
    contextIssueIid: null,
  }), (error: unknown) => isToolError(error, "INTERNAL_ERROR"));
  assert.deepEqual(repositoryCalls, []);
});

test("context MR uses only the injected exact historical loader and migration records both Bundles", async () => {
  const currentBundle = await currentSelection();
  const historical = await historicalBundle(currentBundle);
  const sessionFixture = fixtureSession();
  const repositoryCalls: string[] = [];
  const loads: string[] = [];
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: 37,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort(repositoryCalls),
    historicalMrBundleLoader: {
      loadVerifiedExact: async (current) => {
        loads.push(`${String(current.iid)}:${current.targetProjectId}:${current.description}`);
        return historical;
      },
    },
  });
  const common = {
    cliVersion: "0.1.0-test",
    command: "context" as const,
    currentBundle,
    cwd: "C:\\fixture",
    request: null,
    contextIssueIid: 37,
  };

  const update = await defaults.planner.prepare({
    ...common,
    invocation: parseCliInvocation(["context", "--mr", "88", "--output", "json"]),
  });
  const migration = await defaults.planner.prepare({
    ...common,
    invocation: parseCliInvocation([
      "context", "--mr", "88", "--migrate-template", "--output", "json",
    ]),
  });

  assert.equal(update.selection.bundleManifestHash, historical.bundleManifestHash);
  assert.equal(update.options.operation, "update");
  assert.equal(update.options.issueIid, 37);
  assert.deepEqual(update.mergeRequestPlan, {
    action: "update",
    iid: 88,
    webUrl: "https://gitlab.example.test/group/project/-/merge_requests/88",
  });
  assert.equal(migration.selection.bundleManifestHash, currentBundle.bundleManifestHash);
  assert.equal(migration.options.operation, "migrate");
  assert.deepEqual(migration.migration, {
    oldReleaseTag: historical.reference.releaseTag,
    newReleaseTag: currentBundle.releaseTag,
    oldBundleManifestHash: historical.bundleManifestHash,
    newBundleManifestHash: currentBundle.bundleManifestHash,
    oldPolicySchema: historical.bundle.manifest.policySchema,
    newPolicySchema: currentBundle.bundle.manifest.policySchema,
    historicalBundleEol: false,
  });
  assert.deepEqual(loads, [
    "88:7:marker-owned-description",
    "88:7:marker-owned-description",
  ]);
});

test("default planner rejects a GitLab MR whose returned IID differs from the requested IID", async () => {
  const currentBundle = await currentSelection();
  const historical = await historicalBundle(currentBundle);
  const base = fixtureSession();
  const mismatched = fixtureSession({
    getMergeRequest: async (project: string, iid: number) => ({
      ...await base.session.gitlab.getMergeRequest(project, iid),
      iid: iid + 1,
    }),
  });
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => mismatched.session },
    repository: repositoryPort([]),
    historicalMrBundleLoader: { loadVerifiedExact: async () => historical },
  });

  await assert.rejects(
    defaults.planner.prepare({
      cliVersion: "0.1.0-test",
      command: "context",
      currentBundle,
      cwd: "C:\\fixture",
      request: null,
      contextIssueIid: null,
      invocation: parseCliInvocation(["context", "--mr", "88", "--output", "json"]),
    }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR"),
  );
});

test("historical MR failures never fall back to the current Bundle or repository planning", async () => {
  const currentBundle = await currentSelection();
  const failures = [
    new ToolError("UNMANAGED_MR", "Marker is missing", {
      field: "mergeRequest.description",
      expected: "a final marker",
      actual: "missing marker",
      safeNextStep: "Refresh the managed MR.",
    }),
    new ToolError("UPDATE_SECURITY_ERROR", "Receipt is bound to another marker", {
      field: "bundle",
      expected: "the exact durable receipt",
      actual: "receipt mismatch",
      safeNextStep: "Restore the exact receipt.",
    }),
  ];

  for (const failure of failures) {
    const sessionFixture = fixtureSession();
    const repositoryCalls: string[] = [];
    const defaults = createProductionReadOnlyDefaults({
      cliVersion: "0.1.0-test",
      cwd: "C:\\fixture",
      currentBundle,
      contextIssueIid: null,
      targetSessionResolver: { resolve: async () => sessionFixture.session },
      repository: repositoryPort(repositoryCalls),
      historicalMrBundleLoader: { loadVerifiedExact: async () => { throw failure; } },
    });

    await assert.rejects(
      defaults.planner.prepare({
        cliVersion: "0.1.0-test",
        command: "context",
        currentBundle,
        cwd: "C:\\fixture",
        invocation: parseCliInvocation(["context", "--mr", "88", "--output", "json"]),
        request: null,
        contextIssueIid: null,
      }),
      (error: unknown) => isToolError(error, failure.code),
    );
    assert.deepEqual(repositoryCalls, []);
  }
});

test("missing production historical source fails with fixed safe metadata and no current fallback", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const repositoryCalls: string[] = [];
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort(repositoryCalls),
  });

  await assert.rejects(
    defaults.planner.prepare({
      cliVersion: "0.1.0-test",
      command: "context",
      currentBundle,
      cwd: "C:\\fixture",
      invocation: parseCliInvocation(["context", "--mr", "88", "--output", "json"]),
      request: null,
      contextIssueIid: null,
    }),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes("gitlab.example.test") &&
      !`${error.message}\n${JSON.stringify(error.details)}`.includes("marker-owned-description"),
  );
  assert.deepEqual(repositoryCalls, []);
});

test("production main installs the real default doctor instead of the auth fallback", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const repositoryCalls: string[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runProductionMain(["doctor", "--output", "json"], {
    loadCurrentBundle: async () => currentBundle,
    readOnlyDefaults: {
      targetSessionResolver: { resolve: async () => sessionFixture.session },
      repository: repositoryPort(repositoryCalls),
    },
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
  });

  const output = JSON.parse(stdout.join("")) as {
    readonly ok: boolean;
    readonly code: string;
    readonly data?: {
      readonly command?: string;
      readonly capabilities?: Readonly<Record<string, boolean>>;
    };
  };
  assert.equal(exitCode, 0);
  assert.equal(output.ok, true);
  assert.equal(output.code, "OK");
  assert.equal(output.data?.command, "doctor");
  assert.equal(output.data?.capabilities?.["labels-list"], true);
  assert.equal(output.data?.capabilities?.["gitlab-minimum-permissions"], true);
  assert.equal(output.data?.capabilities?.context, false);
  assert.equal(output.data?.capabilities?.preview, false);
  assert.deepEqual(sessionFixture.calls, [
    "current-user",
    "members:7",
    "project:7",
    "capabilities",
    "labels:7",
  ]);
  assert.deepEqual(repositoryCalls.map((entry) => entry.split(":", 1)[0]), [
    "discover",
    "change-set",
  ]);
  assert.deepEqual(stderr, []);
});

test("default doctor rejects arbitrary credentials reflected by GitLab read diagnostics", async () => {
  const currentBundle = await currentSelection();
  const credential = "s3cr3t-canary-abc123";
  const sessionFixture = fixtureSession({
    audit: () => ({ requestIds: [credential] }),
    getCurrentUser: async () => ({
      id: "42",
      username: "doctor",
      displayName: credential,
      state: "active" as const,
      accessLevel: 40,
    }),
    labelInventory: async () => ({
      all: [],
      effective: [{
        restId: 1,
        globalId: "gid://gitlab/ProjectLabel/1",
        name: "type::feature",
        description: credential,
        color: "#123456",
        archived: false,
        scopeKind: "project" as const,
        scopeId: "7",
        scopePath: "group/project",
      }],
      audit: { requestIds: [credential] },
    }),
  }, (value) => {
    if (JSON.stringify(value).includes(credential)) {
      throw new ToolError("INTERNAL_ERROR", "injected credential guard", {
        field: "gitlab.response",
        expected: "credential-free canonical GitLab response data",
        actual: "unsafe GitLab response data",
        safeNextStep: "Retry after removing credential reflection from GitLab metadata.",
      });
    }
  });
  const stdout: string[] = [];

  const exitCode = await runProductionMain(["doctor", "--output", "json"], {
    loadCurrentBundle: async () => currentBundle,
    readOnlyDefaults: {
      targetSessionResolver: { resolve: async () => sessionFixture.session },
      repository: repositoryPort([]),
    },
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: () => true },
  });

  const serialized = stdout.join("");
  assert.equal(exitCode, 7, serialized);
  assert.equal((JSON.parse(serialized) as { readonly code: string }).code, "INTERNAL_ERROR");
  assert.doesNotMatch(serialized, new RegExp(credential, "u"));
});

test("default doctor reports missing capability and label probes without attempting mutations", async () => {
  const currentBundle = await currentSelection();
  let mutations = 0;
  const sessionFixture = fixtureSession({
    probeCapabilities: undefined,
    labelInventory: undefined,
    createDraft: async () => { mutations += 1; throw new Error("mutation"); },
    addLabels: async () => { mutations += 1; throw new Error("mutation"); },
    removeLabels: async () => { mutations += 1; throw new Error("mutation"); },
  });
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort([]),
  });

  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-test",
    currentBundle,
    cwd: "C:\\fixture",
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("gitlab-capabilities")?.status, "failed");
  assert.equal(checks.get("gitlab-labels-rest")?.status, "failed");
  assert.equal(checks.get("gitlab-minimum-permissions")?.status, "passed");
  assert.equal(checks.get("required-label-candidates")?.status, "failed");
  assert.equal(checks.get("signed-cache")?.status, "warning");
  assert.equal(checks.get("update-state")?.status, "warning");
  assert.equal(checks.get("rollback-state")?.status, "warning");
  assert.equal(report.capabilities["gitlab-label-id-mutation"], false);
  assert.equal(report.capabilities["labels-list"], false);
  assert.equal(mutations, 0);
});

test("default doctor preserves partial diagnostics when one read probe fails", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession({
    probeCapabilities: async () => { throw new Error("probe unavailable"); },
  });
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort([]),
  });

  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-test",
    currentBundle,
    cwd: "C:\\fixture",
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("repository")?.status, "passed");
  assert.equal(checks.get("gitlab-authentication")?.status, "passed");
  assert.equal(checks.get("gitlab-minimum-permissions")?.status, "passed");
  assert.equal(checks.get("gitlab-capabilities")?.status, "failed");
  assert.equal(checks.get("gitlab-labels-rest")?.status, "passed");
  assert.equal(checks.get("required-label-candidates")?.status, "passed");
  assert.equal(report.capabilities["gitlab-label-id-mutation"], false);
  assert.equal(report.capabilities["labels-list"], true);
});

test("default doctor reports insufficient project permissions without losing read diagnostics", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession({
    listUsers: async () => [{
      id: "42",
      username: "doctor",
      displayName: "Doctor",
      state: "active" as const,
      accessLevel: 20,
    }],
  });
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: repositoryPort([]),
  });

  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-test",
    currentBundle,
    cwd: "C:\\fixture",
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("gitlab-authentication")?.status, "passed");
  assert.equal(checks.get("gitlab-minimum-permissions")?.status, "failed");
  assert.equal(checks.get("gitlab-labels-rest")?.status, "passed");
  assert.equal(report.capabilities["gitlab-minimum-permissions"], false);
});

test("default doctor preserves snapshot diagnostics when change-set binding drifts", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const baseRepository = repositoryPort([]);
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: {
      ...baseRepository,
      discover: async (input) => ({
        ...await baseRepository.discover(input),
        worktree: { clean: false, staged: false, unstaged: true, untracked: false },
      }),
      readChangeSet: async (repository) => ({
        ...await baseRepository.readChangeSet(),
        sourceHeadSha: "c".repeat(40),
      }),
    },
  });

  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-test",
    currentBundle,
    cwd: "C:\\fixture",
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("repository")?.status, "failed");
  assert.deepEqual(checks.get("remote"), {
    id: "remote",
    status: "passed",
    detail: "Git remote and GitLab host identity are bound to the target session.",
  });
  assert.deepEqual(checks.get("worktree"), {
    id: "worktree",
    status: "warning",
    detail: "Git worktree has local changes.",
  });
  assert.equal(checks.get("gitlab-authentication")?.status, "passed");
  assert.equal(checks.get("gitlab-labels-rest")?.status, "passed");
});

test("default doctor preserves snapshot diagnostics when change-set reading fails", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const baseRepository = repositoryPort([]);
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: {
      ...baseRepository,
      discover: async (input) => ({
        ...await baseRepository.discover(input),
        worktree: { clean: false, staged: false, unstaged: true, untracked: false },
      }),
      readChangeSet: async () => {
        throw new Error("change-set unavailable");
      },
    },
  });

  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-test",
    currentBundle,
    cwd: "C:\\fixture",
  });
  const checks = new Map(report.checks.map((check) => [check.id, check]));

  assert.equal(checks.get("repository")?.status, "failed");
  assert.deepEqual(checks.get("remote"), {
    id: "remote",
    status: "passed",
    detail: "Git remote and GitLab host identity are bound to the target session.",
  });
  assert.deepEqual(checks.get("worktree"), {
    id: "worktree",
    status: "warning",
    detail: "Git worktree has local changes.",
  });
  assert.equal(report.capabilities["labels-list"], false);
});

test("default planner rejects a push plan from another repository remote", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const baseRepository = repositoryPort([]);
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    contextIssueIid: null,
    targetSessionResolver: { resolve: async () => sessionFixture.session },
    repository: {
      ...baseRepository,
      planPush: async () => ({
        ...await baseRepository.planPush(),
        remote: "other",
      }),
    },
  });

  await assert.rejects(
    defaults.planner.prepare({
      cliVersion: "0.1.0-test",
      command: "context",
      currentBundle,
      cwd: "C:\\fixture",
      invocation: parseCliInvocation(["context", "--output", "json"]),
      request: null,
      contextIssueIid: null,
    }),
    (error: unknown) => isToolError(error, "REPOSITORY_ERROR"),
  );
});

test("production main context MR reaches the installed planner and fails closed without trust", async () => {
  const currentBundle = await currentSelection();
  const sessionFixture = fixtureSession();
  const repositoryCalls: string[] = [];
  const stdout: string[] = [];

  const exitCode = await runProductionMain(["context", "--mr", "88", "--output", "json"], {
    loadCurrentBundle: async () => currentBundle,
    readOnlyDefaults: {
      targetSessionResolver: { resolve: async () => sessionFixture.session },
      repository: repositoryPort(repositoryCalls),
    },
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: () => true },
  });

  const serialized = stdout.join("");
  const output = JSON.parse(serialized) as { readonly ok: boolean; readonly code: string };
  assert.notEqual(exitCode, 0);
  assert.equal(output.ok, false);
  assert.equal(output.code, "UPDATE_SECURITY_ERROR");
  assert.notEqual(output.code, "AUTH_ERROR");
  assert.deepEqual(repositoryCalls, []);
  assert.deepEqual(sessionFixture.calls, ["mr:7:88"]);
  assert.doesNotMatch(serialized, /gitlab\.example\.test|marker-owned-description/u);
});
