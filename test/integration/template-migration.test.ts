import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
  loadMrBundle,
  type HistoricalBundleReceipt,
  type HistoricalBundleSource,
} from "../../src/app/load-mr-bundle.ts";
import {
  migrateTemplate,
  type MigrationTransaction,
} from "../../src/app/migrate-template.ts";
import {
  buildMigrationPlan,
  mergeManagedDescriptions,
  type MigrationDescriptionInput,
} from "../../src/bundle/migration.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { loadTemplateBundle, type LoadedTemplateBundle } from "../../src/bundle/load.ts";
import { validateTemplateBundle } from "../../src/bundle/validate.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import {
  appendDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  type DiagnosticMarkerMetadata,
} from "../../src/render/marker.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const OLD_HASH = "f9a35f36f124f76561a507b96b643f9493d7883f6e46af71b21209788bbe7d69";

interface TestMr {
  readonly iid: number;
  readonly targetProjectId: string;
  readonly description: string;
}

function markerBody(): string {
  return [
    "## 1. Changes",
    "old summary",
    "## 2. Motivation",
    "old motivation",
    "## 3. Related Issue / Work Item",
    "old issue",
    "## 4. Impact Scope",
    "old impact",
    "## 5. Verification",
    "old verification",
    "## 6. Documentation",
    "old docs",
    "## 7. Risks and Rollback",
    "old risks",
    "## 8. Review / CI Checklist",
    "old review",
  ].join("\n");
}

async function fixtureBundle(): Promise<LoadedTemplateBundle> {
  return loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
}

async function nextBundle(): Promise<{ readonly bundle: LoadedTemplateBundle; readonly hash: string }> {
  const current = await fixtureBundle();
  const bundle = structuredClone(current) as LoadedTemplateBundle;
  (bundle.manifest as { version: string }).version = "1.1.0";
  validateTemplateBundle(bundle);
  // The application hash contract includes the canonical manifest's final LF.
  const hash = sha256Utf8(`${canonicalizeJson(bundle.manifest)}\n`);
  return { bundle, hash };
}

async function markedMr(bundleHash = OLD_HASH): Promise<TestMr> {
  const [rawRequest, rawSnapshot] = await Promise.all([
    readFile(resolve(repositoryRoot, "test/golden/fixtures/code-docs-request.json"), "utf8")
      .then((value) => JSON.parse(value) as unknown),
    readFile(resolve(repositoryRoot, "test/golden/fixtures/code-docs-snapshot.json"), "utf8")
      .then((value) => JSON.parse(value) as unknown),
  ]);
  const request = normalizeAndValidateRequest(rawRequest);
  const snapshot = validateExternalContextSnapshot({
    ...(rawSnapshot as Record<string, unknown>),
    mergeRequest: {
      ...((rawSnapshot as Record<string, unknown>).mergeRequest as Record<string, unknown>),
      iid: 88,
      lifecycle: "ready",
    },
  });
  const writePlan = validateDesiredWritePlan({
    writePlanVersion: 1,
    title: "[fix][mrtool] old title",
    labelIds: [],
    assigneeUserId: null,
    reviewerUserIds: [],
    squash: false,
    removeSourceBranch: false,
  });
  const stateMap = Object.fromEntries([
    ...request.verification.items.map((item) => [item.id, item.state]),
    ...[
      "source-branch-synced", "commit-convention", "work-item-reviewed", "metadata-reviewed",
      "secret-scan-reviewed", "repository-hygiene-reviewed", "ci-status", "reviewer-requested",
      "high-risk-reviewers", "blocking-issues",
    ].map((id) => [id, "pending"]),
  ]);
  const description = appendDiagnosticMarker(markerBody(), {
    releaseTag: "templates-v1.0.0",
    bundleId: "harness-mr-default",
    bundleVersion: "1.0.0",
    bundleManifestHash: bundleHash,
    profileIds: request.profileIds,
    policySchema: 1,
    cliVersion: "0.1.0-dev",
    renderPhase: "final",
    stateMap,
    request,
    snapshot,
    writePlan,
  });
  return { iid: 88, targetProjectId: "project:100", description };
}

function markerFrom(description: string): DiagnosticMarkerMetadata {
  const encoded = description.match(/harness-mrtool:v1 ([A-Za-z0-9_-]+) -->\n$/u)?.[1];
  if (encoded === undefined) throw new Error("test marker missing");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as DiagnosticMarkerMetadata;
}

function descriptionForBundle(description: string, bundle: LoadedTemplateBundle, hash: string): string {
  const encoded = description.match(/harness-mrtool:v1 ([A-Za-z0-9_-]+) -->\n$/u)?.[1];
  if (encoded === undefined) throw new Error("test marker missing");
  const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  metadata.bundleVersion = bundle.manifest.version;
  metadata.bundleManifestHash = hash;
  const body = description.slice(0, description.indexOf("<!-- harness-mrtool:v1"));
  metadata.bodyDigest = sha256Utf8(body);
  const canonical = canonicalizeJson(metadata as never);
  return `${body}<!-- harness-mrtool:v1 ${Buffer.from(canonical, "utf8").toString("base64url")} -->\n`;
}

function tamperMarkerMetadata(description: string, field: string, value: unknown): string {
  const markerStart = description.indexOf("<!-- harness-mrtool:v1");
  if (markerStart < 0) throw new Error("test marker missing");
  const encoded = description.match(/harness-mrtool:v1 ([A-Za-z0-9_-]+) -->\n$/u)?.[1];
  if (encoded === undefined) throw new Error("test marker missing");
  const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  metadata[field] = value;
  const canonical = canonicalizeJson(metadata as never);
  return `${description.slice(0, markerStart)}<!-- harness-mrtool:v1 ${Buffer.from(canonical, "utf8").toString("base64url")} -->\n`;
}

function receiptFor(mr: TestMr, marker: DiagnosticMarkerMetadata, hash: string): HistoricalBundleReceipt {
  return {
    receiptVersion: 1,
    gitlabOrigin: "https://gitlab.example.test",
    iid: mr.iid,
    targetProjectId: mr.targetProjectId,
    markerDigest: sha256Utf8(canonicalizeJson(marker as unknown as object)),
    bundle: {
      releaseTag: marker.releaseTag,
      bundleId: marker.bundleId,
      bundleVersion: marker.bundleVersion,
      bundleManifestHash: hash,
      policySchema: marker.policySchema,
    },
  };
}

function sourceFor(
  mr: TestMr,
  bundle: LoadedTemplateBundle,
  receipt: HistoricalBundleReceipt,
  allowManualDescriptionDrift = false,
): HistoricalBundleSource {
  return {
    gitlabOrigin: "https://gitlab.example.test",
    ...(allowManualDescriptionDrift ? { allowManualDescriptionDrift: true } : {}),
    receiptLoader: {
      loadVerified: async () => ({ trusted: true as const, receipt }),
    },
    bundleLoader: {
      loadVerifiedExact: async () => ({ trusted: true as const, bundle }),
    },
  };
}

test("ordinary update pins the marker Bundle after stable advances", async () => {
  const bundle = await fixtureBundle();
  const mr = await markedMr(OLD_HASH);
  const marker = markerFrom(mr.description);
  const loaded = await loadMrBundle({
    current: mr,
    source: sourceFor(mr, bundle, receiptFor(mr, marker, OLD_HASH)),
  });

  assert.equal(loaded.reference.bundleManifestHash, OLD_HASH);
  assert.equal(loaded.reference.releaseTag, "templates-v1.0.0");
  assert.equal(loaded.bundle, bundle);
});

test("missing historical asset fails closed before migration planning", async () => {
  const bundle = await fixtureBundle();
  const mr = await markedMr(OLD_HASH);
  const marker = markerFrom(mr.description);
  const source = sourceFor(mr, bundle, receiptFor(mr, marker, OLD_HASH));
  source.bundleLoader.loadVerifiedExact = async () => ({ trusted: false as const, bundle: null });

  await assert.rejects(
    loadMrBundle({ current: mr, source }),
    (error: unknown) => typeof error === "object" && error !== null &&
      "code" in error && error.code === "UPDATE_SECURITY_ERROR",
  );
});

test("non-interactive migration requires exact old:new confirmation", async () => {
  const bundle = await fixtureBundle();
  const newer = await nextBundle();
  const mr = await markedMr(OLD_HASH);
  const marker = markerFrom(mr.description);
  const loaded = await loadMrBundle({
    current: mr,
    source: sourceFor(mr, bundle, receiptFor(mr, marker, OLD_HASH)),
  });
  const writes: string[] = [];
  const transaction: MigrationTransaction = {
    backup: async () => { writes.push("backup"); },
    execute: async () => { writes.push("execute"); return { readbackVerified: true, receiptStaged: true }; },
  };

  await assert.rejects(
    migrateTemplate({
      current: mr,
      historical: loaded,
      currentBundle: newer.bundle,
      newBundleHash: newer.hash,
      newDescription: descriptionForBundle(mr.description, newer.bundle, newer.hash),
      nonInteractive: true,
      confirmation: "yes",
      transaction,
    }),
    /old.*new.*hash/iu,
  );
  assert.deepEqual(writes, []);
});

test("three-way migration keeps manual prose and reports managed conflicts", () => {
  const input: MigrationDescriptionInput = {
    base: markerBody(),
    current: markerBody().replace("old summary", "manual summary").replace("old docs", "manual docs"),
    proposed: markerBody().replace("old summary", "new summary").replace("old review", "new review"),
  };
  const merged = mergeManagedDescriptions(input);
  assert.match(merged.description, /manual docs/u);
  assert.match(merged.description, /new review/u);
  assert.deepEqual(merged.conflicts.map((entry) => entry.field), ["changes"]);
});

test("explicit migration can load a manually edited body while keeping marker metadata pinned", async () => {
  const bundle = await fixtureBundle();
  const original = await markedMr(OLD_HASH);
  const manual: TestMr = {
    ...original,
    description: original.description.replace("old docs", "manual docs"),
  };
  const marker = markerFrom(manual.description);
  const loaded = await loadMrBundle({
    current: manual,
    source: sourceFor(manual, bundle, receiptFor(manual, marker, OLD_HASH), true),
  });
  assert.equal(loaded.marker.bundleManifestHash, OLD_HASH);
});

test("migration blockers produce a plan but perform zero writes", async () => {
  const plan = buildMigrationPlan({
    oldSchema: { required: ["title"] },
    newSchema: { required: ["title", "newRequired"] },
    oldValues: { title: "same" },
    newValues: { title: "same" },
    description: {
      base: markerBody(),
      current: markerBody(),
      proposed: markerBody(),
    },
  });
  assert.deepEqual(plan.missingFields, ["newRequired"]);
  assert.equal(plan.blocked, true);
});

test("successful migration backs up before full transaction and readback receipt", async () => {
  const bundle = await fixtureBundle();
  const newer = await nextBundle();
  const mr = await markedMr(OLD_HASH);
  const marker = markerFrom(mr.description);
  const loaded = await loadMrBundle({
    current: mr,
    source: sourceFor(mr, bundle, receiptFor(mr, marker, OLD_HASH)),
  });
  const events: string[] = [];
  const transaction: MigrationTransaction = {
    backup: async (backup) => {
      events.push(`backup:${backup.marker.bundleManifestHash}`);
    },
    execute: async () => {
      events.push("transaction");
      return { readbackVerified: true, receiptStaged: true };
    },
  };
  const result = await migrateTemplate({
    current: mr,
    historical: loaded,
    currentBundle: newer.bundle,
    newBundleHash: newer.hash,
    newDescription: descriptionForBundle(mr.description, newer.bundle, newer.hash),
    nonInteractive: true,
    confirmation: `${OLD_HASH}:${newer.hash}`,
    transaction,
  });
  assert.deepEqual(events, [`backup:${OLD_HASH}`, "transaction"]);
  assert.equal(result.committed, true);
});

test("managed conflict stops migration before backup or remote transaction", async () => {
  const oldBundle = await fixtureBundle();
  const newer = await nextBundle();
  const original = await markedMr(OLD_HASH);
  const manual: TestMr = { ...original, description: original.description.replace("old summary", "manual summary") };
  const marker = markerFrom(manual.description);
  const historical = await loadMrBundle({
    current: manual,
    source: sourceFor(manual, oldBundle, receiptFor(manual, marker, OLD_HASH), true),
  });
  const writes: string[] = [];
  await assert.rejects(
    migrateTemplate({
      current: manual,
      historical,
      currentBundle: newer.bundle,
      newBundleHash: newer.hash,
      newDescription: descriptionForBundle(original.description.replace("old summary", "new summary"), newer.bundle, newer.hash),
      baseDescription: original.description,
      nonInteractive: true,
      confirmation: `${OLD_HASH}:${newer.hash}`,
      transaction: {
        backup: async () => { writes.push("backup"); },
        execute: async () => { writes.push("execute"); return { readbackVerified: true, receiptStaged: true }; },
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "MANUAL_DESCRIPTION_CHANGE",
  );
  assert.deepEqual(writes, []);
});

test("EOL historical Bundle blocks migration before backup", async () => {
  const oldBundle = await fixtureBundle();
  const newer = await nextBundle();
  const original = await markedMr(OLD_HASH);
  const marker = markerFrom(original.description);
  const historical = await loadMrBundle({
    current: original,
    source: { ...sourceFor(original, oldBundle, receiptFor(original, marker, OLD_HASH)), isBundleSupported: () => false },
  });
  const writes: string[] = [];
  await assert.rejects(
    migrateTemplate({
      current: original,
      historical,
      currentBundle: newer.bundle,
      newBundleHash: newer.hash,
      newDescription: descriptionForBundle(original.description, newer.bundle, newer.hash),
      nonInteractive: true,
      confirmation: `${OLD_HASH}:${newer.hash}`,
      transaction: {
        backup: async () => { writes.push("backup"); },
        execute: async () => { writes.push("execute"); return { readbackVerified: true, receiptStaged: true }; },
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "UPDATE_REQUIRED",
  );
  assert.deepEqual(writes, []);
});

test("marker drift stops migration before backup", async () => {
  const oldBundle = await fixtureBundle();
  const newer = await nextBundle();
  const original = await markedMr(OLD_HASH);
  const marker = markerFrom(original.description);
  const historical = await loadMrBundle({
    current: original,
    source: sourceFor(original, oldBundle, receiptFor(original, marker, OLD_HASH)),
  });
  const drifted: TestMr = {
    ...original,
    description: tamperMarkerMetadata(original.description, "cliVersion", "0.1.1-dev"),
  };
  const writes: string[] = [];
  await assert.rejects(
    migrateTemplate({
      current: drifted,
      historical,
      currentBundle: newer.bundle,
      newBundleHash: newer.hash,
      newDescription: descriptionForBundle(original.description, newer.bundle, newer.hash),
      nonInteractive: true,
      confirmation: `${OLD_HASH}:${newer.hash}`,
      transaction: {
        backup: async () => { writes.push("backup"); },
        execute: async () => { writes.push("execute"); return { readbackVerified: true, receiptStaged: true }; },
      },
    }),
    (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
      error.code === "CONCURRENT_UPDATE",
  );
  assert.deepEqual(writes, []);
});
