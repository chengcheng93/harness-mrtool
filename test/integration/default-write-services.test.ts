import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { createDefaultWriteServices } from "../../src/cli/default-write-services.ts";
import { createProductionRuntime } from "../../src/cli/production-runtime.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import type { ReadOnlyCommandDependencies, PreparedReadOnlyContext } from "../../src/cli/commands/readonly.ts";

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
