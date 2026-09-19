import assert from "node:assert/strict";
import test from "node:test";

import { runProductionMain } from "../../src/production-main.ts";
import type { ProductionInstallationService } from "../../src/update/managed-installation-types.ts";

function outputSink(chunks: string[]) {
  return { write(chunk: string): boolean { chunks.push(chunk); return true; } };
}

function installationService(recover: () => Promise<void>): ProductionInstallationService {
  return {
    apply: async () => { throw new Error("apply must not run"); },
    rollback: async () => { throw new Error("rollback must not run"); },
    recover,
  } as unknown as ProductionInstallationService;
}

test("default production entry recovers a durable installation journal before ordinary work", async () => {
  let recoveries = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["version", "--no-update", "--output", "json"], {
    installationService: installationService(async () => { recoveries += 1; }),
    stdout: outputSink(stdout),
    stderr: outputSink(stderr),
  });

  assert.equal(exitCode, 0);
  assert.equal(recoveries, 1);
  assert.equal(stderr.join(""), "");
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "OK");
});

test("self-update repair owns recovery and is not double-recovered by startup", async () => {
  let recoveries = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runProductionMain(["self-update", "repair", "--no-update", "--output", "json"], {
    installationService: installationService(async () => { recoveries += 1; }),
    stdout: outputSink(stdout),
    stderr: outputSink(stderr),
  });

  assert.equal(exitCode, 0);
  assert.equal(recoveries, 1);
  assert.equal(stderr.join(""), "");
  assert.equal((JSON.parse(stdout.join("")) as { readonly code: string }).code, "OK");
});
