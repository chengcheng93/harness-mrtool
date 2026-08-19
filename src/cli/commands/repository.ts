import { detectProfiles, type ProfileDetectionResult } from "../../bundle/detect-profile.ts";
import type { CanonicalChangeSet } from "../../git/change-set.ts";
import type {
  GitLabProjectIdentity,
  RepositorySnapshot,
} from "../../git/repository.ts";
import type { TrustedBundleSelection } from "./local.ts";
import type { CliCommandExecution } from "../execute.ts";
import type { TargetProjectResolver } from "../target-project.ts";
import type { ProductionCommandServices } from "./production.ts";

/** Read-only repository port owned exclusively by profiles.detect. */
export interface ProfileDetectionRepositoryRuntime {
  readonly discover: (
    options: {
      readonly cwd: string;
      readonly expectedTargetProject: GitLabProjectIdentity;
      readonly targetBranch: string;
      readonly targetRemote: string;
    },
  ) => Promise<RepositorySnapshot>;
  readonly readChangeSet: (
    repository: RepositorySnapshot,
  ) => Promise<CanonicalChangeSet>;
}

export interface ProfileDetectionCommandDependencies {
  readonly cwd: string;
  readonly currentBundle: TrustedBundleSelection;
  readonly profileRepository: ProfileDetectionRepositoryRuntime;
  readonly targetProjectResolver: TargetProjectResolver;
}

function detectionData(
  result: ProfileDetectionResult,
  changeSet: CanonicalChangeSet,
): NonNullable<
  NonNullable<CliCommandExecution["output"]>["data"]
> {
  return result.kind === "detected"
    ? {
        command: "profiles.detect",
        kind: result.kind,
        mergeBaseSha: changeSet.mergeBaseSha,
        profileIds: [...result.profileIds],
        profileSelectionReasons: result.profileIds.map((profileId) => ({
          code: "matched-versioned-profile-rules",
          profileId,
        })),
        sourceHeadSha: changeSet.sourceHeadSha,
        targetRefSha: changeSet.targetRefSha,
      }
    : {
        command: "profiles.detect",
        itemIndex: result.itemIndex,
        kind: result.kind,
        mergeBaseSha: changeSet.mergeBaseSha,
        profileSelectionReasons: [{ code: result.reason, itemIndex: result.itemIndex }],
        reason: result.reason,
        sourceHeadSha: changeSet.sourceHeadSha,
        targetRefSha: changeSet.targetRefSha,
      };
}

export function createProfileDetectionCommandServices(
  dependencies: ProfileDetectionCommandDependencies,
): Pick<ProductionCommandServices, "profilesDetect"> {
  return {
    profilesDetect: async () => {
      const target = await dependencies.targetProjectResolver.resolve({ cwd: dependencies.cwd });
      const repository = await dependencies.profileRepository.discover({
        cwd: dependencies.cwd,
        expectedTargetProject: target.identity,
        targetBranch: target.project.defaultBranch,
        targetRemote: target.targetRemote,
      });
      const changeSet = await dependencies.profileRepository.readChangeSet(repository);
      const detection = detectProfiles(dependencies.currentBundle.bundle, changeSet.items);
      return {
        context: {
          versions: {
            templateVersion: dependencies.currentBundle.bundle.manifest.version,
            bundleHash: dependencies.currentBundle.bundleManifestHash,
            releaseSetId: dependencies.currentBundle.releaseSetId,
            inputSchema: dependencies.currentBundle.bundle.manifest.inputSchema,
            policySchema: dependencies.currentBundle.bundle.manifest.policySchema,
          },
        },
        output: { data: detectionData(detection, changeSet) },
      };
    },
  };
}
