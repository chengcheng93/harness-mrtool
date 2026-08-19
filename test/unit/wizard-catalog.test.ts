import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import type { DiscoveredContext } from "../../src/app/get-context.ts";
import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { buildWizardCatalog } from "../../src/cli/wizard-catalog.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("wizard catalog is derived only from the verified Bundle and discovered candidates", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const discovered = {
    contextId: `hmrx1_${"x".repeat(43)}`,
    binding: { targetBranch: "develop" },
    snapshot: { issue: { kind: "linked", iid: 51 } },
    labelCandidates: [{
      token: `hmrc1_${"l".repeat(43)}`,
      category: "type",
      name: "type::bug",
      description: "Bug fix",
      scopeKind: "project",
      scopePath: "group/project",
      currentlyApplied: false,
    }],
    userCandidates: [{
      token: `hmrc1_${"u".repeat(43)}`,
      kind: "reviewer",
      username: "reviewer",
      displayName: "Fixture Reviewer",
      currentlyApplied: false,
      defaultSelected: false,
      qualifiedReviewer: true,
    }],
  } as unknown as DiscoveredContext;

  const catalog = buildWizardCatalog({
    bundle,
    discovered,
    suggestedProfileIds: ["code", "docs"],
    confirmations: null,
  });

  assert.deepEqual(catalog.profiles.map(({ id }) => id), ["code", "docs", "general", "ops"]);
  assert.deepEqual(catalog.suggestedProfileIds, ["code", "docs"]);
  assert.deepEqual(catalog.titleTypes, bundle.registries.fields.titleTypes);
  assert.ok(catalog.impactAreas.some(({ id }) => id === "app"));
  assert.equal(catalog.impactAreas.some(({ id }) => id === "functional"), false);
  assert.ok(catalog.verificationItems.some(({ id }) => id === "local-build"));
  assert.ok(catalog.documentationItems.some(({ id }) => id === "readme"));
  assert.deepEqual(catalog.profileFields.map(({ id }) => id), [
    "docs.target-audience",
    "docs.content-impact",
    "ops.affected-environments",
    "ops.deployment-plan",
    "ops.configuration-compatibility",
  ]);
  assert.deepEqual(catalog.labelCategories, [
    { id: "week", required: true, max: 1 },
    { id: "type", required: true, max: 1 },
    { id: "priority", required: true, max: 1 },
  ]);
  assert.deepEqual(catalog.labelCandidates, discovered.labelCandidates.map((candidate) => ({
    token: candidate.token,
    category: candidate.category,
    name: candidate.name,
    description: candidate.description,
    scopeKind: candidate.scopeKind,
    scopePath: candidate.scopePath,
    currentlyApplied: candidate.currentlyApplied,
  })));
  assert.deepEqual(catalog.userCandidates, discovered.userCandidates);
  assert.equal(catalog.contextId, discovered.contextId);
  assert.equal(catalog.issueIid, 51);
  assert.equal(catalog.targetBranch, "develop");
  assert.equal(Object.isFrozen(catalog), true);
  assert.equal(Object.isFrozen(catalog.labelCandidates), true);
});
