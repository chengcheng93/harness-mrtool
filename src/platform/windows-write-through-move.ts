import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { dirname, isAbsolute, resolve } from "node:path";

import { resolveWindowsPowerShellPath } from "./state-path.ts";

const MOVE_TIMEOUT_MS = 15_000;
const TERMINATION_WAIT_MS = 2_000;
const MAX_HELPER_OUTPUT_BYTES = 512;
const SOURCE_ENVIRONMENT_NAME = "HMRTOOL_MOVE_SOURCE";
const DESTINATION_ENVIRONMENT_NAME = "HMRTOOL_MOVE_DESTINATION";
// MOVEFILE_WRITE_THROUGH is Windows' namespace durability barrier. Omitting
// MOVEFILE_REPLACE_EXISTING preserves create-once publication.
const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = $env:HMRTOOL_MOVE_SOURCE
$destination = $env:HMRTOOL_MOVE_DESTINATION
try {
  [System.IO.File]::Move($source, $destination)
  $stream = [System.IO.File]::Open(
    $destination,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::Read
  )
  try { $stream.Flush($true) } finally { $stream.Dispose() }
  [Console]::Out.WriteLine("OK")
} catch {
  if (Test-Path -LiteralPath $destination) {
    [Console]::Out.WriteLine("ERR:183")
  } else {
    [Console]::Out.WriteLine("ERR:1")
  }
  exit 25
}
`;

export type WindowsWriteThroughMoveFailure = "exists" | "timeout" | "unavailable";

export class WindowsWriteThroughMoveError extends Error {
  readonly reason: WindowsWriteThroughMoveFailure;

  constructor(reason: WindowsWriteThroughMoveFailure) {
    super(reason === "exists"
      ? "The durable destination already exists"
      : reason === "timeout"
        ? "The write-through move helper timed out"
        : "The write-through move helper failed");
    this.name = "WindowsWriteThroughMoveError";
    this.reason = reason;
  }
}

export interface WindowsWriteThroughMover {
  moveNoReplace(sourcePath: string, destinationPath: string): Promise<void>;
}

export interface WindowsMoveChild {
  readonly stdout: Readable;
  readonly stderr: Readable;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WindowsMoveSpawnOptions {
  readonly env: NodeJS.ProcessEnv;
  readonly stdio: ["ignore", "pipe", "pipe"];
  readonly windowsHide: true;
}

export type WindowsMoveChildSpawner = (
  executable: string,
  arguments_: readonly string[],
  options: WindowsMoveSpawnOptions,
) => WindowsMoveChild;

export interface WindowsWriteThroughMoverOptions {
  readonly executablePath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly spawnChild?: WindowsMoveChildSpawner;
}

function copyAllowedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const name of ["SystemRoot", "WINDIR", "TEMP", "TMP"] as const) {
    const value = environment[name];
    if (value !== undefined) scrubbed[name] = value;
  }
  return scrubbed;
}

function validateMovePaths(sourcePath: string, destinationPath: string): void {
  if (typeof sourcePath !== "string" || typeof destinationPath !== "string" ||
      sourcePath.trim() === "" || destinationPath.trim() === "" ||
      /[\r\n\u0000]/u.test(sourcePath) || /[\r\n\u0000]/u.test(destinationPath) ||
      !isAbsolute(sourcePath) || !isAbsolute(destinationPath) ||
      resolve(sourcePath) !== sourcePath || resolve(destinationPath) !== destinationPath ||
      sourcePath.toLocaleLowerCase("en-US") === destinationPath.toLocaleLowerCase("en-US") ||
      dirname(sourcePath).toLocaleLowerCase("en-US") !== dirname(destinationPath).toLocaleLowerCase("en-US")) {
    throw new WindowsWriteThroughMoveError("unavailable");
  }
}

function defaultSpawnChild(
  executable: string,
  arguments_: readonly string[],
  options: WindowsMoveSpawnOptions,
): WindowsMoveChild {
  return spawn(executable, [...arguments_], options) as WindowsMoveChild;
}

function appendBounded(chunks: Buffer[], chunk: Buffer | string, currentBytes: number): number {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const nextBytes = currentBytes + bytes.length;
  if (nextBytes <= MAX_HELPER_OUTPUT_BYTES) chunks.push(bytes);
  return nextBytes;
}

export function createWindowsWriteThroughMover(
  options: WindowsWriteThroughMoverOptions = {},
): WindowsWriteThroughMover {
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? MOVE_TIMEOUT_MS;
  const spawnChild = options.spawnChild ?? defaultSpawnChild;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new TypeError("timeoutMs must be an integer between 1 and 30000");
  }

  return Object.freeze({
    async moveNoReplace(sourcePath: string, destinationPath: string): Promise<void> {
      validateMovePaths(sourcePath, destinationPath);
      let executable: string;
      try {
        executable = options.executablePath ?? resolveWindowsPowerShellPath(environment);
      } catch {
        throw new WindowsWriteThroughMoveError("unavailable");
      }
      const childEnvironment = copyAllowedEnvironment(environment);
      childEnvironment[SOURCE_ENVIRONMENT_NAME] = sourcePath;
      childEnvironment[DESTINATION_ENVIRONMENT_NAME] = destinationPath;
      let child: WindowsMoveChild;
      try {
        child = spawnChild(
          executable,
          [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-InputFormat",
            "Text",
            "-OutputFormat",
            "Text",
            "-Command",
            POWERSHELL_SCRIPT,
          ],
          { env: childEnvironment, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
      } catch {
        throw new WindowsWriteThroughMoveError("unavailable");
      }

      await new Promise<void>((resolveMove, rejectMove) => {
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let requestedFailure: WindowsWriteThroughMoveFailure | undefined;
        let settled = false;
        let closeWait: NodeJS.Timeout | undefined;

        const settle = (failure?: WindowsWriteThroughMoveFailure): void => {
          if (settled) return;
          settled = true;
          clearTimeout(executionTimeout);
          if (closeWait !== undefined) clearTimeout(closeWait);
          if (failure !== undefined) {
            rejectMove(new WindowsWriteThroughMoveError(failure));
          } else {
            resolveMove();
          }
        };
        const terminate = (failure: WindowsWriteThroughMoveFailure): void => {
          if (requestedFailure !== undefined || settled) return;
          requestedFailure = failure;
          try {
            child.kill("SIGKILL");
          } catch {
            // A failed kill request does not prove that the helper has stopped.
          }
          if (settled) return;
          closeWait = setTimeout(() => settle(failure), TERMINATION_WAIT_MS);
        };
        const executionTimeout = setTimeout(() => terminate("timeout"), timeoutMs);
        executionTimeout.unref();

        child.stdout.on("data", (chunk: Buffer | string) => {
          stdoutBytes = appendBounded(stdout, chunk, stdoutBytes);
          if (stdoutBytes > MAX_HELPER_OUTPUT_BYTES) terminate("unavailable");
        });
        child.stdout.on("error", () => terminate("unavailable"));
        child.stderr.on("data", (chunk: Buffer | string) => {
          stderrBytes = appendBounded(stderr, chunk, stderrBytes);
          if (stderrBytes > MAX_HELPER_OUTPUT_BYTES) terminate("unavailable");
        });
        child.stderr.on("error", () => terminate("unavailable"));
        child.once("error", () => terminate("unavailable"));
        child.once("close", (code) => {
          if (requestedFailure !== undefined) {
            settle(requestedFailure);
            return;
          }
          const output = Buffer.concat(stdout).toString("utf8").trim();
          const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
          if (code === 0 && output === "OK" && diagnostic === "") {
            settle();
            return;
          }
          const match = /^ERR:(\d+)$/u.exec(output);
          settle(match !== null && (match[1] === "80" || match[1] === "183")
            ? "exists"
            : "unavailable");
        });
      });
    },
  });
}

export const systemWindowsWriteThroughMover = createWindowsWriteThroughMover();
