import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import { parseCliInvocation } from "../../src/cli/program.ts";
import { createSkillCommandServices, type SkillCommandService } from "../../src/cli/commands/skill.ts";
import type { SkillActivationResult, SkillInvocationPin, SkillStageResult, SkillStatus } from "../../src/skill/manager.ts";
import { runProductionMain } from "../../src/production-main.ts";

const status: SkillStatus = Object.freeze({
  loadedSkillVersion: "1.0.0",
  loadedSkillProtocol: 1,
  installedSkillVersion: "1.0.0",
  installedSkillProtocol: 1,
  stagedSkillVersion: "1.2.3",
  stagedSkillProtocol: 1,
  activationRequired: true,
  hostRefreshMayBeRequired: false,
  persistencePending: false,
});

const stage: SkillStageResult = Object.freeze({
  ...status,
  stagedPath: "C:\\fixture\\staging\\versions\\1.2.3",
});

const activation: SkillActivationResult = Object.freeze({
  ...status,
  installedSkillVersion: "1.2.3",
  stagedSkillVersion: null,
  activationRequired: false,
  hostRefreshMayBeRequired: true,
  activatedVersion: "1.2.3",
});

test("Skill command adapter stages install and never activates implicitly", async () => {
  const calls: string[] = [];
  const service: SkillCommandService = {
    install: async (path) => {
      calls.push(`install:${path}`);
      return stage;
    },
    activate: async (version, path) => {
      calls.push(`activate:${version}:${path}`);
      return activation;
    },
    status: async () => {
      calls.push("status");
      return status;
    },
  };
  const handlers = createSkillCommandServices(service);
  const invocation = parseCliInvocation(["skill", "install", "--path", "C:\\Skills", "--output", "json"]);
  const result = await handlers.skillInstall(invocation);

  assert.deepEqual(calls, ["install:C:\\Skills"]);
  assert.equal(result.output?.data && "command" in result.output.data
    ? result.output.data.command
    : undefined, "skill.install");
  assert.equal(result.output?.data && "activationRequired" in result.output.data
    ? result.output.data.activationRequired
    : undefined, true);
});

test("Skill activate requires the exact requested version and path", async () => {
  const calls: string[] = [];
  const service: SkillCommandService = {
    install: async () => stage,
    activate: async (version, path) => {
      calls.push(`${version}:${path}`);
      return activation;
    },
    status: async () => status,
  };
  const handlers = createSkillCommandServices(service);
  const invocation = parseCliInvocation([
    "skill", "activate", "--version", "1.2.3", "--path", "C:\\Skills", "--output", "json",
  ]);
  await handlers.skillActivate(invocation);
  assert.deepEqual(calls, ["1.2.3:C:\\Skills"]);
});

test("Skill status is read-only and returns no installation path or credential material", async () => {
  let calls = 0;
  const service: SkillCommandService = {
    install: async () => stage,
    activate: async () => activation,
    status: async () => {
      calls += 1;
      return status;
    },
  };
  const handlers = createSkillCommandServices(service);
  const invocation = parseCliInvocation(["skill", "status", "--output", "json"]);
  const result = await handlers.skillStatus(invocation);
  assert.equal(calls, 1);
  assert.equal(result.output?.data && "command" in result.output.data
    ? result.output.data.command
    : undefined, "skill.status");
  assert.equal(JSON.stringify(result).includes("C:\\Skills"), false);
});


test("Skill command adapter forwards the loaded Skill invocation pin", async () => {
  let received: SkillInvocationPin | undefined;
  const service: SkillCommandService = {
    install: async () => stage,
    activate: async () => activation,
    status: async (pin) => {
      received = pin;
      return status;
    },
  };
  const handlers = createSkillCommandServices(service);
  const invocation = parseCliInvocation([
    "skill", "status", "--client", "codex-skill", "--client-version", "1.2.3",
    "--skill-protocol", "1", "--output", "json",
  ]);
  await handlers.skillStatus(invocation);
  assert.deepEqual(received, { loadedSkillVersion: "1.2.3", loadedSkillProtocol: 1 });
});

test("production main uses the injected Skill service for status", async () => {
  let calls = 0;
  const service: SkillCommandService = {
    install: async () => stage,
    activate: async () => activation,
    status: async () => {
      calls += 1;
      return status;
    },
  };
  const chunks: string[] = [];
  const output = { write: (chunk: string) => { chunks.push(chunk); return true; } };
  const exitCode = await runProductionMain(
    ["skill", "status", "--output", "json"],
    {
      skillService: service,
      updatePreflight: { run: async () => undefined },
      stdout: output,
      stderr: output,
    },
  );
  assert.equal(exitCode, 0);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(chunks.join("")).data.command, "skill.status");
});

test("production main forwards the loaded Skill invocation pin to its default service", async (t) => {
  const home = await mkdtemp(resolve(await realpath(tmpdir()), "production-skill-default-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
  });

  const chunks: string[] = [];
  const output = { write: (chunk: string) => { chunks.push(chunk); return true; } };
  const exitCode = await runProductionMain(
    [
      "skill", "status", "--client", "codex-skill", "--client-version", "0.1.6",
      "--skill-protocol", "1", "--output", "json",
    ],
    {
      updateChannelDefaults: { stateDirectory: resolve(home, "state") },
      updatePreflight: { run: async () => undefined },
      stdout: output,
      stderr: output,
    },
  );
  assert.equal(exitCode, 0);
  const data = JSON.parse(chunks.join("")) as { data: { loadedSkillVersion: string | null; loadedSkillProtocol: number | null } };
  assert.equal(data.data.loadedSkillVersion, "0.1.6");
  assert.equal(data.data.loadedSkillProtocol, 1);
});
