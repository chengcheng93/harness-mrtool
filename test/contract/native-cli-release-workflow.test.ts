import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type Step = { name?: string; uses?: string; run?: string; shell?: string; if?: string;
  env?: Record<string, string>; with?: Record<string, string>; "continue-on-error"?: boolean };
type Job = { "runs-on": string; needs?: string | string[]; if?: string;
  env?: Record<string, string>; steps: Step[]; "continue-on-error"?: boolean };
type Workflow = { permissions: Record<string, string>; jobs: Record<string, Job> };
const source = await readFile(join(import.meta.dirname, "../../.github/workflows/release-cli.yml"), "utf8");
const workflow = parse(source) as Workflow;
function job(id: string): Job {
  const result = workflow.jobs[id];
  assert.ok(result, `required release job: ${id}`);
  return result;
}
function step(target: Job, name: string): Step {
  const result = target.steps.find((candidate) => candidate.name === name);
  assert.ok(result, `required release step: ${name}`);
  return result;
}
function runs(target: Job): string { return target.steps.map((item) => item.run ?? "").join("\n"); }
function ordered(target: Job, names: string[]): void {
  let previous = -1;
  for (const name of names) {
    const current = target.steps.indexOf(step(target, name));
    assert.ok(current > previous, `${name} must follow the previous verification gate`);
    previous = current;
  }
}

test("formal CLI release builds native Darwin ARM64 with exact Node without replacing Windows", () => {
  assert.equal(job("build")["runs-on"], "windows-latest");
  const mac = job("build-macos-arm64");
  assert.equal(mac["runs-on"], "macos-15");
  assert.equal(mac.env?.TMPDIR, "/private/var/tmp");
  for (const target of Object.values(workflow.jobs)) {
    assert.equal(target.steps.find((item) => item.uses === "actions/setup-node@v4")?.with?.["node-version"], "24.16.0");
    assert.equal(target.steps.find((item) => item.uses === "actions/checkout@v4")?.with?.ref, "${{ inputs.tag || github.ref }}");
  }
  assert.equal(mac.steps.find((item) => item.uses === "actions/setup-node@v4")?.with?.architecture, "arm64");
  assert.match(runs(mac), /process\.platform !== ["']darwin["']/u);
  assert.match(runs(mac), /process\.arch !== ["']arm64["']/u);
  assert.match(runs(mac), /process\.versions\.node !== ["']24\.16\.0["']/u);
  assert.match(runs(mac), /verify-release-version\.mjs --component cli --tag "\$RELEASE_TAG"/u);
  assert.equal(mac.env?.RELEASE_TAG, job("build").env?.RELEASE_TAG);
  assert.match(runs(mac), /npm run typecheck/u);
  assert.match(runs(mac), /npm test --[^\n]*test\/contract\/native-release-platform\.test\.ts/u);
  assert.match(runs(mac), /npm run build:sea/u);
});

test("Darwin release packages verified native SEA bytes, not a renamed Windows executable", () => {
  const mac = job("build-macos-arm64");
  const native = step(mac, "Verify and name the native release executable").run!;
  assert.match(native, /codesign --verify --strict[^\n]*dist\/harness-mrtool\.exe/u);
  assert.match(native, /cp -p dist\/harness-mrtool\.exe dist\/harness-mrtool/u);
  assert.match(native, /cmp dist\/harness-mrtool\.exe dist\/harness-mrtool/u);
  assert.match(native, /\.\/dist\/harness-mrtool self-test --output json/u);
  const packaging = step(mac, "Package the final native SEA bytes").run!;
  for (const argument of ["--platform darwin-arm64", "--executable dist/harness-mrtool",
    "--receipt dist/bundle-receipt.envelope.json", "--notices THIRD_PARTY_NOTICES.md",
    "--node-license licenses/Node.txt", "--output dist/harness-mrtool-darwin-arm64.zip"]) {
    assert.ok(packaging.includes(argument), argument);
  }
  ordered(mac, ["Verify and name the native release executable", "Materialize the approved signed Bundle receipt",
    "Verify the signed embedded template receipt", "Package the final native SEA bytes", "Attest the final portable archive", "Upload immutable draft inputs"]);
});

test("approved Darwin receipt is bounded, never printed, and production-authenticated before packaging", () => {
  const mac = job("build-macos-arm64");
  const materialize = step(mac, "Materialize the approved signed Bundle receipt");
  assert.equal(materialize.env?.BUNDLE_RECEIPT_B64, "${{ secrets.BUNDLE_RECEIPT_B64 }}");
  assert.match(materialize.run!, /2097152/u);
  assert.match(materialize.run!, /toString\('base64'\) !== encoded/u);
  assert.doesNotMatch(materialize.run!, /console\.|echo.*BUNDLE_RECEIPT/u);
  const authenticate = step(mac, "Verify the signed embedded template receipt").run!;
  assert.match(authenticate, /verify-template-publication\.mjs --directory template-bundle --receipt dist\/bundle-receipt\.envelope\.json --tag "templates-v\$TEMPLATE_VERSION"/u);
  assert.doesNotMatch(runs(mac), /--trust|--key|fixture|test-key|sign-receipt/u);
});

test("receipt materialization rejects missing/malformed input and refuses overwrite without echoing input", async (t) => {
  const script = step(job("build-macos-arm64"), "Materialize the approved signed Bundle receipt").run!;
  const javascript = /node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/u.exec(script)?.[1];
  assert.ok(javascript, "materialization must have an executable inline Node gate");
  const root = await mkdtemp(join(tmpdir(), "native-release-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist"));
  function execute(encoded: string) {
    return spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd: root, input: javascript, encoding: "utf8", timeout: 10_000,
      env: { PATH: dirname(process.execPath), BUNDLE_RECEIPT_B64: encoded },
    });
  }
  for (const invalid of ["", "private-invalid-receipt-material", "e30K!", "e30K\n"]) {
    const result = execute(invalid);
    assert.notEqual(result.status, 0);
    if (invalid.length > 0) assert.ok(!(result.stdout + result.stderr).includes(invalid));
  }
  const bytes = Buffer.from('{}\n'); // Materialization only; not a trusted publication receipt.
  assert.equal(execute(bytes.toString("base64")).status, 0);
  assert.deepEqual(await readFile(join(root, "dist/bundle-receipt.envelope.json")), bytes);
  assert.notEqual(execute(Buffer.from('other\n').toString("base64")).status, 0);
  assert.deepEqual(await readFile(join(root, "dist/bundle-receipt.envelope.json")), bytes);
});

test("platform artifacts stay isolated and both archives retain attestation gates", () => {
  const names = new Set<string>();
  for (const id of ["build", "build-macos-arm64"]) {
    const target = job(id);
    const upload = target.steps.find((item) => item.uses === "actions/upload-artifact@v4")!;
    assert.ok(upload);
    assert.equal(upload.with?.["if-no-files-found"], "error");
    const name = upload.with!.name!;
    assert.match(name, /\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u);
    assert.ok(!names.has(name)); names.add(name);
    const attest = target.steps.find((item) => item.uses === "actions/attest@v4")!;
    assert.equal(attest.if, "${{ github.event.repository.visibility != 'private' }}");
    assert.equal(attest.with?.["subject-path"], `dist/harness-mrtool-${id === "build" ? "windows-x64" : "darwin-arm64"}.zip`);
  }
  assert.equal(workflow.permissions["id-token"], "write");
  assert.equal(workflow.permissions.attestations, "write");
});

test("each platform independently revalidates downloaded archive, receipt and platform checksums", () => {
  for (const [id, build, platform, executable] of [
    ["verify-draft-assets", "build", "windows-x64", "harness-mrtool.exe"],
    ["verify-draft-assets-macos-arm64", "build-macos-arm64", "darwin-arm64", "harness-mrtool"],
  ] as const) {
    const target = job(id);
    assert.deepEqual(target.needs, platform === "windows-x64" ? [build, "verify-draft-assets-macos-arm64"] : build);
    assert.equal(target.steps.find((item) => item.uses === "actions/download-artifact@v4")?.with?.name,
      job(build).steps.find((item) => item.uses === "actions/upload-artifact@v4")?.with?.name);
    const run = runs(target);
    assert.ok(run.includes(`unzip -p dist/harness-mrtool-${platform}.zip ${executable}`));
    assert.ok(run.includes(`cmp --silent dist/${executable} dist/portable-${executable}`));
    assert.ok(run.includes(`SHA256SUMS-${platform}`));
    assert.match(run, /validateReleaseArchiveAndReceipt/u);
    if (platform === "darwin-arm64") assert.match(run, /platform: 'darwin-arm64'/u);
    assert.match(run, /verify-template-publication\.mjs --directory template-bundle/u);
    ordered(target, ["Verify downloaded final bytes", "Authenticate the downloaded template receipt", "Preserve the verified bytes for publication"]);
  }
});

test("one publisher requires BOTH successful platform verification jobs with no bypass", () => {
  const publish = job("publish");
  // Keep the established publisher boundary; its Windows verifier is also the join gate.
  assert.equal(publish.needs, "verify-draft-assets");
  assert.deepEqual(job("verify-draft-assets").needs, ["build", "verify-draft-assets-macos-arm64"]);
  assert.equal(job("verify-draft-assets-macos-arm64").needs, "build-macos-arm64");
  assert.match(publish.if!, /success\(\)/u);
  assert.match(publish.if!, /startsWith\(inputs\.tag \|\| github\.ref_name, 'cli-v'\)/u);
  assert.equal((source.match(/gh release create /gu) ?? []).length, 1);
  assert.equal((source.match(/gh release edit /gu) ?? []).length, 1);
  assert.doesNotMatch(source, /--clobber|gh release delete|gh release upload|continue-on-error:\s*true/u);
  for (const target of Object.values(workflow.jobs)) {
    assert.notEqual(target["continue-on-error"], true);
    if (target !== publish) assert.equal(target.if, undefined);
    for (const item of target.steps) {
      assert.notEqual(item["continue-on-error"], true);
      if (item.uses !== "actions/attest@v4") assert.equal(item.if, undefined);
    }
  }
});

test("single immutable draft contains both verified platforms, collision-free receipts and checksums", () => {
  const publish = job("publish");
  const downloads = publish.steps.filter((item) => item.uses === "actions/download-artifact@v4");
  assert.equal(downloads.length, 2);
  assert.notEqual(downloads[0]!.with?.path, downloads[1]!.with?.path);
  const merge = step(publish, "Combine the verified platform assets").run!;
  assert.match(merge, /cmp --silent dist\/bundle-receipt\.envelope\.json dist\/darwin-arm64\/bundle-receipt\.envelope\.json/u);
  const create = step(publish, "Create a draft release with the verified assets").run!;
  assert.match(create, /gh release create "\$\{RELEASE_TAG\}" --draft --verify-tag/u);
  for (const name of ["harness-mrtool.exe", "harness-mrtool-windows-x64.zip", "harness-mrtool",
    "harness-mrtool-darwin-arm64.zip", "bundle-receipt.envelope.json", "sea-build-receipt.json",
    "sea-build-receipt-darwin-arm64.json", "SHA256SUMS-windows-x64", "SHA256SUMS-darwin-arm64"]) {
    assert.ok(create.includes(`dist/${name}`), `draft missing ${name}`);
    assert.ok(step(publish, "Download the draft assets and verify the published bytes").run!
      .includes(`cmp --silent dist/${name} draft-download/${name}`), `download not compared: ${name}`);
  }
  for (const name of ["Re-verify the bytes in the publishing job", "Download the draft assets and verify the published bytes"]) {
    const run = step(publish, name).run!;
    assert.match(run, /validateReleaseArchiveAndReceipt[^\n]*platform: 'darwin-arm64'/u);
    assert.match(run, /sha256sum --check SHA256SUMS-windows-x64/u);
    assert.match(run, /sha256sum --check SHA256SUMS-darwin-arm64/u);
  }
  ordered(publish, ["Combine the verified platform assets", "Re-verify the bytes in the publishing job",
    "Authenticate publishing-job template receipt", "Create a draft release with the verified assets",
    "Download the draft assets and verify the published bytes", "Publish the verified draft", "Verify immutable release state"]);
  assert.match(step(publish, "Verify immutable release state").run!, /isImmutable[\s\S]*= true/u);
});

test("all POSIX release scripts parse and use fail-closed shell execution", () => {
  for (const target of Object.values(workflow.jobs)) {
    for (const item of target.steps) {
      if (item.shell !== "bash" || item.run === undefined) continue;
      assert.match(item.run, /^set -euo pipefail\n/u, item.name);
      const result = spawnSync("bash", ["-n"], { input: item.run, encoding: "utf8", timeout: 10_000 });
      assert.equal(result.status, 0, `${item.name}: ${result.stderr}`);
    }
  }
});
