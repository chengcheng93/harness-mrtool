import { ToolError } from "../../contracts/errors.ts";
import type { RepositorySnapshot } from "../../git/repository.ts";
import type { ExecutePushOptions, PlanPushOptions, SourceBranchPushPlan, executeSourceBranchPush } from "../../git/push-plan.ts";
import type { CliInvocation } from "../program.ts";
import type { TrustedBundleSelection } from "./local.ts";
import type { ProductionCommandServices } from "./production.ts";

export interface ManualRepositoryRuntime {
  readonly discover: (input: {
    readonly cwd: string;
    readonly targetBranch: string;
  }) => Promise<RepositorySnapshot>;
  readonly mergeBase: (repository: RepositorySnapshot) => Promise<string>;
  readonly planPush: (
    repository: RepositorySnapshot,
    options: PlanPushOptions,
  ) => Promise<SourceBranchPushPlan>;
  readonly executePush: (
    repository: RepositorySnapshot,
    plan: SourceBranchPushPlan,
    options: ExecutePushOptions,
  ) => Promise<Awaited<ReturnType<typeof executeSourceBranchPush>>>;
}

export interface ManualCommandDependencies {
  readonly cliVersion: string;
  readonly cwd: string;
  readonly currentBundle: TrustedBundleSelection;
  readonly requestSource: {
    readonly read: (invocation: CliInvocation) => Promise<unknown>;
  };
  readonly repository?: ManualRepositoryRuntime;
}

export function createManualCommandServices(
  _dependencies: ManualCommandDependencies,
): Pick<ProductionCommandServices, "manual"> {
  return {
    manual: async () => {
      throw new ToolError("INPUT_ERROR", "Manual MR creation cannot enforce Issue-first submission", {
        field: "manual",
        expected: "API create that creates an Issue and linked MR",
        actual: "manual creation handoff is disabled",
        safeNextStep: "Use API create with omitted workItem or relation:new; it creates the Issue before the MR.",
      });
    },
  };
}
