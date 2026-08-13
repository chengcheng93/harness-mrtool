import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

// The receipt helper is JavaScript so it can run before TypeScript is compiled.
// @ts-expect-error The receipt helper intentionally has no declaration file.
import { createSeaBuildReceipt, verifySeaBuildReceipt, writeSeaBuildReceipt } from "../../scripts/sea-build-receipt.mjs";

function createFixture(context: test.TestContext) {
  const fixtureDirectory = mkdtempSync(join(tmpdir(), "harness-sea-receipt-"));
  context.after(() => rmSync(fixtureDirectory, { recursive: true, force: true }));
  const artifactPath = join(fixtureDirectory, "dist", "harness-mrtool.exe");
  const inputPaths = [
    join(fixtureDirectory, "src", "main.ts"),
    join(fixtureDirectory, "package.json"),
  ];
  const receiptPath = join(fixtureDirectory, "dist", "sea-build-receipt.json");
  for (const [path, content] of [
    [artifactPath, "verified artifact"],
    [inputPaths[0]!, "source"],
    [inputPaths[1]!, '{"version":"1.0.0"}'],
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }
  writeSeaBuildReceipt(
    receiptPath,
    createSeaBuildReceipt(fixtureDirectory, artifactPath, inputPaths),
  );
  return { artifactPath, fixtureDirectory, inputPaths, receiptPath };
}

test("writes canonical sorted hashes and verifies matching content", (context) => {
  const fixture = createFixture(context);

  assert.doesNotThrow(() =>
    verifySeaBuildReceipt(
      fixture.fixtureDirectory,
      fixture.artifactPath,
      fixture.inputPaths,
      fixture.receiptPath,
    ),
  );
  const serializedReceipt = readFileSync(fixture.receiptPath, "utf8");
  assert.equal(serializedReceipt.endsWith("\n"), true);
  const receipt = JSON.parse(serializedReceipt) as {
    inputs: Array<{ path: string; sha256: string }>;
  };
  assert.deepEqual(
    receipt.inputs.map((input) => input.path),
    ["package.json", "src/main.ts"],
  );
  assert.equal(receipt.inputs.every((input) => /^[a-f0-9]{64}$/.test(input.sha256)), true);
});

test("rejects stale artifact content even when its mtime is newest", (context) => {
  const fixture = createFixture(context);
  writeFileSync(fixture.artifactPath, "artifact built from different source");
  const newestTime = new Date("2026-01-01T00:00:01.000Z");
  utimesSync(fixture.artifactPath, newestTime, newestTime);

  assert.throws(
    () =>
      verifySeaBuildReceipt(
        fixture.fixtureDirectory,
        fixture.artifactPath,
        fixture.inputPaths,
        fixture.receiptPath,
      ),
    /artifact SHA-256 mismatch/i,
  );
});

test("rejects a changed build input regardless of mtime", (context) => {
  const fixture = createFixture(context);
  writeFileSync(fixture.inputPaths[0]!, "changed source");

  assert.throws(
    () =>
      verifySeaBuildReceipt(
        fixture.fixtureDirectory,
        fixture.artifactPath,
        fixture.inputPaths,
        fixture.receiptPath,
      ),
    /input SHA-256 mismatch.*src\/main\.ts/is,
  );
});

test("rejects a non-canonical receipt serialization", (context) => {
  const fixture = createFixture(context);
  const receipt = JSON.parse(readFileSync(fixture.receiptPath, "utf8")) as unknown;
  writeFileSync(fixture.receiptPath, `${JSON.stringify(receipt, undefined, 2)}\n`);

  assert.throws(
    () =>
      verifySeaBuildReceipt(
        fixture.fixtureDirectory,
        fixture.artifactPath,
        fixture.inputPaths,
        fixture.receiptPath,
      ),
    /receipt is not canonical/i,
  );
});
