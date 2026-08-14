import { ToolError } from "../contracts/errors.ts";

export const MAX_HANDOFF_BYTES = 2 * 1024 * 1024;
export const MAX_HANDOFF_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface HandoffChild {
  writeStdin(bytes: Uint8Array): Promise<void>;
  closeStdin(): Promise<void>;
  /** Legacy adapters must enforce the supplied cap while reading. */
  readStdout(maxBytes?: number): Promise<Uint8Array>;
  /** Legacy adapters must enforce the supplied cap while reading. */
  readStderr(maxBytes?: number): Promise<Uint8Array>;
  streamStdout?(): AsyncIterable<Uint8Array>;
  streamStderr?(): AsyncIterable<Uint8Array>;
  wait(): Promise<{ readonly exitCode: number }>;
  terminate?(): void | Promise<void>;
  cleanup?(): void | Promise<void>;
}

export interface HandoffOutput {
  stdout(bytes: Uint8Array): void | Promise<void>;
  stderr(bytes: Uint8Array): void | Promise<void>;
}

export interface HandoffOptions {
  readonly output?: HandoffOutput;
  /** Per-stream cap. Callers may lower, but never raise, the hard limit. */
  readonly maxOutputBytes?: number;
}

export interface HandoffResult {
  readonly parentStdout: Uint8Array;
  readonly parentStderr: Uint8Array;
  readonly parentExit: number;
  readonly childStdout: Uint8Array;
  readonly childStderr: Uint8Array;
  readonly childExit: number;
  readonly childReads: 1;
}

function inputFailure(message: string): ToolError<"INPUT_ERROR"> {
  return new ToolError(
    "INPUT_ERROR",
    message,
    { field: "stdin", expected: "one bounded JSON envelope", actual: "invalid", safeNextStep: "Provide one JSON request on stdin" },
  );
}

function handoffFailure(cause?: unknown): ToolError<"UPDATE_REQUIRED"> {
  return new ToolError(
    "UPDATE_REQUIRED",
    "update handoff failed",
    { field: "handoff", expected: "a verified bounded child result", actual: "unavailable", safeNextStep: "Retry self-update" },
    cause,
  );
}

function outputLimit(options: HandoffOptions): number {
  const value = options.maxOutputBytes ?? MAX_HANDOFF_OUTPUT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HANDOFF_OUTPUT_BYTES) {
    throw handoffFailure();
  }
  return value;
}

async function collectOutput(
  stream: AsyncIterable<Uint8Array> | undefined,
  legacyRead: (maxBytes: number) => Promise<Uint8Array>,
  maxBytes: number,
  forward: ((bytes: Uint8Array) => void | Promise<void>) | undefined,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const accept = async (chunk: Uint8Array): Promise<void> => {
    if (!(chunk instanceof Uint8Array)) throw new Error("child output is not bytes");
    if (chunk.byteLength === 0) return;
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > maxBytes) {
      throw new Error("child output exceeds handoff limit");
    }
    const copy = Uint8Array.from(chunk);
    chunks.push(copy);
    await forward?.(Uint8Array.from(copy));
  };

  if (stream === undefined) {
    await accept(await legacyRead(maxBytes));
  } else {
    const iterator = stream[Symbol.asyncIterator]?.();
    if (iterator === undefined) throw new Error("child output stream is invalid");
    let completed = false;
    try {
      for (;;) {
        const step = await iterator.next();
        if (step.done === true) {
          completed = true;
          break;
        }
        await accept(step.value);
      }
    } finally {
      if (!completed) {
        try {
          await iterator.return?.();
        } catch {
          // The original stream failure remains authoritative.
        }
      }
    }
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function stopChild(child: HandoffChild): Promise<void> {
  try {
    await child.terminate?.();
  } catch {
    // Termination is best-effort; cleanup is still required.
  }
}

async function cleanupChild(child: HandoffChild): Promise<void> {
  await child.cleanup?.();
}

export async function consumeInvocationStdin(input: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of input) {
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) throw inputFailure("stdin chunk is invalid");
      total += chunk.byteLength;
      if (total > MAX_HANDOFF_BYTES) throw inputFailure("stdin envelope is too large");
      chunks.push(Uint8Array.from(chunk));
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw inputFailure("stdin could not be consumed");
  }
  if (chunks.length === 0) throw inputFailure("stdin envelope is empty");
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function runUpdateHandoff(
  input: AsyncIterable<Uint8Array>,
  spawnChild: () => Promise<HandoffChild>,
  options: HandoffOptions = {},
): Promise<HandoffResult> {
  const envelope = await consumeInvocationStdin(input);
  const maxOutputBytes = outputLimit(options);
  let child: HandoffChild | undefined;
  let result: HandoffResult;
  try {
    child = await spawnChild();
    const feeding = (async () => {
      await child!.writeStdin(envelope);
      await child!.closeStdin();
    })();
    const [, childStdout, childStderr, exit] = await Promise.all([
      feeding,
      collectOutput(
        child.streamStdout?.(),
        (limit) => child!.readStdout(limit),
        maxOutputBytes,
        options.output?.stdout,
      ),
      collectOutput(
        child.streamStderr?.(),
        (limit) => child!.readStderr(limit),
        maxOutputBytes,
        options.output?.stderr,
      ),
      child.wait(),
    ]);
    if (!(childStdout instanceof Uint8Array) || !(childStderr instanceof Uint8Array) ||
      !Number.isInteger(exit.exitCode) || exit.exitCode < 0 || exit.exitCode > 255) {
      throw new Error("child result is invalid");
    }
    result = Object.freeze({
      parentStdout: Uint8Array.from(childStdout),
      parentStderr: Uint8Array.from(childStderr),
      parentExit: exit.exitCode,
      childStdout: Uint8Array.from(childStdout),
      childStderr: Uint8Array.from(childStderr),
      childExit: exit.exitCode,
      childReads: 1 as const,
    });
  } catch (error) {
    if (child !== undefined) {
      await stopChild(child);
      await cleanupChild(child).catch(() => undefined);
    }
    throw handoffFailure(error);
  }
  try {
    await cleanupChild(child);
  } catch (error) {
    throw handoffFailure(error);
  }
  return result;
}

export function forwardHandoffResult(
  result: HandoffResult,
  output: { readonly stdout: (bytes: Uint8Array) => void; readonly stderr: (bytes: Uint8Array) => void },
): number {
  output.stdout(Uint8Array.from(result.parentStdout));
  output.stderr(Uint8Array.from(result.parentStderr));
  return result.parentExit;
}
