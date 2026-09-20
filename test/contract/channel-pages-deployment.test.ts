import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

type Step = {
  name?: string; id?: string; uses?: string; run?: string; shell?: string; if?: string;
  env?: Record<string, string>; with?: Record<string, string>; "continue-on-error"?: boolean;
};
type Job = {
  needs?: string | string[]; if?: string; permissions?: Record<string, string>;
  environment?: { name: string; url: string }; steps: Step[]; "continue-on-error"?: boolean;
};
type Workflow = {
  permissions: Record<string, string>;
  concurrency?: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
};
const source = await readFile(join(import.meta.dirname, "../../.github/workflows/publish-channel.yml"), "utf8");
const workflow = parse(source) as Workflow;
function job(id: string): Job {
  const target = workflow.jobs[id];
  assert.ok(target, `required channel job: ${id}`);
  return target;
}
function step(name: string): Step {
  const target = job("publish").steps.find((item) => item.name === name);
  assert.ok(target, `required publication gate: ${name}`);
  return target;
}
function pagesUpload(): Step {
  const target = job("publish").steps.find((item) => item.uses === "actions/upload-pages-artifact@v4");
  assert.ok(target, "upload the verified channel envelope as a Pages artifact");
  return target;
}

test("Pages upload follows every signature, asset binding, draft and immutable readback gate", () => {
  const publish = job("publish");
  const upload = pagesUpload();
  assert.deepEqual(publish.needs, ["verify-cli", "verify-template", "verify-skill"]);
  assert.equal(publish.if, "${{ inputs.channel == 'stable' }}");
  for (const id of publish.needs) {
    const verifier = job(id);
    assert.equal(verifier.if, undefined);
    const commands = verifier.steps.map((item) => item.run ?? "").join("\n");
    assert.match(commands, /--json isDraft --jq \.isDraft\)" = false/u);
    assert.match(commands, /--json isImmutable --jq \.isImmutable\)" = true/u);
  }
  const gates = [
    step("Materialize the externally signed channel envelope"),
    step("Authenticate channel and bind every input asset"),
    step("Create a draft channel release after all immutable component checks"),
    step("Download the draft channel envelope"),
    step("Publish the verified channel draft"),
    step("Verify immutable channel release state"),
    upload,
  ];
  let previous = -1;
  for (const gate of gates) {
    const index = publish.steps.indexOf(gate);
    assert.ok(index > previous, `${gate.name} must follow the previous gate`);
    previous = index;
  }
  const authentication = gates[1]!.run!;
  assert.match(authentication, /node --import tsx\/esm scripts\/verify-channel-release-inputs\.mjs/u);
  for (const argument of [
    "--envelope dist/channel/stable.envelope.json", '--cli-tag "$CLI_TAG"',
    '--template-tag "$TEMPLATE_TAG"', '--skill-tag "$SKILL_TAG"',
    "--windows-archive cli-release/harness-mrtool-windows-x64.zip",
    "--darwin-archive cli-release/harness-mrtool-darwin-arm64.zip",
    "--template-archive template-release/harness-mr-templates.zip",
    "--skill-archive skill-release/harness-mr-skill.zip",
  ]) assert.ok(authentication.includes(argument), argument);
  for (const target of Object.values(workflow.jobs)) {
    assert.equal(target["continue-on-error"], undefined);
    for (const item of target.steps) {
      assert.equal(item.if, undefined, `do not skip or bypass ${item.name ?? item.uses}`);
      assert.equal(item["continue-on-error"], undefined);
      assert.doesNotMatch(item.run ?? "", /\|\|\s*true|set \+e|continue-on-error/u);
      if (item.shell === "bash") assert.match(item.run!, /^set -euo pipefail\n/u);
    }
  }
});

test("only a successful publish can deploy the same named artifact without checkout or secrets", () => {
  const deploy = job("deploy-pages");
  assert.equal(deploy.needs, "publish");
  assert.equal(deploy.if, undefined, "retain GitHub's implicit success() dependency gate");
  assert.deepEqual(deploy.environment, {
    name: "github-pages", url: "${{ steps.deployment.outputs.page_url }}",
  });
  assert.deepEqual(deploy.steps, [{
    name: "Deploy the verified stable channel to GitHub Pages",
    id: "deployment",
    uses: "actions/deploy-pages@v4",
    with: { artifact_name: "github-pages" },
  }]);
  assert.deepEqual(pagesUpload().with, {
    name: "github-pages", path: "${{ runner.temp }}/channel-pages",
  });
  const uploaders = Object.values(workflow.jobs).flatMap((target) => target.steps)
    .filter((item) => item.uses?.startsWith("actions/upload-pages-artifact@"));
  assert.equal(uploaders.length, 1, "no earlier or alternate Pages artifact producer");
  assert.doesNotMatch(JSON.stringify(deploy), /secrets\.|CHANNEL_ENVELOPE_B64|checkout|verify-channel/u);
});

test("Pages and OIDC rights are isolated from verification and signing inputs", () => {
  assert.deepEqual(workflow.permissions, { contents: "read" });
  for (const id of ["verify-cli", "verify-template", "verify-skill"]) {
    assert.equal(job(id).permissions, undefined, `${id} inherits read-only contents`);
  }
  assert.deepEqual(job("publish").permissions, { contents: "write" });
  assert.deepEqual(job("deploy-pages").permissions, { pages: "write", "id-token": "write" });
  assert.deepEqual(workflow.concurrency, { group: "stable-channel-pages", "cancel-in-progress": false });
  const secretConsumers = job("publish").steps.filter((item) => JSON.stringify(item).includes("secrets."));
  assert.deepEqual(secretConsumers.map((item) => item.name), ["Materialize the externally signed channel envelope"]);
  const afterAuthentication = job("publish").steps.slice(
    job("publish").steps.indexOf(step("Authenticate channel and bind every input asset")) + 1,
  );
  assert.doesNotMatch(JSON.stringify(afterAuthentication), /CHANNEL_ENVELOPE_B64|secrets\.|base64|sign-channel|signEnvelope/u);
});

test("immutable readback downloads only the envelope into a fresh directory and compares before upload", () => {
  const gate = step("Verify immutable channel release state").run!;
  const immutable = gate.indexOf('--json isImmutable --jq .isImmutable)" = true');
  const directory = gate.indexOf('mkdir "$RUNNER_TEMP/channel-pages"');
  const download = gate.indexOf('gh release download "stable-${GITHUB_SHA}" --dir "$RUNNER_TEMP/channel-pages" --pattern \'stable.envelope.json\'');
  const comparison = gate.indexOf('cmp --silent dist/channel/stable.envelope.json "$RUNNER_TEMP/channel-pages/stable.envelope.json"');
  assert.ok(immutable >= 0 && directory > immutable && download > directory && comparison > download,
    "immutable state must succeed before readback; compare the published bytes with the authenticated input");
  assert.doesNotMatch(gate, /--clobber|mkdir -p|\b(?:cp|mv|tee|cat|echo|base64|node)\b|[>|]/u);
  assert.equal(job("publish").steps.at(-1), pagesUpload(), "nothing rewrites or replaces the verified artifact");
  const result = spawnSync("bash", ["-n"], { input: gate, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr);
});

for (const scenario of ["exact", "changed", "missing", "download-failed", "draft", "mutable", "metadata-failed", "preexisting"] as const) {
  test(`immutable Pages gate fails closed for ${scenario} readback`, async (t) => {
    const upload = pagesUpload();
    const directory = await mkdtemp(join(tmpdir(), "channel-pages-contract-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const bin = join(directory, "bin");
    const runnerTemp = join(directory, "runner-temp");
    await mkdir(bin);
    await mkdir(runnerTemp);
    await mkdir(join(directory, "dist/channel"), { recursive: true });
    // Deliberately non-canonical signed bytes: no parsing, reserialization or resigning is allowed.
    const envelope = '{ "payload" : "signed-payload", "signatures" : [{ "signature": "unchanged" }] }\n';
    const input = join(directory, "dist/channel/stable.envelope.json");
    await writeFile(input, envelope);
    if (scenario === "preexisting") {
      await mkdir(join(runnerTemp, "channel-pages"));
      await writeFile(join(runnerTemp, "channel-pages/unrelated-secret.txt"), "not public");
    }
    // Stub only the network boundary. Execute the workflow's real shell, mkdir and cmp locally.
    await writeFile(join(bin, "gh"), `#!/bin/bash
set -euo pipefail
[[ "$1" == release && "$3" == "stable-$GITHUB_SHA" ]]
if [[ "$2" == view ]]; then
  [[ "$SCENARIO" != metadata-failed ]] || exit 42
  case "$*" in
    *"--jq .isDraft") [[ "$SCENARIO" == draft ]] && printf true || printf false ;;
    *"--jq .isImmutable") [[ "$SCENARIO" == mutable ]] && printf false || printf true ;;
    *) printf '{}\\n' ;;
  esac
elif [[ "$2" == download ]]; then
  printf 'download\\n' >> "$RUNNER_TEMP/download-attempted"
  [[ "$4" == --dir && "$5" == "$RUNNER_TEMP/channel-pages" && "$6" == --pattern && "$7" == stable.envelope.json && "$#" == 7 ]]
  [[ "$SCENARIO" != download-failed ]] || exit 43
  [[ "$SCENARIO" != missing ]] || exit 0
  if [[ "$SCENARIO" == changed ]]; then
    printf 'different signed bytes\\n' > "$5/stable.envelope.json"
  else
    cp dist/channel/stable.envelope.json "$5/stable.envelope.json"
  fi
else
  exit 44
fi
`, { mode: 0o755 });
    const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c",
      step("Verify immutable channel release state").run! + '\nprintf "upload-allowed\\n" > "$RUNNER_TEMP/upload-allowed"\n',
    ], {
      cwd: directory, encoding: "utf8", timeout: 10_000,
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: runnerTemp, GITHUB_SHA: "fixture-sha", SCENARIO: scenario },
    });
    assert.equal(result.error, undefined);
    const files = await readdir(runnerTemp);
    assert.equal(result.stdout.includes("signed-payload"), false, "never print envelope contents");
    assert.equal(result.stderr.includes("signed-payload"), false, "never print envelope contents");
    assert.equal(await readFile(input, "utf8"), envelope, "never overwrite the authenticated envelope");
    if (scenario === "exact") {
      assert.equal(result.status, 0, result.stderr);
      assert.ok(files.includes("upload-allowed"));
      const uploadDirectory = upload.with!.path!.replace("${{ runner.temp }}", runnerTemp);
      assert.deepEqual(await readdir(uploadDirectory), ["stable.envelope.json"]);
      assert.equal(await readFile(join(uploadDirectory, "stable.envelope.json"), "utf8"), envelope);
    } else {
      assert.notEqual(result.status, 0, "reject failed checks before the upload boundary");
      assert.equal(files.includes("upload-allowed"), false);
    }
    if (["draft", "mutable", "metadata-failed", "preexisting"].includes(scenario)) {
      assert.equal(files.includes("download-attempted"), false, "do not download before all metadata and isolation gates pass");
    }
  });
}
