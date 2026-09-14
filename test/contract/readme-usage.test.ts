import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { normalizeAndValidateRequest } from "../../src/input/normalize.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";

const root = resolve(import.meta.dirname, "../..");

test("README draft example is schema-valid, pending, and never contains fabricated candidate tokens", async () => {
  const raw = JSON.parse(await readFile(resolve(root, "examples/request.draft.json"), "utf8"));
  const request = normalizeAndValidateRequest(raw);
  assert.equal(request.intent, "draft");
  assert.match(request.contextId, /REPLACE_FROM_CONTEXT_OUTPUT/u);
  assert.deepEqual(request.mergeRequest.labelCandidateTokens, []);
  assert.equal(request.mergeRequest.assigneeCandidateToken, null);
  assert.deepEqual(request.review.reviewerCandidateTokens, []);
  assert.equal(request.verification.items.length, 4);
  for (const item of request.verification.items) {
    assert.equal(item.state, "pending");
    assert.equal(item.evidenceKind, "pending-reason");
    assert.equal(item.command, null);
    assert.equal(item.result, null);
  }
});

test("README CLI examples use supported commands and flags", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  const lines = [...readme.matchAll(/^hmr (.+)$/gmu)].map((match) => match[1]!);
  assert.ok(lines.length >= 25);
  for (const line of lines) {
    const expanded = line.replaceAll("<diffDigest>", "a".repeat(64))
      .replaceAll("<oldHash>:<newHash>", `${"a".repeat(64)}:${"b".repeat(64)}`);
    // The guide deliberately keeps examples single-line, with simple quoted values.
    const args = [...expanded.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/gu)]
      .map((match) => match[1] ?? match[2] ?? match[3]!);
    assert.doesNotThrow(() => parseCliInvocation(args), line);
  }
});

test("README distinguishes unpublished source, real API writes, manual handoff and fixed-three replacement", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");
  for (const phrase of ["尚未发布", "API MR 命令不自动 push", "恰好三个标签", "池外人工标签", "不自动复用", "HARNESS_MRTOOL_GITLAB_HOST", "HARNESS_MRTOOL_GITLAB_TOKEN", "--confirm-migration", "--label-diff-digest"]) {
    assert.ok(readme.includes(phrase), phrase);
  }
  assert.ok(readme.includes("[Draft 输入样例](examples/request.draft.json)"));
});
