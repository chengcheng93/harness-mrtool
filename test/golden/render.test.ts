import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { stringify as stringifyYaml } from "yaml";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { decodeInputBytes } from "../../src/input/load-input.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { renderTitle } from "../../src/render/title.ts";
import { deriveReviewStates, renderDescription } from "../../src/render/markdown.ts";
import { renderProjectTemplate } from "../../src/render/project-template.ts";
import {
  appendDiagnosticMarker,
  digestDescriptionBody,
  parseDiagnosticMarker,
  validateDesiredWritePlan,
  validateExternalContextSnapshot,
  verifyDiagnosticMarker,
  type DiagnosticMarkerInputs,
} from "../../src/render/marker.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("ready title matches the canonical UTF-8 golden", async () => {
  const [requestBytes, expected, bundle] = await Promise.all([
    readFile(resolve(repositoryRoot, "test/fixtures/requests/code-docs.json")),
    readFile(resolve(import.meta.dirname, "fixtures/title-ready.txt"), "utf8"),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const request = normalizeAndValidateRequest(decodeInputBytes(requestBytes, "json"));

  assert.equal(renderTitle(request, bundle), expected.replace(/\r?\n$/u, ""));
});

test("title format and 100-Unicode-scalar limit are exact for Ready and Draft", async () => {
  const [requestValue, bundle] = await Promise.all([
    readFile(resolve(import.meta.dirname, "fixtures/code-docs-request.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  requestValue.title.module = "m".repeat(20);
  requestValue.title.titleSummary = "界".repeat(72);
  const readyRequest = normalizeAndValidateRequest(requestValue);
  const readyTitle = renderTitle(readyRequest, bundle);

  assert.equal([...readyTitle].length, 100);
  assert.equal(readyTitle, `[fix][${"m".repeat(20)}] ${"界".repeat(72)}`);
  const tamperedBundle = {
    ...structuredClone(bundle),
    layout: { ...structuredClone(bundle.layout), markdown: "## Invalid\n" },
  };
  assert.throws(() => renderTitle(readyRequest, tamperedBundle), /renderer input is invalid/u);
  const draftRequest = normalizeAndValidateRequest({ ...requestValue, intent: "draft" });
  assert.throws(
    () => renderTitle(draftRequest, bundle),
    /exceeds 100 Unicode scalar values/u,
  );
});

test("diagnostic marker hashes the LF body without hashing itself", async () => {
  const request = normalizeAndValidateRequest(JSON.parse(await readFile(
    resolve(import.meta.dirname, "fixtures/code-docs-request.json"),
    "utf8",
  )));
  const stateMap = Object.fromEntries([
    ...request.verification.items.map((item) => [item.id, item.state]),
    ...[
      "source-branch-synced", "commit-convention", "work-item-reviewed",
      "metadata-reviewed", "secret-scan-reviewed", "repository-hygiene-reviewed",
      "ci-status", "reviewer-requested", "high-risk-reviewers", "blocking-issues",
    ].map((id) => [id, "pending"]),
  ]);
  const inputs: DiagnosticMarkerInputs = {
    releaseTag: "templates-v1.0.0",
    bundleId: "harness-mr-default",
    bundleVersion: "1.0.0",
    bundleManifestHash: "a".repeat(64),
    profileIds: request.profileIds,
    policySchema: 1,
    cliVersion: "0.1.0-dev",
    renderPhase: "final",
    stateMap,
    request,
    snapshot: {
      snapshotVersion: 1,
      targetProject: { id: "project:target", path: "team/target" },
      sourceProject: { id: "project:source", path: "team/source" },
      targetRefSha: "a".repeat(40),
      mergeBaseSha: "b".repeat(40),
      sourceHeadSha: "c".repeat(40),
      issue: { kind: "none" },
      labelCandidates: [{ id: "label:1", name: "type::bug" }],
      userCandidates: [
        { id: "user:author", username: "author", displayName: "Author User" },
      ],
      mergeRequest: {
        iid: null,
        authorUserId: "user:author",
        lifecycle: "new",
        labelIds: [],
        assigneeUserId: null,
        reviewerUserIds: [],
      },
      localChecks: {
        commitConvention: { status: "passed", evidence: "Commit convention check passed." },
        secretScan: { status: "not-run", evidence: "Secret scan has not been run." },
        repositoryHygiene: { status: "passed", evidence: "Repository hygiene check passed." },
      },
      metadataRead: { status: "available", evidence: "Merge request metadata was read." },
      ci: { status: "unavailable" },
      review: { approvedByUserIds: [], qualifiedReviewerUserIds: [], unresolvedDiscussions: null },
    },
    writePlan: {
      writePlanVersion: 1,
      title: "[fix][module] Summary",
      labelIds: ["label:1"],
      assigneeUserId: null,
      reviewerUserIds: [],
      removeSourceBranch: false,
      squash: false,
    },
  };

  const description = appendDiagnosticMarker("## 1. Changes\r\n\r\nBody\r\n", inputs);
  assert.match(description, /\n<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n$/u);
  const metadata = verifyDiagnosticMarker(description, inputs);

  assert.equal(metadata.bodyDigest, digestDescriptionBody(description));
  assert.equal(description.match(/harness-mrtool:v1/gu)?.length, 1);
  assert.equal(description.includes("="), false);
});

test("marker state map is exactly active evidence plus ten derived review IDs", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const description = renderDescription({
    request: normalizeAndValidateRequest(requestValue), snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });
  const keys = Object.keys(parseDiagnosticMarker(description).stateMap).sort();

  assert.deepEqual(keys, [
    "blocking-issues", "ci-status", "commit-convention", "core-behavior",
    "docs-links-format", "high-risk-reviewers", "integration-tests", "local-build",
    "metadata-reviewed", "repository-hygiene-reviewed", "reviewer-requested",
    "secret-scan-reviewed", "source-branch-synced", "unit-tests", "work-item-reviewed",
  ]);
});

test("external snapshot accepts only typed sources for derived review state", async () => {
  const snapshot = JSON.parse(await readFile(
    resolve(import.meta.dirname, "fixtures/code-docs-snapshot.json"),
    "utf8",
  ));

  const validated = validateExternalContextSnapshot(snapshot);

  assert.equal(validated.localChecks.secretScan.status, "not-run");
  assert.equal(validated.metadataRead.status, "available");
  assert.deepEqual(validated.review.qualifiedReviewerUserIds, ["user:20"]);
  assert.throws(
    () => validateExternalContextSnapshot({ ...snapshot, derivedStates: { "ci-status": "checked" } }),
    /missing or unknown fields/u,
  );
});

test("code+docs description body matches the canonical eight-section golden", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, expectedBody, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-body.md"), "utf8"),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const request = normalizeAndValidateRequest(requestValue);

  const description = renderDescription({
    request,
    snapshot,
    writePlan,
    bundle,
    releaseTag: "templates-v1.0.0",
    cliVersion: "0.1.0-dev",
    renderPhase: "final",
  });
  const body = description.replace(/<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n$/u, "");

  assert.equal(body, expectedBody.replace(/\r\n?/gu, "\n"));
  assert.equal(verifyDiagnosticMarker(description).bodyDigest, digestDescriptionBody(expectedBody));
});

test("MR label display order follows policy categories despite token and API ordering", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  requestValue.mergeRequest.labelCandidateTokens.reverse();
  const request = normalizeAndValidateRequest(requestValue);
  const description = renderDescription({
    request, snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });

  assert.match(description, /Merge Request Labels: week&#58;&#58;[^,]+, type&#58;&#58;bug, priority&#58;&#58;p1, status&#58;&#58;review/u);
});

test("opaque context tokens never enter snapshot or decoded marker metadata", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  requestValue.mergeRequest.labelCandidateTokens = ["hmrc1_label_secret"];
  requestValue.mergeRequest.assigneeCandidateToken = "hmrc1_assignee_secret";
  requestValue.review.reviewerCandidateTokens = ["hmrc1_reviewer_secret"];
  const request = normalizeAndValidateRequest(requestValue);
  const description = renderDescription({
    request, snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });
  const metadata = parseDiagnosticMarker(description);

  assert.equal(JSON.stringify(snapshot).includes("hmrc1_"), false);
  assert.equal(description.includes("hmrc1_"), false);
  assert.equal(JSON.stringify(metadata).includes("hmrc1_"), false);
});

test("all ten Review / CI states derive only from declared snapshot sources", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshotValue, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const request = normalizeAndValidateRequest(requestValue);
  const validate = (value: unknown) => validateExternalContextSnapshot(value);
  const derive = (value: unknown, requestOverride = request) =>
    deriveReviewStates(requestOverride, validate(value), bundle);
  const base = derive(snapshotValue);

  assert.deepEqual(Object.fromEntries(Object.entries(base).map(([id, value]) => [id, value.state])), {
    "source-branch-synced": "checked",
    "commit-convention": "checked",
    "work-item-reviewed": "checked",
    "metadata-reviewed": "checked",
    "secret-scan-reviewed": "pending",
    "repository-hygiene-reviewed": "checked",
    "ci-status": "pending",
    "reviewer-requested": "checked",
    "high-risk-reviewers": "not-applicable",
    "blocking-issues": "checked",
  });

  const mutated = structuredClone(snapshotValue);
  mutated.mergeBaseSha = "f".repeat(40);
  mutated.localChecks.commitConvention.status = "failed";
  mutated.localChecks.secretScan.status = "passed";
  mutated.localChecks.repositoryHygiene.status = "unavailable";
  mutated.ci.status = "failed";
  mutated.review.qualifiedReviewerUserIds = null;
  mutated.review.unresolvedDiscussions = 2;
  const pending = derive(mutated);
  assert.equal(pending["source-branch-synced"]?.state, "pending");
  assert.equal(pending["commit-convention"]?.state, "pending");
  assert.equal(pending["secret-scan-reviewed"]?.state, "checked");
  assert.equal(pending["repository-hygiene-reviewed"]?.state, "pending");
  assert.equal(pending["ci-status"]?.state, "pending");
  assert.equal(pending["reviewer-requested"]?.state, "pending");
  assert.equal(pending["blocking-issues"]?.state, "pending");

  const highRequest = normalizeAndValidateRequest({
    ...requestValue,
    risk: { ...requestValue.risk, level: "high" },
  });
  const highPending = derive(snapshotValue, highRequest);
  assert.equal(highPending["high-risk-reviewers"]?.state, "pending");
  const twoReviewers = structuredClone(snapshotValue);
  twoReviewers.userCandidates.push({
    id: "user:40", username: "carol", displayName: "Carol Li",
  });
  twoReviewers.mergeRequest.reviewerUserIds.push("user:40");
  twoReviewers.review.qualifiedReviewerUserIds.push("user:40");
  const highChecked = derive(twoReviewers, highRequest);
  assert.equal(highChecked["high-risk-reviewers"]?.state, "checked");

  const draftRequest = normalizeAndValidateRequest({ ...requestValue, intent: "draft" });
  const draftSnapshot = structuredClone(snapshotValue);
  draftSnapshot.mergeRequest.lifecycle = "draft";
  const draft = derive(draftSnapshot, draftRequest);
  assert.equal(draft["reviewer-requested"]?.state, "not-applicable");

  const newSnapshot = structuredClone(snapshotValue);
  newSnapshot.mergeRequest.iid = null;
  newSnapshot.mergeRequest.lifecycle = "new";
  assert.equal(derive(newSnapshot)["metadata-reviewed"]?.state, "pending");

  const mismatch = structuredClone(snapshotValue);
  mismatch.issue.iid = 52;
  assert.throws(() => derive(mismatch), /work item Request and external Issue snapshot do not match/u);
});

test("snapshot collections canonicalize API ordering and reject duplicates or dangling IDs", async () => {
  const snapshot = JSON.parse(await readFile(
    resolve(import.meta.dirname, "fixtures/code-docs-snapshot.json"),
    "utf8",
  ));
  const reversed = structuredClone(snapshot);
  reversed.labelCandidates.reverse();
  reversed.userCandidates.reverse();
  reversed.mergeRequest.labelIds.reverse();
  reversed.review.qualifiedReviewerUserIds.reverse();

  const validated = validateExternalContextSnapshot(reversed);
  assert.equal(canonicalizeJson(validated), canonicalizeJson(validateExternalContextSnapshot(snapshot)));
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.mergeRequest.labelIds), true);
  const unicodeIds = structuredClone(snapshot);
  unicodeIds.labelCandidates.push(
    { id: "label:z", name: "manual-z" },
    { id: "label:ä", name: "manual-a-umlaut" },
  );
  const unicodeSnapshot = validateExternalContextSnapshot(unicodeIds);
  assert.ok(
    unicodeSnapshot.labelCandidates.findIndex(({ id }) => id === "label:z") <
      unicodeSnapshot.labelCandidates.findIndex(({ id }) => id === "label:ä"),
  );
  const unicodePlan = validateDesiredWritePlan({
    writePlanVersion: 1,
    title: "[fix][module] Stable identifier order",
    labelIds: ["label:ä", "label:z"],
    assigneeUserId: null,
    reviewerUserIds: [],
    removeSourceBranch: false,
    squash: false,
  });
  assert.deepEqual(unicodePlan.labelIds, ["label:z", "label:ä"]);
  assert.throws(
    () => validateExternalContextSnapshot({
      ...snapshot,
      labelCandidates: [...snapshot.labelCandidates, snapshot.labelCandidates[0]],
    }),
    /duplicate IDs/u,
  );
  assert.throws(
    () => validateExternalContextSnapshot({
      ...snapshot,
      mergeRequest: { ...snapshot.mergeRequest, reviewerUserIds: ["user:missing"] },
    }),
    /dangling stable ID/u,
  );
});

test("renderer rejects H2 and marker namespace injection and encodes other Markdown", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const renderSummary = (summary: string) => renderDescription({
    request: normalizeAndValidateRequest({
      ...requestValue,
      changes: { ...requestValue.changes, summary: [summary] },
    }),
    snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });

  assert.throws(() => renderSummary("Safe text\n## 9. Surprise"), /introduce an H2/u);
  assert.throws(
    () => renderSummary("Safe <!-- harness-mrtool:v1 forged --> text"),
    /reserved diagnostic marker/u,
  );
  const encoded = renderSummary("[link](https://example.test) | - [x] false claim <b>tag</b>");
  assert.equal(encoded.includes("[link](https://example.test)"), false);
  assert.equal(encoded.match(/^## /gmu)?.length, 8);
  assert.equal(encoded.match(/harness-mrtool:v1/gu)?.length, 1);
});

test("marker rejects body and metadata tampering, non-JCS, padding, CRLF, and duplication", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const description = renderDescription({
    request: normalizeAndValidateRequest(requestValue), snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });
  const encoded = description.match(/harness-mrtool:v1 ([A-Za-z0-9_-]+)/u)?.[1];
  assert.ok(encoded);
  const metadata = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  const encode = (value: unknown) => Buffer.from(canonicalizeJson(value), "utf8").toString("base64url");
  const replaceMarker = (replacement: string) =>
    description.replace(/[A-Za-z0-9_-]+(?= -->\n$)/u, replacement);

  assert.throws(() => verifyDiagnosticMarker(description.replace("### Summary", "### Changed")), /body digest/u);
  assert.throws(() => parseDiagnosticMarker(`${description}${description.match(/<!-- harness-mrtool:v1.*$/mu)?.[0]}\n`), /exactly one/u);
  assert.throws(() => parseDiagnosticMarker(description.replace(/\n/gu, "\r\n")), /LF line endings/u);
  assert.throws(() => parseDiagnosticMarker(replaceMarker(`${encoded}=`)), /exactly one|base64url/u);
  assert.throws(() => parseDiagnosticMarker(replaceMarker(encode({ ...metadata, unexpected: true }))), /canonical JCS|unknown fields/u);
  const reversed = Object.fromEntries(Object.entries(metadata).reverse());
  const nonCanonical = Buffer.from(JSON.stringify(reversed), "utf8").toString("base64url");
  assert.throws(() => parseDiagnosticMarker(replaceMarker(nonCanonical)), /canonical JCS/u);
  const missingState = structuredClone(metadata);
  delete missingState.stateMap["ci-status"];
  assert.throws(() => parseDiagnosticMarker(replaceMarker(encode(missingState))), /stateMap keys/u);
  const extraState = structuredClone(metadata);
  extraState.stateMap.app = "checked";
  assert.throws(() => parseDiagnosticMarker(replaceMarker(encode(extraState))), /stateMap keys/u);
  const nonCanonicalProfiles = { ...metadata, profileIds: ["docs", "code"] };
  assert.throws(
    () => parseDiagnosticMarker(replaceMarker(encode(nonCanonicalProfiles))),
    /Profile IDs/u,
  );
  const forgedDigest = { ...metadata, requestDigest: "0".repeat(64) };
  assert.throws(
    () => verifyDiagnosticMarker(replaceMarker(encode(forgedDigest)), {
      releaseTag: "templates-v1.0.0",
      bundleId: bundle.manifest.bundleId,
      bundleVersion: bundle.manifest.version,
      bundleManifestHash: createHash("sha256").update(`${canonicalizeJson(bundle.manifest)}\n`).digest("hex"),
      profileIds: ["code", "docs"],
      policySchema: bundle.manifest.policySchema,
      cliVersion: "0.1.0-dev",
      renderPhase: "final",
      stateMap: metadata.stateMap,
      request: normalizeAndValidateRequest(requestValue),
      snapshot: validateExternalContextSnapshot(snapshot),
      writePlan,
    }),
    /metadata does not match/u,
  );
  assert.throws(
    () => appendDiagnosticMarker("Body", {
      releaseTag: "templates-v1.0.0",
      bundleId: bundle.manifest.bundleId,
      bundleVersion: bundle.manifest.version,
      bundleManifestHash: createHash("sha256").update(`${canonicalizeJson(bundle.manifest)}\n`).digest("hex"),
      profileIds: ["ops"],
      policySchema: bundle.manifest.policySchema,
      cliVersion: "0.1.0-dev",
      renderPhase: "final",
      stateMap: metadata.stateMap,
      request: normalizeAndValidateRequest(requestValue),
      snapshot,
      writePlan,
    }),
    /Profile IDs do not match/u,
  );
  assert.throws(
    () => appendDiagnosticMarker("Body", {
      releaseTag: "templates-v1.0.0",
      bundleId: bundle.manifest.bundleId,
      bundleVersion: bundle.manifest.version,
      bundleManifestHash: createHash("sha256").update(`${canonicalizeJson(bundle.manifest)}\n`).digest("hex"),
      profileIds: ["code", "docs"],
      policySchema: bundle.manifest.policySchema,
      cliVersion: "0.1.0-dev",
      renderPhase: "final",
      stateMap: metadata.stateMap,
      request: normalizeAndValidateRequest(requestValue),
      snapshot,
      writePlan,
      unexpected: true,
    } as never),
    /marker inputs has missing or unknown fields/u,
  );
});

test("same canonical inputs render one byte identity across transports and 100 runs", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const render = (request: ReturnType<typeof normalizeAndValidateRequest>) => renderDescription({
    request, snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
  });
  const requestJson = normalizeAndValidateRequest(decodeInputBytes(
    Buffer.from(JSON.stringify(requestValue), "utf8"),
    "json",
  ));
  const requestYaml = normalizeAndValidateRequest(decodeInputBytes(
    Buffer.from(stringifyYaml(requestValue), "utf8"),
    "yaml",
  ));
  const jsonDescription = render(requestJson);

  assert.equal(render(requestYaml), jsonDescription);
  const hashes = new Set(Array.from({ length: 100 }, () =>
    createHash("sha256").update(render(requestJson), "utf8").digest("hex")));
  assert.equal(hashes.size, 1);
});

test("title summary and description summary remain independent", async () => {
  const fixture = (name: string) => resolve(import.meta.dirname, "fixtures", name);
  const [requestValue, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
  ]);
  const withoutMarker = (description: string) =>
    description.replace(/<!-- harness-mrtool:v1 [A-Za-z0-9_-]+ -->\n$/u, "");
  const render = (request: ReturnType<typeof normalizeAndValidateRequest>, plan = writePlan) =>
    renderDescription({
      request, snapshot, writePlan: plan, bundle,
      releaseTag: "templates-v1.0.0", cliVersion: "0.1.0-dev", renderPhase: "final",
    });
  const originalRequest = normalizeAndValidateRequest(requestValue);
  const originalDescription = render(originalRequest);
  const changedBodyRequest = normalizeAndValidateRequest({
    ...requestValue,
    changes: { ...requestValue.changes, summary: ["A different description summary."] },
  });

  assert.equal(renderTitle(changedBodyRequest, bundle), renderTitle(originalRequest, bundle));
  assert.notEqual(withoutMarker(render(changedBodyRequest)), withoutMarker(originalDescription));

  const changedTitleRequest = normalizeAndValidateRequest({
    ...requestValue,
    title: { ...requestValue.title, titleSummary: "Use an independent MR title" },
  });
  const changedTitlePlan = {
    ...writePlan,
    title: renderTitle(changedTitleRequest, bundle),
  };
  const changedTitleDescription = render(changedTitleRequest, changedTitlePlan);

  assert.notEqual(renderTitle(changedTitleRequest, bundle), renderTitle(originalRequest, bundle));
  assert.equal(withoutMarker(changedTitleDescription), withoutMarker(originalDescription));
  assert.notEqual(changedTitleDescription, originalDescription);
});

for (const profile of ["general", "code", "docs", "ops"] as const) {
  test(`GitLab ${profile} project template matches its read-only golden`, async () => {
    const [bundle, expected] = await Promise.all([
      loadTemplateBundle(resolve(repositoryRoot, "template-bundle")),
      readFile(resolve(import.meta.dirname, `fixtures/project-${profile}.md`), "utf8"),
    ]);
    const rendered = renderProjectTemplate(profile, bundle);

    assert.equal(rendered, expected.replace(/\r\n?/gu, "\n"));
    assert.equal(rendered.match(/^## /gmu)?.length, 8);
    assert.equal(rendered.includes("[x]"), false);
    assert.equal(rendered.includes("harness-mrtool:v1"), false);
    assert.equal(rendered.includes("{{"), false);
    assert.equal(rendered.includes("candidate:"), false);
    assert.equal(rendered.includes("status::"), false);
    assert.equal(rendered.includes("/assign"), false);
  });
}

test("project template export rejects auto and Profile combinations", async () => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  assert.throws(() => renderProjectTemplate("auto", bundle), /unsupported or combined Profile/u);
  assert.throws(() => renderProjectTemplate("code+docs", bundle), /unsupported or combined Profile/u);
});
