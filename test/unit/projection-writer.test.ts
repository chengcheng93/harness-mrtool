import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { writeProjectTemplate } from "../../src/cli/projection-writer.ts";

async function fixture(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), "harness-mrtool-projection-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function temporaryEntries(directory: string): Promise<string[]> {
  return (await import("node:fs/promises")).readdir(directory).then((entries) =>
    entries.filter((entry) => entry.includes(".harness-mrtool-")));
}

test("publishes exact UTF-8 bytes without leaving a temporary file", async (context) => {
  const root = await fixture(context);
  const destination = resolve(root, "templates", "Docs.md");
  await mkdir(dirname(destination), { recursive: true });
  const contents = "## Documentation\n\n- UTF-8: 测试\n";

  await writeProjectTemplate(destination, contents);

  assert.equal(await readFile(destination, "utf8"), contents);
  assert.deepEqual(await temporaryEntries(dirname(destination)), []);
  const metadata = await lstat(destination);
  assert.equal(metadata.isFile(), true);
  assert.equal(metadata.isSymbolicLink(), false);
});

test("never overwrites an existing destination", async (context) => {
  const root = await fixture(context);
  const destination = resolve(root, "Default.md");
  await writeFile(destination, "user-owned\n", "utf8");

  await assert.rejects(
    writeProjectTemplate(destination, "generated\n"),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  assert.equal(await readFile(destination, "utf8"), "user-owned\n");
  assert.deepEqual(await temporaryEntries(root), []);
});

test("rejects an absent parent and unsafe destination scalars", async (context) => {
  const root = await fixture(context);
  for (const destination of [
    "",
    " Default.md",
    `Default.md\u0000`,
    resolve(root, "missing", "Default.md"),
  ]) {
    await assert.rejects(
      writeProjectTemplate(destination, "generated\n"),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
  }
});

test("rejects a parent directory reached through a symlink or junction", async (context) => {
  const root = await fixture(context);
  const actual = resolve(root, "actual");
  const linked = resolve(root, "linked");
  await mkdir(actual);
  try {
    await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    context.skip(`link creation is unavailable: ${String(error)}`);
    return;
  }

  await assert.rejects(
    writeProjectTemplate(resolve(linked, "Default.md"), "generated\n"),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  await assert.rejects(lstat(resolve(actual, "Default.md")));
});

test("cleans the temporary file when publication loses an existing-target race", async (context) => {
  const root = await fixture(context);
  const destination = resolve(root, "Default.md");
  let linked = false;

  await assert.rejects(
    writeProjectTemplate(destination, "generated\n", {
      beforePublish: async () => {
        await writeFile(destination, "racer\n", "utf8");
        linked = true;
      },
    }),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
  assert.equal(linked, true);
  assert.equal(await readFile(destination, "utf8"), "racer\n");
  assert.deepEqual(await temporaryEntries(root), []);
});
