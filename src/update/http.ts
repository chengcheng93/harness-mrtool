import { MAX_SIGNED_ENVELOPE_BYTES, updateSecurityError } from "./envelope.ts";

const ORDINARY_CONNECT_TIMEOUT_MS = 1_000;
const ORDINARY_TOTAL_TIMEOUT_MS = 2_000;
const FORCE_TOTAL_TIMEOUT_MS = 15_000;
const FORCE_BACKOFF_MS = [250, 750] as const;

export interface ChannelHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly connectTimeoutMs: number;
  readonly totalTimeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface ChannelHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface ChannelHttpTransport {
  request(request: ChannelHttpRequest): Promise<ChannelHttpResponse>;
}

class ChannelTransportError extends Error {
  constructor(readonly reason: "network" | "timeout" | "response-too-large") {
    super("Channel transport failed safely");
    this.name = "ChannelTransportError";
  }
}

export interface ChannelValidators {
  readonly etag: string | null;
  readonly lastModified: string | null;
}

export interface ChannelClock {
  now(): number;
}

export interface StableChannelCheckOptions {
  readonly url: string;
  readonly transport?: ChannelHttpTransport;
  readonly validators: ChannelValidators;
  readonly force: boolean;
  readonly clock?: ChannelClock;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export type StableChannelCheckResult =
  | {
      readonly kind: "not-modified";
      readonly validators: ChannelValidators;
      readonly attempts: number;
    }
  | {
      readonly kind: "changed";
      readonly envelope: Uint8Array;
      readonly validators: ChannelValidators;
      readonly attempts: number;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "network" | "rate-limited" | "server";
      readonly attempts: number;
    }
  | {
      readonly kind: "security-anomaly";
      readonly reason: "invalid-response";
      readonly attempts: number;
    };

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

const systemClock: ChannelClock = { now: () => Date.now() };

function canonicalUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw updateSecurityError("envelope is invalid");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.port !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.pathname === "/" ||
    parsed.href !== value
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return parsed.href;
}

function validHeader(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 &&
    !/[\r\n\u0000]/u.test(value);
}

function validators(value: ChannelValidators): ChannelValidators {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).sort().join(",") !== "etag,lastModified" ||
    (value.etag !== null && !validHeader(value.etag)) ||
    (value.lastModified !== null && !validHeader(value.lastModified))
  ) {
    throw updateSecurityError("envelope is invalid");
  }
  return Object.freeze({ etag: value.etag, lastModified: value.lastModified });
}

function requestHeaders(value: ChannelValidators): Readonly<Record<string, string>> {
  return Object.freeze({
    accept: "application/json",
    ...(value.etag === null ? {} : { "if-none-match": value.etag }),
    ...(value.lastModified === null ? {} : { "if-modified-since": value.lastModified }),
    "user-agent": "harness-mrtool",
  });
}

function responseHeaders(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const normalized: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, header] of Object.entries(value)) {
    if (!/^[A-Za-z0-9-]+$/u.test(name) || !validHeader(header)) return null;
    const lower = name.toLowerCase();
    if (Object.hasOwn(normalized, lower)) return null;
    normalized[lower] = header;
  }
  return Object.freeze(normalized);
}

function nextValidators(
  current: ChannelValidators,
  headers: Readonly<Record<string, string>>,
): ChannelValidators | null {
  const etag = headers.etag ?? current.etag;
  const lastModified = headers["last-modified"] ?? current.lastModified;
  if ((etag !== null && !validHeader(etag)) ||
      (lastModified !== null && !validHeader(lastModified))) return null;
  return Object.freeze({ etag, lastModified });
}

function validateResponse(value: ChannelHttpResponse): {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
} | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    !Number.isSafeInteger(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    !(value.body instanceof Uint8Array) ||
    value.body.byteLength > MAX_SIGNED_ENVELOPE_BYTES
  ) {
    return null;
  }
  const headers = responseHeaders(value.headers);
  return headers === null ? null : { status: value.status, headers, body: value.body };
}

async function readBounded(response: Response, limit: number): Promise<Uint8Array> {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ChannelTransportError("response-too-large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export const nodeChannelHttpTransport: ChannelHttpTransport = Object.freeze({
  async request(request: ChannelHttpRequest): Promise<ChannelHttpResponse> {
    const controller = new AbortController();
    const totalTimeout = setTimeout(() => controller.abort(), request.totalTimeoutMs);
    const connectTimeout = setTimeout(() => controller.abort(), request.connectTimeoutMs);
    totalTimeout.unref();
    connectTimeout.unref();
    try {
      let response: Response;
      try {
        response = await fetch(request.url, {
          method: "GET",
          headers: request.headers,
          redirect: "error",
          signal: controller.signal,
        });
      } catch (error) {
        throw new ChannelTransportError(
          typeof error === "object" && error !== null && "name" in error &&
              String(error.name) === "AbortError"
            ? "timeout"
            : "network",
        );
      } finally {
        clearTimeout(connectTimeout);
      }
      const headers: Record<string, string> = Object.create(null) as Record<string, string>;
      response.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
      return {
        status: response.status,
        headers,
        body: await readBounded(response, request.maxResponseBytes),
      };
    } finally {
      clearTimeout(connectTimeout);
      clearTimeout(totalTimeout);
    }
  },
});

export async function checkStableChannel(
  options: StableChannelCheckOptions,
): Promise<StableChannelCheckResult> {
  const url = canonicalUrl(options.url);
  const currentValidators = validators(options.validators);
  const transport = options.transport ?? nodeChannelHttpTransport;
  const clock = options.clock ?? systemClock;
  const sleep = options.sleep ?? defaultSleep;
  const force = options.force;
  const totalBudget = force ? FORCE_TOTAL_TIMEOUT_MS : ORDINARY_TOTAL_TIMEOUT_MS;
  const started = clock.now();
  if (!Number.isSafeInteger(started) || started < 0) throw updateSecurityError("envelope is invalid");
  let lastObserved = started;
  const observe = (): number => {
    const now = clock.now();
    if (!Number.isSafeInteger(now) || now < lastObserved) {
      throw updateSecurityError("envelope is invalid");
    }
    lastObserved = now;
    return now;
  };
  const retryWithinBudget = async (backoffMs: number): Promise<boolean> => {
    const beforeSleep = observe();
    const remaining = totalBudget - (beforeSleep - started);
    if (remaining < 1) return false;
    await sleep(Math.min(backoffMs, remaining));
    const afterSleep = observe();
    return totalBudget - (afterSleep - started) > 0;
  };
  const maximumAttempts = force ? 3 : 1;

  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    const now = observe();
    const remaining = totalBudget - (now - started);
    if (remaining < 1) {
      return { kind: "unavailable", reason: "network", attempts: attempt - 1 };
    }
    let raw: ChannelHttpResponse;
    try {
      raw = await transport.request(Object.freeze({
        url,
        headers: requestHeaders(currentValidators),
        connectTimeoutMs: Math.min(ORDINARY_CONNECT_TIMEOUT_MS, remaining),
        totalTimeoutMs: remaining,
        maxResponseBytes: MAX_SIGNED_ENVELOPE_BYTES,
      }));
    } catch (error) {
      if (error instanceof ChannelTransportError && error.reason === "response-too-large") {
        return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
      }
      if (attempt < maximumAttempts) {
        if (await retryWithinBudget(FORCE_BACKOFF_MS[attempt - 1]!)) continue;
      }
      return { kind: "unavailable", reason: "network", attempts: attempt };
    }
    if (totalBudget - (observe() - started) < 1) {
      return { kind: "unavailable", reason: "network", attempts: attempt };
    }
    const response = validateResponse(raw);
    if (response === null) {
      return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt < maximumAttempts) {
        if (await retryWithinBudget(FORCE_BACKOFF_MS[attempt - 1]!)) continue;
      }
      return {
        kind: "unavailable",
        reason: response.status === 429 ? "rate-limited" : "server",
        attempts: attempt,
      };
    }
    const updatedValidators = nextValidators(currentValidators, response.headers);
    if (updatedValidators === null) {
      return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
    }
    if (response.status === 304) {
      if (response.body.byteLength !== 0) {
        return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
      }
      return { kind: "not-modified", validators: updatedValidators, attempts: attempt };
    }
    if (response.status === 200) {
      if (response.body.byteLength === 0) {
        return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
      }
      return {
        kind: "changed",
        envelope: Uint8Array.from(response.body),
        validators: updatedValidators,
        attempts: attempt,
      };
    }
    return { kind: "security-anomaly", reason: "invalid-response", attempts: attempt };
  }
  return { kind: "unavailable", reason: "network", attempts: maximumAttempts };
}
