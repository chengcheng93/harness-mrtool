import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, lstat, open } from "node:fs/promises";

import { resolveWindowsPowerShellPath } from "./state-path.ts";

export interface ProcessLockLease {
  assertHeld(): void;
  release(): Promise<void>;
}

export interface ProcessLockProvider {
  acquire(path: string, timeoutMs: number): Promise<ProcessLockLease>;
}

export class ProcessLockError extends Error {
  constructor(readonly reason: "timeout" | "unsafe" | "unavailable") {
    super(`Process lock ${reason}`);
  }
}

async function prepareLockFile(path: string): Promise<void> {
  try {
    const current = await lstat(path, { bigint: true });
    if (current.isSymbolicLink() || !current.isFile()) throw new ProcessLockError("unsafe");
    if (process.platform !== "win32") await chmod(path, 0o600);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() ||
        opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new ProcessLockError("unsafe");
    }
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return prepareLockFile(path);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function waitForHelper(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<ProcessLockLease> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    let helperExited = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectPromise(new ProcessLockError("timeout"));
    }, timeoutMs + 5_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (output.length > 128) {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        rejectPromise(new ProcessLockError("unavailable"));
        return;
      }
      if (!output.includes("\n")) return;
      if (output.trim() !== "LOCKED") {
        settled = true;
        clearTimeout(timeout);
        child.kill();
        rejectPromise(new ProcessLockError("unavailable"));
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({
        assertHeld() {
          if (helperExited || child.exitCode !== null) throw new ProcessLockError("unavailable");
        },
        async release() {
          if (helperExited || child.exitCode !== null) return;
          child.stdin.end("release\n");
          await new Promise<void>((resolveExit) => {
            const releaseTimeout = setTimeout(() => {
              child.kill();
              resolveExit();
            }, 1_000);
            child.once("exit", () => {
              clearTimeout(releaseTimeout);
              resolveExit();
            });
          });
        },
      });
    });
    child.once("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new ProcessLockError("unavailable"));
    });
    child.once("exit", (code) => {
      helperExited = true;
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rejectPromise(new ProcessLockError(code === 24 ? "timeout" : "unavailable"));
    });
  });
}

async function acquireWindows(path: string, timeoutMs: number): Promise<ProcessLockLease> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$lockPath = $env:HMRTOOL_PROCESS_LOCK_PATH",
    `$timeoutMs = ${String(timeoutMs)}`,
    "$watch = [System.Diagnostics.Stopwatch]::StartNew()",
    "$stream = $null",
    "while ($null -eq $stream) { try { $stream = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') } " +
      "catch { if ($watch.ElapsedMilliseconds -ge $timeoutMs) { exit 24 }; Start-Sleep -Milliseconds 5 } }",
    "[Console]::Out.WriteLine('LOCKED')",
    "[Console]::Out.Flush()",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const child = spawn(
    resolveWindowsPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HMRTOOL_PROCESS_LOCK_PATH: path },
    },
  );
  return waitForHelper(child, timeoutMs);
}

async function acquireLinux(path: string, timeoutMs: number): Promise<ProcessLockLease> {
  const child = spawn(
    "/usr/bin/flock",
    ["-x", "-E", "24", "-w", String(timeoutMs / 1_000), path, "/bin/sh", "-c", "printf 'LOCKED\\n'; read _"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return waitForHelper(child, timeoutMs);
}

export const systemProcessLockProvider: ProcessLockProvider = {
  async acquire(path, timeoutMs) {
    await prepareLockFile(path);
    if (process.platform === "win32") return acquireWindows(path, timeoutMs);
    if (process.platform === "linux") return acquireLinux(path, timeoutMs);
    throw new ProcessLockError("unavailable");
  },
};
