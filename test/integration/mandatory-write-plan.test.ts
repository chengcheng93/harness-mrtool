import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { buildWritePlan } from "../../src/app/write-plan.ts";
import { createMergeRequest } from "../../src/app/create-mr.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { validateExternalContextSnapshot } from "../../src/render/marker.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";

const root = resolve(import.meta.dirname, "../..");
async function fixture() {
  const raw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-request.json"), "utf8"));
  raw.intent = "draft";
  raw.title.type = "fix"; // caller type is intentionally not authoritative
  raw.mergeRequest.labelCandidateTokens = [];
  raw.mergeRequest.assigneeCandidateToken = null;
  raw.review.reviewerCandidateTokens = [];
  const snapshotRaw = JSON.parse(await readFile(resolve(root, "test/golden/fixtures/code-docs-snapshot.json"), "utf8"));
  snapshotRaw.labelCandidates = DEFAULT_LABEL_POOL.map((name, i) => ({ id: `label:${i}`, name }));
  snapshotRaw.mergeRequest.labelIds = [];
  snapshotRaw.mergeRequest.lifecycle = "new";
  snapshotRaw.mergeRequest.iid = null;
  const snapshot = validateExternalContextSnapshot(snapshotRaw);
  return {
    request: normalizeAndValidateRequest(raw), snapshot,
    bundle: await loadTemplateBundle(resolve(root, "template-bundle")), resolvedCandidates: [],
    labelDiff: { sourceHeadSha: snapshot.sourceHeadSha, targetRefSha: snapshot.targetRefSha, mergeBaseSha: snapshot.mergeBaseSha,
      items: [{ status: "modified" as const, newPath: "README.md", binary: false, submodule: false, before: "old", after: "new" }],
    },
  };
}
test("write plan automatically selects fixed pool labels with no caller tokens and overrides misleading title", async () => {
  const data = await fixture();
  const plan = buildWritePlan(data);
  assert.deepEqual(plan.desired.labelIds.map((id) => data.snapshot.labelCandidates.find((label) => label.id === id)!.name).sort(), ["priority::p2", "status::doing", "type::doc"]);
  assert.match(plan.desired.title, /docs/u);
});
test("omitting canonical diff is rejected at the domain write-plan boundary", async () => {
  const { labelDiff: _, ...data } = await fixture();
  assert.throws(() => buildWritePlan(data as never), { code: "LABEL_ERROR" });
});
test("source/target mismatch cannot be hidden by a self-consistent diff object", async () => {
  const data = await fixture();
  assert.throws(() => buildWritePlan({ ...data, labelDiff: { ...data.labelDiff, sourceHeadSha: "f".repeat(40) } }), { code: "LABEL_ERROR" });
});
test("updating a plan removes old week and unrelated labels so exactly three remain", async () => {
  const data = await fixture();
  const snapshot = validateExternalContextSnapshot({ ...data.snapshot,
    labelCandidates: [...data.snapshot.labelCandidates, { id: "old-week", name: "week::old" }, { id: "old-manual", name: "manual::keep" }],
    mergeRequest: { ...data.snapshot.mergeRequest, labelIds: ["old-week", "old-manual"], lifecycle: "draft", iid: 1 },
  });
  const plan = buildWritePlan({ ...data, snapshot });
  assert.equal(plan.desired.labelIds.length, 3);
  assert.equal(plan.desired.labelIds.includes("old-week"), false);
  assert.equal(plan.desired.labelIds.includes("old-manual"), false);
  assert.ok(plan.managedLabelIds.includes("old-week"));
});
test("direct create cannot bypass mandatory classification even before querying existing MRs", async () => {
  const data = await fixture();
  let calls = 0;
  await assert.rejects(createMergeRequest({
    request: data.request, initialSnapshot: data.snapshot, resolvedCandidates: [], bundle: data.bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "test", sourceBranch: "feature/labels",
    gitlabOrigin: "https://gitlab.example.test", verificationReceiptWriter: {} as never,
    remote: { findOpen: async () => { calls++; throw new Error("must not reach remote"); } } as never,
  } as never), { code: "LABEL_ERROR" });
  assert.equal(calls, 0);
});
