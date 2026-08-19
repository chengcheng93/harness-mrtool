import assert from "node:assert/strict";
import test from "node:test";

import { guardReadOnlySuccess } from "../../src/cli/success-output-guard.ts";
import { isToolError } from "../../src/contracts/errors.ts";
import type { JsonObject } from "../../src/contracts/jcs.ts";

const contextToken = `hmrx1_${"x".repeat(43)}`;
const candidateToken = `hmrc1_${"y".repeat(43)}`;

test("success output guard recursively rejects secret-shaped keys and values", () => {
  for (const data of [
    { nested: { Authorization: "ordinary-value" } },
    { nested: { "Private-Token": "ordinary-value" } },
    { nested: { "Job-Token": "ordinary-value" } },
    { nested: { credentialProvider: "ordinary-value" } },
    { nested: { value: "Bearer credential-canary" } },
    { nested: { value: "github_pat_credential_canary" } },
  ]) {
    assert.throws(
      () => guardReadOnlySuccess("doctor", { output: { data } }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
  }
});

test("success output guard rejects bearer-shaped and token-shaped object keys for every read-only output", () => {
  const keyCanary = `hmrc1_${"k".repeat(43)}`;
  const commands = ["doctor", "context", "labels.list", "preview"] as const;
  const sensitiveKeys = [
    keyCanary,
    "token",
    "Token",
    "to-ken",
    "to_ken",
    "to ken",
    "accessToken",
    "access-token",
    "access_token",
    "Private-Token: glpat-key-canary",
    "Job-Token: job-key-canary",
    "Authorization: Bearer auth-key-canary",
  ];

  for (const command of commands) {
    for (const key of sensitiveKeys) {
      assert.throws(
        () => guardReadOnlySuccess(command, {
          output: { data: { command, nested: { [key]: "opaque-secret-canary" } } },
        }),
        (error: unknown) => isToolError(error, "INTERNAL_ERROR") &&
          !`${error.message}\n${JSON.stringify(error.details)}`.includes("key-canary") &&
          !`${error.message}\n${JSON.stringify(error.details)}`.includes(keyCanary),
      );
    }
  }
});

for (const key of [
  "gitlabToken",
  "oauthToken",
  "session_token",
  "deploy-token",
  "personalAccessToken",
  "tokenValue",
  "secretToken",
  "tokens",
  "accessTokens",
  "labelCandidateTokens",
  "gitlabToKen",
  "gitlabTo_ken",
  "ｇｉｔｌａｂＴｏｋｅｎ",
  "gitlab__Token--value",
] as const) {
  test(`success output guard rejects segmented sensitive key ${key}`, () => {
    for (const command of ["doctor", "context", "labels.list", "preview"] as const) {
      assert.throws(
        () => guardReadOnlySuccess(command, {
          output: { data: { command, nested: { [key]: "ordinary-value" } } },
        }),
        (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
      );
    }
  });
}

test("success output guard treats token as sensitive outside the exact context candidate value paths", () => {
  const cases: readonly {
    readonly command: "doctor" | "context";
    readonly data: JsonObject;
  }[] = [
    { command: "doctor", data: { token: "opaque-secret-canary" } },
    { command: "context", data: { token: "opaque-secret-canary" } },
    { command: "context", data: { labelCandidates: [{ token: "opaque-secret-canary" }] } },
    { command: "context", data: { userCandidates: [{ token: candidateToken }], token: candidateToken } },
  ];
  for (const { command, data } of cases) {
    assert.throws(
      () => guardReadOnlySuccess(command, { output: { data } }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
  }
});

test("success output guard permits context bearers only at the documented token paths", () => {
  const allowed = guardReadOnlySuccess("context", {
    output: {
      data: {
        command: "context",
        contextId: contextToken,
        labelCandidates: [{ token: candidateToken }],
        userCandidates: [{ token: `hmrc1_${"z".repeat(43)}` }],
      },
    },
  });

  assert.equal(allowed.output?.data?.contextId, contextToken);
  for (const data of [
    { contextId: contextToken, audit: { requestIds: [candidateToken] } },
    { contextId: contextToken, labelCandidates: [{ token: candidateToken, nested: contextToken }] },
    { contextId: contextToken, userCandidates: [{ token: candidateToken }], extra: candidateToken },
  ]) {
    assert.throws(
      () => guardReadOnlySuccess("context", { output: { data } }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
  }
  assert.throws(
    () => guardReadOnlySuccess("preview", { output: { data: { contextId: contextToken } } }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
  );
});

const schemaTokenFields: readonly {
  readonly definition: string;
  readonly key: string;
  readonly descriptor: JsonObject;
}[] = [
  {
    definition: "mergeRequest",
    key: "assigneeCandidateToken",
    descriptor: { anyOf: [{ type: "null" }, { $ref: "#/definitions/opaque" }] },
  },
  {
    definition: "mergeRequest",
    key: "labelCandidateTokens",
    descriptor: { $ref: "#/definitions/idArray" },
  },
  {
    definition: "review",
    key: "reviewerCandidateTokens",
    descriptor: { $ref: "#/definitions/idArray" },
  },
] as const;

for (const schemaField of schemaTokenFields) {
  test(`success output guard narrowly authorizes schema property ${schemaField.key}`, () => {
    const inputSchema: JsonObject = {
      definitions: {
        [schemaField.definition]: {
          properties: { [schemaField.key]: schemaField.descriptor },
        },
      },
    };
    const guarded = guardReadOnlySuccess("context", {
      output: { data: { inputSchema } },
    });
    assert.deepEqual(guarded.output?.data?.inputSchema, inputSchema);

    assert.throws(
      () => guardReadOnlySuccess("context", {
        output: {
          data: {
            inputSchema: {
              definitions: {
                [schemaField.definition]: {
                  properties: { [schemaField.key]: { type: "string" } },
                },
              },
            },
          },
        },
      }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
    assert.throws(
      () => guardReadOnlySuccess("context", {
        output: { data: { nested: { [schemaField.key]: schemaField.descriptor } } },
      }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
    assert.throws(
      () => guardReadOnlySuccess("doctor", { output: { data: { inputSchema } } }),
      (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
    );
  });
}

test("success output guard returns an immutable detached projection", () => {
  const source = { output: { data: { command: "doctor", checks: [{ id: "repository" }] } } };
  const guarded = guardReadOnlySuccess("doctor", source);
  source.output.data.checks[0]!.id = "mutated";

  assert.equal((guarded.output?.data?.checks as readonly { readonly id: string }[])[0]?.id, "repository");
  assert.equal(Object.isFrozen(guarded), true);
  assert.equal(Object.isFrozen(guarded.output), true);
  assert.equal(Object.isFrozen(guarded.output?.data), true);
  assert.equal(Object.isFrozen(guarded.output?.data?.checks), true);
});

test("success output guard rejects accessors without invoking them", () => {
  let reads = 0;
  const nested: Record<string, never> = {};
  Object.defineProperty(nested, "detail", {
    enumerable: true,
    get() {
      reads += 1;
      return "Bearer getter-canary";
    },
  });

  assert.throws(
    () => guardReadOnlySuccess("doctor", { output: { data: { command: "doctor", nested } } }),
    (error: unknown) => isToolError(error, "INTERNAL_ERROR"),
  );
  assert.equal(reads, 0);
});
