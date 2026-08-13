import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import {
  decodeInputBytes,
  loadInputTransport,
  MAX_INPUT_BYTES,
  type InputIo,
} from "../../src/input/load-input.ts";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { parseStrictJson } from "../../src/input/strict-json.ts";
import { parseStrictYaml } from "../../src/input/strict-yaml.ts";

function assertInputError(action: () => unknown, message?: RegExp): void {
  assert.throws(action, (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR", message), true);
    return true;
  });
}

function validRequest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    contextId: "context:test",
    intent: "draft",
    profileIds: ["future-profile"],
    targetBranch: "develop",
    title: {
      type: "future-type",
      module: "module-1",
      titleSummary: "A valid title",
    },
    changes: { summary: ["Specific change"] },
    motivation: { background: ["Specific background"] },
    workItem: { relation: "none", noIssueReason: "No issue exists for this maintenance task" },
    impact: { areaIds: ["future-area"], nature: "functional" },
    verification: {
      items: [{ id: "future-check", state: "pending", evidence: "CI has not started" }],
    },
    documentation: {},
    risk: { level: "low" },
    review: {},
    mergeRequest: { removeSourceBranch: false, squash: false },
  };
}

function assertInvalidRequest(request: unknown): void {
  assertInputError(() => normalizeAndValidateRequest(request));
}

test("rejects root, nested and escaped duplicate JSON object keys", () => {
  for (const raw of [
    '{"title":1,"title":2}',
    '{"outer":{"title":1,"title":2}}',
    '{"title":1,"\\u0074itle":2}',
  ]) {
    assertInputError(() => parseStrictJson(raw), /duplicate/i);
  }
});

test("rejects non-strict, truncated, empty and multi-value JSON", () => {
  for (const raw of [
    '{"a":/* comment */1}',
    '{"a":1,}',
    '{"a":',
    '{"a":1}{"b":2}',
    '{"a":1} trailing',
    "",
    "   \r\n",
  ]) {
    assertInputError(() => parseStrictJson(raw));
  }
});

test("does not disclose JSON payloads through input errors", () => {
  const secret = "glpat-sensitive-value";
  assert.throws(() => parseStrictJson(`{"token":"${secret}",}`), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error instanceof Error && error.message.includes(secret), false);
    return true;
  });
});

test("rejects unsafe YAML graph features", () => {
  for (const raw of [
    "a: &value 1\nb: 2",
    "a: *value",
    "base: &base\n  a: 1\nvalue:\n  <<: *base",
    "a: !custom value",
    "a: !!timestamp 2026-08-13",
    "a: !!binary SGVsbG8=",
    "a: !!set\n  value: null",
    "? [a, b]\n: value",
    "1: value",
    "a: .nan",
    "a: .inf",
  ]) {
    assertInputError(() => parseStrictYaml(raw));
  }
});

test("rejects duplicate keys, empty YAML and every extra document", () => {
  for (const raw of [
    "a: 1\na: 2",
    "",
    "# comment only\n",
    "---",
    "---\n# empty document",
    "a: 1\n---\nb: 2",
    "a: 1\n---",
  ]) {
    assertInputError(() => parseStrictYaml(raw));
  }
});

test("accepts the exact byte limit and rejects one byte over it", () => {
  const exact = Buffer.alloc(MAX_INPUT_BYTES, 0x20);
  exact.write("null", 0, "utf8");
  assert.equal(decodeInputBytes(exact, "json"), null);

  assert.throws(() => decodeInputBytes(Buffer.concat([exact, Buffer.from(" ")]), "json"), (error) => {
    assert.equal(isToolError(error, "INPUT_TOO_LARGE"), true);
    return true;
  });
});

test("uses fatal UTF-8 decoding and permits only one leading BOM", () => {
  assert.deepEqual(
    decodeInputBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]), "json"),
    { a: 1 },
  );
  for (const bytes of [
    Uint8Array.from([0xc3, 0x28]),
    Uint8Array.from([0xe2, 0x82]),
    Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]),
      Buffer.from('{"a":1}'),
    ]),
    Buffer.from('{"a":"\ufeff"}', "utf8"),
  ]) {
    assertInputError(() => decodeInputBytes(bytes, "json"));
  }
});

test("rejects unsupported runtime formats instead of treating them as YAML", async () => {
  assertInputError(() => decodeInputBytes(Buffer.from("a: 1"), "toml" as never));
  const io: InputIo = {
    statFile: async () => ({ size: 4 }),
    readFile: async () => Buffer.from("null"),
    stdin: (async function* () {})(),
  };
  await assert.rejects(
    loadInputTransport({ kind: "file", path: "request.json", format: "toml" as never }, io),
    (error) => isToolError(error, "INPUT_ERROR"),
  );
});

test("rejects malformed runtime transports with ToolError", async () => {
  const io: InputIo = {
    statFile: async () => ({ size: 4 }),
    readFile: async () => Buffer.from("null"),
    stdin: (async function* () {})(),
  };
  for (const transport of [
    null,
    {},
    { kind: "other", format: "json" },
    { kind: "file", path: 17, format: "json" },
  ]) {
    await assert.rejects(
      loadInputTransport(transport as never, io),
      (error) => isToolError(error, "INPUT_ERROR"),
    );
  }
});

test("selects file format explicitly or from case-insensitive extensions", async () => {
  const calls: string[] = [];
  const io: InputIo = {
    statFile: async (path) => ({ size: Buffer.byteLength(path.endsWith("JSON") ? '{"a":1}' : "a: 1") }),
    readFile: async (path) => {
      calls.push(path);
      return Buffer.from(path.endsWith("JSON") ? '{"a":1}' : "a: 1");
    },
    stdin: (async function* () {})(),
  };
  assert.deepEqual(await loadInputTransport({ kind: "file", path: "request.JSON" }, io), { a: 1 });
  assert.deepEqual(
    await loadInputTransport({ kind: "file", path: "request.json", format: "yaml" }, io),
    { a: 1 },
  );
  await assert.rejects(
    loadInputTransport({ kind: "file", path: "request.txt" }, io),
    (error) => isToolError(error, "INPUT_ERROR"),
  );
  assert.deepEqual(calls, ["request.JSON", "request.json"]);
});

test("checks file size before and after reading", async () => {
  let reads = 0;
  const makeIo = (statSize: number, contents: Uint8Array): InputIo => ({
    statFile: async () => ({ size: statSize }),
    readFile: async () => {
      reads += 1;
      return contents;
    },
    stdin: (async function* () {})(),
  });
  await assert.rejects(
    loadInputTransport(
      { kind: "file", path: "request.json" },
      makeIo(MAX_INPUT_BYTES + 1, Buffer.from("null")),
    ),
    (error) => isToolError(error, "INPUT_TOO_LARGE"),
  );
  assert.equal(reads, 0);
  await assert.rejects(
    loadInputTransport(
      { kind: "file", path: "request.json" },
      makeIo(4, Buffer.alloc(MAX_INPUT_BYTES + 1, 0x20)),
    ),
    (error) => isToolError(error, "INPUT_TOO_LARGE"),
  );
  assert.equal(reads, 1);
});

test("requires stdin format and stops after observing max plus one bytes", async () => {
  let chunksRead = 0;
  let closed = false;
  async function* oversized(): AsyncGenerator<Uint8Array> {
    try {
      chunksRead += 1;
      yield Buffer.alloc(MAX_INPUT_BYTES, 0x20);
      chunksRead += 1;
      yield Buffer.from("x");
      chunksRead += 1;
      yield Buffer.from("unreachable");
    } finally {
      closed = true;
    }
  }
  const io: InputIo = {
    statFile: async () => ({ size: 0 }),
    readFile: async () => Buffer.alloc(0),
    stdin: oversized(),
  };
  await assert.rejects(
    loadInputTransport({ kind: "stdin" } as never, io),
    (error) => isToolError(error, "INPUT_ERROR"),
  );
  io.stdin = oversized();
  await assert.rejects(
    loadInputTransport({ kind: "stdin", format: "json" }, io),
    (error) => isToolError(error, "INPUT_TOO_LARGE"),
  );
  assert.equal(chunksRead, 2);
  assert.equal(closed, true);
});

test("does not let stdin cleanup failures mask an oversized input error", async () => {
  const source = {
    async *[Symbol.asyncIterator](): AsyncGenerator<Uint8Array> {
      yield Buffer.alloc(MAX_INPUT_BYTES + 1);
    },
    destroy(): never {
      throw new Error("cleanup secret");
    },
  };
  const io: InputIo = {
    statFile: async () => ({ size: 0 }),
    readFile: async () => Buffer.alloc(0),
    stdin: source,
  };
  await assert.rejects(
    loadInputTransport({ kind: "stdin", format: "json" }, io),
    (error) => isToolError(error, "INPUT_TOO_LARGE"),
  );
});

test("sanitizes parser and source failures without serializing their causes", async () => {
  const secret = "glpat-source-secret";
  assert.throws(() => parseStrictYaml(`value: !${secret} x`), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
  const io: InputIo = {
    statFile: async () => { throw new Error(secret); },
    readFile: async () => Buffer.alloc(0),
    stdin: (async function* () { throw new Error(secret); })(),
  };
  for (const operation of [
    () => loadInputTransport({ kind: "file", path: secret, format: "json" }, io),
    () => loadInputTransport({ kind: "stdin", format: "json" }, io),
  ]) {
    await assert.rejects(operation(), (error: unknown) => {
      assert.equal(isToolError(error, "INPUT_ERROR"), true);
      assert.equal(JSON.stringify(error).includes(secret), false);
      assert.equal(error instanceof Error && error.message.includes(secret), false);
      return true;
    });
  }
});

test("equivalent complete JSON and YAML fixtures normalize identically", async () => {
  const fixtureRoot = new URL("../fixtures/requests/", import.meta.url);
  const [json, yaml] = await Promise.all([
    readFile(new URL("code-docs.json", fixtureRoot)),
    readFile(new URL("code-docs.yml", fixtureRoot)),
  ]);
  const normalizedJson = normalizeAndValidateRequest(decodeInputBytes(json, "json"));
  const normalizedYaml = normalizeAndValidateRequest(decodeInputBytes(yaml, "yaml"));
  assert.deepEqual(normalizedYaml, normalizedJson);
  assert.equal(normalizedJson.title.titleSummary, "Preserve e\u0301 and \u4e2d\u6587 text");
  assert.equal(normalizedJson.changes.summary[0], "  First line\nSecond line  ");
  assert.equal(normalizedJson.verification.items[0]?.command, null);
  assert.equal(normalizedJson.verification.items[0]?.result, " 274 tests passed ");
  assert.deepEqual(normalizedJson.changes.technicalChanges, []);
  assert.deepEqual(normalizedJson.profileFields, {});
  assert.deepEqual(normalizedJson.review.reviewerCandidateTokens, [
    "reviewer-token:02",
    "reviewer-token:01",
  ]);
});

test("keeps Bundle membership out of the base request schema", () => {
  const normalized = normalizeAndValidateRequest(validRequest());
  assert.deepEqual(normalized.profileIds, ["future-profile"]);
  assert.equal(normalized.title.type, "future-type");
  assert.deepEqual(normalized.impact.areaIds, ["future-area"]);
  assert.equal(normalized.verification.items[0]?.id, "future-check");
});

test("rejects unknown properties at every fixed request object boundary", () => {
  const root = validRequest();
  root.unexpected = "secret-value";
  assertInvalidRequest(root);

  const nested = validRequest();
  (nested.title as Record<string, unknown>).unexpected = true;
  assertInvalidRequest(nested);

  const item = validRequest();
  const verification = item.verification as { items: Record<string, unknown>[] };
  verification.items[0]!.unexpected = "value";
  assertInvalidRequest(item);

  const prototypeKey = parseStrictJson(JSON.stringify({
    ...validRequest(),
    title: {
      type: "fix",
      module: "module",
      titleSummary: "Title",
    },
  }).replace('"titleSummary":"Title"', '"titleSummary":"Title","__proto__":true'));
  assertInvalidRequest(prototypeKey);
});

test("enforces the work item tagged union", () => {
  for (const workItem of [
    { relation: "related" },
    { relation: "closes", iid: 0 },
    { relation: "related", iid: 51, noIssueReason: "conflict" },
    { relation: "none" },
    { relation: "none", iid: 51, noIssueReason: "conflict" },
    { relation: "none", noIssueReason: "N / A" },
  ]) {
    const request = validRequest();
    request.workItem = workItem;
    assertInvalidRequest(request);
  }
  for (const workItem of [
    { relation: "closes", iid: 1 },
    { relation: "related", iid: 51 },
    { relation: "none", noIssueReason: "No tracked issue is required" },
  ]) {
    const request = validRequest();
    request.workItem = workItem;
    assert.equal(normalizeAndValidateRequest(request).workItem.relation, workItem.relation);
  }
});

test("rejects duplicate canonical IDs and tokens", () => {
  const mutations: ((request: Record<string, unknown>) => void)[] = [
    (request) => { request.profileIds = ["code", " code "]; },
    (request) => { (request.impact as Record<string, unknown>).areaIds = ["app", " app "]; },
    (request) => { (request.documentation as Record<string, unknown>).itemIds = ["readme", " readme "]; },
    (request) => {
      (request.review as Record<string, unknown>).reviewerCandidateTokens = ["user:1", " user:1 "];
    },
    (request) => {
      (request.mergeRequest as Record<string, unknown>).labelCandidateTokens = ["label:1", " label:1 "];
    },
    (request) => {
      (request.verification as Record<string, unknown>).items = [
        { id: "check", state: "pending", evidence: "first" },
        { id: " check ", state: "pending", evidence: "second" },
      ];
    },
  ];
  for (const mutate of mutations) {
    const request = validRequest();
    mutate(request);
    assertInvalidRequest(request);
  }
});

test("enforces module syntax and Unicode-scalar title limits", () => {
  const validModules = ["a", "a".repeat(32), "abc-123"];
  for (const module of validModules) {
    const request = validRequest();
    (request.title as Record<string, unknown>).module = module;
    assert.equal(normalizeAndValidateRequest(request).title.module, module);
  }
  for (const module of ["", "-abc", "abc-", "abc--def", "ABC", "a_b", "a".repeat(33)]) {
    const request = validRequest();
    (request.title as Record<string, unknown>).module = module;
    assertInvalidRequest(request);
  }

  const title72 = "\ud83d\ude80".repeat(72);
  const request72 = validRequest();
  (request72.title as Record<string, unknown>).titleSummary = title72;
  assert.equal([...normalizeAndValidateRequest(request72).title.titleSummary].length, 72);
  const request73 = validRequest();
  (request73.title as Record<string, unknown>).titleSummary = `${title72}\ud83d\ude80`;
  assertInvalidRequest(request73);
});

test("rejects title newlines, existing prefixes and obvious Markdown", () => {
  for (const titleSummary of [
    "line one\nline two",
    "line one\u2028line two",
    "Draft: existing title",
    "[fix][module] Existing title",
    "Draft: [fix][module] Existing title",
    "## Heading",
    "- list item",
    "[link](https://example.invalid)",
    "`inline code`",
  ]) {
    const request = validRequest();
    (request.title as Record<string, unknown>).titleSummary = titleSummary;
    assertInvalidRequest(request);
  }
});

test("rejects blank or placeholder provided prose and always requires evidence", () => {
  for (const placeholder of ["   ", "\u65e0", "n/a", "N / A", " t b d "]) {
    const request = validRequest();
    (request.changes as { summary: string[] }).summary = [placeholder];
    assertInvalidRequest(request);
  }
  for (const evidence of [undefined, null, "", "N/A", " t b d "]) {
    const request = validRequest();
    const verification = request.verification as { items: Record<string, unknown>[] };
    if (evidence === undefined) {
      delete verification.items[0]!.evidence;
    } else {
      verification.items[0]!.evidence = evidence;
    }
    assertInvalidRequest(request);
  }
});

test("rejects placeholders in titles, identities, IDs and candidate tokens", () => {
  const mutations: ((request: Record<string, unknown>) => void)[] = [
    (request) => { request.contextId = "N / A"; },
    (request) => { request.targetBranch = " t b d "; },
    (request) => { request.profileIds = ["N/A"]; },
    (request) => { (request.title as Record<string, unknown>).type = "TBD"; },
    (request) => { (request.title as Record<string, unknown>).module = "tbd"; },
    (request) => { (request.title as Record<string, unknown>).titleSummary = "\u65e0"; },
    (request) => { (request.impact as Record<string, unknown>).areaIds = ["TBD"]; },
    (request) => {
      (request.verification as { items: Record<string, unknown>[] }).items[0]!.id = "N/A";
    },
    (request) => { (request.documentation as Record<string, unknown>).itemIds = ["TBD"]; },
    (request) => {
      (request.review as Record<string, unknown>).reviewerCandidateTokens = ["N/A"];
    },
    (request) => {
      (request.mergeRequest as Record<string, unknown>).assigneeCandidateToken = "TBD";
    },
    (request) => {
      (request.mergeRequest as Record<string, unknown>).labelCandidateTokens = ["N/A"];
    },
  ];
  for (const mutate of mutations) {
    const request = validRequest();
    mutate(request);
    assertInvalidRequest(request);
  }
});

test("normalizes only declared semantic empties and preserves prose whitespace and Unicode", () => {
  const request = validRequest();
  (request.title as Record<string, unknown>).titleSummary = "  e\u0301 title  ";
  (request.changes as { summary: string[] }).summary = ["  prose\rline  "];
  const verification = request.verification as { items: Record<string, unknown>[] };
  verification.items[0]!.command = "   ";
  verification.items[0]!.result = "  result  ";
  const normalized = normalizeAndValidateRequest(request);
  assert.equal(normalized.title.titleSummary, "e\u0301 title");
  assert.notEqual(normalized.title.titleSummary, "\u00e9 title");
  assert.equal(normalized.changes.summary[0], "  prose\nline  ");
  assert.equal(normalized.verification.items[0]?.command, null);
  assert.equal(normalized.verification.items[0]?.result, "  result  ");

  for (const requiredField of ["intent", "targetBranch", "workItem", "risk", "mergeRequest"]) {
    const missing = validRequest();
    delete missing[requiredField];
    assertInvalidRequest(missing);
  }
  const missingBoolean = validRequest();
  delete (missingBoolean.mergeRequest as Record<string, unknown>).squash;
  assertInvalidRequest(missingBoolean);
});

test("sanitizes request validation errors and snapshots caller-owned values", () => {
  const secret = "glpat-request-secret";
  const request = validRequest();
  request.unexpected = secret;
  assert.throws(() => normalizeAndValidateRequest(request), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(JSON.stringify(error).includes(secret), false);
    assert.equal(error instanceof Error && error.message.includes(secret), false);
    return true;
  });

  delete request.unexpected;
  const normalized = normalizeAndValidateRequest(request);
  (request.title as Record<string, unknown>).titleSummary = "mutated";
  assert.equal(normalized.title.titleSummary, "A valid title");
});

test("masks dynamic profile field keys in validation errors", () => {
  const secret = "glpat-profile-field-secret";
  const request = validRequest();
  request.profileFields = { [secret]: ["N/A"] };
  assert.throws(() => normalizeAndValidateRequest(request), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(JSON.stringify(error).includes(secret), false);
    return true;
  });
});

test("rejects object-meta property names in dynamic profile fields", () => {
  for (const fieldId of ["__proto__", "prototype", "constructor"]) {
    const request = validRequest();
    request.profileFields = Object.fromEntries([[fieldId, ["Specific content"]]]);
    assertInvalidRequest(request);
  }
});
