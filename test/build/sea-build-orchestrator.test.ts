import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// The build orchestrator is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The build orchestrator intentionally has no declaration file.
import { orchestrateSeaBuild } from "../../scripts/sea-build-orchestrator.mjs";

test("rejects input changes during build and removes canonical outputs", async (context) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "harness-sea-orchestrator-"));
  context.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const inputPath = join(repositoryRoot, "src", "main.ts");
  const artifactPath = join(repositoryRoot, "dist", "harness-mrtool.exe");
  const receiptPath = join(repositoryRoot, "dist", "sea-build-receipt.json");
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, "source before build", "utf8");

  await assert.rejects(
    orchestrateSeaBuild({
      artifactPath,
      buildArtifact: async () => {
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, "injected and verified artifact", "utf8");
        writeFileSync(receiptPath, "stale receipt", "utf8");
        writeFileSync(inputPath, "source changed during build", "utf8");
      },
      collectBuildInputPaths: () => [inputPath],
      receiptPath,
      repositoryRoot,
    }),
    /build inputs changed during build/i,
  );

  assert.equal(existsSync(artifactPath), false);
  assert.equal(existsSync(receiptPath), false);
});

test("rejects input paths added during build", async (context) => {
  const repositoryRoot = mkdtempSync(join(tmpdir(), "harness-sea-orchestrator-"));
  context.after(() => rmSync(repositoryRoot, { recursive: true, force: true }));
  const inputPath = join(repositoryRoot, "src", "main.ts");
  const addedInputPath = join(repositoryRoot, "src", "added.ts");
  const artifactPath = join(repositoryRoot, "dist", "harness-mrtool.exe");
  const receiptPath = join(repositoryRoot, "dist", "sea-build-receipt.json");
  mkdirSync(dirname(inputPath), { recursive: true });
  writeFileSync(inputPath, "source before build", "utf8");

  await assert.rejects(
    orchestrateSeaBuild({
      artifactPath,
      buildArtifact: async () => {
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, "injected and verified artifact", "utf8");
        writeFileSync(addedInputPath, "added during build", "utf8");
      },
      collectBuildInputPaths: () =>
        existsSync(addedInputPath)
          ? [inputPath, addedInputPath]
          : [inputPath],
      receiptPath,
      repositoryRoot,
    }),
    /build inputs changed during build/i,
  );

  assert.equal(existsSync(artifactPath), false);
  assert.equal(existsSync(receiptPath), false);
});
