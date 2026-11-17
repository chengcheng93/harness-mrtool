import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {execFile} from "node:child_process";
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {basename, dirname, resolve} from "node:path";
import test from "node:test";
import {UpdateCache} from "../../src/update/cache.ts";
import {createProductionInstallationService} from "../../src/update/production-installation-service.ts";
import {authenticateReleaseSnapshot, createAuthenticatedReleaseSnapshot, createReleaseSetSnapshotVerifier} from "../../src/update/release-set-verifier.ts";
import {exactReleaseFixture} from "../helpers/default-historical-fixture.ts";
import {nativeReleaseFixtureFamily} from "../helpers/native-release-fixture.ts";
import {canonicalPayload, signedEnvelope} from "../helpers/signing.ts";

const acl = {verify: async (_path: string) => undefined};
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function writeInstallerMarker(root: string, path: string, marker: Record<string, unknown>) {
  if (process.platform !== "win32") {
    await writeFile(path, JSON.stringify(marker), {mode: 0o600});
    return;
  }
  const input = resolve(root, "installer-marker-input.json"), script = resolve(root, "installer-marker.ps1");
  await writeFile(input, JSON.stringify(marker));
  await writeFile(script, "param([string]$InputPath, [string]$OutputPath)\n$ErrorActionPreference = \"Stop\"\n$inputValue = Get-Content -LiteralPath $InputPath -Raw | ConvertFrom-Json\n$marker = [ordered]@{ schemaVersion = 1; repository = $inputValue.repository; tag = $inputValue.tag; archiveSha256 = $inputValue.archiveSha256; executableSha256 = $inputValue.executableSha256 }\n[IO.File]::WriteAllText($OutputPath, ($marker | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))\n");
  await new Promise<void>((done, reject) => execFile(resolve(process.env.SystemRoot ?? "C:/Windows", "System32/WindowsPowerShell/v1.0/powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-InputPath", input, "-OutputPath", path],
    {windowsHide: true}, error => error === null ? done() : reject(error)));
}

async function fixture(t: test.TestContext, mutation: string | null = null) {
  const origin = await exactReleaseFixture();
  const family = nativeReleaseFixtureFamily(origin);
  const platform = process.platform === "win32" ? "windows-x64" : "darwin-arm64";
  const candidate = await family(platform, {sequence: 44, cliVersion: "0.1.14", variantByte: 2, releaseSetId: "stable-0.1.14"});
  const snapshot = await createAuthenticatedReleaseSnapshot(candidate.options);
  const authenticated = await authenticateReleaseSnapshot(snapshot, {platform, trustConfig: origin.trustConfig});
  const parent = await import("node:fs/promises").then(fs => fs.realpath(tmpdir()));
  const root = await mkdtemp(resolve(parent, "mrtool-initial-enrollment-"));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    assert.ok(basename(root).startsWith("mrtool-initial-enrollment-"));
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const info = await lstat(current);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await chmod(current, 0o700);
        for (const entry of await readdir(current)) pending.push(resolve(current, entry));
      } else {
        await chmod(current, 0o600).catch(() => undefined);
      }
    }
    await rm(root, {recursive: true, force: true, maxRetries: 3});
  });
  const stateDirectory = resolve(root, "state");
  const installationDirectory = resolve(root, "installation");
  await mkdir(installationDirectory, {mode: 0o700});
  const executablePath = resolve(installationDirectory, authenticated.executableName);
  const markerPath = resolve(installationDirectory, ".harness-mrtool-install.json");
  let bytes = authenticated.executableBytes;
  let marker = {schemaVersion: 1, repository: origin.trustConfig.repository.owner + "/" + origin.trustConfig.repository.name,
    tag: "cli-v0.1.14", archiveSha256: snapshot.record.cliSha256, executableSha256: hash(bytes)};
  if (mutation === "old") {
    const old = await nativeReleaseFixtureFamily(origin)(platform, {sequence: 43, cliVersion: "0.1.10", variantByte: 1, releaseSetId: "stable-0.1.10"});
    const oldSnapshot = await createAuthenticatedReleaseSnapshot(old.options);
    const oldAuth = await authenticateReleaseSnapshot(oldSnapshot, {platform, trustConfig: origin.trustConfig});
    bytes = oldAuth.executableBytes;
    marker = {...marker, tag: "cli-v0.1.10", archiveSha256: oldSnapshot.record.cliSha256, executableSha256: hash(bytes)};
  }
  if (mutation === "tampered") bytes = Buffer.concat([bytes, Buffer.from("tampered")]);
  if (mutation === "marker-hash") marker = {...marker, archiveSha256: "0".repeat(64)};
  await writeFile(executablePath, bytes, {mode: 0o700});
  if (mutation !== "missing-marker") await writeInstallerMarker(root, markerPath, marker);
  const beforeExecutable = await readFile(executablePath);
  const beforeMarker = await readFile(markerPath).catch(() => null);
  const envelope = signedEnvelope(canonicalPayload(candidate.payload), [origin.signingKey]);
  const newer = mutation === "stale-channel" ? await family(platform, {sequence: 45, cliVersion: "0.1.15", variantByte: 3, releaseSetId: "stable-0.1.15"}) : null;
  let channelReads = 0;
  const service = createProductionInstallationService({stateDirectory, installationDirectory, platform,
    trustConfig: origin.trustConfig, windowsAclVerifier: acl,
    channelUrl: "https://fixture.example.test/stable.envelope.json",
    transport: {async request() { channelReads++; return {status: 200, headers: {}, body: Buffer.from(
      newer !== null && channelReads >= 3 ? signedEnvelope(canonicalPayload(newer.payload), [origin.signingKey]) : envelope)}; }},
    fetch: async url => new Response(Buffer.from(String(url).endsWith("harness-mr-templates.zip") ? candidate.options.templateArchive
      : String(url).endsWith("bundle-receipt.envelope.json") ? candidate.options.templateReceipt : candidate.options.cliArchive)),
  });
  const cache = new UpdateCache({stateDirectory, windowsAclVerifier: acl,
    verifySnapshot: createReleaseSetSnapshotVerifier({platform, trustConfig: origin.trustConfig})});
  return {root, stateDirectory, installationDirectory, executablePath, markerPath, beforeExecutable, beforeMarker, service, cache};
}

async function unchanged(f: Awaited<ReturnType<typeof fixture>>) {
  assert.deepEqual(await readFile(f.executablePath), f.beforeExecutable);
  assert.deepEqual(await readFile(f.markerPath).catch(() => null), f.beforeMarker);
}

test("an exact signed versioned installation enrolls once without replacing its executable", async t => {
  const f = await fixture(t);
  assert.equal(await f.cache.loadLastKnownGoodOrNull(), null);
  const result = await f.service.apply(true);
  assert.equal(result.status, "unchanged");
  if (result.status !== "unchanged") return;
  assert.equal(result.active.cliVersion, "0.1.14");
  assert.equal(result.observed.verification, "signed-installed-bytes");
  assert.equal((await f.cache.loadLastKnownGoodOrNull())?.record.cliVersion, "0.1.14");
  assert.equal(await lstat(resolve(f.stateDirectory, "installation-journal.json")).then(() => true, () => false), false);
  await unchanged(f);
  assert.equal((await f.service.apply(false)).status, "unchanged");
  await f.service.recover();
});

for (const mutation of ["old", "tampered", "marker-hash", "missing-marker"]) {
  test("initial enrollment rejects " + mutation + " installation without publishing an active cache", async t => {
    const f = await fixture(t, mutation);
    await assert.rejects(f.service.apply(true));
    assert.equal(await f.cache.loadLastKnownGoodOrNull(), null);
    await unchanged(f);
  });
}

test("initial enrollment rejects a channel that advances while preparing the candidate", async t => {
  const f = await fixture(t, "stale-channel");
  await assert.rejects(f.service.apply(true), {code: "CONCURRENT_UPDATE"});
  assert.equal(await f.cache.loadLastKnownGoodOrNull(), null);
  await unchanged(f);
});

test("rollback does not bootstrap an installation without an active predecessor", async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.rollback(), {code: "UPDATE_REQUIRED"});
  assert.equal(await f.cache.loadLastKnownGoodOrNull(), null);
  await unchanged(f);
});
