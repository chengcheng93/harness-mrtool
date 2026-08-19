import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";

import { isToolError, ToolError } from "../contracts/errors.ts";
import type { JsonValue } from "../contracts/jcs.ts";
import { parseStrictJson } from "./strict-json.ts";
import { parseStrictYaml } from "./strict-yaml.ts";

export const MAX_INPUT_BYTES = 2 * 1024 * 1024;

export type InputFormat = "json" | "yaml";

export type InputTransport =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly format?: InputFormat;
    }
  | {
      readonly kind: "stdin";
      readonly format: InputFormat;
    };

export interface InputIo {
  statFile(path: string): Promise<{ readonly size: number }>;
  readFile(path: string): Promise<Uint8Array>;
  stdin: AsyncIterable<Uint8Array> & { destroy?(): unknown };
}

const defaultIo: InputIo = {
  statFile: async (path) => stat(path),
  readFile,
  stdin: process.stdin,
};

function inputError(reason: string, cause?: unknown): ToolError<"INPUT_ERROR"> {
  return new ToolError(
    "INPUT_ERROR",
    `Invalid structured input: ${reason}`,
    {
      field: null,
      expected: "valid UTF-8 JSON or YAML input",
      actual: reason,
      safeNextStep: "Check the input source, format, encoding, and structured request syntax.",
    },
    cause,
  );
}

function inputTooLarge(): ToolError<"INPUT_TOO_LARGE"> {
  return new ToolError("INPUT_TOO_LARGE", "Structured input exceeds the 2 MiB limit", {
    field: null,
    expected: MAX_INPUT_BYTES,
    actual: "more than 2097152 bytes",
    safeNextStep: "Reduce the input payload to 2 MiB or less.",
  });
}

function assertSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw inputError("input source reported an invalid byte size");
  }
  if (size > MAX_INPUT_BYTES) {
    throw inputTooLarge();
  }
}

function hasLeadingBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function hasEmbeddedBom(bytes: Uint8Array, start: number): boolean {
  for (let index = start; index + 2 < bytes.length; index += 1) {
    if (bytes[index] === 0xef && bytes[index + 1] === 0xbb && bytes[index + 2] === 0xbf) {
      return true;
    }
  }
  return false;
}

export function decodeInputBytes(bytes: Buffer | Uint8Array, format: InputFormat): JsonValue {
  if (!(bytes instanceof Uint8Array)) {
    throw inputError("input must be a byte sequence");
  }
  if (format !== "json" && format !== "yaml") {
    throw inputError("input format must be json or yaml");
  }
  assertSize(bytes.byteLength);

  const leadingBom = hasLeadingBom(bytes);
  if (hasEmbeddedBom(bytes, leadingBom ? 3 : 0)) {
    throw inputError("only one leading UTF-8 BOM is permitted");
  }
  const content = leadingBom ? bytes.subarray(3) : bytes;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch (error) {
    throw inputError("input is not valid UTF-8", error);
  }
  return format === "json" ? parseStrictJson(text) : parseStrictYaml(text);
}

function inferFileFormat(path: string): InputFormat {
  switch (extname(path).toLowerCase()) {
    case ".json":
      return "json";
    case ".yaml":
    case ".yml":
      return "yaml";
    default:
      throw inputError("file extension does not identify JSON or YAML");
  }
}

async function readFileBytes(path: string, io: InputIo): Promise<Uint8Array> {
  try {
    const metadata = await io.statFile(path);
    assertSize(metadata.size);
    const bytes = await io.readFile(path);
    if (!(bytes instanceof Uint8Array)) {
      throw inputError("file reader returned a non-byte value");
    }
    assertSize(bytes.byteLength);
    return bytes;
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw inputError("unable to read input file", error);
  }
}

async function readStdinBytes(source: InputIo["stdin"]): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of source) {
      if (!(chunk instanceof Uint8Array)) {
        throw inputError("stdin returned a non-byte value");
      }
      total += chunk.byteLength;
      if (!Number.isSafeInteger(total) || total > MAX_INPUT_BYTES) {
        try {
          source.destroy?.();
        } catch {
          // Cleanup is best-effort; the deterministic size error remains primary.
        }
        throw inputTooLarge();
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (isToolError(error)) {
      throw error;
    }
    throw inputError("unable to read stdin", error);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), total);
}

export async function loadInputTransport(
  transport: InputTransport,
  io: InputIo = defaultIo,
): Promise<JsonValue> {
  if (transport === null || typeof transport !== "object" || Array.isArray(transport)) {
    throw inputError("input transport must be a file or stdin descriptor");
  }
  const candidate = transport as InputTransport;
  if (candidate.kind === "file") {
    if (typeof candidate.path !== "string" || candidate.path.trim() === "") {
      throw inputError("file input requires a non-empty path");
    }
    const format = candidate.format ?? inferFileFormat(candidate.path);
    if (format !== "json" && format !== "yaml") {
      throw inputError("input format must be json or yaml");
    }
    return decodeInputBytes(await readFileBytes(candidate.path, io), format);
  }
  if (candidate.kind !== "stdin") {
    throw inputError("input transport must be a file or stdin descriptor");
  }
  if (candidate.format !== "json" && candidate.format !== "yaml") {
    throw inputError("stdin requires an explicit json or yaml format");
  }
  return decodeInputBytes(await readStdinBytes(io.stdin), candidate.format);
}
