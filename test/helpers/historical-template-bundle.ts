import { cp, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { loadTemplateBundle, type LoadedTemplateBundle } from "../../src/bundle/load.ts";

// Frozen published 1.0.0 bytes, not a reconstruction using today's policy/defaults.
export const historicalPolicy = "policySchema: 1\nlabels:\n  categories:\n    week:\n      match: \"^week::\"\n      required: true\n      max: 1\n    type:\n      match: \"^type::\"\n      required: true\n      max: 1\n    priority:\n      match: \"^priority::\"\n      required: true\n      max: 1\n    status:\n      match: \"^status::\"\n      required: true\n      max: 1\n  lifecycle:\n    statusCategory: status\n    expectedNames:\n      draft: \"status::doing\"\n      ready: \"status::review\"\n      merge: \"status::review\"\ntitle:\n  typeRegistry: \"registries/fields.json#titleTypes\"\n  typeLabelCompatibility:\n    feat: \"^type::feature$\"\n    fix: \"^type::bug$\"\n    docs: \"^type::doc$\"\n    test: \"^type::test$\"\n    refactor: \"^type::refactor$\"\n    perf: \"^type::performance$\"\n    build: \"^type::build$\"\n    ci: \"^type::ci$\"\n    chore: \"^type::chore$\"\nreview:\n  draftMinimumReviewers: 0\n  readyMinimumReviewers: 1\n  highRiskMinimumReviewers: 2\n";
export const historicalManifest = "{\"bundleId\":\"harness-mr-default\",\"files\":[{\"path\":\"layout.md\",\"sha256\":\"1c505761b5cd3114be41782c3309b292eb064681117d19c3f22b7ebde6cff114\",\"size\":1442},{\"path\":\"policy.yml\",\"sha256\":\"6c0733cd44e6e1f527a5aff104d36ec1117dc9a11cbc5f4c4d1ac99068072ac3\",\"size\":883},{\"path\":\"profiles/code.yml\",\"sha256\":\"0f85cba27f0a6bc184ee579ea947cd2ea0e5b111a74bc89d201895f2e3d0e9bd\",\"size\":589},{\"path\":\"profiles/docs.yml\",\"sha256\":\"26d35425715f23c85d639b34e3a557cf47d4087e0b0b6721ac356f9cebd2851a\",\"size\":349},{\"path\":\"profiles/general.yml\",\"sha256\":\"ca175a19e51005ea668064fa6bd76cfae2f8a2c858c2788c7ac64e2d839f0bfe\",\"size\":722},{\"path\":\"profiles/ops.yml\",\"sha256\":\"65664f7591fe96f08793dcdb29b113d38e07e7e81c0dec46c09b8f2d20ae05bd\",\"size\":501},{\"path\":\"registries/checkboxes.json\",\"sha256\":\"02efb3c1175c6cf25b9155d12974ddc1b44ffa423af43324103daeaa84004212\",\"size\":13632},{\"path\":\"registries/fields.json\",\"sha256\":\"a51216080d30a15d50e768ecf4fb022b61cee5a96daf3419c2d94575a9b42ba4\",\"size\":1504},{\"path\":\"schema.json\",\"sha256\":\"b1b8fd17c81119946abae5c4c30ed7b6b64fca9b72a8bbc939628294ba300e0e\",\"size\":8628}],\"inputSchema\":1,\"manifestVersion\":1,\"policySchema\":1,\"version\":\"1.0.0\"}\n";

// Loads frozen historical metadata and policy through the real hash-verifying
// loader. This is a byte fixture, not an authenticated historical-loader seam.
export async function loadHistoricalTemplateBundle(): Promise<LoadedTemplateBundle> {
  const path = await mkdtemp(resolve(await realpath(tmpdir()), "historical-template-"));
  try {
    await cp(resolve(import.meta.dirname, "../../template-bundle"), path, { recursive: true });
    await writeFile(resolve(path, "policy.yml"), historicalPolicy);
    await writeFile(resolve(path, "bundle-manifest.json"), historicalManifest);
    return await loadTemplateBundle(path);
  } finally {
    await rm(path, { recursive: true, force: true });
  }
}
