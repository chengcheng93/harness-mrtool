import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { writeAnchoredFile } from "../../src/platform/anchored-file-writer.ts";
import { moveAnchoredFile, type AnchoredMoveFileIdentity } from "../../src/platform/anchored-file-mover.ts";

const darwin = { skip: process.platform !== "darwin" };

async function identity(path: string): Promise<AnchoredMoveFileIdentity> {
  const info = await lstat(path, { bigint: true });
  return Object.freeze({
    dev: info.dev,
    ino: info.ino,
    size: info.size,
    mode: info.mode,
    uid: info.uid,
  });
}

async function fixture<T>(callback: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "harness-mrtool-anchored-move-"));
  try {
    return await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sha(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

test("moves an identity-pinned staged file into an absent canonical slot", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-12345678-1234-4234-8234-123456789abc");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    const bytes = Uint8Array.from([0x7f, 0x53, 0x45, 0x41, 0x01]);
    await writeAnchoredFile({ directory: stage, expectedIdentity: { dev: stageStat.dev, ino: stageStat.ino }, name: "harness-mrtool", bytes });
    const source = await identity(resolve(stage, "harness-mrtool"));

    await moveAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: source,
      destinationName: "harness-mrtool",
      destination: { kind: "absent" },
    });

    assert.deepEqual(await readFile(resolve(root, "harness-mrtool")), Buffer.from(bytes));
    await assert.rejects(lstat(resolve(stage, "harness-mrtool")), { code: "ENOENT" });
    const destination = await identity(resolve(root, "harness-mrtool"));
    assert.deepEqual(destination, source);
    assert.equal(sha(await readFile(resolve(root, "harness-mrtool"))), sha(bytes));
  });
});

test("replaces only the expected canonical identity", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-abcdefab-cdef-4abc-8def-abcdefabcdef");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    const oldBytes = Uint8Array.from([1, 2, 3]);
    const newBytes = Uint8Array.from([4, 5, 6]);
    await writeFile(resolve(root, "harness-mrtool"), oldBytes, { mode: 0o500 });
    const oldIdentity = await identity(resolve(root, "harness-mrtool"));
    await writeAnchoredFile({ directory: stage, expectedIdentity: { dev: stageStat.dev, ino: stageStat.ino }, name: "harness-mrtool", bytes: newBytes });
    const source = await identity(resolve(stage, "harness-mrtool"));
    const backup = "harness-mrtool.previous-abcdefab-cdef-4abc-8def-abcdefabcdef";

    await moveAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: root,
      sourceDirectoryIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: oldIdentity,
      destinationName: backup,
      destination: { kind: "absent" },
    });
    await moveAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: source,
      destinationName: "harness-mrtool",
      destination: { kind: "absent" },
    });

    assert.deepEqual(await readFile(resolve(root, backup)), Buffer.from(oldBytes));
    assert.deepEqual(await readFile(resolve(root, "harness-mrtool")), Buffer.from(newBytes));
  });
});

test("rejects a substituted destination and leaves the sentinel untouched", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-fedcba98-7654-4321-8fed-cba987654321");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "old", { mode: 0o500 });
    const expected = await identity(resolve(root, "harness-mrtool"));
    await writeAnchoredFile({ directory: stage, expectedIdentity: { dev: stageStat.dev, ino: stageStat.ino }, name: "harness-mrtool", bytes: Uint8Array.from([9, 8, 7]) });
    const source = await identity(resolve(stage, "harness-mrtool"));
    await rm(resolve(root, "harness-mrtool"));
    await writeFile(resolve(root, "harness-mrtool"), "sentinel", { mode: 0o500 });

    await assert.rejects(() => moveAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: source,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: expected },
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(resolve(root, "harness-mrtool"), "utf8"), "sentinel");
    assert.deepEqual(await identity(resolve(stage, "harness-mrtool")), source);
  });
});

