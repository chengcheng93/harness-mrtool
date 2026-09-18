import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { stageManagedPosixCandidate, removeManagedPosixStage, verifyManagedPosixStage } from "../../src/update/managed-installation-posix.ts";

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
