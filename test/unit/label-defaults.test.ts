import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LABEL_POOL, defaultLabelNames } from "../../src/app/label-defaults.ts";

test("exposes the fixed 14-label pool without week labels", () => {
  assert.deepEqual(DEFAULT_LABEL_POOL, [
    "type::feature", "type::bug", "type::doc", "type::test", "type::refactor",
    "type::performance", "type::build", "type::ci", "type::chore",
    "priority::p0", "priority::p1", "priority::p2", "status::doing", "status::review",
  ]);
  assert.equal(DEFAULT_LABEL_POOL.some((name) => name.startsWith("week::")), false);
});

test("defaults to p2 and does not select week labels", () => {
  const defaults = defaultLabelNames([
    { name: "priority::p0", category: "priority" },
    { name: "priority::p2", category: "priority" },
    { name: "week::2026-w36", category: "week" },
    { name: "type::bug", category: "type" },
  ]);
  assert.deepEqual([...defaults], ["priority::p2"]);
});

import { typeLabelFromDiff } from "../../src/app/diff-labels.ts";

test("classifies a diff deterministically and fails closed for mixed intent", () => {
  assert.equal(typeLabelFromDiff([{ status: "modified", binary: false, submodule: false, newPath: "src/login.ts" }]), null);
  assert.equal(typeLabelFromDiff([{ status: "modified", binary: false, submodule: false, newPath: "docs/guide.md" }]), "type::doc");
  assert.equal(typeLabelFromDiff([{ status: "modified", binary: false, submodule: false, newPath: "src/a.ts" }, { status: "modified", binary: false, submodule: false, newPath: "test/a.test.ts" }]), null);
});
