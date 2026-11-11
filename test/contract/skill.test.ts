import packageMetadata from "../../package.json" with { type: "json" };
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  SkillManager,
  type SkillRelease,
  type SkillReleaseComponent,
  type SkillStagedRelease,
  type SkillReleaseVerifier,
} from "../../src/skill/manager.ts";
import { canonicalizeJson } from "../../src/contracts/jcs.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";
import { renderSkillInstructions } from "../../src/skill/projection.ts";

const CLI_VERSION = "1.2.0";

function release(
  version = "1.1.0",
  protocol = 1,
  contents = "# Harness MR\n",
): SkillRelease {
  return {
    version,
    tag: `skill-v${version}`,
    skillProtocol: protocol,
    cliVersionRange: ">=1.0.0 <2.0.0",
    activation: "explicit-host-refresh",
    verified: true,
    files: [{ path: "SKILL.md", contents }],
    assetSha256: "a".repeat(64),
    assetSize: 32,
  };
}

function component(
  version = "1.1.0",
  protocol = 1,
): SkillReleaseComponent {
  return {
    version,
    tag: `skill-v${version}`,
    skillProtocol: protocol,
    cliVersionRange: ">=1.0.0 <2.0.0",
    asset: `harness-mr-skill-${version}.zip`,
    sha256: "a".repeat(64),
    size: 32,
    activation: "explicit-host-refresh",
  };
}

async function sandbox(): Promise<{ readonly root: string; readonly active: string; readonly staging: string }> {
  const root = await mkdtemp(join(tmpdir(), "harness-mr-skill-"));
  const active = resolve(root, "active");
  const staging = resolve(root, "staging");
  return { root, active, staging };
}

const allowTestSkillVerifier: SkillReleaseVerifier = {
  verify: async (): Promise<void> => undefined,
  verifyStaged: async (): Promise<void> => undefined,
};
const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };

async function manager(paths: { readonly active: string; readonly staging: string }, faultInjector?: { hit(point: string): void }, verifier: SkillReleaseVerifier = allowTestSkillVerifier): Promise<SkillManager> {
  return new SkillManager({
    activePath: paths.active,
    stagingPath: paths.staging,
    cliVersion: CLI_VERSION,
    supportedProtocols: [1],
    releaseVerifier: verifier,
    windowsAclVerifier: allowTestAcl,
    ...(faultInjector === undefined ? {} : { faultInjector }),
  });
}

function assertApiDefaultInstructions(ordinary: string, workflows: string): void {
  const instructions = ordinary + "\n" + workflows;
  const normalized = instructions.replace(/\s+/gu, " ");
  const steps = [
    "-Phase context",
    "Build the Request only after API context succeeds",
    "-Phase create",
  ];
  let previousIndex = -1;
  for (const step of steps) {
    const index = ordinary.indexOf(step);
    assert.ok(index > previousIndex, `${step} must follow the preceding workflow step`);
    previousIndex = index;
  }
  assert.match(ordinary, /workItem.*relation.*new/u);
  assert.match(ordinary, /Issue.*MR.*POST/u);
  assert.match(ordinary, /creation.response/iu);
  assert.doesNotMatch(ordinary, /harness-mrtool (verify|update)|--resume|--upsert/u);
  assert.match(normalized, /preview only when.*user explicitly requests/u);
  assert.match(normalized, /API credentials are missing or API requests fail, stop and explain/u);
  assert.match(normalized, /Never automatically fall back to manual/u);
  assert.match(normalized, /Every new MR requires successful Issue creation first/u);
  assert.match(normalized, /New submissions reject.*none.*closes.*related/u);
  assert.match(normalized, /Manual MR creation handoff is disabled/u);
  assert.doesNotMatch(instructions, /harness-mrtool manual --auth/u);
  assert.match(normalized, /API mode may still use ordinary Git SSH transport/u);
  assert.match(normalized, /activationRequired/u);
  assert.match(normalized, /hostRefreshMayBeRequired/u);
  assert.match(normalized, /raw JSON only when (?:the user )?explicitly request/u);
  assert.doesNotMatch(instructions, /--confirm-label-type|--label-diff-digest|--confirm-migration/u);
  assert.doesNotMatch(normalized, /After create\/update succeeds, verify/u);
  assert.ok(!instructions.includes("## 1. Changes"));
  for (const kind of ["create", "update", "preview"] as const) {
    const example = instructions.split("\n").find((line) => line.startsWith(`harness-mrtool ${kind} `));
    assert.ok(example, `Skill must provide an executable ${kind} example`);
    const invocation = parseCliInvocation(example
      .replaceAll("<iid>", "12")
      .replaceAll("<skill-semver>", "1.1.0")
      .replaceAll("<protocol>", "1")
      .split(/\s+/u).slice(1));
    assert.equal(invocation.command.kind, kind);
    assert.equal(invocation.options.authMode, "api");
    assert.equal(invocation.options.input, "-");
    assert.equal(invocation.options.output, "json");
    assert.equal(invocation.options.dryRun, false);
  }
}

test("generated Skill instructions require Issue-first API creation and reject manual creation", async () => {
  assertApiDefaultInstructions(renderSkillInstructions({ skillVersion: "1.1.0", skillProtocol: 1 }),
    await readFile(new URL("../../skill/harness-mr/references/workflows.md", import.meta.url), "utf8"));
});

for (const path of ["../../skill/harness-mr/SKILL.md", "../../plugins/harness-mrtool/skills/harness-mr/SKILL.md"]) {
  test(`${path} keeps mandatory Issue-first creation and disabled manual handoff`, async () => {
    assertApiDefaultInstructions(await readFile(new URL(path, import.meta.url), "utf8"),
      await readFile(new URL(path.replace("SKILL.md", "references/workflows.md"), import.meta.url), "utf8"));
  });
}

test("bundled and plugin Skills carry identical submission instructions", async () => {
  const [bundled, plugin] = await Promise.all([
    readFile(new URL("../../skill/harness-mr/SKILL.md", import.meta.url), "utf8"),
    readFile(new URL("../../plugins/harness-mrtool/skills/harness-mr/SKILL.md", import.meta.url), "utf8"),
  ]);
  assert.equal(plugin, bundled);
});

for (const path of ["../../skill/harness-mr/SKILL.md", "../../plugins/harness-mrtool/skills/harness-mr/SKILL.md"]) {
  test(`${path} retains executable historical resume validation and structure verification`, async () => {
    const instructions = await readFile(new URL(path.replace("SKILL.md", "references/workflows.md"), import.meta.url), "utf8");
    const resumeSection = instructions.split("### Resume a historical provisional transaction prefix")[1]!.split("## Manual creation is disabled")[0]!;
    assert.doesNotMatch(resumeSection, /preview/iu, "Historical resume uses its own dry-run, not new-submission preview");
    const commands = [...instructions.matchAll(/```text\r?\n([\s\S]*?)```/gu)]
      .map((match) => match[1]!.trim().split(/\r?\n/u))
      .find((lines) => lines.some((line) => line.includes(" --resume ")));
    assert.ok(commands, "Skill must provide an explicit resume command");
    const args = commands.map((line) => line
      .replaceAll("<iid>", "157")
      .replaceAll("<skill-semver>", "1.1.0")
      .replaceAll("<protocol>", "1")
      .replaceAll("<original-request.json>", "original-request.json")
      .replaceAll("<fresh-request.json>", "fresh-request.json")
      .split(/\s+/u).slice(1));
    const invocations = args.map((arguments_) => parseCliInvocation(arguments_));
    assert.equal(invocations.length, 2, "Resume validation must dry-run then verify without mandatory preview");
    const [resume, verify] = invocations;
    assert.deepEqual(resume!.command, { kind: "create", upsert: false,
      resumeIid: 157, resumeFrom: "original-request.json" });
    assert.equal(resume!.options.input, "fresh-request.json");
    assert.equal(resume!.options.dryRun, true);
    assert.deepEqual(verify!.command, { kind: "verify", iid: 157, level: "structure" });
    for (const invocation of invocations) {
      assert.equal(invocation.options.authMode, "api");
      assert.equal(invocation.options.output, "json");
    }
    const write = parseCliInvocation(args[0]!.filter((argument) => argument !== "--dry-run"));
    assert.deepEqual(write.command, resume!.command);
    assert.equal(write.options.input, resume!.options.input);
    assert.equal(write.options.dryRun, false);
  });
}

test("Skill manager prepares the staging root through the private-directory verifier", async () => {
  const paths = await sandbox();
  let calls = 0;
  try {
    const managerInstance = new SkillManager({
      activePath: paths.active,
      stagingPath: paths.staging,
      cliVersion: CLI_VERSION,
      supportedProtocols: [1],
      releaseVerifier: allowTestSkillVerifier,
      windowsAclVerifier: { verify: async (): Promise<void> => { calls += 1; } },
    });
    await managerInstance.status();
    if (process.platform === "win32") assert.ok(calls > 0);
    else assert.equal(calls, 0);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("activation rejects a self-consistent staging manifest without signed provenance", async () => {
  const paths = await sandbox();
  const verifier: SkillReleaseVerifier = {
    verify: async (): Promise<void> => undefined,
    verifyStaged: async (staged): Promise<void> => {
      if (staged.version !== "1.1.0") throw new Error("staged provenance mismatch");
    },
  };
  try {
    const managerInstance = await manager(paths, undefined, verifier);
    await managerInstance.stage(release("1.1.0"));
    const manifestPath = join(paths.staging, "versions", "1.1.0", ".harness-skill-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "9.9.9";
    manifest.tag = "skill-v9.9.9";
    await writeFile(manifestPath, `${canonicalizeJson(manifest as never)}\n`);
    await assert.rejects(
      managerInstance.activate("1.1.0"),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    await assert.rejects(readFile(join(paths.active, "SKILL.md")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("activation gives the verifier persisted signed asset provenance after restart", async () => {
  const paths = await sandbox();
  let staged: SkillStagedRelease | undefined;
  const verifier: SkillReleaseVerifier = {
    verify: async (): Promise<void> => undefined,
    verifyStaged: async (value): Promise<void> => {
      staged = value;
      if (value.assetSha256 !== "a".repeat(64) || value.assetSize !== 32) {
        throw new Error("missing signed asset provenance");
      }
    },
  };
  try {
    const managerInstance = await manager(paths, undefined, verifier);
    await managerInstance.stage(release());
    const restarted = await manager(paths, undefined, verifier);
    await restarted.activate("1.1.0");
    assert.equal(staged?.assetSha256, "a".repeat(64));
    assert.equal(staged?.assetSize, 32);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("staging a verified Skill leaves the active path unchanged and reports activation", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    const result = await managerInstance.stage(release());
    assert.equal(result.activationRequired, true);
    assert.equal(result.stagedSkillVersion, "1.1.0");
    await assert.rejects(readFile(join(paths.active, "SKILL.md")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("bootstrap validates signed component version and protocol before staging", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    const result = await managerInstance.bootstrap(component(), async () => release());
    assert.equal(result.activationRequired, true);
    await assert.rejects(
      managerInstance.bootstrap(component("1.2.0", 2), async () => release("1.2.0", 2)),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        (error.code === "UPDATE_REQUIRED" || error.code === "UPDATE_SECURITY_ERROR"),
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("explicit activation preserves the invocation protocol pin and exposes refresh state", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await managerInstance.stage(release());
    const pin = managerInstance.pinInvocation({ loadedSkillVersion: "1.0.0", loadedSkillProtocol: 1 });
    const result = await managerInstance.activate("1.1.0", pin);
    assert.equal(result.installedSkillVersion, "1.1.0");
    assert.equal(result.loadedSkillVersion, "1.0.0");
    assert.equal(result.loadedSkillProtocol, 1);
    assert.equal(result.hostRefreshMayBeRequired, true);
    assert.equal(result.activationRequired, false);
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "# Harness MR\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("staging and activation reject credentials without echoing the credential", async () => {
  const paths = await sandbox();
  const canary = "glpat-skill-secret-canary";
  try {
    const managerInstance = await manager(paths);
    await assert.rejects(
      managerInstance.stage(release("1.1.0", 1, `secret ${canary}\n`)),
      (error: unknown) => {
        const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
        return !text.includes(canary);
      },
    );
    await assert.rejects(readFile(join(paths.active, "SKILL.md")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("Skill file paths reject Windows device names and trailing dot or space segments", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    for (const path of ["CON", "docs/CON.txt", "NUL.md", "docs/readme.", "docs/readme "]) {
      await assert.rejects(
        managerInstance.stage({ ...release(), files: [{ path, contents: "x\n" }, { path: "SKILL.md", contents: "ok\n" }] }),
        (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
          error.code === "UPDATE_SECURITY_ERROR",
      );
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("failed activation keeps the old active Skill and repair clears the pending journal", async () => {
  const paths = await sandbox();
  let fail = true;
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const faultInjector = { hit(point: string): void {
      if (fail && point === "before-active-publish") throw new Error("injected activation failure");
    } };
    const broken = await manager(paths, faultInjector);
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "old\n");
    fail = false;
    const repaired = await broken.repair();
    assert.equal(repaired.repaired, true);
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "old\n");
    const entries = await readdir(paths.staging);
    assert.equal(entries.some((entry) => entry.includes("journal")), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("bootstrap does not accept a component whose fetched Skill version drifts", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await assert.rejects(
      managerInstance.bootstrap(component("1.1.0", 1), async () => release("1.0.9", 1)),
      /version|asset|security|invalid/iu,
    );
    await assert.rejects(readFile(join(paths.active, "SKILL.md")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("bootstrap rejects a fetched asset whose signed size or hash drifts", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await assert.rejects(
      managerInstance.bootstrap(component(), async () => ({
        ...release(),
        assetSha256: "b".repeat(64),
        assetSize: 32,
      })),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    await assert.rejects(readFile(join(paths.active, "SKILL.md")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("staging the same version rejects protocol metadata drift instead of reusing the old manifest", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = new SkillManager({
      activePath: paths.active,
      stagingPath: paths.staging,
      cliVersion: CLI_VERSION,
      supportedProtocols: [1, 2],
      releaseVerifier: allowTestSkillVerifier,
      windowsAclVerifier: allowTestAcl,
    });
    await managerInstance.stage(release("1.1.0", 1));
    await assert.rejects(
      managerInstance.stage(release("1.1.0", 2)),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("active Skill state rejects files outside the verified manifest", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await managerInstance.install(release("1.0.0", 1, "old\n"));
    await writeFile(join(paths.active, "unexpected.txt"), "manual\n");
    await assert.rejects(managerInstance.status(), /state|security|unavailable/iu);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair restores the old Skill when activation dies after moving the active directory", async () => {
  const paths = await sandbox();
  let fail = true;
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (fail && point === "after-active-old-move") throw new Error("injected post-move failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    fail = false;
    const repaired = await broken.repair();
    assert.equal(repaired.repaired, true);
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "old\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps an old-moved journal when its backup tree is tampered", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-old-move") throw new Error("injected post-move failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const backupName = (await readdir(paths.root)).find((entry) => entry.startsWith(".harness-skill-old-"));
    assert.ok(backupName);
    await writeFile(join(paths.root, backupName!, "SKILL.md"), "tampered\n");
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.ok((await readdir(paths.root)).includes(backupName!));
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps an old-moved journal and temporary tree when its backup is missing", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-old-move") throw new Error("injected post-move failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const backupName = (await readdir(paths.root)).find((entry) => entry.startsWith(".harness-skill-old-"));
    assert.ok(backupName);
    const journal = JSON.parse(await readFile(join(paths.staging, ".harness-skill-activation.json"), "utf8")) as {
      readonly temporaryPath: string;
    };
    await rm(join(paths.root, backupName!), { recursive: true, force: true });
    await mkdir(journal.temporaryPath, { recursive: true });
    await writeFile(join(journal.temporaryPath, "pending.txt"), "pending\n");
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
    assert.equal(await readFile(join(journal.temporaryPath, "pending.txt"), "utf8"), "pending\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps an old-moved journal and temporary tree when its backup is not a directory", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-old-move") throw new Error("injected post-move failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const backupName = (await readdir(paths.root)).find((entry) => entry.startsWith(".harness-skill-old-"));
    assert.ok(backupName);
    const journal = JSON.parse(await readFile(join(paths.staging, ".harness-skill-activation.json"), "utf8")) as {
      readonly temporaryPath: string;
    };
    await rm(join(paths.root, backupName!), { recursive: true, force: true });
    await writeFile(join(paths.root, backupName!), "not a Skill directory\n");
    await mkdir(journal.temporaryPath, { recursive: true });
    await writeFile(join(journal.temporaryPath, "pending.txt"), "pending\n");
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.equal(await readFile(join(paths.root, backupName!), "utf8"), "not a Skill directory\n");
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
    assert.equal(await readFile(join(journal.temporaryPath, "pending.txt"), "utf8"), "pending\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair rejects an old-moved journal that drops a required predecessor backup", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-old-move") throw new Error("injected post-move failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const journalPath = join(paths.staging, ".harness-skill-activation.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as Record<string, unknown>;
    journal.backupPath = null;
    await writeFile(journalPath, `${canonicalizeJson(journal as never)}\n`);
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps a prepared journal and temporary tree when the previous active Skill is missing", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "before-active-publish") throw new Error("injected pre-publish failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const journal = JSON.parse(await readFile(join(paths.staging, ".harness-skill-activation.json"), "utf8")) as {
      readonly temporaryPath: string;
    };
    await rm(paths.active, { recursive: true, force: true });
    await mkdir(journal.temporaryPath, { recursive: true });
    await writeFile(join(journal.temporaryPath, "pending.txt"), "pending\n");
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
    assert.equal(await readFile(join(journal.temporaryPath, "pending.txt"), "utf8"), "pending\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps a prepared journal and temporary tree when the active Skill version drifts", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "before-active-publish") throw new Error("injected pre-publish failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const activeManifestPath = join(paths.active, ".harness-skill-manifest.json");
    const manifest = JSON.parse(await readFile(activeManifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "9.9.9";
    manifest.tag = "skill-v9.9.9";
    await writeFile(activeManifestPath, `${canonicalizeJson(manifest as never)}\n`);
    const journal = JSON.parse(await readFile(join(paths.staging, ".harness-skill-activation.json"), "utf8")) as {
      readonly temporaryPath: string;
    };
    await mkdir(journal.temporaryPath, { recursive: true });
    await writeFile(join(journal.temporaryPath, "pending.txt"), "pending\n");
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.ok((await readdir(paths.staging)).includes(".harness-skill-activation.json"));
    assert.equal(await readFile(join(journal.temporaryPath, "pending.txt"), "utf8"), "pending\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair keeps the new Skill when the published journal survives cleanup", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-published") throw new Error("injected published cleanup failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "new\n");
    const restarted = await manager(paths);
    const repaired = await restarted.repair();
    assert.equal(repaired.repaired, true);
    assert.equal(await readFile(join(paths.active, "SKILL.md"), "utf8"), "new\n");
    await assert.rejects(readFile(join(paths.staging, ".harness-skill-activation.json")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair preserves the backup when a published active tree has the wrong version", async () => {
  const paths = await sandbox();
  try {
    const initial = await manager(paths);
    await initial.install(release("1.0.0", 1, "old\n"));
    const broken = await manager(paths, {
      hit(point: string): void {
        if (point === "after-active-published") throw new Error("injected published cleanup failure");
      },
    });
    await broken.stage(release("1.1.0", 1, "new\n"));
    await assert.rejects(broken.activate("1.1.0"));
    const activeManifestPath = join(paths.active, ".harness-skill-manifest.json");
    const manifest = JSON.parse(await readFile(activeManifestPath, "utf8")) as Record<string, unknown>;
    manifest.version = "1.0.0";
    manifest.tag = "skill-v1.0.0";
    await writeFile(activeManifestPath, `${canonicalizeJson(manifest as never)}\n`);
    const restarted = await manager(paths);
    await assert.rejects(
      restarted.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    const siblings = await readdir(paths.root);
    assert.ok(siblings.some((entry) => entry.startsWith(".harness-skill-old-")));
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair fails closed when the activation journal path is corrupted", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await managerInstance.status();
    await mkdir(join(paths.staging, ".harness-skill-activation.json"));
    await assert.rejects(
      managerInstance.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("repair refuses journal paths that are not manager-owned temporary siblings", async () => {
  const paths = await sandbox();
  const victim = join(paths.root, "victim");
  try {
    const managerInstance = await manager(paths);
    await managerInstance.status();
    await mkdir(victim, { recursive: true });
    await writeFile(join(victim, "keep.txt"), "do not delete\n");
    const journal = {
      journalVersion: 1,
      state: "prepared",
      temporaryPath: victim,
      backupPath: null,
      activePath: paths.active,
      previousVersion: null,
      version: "1.1.0",
    };
    await writeFile(
      join(paths.staging, ".harness-skill-activation.json"),
      `${JSON.stringify(journal)}\n`,
    );
    await assert.rejects(
      managerInstance.repair(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
    assert.equal(await readFile(join(victim, "keep.txt"), "utf8"), "do not delete\n");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("status fails closed when the Skill activation journal is non-canonical", async () => {
  const paths = await sandbox();
  try {
    const managerInstance = await manager(paths);
    await managerInstance.status();
    await writeFile(
      join(paths.staging, ".harness-skill-activation.json"),
      '{"junk":true}\n',
    );
    await assert.rejects(
      managerInstance.status(),
      (error: unknown) => typeof error === "object" && error !== null && "code" in error &&
        error.code === "UPDATE_SECURITY_ERROR",
    );
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("default Skill stays short and generated instructions exactly preserve the static contract", async () => {
  const bundled = await readFile(new URL("../../skill/harness-mr/SKILL.md", import.meta.url), "utf8");
  const body = bundled.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim();
  assert.ok(body.split(/\r?\n/u).length <= 80);
  const generated = renderSkillInstructions({ skillVersion: packageMetadata.version, skillProtocol: 1 });
  assert.equal(generated.trim(), body.replaceAll("<skill-semver>", packageMetadata.version).replaceAll("<protocol>", "1"));
});
