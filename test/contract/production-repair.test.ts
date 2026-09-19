import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseCliInvocation } from "../../src/cli/program.ts";
import { createInstallationCommandServices } from "../../src/cli/commands/updater.ts";
import type { InstallationResult, ProductionInstallationService } from "../../src/update/managed-installation-types.ts";

const impossible: InstallationResult = undefined as never;

test("self-update repair invokes the installation recovery authority", async () => {
  let recovered = 0;
  const service: ProductionInstallationService = {
    apply: async () => impossible,
    rollback: async () => impossible,
    recover: async () => { recovered += 1; },
  };
  const handlers = createInstallationCommandServices(service);
  const result = await handlers.selfUpdateRepair({
    command: parseCliInvocation(["self-update", "repair", "--output", "json"]).command,
    options: parseCliInvocation(["self-update", "repair", "--output", "json"]).options,
  });
  assert.equal(recovered, 1);
  assert.equal(result.output?.data && "command" in result.output.data ? result.output.data.command : undefined, "self-update.repair");
  assert.equal(result.output?.data && "status" in result.output.data ? result.output.data.status : undefined, "repaired");
});


test("production default composition exposes the managed repair route", async () => {
  const source = await readFile(resolve(import.meta.dirname, "../../src/production-main.ts"), "utf8");
  assert.match(source, /Pick<ProductionCommandServices, "selfUpdateRepair" \| "selfUpdateApply" \| "selfUpdateRollback">/u);
  assert.match(source, /selfUpdateRepair:\s*\(invocation\) => service\(\)\.selfUpdateRepair\(invocation\)/u);
});
