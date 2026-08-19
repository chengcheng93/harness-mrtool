import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

import { ToolError } from "../contracts/errors.ts";

export const OPAQUE_TOKEN_BYTES = 32;
const CANDIDATE_PREFIX = "hmrc1_";
const CONTEXT_PREFIX = "hmrx1_";
const BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/u;

export interface TokenRandomSource {
  randomBytes(length: number): Uint8Array;
}

export const systemTokenRandomSource: TokenRandomSource = {
  randomBytes(length) {
    return nodeRandomBytes(length);
  },
};

function tokenError(subject: "candidate token" | "context ID"): ToolError<"INPUT_ERROR"> {
  return new ToolError("INPUT_ERROR", `Invalid ${subject}`, {
    field: subject === "candidate token" ? "candidateToken" : "contextId",
    expected: `a CLI-issued opaque ${subject}`,
    actual: "malformed or unknown bearer value",
    safeNextStep: "Run context again and use the newly issued opaque values.",
  });
}

function encode(prefix: string, bytes: Uint8Array): string {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== OPAQUE_TOKEN_BYTES) {
    throw new ToolError("INTERNAL_ERROR", "Secure random source returned an invalid value", {
      field: null,
      expected: `${String(OPAQUE_TOKEN_BYTES)} random bytes`,
      actual: "invalid random output",
      safeNextStep: "Retry the command; if the problem persists, repair the installation.",
    });
  }
  return `${prefix}${Buffer.from(bytes).toString("base64url")}`;
}

function assertOpaque(value: string, prefix: string, subject: "candidate token" | "context ID"): void {
  if (
    typeof value !== "string" ||
    value.length !== prefix.length + 43 ||
    !value.startsWith(prefix) ||
    !BASE64URL_256.test(value.slice(prefix.length))
  ) {
    throw tokenError(subject);
  }
  const encoded = value.slice(prefix.length);
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.byteLength !== OPAQUE_TOKEN_BYTES || bytes.toString("base64url") !== encoded) {
    throw tokenError(subject);
  }
}

export function issueCandidateToken(random: TokenRandomSource): string {
  return encode(CANDIDATE_PREFIX, random.randomBytes(OPAQUE_TOKEN_BYTES));
}

export function issueContextId(random: TokenRandomSource): string {
  return encode(CONTEXT_PREFIX, random.randomBytes(OPAQUE_TOKEN_BYTES));
}

export function assertCandidateToken(value: string): void {
  assertOpaque(value, CANDIDATE_PREFIX, "candidate token");
}

export function assertContextId(value: string): void {
  assertOpaque(value, CONTEXT_PREFIX, "context ID");
}

export function candidateTokenDigest(token: string): string {
  assertCandidateToken(token);
  return createHash("sha256").update(token, "ascii").digest("hex");
}

export function contextIdDigest(contextId: string): string {
  assertContextId(contextId);
  return createHash("sha256").update(contextId, "ascii").digest("hex");
}
