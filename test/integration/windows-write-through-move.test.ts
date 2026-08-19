import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createWindowsWriteThroughMover,
  systemWindowsWriteThroughMover,
  WindowsWriteThroughMoveError,
  type WindowsMoveChild,
  type WindowsMoveSpawnOptions,
} from "../../src/platform/windows-write-through-move.ts";

class FakeChild extends EventEmitter implements WindowsMoveChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  closeObserved = false;

  kill(): boolean {
    this.killed = true;
    this.stdout.end();
    this.stderr.end();
    queueMicrotask(() => {
      this.closeObserved = true;
      this.emit("close", null, "SIGKILL");
    });
    return true;
  }
}

class ControlledChild extends EventEmitter implements WindowsMoveChild {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killCalls = 0;
  closeObserved = false;

  constructor(private readonly killBehavior: "false" | "throw") {
    super();
  }

  kill(): boolean {
    this.killCalls += 1;
    if (this.killBehavior === "throw") throw new Error("kill failed");
    return false;
  }

  close(): void {
    this.stdout.end();
    this.stderr.end();
    this.closeObserved = true;
    this.emit("close", null, "SIGKILL");
  }
}

test("defers Windows executable resolution until a move is requested", () => {
  assert.doesNotThrow(() => createWindowsWriteThroughMover({ environment: {} }));
});

test("uses a scrubbed environment and never reflects helper output or receipt paths", async () => {
  const child = new FakeChild();
  let captured: WindowsMoveSpawnOptions | undefined;
  const sourcePath = resolve(tmpdir(), "Private-Token=persisted-secret-value", "source.json");
  const destinationPath = resolve(tmpdir(), "Private-Token=persisted-secret-value", "final.json");
  const mover = createWindowsWriteThroughMover({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    environment: {
      SystemRoot: "C:\\Windows",
      WINDIR: "C:\\Windows",
      TEMP: "C:\\Temp",
      TMP: "C:\\Temp",
      GITLAB_TOKEN: "persisted-secret-value",
      PATH: "persisted-secret-value",
    },
    spawnChild(_executable, _arguments, options) {
      captured = options;
      queueMicrotask(() => {
        child.stderr.end(`persisted-secret-value ${sourcePath}`);
        child.stdout.end("ERR:5\n");
        child.emit("close", 25, null);
      });
      return child;
    },
  });

  let caught: unknown;
  try {
    await mover.moveNoReplace(sourcePath, destinationPath);
  } catch (error) {
    caught = error;
  }

  assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
  assert.equal((caught as WindowsWriteThroughMoveError).reason, "unavailable");
  assert.equal(`${String(caught)}${JSON.stringify(caught)}`.includes("persisted-secret-value"), false);
  assert.deepEqual(Object.keys(captured?.env ?? {}).sort(), [
    "HMRTOOL_MOVE_DESTINATION",
    "HMRTOOL_MOVE_SOURCE",
    "SystemRoot",
    "TEMP",
    "TMP",
    "WINDIR",
  ]);
  assert.equal(captured?.env.GITLAB_TOKEN, undefined);
  assert.equal(captured?.env.PATH, undefined);
  assert.equal(captured?.env.HMRTOOL_MOVE_SOURCE, sourcePath);
  assert.equal(captured?.env.HMRTOOL_MOVE_DESTINATION, destinationPath);
  assert.equal(captured?.windowsHide, true);
});

test("kills an unresponsive helper, waits for close, and returns a generic timeout", async () => {
  const child = new FakeChild();
  const mover = createWindowsWriteThroughMover({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    timeoutMs: 20,
    spawnChild() {
      return child;
    },
  });

  let caught: unknown;
  try {
    await mover.moveNoReplace(
      resolve(tmpdir(), "write-through-source.json"),
      resolve(tmpdir(), "write-through-final.json"),
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(child.killed, true);
  assert.equal(child.closeObserved, true);
  assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
  assert.equal((caught as WindowsWriteThroughMoveError).reason, "timeout");
});

test("kill failure never settles a timed-out helper before its delayed close", async (t) => {
  for (const behavior of ["false", "throw"] as const) {
    await t.test(`kill ${behavior}`, async () => {
      const child = new ControlledChild(behavior);
      const mover = createWindowsWriteThroughMover({
        executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        timeoutMs: 10,
        spawnChild: () => child,
      });
      let settled = false;
      let caught: unknown;
      const move = mover.moveNoReplace(
        resolve(tmpdir(), `kill-${behavior}-source.json`),
        resolve(tmpdir(), `kill-${behavior}-final.json`),
      ).then(
        () => { settled = true; },
        (error: unknown) => { settled = true; caught = error; },
      );

      await delay(30);
      const settledBeforeClose = settled;
      child.close();
      await move;

      assert.equal(child.killCalls, 1);
      assert.equal(settledBeforeClose, false);
      assert.equal(child.closeObserved, true);
      assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
      assert.equal((caught as WindowsWriteThroughMoveError).reason, "timeout");
    });
  }
});

test("a child error after timeout cannot settle or replace the first failure before close", async () => {
  const child = new ControlledChild("false");
  const mover = createWindowsWriteThroughMover({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    timeoutMs: 10,
    spawnChild: () => child,
  });
  let settled = false;
  let caught: unknown;
  const move = mover.moveNoReplace(
    resolve(tmpdir(), "child-error-source.json"),
    resolve(tmpdir(), "child-error-final.json"),
  ).then(
    () => { settled = true; },
    (error: unknown) => { settled = true; caught = error; },
  );

  await delay(30);
  child.emit("error", new Error("spawn error after timeout"));
  await delay(0);
  const settledBeforeClose = settled;
  child.close();
  await move;

  assert.equal(child.killCalls, 1);
  assert.equal(settledBeforeClose, false);
  assert.equal(child.closeObserved, true);
  assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
  assert.equal((caught as WindowsWriteThroughMoveError).reason, "timeout");
});

test("stdout and stderr errors request termination and wait for child close", async (t) => {
  for (const streamName of ["stdout", "stderr"] as const) {
    await t.test(streamName, async () => {
      const child = new ControlledChild("false");
      child[streamName].once("error", () => undefined);
      const mover = createWindowsWriteThroughMover({
        executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        timeoutMs: 1_000,
        spawnChild: () => child,
      });
      let settled = false;
      let caught: unknown;
      const move = mover.moveNoReplace(
        resolve(tmpdir(), `${streamName}-error-source.json`),
        resolve(tmpdir(), `${streamName}-error-final.json`),
      ).then(
        () => { settled = true; },
        (error: unknown) => { settled = true; caught = error; },
      );

      child[streamName].emit("error", new Error(`${streamName} failed`));
      await delay(0);
      const settledBeforeClose = settled;
      const killCallsBeforeClose = child.killCalls;
      child.close();
      await move;

      assert.equal(killCallsBeforeClose, 1);
      assert.equal(settledBeforeClose, false);
      assert.equal(child.closeObserved, true);
      assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
      assert.equal((caught as WindowsWriteThroughMoveError).reason, "unavailable");
    });
  }
});

test("terminates a helper whose stdout or stderr exceeds the fixed bound", async () => {
  const child = new FakeChild();
  const mover = createWindowsWriteThroughMover({
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    spawnChild() {
      queueMicrotask(() => child.stdout.write("x".repeat(2_048)));
      return child;
    },
  });

  let caught: unknown;
  try {
    await mover.moveNoReplace(
      resolve(tmpdir(), "bounded-source.json"),
      resolve(tmpdir(), "bounded-final.json"),
    );
  } catch (error) {
    caught = error;
  }

  assert.equal(child.killed, true);
  assert.equal(child.closeObserved, true);
  assert.equal(caught instanceof WindowsWriteThroughMoveError, true);
  assert.equal((caught as WindowsWriteThroughMoveError).reason, "unavailable");
});

test("MoveFileExW publishes once with write-through and never replaces an existing destination", async (t) => {
  if (process.platform !== "win32") {
    t.skip("MoveFileExW contract requires Windows");
    return;
  }
  const stateDirectory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-write-through-"));
  t.after(async () => rm(stateDirectory, { recursive: true, force: true }));
  const receiptDirectory = resolve(stateDirectory, "quote ' and spaces");
  await mkdir(receiptDirectory);
  const sourcePath = resolve(receiptDirectory, "pending.json");
  const finalPath = resolve(receiptDirectory, "final.json");
  const bytes = "complete and file-synced receipt\n";
  await writeFile(sourcePath, bytes, { encoding: "utf8", flush: true });

  await systemWindowsWriteThroughMover.moveNoReplace(sourcePath, finalPath);

  assert.equal(await readFile(finalPath, "utf8"), bytes);
  await assert.rejects(readFile(sourcePath), (error: unknown) =>
    typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT");

  const secondSource = resolve(receiptDirectory, "second-pending.json");
  await writeFile(secondSource, "must remain pending\n", { encoding: "utf8", flush: true });
  await assert.rejects(
    systemWindowsWriteThroughMover.moveNoReplace(secondSource, finalPath),
    (error: unknown) => error instanceof WindowsWriteThroughMoveError && error.reason === "exists",
  );
  assert.equal(await readFile(finalPath, "utf8"), bytes);
  assert.equal(await readFile(secondSource, "utf8"), "must remain pending\n");
});
