import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { normalizeGitLabDescription } from "../../src/gitlab/description.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { renderDescription } from "../../src/render/markdown.ts";
import { verifyDiagnosticMarker } from "../../src/render/marker.ts";

async function managedDescription(): Promise<string> {
  const fixture = (name: string) => resolve(import.meta.dirname, "../golden/fixtures", name);
  const [request, snapshot, writePlan, bundle] = await Promise.all([
    readFile(fixture("code-docs-request.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-snapshot.json"), "utf8").then(JSON.parse),
    readFile(fixture("code-docs-write-plan.json"), "utf8").then(JSON.parse),
    loadTemplateBundle(resolve(import.meta.dirname, "../../template-bundle")),
  ]);
  return renderDescription({ request: normalizeAndValidateRequest(request), snapshot, writePlan, bundle,
    releaseTag: "templates-v1.0.0", cliVersion: "0.1.7", renderPhase: "provisional" });
}

test("restores GitLab's removed terminal LF only for a verified managed description", async () => {
  const original = await managedDescription();
  const remote = original.slice(0, -1);
  assert.throws(() => verifyDiagnosticMarker(remote));
  assert.equal(normalizeGitLabDescription(remote), original);
  assert.deepEqual(verifyDiagnosticMarker(normalizeGitLabDescription(remote)), verifyDiagnosticMarker(original));
  assert.equal(normalizeGitLabDescription(original), original);
});

test("does not repair modified bodies, malformed markers, or unowned prose", async () => {
  const original = await managedDescription();
  const remote = original.slice(0, -1);
  for (const value of ["Manual description", "", `${remote} `, `${original}\n`,
    `Human edits\n${remote}`, remote.replace("harness-mrtool:v1", "harness-mrtool:v2"),
    remote.replace(/ -->$/u, "x -->")]) {
    assert.equal(normalizeGitLabDescription(value), value);
  }
});
