import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { loadTemplateBundle } from "../../src/bundle/load.ts";
import { canonicalizeJson, sha256Utf8 } from "../../src/contracts/jcs.ts";
import { createManualCommandServices } from "../../src/cli/commands/manual.ts";
import { executeCliJson } from "../../src/cli/execute.ts";

const repositoryRoot = resolve(import.meta.dirname, "../..");

test("manual creation always requires API Issue-first create without reading input or touching Git", async (t) => {
  const bundle = await loadTemplateBundle(resolve(repositoryRoot, "template-bundle"));
  const raw = JSON.parse(await readFile(resolve(repositoryRoot, "examples/submission.json"), "utf8"));
  const workItems = [undefined, { relation: "new" }, { relation: "none", noIssueReason: "legacy" },
    { relation: "closes", iid: 7 }, { relation: "related", iid: 7 }];
  for (const auth of [[], ["--auth", "auto"], ["--auth", "api"], ["--auth", "ssh"]]) {
    for (const mode of [[], ["--push"], ["--ssh-mr"], ["--push", "--ssh-mr"]]) {
      for (const workItem of workItems) {
        await t.test(JSON.stringify({ auth, mode, workItem }), async () => {
          const touched: string[] = [];
          const services = createManualCommandServices({
            cliVersion: "0.1.12-test", cwd: repositoryRoot,
            currentBundle: { bundle, bundleManifestHash: sha256Utf8(canonicalizeJson(bundle.manifest) + "\n"),
              releaseSetId: "release-set:test", releaseTag: "templates-v1.2.0" },
            requestSource: { read: async () => { touched.push("input"); return { ...raw, workItem }; } },
            repository: {
              discover: async () => { touched.push("repository"); throw new Error("must not discover"); },
              mergeBase: async () => { touched.push("merge-base"); throw new Error("must not calculate"); },
              planPush: async () => { touched.push("plan"); throw new Error("must not plan"); },
              executePush: async () => { touched.push("push"); throw new Error("must not push"); },
            },
          });
          const chunks: string[] = [];
          const result = await executeCliJson(["manual", ...auth, ...mode, "--input", "-",
            "--input-format", "json", "--output", "json"], {
            cliVersion: "0.1.12-test", handlers: services,
            stdout: { write(chunk, callback) { chunks.push(chunk); callback(); return true; } },
          });
          const output = JSON.parse(chunks[0]!);
          assert.equal(result.exitCode, 2);
          assert.equal(output.code, "INPUT_ERROR");
          assert.match(JSON.stringify(output), /API create/u);
          assert.match(JSON.stringify(output), /Issue/u);
          assert.deepEqual(touched, []);
          assert.equal(output.remoteWrite.state, "not-attempted");
        });
      }
    }
  }
});
