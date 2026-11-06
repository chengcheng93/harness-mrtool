import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { runProcess } from "../helpers/process.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const delayedStdoutFixture = resolve(
  repositoryRoot,
  "test/fixtures/delayed-stdout.cjs",
);
const sourceEntrypoint = resolve(repositoryRoot, "src/main.ts");

test("JSON usage errors flush one complete output-v1 document to stdout", () => {
  const result = runProcess(
    process.execPath,
    [
      "--require",
      delayedStdoutFixture,
      "--import",
      "tsx",
      sourceEntrypoint,
      "unknown-command",
      "--output",
      "json",
    ],
    { cwd: repositoryRoot },
  );

  const diagnostic = JSON.stringify(result, undefined, 2);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 2, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  const output = JSON.parse(result.stdout) as {
    readonly schemaVersion?: unknown;
    readonly ok?: unknown;
    readonly code?: unknown;
    readonly data?: unknown;
  };
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, false);
  assert.equal(output.code, "INPUT_ERROR");
  assert.equal(output.data, null);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});

test("partial JSON failures flush the MR locator and failed step with the original unknown outcome", () => {
  const result = runProcess(process.execPath, [
    "--require", delayedStdoutFixture,
    "--import", "tsx",
    "--input-type=module",
    "--eval", `
      import { CliJsonOutput } from "./src/cli/output.ts";
      import { ToolError } from "./src/contracts/errors.ts";
      import { attachTransactionAudit, attachTransactionFailureReceipt } from "./src/app/transaction-journal.ts";
      const error = new ToolError("PARTIAL_REMOTE_STATE", "Label write result is unknown", {
        field: "mergeRequest", expected: "confirmed labels", actual: "readback unavailable",
        safeNextStep: "Inspect the MR and refresh context before retrying."
      });
      attachTransactionAudit(error, {
        journalVersion: 1, operation: "update", sourceHeadSha: "a".repeat(40), candidateSelectionDigest: "b".repeat(64),
        finalState: "unknown", recoveredUnknownOutcome: false,
        steps: [{ sequence: 1, phase: "normal", operation: "labels-add",
          preRead: { outcome: "succeeded", requestId: "request-before", snapshotDigest: "c".repeat(64) },
          mutation: { outcome: "unknown", requestId: "request-labels" },
          postRead: { outcome: "failed", requestId: "request-readback", snapshotDigest: null }, postcondition: "unavailable" }]
      });
      attachTransactionFailureReceipt(error, {
        receiptVersion: 1, iid: 88, iidUnavailable: false,
        webUrl: "http://gitlab.example.test/group/project/-/merge_requests/88", webUrlUnavailable: false,
        completedSteps: ["mark-draft: matched"], failedOperation: "labels-add", failedField: "mergeRequest.labels",
        retryCommand: "harness-mrtool update 88 --input - --non-interactive --output json"
      });
      const result = await new CliJsonOutput({ cliVersion: "0.1.0-dev" }, process.stdout).failure(error);
      process.exitCode = result.exitCode;
    `,
  ], { cwd: repositoryRoot });

  const diagnostic = JSON.stringify(result, undefined, 2);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 6, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
  const output = JSON.parse(result.stdout) as {
    code: string;
    remoteWrite: { state: string; operations: string[] };
    error: { safeNextStep: string };
    data: { failureReceipt: { iid: number; webUrl: string; failedOperation: string; failedField: string } };
  };
  assert.equal(output.code, "PARTIAL_REMOTE_STATE");
  assert.deepEqual(output.remoteWrite, { state: "unknown", operations: ["labels-add"] });
  assert.equal(output.data.failureReceipt.iid, 88);
  assert.equal(output.data.failureReceipt.webUrl, "http://gitlab.example.test/group/project/-/merge_requests/88");
  assert.equal(output.data.failureReceipt.failedOperation, "labels-add");
  assert.equal(output.data.failureReceipt.failedField, "mergeRequest.labels");
  assert.match(output.error.safeNextStep, /!88/u);
  assert.match(output.error.safeNextStep, /mergeRequest\.labels/u);
  assert.doesNotMatch(result.stdout, /(?:hmrc1_|hmrx1_|Bearer\s)/u);
});

test("the public version command uses the same output-v1 process boundary", () => {
  const result = runProcess(
    process.execPath,
    [
      "--import",
      "tsx",
      sourceEntrypoint,
      "version",
      "--output",
      "json",
    ],
    { cwd: repositoryRoot },
  );

  const diagnostic = JSON.stringify(result, undefined, 2);
  assert.equal(result.error, undefined, diagnostic);
  assert.equal(result.status, 0, diagnostic);
  assert.equal(result.stderr, "", diagnostic);
  const output = JSON.parse(result.stdout) as {
    readonly schemaVersion?: unknown;
    readonly ok?: unknown;
    readonly code?: unknown;
    readonly versions?: { readonly cliVersion?: unknown };
    readonly data?: { readonly version?: unknown };
  };
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.ok, true);
  assert.equal(output.code, "OK");
  assert.equal(output.versions?.cliVersion, output.data?.version);
  assert.equal(result.stdout.trimEnd().split("\n").length, 1, diagnostic);
});
