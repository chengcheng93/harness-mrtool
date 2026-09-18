import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import { withUpdateLock } from "../../src/platform/lock.ts";
import { createInstallationJournalStore } from "../../src/update/installation-journal-store.ts";
import { recoverInstallationJournal, type InstallationRecoveryDriver } from "../../src/update/installation-recovery-coordinator.ts";
import type { RecoveryFacts } from "../../src/update/installation-recovery.ts";
import { journalFixture, type JournalFixture } from "../helpers/installation-journal-fixture.ts";

const allowTestAcl = Object.freeze({ verify: async (_path: string): Promise<void> => undefined });

const stableFacts: RecoveryFacts = Object.freeze({
  canonical: "previous", marker: "previous", active: "previous",
  previousComplete: true, nextComplete: true,
  enrollment: "enrolled", policyContinuity: "current",
  writerAuthority: "fenced-current-epoch", launch: "none", retention: "current",
  knownPolicyAllowsPrevious: true, knownPolicyAllowsNext: true, innerBinding: "none",
});

async function withStateRoot<T>(callback: (stateRoot: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-mrtool-recovery-coordinator-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function journalForRoot(stateRoot: string): Promise<JournalFixture> {
  const journal = journalFixture("darwin-arm64", "prepared");
  const root = await lstat(stateRoot, { bigint: true });
  journal.roots.state = { dev: String(root.dev), ino: String(root.ino) };
  return journal;
}

function driver(overrides: Partial<InstallationRecoveryDriver> = {}): InstallationRecoveryDriver {
  return {
    async observe() { return stableFacts; },
    async apply() {},
    ...overrides,
  };
}

test("no journal is a stable no-op and never invokes the recovery driver", async () => {
  await withStateRoot(async (stateRoot) => {
    const calls: string[] = [];
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationJournalStore(stateRoot, { lease, windowsAclVerifier: allowTestAcl });
      await recoverInstallationJournal({ stateDirectory: stateRoot, store, lease,
        driver: driver({ async observe() { calls.push("observe"); return stableFacts; } }) });
    });
    assert.deepEqual(calls, []);
  });
});


test("a new process can reload the durable journal before recovery selection", async () => {
  await withStateRoot(async (stateRoot) => {
    const journal = await journalForRoot(stateRoot);
    const store = createInstallationJournalStore(stateRoot, { windowsAclVerifier: allowTestAcl });
    await store.write(journal);
    const script = [
      'import { createInstallationJournalStore } from "./src/update/installation-journal-store.ts";',
      'const allowTestAcl = { verify: async (_path) => undefined };',
      'const journal = await createInstallationJournalStore(process.env.STATE_ROOT, { windowsAclVerifier: allowTestAcl }).read();',
      'if (journal === null) process.exit(2);',
      'process.stdout.write(JSON.stringify({ revision: journal.revision, phase: journal.phase }));',
    ].join("\n");
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, STATE_ROOT: stateRoot },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const [code, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.deepEqual(JSON.parse(stdout), { revision: journal.revision, phase: journal.phase });
  });
});

test("blocked evidence is preserved and cannot invoke a recovery mutation", async () => {
  await withStateRoot(async (stateRoot) => {
    const journal = await journalForRoot(stateRoot);
    let applied = false;
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationJournalStore(stateRoot, { lease, windowsAclVerifier: allowTestAcl });
      await store.write(journal);
      await assert.rejects(
        () => recoverInstallationJournal({ stateDirectory: stateRoot, store, lease,
          driver: driver({ async observe() { return { ...stableFacts, enrollment: "unenrolled" }; }, async apply() { applied = true; } }) }),
        (error: unknown) => {
          assert.ok(error instanceof ToolError);
          assert.equal(error.code, "UPDATE_SECURITY_ERROR");
          return true;
        },
      );
      assert.equal(applied, false);
      assert.ok(await store.read());
    });
  });
});

test("a recovery action must make durable progress before the journal can retire", async () => {
  await withStateRoot(async (stateRoot) => {
    const journal = await journalForRoot(stateRoot);
    let applyCount = 0;
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationJournalStore(stateRoot, { lease, windowsAclVerifier: allowTestAcl });
      await store.write(journal);
      await assert.rejects(
        () => recoverInstallationJournal({ stateDirectory: stateRoot, store, lease, maxSteps: 2,
          driver: driver({ async apply() { applyCount += 1; } }) }),
        (error: unknown) => {
          assert.ok(error instanceof ToolError);
          assert.equal(error.code, "UPDATE_SECURITY_ERROR");
          return true;
        },
      );
      assert.equal(applyCount, 1);
      assert.ok(await store.read());
    });
  });
});

test("a real recovery driver may retire the journal only after its action completes", async () => {
  await withStateRoot(async (stateRoot) => {
    const journal = await journalForRoot(stateRoot);
    await withUpdateLock(stateRoot, async (lease) => {
      const store = createInstallationJournalStore(stateRoot, { lease, windowsAclVerifier: allowTestAcl });
      await store.write(journal);
      await recoverInstallationJournal({ stateDirectory: stateRoot, store, lease,
        driver: driver({ async apply() { await store.remove(); } }) });
      assert.equal(await store.read(), null);
    });
  });
});
