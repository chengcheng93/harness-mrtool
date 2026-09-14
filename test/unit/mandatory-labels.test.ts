import assert from "node:assert/strict";
import test from "node:test";
import * as mandatory from "../../src/app/mandatory-labels.ts";
import { DEFAULT_LABEL_POOL } from "../../src/app/label-defaults.ts";
import type { CanonicalLabelChangeSet } from "../../src/git/change-set.ts";

const diff: CanonicalLabelChangeSet = {
  sourceHeadSha: "a".repeat(40), targetRefSha: "b".repeat(40), mergeBaseSha: "c".repeat(40),
  items: [{ status: "modified", newPath: "README.md", binary: false, submodule: false, before: "old", after: "new" }],
};
const binding = { sourceHeadSha: diff.sourceHeadSha, targetRefSha: diff.targetRefSha, mergeBaseSha: diff.mergeBaseSha };
const inventory = DEFAULT_LABEL_POOL.map((name, index) => ({ id: String(index + 1), name }));
const input = { diff, binding, inventory, intent: "ready" as const };

test("automatically selects exactly doc/p2/review without any caller title or label tokens", () => {
  const selection = mandatory.selectMandatoryLabels(input);
  assert.deepEqual(selection.names, ["type::doc", "priority::p2", "status::review"]);
  assert.equal(selection.titleType, "docs");
  assert.deepEqual(selection.ids, ["3", "12", "14"]);
  assert.equal(selection.source, "diff");
  assert.equal(Object.isFrozen(selection.names), true);
});
test("Draft defaults to doing and priority is not inferred from sensitive filenames", () => {
  const selection = mandatory.selectMandatoryLabels({ ...input, intent: "draft" });
  assert.deepEqual(selection.names, ["type::doc", "priority::p2", "status::doing"]);
});
test("an explicit priority elevation requires a reason and does not change type selection", () => {
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, options: { priority: "p0" } }), { code: "LABEL_ERROR" });
  assert.deepEqual(mandatory.selectMandatoryLabels({ ...input,
    options: { priority: "p0", priorityReason: "Production incident 42" },
  }).names, ["type::doc", "priority::p0", "status::review"]);
});
for (const field of ["sourceHeadSha", "targetRefSha", "mergeBaseSha"] as const) {
  test(`rejects stale ${field} before writing`, () => {
    assert.throws(() => mandatory.selectMandatoryLabels({ ...input, binding: { ...binding, [field]: "d".repeat(40) } }), { code: "LABEL_ERROR" });
  });
}
test("unknown intent never falls back to chore or an unconfirmed caller type", () => {
  const unknown: CanonicalLabelChangeSet = { ...diff, items: [{ status: "modified", newPath: "src/auth.ts", binary: false, submodule: false, before: "const x = 1;", after: "const x = 2;" }] };
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: unknown }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: unknown, options: { confirmedType: "bug" } }), { code: "LABEL_ERROR" });
  const digest = mandatory.labelDiffDigest(unknown);
  const selection = mandatory.selectMandatoryLabels({ ...input, diff: unknown, options: { confirmedType: "bug", confirmationDigest: digest } });
  assert.equal(selection.source, "confirmed");
  assert.equal(selection.names[0], "type::bug");
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: { ...unknown, sourceHeadSha: "e".repeat(40) }, binding: { ...binding, sourceHeadSha: "e".repeat(40) }, options: { confirmedType: "bug", confirmationDigest: digest } }), { code: "LABEL_ERROR" });
});
test("explicit confirmation cannot silently override a conclusive classifier result", () => {
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, options: { confirmedType: "bug", confirmationDigest: mandatory.labelDiffDigest(diff) } }), { code: "LABEL_ERROR" });
});
test("missing real labels and duplicate names or ids block rather than invent IDs", () => {
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, inventory: inventory.filter((entry) => entry.name !== "priority::p2") }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, inventory: [...inventory, { name: "priority::p2", id: "999" }] }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, inventory: inventory.map((entry) => ({ ...entry, id: "1" })) }), { code: "LABEL_ERROR" });
});
test("invented priority/type and incomplete diff evidence are rejected", () => {
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, options: { priority: "p9" as never } }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: undefined as never }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: { ...diff, items: [] } }), { code: "LABEL_ERROR" });
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, intent: "anything" as never }), { code: "LABEL_ERROR" });
});
test("final-label validation rejects week, foreign names, missing/duplicate categories and status drift", () => {
  assert.doesNotThrow(() => mandatory.assertMandatoryLabelNames(["type::bug", "priority::p2", "status::review"], "ready"));
  for (const names of [
    ["type::bug", "priority::p2"],
    ["type::bug", "priority::p2", "status::review", "week::2026-w36"],
    ["type::bug", "priority::p2", "status::review", "team::qa"],
    ["type::bug", "type::doc", "status::review"],
    ["type::invented", "priority::p2", "status::review"],
    ["type::bug", "priority::p2", "status::doing"],
  ]) assert.throws(() => mandatory.assertMandatoryLabelNames(names, "ready"), { code: "LABEL_ERROR" });
});
