import assert from "node:assert/strict";
import { Ajv } from "ajv";
import {
  cp,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  MAX_BUNDLE_MANIFEST_BYTES,
  MAX_BUNDLE_PAYLOAD_BYTES,
  REQUIRED_H2_HEADINGS,
  loadTemplateBundle,
  nodeTemplateBundleIo,
  type TemplateBundleIo,
} from "../../src/bundle/load.ts";
import { buildTemplateBundleManifest } from "../../src/bundle/manifest.ts";
import {
  composeProfiles,
  type ImpactNatureForProfileComposition,
} from "../../src/bundle/compose.ts";
import {
  detectProfiles,
  type DiffItem,
  type ProfileDetectionResult,
} from "../../src/bundle/detect-profile.ts";
import { validateTemplateBundle } from "../../src/bundle/validate.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { runProcess } from "../helpers/process.ts";

import outputSchema from "../../schemas/output-v1.schema.json" with { type: "json" };

const repositoryRoot = resolve(import.meta.dirname, "../..");
const templateBundlePath = resolve(repositoryRoot, "template-bundle");

const REQUIRED_PLACEHOLDERS = [
  "changes.summary",
  "changes.technicalChanges",
  "changes.outOfScope",
  "profileFields.changes",
  "motivation.background",
  "motivation.whyNeeded",
  "profileFields.motivation",
  "workItem.canonicalRelationLines",
  "issueSnapshot.milestone",
  "issueSnapshot.assignees",
  "issueSnapshot.dueDate",
  "issueSnapshot.labels",
  "mergeRequest.labels",
  "impact.checkboxes",
  "impact.details",
  "profileFields.impact",
  "verification.checkboxes",
  "verification.rows",
  "verification.acceptanceEvidence",
  "verification.knownGaps",
  "documentation.checkboxes",
  "documentation.details",
  "profileFields.documentation",
  "risk.levelCheckboxes",
  "risk.items",
  "risk.compatibilityImpact",
  "risk.rollbackPlan",
  "profileFields.risk",
  "review.checkboxes",
  "review.reviewerFocus",
  "review.additionalNotes",
  "diagnosticMarker",
] as const;

const REQUIRED_CHECKBOX_IDS = [
  "app",
  "platform",
  "cloud",
  "controller-app",
  "motion-control",
  "fpga",
  "cad-cam",
  "vision-ai",
  "process",
  "shared-schema-protocol",
  "qa",
  "release",
  "devops",
  "hardware-manufacturing",
  "functional",
  "non-functional",
  "docs-only",
  "no-documentation-changes",
  "interface-schema-protocol-documentation",
  "design-documentation",
  "test-documentation",
  "release-notes",
  "readme",
  "documentation-policy-reviewed",
  "low",
  "medium",
  "high",
  "local-build",
  "unit-tests",
  "integration-tests",
  "core-behavior",
  "docs-links-format",
  "deployment-pipeline",
  "source-branch-synced",
  "commit-convention",
  "work-item-reviewed",
  "metadata-reviewed",
  "secret-scan-reviewed",
  "repository-hygiene-reviewed",
  "ci-status",
  "reviewer-requested",
  "high-risk-reviewers",
  "blocking-issues",
] as const;

const REQUIRED_BASE_FIELDS = [
  "changes.summary",
  "changes.technicalChanges",
  "changes.outOfScope",
  "motivation.background",
  "motivation.whyNeeded",
  "workItem",
  "impact.details",
  "verification.items",
  "verification.acceptanceEvidence",
  "verification.knownGaps",
  "documentation.details",
  "risk.items",
  "risk.compatibilityImpact",
  "risk.rollbackPlan",
  "review.reviewerFocus",
  "review.additionalNotes",
] as const;

async function createValidBundleFixture(context: test.TestContext): Promise<string> {
  const fixtureRoot = await mkdtemp(resolve(tmpdir(), "harness-bundle-"));
  context.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const bundlePath = resolve(fixtureRoot, "bundle");
  await cp(templateBundlePath, bundlePath, { recursive: true });
  const built = await buildTemplateBundleManifest(bundlePath);
  await writeFile(resolve(bundlePath, "bundle-manifest.json"), built.serialized, "utf8");
  return bundlePath;
}

async function assertTemplateError(
  operation: () => Promise<unknown>,
  pattern: RegExp,
  forbiddenText?: string,
): Promise<void> {
  await assert.rejects(operation, (error: unknown) => {
    assert.equal(isToolError(error, "TEMPLATE_ERROR"), true);
    const serialized = JSON.stringify(error);
    assert.match(`${(error as Error).message}\n${serialized}`, pattern);
    if (forbiddenText !== undefined) {
      assert.equal(serialized.includes(forbiddenText), false);
      assert.equal((error as Error).message.includes(forbiddenText), false);
    }
    return true;
  });
}

function mutableBundle<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertPolicyError(operation: () => unknown, pattern: RegExp): void {
  assert.throws(operation, (error: unknown) => {
    assert.equal(isToolError(error, "POLICY_ERROR"), true);
    assert.match((error as Error).message, pattern);
    return true;
  });
}

test("template bundle has exactly eight ordered English H2 headings", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);

  assert.deepEqual(bundle.layout.h2Headings, REQUIRED_H2_HEADINGS);
});

test("template bundle loads an exact immutable nine-payload manifest", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const requestSchema = await readFile(
    resolve(repositoryRoot, "schemas/request-v1.schema.json"),
  );
  const bundledSchema = await readFile(
    resolve(templateBundlePath, "schema.json"),
  );

  assert.equal(bundle.manifest.files.length, 9);
  assert.deepEqual(
    bundle.manifest.files.map((file) => file.path),
    [
      "layout.md",
      "policy.yml",
      "profiles/code.yml",
      "profiles/docs.yml",
      "profiles/general.yml",
      "profiles/ops.yml",
      "registries/checkboxes.json",
      "registries/fields.json",
      "schema.json",
    ],
  );
  assert.deepEqual(bundledSchema, requestSchema);
  assert.equal(Object.isFrozen(bundle), true);
  assert.equal(Object.isFrozen(bundle.manifest.files), true);
  assert.equal(Object.isFrozen(bundle.schema), true);
});

test("manifest builder emits deterministic JCS with sorted real payload metadata", async () => {
  const first = await buildTemplateBundleManifest(templateBundlePath);
  const second = await buildTemplateBundleManifest(templateBundlePath);

  assert.equal(first.serialized, second.serialized);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.serialized.endsWith("\n"), true);
  assert.deepEqual(
    first.manifest.files.map((file) => file.path),
    [...first.manifest.files.map((file) => file.path)].sort(),
  );
  assert.equal(
    first.manifest.files.every(
      (file) =>
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        /^[a-f0-9]{64}$/.test(file.sha256),
    ),
    true,
  );
});

test("loader verifies payload hash before parsing malformed YAML", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const profilePath = resolve(bundlePath, "profiles/code.yml");
  const original = await readFile(profilePath, "utf8");
  const malformed = `id: [bad\n${"#".repeat(original.length - "id: [bad\n".length)}`;
  await writeFile(profilePath, malformed, "utf8");

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /hash/i,
    bundlePath,
  );
});

test("loader rejects unknown and missing payload files", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  await writeFile(resolve(bundlePath, "unexpected.txt"), "surprise", "utf8");
  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /file set|unknown/i,
    bundlePath,
  );

  await unlink(resolve(bundlePath, "unexpected.txt"));
  await unlink(resolve(bundlePath, "profiles/docs.yml"));
  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /file set|missing/i,
    bundlePath,
  );
});

test("loader rejects a non-canonical or duplicate-key manifest", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const manifest = JSON.parse(
    await readFile(resolve(bundlePath, "bundle-manifest.json"), "utf8"),
  ) as object;
  await writeFile(
    resolve(bundlePath, "bundle-manifest.json"),
    `${JSON.stringify(manifest, undefined, 2)}\n`,
    "utf8",
  );
  await assertTemplateError(() => loadTemplateBundle(bundlePath), /canonical/i);

  await writeFile(
    resolve(bundlePath, "bundle-manifest.json"),
    '{"manifestVersion":1,"manifestVersion":1}\n',
    "utf8",
  );
  await assertTemplateError(() => loadTemplateBundle(bundlePath), /duplicate|manifest/i);
});

test("loader rejects invalid manifest metadata before reading payloads", async (context) => {
  for (const [name, mutate, pattern] of [
    ["SemVer", (value: any) => { value.version = "v1"; }, /semver|version/i],
    ["sort", (value: any) => { value.files.reverse(); }, /sort|order/i],
    ["hash case", (value: any) => { value.files[0].sha256 = value.files[0].sha256.toUpperCase(); }, /sha-256|hash/i],
    ["size", (value: any) => { value.files[0].size = 0; }, /size/i],
    ["path alias", (value: any) => { value.files[0].path = "./layout.md"; }, /path|allowlist/i],
  ] as const) {
    const bundlePath = await createValidBundleFixture(context);
    const manifestPath = resolve(bundlePath, "bundle-manifest.json");
    const value = JSON.parse(await readFile(manifestPath, "utf8"));
    mutate(value);
    const { canonicalizeJson } = await import("../../src/contracts/jcs.ts");
    await writeFile(manifestPath, `${canonicalizeJson(value)}\n`, "utf8");
    await assertTemplateError(
      () => loadTemplateBundle(bundlePath),
      pattern,
      bundlePath,
    );
    assert.ok(name.length > 0);
  }
});

test("loader accepts canonical SemVer metadata but rejects aliases", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const manifestPath = resolve(bundlePath, "bundle-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = "1.0.0+bundle.7";
  await writeFile(manifestPath, `${canonicalizeJson(manifest)}\n`, "utf8");
  assert.equal((await loadTemplateBundle(bundlePath)).manifest.version, "1.0.0+bundle.7");

  manifest.version = "v1.0.0";
  await writeFile(manifestPath, `${canonicalizeJson(manifest)}\n`, "utf8");
  await assertTemplateError(() => loadTemplateBundle(bundlePath), /SemVer/i);
});

test("loader reads each manifest and payload file exactly once", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const opens = new Map<string, number>();
  const io: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    openFile: async (path) => {
      opens.set(path, (opens.get(path) ?? 0) + 1);
      return nodeTemplateBundleIo.openFile(path);
    },
  };

  await loadTemplateBundle(bundlePath, io);

  assert.equal(opens.size, 10);
  assert.equal([...opens.values()].every((count) => count === 1), true);
});

test("loader never uses an unbounded path read after metadata validation", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const manifestPath = resolve(bundlePath, "bundle-manifest.json");
  const scannedSizes = new Map<string, number>();
  const requestedBytes = new Map<string, number>();
  const io = {
    ...nodeTemplateBundleIo,
    lstat: async (path: string) => {
      const metadata = await nodeTemplateBundleIo.lstat(path);
      scannedSizes.set(path, Number(metadata.size));
      return metadata;
    },
    openFile: async (path: string) => {
      const handle = await nodeTemplateBundleIo.openFile(path);
      return {
        close: () => handle.close(),
        read: async (
          buffer: Uint8Array,
          offset: number,
          length: number,
          position: number,
        ) => {
          requestedBytes.set(path, (requestedBytes.get(path) ?? 0) + length);
          assert.equal(buffer.byteLength <= MAX_BUNDLE_PAYLOAD_BYTES, true);
          return handle.read(buffer, offset, length, position);
        },
        stat: () => handle.stat(),
      };
    },
  } as TemplateBundleIo;

  await assert.doesNotReject(() => loadTemplateBundle(bundlePath, io));

  assert.equal(requestedBytes.size, 10);
  assert.equal(requestedBytes.has(manifestPath), true);
  for (const [path, bytes] of requestedBytes) {
    assert.equal(bytes <= (scannedSizes.get(path) as number) + 1, true, path);
  }
});

test("loader rejects opened-file identity, truncation, and growth races", async (context) => {
  const modes = ["identity", "truncated", "grown"] as const;

  for (const mode of modes) {
    const bundlePath = await createValidBundleFixture(context);
    const manifestPath = resolve(bundlePath, "bundle-manifest.json");
    let closed = false;
    const io: TemplateBundleIo = {
      ...nodeTemplateBundleIo,
      openFile: async (path) => {
        const handle = await nodeTemplateBundleIo.openFile(path);
        if (path !== manifestPath) return handle;
        return {
          close: async () => {
            closed = true;
            await handle.close();
          },
          read: async (buffer, offset, length, position) => {
            if (mode === "truncated") return { bytesRead: 0 };
            if (mode === "grown" && length === 1) return { bytesRead: 1 };
            return handle.read(buffer, offset, length, position);
          },
          stat: async () => {
            const metadata = await handle.stat();
            return mode === "identity"
              ? {
                  ...metadata,
                  dev: metadata.dev + 1n,
                  isFile: () => metadata.isFile(),
                  isDirectory: () => metadata.isDirectory(),
                  isSymbolicLink: () => metadata.isSymbolicLink(),
                }
              : metadata;
          },
        };
      },
    };

    await assertTemplateError(
      () => loadTemplateBundle(bundlePath, io),
      /identity|size changed/i,
    );
    assert.equal(closed, true, mode);
  }
});

test("loader closes every opened handle and rejects a close failure", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const manifestPath = resolve(bundlePath, "bundle-manifest.json");
  const closedPaths = new Set<string>();
  const closeFailureIo: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    openFile: async (path) => {
      const handle = await nodeTemplateBundleIo.openFile(path);
      return {
        ...handle,
        close: async () => {
          closedPaths.add(path);
          await handle.close();
          if (path === manifestPath) throw new Error("simulated close failure");
        },
      };
    },
  };

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath, closeFailureIo),
    /handle|closed safely/i,
  );
  assert.deepEqual([...closedPaths], [manifestPath]);

  const successfulCloses = new Set<string>();
  const successIo: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    openFile: async (path) => {
      const handle = await nodeTemplateBundleIo.openFile(path);
      return {
        ...handle,
        close: async () => {
          successfulCloses.add(path);
          await handle.close();
        },
      };
    },
  };
  await loadTemplateBundle(bundlePath, successIo);
  assert.equal(successfulCloses.size, 10);
});

test("loader rejects oversized manifest before reading it", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const manifestPath = resolve(bundlePath, "bundle-manifest.json");
  let manifestOpens = 0;
  const io: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    openFile: async (path) => {
      if (path === manifestPath) manifestOpens += 1;
      return nodeTemplateBundleIo.openFile(path);
    },
    lstat: async (path) => {
      const metadata = await nodeTemplateBundleIo.lstat(path);
      return path === manifestPath
        ? {
            dev: metadata.dev,
            ino: metadata.ino,
            size: BigInt(MAX_BUNDLE_MANIFEST_BYTES + 1),
            isFile: () => metadata.isFile(),
            isDirectory: () => metadata.isDirectory(),
            isSymbolicLink: () => metadata.isSymbolicLink(),
          }
        : metadata;
    },
  };

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath, io),
    /size limit|exceeds/i,
  );
  assert.equal(manifestOpens, 0);
});

test("loader rejects reparse paths and non-file payload entries", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const layoutPath = resolve(bundlePath, "layout.md");
  const reparseIo: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    realpath: async (path) =>
      path === layoutPath ? resolve(bundlePath, "elsewhere.md") : nodeTemplateBundleIo.realpath(path),
  };
  await assertTemplateError(
    () => loadTemplateBundle(bundlePath, reparseIo),
    /reparse|escape|symbolic/i,
  );

  const nonFileIo: TemplateBundleIo = {
    ...nodeTemplateBundleIo,
    lstat: async (path) => {
      const metadata = await nodeTemplateBundleIo.lstat(path);
      return path === layoutPath
        ? {
            dev: metadata.dev,
            ino: metadata.ino,
            size: metadata.size,
            isFile: () => false,
            isDirectory: () => true,
            isSymbolicLink: () => metadata.isSymbolicLink(),
          }
        : metadata;
    },
  };
  await assertTemplateError(
    () => loadTemplateBundle(bundlePath, nonFileIo),
    /regular file/i,
  );
});

test("loader strictly parses payloads only after matching a rebuilt manifest", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  await writeFile(resolve(bundlePath, "profiles/code.yml"), "id: code\nid: code\n", "utf8");
  const built = await buildTemplateBundleManifest(bundlePath);
  await writeFile(resolve(bundlePath, "bundle-manifest.json"), built.serialized, "utf8");

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /strict YAML/i,
  );
});

test("manifest builder rejects unknown payload files", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  await writeFile(resolve(bundlePath, "profiles/extra.yml"), "id: extra\n", "utf8");

  await assertTemplateError(
    () => buildTemplateBundleManifest(bundlePath),
    /file set|unknown/i,
  );
});

test("layout contains the complete fixed skeleton with each placeholder exactly once", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const placeholders = [...bundle.layout.markdown.matchAll(/\{\{([A-Za-z][A-Za-z0-9.]*)\}\}/g)]
    .map((match) => match[1]);

  assert.deepEqual(placeholders, REQUIRED_PLACEHOLDERS);
  assert.equal(new Set(placeholders).size, placeholders.length);
  assert.match(
    bundle.layout.markdown,
    /\| Check \| Command \/ Method \| Result \| Evidence \|\n\| --- \| --- \| --- \| --- \|/,
  );
  assert.equal(
    bundle.layout.markdown.trimEnd().endsWith("{{diagnosticMarker}}"),
    true,
  );
  assert.equal((bundle.layout.markdown.match(/^### .+$/gm) ?? []).length, 13);
});

test("publish validation pins the complete V1 layout text", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const insertBeforeMarker = (markdown: string, text: string): string =>
    markdown.replace("{{diagnosticMarker}}", `${text}\n\n{{diagnosticMarker}}`);
  const variants = [
    insertBeforeMarker(bundle.layout.markdown, "{{bad-placeholder}}"),
    insertBeforeMarker(bundle.layout.markdown, "Hidden Heading\n=============="),
    insertBeforeMarker(bundle.layout.markdown, "<h2>9. Hidden Heading</h2>"),
    insertBeforeMarker(bundle.layout.markdown, "Arbitrary fixed publisher text."),
  ];

  for (const markdown of variants) {
    const changed: any = mutableBundle(bundle);
    changed.layout.markdown = markdown;
    await assertTemplateError(
      async () => validateTemplateBundle(changed),
      /layout|contract/i,
      repositoryRoot,
    );
  }
});

test("central checkbox registry defines all 43 stable contracts exactly once", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const registry = bundle.registries.checkboxes as {
    schemaVersion: number;
    checkboxes: Array<Record<string, unknown>>;
  };

  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(
    registry.checkboxes.map((entry) => entry.id),
    REQUIRED_CHECKBOX_IDS,
  );
  assert.equal(new Set(registry.checkboxes.map((entry) => entry.id)).size, 43);
  for (const entry of registry.checkboxes) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "applicableLifecycles",
      "applicableProfiles",
      "evidenceSchema",
      "id",
      "kind",
      "label",
      "order",
      "sectionSlot",
      "source",
    ]);
    assert.equal(typeof entry.label, "string");
    assert.equal((entry.label as string).trim().length > 0, true);
    assert.equal(Number.isSafeInteger(entry.order), true);
    assert.equal(Array.isArray(entry.applicableProfiles), true);
    assert.equal(Array.isArray(entry.applicableLifecycles), true);
  }
});

test("central field registry is the only source of profile field structure", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const registry = bundle.registries.fields as {
    schemaVersion: number;
    titleTypes: string[];
    fields: Array<Record<string, unknown>>;
  };

  assert.equal(registry.schemaVersion, 1);
  assert.deepEqual(registry.titleTypes, [
    "feat",
    "fix",
    "docs",
    "test",
    "refactor",
    "perf",
    "build",
    "ci",
    "chore",
  ]);
  assert.deepEqual(
    registry.fields.map((field) => field.id),
    [
      "docs.target-audience",
      "docs.content-impact",
      "ops.affected-environments",
      "ops.deployment-plan",
      "ops.configuration-compatibility",
    ],
  );
  assert.deepEqual(
    registry.fields.map((field) => field.h3),
    [
      "Target Audience",
      "Content Impact",
      "Affected Environments",
      "Deployment Plan",
      "Configuration Compatibility",
    ],
  );
  assert.equal(new Set(registry.fields.map((field) => field.order)).size, 5);
});

test("four profiles reference central IDs without redefining registry contracts", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  assert.deepEqual(Object.keys(bundle.profiles), ["code", "docs", "general", "ops"]);

  for (const [id, profile] of Object.entries(bundle.profiles)) {
    assert.equal(profile.id, id);
    assert.deepEqual(Object.keys(profile).sort(), [
      "constraints",
      "id",
      "matchRules",
      "requiredBaseFields",
      "requiredCheckboxIds",
      "requiredFieldIds",
      "suggestedTitleTypes",
    ]);
    const serialized = JSON.stringify(profile);
    for (const forbidden of ["label", "h3", "type:", "cardinality", "sectionSlot", "order:"]) {
      assert.equal(serialized.includes(forbidden), false);
    }
  }

  assert.deepEqual(bundle.profiles.general.requiredBaseFields, REQUIRED_BASE_FIELDS);
});

test("policy declares dynamic label categories, exact lifecycle exception and review defaults", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  assert.deepEqual(bundle.policy, {
    policySchema: 1,
    labels: {
      categories: {
        week: { match: "^week::", required: true, max: 1 },
        type: { match: "^type::", required: true, max: 1 },
        priority: { match: "^priority::", required: true, max: 1 },
        status: { match: "^status::", required: true, max: 1 },
      },
      lifecycle: {
        statusCategory: "status",
        expectedNames: {
          draft: "status::doing",
          ready: "status::review",
          merge: "status::review",
        },
      },
    },
    title: {
      typeRegistry: "registries/fields.json#titleTypes",
      typeLabelCompatibility: {
        feat: "^type::feature$",
        fix: "^type::bug$",
        docs: "^type::doc$",
        test: "^type::test$",
        refactor: "^type::refactor$",
        perf: "^type::performance$",
        build: "^type::build$",
        ci: "^type::ci$",
        chore: "^type::chore$",
      },
    },
    review: {
      draftMinimumReviewers: 0,
      readyMinimumReviewers: 1,
      highRiskMinimumReviewers: 2,
    },
  });
  assert.equal(JSON.stringify(bundle.policy).includes("type::feature,"), false);
});

test("all eight allowed profile selections compose as stable registry ID unions", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const combinations = [
    ["general"],
    ["code"],
    ["docs"],
    ["ops"],
    ["code", "docs"],
    ["code", "ops"],
    ["docs", "ops"],
    ["code", "docs", "ops"],
  ] as const;

  for (const ids of combinations) {
    const composed = composeProfiles(bundle, ids);
    assert.deepEqual(composed.profileIds, ids);
    assert.equal(new Set(composed.requiredBaseFields).size, composed.requiredBaseFields.length);
    assert.equal(new Set(composed.requiredFieldIds).size, composed.requiredFieldIds.length);
    assert.equal(new Set(composed.requiredCheckboxIds).size, composed.requiredCheckboxIds.length);
  }

  const mixed = composeProfiles(bundle, ["ops", "code", "docs"]);
  assert.deepEqual(mixed.profileIds, ["code", "docs", "ops"]);
  assert.deepEqual(mixed.requiredFieldIds, [
    "docs.target-audience",
    "docs.content-impact",
    "ops.affected-environments",
    "ops.deployment-plan",
    "ops.configuration-compatibility",
  ]);
  assert.deepEqual(mixed.requiredCheckboxIds, [
    "local-build",
    "unit-tests",
    "integration-tests",
    "core-behavior",
    "docs-links-format",
    "deployment-pipeline",
  ]);
});

test("profile selection rejects unknown, duplicate and general combinations", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);

  assertPolicyError(() => composeProfiles(bundle, []), /profile/i);
  assertPolicyError(() => composeProfiles(bundle, ["code", "code"]), /duplicate/i);
  assertPolicyError(() => composeProfiles(bundle, ["unknown"]), /unknown/i);
  assertPolicyError(() => composeProfiles(bundle, ["general", "docs"]), /general/i);
});

test("documentation-only impact is valid only for the standalone docs profile", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const compose = (ids: readonly string[], impactNature: ImpactNatureForProfileComposition) =>
    composeProfiles(bundle, ids, { impactNature });

  assert.deepEqual(compose(["docs"], "docs-only").profileIds, ["docs"]);
  for (const ids of [["code"], ["general"], ["docs", "ops"]]) {
    assertPolicyError(() => compose(ids, "docs-only"), /documentation only|docs-only/i);
  }
  assert.deepEqual(compose(["code", "docs"], "functional").profileIds, ["code", "docs"]);
});

test("publish validation rejects cross-file registry and policy drift without path disclosure", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const cases: Array<{ mutate(value: any): void; pattern: RegExp }> = [
    {
      mutate: (value) => value.profiles.docs.requiredFieldIds.push("docs.unknown"),
      pattern: /unknown field/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[1].order = 1;
      },
      pattern: /checkbox|contract|order/i,
    },
    {
      mutate: (value) => {
        value.policy.title.typeLabelCompatibility.feat = "^type::feature,$";
      },
      pattern: /compatibility|label/i,
    },
    {
      mutate: (value) => {
        value.policy.title.typeLabelCompatibility.feat = "^type::feature(?:$|x)";
      },
      pattern: /compatibility|label/i,
    },
    {
      mutate: (value) => {
        value.manifest.inputSchema = 2;
      },
      pattern: /schema/i,
    },
    {
      mutate: (value) => {
        value.registries.fields.fields[0].sectionSlot = "risk";
      },
      pattern: /field|slot/i,
    },
    {
      mutate: (value) => {
        value.registries.fields.fields[0].type = "unsupported";
      },
      pattern: /field|type/i,
    },
    {
      mutate: (value) => {
        value.schema.type = "unsupported-json-schema-type";
      },
      pattern: /schema/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[0].label = "Changed";
      },
      pattern: /checkbox|contract/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[0].kind = "changed";
      },
      pattern: /checkbox|contract/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[0].source = "changed";
      },
      pattern: /checkbox|contract/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[0].sectionSlot = "changed";
      },
      pattern: /checkbox|contract/i,
    },
    {
      mutate: (value) => {
        value.registries.checkboxes.checkboxes[0].evidenceSchema = { changed: true };
      },
      pattern: /checkbox|contract/i,
    },
    {
      mutate: (value) => {
        value.profiles.code.requiredCheckboxIds = [];
      },
      pattern: /profile|minimum|required/i,
    },
    {
      mutate: (value) => {
        value.profiles.code.requiredBaseFields = [];
      },
      pattern: /profile|minimum|required/i,
    },
    {
      mutate: (value) => {
        value.profiles.docs.requiredFieldIds = [];
      },
      pattern: /profile|minimum|required/i,
    },
    {
      mutate: (value) => {
        value.profiles.ops.requiredBaseFields = [];
      },
      pattern: /profile|minimum|required/i,
    },
    {
      mutate: (value) => {
        value.profiles.general.requiredBaseFields = [];
      },
      pattern: /profile|minimum|required/i,
    },
    {
      mutate: (value) => {
        value.profiles.general.constraints = [];
      },
      pattern: /profile|minimum|required/i,
    },
  ];

  for (const fixture of cases) {
    const changed = mutableBundle(bundle);
    fixture.mutate(changed);
    await assertTemplateError(
      async () => validateTemplateBundle(changed),
      fixture.pattern,
      repositoryRoot,
    );
  }
});

test("publish validation pins the V1 profile auto-detection path rules", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const mutations: Array<(value: any) => void> = [
    (value) => {
      value.profiles.general.matchRules.paths = ["**"];
    },
    (value) => {
      value.profiles.docs.matchRules.paths = ["**"];
    },
    (value) => {
      value.profiles.code.matchRules.paths = value.profiles.code.matchRules.paths
        .filter((path: string) => path !== "src/**");
    },
  ];

  for (const mutate of mutations) {
    const changed = mutableBundle(bundle);
    mutate(changed);
    await assertTemplateError(
      async () => validateTemplateBundle(changed),
      /profile|match|rule|contract/i,
      repositoryRoot,
    );
  }
});

test("publish validation pins the canonical V1 request schema semantics", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const mutations: Array<(value: any) => void> = [
    (value) => {
      value.schema.additionalProperties = true;
    },
    (value) => {
      value.schema.definitions.prose.minLength = 0;
    },
  ];

  for (const mutate of mutations) {
    const changed = mutableBundle(bundle);
    mutate(changed);
    await assertTemplateError(
      async () => validateTemplateBundle(changed),
      /schema|contract/i,
      repositoryRoot,
    );
  }
});

test("loader requires the request schema payload to remain byte-identical", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const schemaPath = resolve(bundlePath, "schema.json");
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  await writeFile(schemaPath, `${JSON.stringify(schema)}\n`, "utf8");
  const built = await buildTemplateBundleManifest(bundlePath);
  await writeFile(resolve(bundlePath, "bundle-manifest.json"), built.serialized, "utf8");

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /schema|contract|byte/i,
    bundlePath,
  );
});

test("loader applies semantic publish validation after strict payload parsing", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  const profilePath = resolve(bundlePath, "profiles/docs.yml");
  const profile = await readFile(profilePath, "utf8");
  await writeFile(
    profilePath,
    profile.replace("docs.content-impact", "docs.unknown"),
    "utf8",
  );
  const built = await buildTemplateBundleManifest(bundlePath);
  await writeFile(resolve(bundlePath, "bundle-manifest.json"), built.serialized, "utf8");

  await assertTemplateError(
    () => loadTemplateBundle(bundlePath),
    /unknown field|required V1 fields/i,
    bundlePath,
  );
});

test("internal validate-bundle emits one schema-valid JSON success document", () => {
  const sourceEntrypoint = resolve(repositoryRoot, "src/main.ts");
  const result = runProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntrypoint,
      "internal",
      "validate-bundle",
      templateBundlePath,
    ],
    { cwd: repositoryRoot },
  );
  const diagnostic = JSON.stringify(result, undefined, 2);

  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.equal(result.stdout.trimEnd().split(/\r?\n/u).length, 1, diagnostic);
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    code: string;
    versions: { templateVersion: string; inputSchema: number; policySchema: number; bundleHash: string };
    data: { bundleId: string; payloadCount: number };
  };
  assert.equal(output.ok, true);
  assert.equal(output.code, "OK");
  assert.deepEqual(output.versions, {
    cliVersion: "0.1.0-dev",
    templateVersion: "1.0.0",
    bundleHash: output.versions.bundleHash,
    releaseSetId: null,
    inputSchema: 1,
    policySchema: 1,
    loadedSkillVersion: null,
    loadedSkillProtocol: null,
    installedSkillVersion: null,
    stagedSkillVersion: null,
    manifestSequence: null,
  });
  assert.match(output.versions.bundleHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(output.data, { bundleId: "harness-mr-default", payloadCount: 9 });
});

test("internal validate-bundle serializes TEMPLATE_ERROR without disclosing its path", async (context) => {
  const bundlePath = await createValidBundleFixture(context);
  await writeFile(resolve(bundlePath, "unexpected.txt"), "surprise", "utf8");
  const sourceEntrypoint = resolve(repositoryRoot, "src/main.ts");
  const result = runProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntrypoint,
      "internal",
      "validate-bundle",
      bundlePath,
    ],
    { cwd: repositoryRoot },
  );
  const diagnostic = JSON.stringify(result, undefined, 2);

  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 2, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.equal(result.stdout.trimEnd().split(/\r?\n/u).length, 1, diagnostic);
  assert.equal(result.stdout.includes(bundlePath), false, diagnostic);
  const output = JSON.parse(result.stdout) as {
    ok: boolean;
    code: string;
    error: { safeNextStep: string };
  };
  assert.equal(output.ok, false);
  assert.equal(output.code, "TEMPLATE_ERROR");
  assert.equal(output.error.safeNextStep.length > 0, true);
});

test("internal validate-bundle invalid arguments emit one schema-valid INPUT_ERROR", () => {
  const sourceEntrypoint = resolve(repositoryRoot, "src/main.ts");
  const result = runProcess(
    process.execPath,
    ["--import", "tsx", sourceEntrypoint, "internal", "validate-bundle"],
    { cwd: repositoryRoot },
  );
  const diagnostic = JSON.stringify(result, undefined, 2);

  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 2, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.equal(result.stdout.trimEnd().split(/\r?\n/u).length, 1, diagnostic);
  const output = JSON.parse(result.stdout) as Record<string, unknown>;
  const validateOutput = new Ajv({ allErrors: true, strict: true }).compile(outputSchema);
  assert.equal(validateOutput(output), true, JSON.stringify(validateOutput.errors));
  assert.equal(output.ok, false);
  assert.equal(output.code, "INPUT_ERROR");
  assert.equal((output.error as Record<string, unknown>).field, "arguments");
});

test("auto detection classifies versioned diff fixtures in stable Profile order", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const fixtures = JSON.parse(await readFile(
    resolve(repositoryRoot, "test/fixtures/diffs/profile-detection.json"),
    "utf8",
  )) as Array<{
    name: string;
    items: DiffItem[];
    expected: ProfileDetectionResult;
  }>;

  for (const fixture of fixtures) {
    assert.deepEqual(
      detectProfiles(bundle, fixture.items),
      fixture.expected,
      fixture.name,
    );
  }
});

test("auto detection handles rename and delete paths conservatively", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);

  assert.deepEqual(
    detectProfiles(bundle, [{
      status: "renamed",
      oldPath: "src/old.ts",
      newPath: "docs/new.md",
      binary: false,
      submodule: false,
    }]),
    { kind: "detected", profileIds: ["code", "docs"] },
  );
  assert.deepEqual(
    detectProfiles(bundle, [{
      status: "deleted",
      oldPath: "DOCS\\REMOVED.MDX",
      binary: false,
      submodule: false,
    }]),
    { kind: "detected", profileIds: ["docs"] },
  );
  assert.deepEqual(
    detectProfiles(bundle, [{
      status: "renamed",
      oldPath: "src/known.ts",
      newPath: "vendor/unknown.asset",
      binary: false,
      submodule: false,
    }]),
    { kind: "ambiguous", reason: "unknown-path", itemIndex: 0 },
  );
});

test("auto detection enforces status-specific path fields", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const invalidItems = [
    { status: "added", oldPath: null, newPath: "src/a.ts", binary: false, submodule: false },
    { status: "modified", oldPath: "src/a.ts", newPath: "src/a.ts", binary: false, submodule: false },
    { status: "deleted", oldPath: "src/a.ts", newPath: null, binary: false, submodule: false },
  ];

  for (const item of invalidItems) {
    assert.deepEqual(
      detectProfiles(bundle, [item]),
      { kind: "ambiguous", reason: "invalid-item", itemIndex: 0 },
    );
  }
});

test("auto detection rejects empty, unsafe and unsupported ChangeSets", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const cases: Array<{
    items: unknown;
    expected: ProfileDetectionResult;
  }> = [
    { items: [], expected: { kind: "ambiguous", reason: "empty-diff", itemIndex: null } },
    {
      items: [
        { status: "modified", newPath: "src/a.ts", binary: false, submodule: false },
        { status: "modified", newPath: "vendor/data.bin", binary: false, submodule: false },
      ],
      expected: { kind: "ambiguous", reason: "unknown-path", itemIndex: 1 },
    },
    {
      items: [{ status: "modified", newPath: "docs/a.md", binary: true, submodule: false }],
      expected: { kind: "ambiguous", reason: "binary", itemIndex: 0 },
    },
    {
      items: [{ status: "modified", newPath: "src/vendor", binary: false, submodule: true }],
      expected: { kind: "ambiguous", reason: "submodule", itemIndex: 0 },
    },
    {
      items: [{ status: "copied", oldPath: "src/a.ts", newPath: "src/b.ts", binary: false, submodule: false }],
      expected: { kind: "ambiguous", reason: "unsupported-status", itemIndex: 0 },
    },
    {
      items: [
        { status: "modified", newPath: "LICENSE", binary: false, submodule: false },
        { status: "modified", newPath: "docs/a.md", binary: false, submodule: false },
      ],
      expected: { kind: "ambiguous", reason: "general-mixed", itemIndex: 1 },
    },
  ];

  for (const fixture of cases) {
    assert.deepEqual(detectProfiles(bundle, fixture.items), fixture.expected);
  }
});

test("auto detection rejects illegal paths instead of normalizing traversal", async () => {
  const bundle = await loadTemplateBundle(templateBundlePath);
  const invalidPaths = [
    "../src/a.ts",
    "/src/a.ts",
    "C:\\src\\a.ts",
    "src//a.ts",
    "./src/a.ts",
    "src/a.ts/",
    "src/./a.ts",
    "src/../a.ts",
    "src/a\u0000.ts",
    "src/a\n.ts",
  ];

  for (const path of invalidPaths) {
    assert.deepEqual(
      detectProfiles(bundle, [{
        status: "modified",
        newPath: path,
        binary: false,
        submodule: false,
      }]),
      { kind: "ambiguous", reason: "invalid-path", itemIndex: 0 },
      path,
    );
  }
});
