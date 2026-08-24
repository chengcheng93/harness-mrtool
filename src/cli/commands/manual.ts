import type { LoadedTemplateBundle } from "../../bundle/load.ts";
import { validateTemplateBundle } from "../../bundle/validate.ts";
import { ToolError } from "../../contracts/errors.ts";
import {
  canonicalizeJson,
  sha256Utf8,
  type JsonObject,
} from "../../contracts/jcs.ts";
import type { Request } from "../../contracts/request.ts";
import { normalizeProductionRequest } from "../production-input.ts";
import type { CliCommandExecution } from "../execute.ts";
import type { CliInvocation } from "../program.ts";
import type { TrustedBundleSelection } from "./local.ts";
import type { ProductionCommandServices } from "./production.ts";
import {
  discoverRepository,
  readGitText,
  type RepositorySnapshot,
} from "../../git/repository.ts";
import {
  executeSourceBranchPush,
  buildSshMergeRequestPushOptions,
  isSshPushUrl,
  planSourceBranchPush,
  type ExecutePushOptions,
  type PlanPushOptions,
  type SourceBranchPushPlan,
} from "../../git/push-plan.ts";
import { GitRunner } from "../../git/runner.ts";
import { renderDescription } from "../../render/markdown.ts";
import {
  type ExternalContextSnapshot,
  type SnapshotLabel,
} from "../../render/marker.ts";
import { renderTitle } from "../../render/title.ts";

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

function manualError(
  code: "INPUT_ERROR" | "REPOSITORY_ERROR" | "RENDER_ERROR",
  message: string,
  field: string | null,
  expected: string,
  actual: string,
  safeNextStep: string,
): ToolError<typeof code> {
  return new ToolError(code, message, { field, expected, actual, safeNextStep });
}

function object(value: unknown, subject: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw manualError(
      "RENDER_ERROR",
      "Manual merge request handoff could not be rendered",
      "bundle",
      "a valid Bundle policy object",
      `${subject} is not an object`,
      "Install a complete verified release and retry.",
    );
  }
  return value as Record<string, unknown>;
}

function scalar(value: unknown, subject: string): string {
  if (typeof value !== "string" || value === "" || value !== value.trim() || /[\r\n\u0000]/u.test(value)) {
    throw manualError(
      "RENDER_ERROR",
      "Manual merge request handoff could not be rendered",
      "bundle",
      "canonical Bundle policy values",
      `${subject} is invalid`,
      "Install a complete verified release and retry.",
    );
  }
  return value;
}

function manualLabelName(categoryId: string, request: Request, expectedStatus: string): string {
  if (categoryId === "status") return expectedStatus;
  if (categoryId === "week") return "week::manual";
  if (categoryId === "priority") return "priority::manual";
  if (categoryId === "type") {
    const typeNames: Readonly<Record<string, string>> = {
      feat: "feature",
      fix: "bug",
      docs: "doc",
      test: "test",
      refactor: "refactor",
      perf: "performance",
      build: "build",
      ci: "ci",
      chore: "chore",
    };
    const name = typeNames[request.title.type];
    if (name !== undefined) return `type::${name}`;
  }
  throw manualError(
    "RENDER_ERROR",
    "Manual merge request handoff could not be rendered",
    "bundle.policy.labels.categories",
    "the current Bundle label categories to be supported by manual handoff",
    `unsupported label category ${categoryId}`,
    "Use a verified release that supports the current Bundle policy.",
  );
}

function manualLabels(
  bundle: LoadedTemplateBundle,
  request: Request,
): readonly SnapshotLabel[] {
  const labelsPolicy = object(object(bundle.policy, "policy").labels, "labels policy");
  const categories = object(labelsPolicy.categories, "label categories");
  const lifecycle = object(labelsPolicy.lifecycle, "label lifecycle");
  const expectedNames = object(lifecycle.expectedNames, "lifecycle names");
  const expectedStatus = scalar(
    request.intent === "draft" ? expectedNames.draft : expectedNames.ready,
    "expected lifecycle label",
  );
  const labels: SnapshotLabel[] = [];
  for (const [categoryId, rawCategory] of Object.entries(categories).sort(([left], [right]) => left.localeCompare(right))) {
    const category = object(rawCategory, `label category ${categoryId}`);
    if (category.required !== true && categoryId !== "type" && categoryId !== "status") continue;
    const name = manualLabelName(categoryId, request, expectedStatus);
    let matches = false;
    try {
      matches = new RegExp(scalar(category.match, `label category ${categoryId} match`), "u").test(name);
    } catch {
      matches = false;
    }
    if (!matches) {
      throw manualError(
        "RENDER_ERROR",
        "Manual merge request handoff could not be rendered",
        "bundle.policy.labels.categories",
        "synthetic manual labels matching the verified Bundle policy",
        `manual label ${name} does not match ${categoryId}`,
        "Use a verified release that supports the current Bundle policy.",
      );
    }
    labels.push(Object.freeze({ id: `manual-label:${categoryId}`, name }));
  }
  if (labels.length === 0) {
    throw manualError(
      "RENDER_ERROR",
      "Manual merge request handoff could not be rendered",
      "bundle.policy.labels",
      "at least one supported label category",
      "no label categories are available",
      "Install a complete verified release and retry.",
    );
  }
  return Object.freeze(labels);
}

function manualRequest(value: unknown): Request {
  const request = normalizeProductionRequest(value);
  // Candidate bearers are intentionally discarded before the request reaches
  // the marker or JSON output. Manual mode never resolves or prints them.
  return normalizeProductionRequest({
    ...request,
    review: {
      ...request.review,
      reviewerCandidateTokens: [],
    },
    mergeRequest: {
      ...request.mergeRequest,
      assigneeCandidateToken: null,
      labelCandidateTokens: [],
    },
  });
}

function projectPath(repository: RepositorySnapshot, target: boolean): string {
  const identity = target ? repository.targetProject : repository.sourceProject;
  return identity?.path ?? (target ? "manual/target" : "manual/source");
}

function manualSnapshot(
  repository: RepositorySnapshot,
  request: Request,
  labels: readonly SnapshotLabel[],
  mergeBaseSha: string,
): ExternalContextSnapshot {
  const issue = request.workItem.relation === "none"
    ? { kind: "none" as const }
    : { kind: "linked" as const, iid: request.workItem.iid, readStatus: "unavailable" as const };
  return Object.freeze({
    snapshotVersion: 1 as const,
    targetProject: { id: `manual-project:${projectPath(repository, true)}`, path: projectPath(repository, true) },
    sourceProject: { id: `manual-project:${projectPath(repository, false)}`, path: projectPath(repository, false) },
    targetRefSha: repository.targetRefSha,
    mergeBaseSha,
    sourceHeadSha: repository.sourceHeadSha,
    issue,
    labelCandidates: labels,
    userCandidates: Object.freeze([{
      id: "manual-author",
      username: "manual-handoff",
      displayName: "Manual handoff (author not read)",
    }]),
    mergeRequest: {
      iid: null,
      authorUserId: "manual-author",
      lifecycle: "new" as const,
      labelIds: Object.freeze([]),
      assigneeUserId: null,
      reviewerUserIds: Object.freeze([]),
    },
    localChecks: {
      commitConvention: { status: "not-run" as const, evidence: "Commit convention was not run in manual handoff mode." },
      secretScan: { status: "not-run" as const, evidence: "Secret scan was not run in manual handoff mode." },
      repositoryHygiene: {
        status: repository.worktree.clean ? "passed" as const : "failed" as const,
        evidence: repository.worktree.clean ? "Git worktree is clean." : "Git worktree has local changes.",
      },
    },
    metadataRead: { status: "unavailable" as const, evidence: "GitLab metadata was not read because no API credential was supplied." },
    ci: { status: "unavailable" as const },
    review: { approvedByUserIds: Object.freeze([]), qualifiedReviewerUserIds: null, unresolvedDiscussions: null },
  });
}

function fixedPushCommand(repository: RepositorySnapshot): string {
  return `git push --no-force ${repository.sourceRemote} ${repository.sourceHeadSha}:${repository.sourceRemoteRef}`;
}

function displayPushCommand(plan: SourceBranchPushPlan, repository: RepositorySnapshot): string {
  if (plan.command === null || plan.pushOptions === undefined || plan.pushOptions.length === 0) {
    return fixedPushCommand(repository);
  }
  return [
    "git push --no-force",
    ...plan.pushOptions.map((option) => `--push-option=${JSON.stringify(option)}`),
    repository.sourceRemote,
    `${repository.sourceHeadSha}:${repository.sourceRemoteRef}`,
  ].join(" ");
}

function pushData(
  repository: RepositorySnapshot,
  plan: SourceBranchPushPlan | null,
  error: boolean,
  result: Awaited<ReturnType<typeof executeSourceBranchPush>> | null,
): JsonObject {
  const command = plan === null ? fixedPushCommand(repository) : displayPushCommand(plan, repository);
  return {
    state: plan?.kind === "up-to-date" ? "up-to-date" : error ? "unavailable" : "ready",
    remote: repository.sourceRemote,
    ref: repository.sourceRemoteRef,
    sourceHeadSha: repository.sourceHeadSha,
    remoteSha: plan?.beforeSha ?? null,
    command: plan?.kind === "up-to-date" ? null : command,
    ...(result === null ? {} : {
      execution: {
        state: result.kind,
        beforeSha: result.beforeSha,
        afterSha: result.afterSha,
      },
    }),
  } as JsonObject;
}

const defaultManualRepository: ManualRepositoryRuntime = Object.freeze({
  async discover({ cwd, targetBranch }: { readonly cwd: string; readonly targetBranch: string }): Promise<RepositorySnapshot> {
    const probe = new GitRunner(cwd);
    const remotes = (await readGitText(probe, ["remote"], "configured remotes"))
      .split(/\r?\n/u)
      .filter((value) => value !== "");
    const remote = remotes.includes("origin") ? "origin" : remotes[0];
    if (remote === undefined) {
      throw manualError(
        "REPOSITORY_ERROR",
        "Manual merge request handoff requires a configured Git remote",
        "remote",
        "one configured Git remote",
        "no configured remotes",
        "Configure an SSH or credential-helper Git remote, then retry.",
      );
    }
    return discoverRepository({ cwd, targetBranch, sourceRemote: remote, targetRemote: remote });
  },
  async mergeBase(repository: RepositorySnapshot): Promise<string> {
    return readGitText(repository.runner, ["merge-base", repository.targetRef, "HEAD"], "merge base");
  },
  planPush: planSourceBranchPush,
  executePush: executeSourceBranchPush,
});

function executionContext(selection: TrustedBundleSelection): NonNullable<CliCommandExecution["context"]> {
  return {
    versions: {
      templateVersion: selection.bundle.manifest.version,
      bundleHash: selection.bundleManifestHash,
      releaseSetId: selection.releaseSetId,
      inputSchema: selection.bundle.manifest.inputSchema,
      policySchema: selection.bundle.manifest.policySchema,
    },
  };
}

function verifySelection(selection: TrustedBundleSelection): TrustedBundleSelection {
  validateTemplateBundle(selection.bundle);
  const hash = sha256Utf8(`${canonicalizeJson(selection.bundle.manifest)}\n`);
  if (hash !== selection.bundleManifestHash) {
    throw manualError(
      "RENDER_ERROR",
      "Manual merge request handoff cannot use an unverified Bundle",
      "bundle",
      "a Bundle whose manifest hash matches the release selection",
      "manifest hash mismatch",
      "Install a complete verified release and retry.",
    );
  }
  return selection;
}

export function createManualCommandServices(
  dependencies: ManualCommandDependencies,
): Pick<ProductionCommandServices, "manual"> {
  const repositoryRuntime = dependencies.repository ?? defaultManualRepository;
  return {
    manual: async (invocation) => {
      if (invocation.command.kind === "manual" && invocation.command.sshMergeRequest && invocation.options.authMode === "api") {
        throw manualError(
          "REPOSITORY_ERROR",
          "SSH merge request push options cannot be combined with API auth mode",
          "authMode",
          "ssh or auto",
          "api",
          "Use manual --auth ssh --ssh-mr, or use the API create flow without --ssh-mr.",
        );
      }
      if (invocation.options.authMode === "ssh" && invocation.options.input === null) {
        throw manualError(
          "INPUT_ERROR",
          "SSH manual mode requires structured request input",
          "input",
          "--input <path> or --input - with --input-format json|yaml",
          "no structured input source",
          "Build the Request from schema show/profiles list and pass it through JSON or YAML stdin; this keeps SSH mode token-free.",
        );
      }
      const selection = verifySelection(dependencies.currentBundle);
      const request = manualRequest(await dependencies.requestSource.read(invocation));
      const repository = await repositoryRuntime.discover({
        cwd: dependencies.cwd,
        targetBranch: request.targetBranch,
      });
      let mergeBaseSha = repository.targetRefSha;
      try {
        mergeBaseSha = await repositoryRuntime.mergeBase(repository);
      } catch {
        // A valid target ref is sufficient for a deterministic handoff when
        // the local repository cannot calculate merge-base.
      }
      const labels = manualLabels(selection.bundle, request);
      const snapshot = manualSnapshot(repository, request, labels, mergeBaseSha);
      const title = renderTitle(request, selection.bundle);
      const writePlan = {
        writePlanVersion: 1 as const,
        title,
        labelIds: labels.map((label) => label.id),
        assigneeUserId: null,
        reviewerUserIds: [],
        removeSourceBranch: request.mergeRequest.removeSourceBranch,
        squash: request.mergeRequest.squash,
      };
      const description = renderDescription({
        request,
        snapshot,
        writePlan,
        bundle: selection.bundle,
        releaseTag: selection.releaseTag,
        cliVersion: dependencies.cliVersion,
        renderPhase: "provisional",
      });
      let plan: SourceBranchPushPlan | null = null;
      let pushError = false;
      let pushResult: Awaited<ReturnType<typeof executeSourceBranchPush>> | null = null;
      try {
        const pushOptions = invocation.command.kind === "manual" && invocation.command.sshMergeRequest
          ? buildSshMergeRequestPushOptions({
              targetBranch: request.targetBranch,
              title,
              description,
              draft: request.intent === "draft",
            })
          : undefined;
        plan = await repositoryRuntime.planPush(repository, {
          allowPush: invocation.options.push,
          dryRun: invocation.options.dryRun,
          ...(pushOptions === undefined ? {} : { pushOptions }),
        });
      } catch {
        pushError = true;
        if (invocation.options.push) {
          throw manualError(
            "REPOSITORY_ERROR",
            "SSH push could not be planned without changing GitLab state",
            "push",
            "a readable remote branch or an explicit manual push command",
            "remote branch state is unavailable",
            "Check the SSH agent or credential helper, then rerun manual without --push or retry --push.",
          );
        }
      }
      if (invocation.options.push && plan !== null) {
        if (invocation.options.authMode !== "api" && !isSshPushUrl(repository.sourcePushUrl)) {
          throw manualError(
            "REPOSITORY_ERROR",
            "SSH-first mode requires an SSH source remote",
            "remote",
            "a GitLab SSH push URL",
            repository.sourcePushUrl,
            "Run git remote set-url --push origin git@<gitlab-host>:<group>/<project>.git, verify ssh -T, and retry.",
          );
        }
        pushResult = await repositoryRuntime.executePush(repository, plan, {
          authorized: true,
          dryRun: invocation.options.dryRun,
        });
      }
      const manualSteps = [
        "Review the generated title and description; GitLab labels, assignee, and reviewers were not read.",
        invocation.options.push
          ? "The source branch push was requested through the configured Git remote; confirm the execution result below."
          : "Run pushPlan.command with your SSH agent or Git credential helper if the source branch is not already remote.",
        invocation.command.kind === "manual" && invocation.command.sshMergeRequest
          ? request.intent === "draft"
            ? "The SSH push requested a Draft Merge Request with generated title and description; creation is not API-verified. Open GitLab and verify it before adding labels, assignee, and reviewers."
            : "The SSH push requested a Merge Request with generated title and description; creation is not API-verified. Open GitLab and verify it before adding labels, assignee, and reviewers."
          : "Open the GitLab project, create the Merge Request manually, paste the title and description, and choose labels, assignee, and reviewers in the UI.",
      ];
      const targetProject = repository.targetProject;
      return {
        context: executionContext(selection),
        output: {
          data: {
            command: "manual",
            mode: invocation.command.kind === "manual" && invocation.command.sshMergeRequest ? "ssh-mr" : "manual",
            authMode: invocation.options.authMode,
            tokenRequired: false,
            remoteApi: "not-used",
            title,
            description,
            targetBranch: request.targetBranch,
            sourceBranch: repository.sourceBranch,
            sourceHeadSha: repository.sourceHeadSha,
            targetRefSha: repository.targetRefSha,
            targetProject: targetProject === null ? null : {
              host: targetProject.host,
              path: targetProject.path,
            },
            pushPlan: pushData(repository, plan, pushError, pushResult),
            manualLabelPlaceholders: labels.map((label) => label.name),
            manualSteps,
            ...(invocation.command.kind === "manual" && invocation.command.sshMergeRequest
              ? { mrCreation: pushResult?.kind === "pushed" || pushResult?.kind === "synchronized-after-unknown" ? "requested-unverified" : "not-requested" }
              : {}),
          },
        },
      };
    },
  };
}
