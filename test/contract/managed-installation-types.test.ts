import assert from "node:assert/strict";
import test from "node:test";

import type { ReleaseSetRecord } from "../../src/update/cache.ts";
import type { InstalledReleaseObservation } from "../../src/update/installed-release-verification.ts";
import type {
  InstallationResult,
  ProductionInstallationOptions,
  ProductionInstallationService,
} from "../../src/update/managed-installation-types.ts";

// Compile-time contract checks. These never manufacture installation evidence.
function resultContract(result: InstallationResult): void {
  if (result.status === "persistence-pending") {
    const executing: ReleaseSetRecord = result.executing;
    const pending: true = result.persistencePending;
    // @ts-expect-error Pending persistence has no installed observation.
    const observation: InstalledReleaseObservation = result.observed;
    // @ts-expect-error Pending persistence has no committed active tuple.
    const active: ReleaseSetRecord = result.active;
    void [executing, pending, observation, active];
  } else {
    const active: ReleaseSetRecord = result.active;
    const observation: InstalledReleaseObservation = result.observed;
    // @ts-expect-error Installed truth cannot also claim pending persistence.
    const pending: true = result.persistencePending;
    void [active, observation, pending];
  }
  // @ts-expect-error Result discriminants are readonly.
  result.status = "installed";
}

function serviceContract(service: ProductionInstallationService, options: ProductionInstallationOptions): void {
  const apply: (force: boolean) => Promise<InstallationResult> = service.apply;
  const rollback: () => Promise<InstallationResult> = service.rollback;
  const recover: () => Promise<void> = service.recover;
  const state: string = options.stateDirectory;
  const installation: string = options.installationDirectory;
  // @ts-expect-error Both roots are required; they are not inferred from journal data.
  const missingRoots: ProductionInstallationOptions = {};
  void [apply, rollback, recover, state, installation, missingRoots];
}

function rejectMixedStatus(record: ReleaseSetRecord, observed: InstalledReleaseObservation): void {
  const extraObservation = { status: "persistence-pending" as const, executing: record, persistencePending: true as const, observed };
  // @ts-expect-error Reject mixed truth even when passed through a variable.
  const pending: InstallationResult = extraObservation;
  const extraPending = { status: "installed" as const, active: record, observed, persistencePending: true as const };
  // @ts-expect-error Installed and pending are disjoint.
  const installed: InstallationResult = extraPending;
  void [pending, installed];
}

void [resultContract, serviceContract, rejectMixedStatus];

test("managed installation contracts expose data types, not runtime installation authority", async () => {
  const contracts = await import("../../src/update/managed-installation-types.ts");
  assert.deepEqual(Object.keys(contracts), []);
});
