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
const input = { diff, binding, inventory };

test("automatically selects exactly doc/p2/review without any caller title or label tokens", () => {
  const selection = mandatory.selectMandatoryLabels(input);
  assert.deepEqual(selection.names, ["type::doc", "priority::p2", "status::review"]);
  assert.equal(selection.titleType, "docs");
  assert.deepEqual(selection.ids, ["3", "12", "13"]);
  assert.equal(selection.source, "diff");
  assert.equal(Object.isFrozen(selection.names), true);
});
test("the review lifecycle status is fixed and exported; no selection yields a Draft status", () => {
  assert.equal(mandatory.MANDATORY_STATUS_LABEL, "status::review");
  const selection = mandatory.selectMandatoryLabels(input);
  assert.equal(selection.names[2], mandatory.MANDATORY_STATUS_LABEL);
  assert.equal(selection.names.includes("status::doing"), false);
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
test("unknown intent and mixed primary types automatically use stable chore without caller confirmation", () => {
  for (const items of [
    [{ status: "modified", newPath: "src/auth.ts", binary: false, submodule: false, before: "const x = 1;", after: "const x = 2;" }],
    [{ status: "modified", newPath: "package.json", binary: false, submodule: false }, { status: "modified", newPath: ".gitlab-ci.yml", binary: false, submodule: false }],
    [{ status: "modified", newPath: "assets/data.bin", binary: true, submodule: false }],
  ] as const) {
    const selection = mandatory.selectMandatoryLabels({ ...input, diff: { ...diff, items } });
    assert.deepEqual(selection.names, ["type::chore", "priority::p2", "status::review"]);
    assert.equal(selection.source, "fallback");
    assert.equal(selection.titleType, "chore");
    assert.equal(selection.diffDigest, mandatory.labelDiffDigest({ ...diff, items }));
  }
});
test("obsolete human type fields cannot override an automatically detected or fallback type", () => {
  for (const options of [{ confirmedType: "bug" }, { confirmationDigest: mandatory.labelDiffDigest(diff) },
    { confirmedType: "bug", confirmationDigest: mandatory.labelDiffDigest(diff) }]) {
    assert.throws(() => mandatory.selectMandatoryLabels({ ...input, options: options as never }), (error: unknown) => {
      assert.equal((error as { code: string }).code, "LABEL_ERROR");
      assert.doesNotMatch((error as Error).message, /requires confirmation|stale type confirmation/u);
      return true;
    });
  }
});
test("the WASM adapter comment change selects doc without a type or digest argument", () => {
  const selection = mandatory.selectMandatoryLabels({ ...input, diff: { ...diff, items: [{
    status: "modified", newPath: "luban-web-wasm/src/lb_web_runtime.ts", binary: false, submodule: false,
    before: "// This thin adapter owns JS/WASM copying and leaves command semantics in C++.\nexport class LbWebRuntime {}\n",
    after: "// This adapter handles JS/WASM data copying while command semantics stay in C++.\nexport class LbWebRuntime {}\n",
  }] } });
  assert.deepEqual(selection.names, ["type::doc", "priority::p2", "status::review"]);
  assert.equal(selection.source, "diff");
});
test("malformed diff items remain errors rather than becoming the unknown fallback", () => {
  assert.throws(() => mandatory.selectMandatoryLabels({ ...input, diff: { ...diff, items: [{ status: "invalid" } as never] } }), { code: "LABEL_ERROR" });
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
});
test("final-label validation rejects week, foreign names, missing/duplicate categories and status drift", () => {
  assert.doesNotThrow(() => mandatory.assertMandatoryLabelNames(["type::bug", "priority::p2", "status::review"]));
  for (const names of [
    ["type::bug", "priority::p2"],
    ["type::bug", "priority::p2", "status::review", "week::2026-w36"],
    ["type::bug", "priority::p2", "status::review", "team::qa"],
    ["type::bug", "type::doc", "status::review"],
    ["type::invented", "priority::p2", "status::review"],
    ["type::bug", "priority::p2", "status::doing"],
  ]) assert.throws(() => mandatory.assertMandatoryLabelNames(names), { code: "LABEL_ERROR" });
});
