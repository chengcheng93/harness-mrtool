import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";

import { ToolError } from "../contracts/errors.ts";
import {
  consumeInvocationStdin,
  MAX_HANDOFF_BYTES,
  runUpdateHandoff,
  type HandoffChild,
  type HandoffOptions,
  type HandoffResult,
} from "./invocation-envelope.ts";

export { MAX_HANDOFF_BYTES } from "./invocation-envelope.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const SECRET_SHAPE = /(?:token|secret|password|credential|authorization|bearer|passphrase)/iu;
const SAFE_ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/u;

export interface UpdateHandoffChild {
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
}

export interface UpdateHandoffRelease {
  readonly repository: { readonly owner: string; readonly name: string };
  readonly tag: string;
  readonly assetSha256: string;
  readonly assetSize: number;
}

export interface UpdateHandoffEnvelope {
  readonly version: 1;
  readonly inputLength: number;
  readonly inputSha256: string;
  readonly child: UpdateHandoffChild;
  readonly release: UpdateHandoffRelease;
}

export interface UpdateHandoffSpawnInput {
  readonly child: UpdateHandoffChild;
  readonly release: UpdateHandoffRelease;
  readonly envelope: UpdateHandoffEnvelope;
  /** A detached copy; the spawner must not retain or mutate the caller's stdin view. */
  readonly input: Uint8Array;
}

export interface BoundedUpdateHandoffOptions extends HandoffOptions {
  readonly input: AsyncIterable<Uint8Array>;
  readonly child: UpdateHandoffChild;
  readonly release: UpdateHandoffRelease;
  readonly spawnChild: (input: UpdateHandoffSpawnInput) => Promise<HandoffChild>;
}

export interface BoundedUpdateHandoffResult extends HandoffResult {
  readonly envelope: UpdateHandoffEnvelope;
}

function inputFailure(): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", "The update handoff request is invalid", {
    field: "handoff",
    expected: "one bounded request and a fixed child specification",
    actual: "invalid handoff input",
    safeNextStep: "Retry through the verified updater.",
  });
}

function plainString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    !/[\u0000\r\n]/u.test(value);
}

function safePublicString(value: unknown, maximum: number): value is string {
  return plainString(value, maximum) && !SECRET_SHAPE.test(value);
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function copyChild(value: UpdateHandoffChild): UpdateHandoffChild {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !safePublicString(value.executable, 1024) || !isAbsolute(value.cwd) ||
      !plainString(value.cwd, 4096) || !Array.isArray(value.arguments) ||
      value.arguments.length > 32 || value.arguments.some((item) => !safePublicString(item, 4096)) ||
      value.environment === null || typeof value.environment !== "object" ||
      Array.isArray(value.environment)) {
    throw inputFailure();
  }
  const environment: Record<string, string> = {};
  for (const [key, item] of Object.entries(value.environment)) {
    if (!SAFE_ENV_KEY.test(key) || !safePublicString(item, 4096)) throw inputFailure();
    environment[key] = item;
  }
  return deepFreeze({
    executable: value.executable,
    arguments: Object.freeze([...value.arguments]),
    cwd: value.cwd,
    environment: Object.freeze(environment),
  });
}

function copyRelease(value: UpdateHandoffRelease): UpdateHandoffRelease {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      value.repository === null || typeof value.repository !== "object" ||
      Array.isArray(value.repository) || !plainString(value.repository.owner, 100) ||
      !plainString(value.repository.name, 100) || !/^[A-Za-z0-9_.-]+$/u.test(value.repository.owner) ||
      !/^[A-Za-z0-9_.-]+$/u.test(value.repository.name) || !safePublicString(value.tag, 256) ||
      !SHA256.test(value.assetSha256) || !Number.isSafeInteger(value.assetSize) ||
      value.assetSize < 0 || value.assetSize > 256 * 1024 * 1024) {
    throw inputFailure();
  }
  return deepFreeze({
    repository: Object.freeze({ owner: value.repository.owner, name: value.repository.name }),
    tag: value.tag,
    assetSha256: value.assetSha256,
    assetSize: value.assetSize,
  });
}

function inputHash(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function* oneChunk(value: Uint8Array): AsyncIterable<Uint8Array> {
  yield value;
}

export async function runBoundedUpdateHandoff(
  options: BoundedUpdateHandoffOptions,
): Promise<BoundedUpdateHandoffResult> {
  if (options === null || typeof options !== "object" ||
      typeof options.spawnChild !== "function" || options.input === null ||
      typeof options.input[Symbol.asyncIterator] !== "function") {
    throw inputFailure();
  }
  const child = copyChild(options.child);
  const release = copyRelease(options.release);
  const request = await consumeInvocationStdin(options.input);
  if (request.byteLength > MAX_HANDOFF_BYTES) throw inputFailure();
  const input = Uint8Array.from(request);
  const envelope = deepFreeze({
    version: 1 as const,
    inputLength: input.byteLength,
    inputSha256: inputHash(input),
    child,
    release,
  });
  const descriptor: UpdateHandoffSpawnInput = Object.freeze({
    child,
    release,
    envelope,
    input: Uint8Array.from(input),
  });
  const result = await runUpdateHandoff(
    oneChunk(input),
    () => options.spawnChild(descriptor),
    {
      ...(options.output === undefined ? {} : { output: options.output }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    },
  );
  return Object.freeze({ ...result, envelope });
}
