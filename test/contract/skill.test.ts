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

test("Skill instructions begin with context and delegate rendering/labels to the CLI", () => {
  const instructions = renderSkillInstructions({ skillVersion: "1.1.0", skillProtocol: 1 });
  const contextIndex = instructions.indexOf("harness-mrtool context");
  assert.notEqual(contextIndex, -1);
  assert.ok(contextIndex < instructions.indexOf("harness-mrtool preview"));
  assert.ok(instructions.includes("harness-mrtool create"));
  assert.ok(instructions.includes("harness-mrtool update"));
  assert.ok(!instructions.includes("status::"));
  assert.ok(!instructions.includes("type::"));
  assert.ok(!instructions.includes("## 1. Changes"));
});

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
