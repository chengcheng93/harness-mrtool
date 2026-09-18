import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { ToolError } from "../contracts/errors.ts";
import { ASSET_UPDATE_BUDGET_MS, downloadBounded } from "./download.ts";
import { requireCanonicalSemVer } from "./envelope.ts";
import type { ReleaseAsset, ReleaseRepository } from "./manifest.ts";
import { PRODUCTION_UPDATE_REPOSITORY } from "./trust-config.ts";

const REPOSITORY_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const ASSET_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMPONENT_LIMITS = { cli: 256 * 1024 * 1024, templates: 32 * 1024 * 1024, skill: 16 * 1024 * 1024 } as const;
const RECEIPT_NAME = "bundle-receipt.envelope.json";
const RECEIPT_LIMIT = 256 * 1024;
const MAX_REDIRECTS = 3;
const RELEASE_ASSET_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

export interface ProductionReleaseSourceOptions {
  /** Explicit trusted composition only; not a CLI, configuration, or environment input. */
  readonly repository?: ReleaseRepository;
  /** In-process transport seam; requests still use the fixed GitHub HTTPS origin. */
  readonly fetch?: typeof globalThis.fetch;
}

export interface ProductionReleaseRequest {
  readonly repository: ReleaseRepository;
  readonly tag: string;
}

export interface ProductionReleaseAssetRequest extends ProductionReleaseRequest {
  /** The caller must authenticate this descriptor before invoking the downloader. */
  readonly asset: ReleaseAsset;
}

export interface ProductionReleaseSource {
  readonly downloadAsset: (request: ProductionReleaseAssetRequest) => Promise<Uint8Array>;
  readonly downloadTemplateReceipt: (request: ProductionReleaseRequest) => Promise<Uint8Array>;
}

function fail(): never {
  throw new ToolError("UPDATE_SECURITY_ERROR", "Release asset download was rejected", {
    field: "update.asset",
    expected: "bounded bytes from the fixed release origin matching an authenticated descriptor",
    actual: "release asset rejected",
    safeNextStep: "Keep the last-known-good release set and retry from the fixed official update origin.",
  });
}

function component(tag: unknown): keyof typeof COMPONENT_LIMITS {
  if (typeof tag !== "string") return fail();
  const match = /^(cli|templates|skill)-v(.+)$/u.exec(tag);
  if (match === null || `${match[1]}-v${requireCanonicalSemVer(match[2])}` !== tag) return fail();
  return match[1] as keyof typeof COMPONENT_LIMITS;
}

function safeRedirect(location: string, current: URL): URL {
  const next = new URL(location, current);
  if (next.protocol !== "https:" || next.username !== "" || next.password !== "" ||
      next.port !== "" || next.hash !== "" || !RELEASE_ASSET_HOSTS.has(next.hostname)) fail();
  return next;
}

/** Cleanup must not extend the deadline, even for a stalled/hostile transport. */
function cancel(body: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array> | null): void {
  void body?.cancel().catch(() => undefined);
}

async function download(
  initialUrl: URL, maxBytes: number, fetcher: typeof globalThis.fetch, expected?: ReleaseAsset,
): Promise<Uint8Array> {
  const controller = new AbortController();
  const deadline = performance.now() + ASSET_UPDATE_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      // Do not expose abort/fetch errors, which can contain signed redirect URLs.
      try { fail(); } catch (error) { reject(error); }
    }, ASSET_UPDATE_BUDGET_MS);
  });

  async function transfer(): Promise<Uint8Array> {
    let url = initialUrl;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetcher(url.href, {
        method: "GET", redirect: "manual", credentials: "omit", referrerPolicy: "no-referrer",
        signal: controller.signal,
        headers: { accept: "application/octet-stream", "user-agent": "harness-mrtool" },
      });
      // A late response after timeout must never start another request or body read.
      if (controller.signal.aborted || performance.now() >= deadline || response.redirected ||
          (response.url !== "" && response.url !== url.href)) {
        cancel(response.body);
        fail();
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        cancel(response.body);
        const location = response.headers.get("location");
        if (location === null || redirects === MAX_REDIRECTS) fail();
        url = safeRedirect(location, url);
        continue;
      }
      const length = response.headers.get("content-length");
      const advertisedSize = length === null ? null : Number(length);
      if (response.status !== 200 || response.body === null ||
          (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(advertisedSize) ||
            advertisedSize! <= 0 || advertisedSize! > maxBytes ||
            (expected !== undefined && advertisedSize !== expected.size)))) {
        cancel(response.body);
        fail();
      }
      const remaining = Math.floor(deadline - performance.now());
      if (remaining <= 0) { cancel(response.body); fail(); }
      const bodyReader = response.body.getReader();
      reader = bodyReader;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        try {
          while (!controller.signal.aborted) {
            const item = await bodyReader.read();
            if (controller.signal.aborted) fail();
            if (item.done) return;
            yield item.value;
          }
          fail();
        } finally {
          cancel(bodyReader);
          bodyReader.releaseLock();
          reader = null;
        }
      }
      const bytes = await downloadBounded(chunks(), { maxBytes, budgetMs: remaining });
      if (controller.signal.aborted || performance.now() >= deadline ||
          (advertisedSize !== null && bytes.byteLength !== advertisedSize) ||
          (expected !== undefined && (bytes.byteLength !== expected.size ||
            createHash("sha256").update(bytes).digest("hex") !== expected.sha256))) fail();
      return bytes;
    }
    return fail();
  }

  try {
    return await Promise.race([transfer(), timeout]);
  } catch {
    return fail();
  } finally {
    clearTimeout(timer);
    controller.abort();
    cancel(reader);
  }
}

/**
 * Downloads content only: neither a signature verifier nor channel authority.
 * The caller authenticates descriptors and verifies returned receipt envelopes.
 */
export function createProductionReleaseSource(
  options: ProductionReleaseSourceOptions = {},
): ProductionReleaseSource {
  let repository: ReleaseRepository;
  let fetcher: typeof globalThis.fetch;
  try {
    repository = Object.freeze({ ...(options.repository ?? PRODUCTION_UPDATE_REPOSITORY) });
    if (![repository.owner, repository.name].every((part) => typeof part === "string" && REPOSITORY_PART.test(part))) fail();
    fetcher = options.fetch ?? globalThis.fetch;
    if (typeof fetcher !== "function") fail();
  } catch {
    return fail();
  }

  function releaseUrl(request: ProductionReleaseRequest, name: string): URL {
    if (request.repository?.owner !== repository.owner || request.repository?.name !== repository.name) fail();
    return new URL(`https://github.com/${repository.owner}/${repository.name}/releases/download/${encodeURIComponent(request.tag)}/${name}`);
  }

  return Object.freeze({
    async downloadAsset(request: ProductionReleaseAssetRequest): Promise<Uint8Array> {
      try {
        const cap = COMPONENT_LIMITS[component(request.tag)];
        // Copy before the first await so caller mutation cannot change verification.
        const asset = { ...request.asset };
        if (typeof asset.name !== "string" || !ASSET_NAME.test(asset.name) ||
            typeof asset.sha256 !== "string" || !SHA256.test(asset.sha256) ||
            !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > cap) fail();
        return await download(releaseUrl(request, asset.name), asset.size, fetcher, asset);
      } catch {
        return fail();
      }
    },
    async downloadTemplateReceipt(request: ProductionReleaseRequest): Promise<Uint8Array> {
      try {
        if (component(request.tag) !== "templates") fail();
        return await download(releaseUrl(request, RECEIPT_NAME), RECEIPT_LIMIT, fetcher);
      } catch {
        return fail();
      }
    },
  });
}
