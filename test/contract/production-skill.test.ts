import assert from "node:assert/strict";
import test from "node:test";

import { parseCliInvocation } from "../../src/cli/program.ts";
import { createSkillCommandServices, type SkillCommandService } from "../../src/cli/commands/skill.ts";
import type { SkillActivationResult, SkillStageResult, SkillStatus } from "../../src/skill/manager.ts";
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
