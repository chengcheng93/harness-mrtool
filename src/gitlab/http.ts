import { createHash, timingSafeEqual } from "node:crypto";

import { ToolError } from "../contracts/errors.ts";
import { copyJsonValue, type JsonValue } from "../contracts/jcs.ts";
import {
  createScanner,
  printParseErrorCode,
  SyntaxKind,
  visit,
} from "jsonc-parser";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RESPONSE_LIMIT = 8 * 1024 * 1024;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_JSON_NESTING_DEPTH = 256;

export interface GitLabHttpRequest {
  readonly method: "GET" | "POST" | "PUT";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array | null;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface GitLabHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface GitLabHttpTransport {
  request(request: GitLabHttpRequest): Promise<GitLabHttpResponse>;
}

export type GitLabTokenProvider = () => Promise<string>;

export interface GitLabHttpClientOptions {
  readonly origin: string;
  readonly tokenProvider: GitLabTokenProvider;
  readonly transport?: GitLabHttpTransport;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly allowInsecureLoopback?: boolean;
}

export interface GitLabJsonResponse {
  readonly data: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId: string | null;
  readonly status: number;
}

function gitLabError(
  code: "AUTH_ERROR" | "GITLAB_ERROR",
  message: string,
  actual: string,
  requestId: string | null = null,
): ToolError<"AUTH_ERROR" | "GITLAB_ERROR"> {
  return new ToolError(code, message, {
    field: "gitlab",
    expected: "an authenticated, bounded GitLab API response",
    actual: requestId === null ? actual : `${actual}; request-id ${requestId}`,
    safeNextStep: code === "AUTH_ERROR"
      ? "Refresh the GitLab credential and verify the required project permission."
      : "Retry the read-only operation or inspect the GitLab request ID with an administrator.",
  });
}

export function normalizeGitLabOrigin(value: string, allowInsecureLoopback = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw gitLabError("GITLAB_ERROR", "GitLab origin is invalid", "invalid origin");
  }
  const loopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]" || parsed.hostname === "localhost";
  if ((parsed.protocol !== "https:" && !(allowInsecureLoopback && loopback && parsed.protocol === "http:")) ||
      parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
      (parsed.pathname !== "" && parsed.pathname !== "/")) {
    throw gitLabError("GITLAB_ERROR", "GitLab origin is not trusted", "unsupported origin shape");
  }
  return parsed.origin;
}

async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) {
    return new Uint8Array();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new RangeError("GitLab response exceeds the configured limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export const nodeGitLabHttpTransport: GitLabHttpTransport = Object.freeze({
  async request(request: GitLabHttpRequest): Promise<GitLabHttpResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    timer.unref();
    try {
      const init: RequestInit = {
        method: request.method,
        headers: request.headers,
        redirect: "error",
        signal: controller.signal,
      };
      if (request.body !== null) {
        init.body = Buffer.from(request.body);
      }
      const response = await fetch(request.url, init);
      const headers: Record<string, string> = Object.create(null) as Record<string, string>;
      response.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
      return {
        status: response.status,
        headers,
        body: await readBoundedBody(response, request.maxResponseBytes),
      };
    } finally {
      clearTimeout(timer);
    }
  },
});

function normalizeHeaders(
  headers: Readonly<Record<string, string>>,
  reflectsCredential: (value: string) => boolean,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== "string" || /[\r\n\u0000]/u.test(name) || /[\r\n\u0000]/u.test(value)) {
      throw gitLabError("GITLAB_ERROR", "GitLab returned invalid response headers", "invalid response header");
    }
    const normalizedName = name.toLowerCase();
    if (reflectsCredential(normalizedName) || reflectsCredential(value)) {
      continue;
    }
    result[normalizedName] = value;
  }
  return Object.freeze(result);
}

function parseStrictResponseJson(text: string): JsonValue {
  const scanner = createScanner(text, false);
  let depth = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      depth += 1;
      if (depth > MAX_JSON_NESTING_DEPTH) throw new SyntaxError("GitLab JSON nesting is excessive");
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      depth = Math.max(0, depth - 1);
    }
  }
  const objectKeys: Set<string>[] = [];
  let duplicate = false;
  let syntaxError: string | undefined;
  visit(text, {
    onObjectBegin: () => { objectKeys.push(new Set()); },
    onObjectProperty: (property) => {
      const keys = objectKeys.at(-1);
      if (keys?.has(property)) duplicate = true;
      keys?.add(property);
    },
    onObjectEnd: () => { objectKeys.pop(); },
    onError: (code) => { syntaxError ??= printParseErrorCode(code); },
  }, { allowTrailingComma: false, disallowComments: true });
  if (duplicate) throw new SyntaxError("GitLab JSON has a duplicate object key");
  if (syntaxError !== undefined) throw new SyntaxError(`GitLab JSON syntax error: ${syntaxError}`);
  return copyJsonValue(JSON.parse(text));
}

export class GitLabHttpClient {
  readonly origin: string;
  private readonly tokenProvider: GitLabTokenProvider;
  private readonly transport: GitLabHttpTransport;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly credentialDigests = new Map<number, Buffer[]>();

  constructor(options: GitLabHttpClientOptions) {
    this.origin = normalizeGitLabOrigin(options.origin, options.allowInsecureLoopback ?? false);
    this.tokenProvider = options.tokenProvider;
    this.transport = options.transport ?? nodeGitLabHttpTransport;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxResponseBytes = options.maxResponseBytes ?? DEFAULT_RESPONSE_LIMIT;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 ||
        !Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new TypeError("GitLab HTTP limits must be positive safe integers");
    }
  }

  private rememberCredential(credential: string): void {
    const normalized = credential.toLowerCase();
    const digest = createHash("sha256").update(normalized, "utf8").digest();
    const digests = this.credentialDigests.get(normalized.length) ?? [];
    if (!digests.some((known) => timingSafeEqual(known, digest))) digests.push(digest);
    this.credentialDigests.set(normalized.length, digests);
  }

  private reflectsCredential(value: string): boolean {
    const normalized = value.toLowerCase();
    for (const [length, digests] of this.credentialDigests) {
      if (length > normalized.length) continue;
      for (let offset = 0; offset <= normalized.length - length; offset += 1) {
        const digest = createHash("sha256")
          .update(normalized.slice(offset, offset + length), "utf8")
          .digest();
        if (digests.some((known) => timingSafeEqual(known, digest))) return true;
      }
    }
    return false;
  }

  sanitizeRequestId(value: string): string | null {
    const normalized = value.trim();
    return normalized === "" || this.reflectsCredential(normalized) ? null : normalized;
  }

  async requestJson(
    method: "GET" | "POST" | "PUT",
    endpoint: string,
    body: JsonValue | null = null,
  ): Promise<GitLabJsonResponse> {
    let canonicalEndpoint = false;
    try {
      canonicalEndpoint = new URL(endpoint, this.origin).href === `${this.origin}${endpoint}`;
    } catch {
      canonicalEndpoint = false;
    }
    if (!endpoint.startsWith("/api/") || /[\r\n\u0000]/u.test(endpoint) || !canonicalEndpoint) {
      throw new TypeError("GitLab endpoint must be an absolute API path");
    }
    let token: string;
    try {
      token = await this.tokenProvider();
    } catch {
      throw gitLabError("AUTH_ERROR", "GitLab credential is unavailable", "credential provider failed");
    }
    if (typeof token !== "string" || token === "" || token !== token.trim() ||
        token.length > MAX_TOKEN_LENGTH || /[\r\n\u0000]/u.test(token)) {
      throw gitLabError("AUTH_ERROR", "GitLab credential is invalid", "invalid credential shape");
    }
    this.rememberCredential(token);
    const encodedBody = body === null ? null : new TextEncoder().encode(JSON.stringify(body));
    let response: GitLabHttpResponse;
    try {
      response = await this.transport.request({
        method,
        url: `${this.origin}${endpoint}`,
        headers: Object.freeze({
          accept: "application/json",
          ...(encodedBody === null ? {} : { "content-type": "application/json" }),
          "private-token": token,
          "user-agent": "harness-mrtool",
        }),
        body: encodedBody,
        timeoutMs: this.timeoutMs,
        maxResponseBytes: this.maxResponseBytes,
      });
    } catch {
      throw gitLabError("GITLAB_ERROR", "GitLab request failed", "network, timeout, or response limit failure");
    }
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 ||
        !(response.body instanceof Uint8Array) || response.body.byteLength > this.maxResponseBytes ||
        response.headers === null || typeof response.headers !== "object" || Array.isArray(response.headers)) {
      throw gitLabError("GITLAB_ERROR", "GitLab response exceeded the configured limit", "response limit failure");
    }
    const headers = normalizeHeaders(response.headers, (value) => this.reflectsCredential(value));
    const requestId = headers["x-request-id"] === undefined
      ? null
      : this.sanitizeRequestId(headers["x-request-id"]);
    if (response.status === 401 || response.status === 403) {
      throw gitLabError("AUTH_ERROR", "GitLab rejected the credential or permission", `HTTP ${String(response.status)}`, requestId);
    }
    if (response.status < 200 || response.status >= 300) {
      throw gitLabError("GITLAB_ERROR", "GitLab API returned an error", `HTTP ${String(response.status)}`, requestId);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      throw gitLabError("GITLAB_ERROR", "GitLab returned invalid UTF-8", "invalid response bytes", requestId);
    }
    let data: JsonValue;
    try {
      data = parseStrictResponseJson(text);
    } catch {
      throw gitLabError("GITLAB_ERROR", "GitLab returned invalid JSON", "malformed response", requestId);
    }
    return Object.freeze({ data, headers, requestId, status: response.status });
  }
}
