import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { promisify } from "node:util";

import { resolveWindowsPowerShellPath } from "./state-path.ts";

const execFileAsync = promisify(execFile);
const MAX_PROCESS_METADATA_BYTES = 4 * 1024;
const START_KEY = /^[A-Za-z0-9:._-]{1,128}$/u;

export interface ProcessIdentity {
  readonly pid: number;
  readonly startKey: string;
}

export type ProcessIdentityStatus =
  | { readonly state: "alive"; readonly startKey: string }
  | { readonly state: "dead" }
  | { readonly state: "unknown" };

export interface ProcessIdentityProvider {
  current(): Promise<ProcessIdentity>;
  inspect(pid: number): Promise<ProcessIdentityStatus>;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function validStartKey(value: string): string | undefined {
  const key = value.trim();
  return START_KEY.test(key) ? key : undefined;
}

async function inspectWindows(pid: number): Promise<ProcessIdentityStatus> {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `try { $p = [System.Diagnostics.Process]::GetProcessById(${String(pid)}); ` +
      "$ticks = $p.StartTime.ToUniversalTime().Ticks; " +
      "[Console]::Out.Write(('win:' + $ticks.ToString([System.Globalization.CultureInfo]::InvariantCulture))); " +
      "exit 0 } catch [System.ArgumentException] { exit 3 } catch { exit 4 }",
  ].join("; ");
  try {
    const result = await execFileAsync(
      resolveWindowsPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, timeout: 5_000, encoding: "utf8", maxBuffer: 1_024 },
    );
    const startKey = validStartKey(result.stdout);
    return startKey === undefined ? { state: "unknown" } : { state: "alive", startKey };
  } catch (error) {
    const exitCode = (error as Error & { code?: number | string }).code;
    return exitCode === 3 || exitCode === "3" ? { state: "dead" } : { state: "unknown" };
  }
}

async function inspectLinux(pid: number): Promise<ProcessIdentityStatus> {
  let handle;
  try {
    handle = await open(`/proc/${String(pid)}/stat`, "r");
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_PROCESS_METADATA_BYTES) return { state: "unknown" };
    const bytes = Buffer.alloc(MAX_PROCESS_METADATA_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_PROCESS_METADATA_BYTES) return { state: "unknown" };
    const after = await handle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino) return { state: "unknown" };
    const metadata = bytes.subarray(0, offset).toString("utf8");
    const commandEnd = metadata.lastIndexOf(")");
    if (commandEnd < 1) return { state: "unknown" };
    const fields = metadata.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTicks = fields[19];
    const startKey = startTicks === undefined ? undefined : validStartKey(`linux:${startTicks}`);
    return startKey === undefined ? { state: "unknown" } : { state: "alive", startKey };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { state: "dead" } : { state: "unknown" };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function inspectDarwin(pid: number): Promise<ProcessIdentityStatus> {
  try {
    const result = await execFileAsync(
      "/bin/ps",
      ["-o", "lstart=", "-p", String(pid)],
      { timeout: 5_000, encoding: "utf8", maxBuffer: 1_024 },
    );
    const value = result.stdout.trim();
    if (value === "") return { state: "dead" };
    const startKey = validStartKey(`darwin:${Buffer.from(value, "utf8").toString("base64url")}`);
    return startKey === undefined ? { state: "unknown" } : { state: "alive", startKey };
  } catch (error) {
    const exitCode = (error as Error & { code?: number | string }).code;
    return exitCode === 1 || exitCode === "1" ? { state: "dead" } : { state: "unknown" };
  }
}

async function inspectSystemProcess(pid: number): Promise<ProcessIdentityStatus> {
  if (!validPid(pid)) return { state: "unknown" };
  if (process.platform === "win32") return inspectWindows(pid);
  if (process.platform === "linux") return inspectLinux(pid);
  if (process.platform === "darwin") return inspectDarwin(pid);
  return { state: "unknown" };
}

export const systemProcessIdentityProvider: ProcessIdentityProvider = {
  async current() {
    return currentProcessIdentity();
  },
  inspect: inspectSystemProcess,
};

export interface ProcessExitWaitOptions {
  readonly provider?: ProcessIdentityProvider;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

/**
 * Waits for one exact process instance to exit. A PID that is reused by a
 * different process is never treated as the parent becoming alive again.
 * Unknown inspection is fail-closed because a Windows persistence helper must
 * not mutate while the old executable may still be running.
 */
export async function waitForProcessExit(
  expected: ProcessIdentity,
  options: ProcessExitWaitOptions = {},
): Promise<void> {
  if (expected === null || typeof expected !== "object" || !validPid(expected.pid) ||
      validStartKey(expected.startKey) === undefined) {
    throw new Error("process identity unavailable");
  }
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollMs = options.pollMs ?? 50;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000 ||
      !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 10_000) {
    throw new Error("process exit wait bounds are invalid");
  }
  const provider = options.provider ?? systemProcessIdentityProvider;
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolvePromise) => {
    setTimeout(resolvePromise, milliseconds);
  }));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let state: ProcessIdentityStatus;
    try {
      state = await provider.inspect(expected.pid);
    } catch {
      throw new Error("process identity unavailable");
    }
    if (state.state === "dead") return;
    if (state.state === "unknown") throw new Error("process identity unavailable");
    if (state.startKey !== expected.startKey) throw new Error("process identity changed");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("process exit wait timed out");
    await sleep(Math.min(pollMs, remaining));
  }
}

let currentIdentityPromise: Promise<ProcessIdentity> | undefined;

function currentProcessIdentity(): Promise<ProcessIdentity> {
  currentIdentityPromise ??= inspectSystemProcess(process.pid).then((status) => {
    if (status.state !== "alive") throw new Error("Current process instance cannot be identified");
    return { pid: process.pid, startKey: status.startKey };
  });
  return currentIdentityPromise;
}
