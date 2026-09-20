import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";


import { resolveWindowsPowerShellPath } from "./state-path.ts";


export interface ProcessLockLease {
  assertHeld(): void;
  release(): Promise<void>;
}


export interface ProcessLockProvider {
  // timeoutMs is the contention budget: Windows starts it at READY; POSIX
  // includes helper startup. Windows separately allows min(10_000, timeoutMs +
  // 1_000) ms for PowerShell/Add-Type startup. Failed acquisition additionally
  // waits up to 1_000 ms for helper close, reporting unavailable if not reaped.
  acquire(path: string, timeoutMs: number): Promise<ProcessLockLease>;
}


export class ProcessLockError extends Error {
  constructor(
    readonly reason: "timeout" | "unsafe" | "unavailable",
    readonly diagnostic?: `windows-lock-helper:${string}`,
  ) {
    super(`Process lock ${reason}`);
  }
}


interface LockFileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}


const NOFOLLOW = process.platform === "win32" ? 0 : ((constants as { readonly O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
const DIRECTORY = (constants as { readonly O_DIRECTORY?: number }).O_DIRECTORY ?? 0;


function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}


async function lockFileIdentity(path: string): Promise<LockFileIdentity> {
  let item: Awaited<ReturnType<typeof lstat>>;
  let physical: string;
  try {
    item = await lstat(path, { bigint: true });
    physical = await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new ProcessLockError("unsafe");
  }
  if (!item.isFile() || item.isSymbolicLink() ||
      (process.platform !== "win32" && !samePath(physical, path))) {
    throw new ProcessLockError("unsafe");
  }
  return { dev: item.dev, ino: item.ino };
}


async function prepareLockFile(path: string): Promise<LockFileIdentity> {
  try {
    const identity = await lockFileIdentity(path);
    if (process.platform !== "win32") await chmod(path, 0o600);
    return identity;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    const opened = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    if (!opened.isFile() || current.isSymbolicLink() || !current.isFile() ||
        opened.dev !== current.dev || opened.ino !== current.ino) {
      throw new ProcessLockError("unsafe");
    }
    if (process.platform !== "win32") await chmod(path, 0o600);
    return { dev: opened.dev, ino: opened.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return prepareLockFile(path);
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}


interface LockDirectoryIdentity {
  readonly path: string;
  readonly dev: bigint;
  readonly ino: bigint;
}


async function lockDirectoryIdentity(path: string): Promise<LockDirectoryIdentity> {
  const directory = dirname(resolve(path));
  try {
    const item = await lstat(directory, { bigint: true });
    const physical = await realpath(directory);
    if (!item.isDirectory() || item.isSymbolicLink() || !samePath(physical, directory)) {
      throw new ProcessLockError("unsafe");
    }
    return { path: directory, dev: item.dev, ino: item.ino };
  } catch (error) {
    if (error instanceof ProcessLockError) throw error;
    throw new ProcessLockError("unsafe");
  }
}


async function assertLockDirectoryIdentity(expected: LockDirectoryIdentity): Promise<void> {
  try {
    const item = await lstat(expected.path, { bigint: true });
    const physical = await realpath(expected.path);
    if (!item.isDirectory() || item.isSymbolicLink() || !samePath(physical, expected.path) ||
        item.dev !== expected.dev || item.ino !== expected.ino) {
      throw new ProcessLockError("unsafe");
    }
  } catch (error) {
    if (error instanceof ProcessLockError) throw error;
    throw new ProcessLockError("unsafe");
  }
}


async function assertLockIdentity(path: string, expected: LockFileIdentity): Promise<void> {
  const actual = await lockFileIdentity(path);
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) {
    throw new ProcessLockError("unsafe");
  }
}


const HELPER_REAP_TIMEOUT_MS = 1_000;
const RELEASE_CLOSE_TIMEOUT_MS = 2_000;
const RELEASE_KILL_DELAY_MS = 1_000;


function waitForHelper(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  startupTimeoutMs = timeoutMs,
  expectsReady = false,
): Promise<ProcessLockLease> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    let helperExited = false;
    let helperClosed = false;
    let ready = !expectsReady;
    let releasing: Promise<void> | undefined;
    let timeout: NodeJS.Timeout | undefined;
    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolveClosePromise) => {
      resolveClose = resolveClosePromise;
    });

    const waitForClose = (waitMs: number): Promise<boolean> => {
      if (helperClosed) return Promise.resolve(true);
      return new Promise((resolveCloseWait) => {
        const closeTimeout = setTimeout(() => resolveCloseWait(false), waitMs);
        void closePromise.then(() => {
          clearTimeout(closeTimeout);
          resolveCloseWait(true);
        });
      });
    };

    const terminateHelper = (): void => {
      if (helperClosed) return;
      try {
        child.kill("SIGKILL");
      } catch {
        try { child.kill(); } catch { /* The close timeout reports unreaped helpers. */ }
      }
    };

    const fail = (
      reason: ProcessLockError["reason"],
      terminate = true,
      diagnostic?: ProcessLockError["diagnostic"],
    ): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      if (terminate) terminateHelper();
      void waitForClose(HELPER_REAP_TIMEOUT_MS).then((closed) => {
        rejectPromise(new ProcessLockError(closed ? reason : "unavailable", diagnostic));
      });
    };

    timeout = setTimeout(() => fail("timeout"), ready ? timeoutMs : startupTimeoutMs);
    child.once("close", () => {
      helperClosed = true;
      helperExited = true;
      resolveClose();
      if (!settled) fail("unavailable", false);
    });
    // The helper can exit between the liveness check and a release write.
    // A closed pipe must not become an unhandled EPIPE in the owner process.
    child.stdin.on("error", () => {
      if (!settled) fail("unavailable");
      else if (!helperClosed) terminateHelper();
    });
    child.stdout.setEncoding("utf8");
    child.stderr.resume();
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      output += chunk;
      if (output.length > 128) {
        fail("unavailable");
        return;
      }
      for (;;) {
        const newline = output.indexOf("\n");
        if (newline < 0) return;
        const line = output.slice(0, newline).replace(/\r$/u, "");
        output = output.slice(newline + 1);
        if (!ready) {
          if (line !== "READY") {
            const diagnostic = /^ERR:[a-z-]{1,32}$/u.test(line)
              ? `windows-lock-helper:${line.slice(4)}` as const
              : undefined;
            fail("unavailable", true, diagnostic);
            return;
          }
          ready = true;
          if (timeout !== undefined) clearTimeout(timeout);
          timeout = setTimeout(() => fail("timeout"), timeoutMs);
          continue;
        }
        if (line !== "LOCKED") {
          const diagnostic = /^ERR:[a-z-]{1,32}$/u.test(line)
            ? `windows-lock-helper:${line.slice(4)}` as const
            : undefined;
          fail("unavailable", true, diagnostic);
          return;
        }
        settled = true;
        if (timeout !== undefined) clearTimeout(timeout);
        resolvePromise(Object.freeze({
          assertHeld() {
            if (releasing !== undefined || helperExited || helperClosed || child.exitCode !== null || child.signalCode !== null) {
              throw new ProcessLockError("unavailable");
            }
          },
          async release() {
            if (releasing !== undefined) return releasing;
            releasing = (async () => {
              if (helperClosed) return;
              const active = !helperExited && child.exitCode === null && child.signalCode === null;
              const releaseKillTimeout = active
                ? setTimeout(terminateHelper, RELEASE_KILL_DELAY_MS)
                : undefined;
              if (active) {
                try {
                  child.stdin.end("release\n");
                } catch {
                  terminateHelper();
                }
              }
              const closed = await waitForClose(RELEASE_CLOSE_TIMEOUT_MS);
              if (releaseKillTimeout !== undefined) clearTimeout(releaseKillTimeout);
              if (!closed) {
                terminateHelper();
                throw new ProcessLockError("unavailable");
              }
            })();
            return releasing;
          },
        }));
        return;
      }
    });
    child.once("error", () => fail("unavailable"));
    child.once("exit", (code) => {
      helperExited = true;
      if (!settled) fail(code === 24 ? "timeout" : code === 25 ? "unsafe" : "unavailable");
    });
  });
}


// PowerShell/Add-Type gets a separate bounded startup budget. READY starts
// the full caller contention budget exactly once; partial/duplicate frames
// cannot renew either budget. Neither budget includes the bounded reap wait.
const WINDOWS_HELPER_STARTUP_GRACE_MS = 1_000;
const WINDOWS_HELPER_STARTUP_MAX_MS = 10_000;

const WINDOWS_LOCK_HELPER = String.raw`
$ErrorActionPreference='Stop'
$stage='compile'
try {
Add-Type -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
public static class ProcessLockNative {
 [StructLayout(LayoutKind.Sequential)] struct Info {
  public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
  public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
 }
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 static extern IntPtr CreateFileW(string path,uint access,uint share,IntPtr security,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool GetFileInformationByHandle(IntPtr handle,out Info info);
 [DllImport("kernel32.dll", SetLastError=true)]
 static extern bool CloseHandle(IntPtr handle);
 static readonly IntPtr InvalidHandle=new IntPtr(-1);
 static IntPtr held=IntPtr.Zero;
 public static int Acquire(string path,string expectedDevText,string expectedInoText,string timeoutText) {
  uint expectedVolume; ulong expectedIno; long timeoutMs;
  if(!UInt32.TryParse(expectedDevText,out expectedVolume) || !UInt64.TryParse(expectedInoText,out expectedIno) || !Int64.TryParse(timeoutText,out timeoutMs) || timeoutMs<1) return 2;
  var watch=Stopwatch.StartNew();
  while (watch.ElapsedMilliseconds < timeoutMs) {
   var candidate=CreateFileW(path,0xC0000000,0,IntPtr.Zero,4,0x02200000,IntPtr.Zero);
   if (candidate==IntPtr.Zero || candidate==InvalidHandle) { Thread.Sleep(5); continue; }
   try {
    Info info; if(!GetFileInformationByHandle(candidate,out info)) { CloseHandle(candidate); return 1; }
    ulong index=((ulong)info.IndexHigh<<32)|info.IndexLow;
    if((info.Attributes&(0x10|0x400))!=0 || info.Links!=1 || info.Volume!=expectedVolume || index!=expectedIno) { CloseHandle(candidate); return 25; }
    held=candidate; return 0;
   } catch { CloseHandle(candidate); return 2; }
  }
  return 24;
 }
 public static void Release() { if(held!=IntPtr.Zero && held!=InvalidHandle) CloseHandle(held); held=IntPtr.Zero; }
}
'@ | Out-Null
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
$stage='acquire'
$code=[ProcessLockNative]::Acquire($env:HMRTOOL_PROCESS_LOCK_PATH,$env:HMRTOOL_PROCESS_LOCK_DEV,$env:HMRTOOL_PROCESS_LOCK_INO,$env:HMRTOOL_PROCESS_LOCK_TIMEOUT)
if($code -eq 1) { [Console]::Out.WriteLine('ERR:info'); exit 26 }
if($code -eq 2) { [Console]::Out.WriteLine('ERR:exception'); exit 26 }
if($code -ne 0) { exit $code }
$stage='ready'
[Console]::Out.WriteLine('LOCKED')
[Console]::Out.Flush()
[Console]::In.ReadLine() | Out-Null
$stage='release'
[ProcessLockNative]::Release()
exit 0
} catch { try { [Console]::Out.WriteLine('ERR:'+ $stage) } catch {}; exit 26 }
`

async function acquireWindows(path: string, timeoutMs: number, expected: LockFileIdentity): Promise<ProcessLockLease> {
  if (expected.dev < 0n || expected.dev > 0xffffffffn) throw new ProcessLockError("unsafe");
  const child = spawn(
    resolveWindowsPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_LOCK_HELPER, "utf16le").toString("base64")],
    {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HMRTOOL_PROCESS_LOCK_PATH: path,
        HMRTOOL_PROCESS_LOCK_DEV: expected.dev.toString(),
        HMRTOOL_PROCESS_LOCK_INO: expected.ino.toString(),
        HMRTOOL_PROCESS_LOCK_TIMEOUT: String(timeoutMs),
      },
    },
  );
  const startupTimeoutMs = Math.min(WINDOWS_HELPER_STARTUP_MAX_MS, timeoutMs + WINDOWS_HELPER_STARTUP_GRACE_MS);
  return waitForHelper(child, timeoutMs, startupTimeoutMs, true);
}


async function acquireLinux(path: string, timeoutMs: number): Promise<ProcessLockLease> {
  const child = spawn(
    "/usr/bin/flock",
    ["-x", "-E", "24", "-w", String(timeoutMs / 1_000), path, "/bin/sh", "-c", "printf 'LOCKED\\n'; read _"],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  return waitForHelper(child, timeoutMs);
}


// macOS ships /usr/bin/perl with Fcntl and native flock support. Do not use
// shlock: it uses PID files and stale-file unlinking, not an OS advisory lock.
async function acquireDarwin(
  path: string,
  timeoutMs: number,
  expected: LockFileIdentity,
  expectedDirectory: LockDirectoryIdentity,
): Promise<ProcessLockLease> {
  const executable = "/usr/bin/perl";
  try {
    const runtime = await lstat(executable);
    if (!runtime.isFile() || runtime.isSymbolicLink() || runtime.uid !== 0 ||
        (runtime.mode & 0o022) !== 0 || await realpath(executable) !== executable) {
      throw new ProcessLockError("unavailable");
    }
  } catch {
    throw new ProcessLockError("unavailable");
  }

  // Pass checked open file descriptions, never pathnames, for both the marker
  // and its parent directory. Every cooperating Darwin lock user takes the
  // directory fence first, so marker unlink/recreate cannot split the lock.
  let handle;
  let directoryHandle;
  let lease: ProcessLockLease;
  try {
    directoryHandle = await open(
      expectedDirectory.path,
      constants.O_RDONLY | constants.O_NONBLOCK | DIRECTORY | NOFOLLOW,
    );
    const openedDirectory = await directoryHandle.stat({ bigint: true });
    if (!openedDirectory.isDirectory() || openedDirectory.isSymbolicLink() ||
        openedDirectory.dev !== expectedDirectory.dev || openedDirectory.ino !== expectedDirectory.ino) {
      throw new ProcessLockError("unsafe");
    }
    handle = await open(path, constants.O_RDWR | constants.O_NONBLOCK | NOFOLLOW);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new ProcessLockError("unsafe");
    }
    await assertLockDirectoryIdentity(expectedDirectory);
    await assertLockIdentity(path, expected);
    const script = [
      "use strict; use warnings; use Config; use Fcntl qw(:flock); use Errno qw(EWOULDBLOCK EINTR)",
      '$Config{d_flock} eq "define" or die "native flock unavailable"',
      'open(my $root, "+<&=3") or die "root descriptor unavailable"',
      'open(my $lock, "+<&=4") or die "lock descriptor unavailable"',
      'my @root_identity = stat($root)',
      '@root_identity && -d $root && "$root_identity[0]" eq $ARGV[0] && "$root_identity[1]" eq $ARGV[1] or die "root identity mismatch"',
      'my @lock_identity = stat($lock)',
      '@lock_identity && -f $lock && "$lock_identity[0]" eq $ARGV[2] && "$lock_identity[1]" eq $ARGV[3] or die "lock identity mismatch"',
      // A blocking flock would orphan a waiter if Node died before acquisition.
      // Poll stdin alongside LOCK_NB so EOF cancels waiting at either fence.
      'sub wait_for_lock { my ($item) = @_; while (!flock($item, LOCK_EX | LOCK_NB)) { ' +
        '$! == EWOULDBLOCK || $! == EINTR or die "flock failed"; ' +
        'my $readers = ""; vec($readers, fileno(STDIN), 1) = 1; ' +
        'my $ready = select($readers, undef, undef, 0.01); ' +
        'defined($ready) or die "owner pipe failed"; exit 0 if $ready > 0 } }',
      'wait_for_lock($root)',
      'wait_for_lock($lock)',
      '$| = 1; print "LOCKED\\n" or die "readiness failed"',
      // EOF when the owner exits (including SIGKILL) releases both advisory locks.
      'scalar <STDIN>',
      'close($lock) or die "lock close failed"',
      'close($root) or die "root close failed"',
    ].join("; ");
    const child = spawn(executable, ["-T", "-e", script,
      String(expectedDirectory.dev), String(expectedDirectory.ino),
      String(expected.dev), String(expected.ino)], {
      stdio: ["pipe", "pipe", "pipe", directoryHandle.fd, handle.fd],
      env: { PATH: "/usr/bin:/bin" },
    }) as ChildProcessWithoutNullStreams;
    let childClosed = false;
    child.once("close", () => { childClosed = true; });
    const pending = waitForHelper(child, timeoutMs);
    const closing = Promise.all([directoryHandle.close(), handle.close()]);
    directoryHandle = undefined;
    handle = undefined;
    try {
      [lease] = await Promise.all([pending, closing]);
    } catch (error) {
      if (!childClosed) child.kill("SIGKILL");
      throw error;
    }
  } catch (error) {
    if (error instanceof ProcessLockError) throw error;
    throw new ProcessLockError("unsafe");
  } finally {
    await handle?.close().catch(() => undefined);
    await directoryHandle?.close().catch(() => undefined);
  }
  return Object.freeze({
    assertHeld() {
      lease.assertHeld();
      try {
        const currentDirectory = lstatSync(expectedDirectory.path, { bigint: true });
        if (!currentDirectory.isDirectory() || currentDirectory.isSymbolicLink() ||
            currentDirectory.dev !== expectedDirectory.dev || currentDirectory.ino !== expectedDirectory.ino ||
            !samePath(realpathSync(expectedDirectory.path), expectedDirectory.path)) {
          throw new ProcessLockError("unsafe");
        }
        const current = lstatSync(path, { bigint: true });
        if (!current.isFile() || current.isSymbolicLink() ||
            current.dev !== expected.dev || current.ino !== expected.ino ||
            !samePath(realpathSync(path), path)) {
          throw new ProcessLockError("unsafe");
        }
      } catch {
        throw new ProcessLockError("unsafe");
      }
    },
    release: () => lease.release(),
  });
}

export const systemProcessLockProvider: ProcessLockProvider = {
  async acquire(path, timeoutMs) {
    const expectedDirectory = process.platform === "darwin" ? await lockDirectoryIdentity(path) : undefined;
    const expected = await prepareLockFile(path);
    const lease = process.platform === "win32"
      ? await acquireWindows(path, timeoutMs, expected)
      : process.platform === "linux"
        ? await acquireLinux(path, timeoutMs)
        : process.platform === "darwin"
          ? await acquireDarwin(path, timeoutMs, expected, expectedDirectory!)
          : null;
    if (lease === null) throw new ProcessLockError("unavailable");
    try {
      if (expectedDirectory !== undefined) await assertLockDirectoryIdentity(expectedDirectory);
      if (process.platform !== "win32") await assertLockIdentity(path, expected);
    } catch (error) {
      await lease.release().catch(() => undefined);
      throw error;
    }
    return lease;
  },
};
