import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AnchoredMoveFileIdentity } from "../../src/platform/anchored-file-mover.ts";
import test from "node:test";

import { publishManagedPosixCandidate, restoreManagedPosixPrevious, stageManagedPosixCandidate, removeManagedPosixStage, verifyManagedPosixStage } from "../../src/update/managed-installation-posix.ts";

const darwin = { skip: process.platform !== "darwin" };

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function installationRoot<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-mrtool-managed-posix-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function stage(root: string, variant: number) {
  const executable = Uint8Array.from([0x7f, 0x53, 0x45, 0x41, variant]);
  const marker = new TextEncoder().encode(`{"schemaVersion":1,"variant":${variant}}\n`);
  return stageManagedPosixCandidate({
    installationDirectory: root,
    executableBytes: executable,
    markerBytes: marker,
    executableSha256: sha(executable),
    markerSha256: sha(marker),
  });
}

async function fileIdentity(path: string): Promise<AnchoredMoveFileIdentity> {
  const info = await lstat(path, { bigint: true });
  return { dev: info.dev, ino: info.ino, size: info.size, mode: info.mode, uid: info.uid };
}

test("stages two distinct candidates and verifies their actual bytes", darwin, async () => {
  await installationRoot(async (root) => {
    const first = await stage(root, 1);
    const second = await stage(root, 2);
    assert.notEqual(first.stageDirectory, second.stageDirectory);
    assert.deepEqual(await readFile(first.executablePath), Buffer.from([0x7f, 0x53, 0x45, 0x41, 1]));
    assert.deepEqual(await readFile(second.executablePath), Buffer.from([0x7f, 0x53, 0x45, 0x41, 2]));
    assert.equal((await verifyManagedPosixStage(first)).executableSha256, sha(Uint8Array.from([0x7f, 0x53, 0x45, 0x41, 1])));
    assert.equal((await verifyManagedPosixStage(second)).executableSha256, sha(Uint8Array.from([0x7f, 0x53, 0x45, 0x41, 2])));
    await removeManagedPosixStage(first);
    await removeManagedPosixStage(second);
    await assert.rejects(() => readFile(first.stageDirectory), { code: "ENOENT" });
    await assert.rejects(() => readFile(second.stageDirectory), { code: "ENOENT" });
  });
});

test("rejects a forged stage handle and preserves a tampered stage", darwin, async () => {
  await installationRoot(async (root) => {
    const candidate = await stage(root, 3);
    const forged = structuredClone(candidate);
    await assert.rejects(() => verifyManagedPosixStage(forged as typeof candidate), { code: "UPDATE_SECURITY_ERROR" });
    await chmod(candidate.executablePath, 0o600);
    await writeFile(candidate.executablePath, Buffer.from("tampered"));
    await assert.rejects(() => verifyManagedPosixStage(candidate), { code: "UPDATE_SECURITY_ERROR" });
    await assert.rejects(() => removeManagedPosixStage(candidate), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(candidate.executablePath, "utf8"), "tampered");
  });
});

test("does not follow a replaced marker symlink during verification or cleanup", darwin, async () => {
  await installationRoot(async (root) => {
    const candidate = await stage(root, 4);
    const outside = join(root, "outside-marker.json");
    await writeFile(outside, "outside\n", { mode: 0o600 });
    await rm(candidate.markerPath);
    await symlink(outside, candidate.markerPath);
    await assert.rejects(() => verifyManagedPosixStage(candidate), { code: "UPDATE_SECURITY_ERROR" });
    await assert.rejects(() => removeManagedPosixStage(candidate), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(outside, "utf8"), "outside\n");
  });
});


test("publishes distinct candidates and retains the expected previous pair", darwin, async () => {
  await installationRoot(async (root) => {
    const first = await stage(root, 5);
    const firstPublication = await publishManagedPosixCandidate({
      stage: first,
      attemptId: "a".repeat(32),
      previous: { executable: null, marker: null },
    });
    assert.equal(firstPublication.previous, null);
    assert.deepEqual(await readFile(join(root, "harness-mrtool")), Buffer.from([0x7f, 0x53, 0x45, 0x41, 5]));

    const previous = {
      executable: await fileIdentity(join(root, "harness-mrtool")),
      marker: await fileIdentity(join(root, ".harness-mrtool-install.json")),
    };
    const second = await stage(root, 6);
    const secondPublication = await publishManagedPosixCandidate({
      stage: second,
      attemptId: "b".repeat(32),
      previous,
    });
    assert.deepEqual(secondPublication.previous, previous);
    assert.deepEqual(await readFile(join(root, "harness-mrtool")), Buffer.from([0x7f, 0x53, 0x45, 0x41, 6]));
    assert.deepEqual(await readFile(join(root, "harness-mrtool.previous-" + "b".repeat(32))), Buffer.from([0x7f, 0x53, 0x45, 0x41, 5]));
    assert.match(await readFile(join(root, ".harness-mrtool-install.previous-" + "b".repeat(32)), "utf8"), /variant":5/u);
  });
});

test("does not publish over a substituted canonical file", darwin, async () => {
  await installationRoot(async (root) => {
    const first = await stage(root, 7);
    await publishManagedPosixCandidate({ stage: first, attemptId: "c".repeat(32), previous: { executable: null, marker: null } });
    const previous = {
      executable: await fileIdentity(join(root, "harness-mrtool")),
      marker: await fileIdentity(join(root, ".harness-mrtool-install.json")),
    };
    const second = await stage(root, 8);
    await rm(join(root, "harness-mrtool"));
    await writeFile(join(root, "harness-mrtool"), "sentinel", { mode: 0o500 });
    await assert.rejects(
      () => publishManagedPosixCandidate({ stage: second, attemptId: "d".repeat(32), previous }),
      { code: "UPDATE_SECURITY_ERROR" },
    );
    assert.equal(await readFile(join(root, "harness-mrtool"), "utf8"), "sentinel");
    assert.deepEqual(await readFile(second.executablePath), Buffer.from([0x7f, 0x53, 0x45, 0x41, 8]));
  });
});

test("restores the authorized previous pair while retaining the current pair", darwin, async () => {
  await installationRoot(async (root) => {
    const first = await stage(root, 9);
    await publishManagedPosixCandidate({ stage: first, attemptId: "e".repeat(32), previous: { executable: null, marker: null } });
    const previousBackup = {
      executable: await fileIdentity(join(root, "harness-mrtool")),
      marker: await fileIdentity(join(root, ".harness-mrtool-install.json")),
    };
    const second = await stage(root, 10);
    await publishManagedPosixCandidate({ stage: second, attemptId: "f".repeat(32), previous: previousBackup });
    const current = {
      executable: await fileIdentity(join(root, "harness-mrtool")),
      marker: await fileIdentity(join(root, ".harness-mrtool-install.json")),
    };
    const previous = {
      executable: await fileIdentity(join(root, "harness-mrtool.previous-" + "f".repeat(32))),
      marker: await fileIdentity(join(root, ".harness-mrtool-install.previous-" + "f".repeat(32))),
    };

    const rollback = await restoreManagedPosixPrevious({
      installationDirectory: root,
      publishedAttemptId: "f".repeat(32),
      rollbackAttemptId: "1".repeat(32),
      current,
      previous,
    });
    assert.deepEqual(rollback.retainedCurrent, current);
    assert.deepEqual(await readFile(join(root, "harness-mrtool")), Buffer.from([0x7f, 0x53, 0x45, 0x41, 9]));
    assert.deepEqual(await readFile(join(root, "harness-mrtool.previous-" + "1".repeat(32))), Buffer.from([0x7f, 0x53, 0x45, 0x41, 10]));
  });
});
