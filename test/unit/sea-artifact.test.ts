import assert from "node:assert/strict";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertArtifactIsFresh } from "../helpers/sea-artifact.ts";

test("rejects a SEA artifact older than any build input", (context) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "harness-sea-freshness-"));
  context.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
  const artifactPath = join(fixtureDirectory, "harness-mrtool.exe");
  const inputPath = join(fixtureDirectory, "main.ts");
  writeFileSync(artifactPath, "artifact");
  writeFileSync(inputPath, "input");
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-01T00:00:01.000Z");
  utimesSync(artifactPath, oldTime, oldTime);
  utimesSync(inputPath, newTime, newTime);

  assert.throws(
    () => assertArtifactIsFresh(artifactPath, [inputPath]),
    /SEA executable is stale.*npm run build:sea/s,
  );
});

test("accepts a SEA artifact at least as new as every build input", (context) => {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "harness-sea-freshness-"));
  context.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
  const artifactPath = join(fixtureDirectory, "harness-mrtool.exe");
  const inputPath = join(fixtureDirectory, "main.ts");
  writeFileSync(artifactPath, "artifact");
  writeFileSync(inputPath, "input");
  const oldTime = new Date("2026-01-01T00:00:00.000Z");
  const newTime = new Date("2026-01-01T00:00:01.000Z");
  utimesSync(inputPath, oldTime, oldTime);
  utimesSync(artifactPath, newTime, newTime);

  assert.doesNotThrow(() => assertArtifactIsFresh(artifactPath, [inputPath]));
});
