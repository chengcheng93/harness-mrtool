import { Unzip, UnzipInflate } from "fflate";
import { ASSET_UPDATE_BUDGET_MS, downloadBounded, validateArchiveEntries, type ArchiveEntry } from "./download.ts";
import { isCanonicalTemplateReleaseTag, updateSecurityError } from "./envelope.ts";
import type { HistoricalBundleReleaseAssetRequest, HistoricalBundleReleaseAssetSource } from "./historical-bundle-loader.ts";
import type { ReleaseRepository } from "./manifest.ts";
import { PRODUCTION_UPDATE_REPOSITORY } from "./trust-config.ts";

const TEMPLATE_ARCHIVE_NAME = "harness-mr-templates.zip";
const MAX_REDIRECTS = 3;
const RELEASE_ASSET_HOSTS = new Set(["release-assets.githubusercontent.com", "objects.githubusercontent.com"]);

export interface ProductionHistoricalBundleSourceOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Only an explicit trusted composition may supply a different repository. */
  readonly repository?: ReleaseRepository;
}

function fail(): never { throw updateSecurityError("envelope is invalid"); }

function safeRedirect(location: string, current: URL): URL {
  const next = new URL(location, current);
  if (next.protocol !== "https:" || next.username !== "" || next.password !== "" ||
      next.port !== "" || next.hash !== "" || !RELEASE_ASSET_HOSTS.has(next.hostname)) fail();
  return next;
}

async function asset(
  url: URL, maxBytes: number, fetcher: typeof globalThis.fetch,
): Promise<Uint8Array | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ASSET_UPDATE_BUDGET_MS);
  timer.unref();
  try {
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const response = await fetcher(url.href, {
        method: "GET", redirect: "manual", signal: controller.signal,
        headers: { accept: "application/octet-stream", "user-agent": "harness-mrtool" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        if (location === null || redirects === MAX_REDIRECTS) fail();
        url = safeRedirect(location, url);
        continue;
      }
      if (response.status === 404) { await response.body?.cancel(); return null; }
      const size = response.headers.get("content-length");
      if (response.status !== 200 || response.body === null ||
          (size !== null && (!/^\d+$/u.test(size) || Number(size) > maxBytes))) {
        await response.body?.cancel();
        fail();
      }
      const body = response.body;
      async function* chunks(): AsyncGenerator<Uint8Array> {
        const reader = body!.getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) break;
            yield item.value;
          }
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      }
      return await downloadBounded(chunks(), { maxBytes, budgetMs: ASSET_UPDATE_BUDGET_MS });
    }
    return fail();
  } finally { clearTimeout(timer); controller.abort(); }
}

/** Inspect central-directory types before in-memory decompression; never extract to disk. */
function archiveEntries(bytes: Uint8Array): readonly ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65_557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  if (end < 0 || end < bytes.length - 65_557 || view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0) fail();
  const count = view.getUint16(end + 10, true);
  const length = view.getUint32(end + 12, true);
  let cursor = view.getUint32(end + 16, true);
  if (count === 0 || count === 65_535 || count !== view.getUint16(end + 8, true) || cursor + length !== end) fail();
  const entries: ArchiveEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || view.getUint32(cursor, true) !== 0x02014b50) fail();
    const nameLength = view.getUint16(cursor + 28, true);
    const next = cursor + 46 + nameLength + view.getUint16(cursor + 30, true) + view.getUint16(cursor + 32, true);
    if (next > end || view.getUint16(cursor + 34, true) !== 0 || (view.getUint16(cursor + 8, true) & 1) !== 0) fail();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    const unixType = (view.getUint32(cursor + 38, true) >>> 16) & 0xf000;
    if (unixType !== 0 && unixType !== 0x8000 && unixType !== 0x4000) fail();
    const directory = name.endsWith("/");
    if ((unixType === 0x4000 && !directory) || (unixType === 0x8000 && directory)) fail();
    entries.push({ name, kind: directory ? "directory" : "file" });
    cursor = next;
  }
  if (cursor !== end) fail();
  return validateArchiveEntries(entries);
}

function unpack(bytes: Uint8Array, request: HistoricalBundleReleaseAssetRequest): ReadonlyMap<string, Uint8Array> {
  const entries = archiveEntries(bytes);
  const wanted = new Set(request.filePaths);
  const directories = new Set(request.filePaths.flatMap((path) => {
    const segments = path.split("/");
    return segments.slice(0, -1).map((_, index) => `${segments.slice(0, index + 1).join("/")}/`);
  }));
  if (entries.some((entry) => entry.kind === "directory" ? !directories.has(entry.name) : !wanted.has(entry.name)) ||
      entries.filter((entry) => entry.kind === "file").length !== wanted.size) fail();
  const kinds = new Map(entries.map((entry) => [entry.name, entry.kind]));
  const seen = new Set<string>();
  const completed = new Set<string>();
  const files = new Map<string, Uint8Array>();
  let total = 0;
  const unzip = new Unzip((file) => {
    const kind = kinds.get(file.name);
    if (kind === undefined || seen.has(file.name) || (file.compression !== 0 && file.compression !== 8)) fail();
    seen.add(file.name);
    const max = kind === "directory" ? 0 : file.name === "bundle-manifest.json" ? request.limits.manifestBytes : request.limits.payloadBytes;
    if (file.originalSize !== undefined && (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0 || file.originalSize > max)) fail();
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (error !== null) fail();
      size += chunk.byteLength;
      total += chunk.byteLength;
      if (size > max || total > request.limits.manifestBytes + request.limits.totalPayloadBytes) fail();
      chunks.push(Uint8Array.from(chunk));
      if (final) {
        if (file.originalSize !== undefined && size !== file.originalSize) fail();
        completed.add(file.name);
        if (kind === "file") {
          const contents = new Uint8Array(size);
          let offset = 0;
          for (const part of chunks) { contents.set(part, offset); offset += part.byteLength; }
          files.set(file.name, contents);
        }
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Small compressed input slices bound each inflation callback, even when ZIP
  // metadata lies about the output size. Never preallocate from attacker sizes.
  for (let offset = 0; offset < bytes.byteLength; offset += 1024) {
    const end = Math.min(offset + 1024, bytes.byteLength);
    unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
  }
  if (seen.size !== entries.length || completed.size !== entries.length || files.size !== wanted.size ||
      [...wanted].some((path) => !files.has(path))) fail();
  return files;
}

/** URLs derive solely from the pinned repository, canonical tag and fixed release asset names. */
export function createProductionHistoricalBundleSource(
  options: ProductionHistoricalBundleSourceOptions = {},
): HistoricalBundleReleaseAssetSource {
  const repository = Object.freeze({ ...(options.repository ?? PRODUCTION_UPDATE_REPOSITORY) });
  if (![repository.owner, repository.name].every((part) => /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u.test(part))) fail();
  const fetcher = options.fetch ?? globalThis.fetch;
  return Object.freeze({ async loadExact(request: HistoricalBundleReleaseAssetRequest) {
    if (request.repository.owner !== repository.owner || request.repository.name !== repository.name ||
        !isCanonicalTemplateReleaseTag(request.releaseTag) || request.releaseTag !== `templates-v${request.bundleVersion}` ||
        request.receiptAssetName !== "bundle-receipt.envelope.json") fail();
    const base = `https://github.com/${repository.owner}/${repository.name}/releases/download/${encodeURIComponent(request.releaseTag)}/`;
    const receiptEnvelope = await asset(new URL(request.receiptAssetName, base), request.limits.receiptEnvelopeBytes, fetcher);
    if (receiptEnvelope === null) return null;
    // ZIP overhead is bounded independently from the signed, uncompressed file limits.
    const archive = await asset(new URL(TEMPLATE_ARCHIVE_NAME, base), request.limits.manifestBytes + request.limits.totalPayloadBytes + 1024 * 1024, fetcher);
    if (archive === null) return null;
    return Object.freeze({ repository, releaseTag: request.releaseTag, receiptEnvelope, files: unpack(archive, request) });
  } });
}
