import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { writeAnchoredFile } from "../../src/platform/anchored-file-writer.ts";
import { moveAnchoredFile, swapAnchoredFile, type AnchoredMoveFileIdentity } from "../../src/platform/anchored-file-mover.ts";

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



test("atomically swaps the pinned staged and canonical file identities", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-0123456789abcdef0123456789abcdef");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "canonical", { mode: 0o500 });
    const canonical = await identity(resolve(root, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "staged", { mode: 0o500 });
    const staged = await identity(resolve(stage, "harness-mrtool"));

    await swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: staged,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: canonical },
    });

    assert.equal(await readFile(resolve(root, "harness-mrtool"), "utf8"), "staged");
    assert.equal(await readFile(resolve(stage, "harness-mrtool"), "utf8"), "canonical");
    assert.deepEqual(await identity(resolve(root, "harness-mrtool")), staged);
    assert.deepEqual(await identity(resolve(stage, "harness-mrtool")), canonical);
  });
});

test("rejects a substituted destination without moving either file", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-22222222-2222-4222-8222-222222222222");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "expected", { mode: 0o500 });
    const expectedDestination = await identity(resolve(root, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "staged", { mode: 0o500 });
    const source = await identity(resolve(stage, "harness-mrtool"));
    await rm(resolve(root, "harness-mrtool"));
    await writeFile(resolve(root, "harness-mrtool"), "sentinel", { mode: 0o500 });

    await assert.rejects(() => swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: source,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: expectedDestination },
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(resolve(root, "harness-mrtool"), "utf8"), "sentinel");
    assert.deepEqual(await identity(resolve(stage, "harness-mrtool")), source);
  });
});

test("rejects a substituted source without moving the expected destination", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-33333333-3333-4333-8333-333333333333");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "canonical", { mode: 0o500 });
    const destination = await identity(resolve(root, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "expected", { mode: 0o500 });
    const expectedSource = await identity(resolve(stage, "harness-mrtool"));
    await rm(resolve(stage, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "substituted", { mode: 0o500 });

    await assert.rejects(() => swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: expectedSource,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: destination },
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(resolve(root, "harness-mrtool"), "utf8"), "canonical");
    assert.equal(await readFile(resolve(stage, "harness-mrtool"), "utf8"), "substituted");
  });
});

test("rejects symlink and hard-link source or destination entries", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-44444444-4444-4444-8444-444444444444");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "canonical", { mode: 0o500 });
    const canonical = await identity(resolve(root, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "staged", { mode: 0o500 });
    const staged = await identity(resolve(stage, "harness-mrtool"));
    await link(resolve(stage, "harness-mrtool"), resolve(stage, ".harness-mrtool-install.json"));
    await assert.rejects(() => swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: staged,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: canonical },
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(resolve(root, "harness-mrtool"), "utf8"), "canonical");
    assert.equal(await readFile(resolve(stage, "harness-mrtool"), "utf8"), "staged");

    await rm(resolve(stage, ".harness-mrtool-install.json"));
    await rm(resolve(stage, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "staged-again", { mode: 0o500 });
    const stagedAgain = await identity(resolve(stage, "harness-mrtool"));
    const outside = resolve(root, "outside");
    await writeFile(outside, "outside", { mode: 0o500 });
    await rm(resolve(root, "harness-mrtool"));
    await symlink(outside, resolve(root, "harness-mrtool"));
    await assert.rejects(() => swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: stagedAgain,
      destinationName: "harness-mrtool",
      destination: { kind: "identity", identity: canonical },
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.equal(await readFile(outside, "utf8"), "outside");
    assert.equal(await readFile(resolve(stage, "harness-mrtool"), "utf8"), "staged-again");
  });
});

test("requires an identity-pinned destination", darwin, async () => {
  await fixture(async (root) => {
    const stage = resolve(root, ".harness-mrtool-stage-55555555-5555-4555-8555-555555555555");
    await mkdir(stage, { mode: 0o700 });
    const rootStat = await identity(root);
    const stageStat = await identity(stage);
    await writeFile(resolve(root, "harness-mrtool"), "canonical", { mode: 0o500 });
    const canonical = await identity(resolve(root, "harness-mrtool"));
    await writeFile(resolve(stage, "harness-mrtool"), "staged", { mode: 0o500 });
    const staged = await identity(resolve(stage, "harness-mrtool"));

    await assert.rejects(() => swapAnchoredFile({
      rootDirectory: root,
      rootIdentity: { dev: rootStat.dev, ino: rootStat.ino },
      sourceDirectory: stage,
      sourceDirectoryIdentity: { dev: stageStat.dev, ino: stageStat.ino },
      sourceName: "harness-mrtool",
      sourceIdentity: staged,
      destinationName: "harness-mrtool",
      destination: { kind: "absent" } as never,
    }), { code: "UPDATE_SECURITY_ERROR" });
    assert.deepEqual(await identity(resolve(root, "harness-mrtool")), canonical);
    assert.deepEqual(await identity(resolve(stage, "harness-mrtool")), staged);
  });
});
