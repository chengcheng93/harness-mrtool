import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  createSecureWizardLongFormEditor,
  createNodeWizardTempStore,
  createNodeWizardEditorProcessRunner,
  type WizardEditorProcessRunner,
  type WizardTempFile,
  type WizardTempStore,
} from "../../src/cli/wizard-editor.ts";
import { MAX_INPUT_BYTES } from "../../src/input/load-input.ts";

const tempFile: WizardTempFile = { path: "C:\\private\\request.yaml" };

function tempStoreFixture(options: {
  readonly readError?: Error;
  readonly removeError?: Error;
} = {}): {
  readonly calls: string[];
  readonly store: WizardTempStore;
} {
  const calls: string[] = [];
  return {
    calls,
    store: {
      create: async (initialBytes) => {
        calls.push(`create:${Buffer.from(initialBytes).toString("utf8")}`);
        return tempFile;
      },
      read: async (file) => {
        calls.push(`read:${file.path}`);
        if (options.readError !== undefined) throw options.readError;
        return Buffer.from("edited: true\n", "utf8");
      },
      remove: async (file) => {
        calls.push(`remove:${file.path}`);
        if (options.removeError !== undefined) throw options.removeError;
      },
    },
  };
}

test("secure editor prefers VISUAL and sends only fixed editor args plus the private path", async () => {
  const fixture = tempStoreFixture();
  const invocations: Parameters<WizardEditorProcessRunner["run"]>[0][] = [];
  const runner: WizardEditorProcessRunner = {
    run: async (input) => {
      invocations.push(input);
      return { exitCode: 0 };
    },
  };
  const secret = "opaque-token:must-never-enter-argv";
  const editor = createSecureWizardLongFormEditor({
    environment: {
      VISUAL: '"C:\\Program Files\\Fixture\\visual.exe" --wait',
      EDITOR: "fallback-editor",
    },
    processRunner: runner,
    tempStore: fixture.store,
  });

  const output = await editor.edit({ initialBytes: Buffer.from(`notes: ${secret}\n`, "utf8") });

  assert.equal(Buffer.from(output).toString("utf8"), "edited: true\n");
  assert.deepEqual(invocations, [{
    executable: "C:\\Program Files\\Fixture\\visual.exe",
    args: ["--wait", tempFile.path],
  }]);
  assert.equal(JSON.stringify(invocations).includes(secret), false);
  assert.deepEqual(fixture.calls, [
    `create:notes: ${secret}\n`,
    `read:${tempFile.path}`,
    `remove:${tempFile.path}`,
  ]);
});

test("secure editor falls back to EDITOR and rejects a missing editor before creating a temp file", async () => {
  const fallback = tempStoreFixture();
  const invocations: Parameters<WizardEditorProcessRunner["run"]>[0][] = [];
  const editor = createSecureWizardLongFormEditor({
    environment: { VISUAL: "   ", EDITOR: "fixture-editor" },
    processRunner: {
      run: async (input) => {
        invocations.push(input);
        return { exitCode: 0 };
      },
    },
    tempStore: fallback.store,
  });
  await editor.edit({ initialBytes: Buffer.from("notes: edited\n") });
  assert.deepEqual(invocations, [{ executable: "fixture-editor", args: [tempFile.path] }]);

  const missing = tempStoreFixture();
  const unavailable = createSecureWizardLongFormEditor({
    environment: {},
    processRunner: { run: async () => { throw new Error("must not run"); } },
    tempStore: missing.store,
  });
  await assert.rejects(
    unavailable.edit({ initialBytes: Buffer.from("notes: missing\n") }),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "No interactive editor is configured",
  );
  assert.deepEqual(missing.calls, []);
});

test("secure editor removes the temp file after process, read, and cleanup failures without reflecting secrets", async () => {
  const secret = "Private-Token: editor-failure-secret";
  const processFailure = tempStoreFixture();
  const failedProcessEditor = createSecureWizardLongFormEditor({
    environment: { EDITOR: "fixture-editor" },
    processRunner: { run: async () => { throw new Error(secret); } },
    tempStore: processFailure.store,
  });
  await assert.rejects(
    failedProcessEditor.edit({ initialBytes: Buffer.from("notes: process\n") }),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      !JSON.stringify(error).includes(secret) && !error.message.includes(secret),
  );
  assert.deepEqual(processFailure.calls, [
    "create:notes: process\n",
    `remove:${tempFile.path}`,
  ]);

  const readFailure = tempStoreFixture({ readError: new Error(secret) });
  const failedReadEditor = createSecureWizardLongFormEditor({
    environment: { EDITOR: "fixture-editor" },
    processRunner: { run: async () => ({ exitCode: 0 }) },
    tempStore: readFailure.store,
  });
  await assert.rejects(
    failedReadEditor.edit({ initialBytes: Buffer.from("notes: read\n") }),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      !JSON.stringify(error).includes(secret) && !error.message.includes(secret),
  );
  assert.deepEqual(readFailure.calls, [
    "create:notes: read\n",
    `read:${tempFile.path}`,
    `remove:${tempFile.path}`,
  ]);

  const cleanupFailure = tempStoreFixture({ removeError: new Error(secret) });
  const failedCleanupEditor = createSecureWizardLongFormEditor({
    environment: { EDITOR: "fixture-editor" },
    processRunner: { run: async () => ({ exitCode: 0 }) },
    tempStore: cleanupFailure.store,
  });
  await assert.rejects(
    failedCleanupEditor.edit({ initialBytes: Buffer.from("notes: cleanup\n") }),
    (error: unknown) => isToolError(error, "INPUT_ERROR") &&
      error.message === "Interactive editor temporary file cleanup failed" &&
      !JSON.stringify(error).includes(secret),
  );
  assert.deepEqual(cleanupFailure.calls, [
    "create:notes: cleanup\n",
    `read:${tempFile.path}`,
    `remove:${tempFile.path}`,
  ]);
});

test("node editor process runner always disables shell execution and inherits terminal handles", async () => {
  const calls: unknown[] = [];
  const runner = createNodeWizardEditorProcessRunner({
    spawnProcess: (executable, args, options) => {
      calls.push({ executable, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    },
  });

  assert.deepEqual(await runner.run({
    executable: "fixture-editor",
    args: ["--wait", "C:\\private\\request.yaml"],
  }), { exitCode: 0 });
  assert.deepEqual(calls, [{
    executable: "fixture-editor",
    args: ["--wait", "C:\\private\\request.yaml"],
    options: { shell: false, stdio: "inherit", windowsHide: false },
  }]);
});

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

test("node wizard temp store creates private files, revalidates them, and removes only its exact directory", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-wizard-store-root-"));
  let aclChecks = 0;
  try {
    const store = createNodeWizardTempStore({
      tempRoot: root,
      windowsAclVerifier: { verify: async () => { aclChecks += 1; } },
    });
    const file = await store.create(Buffer.from("notes: initial\n", "utf8"));
    const directory = dirname(file.path);
    const directoryInfo = await lstat(directory);
    const fileInfo = await lstat(file.path);
    assert.equal(directoryInfo.isDirectory(), true);
    assert.equal(fileInfo.isFile(), true);
    if (process.platform === "win32") {
      assert.ok(aclChecks >= 1);
    } else {
      assert.equal(directoryInfo.mode & 0o077, 0);
      assert.equal(fileInfo.mode & 0o077, 0);
      assert.equal(directoryInfo.uid, process.getuid!());
      assert.equal(fileInfo.uid, process.getuid!());
    }

    await writeFile(file.path, "notes: edited\n", { mode: 0o600 });
    assert.equal(Buffer.from(await store.read(file)).toString("utf8"), "notes: edited\n");
    if (process.platform === "win32") assert.ok(aclChecks >= 2);

    await store.remove(file);
    assert.equal(await absent(directory), true);
    assert.equal(await absent(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node wizard temp store rejects oversized editor output before reading it", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-wizard-store-size-"));
  try {
    const store = createNodeWizardTempStore({
      tempRoot: root,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const file = await store.create(Buffer.from("notes: initial\n"));
    await writeFile(file.path, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x61));

    await assert.rejects(
      store.read(file),
      (error: unknown) => isToolError(error, "INPUT_TOO_LARGE"),
    );
    await store.remove(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node wizard temp store rejects a symlink replacement without reading its target", async (t) => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-wizard-store-link-"));
  const outside = resolve(root, "outside-secret.yaml");
  await writeFile(outside, "secret: must-not-be-read\n", { mode: 0o600 });
  const privateRoot = resolve(root, "private");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(privateRoot, { mode: 0o700 }));
  try {
    const store = createNodeWizardTempStore({
      tempRoot: privateRoot,
      windowsAclVerifier: { verify: async () => undefined },
    });
    const file = await store.create(Buffer.from("notes: initial\n"));
    await unlink(file.path);
    try {
      await symlink(outside, file.path, process.platform === "win32" ? "file" : undefined);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        await store.remove(file);
        t.skip("symbolic links require an unavailable Windows privilege");
        return;
      }
      throw error;
    }

    await assert.rejects(
      store.read(file),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
    await store.remove(file);
    assert.equal(await readFile(outside, "utf8"), "secret: must-not-be-read\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node wizard temp store detects content changes between handle validation and final identity check", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-wizard-store-race-"));
  let hookCalls = 0;
  try {
    const store = createNodeWizardTempStore({
      tempRoot: root,
      windowsAclVerifier: { verify: async () => undefined },
      hooks: {
        afterOpenForRead: async ({ path }) => {
          hookCalls += 1;
          await writeFile(path, "notes: changed-after-open\n", { mode: 0o600 });
        },
      },
    });
    const file = await store.create(Buffer.from("notes: initial\n"));

    await assert.rejects(
      store.read(file),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
    assert.equal(hookCalls, 1);
    await store.remove(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("node wizard temp store rechecks private permissions before every read", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "harness-wizard-store-mode-"));
  try {
    if (process.platform === "win32") {
      let checks = 0;
      const store = createNodeWizardTempStore({
        tempRoot: root,
        windowsAclVerifier: {
          verify: async () => {
            checks += 1;
            if (checks > 1) throw new Error("unsafe ACL");
          },
        },
      });
      const file = await store.create(Buffer.from("notes: initial\n"));
      await assert.rejects(
        store.read(file),
        (error: unknown) => isToolError(error, "INPUT_ERROR"),
      );
      await store.remove(file);
      return;
    }

    const store = createNodeWizardTempStore({ tempRoot: root });
    const file = await store.create(Buffer.from("notes: initial\n"));
    await chmod(file.path, 0o644);
    await assert.rejects(
      store.read(file),
      (error: unknown) => isToolError(error, "INPUT_ERROR"),
    );
    await store.remove(file);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
