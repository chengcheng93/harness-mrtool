import assert from "node:assert/strict";
import test from "node:test";
import { discoverRepository } from "../../src/git/repository.ts";
import * as changes from "../../src/git/change-set.ts";
import { typeLabelFromDiff } from "../../src/app/diff-labels.ts";
import { GitFixture } from "../helpers/git-fixture.ts";

test("reads label evidence from committed blobs, not the dirty working tree or commit title", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.commitFile("src/public.ts", "export function run() { return 1; }\n", "fix: misleading title");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    await fixture.write("src/public.ts", "working tree is not committed evidence\n");
    assert.equal(typeof changes.readCanonicalLabelDiff, "function");
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.equal(diff.sourceHeadSha, await fixture.head());
    assert.equal(diff.targetRefSha, await fixture.targetHead());
    assert.deepEqual(diff.items, [{
      status: "added", newPath: "src/public.ts", binary: false, submodule: false,
      after: "export function run() { return 1; }\n",
    }]);
    assert.equal(typeLabelFromDiff(diff.items), "type::feature");
    assert.equal(Object.isFrozen(diff), true);
    assert.equal(Object.isFrozen(diff.items[0]), true);
  } finally { await fixture.dispose(); }
});

test("reads both sides of a committed comparison fix and supporting tests", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.commitFile("src/login.ts", "if (attempts > max) { return false; }\n", "baseline");
    await fixture.git(["update-ref", "refs/remotes/origin/main", await fixture.head()]);
    await fixture.write("src/login.ts", "if (attempts >= max) { return false; }\n");
    await fixture.write("test/login.test.ts", "test('boundary', () => {});\n");
    await fixture.commitAll("chore: misleading title");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    assert.equal(typeof changes.readCanonicalLabelDiff, "function");
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.equal(typeLabelFromDiff(diff.items), "type::bug");
    const source = diff.items.find((item) => "newPath" in item && item.newPath === "src/login.ts");
    assert.equal(source?.before, "if (attempts > max) { return false; }\n");
    assert.equal(source?.after, "if (attempts >= max) { return false; }\n");
  } finally { await fixture.dispose(); }
});

test("binary content and symlinks cannot masquerade as readable documentation", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.write("docs/binary.md", Buffer.from([0, 255, 0, 1]));
    await fixture.commitAll("docs");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    assert.equal(typeof changes.readCanonicalLabelDiff, "function");
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.equal(typeLabelFromDiff(diff.items), null);
    assert.equal(diff.items[0]?.after, undefined);
  } finally { await fixture.dispose(); }
});

test("committed symlinks named as Markdown remain ambiguous without host symlink privileges", async () => {
  const fixture = await GitFixture.create();
  try {
    // The classifier reads committed Git mode/blob evidence, not the checkout.
    // Stage mode 120000 directly so Windows needs no symlink privilege.
    await fixture.stageIndexEntry("link.md", "src/modified.ts", "120000");
    await fixture.git(["commit", "-m", "docs"]);
    assert.match(await fixture.git(["ls-tree", "HEAD", "--", "link.md"]), /^120000 blob /u);
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.deepEqual(diff.items.map(item => "newPath" in item ? item.newPath : undefined), ["link.md"]);
    assert.equal(typeLabelFromDiff(diff.items), null);
    assert.equal(diff.items[0]?.after, undefined);
  } finally { await fixture.dispose(); }
});

test("untrusted git attributes cannot make binary blobs classify as docs", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.commitFile(".gitattributes", "*.md diff\n", "attributes baseline");
    await fixture.git(["update-ref", "refs/remotes/origin/main", await fixture.head()]);
    await fixture.write("docs/binary.md", Buffer.from([97, 0, 98]));
    await fixture.commitAll("docs");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.equal(typeLabelFromDiff(diff.items), null);
    assert.equal(diff.items[0]?.after, undefined);
  } finally { await fixture.dispose(); }
});

test("reads renamed before/after blobs without matching other glob-like filenames", async () => {
  const fixture = await GitFixture.create();
  try {
    // Bracket syntax is glob-like but legal on Windows, unlike '*'. An
    // unchanged matching decoy ensures literal lookup cannot read another blob.
    await fixture.commitFile("src/n.ts", "export const decoy = true;\n", "decoy baseline");
    await fixture.git(["update-ref", "refs/remotes/origin/main", await fixture.head()]);
    await fixture.rename("src/rename-old.ts", "src/[new].ts");
    await fixture.commitAll("refactor");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    const diff = await changes.readCanonicalLabelDiff(repository);
    assert.equal(typeLabelFromDiff(diff.items), "type::refactor");
    assert.equal(diff.items.length, 1);
    assert.equal(diff.items[0]?.status, "renamed");
    assert.equal(diff.items[0]?.newPath, "src/[new].ts");
    assert.equal(diff.items[0]?.before, "export const renamed = true;\n");
    assert.equal(diff.items[0]?.before, diff.items[0]?.after);
  } finally { await fixture.dispose(); }
});

test("rejects oversized content before classifying or allocating an unbounded diff", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.commitFile("README.md", "x".repeat(1024 * 1024 + 1), "docs");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    await assert.rejects(changes.readCanonicalLabelDiff(repository), { code: "REPOSITORY_ERROR" });
  } finally { await fixture.dispose(); }
});

test("committed nested attributes remain authoritative for label evidence over staged and local overrides", async () => {
  const fixture = await GitFixture.create();
  try {
    await fixture.commitFile("docs/.gitattributes", "*.md diff\n", "target attributes");
    await fixture.git(["update-ref", "refs/remotes/origin/main", await fixture.head()]);
    await fixture.write("docs/.gitattributes", "*.md binary\n");
    await fixture.write("docs/opaque.md", "looks like readable documentation\n");
    await fixture.commitAll("source attributes");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    await fixture.write("docs/.gitattributes", "*.md diff\n");
    await fixture.git(["add", "docs/.gitattributes"]);
    await fixture.write(".git/info/attributes", "*.md diff\n");

    const diff = await changes.readCanonicalLabelDiff(repository);
    const opaque = diff.items.find((item) => "newPath" in item && item.newPath === "docs/opaque.md");
    assert.ok(opaque);
    assert.equal(opaque.binary, true);
    assert.equal(opaque.after, undefined);
    assert.equal(typeLabelFromDiff([opaque]), null);
  } finally { await fixture.dispose(); }
});

test("ambient GIT_ATTR_SOURCE cannot override source-committed binary attributes", async () => {
  const fixture = await GitFixture.create();
  const previous = process.env.GIT_ATTR_SOURCE;
  try {
    await fixture.commitFile("docs/.gitattributes", "*.md diff\n", "target attributes");
    const target = await fixture.head();
    await fixture.git(["update-ref", "refs/remotes/origin/main", target]);
    await fixture.write("docs/.gitattributes", "*.md binary\n");
    await fixture.write("docs/opaque.md", "looks like ordinary documentation\n");
    await fixture.commitAll("source binary attributes");
    const repository = await discoverRepository({ cwd: fixture.worktreePath, targetBranch: "main" });
    process.env.GIT_ATTR_SOURCE = target;
    const diff = await changes.readCanonicalLabelDiff(repository);
    const opaque = diff.items.find(item => "newPath" in item && item.newPath === "docs/opaque.md");
    assert.ok(opaque);
    assert.equal(opaque.binary, true);
    assert.equal(opaque.after, undefined);
    assert.equal(typeLabelFromDiff([opaque]), null);
  } finally {
    if (previous === undefined) delete process.env.GIT_ATTR_SOURCE;
    else process.env.GIT_ATTR_SOURCE = previous;
    await fixture.dispose();
  }
});
