import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";




import { isToolError } from "../../src/contracts/errors.ts";
import {
  createDefaultUpdaterCommandServices,
  createProductionCommandHandlers,
} from "../../src/cli/commands/production.ts";
import { executeCliJson } from "../../src/cli/execute.ts";
import { UpdateCache, type ReleaseSetSnapshot } from "../../src/update/cache.ts";
import { parseCliInvocation, type CliCommand } from "../../src/cli/program.ts";




// The production default intentionally performs a real Windows ACL check.
// This contract fixture uses an injected platform adapter so the test remains
// deterministic when the full suite runs concurrently with other PowerShell
// ACL probes.
const allowTestAcl = { verify: async (_path: string): Promise<void> => undefined };

async function removeFixtureDirectory(directory: string): Promise<void> {
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) continue;
    await chmod(current, 0o700).catch(() => undefined);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        pending.push(resolve(current, entry.name));
      }
    }
  }
  await rm(directory, { recursive: true, force: true });
}





const ROUTES: readonly (readonly string[])[] = [
  ["doctor"], ["context"], ["create"], ["update"], ["verify", "1", "--level", "structure"],
  ["preview"], ["manual"], ["profiles.detect"], ["labels.list"], ["template.refresh"],
  ["self-update.check"], ["self-update.status"], ["self-update.apply"], ["self-update.rollback", "--version", "1.2.3"],
  ["skill.install", "--path", "skill"], ["skill.activate", "--version", "1.2.3", "--path", "skill"], ["skill.status"],
];




function routeToArgs(route: readonly string[]): readonly string[] {
  const [head, ...tail] = route;
  if (head === "profiles.detect" || head === "labels.list" || head === "template.refresh" ||
      head === "self-update.check" || head === "self-update.status" || head === "self-update.apply" ||
      head === "self-update.rollback" || head === "skill.install" || head === "skill.activate" || head === "skill.status") {
    const [group, sub] = head.split(".");
    return [group!, sub!, ...tail];
  }
  return [head!, ...tail];
}




test("production handler factory registers every non-local V1 route", () => {
  const handlers = createProductionCommandHandlers({ cliVersion: "1.0.0" });
  for (const route of ROUTES) {
    const invocation = parseCliInvocation([...routeToArgs(route), "--output", "json"]);
    const handler = handlers[invocation.command.kind as CliCommand["kind"]];
    assert.equal(typeof handler, "function", `missing handler for ${invocation.command.kind}`);
  }
});

test("SSH auth mode rejects API-only production commands before invoking handlers", async () => {
  let called = false;
  const handlers = createProductionCommandHandlers({
    cliVersion: "0.1.4-test",
    context: async () => { called = true; return {}; },
  });
  const chunks: string[] = [];
  const result = await executeCliJson(
    ["context", "--auth", "ssh", "--output", "json"],
    {
      cliVersion: "0.1.4-test",
      handlers,
      stdout: { write(chunk, callback) { chunks.push(chunk); callback(); return true; } },
    },
  );
  assert.equal(result.exitCode, 3);
  assert.equal(called, false);
  const output = JSON.parse(chunks[0]!) as Record<string, unknown>;
  assert.equal(output.ok, false);
  assert.equal(output.code, "AUTH_ERROR");
});




test("missing production runtime dependencies are classified and do not claim success", async () => {
  const handlers = createProductionCommandHandlers({ cliVersion: "1.0.0" });
  const invocation = parseCliInvocation(["create", "--output", "json"]);
  const handler = handlers.create;
  assert.ok(handler);
  await assert.rejects(
    async () => handler(invocation as never),
    (error: unknown) => isToolError(error) && error.code !== "INTERNAL_ERROR",
  );
});




test("self-update status reads the real cache and reports an empty bootstrap safely", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-cli-status-"));
  t.after(async () => removeFixtureDirectory(directory));
  const handlers = createProductionCommandHandlers({
    cliVersion: "1.0.0",
    ...createDefaultUpdaterCommandServices({ stateDirectory: directory, windowsAclVerifier: allowTestAcl }),
  });
  const invocation = parseCliInvocation(["self-update", "status", "--output", "json"]);
  const handler = handlers[invocation.command.kind];
  assert.ok(handler);
  const execution = await handler(invocation as never);
  assert.equal(execution.context?.update?.usingLastKnownGood, false);
  assert.equal(execution.context?.update?.checked, true);
  assert.equal(execution.output?.data?.state, "empty");
});




test("self-update status requires a verifier for existing cache and reads verified LKG when injected", async (t) => {
  const directory = await mkdtemp(resolve(tmpdir(), "harness-mrtool-cli-status-verified-"));
  t.after(async () => removeFixtureDirectory(directory));
  const bytes = (value: string) => new TextEncoder().encode(value);
  const digest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
  const cliBytes = bytes("verified cli\n");
  const templateBytes = bytes("verified template\n");
  const receiptBytes = bytes("verified receipt\n");
  const snapshot: ReleaseSetSnapshot = {
    record: {
      cacheVersion: 1,
      recordType: "active-release-set",
      releaseSetId: "stable-verified",
      cliVersion: "1.0.0",
      cliSha256: digest(cliBytes),
      templateVersion: "1.0.0",
      templateSha256: digest(templateBytes),
      manifestVersion: 1,
      inputSchema: 1,
      policySchema: 1,
      manifestSequence: 1,
      transactionId: "tx-verified",
      receiptSha256: digest(receiptBytes),
    },
    cliBytes,
    templateBytes,
    receiptBytes,
  };
  const verifier = { verify: async (_value: ReleaseSetSnapshot): Promise<void> => undefined };
  await new UpdateCache({ stateDirectory: directory, verifySnapshot: verifier, windowsAclVerifier: allowTestAcl }).storeVerifiedReleaseSet(snapshot);




  const unverifiedHandlers = createProductionCommandHandlers({
    cliVersion: "1.0.0",
    ...createDefaultUpdaterCommandServices({ stateDirectory: directory, windowsAclVerifier: allowTestAcl }),
  });
  const invocation = parseCliInvocation(["self-update", "status", "--output", "json"]);
  await assert.rejects(
    () => Promise.resolve(unverifiedHandlers[invocation.command.kind]!(invocation as never)),
    (error: unknown) => isToolError(error, "UPDATE_SECURITY_ERROR"),
  );




  const verifiedHandlers = createProductionCommandHandlers({
    cliVersion: "1.0.0",
    ...createDefaultUpdaterCommandServices({ stateDirectory: directory, windowsAclVerifier: allowTestAcl, verifySnapshot: verifier }),
  });
  const execution = await verifiedHandlers[invocation.command.kind]!(invocation as never);
  assert.equal(execution.context?.update?.usingLastKnownGood, true);
  assert.equal(execution.output?.data?.state, "ready");
});
