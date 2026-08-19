import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createProductionRuntime } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { isToolError, ToolError } from "../../src/contracts/errors.ts";
import { runProductionMain } from "../../src/production-main.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

async function runtimeFixture() {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const bundleManifestHash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  const currentBundle = {
    bundle,
    bundleManifestHash,
    releaseSetId: `embedded:${bundleManifestHash}`,
    releaseTag: `templates-v${bundle.manifest.version}`,
  } as const;
  const calls: string[] = [];
  const common = {
    cliVersion: "0.1.0-test",
    cwd: "C:\\fixture",
    currentBundle,
    targetProjectResolver: {
      resolve: async () => {
        calls.push("target-project");
        throw new Error("target project should be lazy");
      },
    },
    profileRepository: {
      discover: async () => {
        calls.push("profile-repository");
        throw new Error("profile repository should be lazy");
      },
      readChangeSet: async () => {
        calls.push("change-set");
        throw new Error("change set should be lazy");
      },
    },
  };
  const readOnly = {
    contextStore: {
      issue: async (): Promise<never> => {
        calls.push("issue");
        throw new Error("context store should be lazy");
      },
      resolve: async (): Promise<never> => {
        calls.push("resolve");
        throw new Error("context store should be lazy");
      },
    },
    planner: {
      prepare: async (): Promise<never> => {
        calls.push("planner");
        throw new Error("planner should be lazy");
      },
    },
    doctorProbe: {
      inspect: async () => {
        calls.push("doctor");
        return {
          checks: [{ id: "repository", status: "passed" as const, detail: "Repository is readable." }],
          capabilities: { labelIdMutation: true },
        };
      },
    },
    requestSource: {
      read: async (): Promise<never> => {
        calls.push("request");
        throw new Error("request source should be lazy");
      },
    },
    resolveCandidates: async (): Promise<never> => {
      calls.push("candidates");
      throw new Error("candidate resolver should be lazy");
    },
    externalContextReader: {
      read: async (): Promise<never> => {
        calls.push("external-context");
        throw new Error("external context should be lazy");
      },
    },
  };
  return { calls, common, readOnly };
}

test("production runtime wires complete read-only dependencies lazily", async () => {
  const fixture = await runtimeFixture();
  const handlers = createProductionRuntime({
    ...fixture.common,
    readOnly: fixture.readOnly,
  });
  const invocation = parseCliInvocation(["doctor", "--output", "json"]);

  const result = await handlers.doctor!(invocation as never);

  assert.deepEqual(fixture.calls, ["doctor"]);
  assert.deepEqual(result.output?.data, {
    command: "doctor",
    checks: [{ id: "repository", status: "passed", detail: "Repository is readable." }],
    capabilities: { labelIdMutation: true },
  });
});

test("production runtime remains fail-closed when read-only dependencies are absent", async () => {
  const fixture = await runtimeFixture();
  const handlers = createProductionRuntime(fixture.common);
  const invocation = parseCliInvocation(["doctor", "--output", "json"]);

  await assert.rejects(
    async () => handlers.doctor!(invocation as never),
    (error: unknown) => isToolError(error, "AUTH_ERROR"),
  );
  assert.deepEqual(fixture.calls, []);
});

test("production main accepts the same complete read-only injection for JSON execution", async () => {
  const fixture = await runtimeFixture();
  const stdout: string[] = [];
  const stderr: string[] = [];

  const exitCode = await runProductionMain(["doctor", "--output", "json"], {
    cwd: fixture.common.cwd,
    loadCurrentBundle: async () => fixture.common.currentBundle,
    profileRepository: fixture.common.profileRepository,
    targetProjectResolver: fixture.common.targetProjectResolver,
    readOnly: fixture.readOnly,
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
  });

  assert.equal(exitCode, 0, stdout.join("") || stderr.join(""));
  assert.equal(stderr.join(""), "");
  assert.deepEqual(fixture.calls, ["doctor"]);
  assert.equal((JSON.parse(stdout.join("")) as { readonly data: { readonly command: string } }).data.command, "doctor");
});

test("production main rejects an out-of-scope issue option before bootstrapping dependencies", async () => {
  const fixture = await runtimeFixture();
  let bundleLoads = 0;
  const stdout: string[] = [];

  const exitCode = await runProductionMain(["doctor", "--issue", "7", "--output", "json"], {
    cwd: fixture.common.cwd,
    loadCurrentBundle: async () => {
      bundleLoads += 1;
      return fixture.common.currentBundle;
    },
    profileRepository: fixture.common.profileRepository,
    targetProjectResolver: fixture.common.targetProjectResolver,
    readOnly: fixture.readOnly,
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 2);
  assert.equal(bundleLoads, 0);
  assert.deepEqual(fixture.calls, []);
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "INPUT_ERROR");
});

test("production main strips context issue before legacy parsing and scopes it to one composition", async () => {
  const fixture = await runtimeFixture();
  const stdout: string[] = [];
  const readOnly = {
    ...fixture.readOnly,
    planner: {
      prepare: async (input: { readonly contextIssueIid: number | null }): Promise<never> => {
        fixture.calls.push(`context-issue:${String(input.contextIssueIid)}`);
        throw new ToolError("REPOSITORY_ERROR", "Repository fixture stopped after issue preprocessing", {
          field: "repository",
          expected: "a test repository continuation",
          actual: "fixture stop",
          safeNextStep: "Inspect the preprocessing assertion.",
        });
      },
    },
  };

  const exitCode = await runProductionMain([
    "context",
    "--issue",
    "42",
    "--output",
    "json",
  ], {
    cwd: fixture.common.cwd,
    loadCurrentBundle: async () => fixture.common.currentBundle,
    profileRepository: fixture.common.profileRepository,
    targetProjectResolver: fixture.common.targetProjectResolver,
    readOnly,
    stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
    stderr: { write: () => true },
  });

  assert.equal(exitCode, 3);
  assert.deepEqual(fixture.calls, ["context-issue:42"]);
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "REPOSITORY_ERROR");
});
