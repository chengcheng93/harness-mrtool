import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import type { TrustedBundleSelection } from "../../src/cli/commands/local.ts";
import { createProductionReadOnlyDefaults } from "../../src/cli/production-runtime.ts";
import type { TargetGitLabSession } from "../../src/cli/target-project.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import type { GitLabClient } from "../../src/gitlab/client.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

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

async function inspectCapabilities(selection: TrustedBundleSelection, modes: unknown) {
  let mutations = 0;
  const project = Object.freeze({
    id: "7",
    fullPath: "group/project",
    defaultBranch: "develop",
    webUrl: "http://gitlab.example.test/group/project",
  });
  const user = { id: "42", username: "doctor", state: "active", accessLevel: 40 };
  const write = async () => { mutations += 1; throw new Error("Doctor attempted a mutation"); };
  const gitlab = {
    audit: () => ({ requestIds: ["doctor-read"] }),
    getCurrentUser: async () => user,
    listUsers: async () => [user],
    getProject: async () => project,
    labelInventory: async () => ({ all: [], effective: [], audit: { requestIds: [] } }),
    probeCapabilities: async () => ({
      version: "17.10.3",
      revision: "doctor-fixture",
      mergeRequestSetLabels: true,
      labelOperationModes: modes,
    }),
    createMergeRequest: write,
    mutateLabels: write,
    updateMergeRequest: write,
  };
  const session: TargetGitLabSession = {
    assertNoCredentialExposure: () => {},
    gitlab: gitlab as unknown as GitLabClient,
    identity: { host: "gitlab.example.test", path: "group/project" },
    origin: "http://gitlab.example.test",
    project,
    targetRemote: "origin",
  };
  const unavailableRepository = async (): Promise<never> => {
    throw new Error("Repository diagnostics are unavailable in this capability fixture");
  };
  const defaults = createProductionReadOnlyDefaults({
    cliVersion: "0.1.0-dev",
    contextIssueIid: null,
    currentBundle: selection,
    cwd: repositoryRoot,
    targetSessionResolver: { resolve: async () => session },
    repository: {
      discover: unavailableRepository,
      readChangeSet: unavailableRepository,
      planPush: unavailableRepository,
    },
  });
  const report = await defaults.doctorProbe.inspect({
    cliVersion: "0.1.0-dev",
    currentBundle: selection,
    cwd: repositoryRoot,
  });
  assert.equal(mutations, 0);
  assert.equal(report.checks.find((check) => check.id === "repository")?.status, "failed");
  return report;
}

test("production doctor accepts advertised add/remove label operations with APPEND or ADD", async () => {
  const selection = await currentSelection();
  for (const modes of [["APPEND", "REMOVE"], ["ADD", "REMOVE"], ["REMOVE", "APPEND"]]) {
    const report = await inspectCapabilities(selection, modes);
    const capability = report.checks.find((check) => check.id === "gitlab-capabilities");
    assert.equal(capability?.status, "passed", JSON.stringify(modes));
    assert.equal(report.capabilities["gitlab-label-id-mutation"], true);
    assert.match(capability?.detail ?? "", /add\/remove operations/u);
  }
});

test("production doctor rejects incomplete, extra, or malformed label operation capabilities", async () => {
  const selection = await currentSelection();
  for (const modes of [null, [], ["APPEND"], ["REMOVE"], ["APPEND", "APPEND"],
    ["ADD", "APPEND"], ["REPLACE", "REMOVE"], ["APPEND", "REMOVE", "ADD"], ["APPEND", 42]]) {
    const report = await inspectCapabilities(selection, modes);
    assert.equal(report.checks.find((check) => check.id === "gitlab-capabilities")?.status, "failed", JSON.stringify(modes));
    assert.equal(report.capabilities["gitlab-label-id-mutation"], false);
  }
});
