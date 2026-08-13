import assert from "node:assert/strict";
import test from "node:test";

import {
  CliJsonOutput,
  normalizeCliFailure,
} from "../../src/cli/output.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import {
  TransactionJournal,
  attachTransactionAudit,
} from "../../src/app/transaction-journal.ts";

const SHA = "a".repeat(40);
const DIGEST = "b".repeat(64);

class DelayedSink {
  readonly chunks: string[] = [];
  callbackCompleted = false;

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    setImmediate(() => {
      this.callbackCompleted = true;
      callback();
    });
    return true;
  }
}

test("CLI JSON success waits for stdout and emits one output-v1 document", async () => {
  const sink = new DelayedSink();
  const output = new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink);

  const result = await output.success({ message: "Version resolved", data: { version: "0.1.0-dev" } });

  assert.equal(sink.callbackCompleted, true);
  assert.equal(result.exitCode, 0);
  assert.equal(sink.chunks.length, 1);
  assert.equal(sink.chunks[0]?.endsWith("\n"), true);
  const envelope = JSON.parse(sink.chunks[0] ?? "") as Record<string, unknown>;
  assert.equal(envelope.schemaVersion, 1);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.code, "OK");
  await assert.rejects(output.success(), /already emitted/i);
});

test("CLI JSON failure projects validation details and stable exit code", async () => {
  const sink = new DelayedSink();
  const output = new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink);
  const error = new ToolError("INPUT_ERROR", "Input is incomplete", {
    field: "changes.summary",
    expected: "at least one summary item",
    actual: null,
    safeNextStep: "Provide the missing field and retry.",
  });

  const result = await output.failure(error);

  assert.equal(result.exitCode, 2);
  const envelope = JSON.parse(sink.chunks[0] ?? "") as {
    code: string;
    validation: { valid: boolean; issues: Array<Record<string, unknown>> };
    remoteWrite: { state: string; operations: string[] };
  };
  assert.equal(envelope.code, "INPUT_ERROR");
  assert.equal(envelope.validation.valid, false);
  assert.equal(envelope.validation.issues.length, 1);
  assert.equal(envelope.validation.issues[0]?.field, "changes.summary");
  assert.deepEqual(envelope.remoteWrite, { state: "not-attempted", operations: [] });
});

test("CLI failure derives partial remote writes and safe audit data from the attached journal", async () => {
  const sink = new DelayedSink();
  const output = new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink);
  const error = new ToolError("PARTIAL_REMOTE_STATE", "Remote state is unknown", {
    field: "mergeRequest",
    expected: "a proven Draft or Ready MR",
    actual: "readback unavailable",
    safeNextStep: "Inspect the MR and refresh context.",
  });
  const journal = new TransactionJournal("create", SHA, DIGEST);
  const step = journal.start("normal", "create-draft", null);
  step.mutation("unknown", "request-1");
  step.readFailed("request-2");
  journal.setFinalState("unknown");
  attachTransactionAudit(error, journal.snapshot());

  const result = await output.failure(error);

  assert.equal(result.exitCode, 6);
  const serialized = sink.chunks[0] ?? "";
  const envelope = JSON.parse(serialized) as {
    remoteWrite: { state: string; operations: string[] };
    data: { transaction: { journalVersion: number; finalState: string } };
  };
  assert.deepEqual(envelope.remoteWrite, { state: "unknown", operations: ["create-draft"] });
  assert.equal(envelope.data.transaction.journalVersion, 1);
  assert.equal(envelope.data.transaction.finalState, "unknown");
  assert.equal(serialized.includes("hmrc1_"), false);
  assert.equal(serialized.includes("hmrx1_"), false);
});

test("unknown failures become non-reflective INTERNAL_ERROR output", async () => {
  const credential = "glpat-secret-value";
  const normalized = normalizeCliFailure(new Error(`network failed: ${credential}`));
  assert.equal(normalized.code, "INTERNAL_ERROR");
  assert.equal(normalized.message.includes(credential), false);
  assert.equal(JSON.stringify(normalized.details).includes(credential), false);

  const sink = new DelayedSink();
  const result = await new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink).failure(
    new Error(`network failed: ${credential}`),
  );
  assert.equal(result.exitCode, 7);
  assert.equal((sink.chunks[0] ?? "").includes(credential), false);
});

test("candidate and context bearers cross stdout only in authorized context fields", async () => {
  const candidate = `hmrc1_${"A".repeat(43)}`;
  const context = `hmrx1_${"B".repeat(43)}`;

  const contextSink = new DelayedSink();
  const contextResult = await new CliJsonOutput(
    { cliVersion: "0.1.0-dev" },
    contextSink,
    { contextBearers: true },
  ).success({
    data: {
      command: "context",
      contextId: context,
      labelCandidates: [{ token: candidate, name: "type::bug" }],
      userCandidates: [{ token: candidate, username: "reviewer" }],
    },
  });
  assert.equal(contextResult.exitCode, 0);
  assert.equal(contextSink.chunks[0]?.includes(candidate), true);
  assert.equal(contextSink.chunks[0]?.includes(context), true);

  const successSink = new DelayedSink();
  await assert.rejects(
    new CliJsonOutput({ cliVersion: "0.1.0-dev" }, successSink).success({
      data: { nested: `prefix ${candidate} suffix` },
    }),
    /bearer/i,
  );
  assert.deepEqual(successSink.chunks, []);

  const failureSink = new DelayedSink();
  const result = await new CliJsonOutput({ cliVersion: "0.1.0-dev" }, failureSink).failure(
    new ToolError("INPUT_ERROR", `Invalid selection ${context}`, {
      field: "selection",
      expected: "a current candidate",
      actual: candidate,
      safeNextStep: "Refresh context.",
    }),
  );
  const serialized = failureSink.chunks[0] ?? "";
  assert.equal(result.exitCode, 7);
  assert.equal(serialized.includes(candidate), false);
  assert.equal(serialized.includes(context), false);
  assert.equal((JSON.parse(serialized) as { code: string }).code, "INTERNAL_ERROR");

  for (const data of [
    { contextId: candidate },
    { contextId: context, nested: candidate },
    { contextId: context, labelCandidates: [{ token: `prefix ${candidate}` }] },
    { contextId: context, userCandidates: [{ name: candidate }] },
  ]) {
    const sink = new DelayedSink();
    await assert.rejects(
      new CliJsonOutput(
        { cliVersion: "0.1.0-dev" },
        sink,
        { contextBearers: true },
      ).success({ data }),
      /bearer/i,
    );
    assert.deepEqual(sink.chunks, []);
  }
});

test("classified ToolErrors containing secret shapes are downgraded before serialization", async () => {
  const secrets = [
    "glpat-handler-secret-canary",
    "github_pat_abcdefghijklmnopqrstuvwxyz0123456789",
    "Authorization: Bearer top-secret-value",
    "https://oauth2:password-canary@gitlab.example.test/team/project.git",
    "-----BEGIN PRIVATE KEY-----",
  ];
  for (const secret of secrets) {
    const sink = new DelayedSink();
    const result = await new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink).failure(
      new ToolError("AUTH_ERROR", `Authentication rejected: ${secret}`, {
        field: "credential",
        expected: secret,
        actual: { reflected: secret },
        safeNextStep: `Replace ${secret} and retry.`,
      }),
    );
    assert.equal(result.exitCode, 7);
    const serialized = sink.chunks[0] ?? "";
    assert.equal(serialized.includes(secret), false);
    assert.equal((JSON.parse(serialized) as { code: string }).code, "INTERNAL_ERROR");
  }
});

test("a ToolError mutated after construction falls back to one safe INTERNAL_ERROR document", async () => {
  const credential = "glpat-mutated-error-secret";
  const error = new ToolError("INPUT_ERROR", "Initially safe", {
    field: "input",
    expected: "valid input",
    actual: null,
    safeNextStep: "Fix the input.",
  });
  (error.details as { actual: unknown }).actual = { secret: credential, invalid: undefined };
  const sink = new DelayedSink();

  const result = await new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink).failure(error);

  assert.equal(result.exitCode, 7);
  const serialized = sink.chunks[0] ?? "";
  assert.equal(serialized.includes(credential), false);
  const envelope = JSON.parse(serialized) as { code: string; validation: { issues: Array<{ code: string }> } };
  assert.equal(envelope.code, "INTERNAL_ERROR");
  assert.equal(envelope.validation.issues[0]?.code, "INTERNAL_ERROR");
});

test("stdout callback failures reject without attempting a second JSON document", async () => {
  const sink = {
    writes: 0,
    write(_chunk: string, callback: (error?: Error | null) => void): boolean {
      this.writes += 1;
      callback(new Error("closed pipe"));
      return false;
    },
  };
  const output = new CliJsonOutput({ cliVersion: "0.1.0-dev" }, sink);

  await assert.rejects(output.success(), /closed pipe/);
  assert.equal(sink.writes, 1);
  await assert.rejects(output.failure(new Error("retry")), /already emitted/i);
  assert.equal(sink.writes, 1);
});
