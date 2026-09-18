import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { GitFixture } from "../helpers/git-fixture.ts";

for (const mode of ["100644", "120000"] as const) {
  test(`index fixture stages exact ${mode} bytes without a filesystem entry`, async () => {
    const fixture = await GitFixture.create();
    try {
      const path = "docs/[literal].md";
      const content = mode === "120000" ? "../src/modified.ts" : "literal committed bytes\r\n";
      const oid = await fixture.stageIndexEntry(path, content, mode);
      await assert.rejects(access(resolve(fixture.worktreePath, path)), {code: "ENOENT"});
      assert.match(oid, /^[a-f0-9]{40,64}$/u);
      await fixture.git(["commit", "-m", "commit exact index fixture"]);
      assert.equal(await fixture.git(["show", `HEAD:${path}`]), content);
      assert.equal((await fixture.git(["ls-tree", "HEAD", "--", `:(literal)${path}`])).split(" ")[0], mode);
      await assert.rejects(access(resolve(fixture.worktreePath, path)), {code: "ENOENT"});
    } finally {
      await fixture.dispose();
    }
  });
}
