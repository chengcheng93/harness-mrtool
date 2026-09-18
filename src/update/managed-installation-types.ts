import type { ReleaseSetRecord } from "./cache.ts";
import type { InstalledReleaseObservation } from "./installed-release-verification.ts";
import type { ProductionReleasePreparationOptions } from "./production-release-preparation.ts";

/**
 * Reported data only. Neither this type nor an installed-byte observation grants
 * permission to mutate files, publish an active tuple, or execute business work.
 * Only the production coordinator may report these after the corresponding
 * verification/admission gates. No coordinator is implemented by this module.
 */
export type InstallationResult =
  | {
      readonly status: "installed" | "unchanged";
      readonly active: ReleaseSetRecord;
      readonly observed: InstalledReleaseObservation;
      readonly executing?: never;
      readonly persistencePending?: never;
    }
  | {
      readonly status: "persistence-pending";
      readonly executing: ReleaseSetRecord;
      readonly persistencePending: true;
      readonly active?: never;
      readonly observed?: never;
    };

export interface ProductionInstallationOptions extends ProductionReleasePreparationOptions {
  readonly stateDirectory: string;
  readonly installationDirectory: string;
}

export interface ProductionInstallationService {
  apply(force: boolean): Promise<InstallationResult>;
  rollback(): Promise<InstallationResult>;
  /** Resolves only after stable coherence; unresolved pending/repair must reject. */
  recover(): Promise<void>;
}
