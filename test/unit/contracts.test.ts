import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { Ajv } from "ajv";

import {
  ERROR_CODES,
  ToolError,
  isToolError,
  type ErrorCode,
} from "../../src/contracts/errors.ts";
import {
  exitCodeFor,
  type RemoteWriteState,
} from "../../src/contracts/exit-codes.ts";
import {
  createFailureOutput,
  createSuccessOutput,
  serializeOutput,
  type OutputContext,
} from "../../src/contracts/output.ts";
import {
  REQUEST_SCHEMA_VERSION,
  type RequestIdentity,
} from "../../src/contracts/request.ts";

const EXPECTED_ERROR_CODES = [
  "UPDATE_CHECK_WARNING",
  "UPDATE_SECURITY_ERROR",
  "UPDATE_REQUIRED",
  "REPOSITORY_ERROR",
  "AUTH_ERROR",
  "PROFILE_REQUIRED",
  "TEMPLATE_ERROR",
  "POLICY_ERROR",
  "LABEL_ERROR",
  "INPUT_ERROR",
  "INPUT_TOO_LARGE",
  "RENDER_ERROR",
  "GITLAB_ERROR",
  "CONCURRENT_UPDATE",
  "MANUAL_DESCRIPTION_CHANGE",
  "UNMANAGED_MR",
  "POSTCONDITION_ERROR",
  "PARTIAL_DRAFT",
  "PARTIAL_REMOTE_STATE",
  "INTERNAL_ERROR",
] as const satisfies readonly ErrorCode[];

const DEFAULT_CONTEXT: OutputContext = { cliVersion: "0.1.0-dev" };

test("publishes the complete stable error code registry", () => {
  assert.deepEqual(ERROR_CODES, EXPECTED_ERROR_CODES);
});

const NOT_WRITTEN_EXIT_CODES: Readonly<Record<"OK" | ErrorCode, number>> = {
  OK: 0,
  UPDATE_CHECK_WARNING: 0,
  UPDATE_SECURITY_ERROR: 5,
  UPDATE_REQUIRED: 5,
  REPOSITORY_ERROR: 3,
  AUTH_ERROR: 3,
  PROFILE_REQUIRED: 2,
  TEMPLATE_ERROR: 2,
  POLICY_ERROR: 2,
  LABEL_ERROR: 2,
  INPUT_ERROR: 2,
  INPUT_TOO_LARGE: 2,
  RENDER_ERROR: 2,
  GITLAB_ERROR: 4,
  CONCURRENT_UPDATE: 4,
  MANUAL_DESCRIPTION_CHANGE: 2,
  UNMANAGED_MR: 2,
  POSTCONDITION_ERROR: 6,
  PARTIAL_DRAFT: 6,
  PARTIAL_REMOTE_STATE: 6,
  INTERNAL_ERROR: 7,
};

for (const [code, expected] of Object.entries(NOT_WRITTEN_EXIT_CODES) as [
  "OK" | ErrorCode,
  number,
][]) {
  test(`maps ${code} deterministically before a remote write`, () => {
    assert.equal(
      exitCodeFor({ code, remoteWriteState: "not-attempted" }),
      expected,
    );
  });
}

for (const remoteWriteState of [
  "written",
  "compensated",
  "unknown",
] as const satisfies readonly RemoteWriteState[]) {
  test(`remote ${remoteWriteState} takes precedence over an input failure`, () => {
    assert.equal(exitCodeFor({ code: "INPUT_ERROR", remoteWriteState }), 6);
  });
}

test("update security is exit 5 before writing and exit 6 after writing", () => {
  assert.equal(
    exitCodeFor({
      code: "UPDATE_SECURITY_ERROR",
      remoteWriteState: "not-written",
    }),
    5,
  );
  assert.equal(
    exitCodeFor({ code: "UPDATE_SECURITY_ERROR", remoteWriteState: "written" }),
    6,
  );
});

test("success and update warnings remain exit 0 regardless of remote state", () => {
  assert.equal(exitCodeFor({ code: "OK", remoteWriteState: "written" }), 0);
  assert.equal(
    exitCodeFor({ code: "UPDATE_CHECK_WARNING", remoteWriteState: "unknown" }),
    0,
  );
});

test("ToolError retains stable details and supports boundary matching", () => {
  const cause = new Error("secret internal cause");
  const error = new ToolError(
    "INPUT_ERROR",
    "Field is invalid",
    {
      field: "title",
      expected: "non-empty string",
      actual: null,
      safeNextStep: "  provide a title  ",
    },
    cause,
  );

  assert.equal(error.code, "INPUT_ERROR");
  assert.equal(error.message, "Field is invalid");
  assert.deepEqual(error.details, {
    field: "title",
    expected: "non-empty string",
    actual: null,
    safeNextStep: "provide a title",
  });
  assert.equal(error.cause, cause);
  assert.equal(isToolError(error), true);
  assert.equal(isToolError(error, "INPUT_ERROR", /field is invalid/i), true);
  assert.equal(isToolError(error, "AUTH_ERROR"), false);
  assert.equal(isToolError(new Error("Field is invalid")), false);
  assert.equal(JSON.stringify(error).includes("secret internal cause"), false);
});

test("ToolError rejects incomplete or unsafe details", () => {
  assert.throws(
    () =>
      new ToolError("INPUT_ERROR", "bad", {
        field: null,
        expected: null,
        actual: null,
        safeNextStep: "  ",
      }),
    /safeNextStep/,
  );
  assert.throws(
    () =>
      new ToolError("INPUT_ERROR", "bad", {
        field: undefined,
        expected: null,
        actual: null,
        safeNextStep: "retry",
      } as never),
    /field/,
  );
});

test("ToolError and failure factory reject forged unknown codes", () => {
  const details = {
    field: null,
    expected: null,
    actual: null,
    safeNextStep: "Retry",
  } as const;

  assert.throws(
    () => new ToolError("UNKNOWN_CODE" as never, "Unknown", details),
    /error code/i,
  );
  assert.throws(
    () =>
      createFailureOutput(DEFAULT_CONTEXT, {
        code: "UNKNOWN_CODE",
        message: "Unknown",
        details,
      } as never),
    /failure code/i,
  );
});

test("success output fills every stable field with deterministic defaults", () => {
  const output = createSuccessOutput(DEFAULT_CONTEXT, {
    message: "Preview generated",
    data: { iid: 51 },
  });

  assert.deepEqual(output, {
    schemaVersion: 1,
    ok: true,
    code: "OK",
    message: "Preview generated",
    versions: {
      cliVersion: "0.1.0-dev",
      templateVersion: null,
      bundleHash: null,
      releaseSetId: null,
      inputSchema: null,
      policySchema: null,
      loadedSkillVersion: null,
      loadedSkillProtocol: null,
      installedSkillVersion: null,
      stagedSkillVersion: null,
      manifestSequence: null,
    },
    update: {
      checked: false,
      reachable: null,
      usingLastKnownGood: false,
      latestVersionConfirmed: false,
      warning: null,
      securityAnomaly: false,
      activationRequired: false,
      hostRefreshMayBeRequired: false,
      persistencePending: false,
      executedVersion: "0.1.0-dev",
      installedVersion: "0.1.0-dev",
    },
    validation: { valid: true, issues: [] },
    remoteWrite: { state: "not-attempted", operations: [] },
    warnings: [],
    error: null,
    data: { iid: 51 },
  });
});

test("success can carry a non-blocking update warning while code remains OK", () => {
  const output = createSuccessOutput({
    ...DEFAULT_CONTEXT,
    warnings: [
      { code: "UPDATE_CHECK_WARNING", message: "Using cached release set" },
    ],
    update: {
      checked: true,
      reachable: false,
      usingLastKnownGood: true,
      warning: "GitHub is unreachable",
    },
  });

  assert.equal(output.ok, true);
  assert.equal(output.code, "OK");
  assert.equal(output.warnings[0]?.code, "UPDATE_CHECK_WARNING");
  assert.equal(output.update.reachable, false);
});

test("schema and sequence versions use monotonic integer fields", () => {
  const output = createSuccessOutput({
    cliVersion: "0.1.0-dev",
    versions: {
      inputSchema: 1,
      policySchema: 2,
      loadedSkillProtocol: 0,
      manifestSequence: 1,
    },
  });

  assert.equal(output.versions.inputSchema, 1);
  assert.equal(output.versions.policySchema, 2);
  assert.equal(output.versions.loadedSkillProtocol, 0);
  assert.equal(output.versions.manifestSequence, 1);
});

test("version counters reject zero or negative values outside their contracts", () => {
  for (const versions of [
    { inputSchema: 0 },
    { policySchema: -1 },
    { loadedSkillProtocol: -1 },
    { manifestSequence: 0 },
  ]) {
    assert.throws(
      () =>
        createSuccessOutput({
          cliVersion: "0.1.0-dev",
          versions,
        } as never),
      /version|schema|protocol|sequence/i,
    );
  }
});

test("output factory snapshots caller-owned nested JSON values", () => {
  const data = { nested: { value: "original" } };
  const expected = { labels: [12, 14] };
  const issueActual = { labels: [12] };
  const context: OutputContext = {
    cliVersion: "0.1.0-dev",
    validation: {
      valid: false,
      issues: [
        {
          code: "LABEL_MISMATCH",
          field: "labels",
          message: "Labels differ",
          expected,
          actual: issueActual,
          safeNextStep: "Refresh context",
        },
      ],
    },
  };
  const success = createSuccessOutput(context, { data });
  const error = new ToolError("POSTCONDITION_ERROR", "Read-back mismatch", {
    field: "labels",
    expected,
    actual: null,
    safeNextStep: "Inspect the draft MR",
  });
  const failure = createFailureOutput(context, error);

  data.nested.value = "mutated";
  expected.labels.push(99);
  issueActual.labels.push(99);

  assert.deepEqual(success.data, { nested: { value: "original" } });
  assert.deepEqual(success.validation.issues[0]?.expected, { labels: [12, 14] });
  assert.deepEqual(success.validation.issues[0]?.actual, { labels: [12] });
  assert.deepEqual(failure.error.expected, { labels: [12, 14] });
});

test("failure output exposes ToolError details and top-level remote writes", () => {
  const error = new ToolError("POSTCONDITION_ERROR", "Read-back mismatch", {
    field: "labels",
    expected: [12, 14],
    actual: [12],
    safeNextStep: "Inspect the draft MR and retry verification",
  });
  const output = createFailureOutput(
    {
      ...DEFAULT_CONTEXT,
      remoteWrite: { state: "written", operations: ["create:mr:51"] },
      validation: {
        valid: false,
        issues: [
          {
            code: "LABEL_MISMATCH",
            field: "labels",
            message: "Expected label missing",
            expected: 14,
            actual: null,
            safeNextStep: "Refresh context",
          },
        ],
      },
    },
    error,
  );

  assert.equal(output.ok, false);
  assert.equal(output.code, "POSTCONDITION_ERROR");
  assert.equal(output.message, "Read-back mismatch");
  assert.deepEqual(output.error, error.details);
  assert.deepEqual(output.remoteWrite, {
    state: "written",
    operations: ["create:mr:51"],
  });
  assert.equal("remoteWrite" in output.error!, false);
});

test("failure rejects OK and warning pseudo-errors", () => {
  const details = {
    field: null,
    expected: null,
    actual: null,
    safeNextStep: "Retry",
  } as const;

  assert.throws(
    () =>
      createFailureOutput(
        DEFAULT_CONTEXT,
        { code: "OK", message: "not a failure", details } as never,
      ),
    /failure code/i,
  );
  assert.throws(
    () =>
      createFailureOutput(
        DEFAULT_CONTEXT,
        {
          code: "UPDATE_CHECK_WARNING",
          message: "not a failure",
          details,
        } as never,
      ),
    /failure code/i,
  );
});

test("output factories reject values JSON.stringify would silently alter", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const invalidData = [
    { value: undefined },
    { value: Number.NaN },
    { value: Number.POSITIVE_INFINITY },
    { value: 1n },
    cycle,
  ];

  for (const data of invalidData) {
    assert.throws(
      () => createSuccessOutput(DEFAULT_CONTEXT, { data: data as never }),
      /valid JSON/i,
    );
  }
  assert.throws(
    () =>
      createSuccessOutput(
        { cliVersion: "0.1.0-dev", versions: { templateVersion: undefined } } as never,
      ),
    /valid JSON/i,
  );
});

test("serializeOutput emits exactly one compact JSON document and LF", () => {
  const serialized = serializeOutput(
    createSuccessOutput(DEFAULT_CONTEXT, { data: { greeting: "hello" } }),
  );

  assert.equal(serialized.endsWith("\n"), true);
  assert.equal(serialized.slice(0, -1).includes("\n"), false);
  assert.equal(serialized.includes(": "), false);
  assert.deepEqual(JSON.parse(serialized),
    createSuccessOutput(DEFAULT_CONTEXT, { data: { greeting: "hello" } }),
  );
});

test("output-v1 schema loads in Ajv strict mode and validates both factories", () => {
  let warnings = 0;
  const ajv = new Ajv({
    allErrors: true,
    strict: true,
    logger: {
      log: () => undefined,
      warn: () => {
        warnings += 1;
      },
      error: () => undefined,
    },
  });
  const schemaPath = resolve(
    import.meta.dirname,
    "../../schemas/output-v1.schema.json",
  );
  const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as object;
  const validate = ajv.compile(schema);
  const success = createSuccessOutput(DEFAULT_CONTEXT);
  const failure = createFailureOutput(
    DEFAULT_CONTEXT,
    new ToolError("INPUT_ERROR", "Invalid request", {
      field: "schemaVersion",
      expected: 1,
      actual: 2,
      safeNextStep: "Use request schema version 1",
    }),
  );

  assert.equal(warnings, 0);
  assert.equal(validate(success), true, JSON.stringify(validate.errors));
  assert.equal(validate(failure), true, JSON.stringify(validate.errors));

  const extraTopLevel = { ...success, surprise: true };
  assert.equal(validate(extraTopLevel), false);
  const extraNested = {
    ...success,
    update: { ...success.update, surprise: true },
  };
  assert.equal(validate(extraNested), false);

  const numericVersions = createSuccessOutput({
    cliVersion: "0.1.0-dev",
    versions: { inputSchema: 1, policySchema: 1 },
  });
  assert.equal(validate(numericVersions), true, JSON.stringify(validate.errors));

  const stringSchemaVersion = {
    ...numericVersions,
    versions: { ...numericVersions.versions, inputSchema: "1" },
  };
  assert.equal(validate(stringSchemaVersion), false);
  for (const versions of [
    { inputSchema: 0 },
    { policySchema: 0 },
    { loadedSkillProtocol: -1 },
    { manifestSequence: 0 },
  ]) {
    assert.equal(
      validate({
        ...numericVersions,
        versions: { ...numericVersions.versions, ...versions },
      }),
      false,
    );
  }
});

test("request identity fixes only the V1 identity contract", () => {
  const identity: RequestIdentity = {
    schemaVersion: REQUEST_SCHEMA_VERSION,
    contextId: "ctx_opaque",
  };

  assert.deepEqual(identity, { schemaVersion: 1, contextId: "ctx_opaque" });
});
