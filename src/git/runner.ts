import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes: number;
  readonly shell: false;
  readonly timeoutMs: number;
}

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: Buffer;
  readonly stdout: Buffer;
  readonly timedOut: boolean;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

function collectOutput(
  chunks: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  maxOutputBytes: number,
): number {
  const nextBytes = currentBytes + chunk.length;
  if (nextBytes > maxOutputBytes) {
    throw new RangeError("Git process output exceeded the configured limit");
  }
  chunks.push(chunk);
  return nextBytes;
}

export const nodeProcessRunner: ProcessRunner = Object.freeze({
  run(request: ProcessRequest): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.arguments], {
        cwd: request.cwd,
        env: request.environment,
        shell: request.shell,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let settled = false;

      const rejectOnce = (error: unknown): void => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          child.kill();
          reject(error);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        try {
          stdoutBytes = collectOutput(stdout, chunk, stdoutBytes, request.maxOutputBytes);
        } catch (error) {
          rejectOnce(error);
        }
      });
      child.stderr.on("data", (chunk: Buffer) => {
        try {
          stderrBytes = collectOutput(stderr, chunk, stderrBytes, request.maxOutputBytes);
        } catch (error) {
          rejectOnce(error);
        }
      });
      child.on("error", rejectOnce);
      child.on("close", (exitCode, signal) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve({
            exitCode,
            signal,
            stderr: Buffer.concat(stderr),
            stdout: Buffer.concat(stdout),
            timedOut,
          });
        }
      });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, request.timeoutMs);
      timer.unref();
    });
  },
});

export interface GitRunnerOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

export class GitRunner {
  readonly cwd: string;
  private readonly processRunner: ProcessRunner;
  private readonly options: GitRunnerOptions;

  constructor(
    cwd: string,
    processRunner: ProcessRunner = nodeProcessRunner,
    options: GitRunnerOptions = {},
  ) {
    this.cwd = cwd;
    this.processRunner = processRunner;
    this.options = options;
  }

  async run(arguments_: readonly string[]): Promise<ProcessResult> {
    if (arguments_.some((argument) => argument.includes("\u0000"))) {
      throw new TypeError("Git arguments must not contain NUL bytes");
    }
    return this.processRunner.run({
      executable: "git",
      arguments: Object.freeze([...arguments_]),
      cwd: this.cwd,
      environment: {
        ...process.env,
        ...this.options.environment,
        GIT_ATTR_NOSYSTEM: "1",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      shell: false,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }
}
