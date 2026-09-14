import assert from "node:assert/strict";
import test from "node:test";
import type { DiffItem } from "../../src/bundle/detect-profile.ts";
import { typeLabelFromDiff } from "../../src/app/diff-labels.ts";

type Change = DiffItem & { readonly before?: string; readonly after?: string };
const modified = (newPath: string, before?: string, after?: string): Change => ({
  status: "modified", newPath, binary: false, submodule: false,
  ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }),
});

for (const path of ["src/prefix.ts", "src/address.ts", "src/remove.ts", "src/cache.ts", "src/features.ts", "src/patch.ts"]) {
  test(`does not infer semantic intent from the path ${path}`, () => {
    assert.equal(typeLabelFromDiff([modified(path, "const x = 1;", "const x = 2;")]), null);
  });
}
for (const [path, label] of [
  ["docs/usage.md", "type::doc"], ["README.md", "type::doc"],
  ["test/login.test.ts", "type::test"], ["src/auth.spec.ts", "type::test"],
  [".github/workflows/test.yml", "type::ci"], [".gitlab-ci.yml", "type::ci"],
  ["package-lock.json", "type::build"], ["packages/ui/tsconfig.json", "type::build"],
  [".gitignore", "type::chore"], [".editorconfig", "type::chore"],
] as const) {
  test(`classifies explicit maintenance surface ${path}`, () => {
    assert.equal(typeLabelFromDiff([modified(path)]), label);
  });
}
for (const path of ["docs/execute.ts", "data/custom.txt", ".github/custom.ts", "src/workflows/login.ts", "assets/unknown.bin"]) {
  test(`does not silently classify unknown executable/data surface ${path}`, () => {
    assert.equal(typeLabelFromDiff([modified(path)]), null);
  });
}
test("binary and submodule changes always require confirmation, including misleading documentation paths", () => {
  assert.equal(typeLabelFromDiff([{ ...modified("README.md"), binary: true }]), null);
  assert.equal(typeLabelFromDiff([{ ...modified("docs/manual.md"), submodule: true }]), null);
});
test("renaming code into docs cannot disguise its deletion as documentation", () => {
  assert.equal(typeLabelFromDiff([{ status: "renamed", oldPath: "src/a.ts", newPath: "docs/a.md", binary: false, submodule: false }]), null);
});
test("a boundary-condition fix plus regression tests has bug as the primary type", () => {
  assert.equal(typeLabelFromDiff([
    modified("src/login.ts", "if (attempts > max) { return false; }", "if (attempts >= max) { return false; }"),
    modified("test/login.test.ts", "", "test('rejects at max', () => assert.equal(login(max), false));"),
    modified("docs/login.md"),
  ]), "type::bug");
});
test("a new public function plus tests and docs has feature as the primary type", () => {
  assert.equal(typeLabelFromDiff([
    { status: "added", newPath: "src/export.ts", binary: false, submodule: false, after: "export function exportCsv(rows) { return rows.join(','); }" },
    modified("test/export.test.ts"), modified("README.md"),
  ]), "type::feature");
});
test("source-only identical-content rename is refactoring", () => {
  assert.equal(typeLabelFromDiff([{
    status: "renamed", oldPath: "src/a.ts", newPath: "src/b.ts", binary: false, submodule: false,
    before: "export const x = 1;", after: "export const x = 1;",
  }]), "type::refactor");
});
test("replacing membership scans with a precomputed Set is a recognized performance pattern", () => {
  assert.equal(typeLabelFromDiff([modified("src/select.ts",
    "export function select(items, ids) { return items.filter(item => ids.includes(item.id)); }",
    "export function select(items, ids) { const lookup = new Set(ids); return items.filter(item => lookup.has(item.id)); }",
  )]), "type::performance");
});
test("unknown source mixed with tests is not a test-only change", () => {
  assert.equal(typeLabelFromDiff([modified("src/a.ts"), modified("test/a.test.ts")]), null);
});
test("unrelated primary types require confirmation instead of arbitrary precedence", () => {
  assert.equal(typeLabelFromDiff([modified("package.json"), modified(".github/workflows/build.yml")]), null);
});
test("empty diff and unsupported items are not chore", () => {
  assert.equal(typeLabelFromDiff([]), null);
  assert.equal(typeLabelFromDiff([{ status: "invalid" } as unknown as DiffItem]), null);
});

for (const [context, content] of [
  ["block comment", "/*\nexport function sample() {}\n*/\n"],
  ["template literal", "export const example = `\nexport function sample() {}\n`;\n"],
  ["continued quoted string", "const example = \"example\\\nexport function sample() {}\";\n"],
] as const) {
  test(`export examples inside a ${context} require confirmation rather than feature classification`, () => {
    assert.equal(typeLabelFromDiff([{
      status: "added", newPath: "src/example.ts", binary: false, submodule: false, after: content,
    }]), null);
    const before = "export const value = 1;\n";
    assert.equal(typeLabelFromDiff([modified("src/example.ts", before, before + content)]), null);
  });
}
for (const before of ["/*\n", "const example = `\n"]) {
  test(`an appended export cannot escape the existing lexical context ${JSON.stringify(before)}`, () => {
    const closing = before.startsWith("/*") ? "*/\n" : "`;\n";
    assert.equal(typeLabelFromDiff([modified("src/example.ts", before,
      before + "export function sample() {}\n" + closing)]), null);
  });
}
test("simple genuine added and appended declarations still classify as features", () => {
  for (const declaration of [
    "export function sample() { return 'text'; }\n",
    "export async function sample() { return 1; }\n",
    "export class Sample { value = `text`; }\n",
  ]) {
    assert.equal(typeLabelFromDiff([{
      status: "added", newPath: "src/example.ts", binary: false, submodule: false, after: declaration,
    }]), "type::feature");
    const before = "export const value = 1;\n";
    assert.equal(typeLabelFromDiff([modified("src/example.ts", before, before + declaration)]), "type::feature");
  }
});
