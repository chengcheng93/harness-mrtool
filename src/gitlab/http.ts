import { createHash, timingSafeEqual } from "node:crypto";

import { ToolError } from "../contracts/errors.ts";
import { GitLabCredentialError, isGitLabCredentialError } from "../platform/gitlab-credential.ts";
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
const MAX_ERROR_MESSAGE_BYTES = 16 * 1024;
const SECRET_DIAGNOSTIC = /(?:glpat-[A-Za-z0-9_-]+|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|hmr[ctx]1_[A-Za-z0-9_-]{43}|(?:private|job)[_-]token\s*[:=]\s*\S+|authorization\s*[:=]\s*(?:bearer\s+)?\S+|bearer\s+\S+|-----BEGIN [A-Z ]+ PRIVATE KEY-----)/iu;

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
  /** @deprecated HTTP and HTTPS origins are supported without a loopback exception. */
  readonly allowInsecureLoopback?: boolean;
}

export interface GitLabJsonResponse {
  readonly data: JsonValue;
  readonly headers: Readonly<Record<string, string>>;
  readonly requestId: string | null;
  readonly status: number;
}

export type GitLabRequestFailureKind =
  | "auth"
  | "http"
  | "network"
  | "timeout"
  | "response";

const gitLabRequestErrors = new WeakSet<object>();

export class GitLabRequestError extends ToolError<"AUTH_ERROR" | "GITLAB_ERROR"> {
  readonly kind: GitLabRequestFailureKind;
  readonly status: number | null;
  readonly requestId: string | null;
  readonly remoteMessage: string | null;

  constructor(
    kind: GitLabRequestFailureKind,
    status: number | null,
    requestId: string | null,
    remoteMessage: string | null = null,
  ) {
    const code = kind === "auth" ? "AUTH_ERROR" : "GITLAB_ERROR";
    super(code, code === "AUTH_ERROR"
      ? status === 401
        ? "GitLab rejected the API credential (HTTP 401)"
        : "GitLab denied access to the requested resource (HTTP 403)"
      : kind === "timeout"
        ? "The GitLab API request timed out"
        : kind === "network"
          ? "The GitLab API could not be reached"
          : "GitLab request failed", {
      field: "gitlab",
      expected: "an authenticated, bounded GitLab API response",
      actual: status === null
        ? `remote ${kind}`
        : requestId === null
          ? `HTTP ${String(status)}`
          : `HTTP ${String(status)}; request-id ${requestId}`,
      safeNextStep: code === "AUTH_ERROR"
        ? status === 401
          ? "The token may be expired or revoked. Run the plugin scripts/setup-gitlab.ps1 authorization guide, or rerun the Windows CLI installer with -SetupOnly, then harness-mrtool auth check --output json."
          : "Verify the token API scope and the account permission for the requested GitLab resource."
        : "Retry the read-only operation or inspect the GitLab request ID with an administrator.",
    });
    this.name = "GitLabRequestError";
    this.kind = kind;
    this.status = status;
    this.requestId = requestId;
    this.remoteMessage = remoteMessage;
    gitLabRequestErrors.add(this);
  }
}

export function isGitLabRequestError(error: unknown): error is GitLabRequestError {
  return (typeof error === "object" || typeof error === "function") &&
    error !== null && gitLabRequestErrors.has(error);
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

export function normalizeGitLabOrigin(value: string, _allowInsecureLoopback = false): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw gitLabError("GITLAB_ERROR", "GitLab origin is invalid", "invalid origin");
  }
  if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
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

// Keep only GitLab's short error fields; raw bodies and headers are never diagnostics.
function responseErrorMessage(body: Uint8Array, reflectsCredential: (value: string) => boolean): string | null {
  if (body.byteLength > MAX_ERROR_MESSAGE_BYTES) return null;
  try {
    const data = parseStrictResponseJson(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
    const value = data.message ?? data.error_description ?? data.error;
    const text = typeof value === "string" ? value
      : Array.isArray(value) && value.every(item => typeof item === "string") ? value.join("; ")
      : value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.entries(value).map(([key, detail]) => typeof detail === "string" ? key + ": " + detail
          : Array.isArray(detail) && detail.every(item => typeof item === "string") ? key + ": " + detail.join("; ") : "").filter(Boolean).join("; ")
        : "";
    if (text === "" || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) ||
        SECRET_DIAGNOSTIC.test(text) || reflectsCredential(text)) return null;
    const normalized = text.replace(/\s+/gu, " ").trim();
    return SECRET_DIAGNOSTIC.test(normalized) || reflectsCredential(normalized) ? null : normalized.slice(0, 512) || null;
  } catch { return null; }
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
    return normalized === "" || SECRET_DIAGNOSTIC.test(normalized) || this.reflectsCredential(normalized) ? null : normalized;
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
    } catch (error) {
      if (isGitLabCredentialError(error)) throw error;
      throw new GitLabCredentialError("source-unavailable");
    }
    if (typeof token !== "string" || token === "" || token !== token.trim() ||
        token.length > MAX_TOKEN_LENGTH || /[\r\n\u0000]/u.test(token)) {
      throw new GitLabCredentialError("token-invalid");
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
    } catch (error) {
      const name = typeof error === "object" && error !== null && "name" in error
        ? String(error.name)
        : "";
      throw new GitLabRequestError(name === "AbortError" ? "timeout" : "network", null, null);
    }
    if (!Number.isSafeInteger(response.status) || response.status < 100 || response.status > 599 ||
        !(response.body instanceof Uint8Array) || response.body.byteLength > this.maxResponseBytes ||
        response.headers === null || typeof response.headers !== "object" || Array.isArray(response.headers)) {
      throw new GitLabRequestError("response", null, null);
    }
    const headers = normalizeHeaders(response.headers, (value) => this.reflectsCredential(value));
    const requestId = headers["x-request-id"] === undefined
      ? null
      : this.sanitizeRequestId(headers["x-request-id"]);
    if (response.status === 401 || response.status === 403) {
      throw new GitLabRequestError("auth", response.status, requestId, responseErrorMessage(response.body, value => this.reflectsCredential(value)));
    }
    if (response.status < 200 || response.status >= 300) {
      throw new GitLabRequestError("http", response.status, requestId, responseErrorMessage(response.body, value => this.reflectsCredential(value)));
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    } catch {
      throw new GitLabRequestError("response", response.status, requestId);
    }
    let data: JsonValue;
    try {
      data = parseStrictResponseJson(text);
    } catch {
      throw new GitLabRequestError("response", response.status, requestId);
    }
    return Object.freeze({ data, headers, requestId, status: response.status });
  }
}
