import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

import { ToolError } from "../../src/contracts/errors.ts";
import { ASSET_UPDATE_BUDGET_MS } from "../../src/update/download.ts";
import { createProductionReleaseSource } from "../../src/update/production-release-source.ts";
import { PRODUCTION_UPDATE_REPOSITORY } from "../../src/update/trust-config.ts";

const repository = PRODUCTION_UPDATE_REPOSITORY;
const payload = new TextEncoder().encode("authenticated release content\n");
const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const asset = { name: "harness-mrtool-linux-x64", size: payload.length, sha256: hash(payload) };
const request = { repository, tag: "cli-v1.2.3", asset };
const base = `https://github.com/${repository.owner}/${repository.name}/releases/download/`;
const secret = "DO-NOT-LEAK-signed-query-token";

type Source = ReturnType<typeof createProductionReleaseSource>;
type AssetRequest = Parameters<Source["downloadAsset"]>[0];

function rejected(error: unknown): boolean {
  assert.ok(error instanceof ToolError);
  assert.equal(error.code, "UPDATE_SECURITY_ERROR");
  assert.equal(error.cause, undefined);
  assert.doesNotMatch(`${error.message}${JSON.stringify(error.details)}${error.stack}`, new RegExp(secret));
  return true;
}

function stream(parts: readonly Uint8Array[] = [payload], headers?: HeadersInit) {
  let pulls = 0;
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[pulls++];
      if (part === undefined) controller.close();
      else controller.enqueue(part);
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }), { status: 200, ...(headers === undefined ? {} : { headers }) });
  return { response, pulls: () => pulls, cancelled: () => cancelled };
}

function fixture(handler: (url: string, init: RequestInit, index: number) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const source = createProductionReleaseSource({ fetch: async (input, init) => {
    assert.ok(init);
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init, calls.length - 1);
  } });
  return { source, calls };
}

test("construction is inert and exact signed bytes use the fixed HTTPS release URL", async () => {
  const f = fixture(() => stream([payload.subarray(0, 4), payload.subarray(4)], {
    "content-length": String(payload.length),
  }).response);
  assert.equal(f.calls.length, 0);
  assert.ok(Object.isFrozen(f.source));
  assert.deepEqual(await f.source.downloadAsset(request), payload);
  assert.equal(f.calls[0]?.url, `${base}cli-v1.2.3/${asset.name}`);
  const init = f.calls[0]!.init;
  assert.equal(init.method, "GET");
  assert.equal(init.redirect, "manual");
  assert.equal(init.credentials, "omit");
  assert.equal(init.referrerPolicy, "no-referrer");
  assert.equal(new Headers(init.headers).has("authorization"), false);
  assert.equal(new Headers(init.headers).has("cookie"), false);
  assert.ok(init.signal?.aborted, "finished request releases its controller");
});

for (const tag of ["cli-v1.2.3", "templates-v0.1.0-rc.1", "skill-v2.0.0+build.7"]) {
  test(`canonical component tag ${tag} is supported`, async () => {
    const f = fixture(() => stream().response);
    assert.deepEqual(await f.source.downloadAsset({ ...request, tag }), payload);
    assert.equal(f.calls[0]?.url, `${base}${encodeURIComponent(tag)}/${asset.name}`);
  });
}

test("trusted composition may pin a different repository, copied at construction", async () => {
  const configured = { owner: "trusted-owner", name: "release.repo" };
  const urls: string[] = [];
  const source = createProductionReleaseSource({ repository: configured, fetch: async (url) => {
    urls.push(String(url));
    return stream().response;
  } });
  configured.owner = "changed";
  await source.downloadAsset({ ...request, repository: { owner: "trusted-owner", name: "release.repo" } });
  assert.equal(urls[0], `https://github.com/trusted-owner/release.repo/releases/download/${request.tag}/${asset.name}`);
  await assert.rejects(source.downloadAsset(request), rejected);
  assert.equal(urls.length, 1);
});

const invalidRequests: readonly [string, unknown][] = [
  ["null request", null], ["missing request", undefined], ["missing repository", { ...request, repository: null }],
  ["foreign owner", { ...request, repository: { ...repository, owner: "attacker" } }],
  ["foreign name", { ...request, repository: { ...repository, name: "attacker" } }],
  ...["v1.2.3", "CLI-v1.2.3", "cli-v01.2.3", "cli-v1.2", "cli-v1.2.3 ",
    "templates-v1.2.3/other", "skill-v1.2.3?token", "cli-v1.2.3#x", "cli-v1.2.3-01", null]
    .map((tag): [string, unknown] => [`tag ${String(tag)}`, { ...request, tag }]),
  ...["", ".", "..", "../asset", "a/b", "a\\b", "a?token", "a#hash", "%2e%2e", "a%2fb", "a\n", "a ", "a:b", "é", "a".repeat(129), null]
    .map((name): [string, unknown] => [`basename ${String(name)}`, { ...request, asset: { ...asset, name } }]),
  ...[0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "12", null]
    .map((size): [string, unknown] => [`size ${String(size)}`, { ...request, asset: { ...asset, size } }]),
  ...["", "a".repeat(63), "G".repeat(64), asset.sha256.toUpperCase(), `${asset.sha256}\n`, null]
    .map((sha256): [string, unknown] => [`hash ${String(sha256)}`, { ...request, asset: { ...asset, sha256 } }]),
  ["missing asset", { ...request, asset: null }],
];
for (const [label, input] of invalidRequests) {
  test(`bad input does zero network: ${label}`, async () => {
    const f = fixture(() => { throw new Error("must not fetch"); });
    await assert.rejects(f.source.downloadAsset(input as AssetRequest), rejected);
    assert.equal(f.calls.length, 0);
  });
}

for (const [tag, cap] of [["cli-v1.2.3", 256 * 1024 * 1024], ["templates-v1.2.3", 32 * 1024 * 1024], ["skill-v1.2.3", 16 * 1024 * 1024]] as const) {
  test(`${tag} cap rejects before fetch; exact cap is admissible`, async () => {
    const f = fixture(() => new Response(null, { status: 404 }));
    await assert.rejects(f.source.downloadAsset({ ...request, tag, asset: { ...asset, size: cap + 1 } }), rejected);
    assert.equal(f.calls.length, 0);
    await assert.rejects(f.source.downloadAsset({ ...request, tag, asset: { ...asset, size: cap } }), rejected);
    assert.equal(f.calls.length, 1);
  });
}

for (const part of ["../evil", "bad/name", "bad?name", "bad@name", "", "a\n"]) {
  test(`invalid configured repository ${JSON.stringify(part)} fails before network`, () => {
    assert.throws(() => createProductionReleaseSource({ repository: { owner: part, name: "release" },
      fetch: async () => { assert.fail("must not fetch"); },
    }), rejected);
  });
}

for (const status of [301, 302, 303, 307, 308]) {
  test(`manually follows allowlisted ${status}, cancels body and retains one signal`, async () => {
    const redirectBody = stream();
    const location = `https://release-assets.githubusercontent.com/github-production-release-asset/123/a?token=${secret}`;
    const redirect = new Response(redirectBody.response.body, { status, headers: { location } });
    const f = fixture((_url, _init, index) => index === 0 ? redirect : stream().response);
    assert.deepEqual(await f.source.downloadAsset(request), payload);
    assert.equal(redirectBody.cancelled(), true);
    assert.equal(redirectBody.pulls(), 0);
    assert.equal(f.calls[1]?.url, location);
    assert.equal(f.calls[1]?.init.signal, f.calls[0]?.init.signal);
  });
}

test("three redirects across both exact asset hosts are permitted", async () => {
  const urls = ["https://objects.githubusercontent.com/a", "https://release-assets.githubusercontent.com/b", "https://objects.githubusercontent.com/c"];
  const f = fixture((_url, _init, index) => index < 3
    ? new Response(null, { status: 302, headers: { location: urls[index]! } }) : stream().response);
  assert.deepEqual(await f.source.downloadAsset(request), payload);
  assert.equal(f.calls.length, 4);
});

for (const location of ["http://objects.githubusercontent.com/a", "https://evil.example/a", "https://objects.githubusercontent.com.evil.example/a", "https://github.com/other/repo/a", "https://user:pass@objects.githubusercontent.com/a", "https://objects.githubusercontent.com:444/a", "https://objects.githubusercontent.com/a#fragment", "file:///tmp/a", "//127.0.0.1/a", "/relative", "https://[invalid"]) {
  test(`rejects redirect without contacting destination: ${location}`, async () => {
    const body = stream();
    const f = fixture(() => new Response(body.response.body, { status: 302, headers: { location } }));
    await assert.rejects(f.source.downloadAsset(request), rejected);
    assert.equal(f.calls.length, 1);
    assert.equal(body.cancelled(), true);
    assert.equal(body.pulls(), 0);
  });
}

test("redirect loops stop at three hops; missing location is rejected", async () => {
  const f = fixture(() => new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/loop" } }));
  await assert.rejects(f.source.downloadAsset(request), rejected);
  assert.equal(f.calls.length, 4);
  const missing = fixture(() => new Response(null, { status: 302 }));
  await assert.rejects(missing.source.downloadAsset(request), rejected);
  assert.equal(missing.calls.length, 1);
});

for (const status of [404, 401, 403, 429, 500, 206]) {
  test(`HTTP ${status} is a sanitized typed failure without reading the body`, async () => {
    const body = stream([new TextEncoder().encode(secret)]);
    const f = fixture(() => new Response(body.response.body, { status }));
    await assert.rejects(f.source.downloadAsset(request), rejected);
    assert.equal(body.pulls(), 0);
    assert.equal(body.cancelled(), true);
  });
}

for (const length of ["99999999999999999999", String(payload.length + 1), String(payload.length - 1), "-1", "1.2", "garbage", "1e2", "0"]) {
  test(`content-length ${length} is rejected before buffering`, async () => {
    const body = stream([payload], { "content-length": length });
    const f = fixture(() => body.response);
    await assert.rejects(f.source.downloadAsset(request), rejected);
    assert.equal(body.pulls(), 0);
    assert.equal(body.cancelled(), true);
  });
}

test("absent body, zero length, short body, and equal-size wrong hash fail", async () => {
  for (const response of [new Response(null), stream([]).response, stream([payload.subarray(1)]).response,
    stream([new Uint8Array(payload.length)]).response]) {
    const f = fixture(() => response);
    await assert.rejects(f.source.downloadAsset(request), rejected);
  }
});

test("missing or lying length never permits buffering past signed size", async () => {
  for (const headers of [undefined, { "content-length": String(payload.length) }]) {
    const body = stream([payload, new Uint8Array([1]), new Uint8Array([2])], headers);
    const f = fixture(() => body.response);
    await assert.rejects(f.source.downloadAsset(request), rejected);
    assert.equal(body.pulls(), 2, "stops at first over-limit chunk");
    assert.equal(body.cancelled(), true);
  }
});

test("fetch and stream exceptions cannot leak URLs, credentials, or causes", async () => {
  const transport = fixture(() => { throw new Error(secret); });
  await assert.rejects(transport.source.downloadAsset(request), rejected);
  const failed = fixture(() => new Response(new ReadableStream({ pull(controller) { controller.error(new Error(secret)); } })));
  await assert.rejects(failed.source.downloadAsset(request), rejected);
});

test("descriptor is snapshotted before awaiting fetch", async () => {
  const mutable = { ...request, asset: { ...asset } };
  const f = fixture(() => {
    mutable.asset.size = 1;
    mutable.asset.sha256 = "0".repeat(64);
    return stream().response;
  });
  assert.deepEqual(await f.source.downloadAsset(mutable), payload);
});

test("receipt uses only fixed name and templates tag, returning uninterpreted bytes", async () => {
  const f = fixture(() => stream().response);
  assert.deepEqual(await f.source.downloadTemplateReceipt({ repository, tag: "templates-v1.2.3" }), payload);
  assert.equal(f.calls[0]?.url, `${base}templates-v1.2.3/bundle-receipt.envelope.json`);
  for (const tag of ["cli-v1.2.3", "skill-v1.2.3", "templates-v01.2.3"]) {
    await assert.rejects(f.source.downloadTemplateReceipt({ repository, tag }), rejected);
  }
  await assert.rejects(f.source.downloadTemplateReceipt({ repository: { owner: "wrong", name: "wrong" }, tag: "templates-v1.2.3" }), rejected);
  assert.equal(f.calls.length, 1);
});

test("receipt enforces 256 KiB on headers and streamed bytes, with exact cap accepted", async () => {
  const input = { repository, tag: "templates-v1.2.3" };
  const full = new Uint8Array(256 * 1024);
  const good = fixture(() => stream([full]).response);
  assert.deepEqual(await good.source.downloadTemplateReceipt(input), full);
  const header = stream([payload], { "content-length": String(full.length + 1) });
  await assert.rejects(fixture(() => header.response).source.downloadTemplateReceipt(input), rejected);
  assert.equal(header.pulls(), 0);
  const body = stream([full, new Uint8Array([1]), new Uint8Array([2])]);
  await assert.rejects(fixture(() => body.response).source.downloadTemplateReceipt(input), rejected);
  assert.equal(body.pulls(), 2);
  assert.equal(body.cancelled(), true);
  await assert.rejects(fixture(() => stream([]).response).source.downloadTemplateReceipt(input), rejected);
});

test("global deadline bounds a fetch ignoring abort and cancels a late response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finish!: (response: Response) => void;
  const f = fixture(() => new Promise<Response>((resolve) => { finish = resolve; }));
  const pending = assert.rejects(f.source.downloadAsset(request), rejected);
  t.mock.timers.tick(ASSET_UPDATE_BUDGET_MS);
  await pending;
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
  const late = stream();
  finish(late.response);
  await setImmediate();
  assert.equal(late.cancelled(), true);
  assert.equal(late.pulls(), 0);
});

test("one budget spans delayed redirects and a stalled body, including hung cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let finishRedirect!: (response: Response) => void;
  let cancelled = false;
  const f = fixture((_url, _init, index) => index === 0
    ? new Promise<Response>((resolve) => { finishRedirect = resolve; })
    : new Response(new ReadableStream<Uint8Array>({
      pull() { return new Promise<void>(() => undefined); },
      cancel() { cancelled = true; return new Promise<void>(() => undefined); },
    }, { highWaterMark: 0 })));
  const pending = assert.rejects(f.source.downloadAsset(request), rejected);
  t.mock.timers.tick(ASSET_UPDATE_BUDGET_MS - 1);
  finishRedirect(new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/a" } }));
  await setImmediate();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0]?.init.signal, f.calls[1]?.init.signal);
  assert.equal(f.calls[1]?.init.signal?.aborted, false);
  t.mock.timers.tick(1);
  await pending;
  assert.equal(f.calls[1]?.init.signal?.aborted, true);
  assert.equal(cancelled, true);
});

test("untrusted redirect cancellation cannot stall a successful download", async () => {
  const body = new ReadableStream<Uint8Array>({ cancel() { return new Promise<void>(() => undefined); } }, { highWaterMark: 0 });
  const f = fixture((_url, _init, index) => index === 0
    ? new Response(body, { status: 302, headers: { location: "https://objects.githubusercontent.com/a" } })
    : stream().response);
  assert.deepEqual(await f.source.downloadAsset(request), payload);
});

for (const metadata of [{ redirected: true }, { url: `https://evil.example/${secret}` }]) {
  test(`auto-followed or misdirected transport response is rejected: ${Object.keys(metadata)[0]}`, async () => {
    const body = stream();
    for (const [key, value] of Object.entries(metadata)) Object.defineProperty(body.response, key, { value });
    const f = fixture(() => body.response);
    await assert.rejects(f.source.downloadAsset(request), rejected);
    assert.equal(body.pulls(), 0);
    assert.equal(body.cancelled(), true);
    assert.equal(f.calls.length, 1);
  });
}

test("receipt follows allowed redirects but rejects truncated advertised bytes", async () => {
  const input = { repository, tag: "templates-v1.2.3" };
  const f = fixture((_url, _init, index) => index === 0
    ? new Response(null, { status: 307, headers: { location: "https://objects.githubusercontent.com/receipt" } })
    : stream().response);
  assert.deepEqual(await f.source.downloadTemplateReceipt(input), payload);
  const truncated = fixture(() => stream([payload], { "content-length": String(payload.length + 1) }).response);
  await assert.rejects(truncated.source.downloadTemplateReceipt(input), rejected);
});

test("receipt deadline also bounds stalled response headers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(() => new Promise<Response>(() => undefined));
  const pending = assert.rejects(f.source.downloadTemplateReceipt({ repository, tag: "templates-v1.2.3" }), rejected);
  t.mock.timers.tick(ASSET_UPDATE_BUDGET_MS);
  await pending;
  assert.equal(f.calls[0]?.init.signal?.aborted, true);
});

test("invalid receipt request shapes perform zero network", async () => {
  const f = fixture(() => { throw new Error("must not fetch"); });
  for (const input of [null, undefined, {}, { tag: "templates-v1.2.3" }, { repository, tag: null }]) {
    await assert.rejects(f.source.downloadTemplateReceipt(input as unknown as Parameters<Source["downloadTemplateReceipt"]>[0]), rejected);
  }
  assert.equal(f.calls.length, 0);
});

test("non-byte chunks are rejected and zero-byte chunks do not excuse an empty body", async () => {
  const nonBytes = new Response(new ReadableStream({ start(controller) { controller.enqueue(secret); controller.close(); } }));
  await assert.rejects(fixture(() => nonBytes).source.downloadAsset(request), rejected);
  await assert.rejects(fixture(() => stream([new Uint8Array()]).response).source.downloadAsset(request), rejected);
  assert.deepEqual(await fixture(() => stream([new Uint8Array(), payload]).response).source.downloadAsset(request), payload);
});
