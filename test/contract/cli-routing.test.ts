import assert from "node:assert/strict";
import test from "node:test";

import { isToolError } from "../../src/contracts/errors.ts";
import { parseCliInvocation } from "../../src/cli/program.ts";

function inputError(arguments_: readonly string[]): void {
  assert.throws(
    () => parseCliInvocation(arguments_),
    (error: unknown) => isToolError(error, "INPUT_ERROR"),
  );
}

test("parses every V1 command into one closed invocation contract", () => {
  const cases: readonly [readonly string[], string][] = [
    [["doctor"], "doctor"],
    [["context", "--mr", "12", "--migrate-template"], "context"],
    [["create", "--profile", "code+docs"], "create"],
    [["update", "12", "--force-replace-description"], "update"],
    [["verify", "12", "--level", "merge"], "verify"],
    [["preview", "--input", "request.yaml"], "preview"],
    [["schema", "show", "--from-mr", "12"], "schema.show"],
    [["profiles", "list"], "profiles.list"],
    [["profiles", "detect"], "profiles.detect"],
    [["labels", "list"], "labels.list"],
    [["template", "show"], "template.show"],
    [["template", "refresh"], "template.refresh"],
    [["template", "export", "--profile", "docs", "--destination", "Docs.md"], "template.export"],
    [["self-update", "check"], "self-update.check"],
    [["self-update", "status"], "self-update.status"],
    [["self-update", "apply"], "self-update.apply"],
    [["self-update", "rollback", "--version", "1.2.3"], "self-update.rollback"],
    [["skill", "install", "--path", "C:\\Skills"], "skill.install"],
    [["skill", "activate", "--version", "1.2.3", "--path", "C:\\Skills"], "skill.activate"],
    [["skill", "status"], "skill.status"],
    [["version"], "version"],
  ];

  for (const [arguments_, expected] of cases) {
    assert.equal(parseCliInvocation(arguments_).command.kind, expected, arguments_.join(" "));
  }
});

test("returns typed command-specific values and common options", () => {
  const invocation = parseCliInvocation([
    "update", "123",
    "--input", "-",
    "--input-format", "json",
    "--non-interactive",
    "--output", "json",
    "--client", "script",
    "--client-version", "2.1.0",
    "--migrate-template",
    "--confirm-migration", `${"a".repeat(64)}:${"b".repeat(64)}`,
    "--force-replace-description",
  ]);

  assert.deepEqual(invocation.command, {
    kind: "update",
    iid: 123,
    migrateTemplate: true,
    confirmation: `${"a".repeat(64)}:${"b".repeat(64)}`,
    forceReplaceDescription: true,
  });
  assert.equal(invocation.options.input, "-");
  assert.equal(invocation.options.output, "json");
  assert.equal(invocation.options.nonInteractive, true);
  assert.equal(invocation.options.client, "script");
});

test("keeps machine output separate from template export destination", () => {
  const invocation = parseCliInvocation([
    "template", "export",
    "--profile", "general",
    "--destination", "Default.md",
    "--output", "json",
  ]);
  assert.deepEqual(invocation.command, {
    kind: "template.export",
    profile: "general",
    destination: "Default.md",
  });
  assert.equal(invocation.options.output, "json");
  inputError(["template", "export", "--output", "Default.md"]);
});

test("rejects malformed routes, IIDs, levels, migration hashes, and inapplicable flags", () => {
  for (const arguments_ of [
    [],
    ["unknown"],
    ["create", "12"],
    ["context", "--mr", "0"],
    ["update", "01"],
    ["verify", "12"],
    ["verify", "12", "--level", "write"],
    ["schema", "detect"],
    ["profiles"],
    ["template", "export", "--profile", "code+docs", "--destination", "x.md"],
    ["template", "export", "--profile", "code", "--destination", "x.md", "--destination", "y.md"],
    ["update", "12", "--confirm-migration", `${"a".repeat(64)}:${"b".repeat(64)}`],
    ["update", "12", "--migrate-template", "--confirm-migration", "yes"],
    ["skill", "activate", "--version", "v1.2.3", "--path", "C:\\Skills"],
    ["skill", "activate", "--version", "1.2.3"],
    ["version", "--input", "request.json"],
    ["doctor", "--push"],
  ]) {
    inputError(arguments_);
  }
});

test("does not reflect rejected command-line values", () => {
  const bearer = `hmrc1_${"A".repeat(43)}`;
  assert.throws(() => parseCliInvocation(["verify", bearer, "--level", "ready"]), (error: unknown) => {
    assert.equal(isToolError(error, "INPUT_ERROR"), true);
    assert.equal(JSON.stringify(error).includes(bearer), false);
    assert.equal(error instanceof Error && error.message.includes(bearer), false);
    return true;
  });
});
