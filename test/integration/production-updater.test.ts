import assert from "node:assert/strict";
import test from "node:test";

import type { CliCommand } from "../../src/cli/program.ts";
import { ToolError } from "../../src/contracts/errors.ts";
import { runProductionMain } from "../../src/production-main.ts";
import type {
  PublicInvocationPreflight,
  PublicInvocationPreflightInput,
} from "../../src/update/preflight.ts";
import { createProductionUpdatePreflight } from "../../src/update/preflight.ts";

interface PublicCommandCase {
  readonly arguments: readonly string[];
  readonly kind: CliCommand["kind"];
}

const PUBLIC_COMMANDS: readonly PublicCommandCase[] = Object.freeze([
  { arguments: ["doctor"], kind: "doctor" },
  { arguments: ["context", "--mr", "12"], kind: "context" },
  { arguments: ["create", "--offline"], kind: "create" },
  { arguments: ["update", "12", "--force-replace-description"], kind: "update" },
  { arguments: ["verify", "12", "--level", "merge"], kind: "verify" },
  { arguments: ["preview", "--input", "request.yaml", "--no-update"], kind: "preview" },
  { arguments: ["schema", "show", "--from-mr", "12"], kind: "schema.show" },
  { arguments: ["profiles", "list"], kind: "profiles.list" },
  { arguments: ["profiles", "detect"], kind: "profiles.detect" },
  { arguments: ["labels", "list"], kind: "labels.list" },
  { arguments: ["template", "show"], kind: "template.show" },
  { arguments: ["template", "refresh"], kind: "template.refresh" },
  {
    arguments: ["template", "export", "--profile", "docs", "--destination", "Docs.md"],
    kind: "template.export",
  },
  { arguments: ["self-update", "check"], kind: "self-update.check" },
  { arguments: ["self-update", "status"], kind: "self-update.status" },
  { arguments: ["self-update", "apply"], kind: "self-update.apply" },
  { arguments: ["self-update", "rollback", "--version", "1.2.3"], kind: "self-update.rollback" },
  { arguments: ["skill", "install", "--path", "C:\\Skills"], kind: "skill.install" },
  {
    arguments: ["skill", "activate", "--version", "1.2.3", "--path", "C:\\Skills"],
    kind: "skill.activate",
  },
  { arguments: ["skill", "status"], kind: "skill.status" },
  { arguments: ["version"], kind: "version" },
]);

function rejectedPreflight(
  expected: PublicCommandCase,
  calls: PublicInvocationPreflightInput[],
): PublicInvocationPreflight {
  return Object.freeze({
    run: async (input: PublicInvocationPreflightInput) => {
      calls.push(input);
      assert.deepEqual(Object.keys(input).sort(), ["commandKind", "noUpdate", "offline"]);
      assert.equal(input.commandKind, expected.kind);
      assert.equal(input.offline, expected.arguments.includes("--offline"));
      assert.equal(input.noUpdate, expected.arguments.includes("--no-update"));
      assert.equal(Object.isFrozen(input), true);
      throw new ToolError("UPDATE_SECURITY_ERROR", "Signed update preflight rejected invocation", {
        field: "update",
        expected: "a trusted active release set",
        actual: "trusted update state unavailable",
        safeNextStep: "Repair or reinstall a verified release before retrying.",
      });
    },
  });
}

for (const commandCase of PUBLIC_COMMANDS) {
  test(`${commandCase.kind} runs exactly one preflight before production bootstrap`, async () => {
    const preflightCalls: PublicInvocationPreflightInput[] = [];
    const stdout: string[] = [];
    const stderr: string[] = [];
    let bundleLoads = 0;

    const exitCode = await runProductionMain(
      [...commandCase.arguments, "--output", "json"],
      {
        loadCurrentBundle: async () => {
          bundleLoads += 1;
          throw new Error("Bundle loading must not start before update preflight succeeds");
        },
        updatePreflight: rejectedPreflight(commandCase, preflightCalls),
        stdout: { write: (chunk) => { stdout.push(chunk); return true; } },
        stderr: { write: (chunk) => { stderr.push(chunk); return true; } },
      },
    );

    assert.equal(exitCode, 5);
    assert.equal(bundleLoads, 0);
    assert.equal(preflightCalls.length, 1);
    assert.equal(stderr.join(""), "");
    const output = JSON.parse(stdout.join("")) as {
      readonly code: string;
      readonly ok: boolean;
      readonly remoteWrite: { readonly state: string };
    };
    assert.equal(output.ok, false);
    assert.equal(output.code, "UPDATE_SECURITY_ERROR");
    assert.equal(output.remoteWrite.state, "not-attempted");
  });
}

test("the default production preflight fails closed without shipped trust roots", async () => {
  await assert.rejects(
    () => createProductionUpdatePreflight().run({
      commandKind: "version",
      noUpdate: false,
      offline: false,
    }),
    (error: unknown) => error instanceof ToolError && error.code === "UPDATE_SECURITY_ERROR",
  );
});
