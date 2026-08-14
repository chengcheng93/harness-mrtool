import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  type ArchiveEntry,
  validateArchiveEntries,
  validateExtractedArchive,
} from "../../src/update/download.ts";

test("archive metadata rejects empty and Windows-ambiguous path sets", () => {
  assert.throws(() => validateArchiveEntries([]), /archive/u);

  for (const name of [
    "payload/data:fork",
    "payload/trailing.",
    "payload/trailing ",
    "CON",
    "prn.txt",
    "AUX.log",
    "nul.bin",
    "COM1.exe",
    "com9",
    "LPT1.txt",
    "lpt9",
  ]) {
    assert.throws(
      () => validateArchiveEntries([{ name, kind: "file" }]),
      /archive/u,
      name,
    );
  }
});

test("archive metadata rejects accessors and symbol-keyed fields", () => {
  const accessor = Object.defineProperties({}, {
    name: { enumerable: true, get: () => "payload/file" },
    kind: { enumerable: true, value: "file" },
  });
  const symbolKeyed = {
    name: "payload/file",
    kind: "file",
    [Symbol("hidden")]: true,
  };

  assert.throws(
    () => validateArchiveEntries([accessor as ArchiveEntry]),
    /malformed/u,
  );
  assert.throws(
    () => validateArchiveEntries([symbolKeyed as ArchiveEntry]),
    /malformed/u,
  );
});

test("post-extraction validation accepts only the exact regular tree", async (t) => {
  const created = await mkdtemp(resolve(tmpdir(), "harness-mrtool-archive-"));
  t.after(async () => rm(created, { recursive: true, force: true }));
  const root = await realpath(created);
  await mkdir(resolve(root, "payload"));
  await writeFile(resolve(root, "payload", "cli.exe"), "verified");
  const entries = [
    { name: "payload/", kind: "directory" },
    { name: "payload/cli.exe", kind: "file" },
  ] as const;

  await validateExtractedArchive(root, entries);
  await writeFile(resolve(root, "payload", "unexpected.txt"), "unexpected");
  await assert.rejects(validateExtractedArchive(root, entries), /archive/u);
});

test("post-extraction validation rejects a directory link that escapes the root", async (t) => {
  const created = await mkdtemp(resolve(tmpdir(), "harness-mrtool-archive-"));
  const outside = await mkdtemp(resolve(tmpdir(), "harness-mrtool-outside-"));
  t.after(async () => Promise.all([
    rm(created, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]).then(() => undefined));
  const root = await realpath(created);
  const link = resolve(root, "payload");
  try {
    await symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") {
      t.skip("creating a directory link is not permitted on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    validateExtractedArchive(root, [{ name: "payload/", kind: "directory" }]),
    /archive/u,
  );
});
