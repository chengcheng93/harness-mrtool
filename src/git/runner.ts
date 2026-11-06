import { spawn } from "node:child_process";
import { realpath, rm, stat } from "node:fs/promises";
import {
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, resolve } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const BLOCKED_GIT_ENVIRONMENT_KEYS = Object.freeze([
  "GIT_ASKPASS",
  "GIT_ATTR_SOURCE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_EXEC_PATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_NAMESPACE",
  "GIT_PROXY_COMMAND",
  "GIT_REDIRECT_STDERR",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_TEMPLATE_DIR",
  "GIT_TRACE",
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE_CURL",
  "GIT_TRACE_PACKET",
  "SSH_ASKPASS",
]);
const BLOCKED_GIT_CONFIG_ENVIRONMENT_KEYS = Object.freeze([
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
]);
const BLOCKED_GIT_REPOSITORY_ENVIRONMENT_KEYS = Object.freeze([
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
]);
const ALLOWED_GIT_ENVIRONMENT_OVERRIDES = Object.freeze([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
  "XDG_CONFIG_HOME",
]);

function scrubGitEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const scrubbed = { ...environment };
  for (const key of Object.keys(scrubbed)) {
    const upper = key.toUpperCase();
    if (
      BLOCKED_GIT_ENVIRONMENT_KEYS.includes(upper) ||
      BLOCKED_GIT_CONFIG_ENVIRONMENT_KEYS.includes(upper) ||
      BLOCKED_GIT_REPOSITORY_ENVIRONMENT_KEYS.includes(upper) ||
      /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(upper)
    ) {
      scrubbed[key] = undefined;
    }
  }
  return scrubbed;
}

function validateGitEnvironmentOverride(
  environment: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> {
  for (const key of Object.keys(environment)) {
    if (!ALLOWED_GIT_ENVIRONMENT_OVERRIDES.includes(key)) {
      throw new TypeError(`Unsupported Git environment override: ${key}`);
    }
  }
  return environment;
}

export async function removeTemporaryDirectory(path: string): Promise<void> {
  await rm(validateAbsolutePath(path, "Temporary directory"), {
    force: true,
    maxRetries: process.platform === "win32" ? 4 : 0,
    recursive: true,
    retryDelay: 50,
  });
}

export interface ProcessRequest {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly fileIdentityGuards: readonly FileIdentityGuard[];
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

export interface FileIdentity {
  readonly birthTimeMs: string;
  readonly changeTimeMs: string;
  readonly device: string;
  readonly inode: string;
  readonly modificationTimeMs: string;
  readonly path: string;
  readonly size: string;
}

export interface FileIdentityGuard {
  readonly compareContentMetadata: boolean;
  readonly identity: FileIdentity;
}

function identityFromStat(path: string, metadata: Awaited<ReturnType<typeof stat>>): FileIdentity {
  return Object.freeze({
    birthTimeMs: String(metadata.birthtimeMs),
    changeTimeMs: String(metadata.ctimeMs),
    device: String(metadata.dev),
    inode: String(metadata.ino),
    modificationTimeMs: String(metadata.mtimeMs),
    path,
    size: String(metadata.size),
  });
}

export async function captureFileIdentity(value: string): Promise<FileIdentity> {
  const path = await realpath(validateAbsolutePath(value, "Guarded path"));
  return identityFromStat(path, await stat(path));
}

function fileIdentityMatches(
  expected: FileIdentity,
  actual: FileIdentity,
  compareContentMetadata: boolean,
): boolean {
  return actual.path === expected.path &&
    actual.birthTimeMs === expected.birthTimeMs &&
    actual.device === expected.device &&
    actual.inode === expected.inode &&
    (!compareContentMetadata || (
      actual.changeTimeMs === expected.changeTimeMs &&
      actual.modificationTimeMs === expected.modificationTimeMs &&
      actual.size === expected.size
    ));
}

function assertFileIdentity(guard: FileIdentityGuard): void {
  const { identity } = guard;
  const path = realpathSync(identity.path);
  const metadata = statSync(path);
  if (
    !fileIdentityMatches(
      identity,
      identityFromStat(path, metadata),
      guard.compareContentMetadata,
    )
  ) {
    throw new Error("Guarded filesystem identity changed before process spawn");
  }
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
    for (const guard of request.fileIdentityGuards) {
      assertFileIdentity(guard);
    }
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
  readonly gitExecutable?: string;
  readonly maxOutputBytes?: number;
  readonly timeoutMs?: number;
}

function validateAbsolutePath(value: string, subject: string): string {
  if (!isAbsolute(value) || value.includes("\u0000") || /[\r\n]/u.test(value)) {
    throw new TypeError(`${subject} must be an absolute path`);
  }
  return resolve(value);
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

  async run(
    arguments_: readonly string[],
    environmentOverride: Readonly<Record<string, string | undefined>> = {},
    fileIdentityGuards: readonly FileIdentity[] = [],
  ): Promise<ProcessResult> {
    if (arguments_.some((argument) => argument.includes("\u0000"))) {
      throw new TypeError("Git arguments must not contain NUL bytes");
    }
    const environment = {
      ...scrubGitEnvironment(process.env),
      ...(this.options.environment ?? {}),
      ...validateGitEnvironmentOverride(environmentOverride),
    };
    return this.processRunner.run({
      executable: this.options.gitExecutable ?? "git",
      arguments: Object.freeze([...arguments_]),
      cwd: this.cwd,
      environment: {
        ...environment,
        GIT_ATTR_NOSYSTEM: "1",
        // Attribute policy is pinned by the trusted caller's private index,
        // never an inherited tree override (including case variants on Windows).
        GIT_ATTR_SOURCE: undefined,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
      fileIdentityGuards: Object.freeze([
        ...fileIdentityGuards.map((identity) => Object.freeze({
          compareContentMetadata: false,
          identity,
        })),
      ]),
      maxOutputBytes: this.options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      shell: false,
      timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
  }
}
