import assert from "node:assert/strict";
import { copyFile, link, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test, { type TestContext } from "node:test";
// @ts-expect-error Build helpers intentionally have no declaration files.
import { injectCopiedSeaExecutable } from "../../scripts/build-sea.mjs";
// @ts-expect-error Build helpers intentionally have no declaration files.
import { finalizeSeaExecutable } from "../../scripts/sea-verification.mjs";

const blob = Buffer.from("SEA fixture");
const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";

async function fixture(t: TestContext, platform: string, failAt?: string) {
  const directory = await mkdtemp(resolve(await realpath(tmpdir()), "sea injection-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = resolve(directory, "harness-mrtool.exe");
  await writeFile(artifact, "owned executable fixture");
  const events: unknown[] = [];
  return { artifact, events, dependencies: {
    platform,
    runProcess: (command: string, args: string[]) => {
      events.push([command, args]);
      return { status: args[0] === failAt ? null : 0, signal: args[0] === failAt ? "SIGKILL" : null, stderr: "", error: undefined };
    },
    inject: async (path: string, name: string, bytes: Buffer, options: unknown) => {
      events.push(["inject", path, name, bytes, options]);
      if (failAt === "inject") throw new Error("injection failed");
    },
  } };
}

test("Darwin SEA removes signature, injects NODE_SEA, signs the owned copy, then verifies", async (t) => {
  const { artifact, events, dependencies } = await fixture(t, "darwin");
  await finalizeSeaExecutable(artifact, {
    injectBlob: () => injectCopiedSeaExecutable(artifact, blob, dependencies),
    verifyExecutable: async (path: string) => { events.push(["verify", path]); },
    removeArtifact: async () => { assert.fail("valid artifact must not be removed"); },
  });
  assert.deepEqual(events, [
    ["/usr/bin/codesign", ["--remove-signature", artifact]],
    ["inject", artifact, "NODE_SEA_BLOB", blob, { sentinelFuse: fuse, machoSegmentName: "NODE_SEA" }],
    ["/usr/bin/codesign", ["--sign", "-", artifact]],
    ["verify", artifact],
  ]);
});

for (const platform of ["win32", "linux"]) {
  test(`${platform} SEA injection retains existing options without codesign`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, platform);
    await injectCopiedSeaExecutable(artifact, blob, dependencies);
    assert.deepEqual(events, [["inject", artifact, "NODE_SEA_BLOB", blob, { sentinelFuse: fuse }]]);
  });
}

for (const failure of ["--remove-signature", "inject", "--sign"]) {
  test(`Darwin ${failure} failure prevents execution and removes the artifact`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, "darwin", failure);
    await assert.rejects(finalizeSeaExecutable(artifact, {
      injectBlob: () => injectCopiedSeaExecutable(artifact, blob, dependencies),
      verifyExecutable: async () => { assert.fail("failed artifact must not execute"); },
      removeArtifact: async (path: string) => { events.push(["remove", path]); },
    }), failure === "inject" ? /injection failed/ : /SEA codesign/);
    assert.deepEqual(events.at(-1), ["remove", artifact]);
    if (failure === "--remove-signature") assert.equal(events.length, 2);
    if (failure === "inject") assert.equal(events.length, 3);
    if (failure === "--sign") assert.equal(events.length, 4);
  });
}

test("SEA injection refuses the active Node runtime instead of modifying it", async (t) => {
  const { events, dependencies } = await fixture(t, "darwin");
  await assert.rejects(injectCopiedSeaExecutable(process.execPath, blob, dependencies), /copy|runtime/i);
  assert.deepEqual(events, []);
});

test("Darwin codesign spawn errors fail closed before injection", async (t) => {
  const { artifact } = await fixture(t, "darwin");
  const events: unknown[] = [];
  await assert.rejects(finalizeSeaExecutable(artifact, {
    injectBlob: () => injectCopiedSeaExecutable(artifact, blob, {
      platform: "darwin",
      runProcess: () => ({ error: new Error("codesign unavailable"), status: null }),
      inject: async () => { assert.fail("codesign errors must stop injection"); },
    }),
    verifyExecutable: async () => { assert.fail("codesign errors must stop execution"); },
    removeArtifact: async (path: string) => { events.push(path); },
  }), /codesign unavailable/);
  assert.deepEqual(events, [artifact]);
});


for (const platform of ["darwin", "linux", "win32"]) {
  test(`${platform} rejects an active-runtime symlink by identity before any mutation`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, platform);
    const alias = `${artifact}.runtime-link`;
    await symlink(process.execPath, alias, "file");
    const runtime = await stat(process.execPath, { bigint: true });
    const target = await stat(alias, { bigint: true });
    assert.equal(target.dev, runtime.dev);
    assert.equal(target.ino, runtime.ino);
    await assert.rejects(injectCopiedSeaExecutable(alias, blob, dependencies), /copy|runtime/i);
    assert.deepEqual(events, []);
  });

  test(`${platform} refuses an unavailable artifact identity before any mutation`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, platform);
    await assert.rejects(injectCopiedSeaExecutable(`${artifact}.missing`, blob, dependencies), /identity/i);
    assert.deepEqual(events, []);
  });

  test(`${platform} refuses a non-file artifact before any mutation`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, platform);
    await assert.rejects(injectCopiedSeaExecutable(dirname(artifact), blob, dependencies), /identity|regular file/i);
    assert.deepEqual(events, []);
  });
}

test("SEA rejects an active-runtime hard link even when realpaths differ", async (t) => {
  const { artifact, events, dependencies } = await fixture(t, "darwin");
  const alias = `${artifact}.runtime-hardlink`;
  try {
    await link(process.execPath, alias);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    t.skip("runtime and temporary directory are on different filesystems");
    return;
  }
  assert.notEqual(await realpath(alias), await realpath(process.execPath));
  await assert.rejects(injectCopiedSeaExecutable(alias, blob, dependencies), /copy|runtime/i);
  assert.deepEqual(events, []);
});

test("SEA still accepts a real owned copy of the active runtime", async (t) => {
  const { artifact, events, dependencies } = await fixture(t, "darwin");
  await copyFile(process.execPath, artifact);
  const runtime = await stat(process.execPath, { bigint: true });
  const target = await stat(artifact, { bigint: true });
  assert.ok(target.dev !== runtime.dev || target.ino !== runtime.ino);
  // All mutation operations remain mocked, including on this real Node copy.
  await injectCopiedSeaExecutable(artifact, blob, dependencies);
  assert.equal(events.length, 3);
});

for (const unavailablePath of ["runtime", "artifact"]) {
  test(`SEA fails closed when ${unavailablePath} identity lookup fails`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, "darwin");
    await assert.rejects(injectCopiedSeaExecutable(artifact, blob, {
      ...dependencies,
      stat: async (path: string, options: { bigint: true }) => {
        if (path === (unavailablePath === "runtime" ? process.execPath : artifact)) {
          throw new Error("identity lookup unavailable");
        }
        return stat(path, options);
      },
    }), /identity/i);
    assert.deepEqual(events, []);
  });
}

for (const invalidIdentity of [{ dev: 1n, ino: 0n }, { dev: undefined, ino: undefined }]) {
  test(`SEA refuses unavailable inode identity ${String(invalidIdentity.ino)}`, async (t) => {
    const { artifact, events, dependencies } = await fixture(t, "darwin");
    await assert.rejects(injectCopiedSeaExecutable(artifact, blob, {
      ...dependencies,
      stat: async (path: string, options: { bigint: true }) => ({
        ...await stat(path, options), ...invalidIdentity, isFile: () => true,
      }),
    }), /identity/i);
    assert.deepEqual(events, []);
  });
}
