import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// @ts-expect-error The build helper intentionally has no declaration file.
import { createApplicationBuildOptions } from "../../scripts/build.mjs";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import type { ResolvedTargetProject } from "../../src/cli/target-project.ts";
import type { CanonicalChangeSet } from "../../src/git/change-set.ts";
import type { RepositorySnapshot } from "../../src/git/repository.ts";
import { createProductionRuntime } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import type { TrustedBundleSelection } from "../../src/cli/commands/local.ts";
import { runProductionMain } from "../../src/production-main.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import {
  GITLAB_CREDENTIAL_HOST_ENV,
  GITLAB_CREDENTIAL_TOKEN_ENV,
} from "../../src/platform/gitlab-credential.ts";
import { runProcess } from "../helpers/process.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const bundleDirectory = resolve(repositoryRoot, "template-bundle");
const execFileAsync = promisify(execFile);

const targetProject: ResolvedTargetProject = Object.freeze({
  identity: Object.freeze({ host: "gitlab.example.test", path: "group/project" }),
  project: Object.freeze({
    id: "7",
    fullPath: "group/project",
    defaultBranch: "develop",
    webUrl: "https://gitlab.example.test/group/project",
  }),
  targetRemote: "origin",
});

function selection(
  bundle: Awaited<ReturnType<typeof loadTemplateBundle>>,
): TrustedBundleSelection {
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return {
    bundle,
    bundleManifestHash,
    releaseSetId: `embedded:${bundleManifestHash}`,
    releaseTag: `templates-v${bundle.manifest.version}`,
  };
}

function changeSet(items: CanonicalChangeSet["items"]): CanonicalChangeSet {
  return {
    items,
    mergeBaseSha: "a".repeat(40),
    sourceHeadSha: "b".repeat(40),
    targetRefSha: "a".repeat(40),
  };
}

test("production runtime detects profiles through only repository and change-set reads", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const calls: string[] = [];
  const snapshot = { targetBranch: "main" } as RepositorySnapshot;
  const handlers = createProductionRuntime({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle: selection(bundle),
    targetProjectResolver: { resolve: async () => targetProject },
    profileRepository: {
      discover: async (options) => {
        calls.push("repository");
        assert.deepEqual(options, {
          cwd: "C:\\fixture",
          expectedTargetProject: targetProject.identity,
          targetBranch: "develop",
          targetRemote: "origin",
        });
        return snapshot;
      },
      readChangeSet: async (repository) => {
        calls.push("change-set");
        assert.equal(repository, snapshot);
        return changeSet([
          { status: "modified", newPath: "src/runtime.ts", binary: false, submodule: false },
          { status: "added", newPath: "docs/runtime.md", binary: false, submodule: false },
        ]);
      },
    },
  });
  const invocation = parseCliInvocation(["profiles", "detect", "--output", "json"]);

  const execution = await handlers["profiles.detect"]!(invocation as never);

  assert.deepEqual(calls, ["repository", "change-set"]);
  assert.deepEqual(execution.output?.data, {
    command: "profiles.detect",
    kind: "detected",
    profileIds: ["code", "docs"],
    profileSelectionReasons: [
      { code: "matched-versioned-profile-rules", profileId: "code" },
      { code: "matched-versioned-profile-rules", profileId: "docs" },
    ],
    mergeBaseSha: "a".repeat(40),
    sourceHeadSha: "b".repeat(40),
    targetRefSha: "a".repeat(40),
  });
});

test("production runtime preserves stable ambiguous profile reasons", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const calls: string[] = [];
  const snapshot = { targetBranch: "main" } as RepositorySnapshot;
  const handlers = createProductionRuntime({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle: selection(bundle),
    targetProjectResolver: { resolve: async () => targetProject },
    profileRepository: {
      discover: async () => {
        calls.push("repository");
        return snapshot;
      },
      readChangeSet: async () => {
        calls.push("change-set");
        return changeSet([]);
      },
    },
  });
  const invocation = parseCliInvocation(["profiles", "detect", "--output", "json"]);

  const execution = await handlers["profiles.detect"]!(invocation as never);

  assert.deepEqual(calls, ["repository", "change-set"]);
  assert.deepEqual(execution.output?.data, {
    command: "profiles.detect",
    itemIndex: null,
    kind: "ambiguous",
    reason: "empty-diff",
    profileSelectionReasons: [{ code: "empty-diff", itemIndex: null }],
    mergeBaseSha: "a".repeat(40),
    sourceHeadSha: "b".repeat(40),
    targetRefSha: "a".repeat(40),
  });
});

test("profile repository reads remain isolated from create and update routes", async () => {
  const bundle = await loadTemplateBundle(bundleDirectory);
  const calls: string[] = [];
  const handlers = createProductionRuntime({
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle: selection(bundle),
    targetProjectResolver: {
      resolve: async () => {
        calls.push("target-project");
        return targetProject;
      },
    },
    profileRepository: {
      discover: async () => {
        calls.push("repository");
        throw new Error("profile repository must not serve a write route");
      },
      readChangeSet: async () => {
        calls.push("change-set");
        throw new Error("profile ChangeSet must not serve a write route");
      },
    },
  });

  for (const arguments_ of [
    ["create", "--output", "json"],
    ["update", "--output", "json"],
  ]) {
    const invocation = parseCliInvocation(arguments_);
    const handler = handlers[invocation.command.kind];
    assert.ok(handler);
    await assert.rejects(
      async () => handler(invocation as never),
      (error: unknown) => isToolError(error, "AUTH_ERROR"),
    );
  }
  assert.deepEqual(calls, []);
});

test("production entrypoint and build config use the same public source entry", () => {
  const buildOptions = createApplicationBuildOptions("0.1.0-test") as {
    readonly entryPoints: readonly string[];
  };
  assert.deepEqual(buildOptions.entryPoints, [resolve(repositoryRoot, "src/production-main.ts")]);

  const result = runProcess(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      buildOptions.entryPoints[0]!,
      "version",
      "--output",
      "json",
    ],
    { cwd: repositoryRoot },
  );

  assert.equal(result.error, undefined);
  assert.equal(result.status, 5, result.stderr || result.stdout);
  assert.equal(result.stderr, "");
  assert.equal((JSON.parse(result.stdout) as { readonly code: string }).code, "UPDATE_SECURITY_ERROR");
});

test("production entry serializes a bootstrap failure as exactly one JSON document", async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["version", "--output", "json"], {
    loadCurrentBundle: async () => {
      throw new Error("bootstrap-credential-canary");
    },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
  });

  assert.equal(exitCode, 7);
  assert.equal(stderr.join(""), "");
  assert.equal(stdout.join("").trimEnd().split(/\r?\n/u).length, 1);
  const serialized = stdout.join("");
  assert.doesNotMatch(serialized, /bootstrap-credential-canary/u);
  assert.equal((JSON.parse(serialized) as { readonly code: string }).code, "INTERNAL_ERROR");
});

test("untrusted production source entry fails closed before GitLab access", async (t) => {
  const credential = "credential-canary-token";
  const requests: Array<{ readonly token: string | undefined; readonly url: string | undefined }> = [];
  const server = createServer((request, response) => {
    requests.push({ token: request.headers["private-token"] as string | undefined, url: request.url });
    if (request.method !== "GET" || request.url !== "/api/v4/projects/group%2Fproject") {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: 7,
      path_with_namespace: "group/project",
      default_branch: "main",
      web_url: "https://gitlab.example.test/group/project",
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolveClose, rejectClose) => {
    server.close((error) => error === undefined ? resolveClose() : rejectClose(error));
  }));
  const address = server.address() as AddressInfo;
  const host = `127.0.0.1:${String(address.port)}`;

  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  const remoteRefsBefore = await fixture.git([
    "--git-dir",
    fixture.remotePath,
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads",
  ]);
  await fixture.git(["remote", "set-url", "origin", `http://${host}/group/project.git`]);
  await fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  const sourceHeadSha = await fixture.commitFile(
    "src/default-branch.ts",
    "export const defaultBranch = true;\n",
    "exercise authoritative target resolution",
  );
  const targetRefSha = await fixture.targetHead();
  const buildOptions = createApplicationBuildOptions("0.1.0-test") as {
    readonly entryPoints: readonly string[];
  };

  let result: { readonly status: number; readonly stdout: string; readonly stderr: string };
  try {
    await execFileAsync(process.execPath, [
      "--import",
      import.meta.resolve("tsx"),
      buildOptions.entryPoints[0]!,
      "profiles",
      "detect",
      "--output",
      "json",
    ], {
      cwd: fixture.worktreePath,
      encoding: "utf8",
      env: {
        ...process.env,
        [GITLAB_CREDENTIAL_HOST_ENV]: host,
        [GITLAB_CREDENTIAL_TOKEN_ENV]: credential,
      },
      windowsHide: true,
    });
    assert.fail("an untrusted production entry must fail closed");
  } catch (error) {
    const child = error as { readonly code?: number; readonly stdout?: string; readonly stderr?: string };
    result = {
      status: typeof child.code === "number" ? child.code : -1,
      stdout: typeof child.stdout === "string" ? child.stdout : "",
      stderr: typeof child.stderr === "string" ? child.stderr : "",
    };
  }

  assert.equal(result.status, 5);
  assert.equal(result.stderr, "");
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(credential, "u"));
  const output = JSON.parse(result.stdout) as { readonly code: string; readonly ok: boolean };
  assert.equal(output.ok, false);
  assert.equal(output.code, "UPDATE_SECURITY_ERROR");
  assert.deepEqual(requests, []);
  assert.equal(await fixture.git([
    "--git-dir",
    fixture.remotePath,
    "for-each-ref",
    "--format=%(refname):%(objectname)",
    "refs/heads",
  ]), remoteRefsBefore);
});

test("production entry presentation invokes the same profiles service for JSON and text", async (t) => {
  const fixture = await GitFixture.create();
  t.after(async () => fixture.dispose());
  await fixture.git([
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
    "refs/remotes/origin/main",
  ]);
  await fixture.commitFile(
    "src/production-runtime.ts",
    "export const productionRuntime = true;\n",
    "exercise production profile detection",
  );
  assert.equal(await fixture.remoteHead(), null);
  const calls: string[] = [];
  const output: string[] = [];
  const dependencies = {
    cwd: fixture.worktreePath,
    stdout: { write: (chunk: string) => { output.push(chunk); return true; } },
    stderr: { write: (_chunk: string) => true },
    targetProjectResolver: { resolve: async () => targetProject },
    profileRepository: {
      discover: async () => {
        calls.push("repository");
        return { targetBranch: "develop" } as RepositorySnapshot;
      },
      readChangeSet: async () => {
        calls.push("change-set");
        return changeSet([
          { status: "modified", newPath: "src/production-runtime.ts", binary: false, submodule: false },
        ]);
      },
    },
  } as const;

  const jsonExit = await runProductionMain(
    ["profiles", "detect", "--output", "json"],
    dependencies,
  );
  const textExit = await runProductionMain(["profiles", "detect"], dependencies);

  assert.equal(jsonExit, 0);
  assert.equal(textExit, 0);
  assert.deepEqual(calls, ["repository", "change-set", "repository", "change-set"]);
  assert.match(output.join(""), /Profiles: code/u);
  assert.match(output.join(""), new RegExp(`Target ref: ${"a".repeat(40)}`, "u"));
  assert.equal(await fixture.remoteHead(), null);
});
