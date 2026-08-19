import type {
  LoadedMrBundle,
  MrBundleIdentity,
} from "../app/load-mr-bundle.ts";
import { resolveRequestCandidates } from "../app/resolve-candidates.ts";
import { detectProfiles } from "../bundle/detect-profile.ts";
import { validateTemplateBundle } from "../bundle/validate.ts";
import { isToolError, ToolError } from "../contracts/errors.ts";
import {
  canonicalizeJson,
  sha256Utf8,
  type JsonValue,
} from "../contracts/jcs.ts";
import type { Request } from "../contracts/request.ts";
import { CandidateContextStore } from "../context/store.ts";
import type { CandidateContextStore as CandidateContextStoreType } from "../context/store.ts";
import { getContext } from "../app/get-context.ts";
import type { CanonicalChangeSet } from "../git/change-set.ts";
import { readCanonicalChangeSet } from "../git/change-set.ts";
import { planSourceBranchPush } from "../git/push-plan.ts";
import type {
  GitLabProjectIdentity,
  RepositorySnapshot,
} from "../git/repository.ts";
import { discoverProfileDetectionRepository } from "../git/target-branch.ts";
import type { InputIo } from "../input/load-input.ts";
import {
  defaultStateDirectory,
  type WindowsAclVerifier,
} from "../platform/state-path.ts";
import type { TrustedBundleSelection } from "./commands/local.ts";
import {
  createProductionCommandHandlers,
  type ProductionCommandServices,
} from "./commands/production.ts";
import {
  createReadOnlyCommandServices,
  type DoctorCheck,
  type DoctorReport,
  type PreparedReadOnlyContext,
  type ReadOnlyCommandDependencies,
  type ReadOnlyProfileDetection,
  type ReadOnlyPushPlan,
} from "./commands/readonly.ts";
import {
  createProfileDetectionCommandServices,
  type ProfileDetectionRepositoryRuntime,
} from "./commands/repository.ts";
import type { CliCommandHandlers } from "./execute.ts";
import {
  createProductionRequestSource,
  type InteractiveRequestWizard,
} from "./production-input.ts";
import type { CliInvocation } from "./program.ts";
import { buildWizardCatalog } from "./wizard-catalog.ts";
import { createNodeWizardConsole } from "./wizard-console.ts";
import { createSecureWizardLongFormEditor } from "./wizard-editor.ts";
import {
  createInteractiveRequestWizard,
  type WizardConsole,
  type WizardCatalogSource,
  type WizardLongFormEditor,
} from "./wizard.ts";
import {
  createGitLabTargetSessionResolver,
  type TargetGitLabSession,
  type TargetGitLabSessionResolver,
  type TargetProjectResolver,
} from "./target-project.ts";

type DefaultContextStore = Pick<CandidateContextStoreType, "issue" | "resolve">;

export interface ProductionReadOnlyRepositoryRuntime {
  readonly discover: (options: {
    readonly cwd: string;
    readonly expectedTargetProject: GitLabProjectIdentity;
    readonly targetBranch: string;
    readonly targetRemote: string;
  }) => Promise<RepositorySnapshot>;
  readonly readChangeSet: (repository: RepositorySnapshot) => Promise<CanonicalChangeSet>;
  readonly planPush: (repository: RepositorySnapshot) => Promise<ReadOnlyPushPlan>;
}

export interface ProductionHistoricalMrBundleLoader {
  readonly loadVerifiedExact: (current: MrBundleIdentity) => Promise<LoadedMrBundle>;
}

export interface ProductionReadOnlyDefaultOverrides {
  readonly contextStore?: DefaultContextStore;
  readonly historicalMrBundleLoader?: ProductionHistoricalMrBundleLoader;
  readonly inputIo?: InputIo;
  readonly repository?: ProductionReadOnlyRepositoryRuntime;
  readonly stateDirectory?: string;
  readonly stdinIsTerminal?: () => boolean;
  readonly targetSessionResolver?: TargetGitLabSessionResolver;
  readonly wizard?: InteractiveRequestWizard;
  readonly wizardConsole?: WizardConsole;
  readonly wizardEditor?: WizardLongFormEditor;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export interface ProductionReadOnlyDefaultsOptions extends ProductionReadOnlyDefaultOverrides {
  readonly cliVersion: string;
  readonly contextIssueIid: number | null;
  readonly currentBundle: TrustedBundleSelection;
  readonly cwd: string;
}

function lazyDefaultContextStore(
  options: ProductionReadOnlyDefaultsOptions,
): DefaultContextStore {
  let resolved: CandidateContextStore | undefined;
  const store = (): CandidateContextStore => {
    resolved ??= new CandidateContextStore({
      stateDirectory: options.stateDirectory ?? defaultStateDirectory(),
      ...(options.windowsAclVerifier === undefined
        ? {}
        : { windowsAclVerifier: options.windowsAclVerifier }),
    });
    return resolved;
  };
  return Object.freeze({
    issue: async (input: Parameters<DefaultContextStore["issue"]>[0]) => store().issue(input),
    resolve: async (input: Parameters<DefaultContextStore["resolve"]>[0]) => store().resolve(input),
  });
}

function readonlyCompositionError(): ToolError<"INTERNAL_ERROR"> {
  return new ToolError("INTERNAL_ERROR", "Default read-only composition failed safely", {
    field: "runtime",
    expected: "one immutable target session and repository snapshot",
    actual: "production read-only dependency returned inconsistent state",
    safeNextStep: "Run doctor, refresh the repository, and retry.",
  });
}

function credentialAssertionFor(
  session: TargetGitLabSession,
): TargetGitLabSession["assertNoCredentialExposure"] {
  const candidate = (session as Partial<TargetGitLabSession>).assertNoCredentialExposure;
  if (typeof candidate !== "function") throw readonlyCompositionError();
  const assertion: TargetGitLabSession["assertNoCredentialExposure"] = (value) => {
    try {
      candidate(value);
    } catch {
      throw readonlyCompositionError();
    }
  };
  assertion({
    identity: session.identity,
    origin: session.origin,
    project: session.project,
    targetRemote: session.targetRemote,
  });
  return Object.freeze(assertion);
}

function repositoryCompositionError(): ToolError<"REPOSITORY_ERROR"> {
  return new ToolError("REPOSITORY_ERROR", "Repository identity is not suitable for GitLab context", {
    field: "repository",
    expected: "one GitLab source project and the resolved target project",
    actual: "repository and GitLab identities are inconsistent",
    safeNextStep: "Fetch the selected remotes, verify their project identities, and retry.",
  });
}

function historicalSecurityError(): ToolError<"UPDATE_SECURITY_ERROR"> {
  return new ToolError("UPDATE_SECURITY_ERROR", "Historical Template Bundle trust is unavailable", {
    field: "bundle",
    expected: "a durable MR receipt and its exact source-pinned historical Bundle",
    actual: "verified historical release source unavailable",
    safeNextStep: "Restore the verified historical release source and retry; no write was attempted.",
  });
}

function unmanagedHistoricalError(): ToolError<"UNMANAGED_MR"> {
  return new ToolError("UNMANAGED_MR", "The merge request is not a verified harness-mrtool MR", {
    field: "mergeRequest.description",
    expected: "a final marker with a matching durable receipt",
    actual: "managed MR proof unavailable",
    safeNextStep: "Refresh the managed MR before retrying; no write was attempted.",
  });
}

function mapHistoricalFailure(error: unknown): never {
  if (isToolError(error, "UNMANAGED_MR")) throw unmanagedHistoricalError();
  throw historicalSecurityError();
}

function fixedPushCommand(
  remote: string,
  sourceHeadSha: string,
  remoteRef: string,
): string {
  return `git push --no-force ${remote} ${sourceHeadSha}:${remoteRef}`;
}

const defaultReadOnlyRepository: ProductionReadOnlyRepositoryRuntime = Object.freeze({
  discover: discoverProfileDetectionRepository,
  readChangeSet: readCanonicalChangeSet,
  async planPush(repository: RepositorySnapshot): Promise<ReadOnlyPushPlan> {
    const plan = await planSourceBranchPush(repository, { allowPush: false, dryRun: true });
    if (plan.kind === "up-to-date") {
      return Object.freeze({
        kind: "up-to-date",
        remote: plan.remote,
        ref: plan.remoteRef,
        sourceHeadSha: plan.localHeadSha,
        remoteSha: plan.beforeSha,
        command: null,
      });
    }
    return Object.freeze({
      kind: plan.relation === "absent" ? "missing" : "behind",
      remote: plan.remote,
      ref: plan.remoteRef,
      sourceHeadSha: plan.localHeadSha,
      remoteSha: plan.beforeSha,
      command: fixedPushCommand(plan.remote, plan.localHeadSha, plan.remoteRef),
    });
  },
});

function requestIssueIid(request: Request | null): number | null {
  return request === null || request.workItem.relation === "none"
    ? null
    : request.workItem.iid;
}

function operationFor(
  command: "context" | "labels.list" | "preview",
  invocation: CliInvocation,
): "create" | "update" | "migrate" {
  if (command !== "context") return "create";
  if (invocation.command.kind !== "context") throw readonlyCompositionError();
  if (invocation.command.mrIid === null) return "create";
  return invocation.command.migrateTemplate ? "migrate" : "update";
}

function profileDetection(
  selection: TrustedBundleSelection,
  changeSet: CanonicalChangeSet,
  request: Request | null,
): ReadOnlyProfileDetection {
  if (request !== null) {
    return Object.freeze({
      kind: "detected",
      profileIds: Object.freeze([...request.profileIds]),
      reasons: Object.freeze(request.profileIds.map((profileId) => Object.freeze({
        code: "normalized-request-profile",
        profileId,
      }))),
    });
  }
  const detected = detectProfiles(selection.bundle, changeSet.items);
  if (detected.kind === "detected") {
    return Object.freeze({
      kind: "detected",
      profileIds: Object.freeze([...detected.profileIds]),
      reasons: Object.freeze(detected.profileIds.map((profileId) => Object.freeze({
        code: "matched-versioned-profile-rules",
        profileId,
      }))),
    });
  }
  return Object.freeze({
    kind: "ambiguous",
    profileIds: Object.freeze([]),
    reasons: Object.freeze([Object.freeze({
      code: detected.reason,
      itemIndex: detected.itemIndex,
    })]),
  });
}

function localChecks(repository: RepositorySnapshot) {
  return Object.freeze({
    commitConvention: Object.freeze({
      status: "not-run" as const,
      evidence: "Commit convention check is not configured for this read-only invocation.",
    }),
    secretScan: Object.freeze({
      status: "not-run" as const,
      evidence: "Secret scan is not configured for this read-only invocation.",
    }),
    repositoryHygiene: Object.freeze({
      status: repository.worktree.clean ? "passed" as const : "failed" as const,
      evidence: repository.worktree.clean
        ? "Git worktree is clean."
        : "Git worktree has local changes.",
    }),
  });
}

function historicalSelection(historical: LoadedMrBundle): TrustedBundleSelection {
  return Object.freeze({
    bundle: historical.bundle,
    bundleManifestHash: historical.bundleManifestHash,
    releaseSetId: `historical:${historical.bundleManifestHash}`,
    releaseTag: historical.reference.releaseTag,
  });
}

async function loadHistorical(
  loader: ProductionHistoricalMrBundleLoader | undefined,
  current: MrBundleIdentity,
): Promise<LoadedMrBundle> {
  if (loader === undefined) throw historicalSecurityError();
  try {
    return await loader.loadVerifiedExact(Object.freeze({ ...current }));
  } catch (error) {
    mapHistoricalFailure(error);
  }
}

async function sourceProjectFor(
  session: TargetGitLabSession,
  repository: RepositorySnapshot,
  assertNoCredentialExposure: TargetGitLabSession["assertNoCredentialExposure"],
) {
  const sourceIdentity = repository.sourceProject;
  if (sourceIdentity === null || sourceIdentity.host !== session.identity.host) {
    throw repositoryCompositionError();
  }
  const sourceProject = sourceIdentity.path === session.project.fullPath
    ? session.project
    : await session.gitlab.getProject(sourceIdentity.path);
  assertNoCredentialExposure(sourceProject);
  if (sourceProject.fullPath !== sourceIdentity.path) throw repositoryCompositionError();
  return sourceProject;
}

function assertChangeSetBinding(
  repository: RepositorySnapshot,
  changeSet: CanonicalChangeSet,
): void {
  if (
    changeSet.sourceHeadSha !== repository.sourceHeadSha ||
    changeSet.targetRefSha !== repository.targetRefSha
  ) {
    throw repositoryCompositionError();
  }
}

function assertRepositoryBinding(
  session: TargetGitLabSession,
  repository: RepositorySnapshot,
): void {
  if (
    repository.gitlabHost !== session.identity.host ||
    repository.targetProject?.host !== session.identity.host ||
    repository.targetProject.path !== session.identity.path ||
    repository.targetBranch !== session.project.defaultBranch ||
    repository.targetRemote !== session.targetRemote ||
    repository.sourceProject === null ||
    repository.sourceProject.host !== session.identity.host ||
    repository.sourceRemoteRef !== `refs/heads/${repository.sourceBranch}` ||
    repository.targetRef !== `refs/remotes/${repository.targetRemote}/${repository.targetBranch}`
  ) {
    throw repositoryCompositionError();
  }
}

function assertPushPlanBinding(
  repository: RepositorySnapshot,
  pushPlan: ReadOnlyPushPlan,
): void {
  if (
    pushPlan.remote !== repository.sourceRemote ||
    pushPlan.ref !== repository.sourceRemoteRef ||
    pushPlan.sourceHeadSha !== repository.sourceHeadSha
  ) {
    throw repositoryCompositionError();
  }
}

function assertMrBinding(
  session: TargetGitLabSession,
  repository: RepositorySnapshot,
  sourceProjectId: string,
  requestedIid: number,
  mr: Awaited<ReturnType<TargetGitLabSession["gitlab"]["getMergeRequest"]>>,
): void {
  if (
    mr.iid !== requestedIid ||
    mr.targetProjectId !== session.project.id ||
    mr.targetBranch !== session.project.defaultBranch ||
    mr.sourceProjectId !== sourceProjectId ||
    mr.sourceBranch !== repository.sourceBranch ||
    mr.sha !== repository.sourceHeadSha
  ) {
    throw repositoryCompositionError();
  }
}

type Diagnostic<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false };

interface DoctorLabelInventory {
  readonly effective: readonly {
    readonly archived: boolean;
    readonly name: string;
  }[];
}

function doctorCheck(
  id: string,
  status: DoctorCheck["status"],
  detail: string,
): DoctorCheck {
  return Object.freeze({ id, status, detail });
}

async function diagnostic<T>(read: () => Promise<T>): Promise<Diagnostic<T>> {
  try {
    return Object.freeze({ ok: true, value: await read() });
  } catch {
    return Object.freeze({ ok: false });
  }
}

async function credentialDiagnostic<T>(
  read: () => Promise<T>,
  assertNoCredentialExposure: TargetGitLabSession["assertNoCredentialExposure"],
): Promise<Diagnostic<T>> {
  let value: T;
  try {
    value = await read();
  } catch {
    return Object.freeze({ ok: false });
  }
  assertNoCredentialExposure(value);
  return Object.freeze({ ok: true, value });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function scalar(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim() &&
    !/[\r\n\u0000]/u.test(value);
}

function bundleIsBound(selection: TrustedBundleSelection): boolean {
  try {
    validateTemplateBundle(selection.bundle);
    return scalar(selection.releaseSetId) && scalar(selection.releaseTag) &&
      /^[a-f0-9]{64}$/u.test(selection.bundleManifestHash) &&
      sha256Utf8(`${canonicalizeJson(selection.bundle.manifest)}\n`) === selection.bundleManifestHash;
  } catch {
    return false;
  }
}

function requiredLabelCoverage(
  selection: TrustedBundleSelection,
  inventory: DoctorLabelInventory,
): boolean {
  try {
    const policy = record(selection.bundle.policy);
    const labels = record(policy?.labels);
    const categories = record(labels?.categories);
    const lifecycle = record(labels?.lifecycle);
    const expectedNames = record(lifecycle?.expectedNames);
    if (categories === null || expectedNames === null) return false;
    const activeNames = inventory.effective
      .filter((label) => !label.archived)
      .map((label) => label.name);
    const requiredPatterns = Object.values(categories).flatMap((value) => {
      const category = record(value);
      if (category?.required !== true) return [];
      if (!scalar(category.match)) throw new TypeError("label policy");
      return [new RegExp(category.match, "u")];
    });
    const lifecycleNames = Object.values(expectedNames);
    return requiredPatterns.every((pattern) => activeNames.some((name) => pattern.test(name))) &&
      lifecycleNames.every((name) => scalar(name) && activeNames.includes(name));
  } catch {
    return false;
  }
}

function validLabelInventory(value: unknown): value is DoctorLabelInventory {
  const inventory = record(value);
  return inventory !== null && Array.isArray(inventory.effective) &&
    inventory.effective.every((entry) => {
      const label = record(entry);
      return label !== null && scalar(label.name) && typeof label.archived === "boolean";
    });
}

function validCurrentUser(value: unknown): boolean {
  const user = record(value);
  return user !== null && scalar(user.id) && scalar(user.username) && user.state === "active";
}

function validMinimumPermissions(userValue: unknown, membersValue: unknown): boolean {
  const user = record(userValue);
  if (user === null || !scalar(user.id) || !Array.isArray(membersValue)) return false;
  return membersValue.some((entry) => {
    const member = record(entry);
    return member !== null && member.id === user.id && member.state === "active" &&
      Number.isSafeInteger(member.accessLevel) && (member.accessLevel as number) >= 30;
  });
}

function validProject(value: unknown, session: TargetGitLabSession): boolean {
  const project = record(value);
  return project !== null && project.id === session.project.id &&
    project.fullPath === session.project.fullPath &&
    project.defaultBranch === session.project.defaultBranch &&
    project.webUrl === session.project.webUrl;
}

function validCapabilities(value: unknown): boolean {
  const capabilities = record(value);
  if (capabilities === null || !scalar(capabilities.version) ||
      capabilities.mergeRequestSetLabels !== true ||
      !Array.isArray(capabilities.labelOperationModes)) return false;
  const modes = capabilities.labelOperationModes;
  return modes.length === 2 && modes.includes("ADD") && modes.includes("REMOVE");
}

async function inspectDoctorRepository(
  session: TargetGitLabSession,
  repository: ProductionReadOnlyRepositoryRuntime,
  cwd: string,
): Promise<{
  readonly snapshot: RepositorySnapshot;
  readonly changeSetReady: boolean;
}> {
  const snapshot = await repository.discover({
    cwd,
    expectedTargetProject: session.identity,
    targetBranch: session.project.defaultBranch,
    targetRemote: session.targetRemote,
  });
  assertRepositoryBinding(session, snapshot);
  const changeSetResult = await diagnostic(async () => {
    const changeSet = await repository.readChangeSet(snapshot);
    assertChangeSetBinding(snapshot, changeSet);
  });
  return Object.freeze({ snapshot, changeSetReady: changeSetResult.ok });
}

function unavailableDoctorReport(
  bundleReady: boolean,
  historicalAvailable: boolean,
): DoctorReport {
  return Object.freeze({
    checks: Object.freeze([
      doctorCheck("repository", "failed", "Repository diagnostics could not resolve the target session."),
      doctorCheck("remote", "failed", "Git remote and GitLab host identity could not be verified."),
      doctorCheck("worktree", "warning", "Worktree state is unavailable."),
      doctorCheck("git-identity", "warning", "Git identity diagnostics are unavailable because no identity probe is installed."),
      doctorCheck("gitlab-authentication", "failed", "GitLab authentication could not be verified."),
      doctorCheck("gitlab-minimum-permissions", "failed", "Minimum GitLab project permissions could not be verified."),
      doctorCheck("gitlab-project-rest", "failed", "GitLab project REST access could not be verified."),
      doctorCheck("gitlab-capabilities", "failed", "GitLab GraphQL label mutation capabilities could not be verified."),
      doctorCheck("gitlab-labels-rest", "failed", "GitLab label inventory access could not be verified."),
      doctorCheck("gitlab-issue-mr-rest", "warning", "Issue and merge request REST probes are unavailable without bound object IDs."),
      doctorCheck("bundle", bundleReady ? "passed" : "failed", bundleReady
        ? "Template Bundle integrity is valid."
        : "Template Bundle integrity could not be verified."),
      doctorCheck("required-label-candidates", "failed", "Required label candidates could not be verified."),
      doctorCheck("protocols", bundleReady ? "passed" : "failed", bundleReady
        ? "CLI input and Policy schema protocols are compatible."
        : "CLI input and Policy schema compatibility could not be verified."),
      doctorCheck("skill-protocol", "warning", "Skill protocol state is unavailable because no Skill state probe is installed."),
      doctorCheck("release-set", bundleReady ? "passed" : "failed", bundleReady
        ? "The current release set is bound to the verified Bundle."
        : "The current release set could not be verified."),
      doctorCheck("candidate-context-state", "warning", "Candidate context state is unavailable to doctor because the private state path is not accessed."),
      doctorCheck("signed-cache", "warning", "Signed release cache state is unavailable because no cache probe is installed."),
      doctorCheck("update-state", "warning", "Update state is unavailable because no update probe is installed."),
      doctorCheck("rollback-state", "warning", "Rollback state is unavailable because no rollback probe is installed."),
      doctorCheck("installation", "warning", "Installation update and rollback safety is unavailable because no installation probe is installed."),
    ]),
    capabilities: Object.freeze({
      context: false,
      "historical-mr-context": historicalAvailable,
      "labels-list": false,
      preview: false,
      "gitlab-authentication": false,
      "gitlab-minimum-permissions": false,
      "gitlab-project-rest": false,
      "gitlab-labels-rest": false,
      "gitlab-issues-rest": false,
      "gitlab-merge-requests-rest": false,
      "gitlab-label-id-mutation": false,
    }),
  });
}

async function productionDoctorReport(
  selection: TrustedBundleSelection,
  targetSessionResolver: TargetGitLabSessionResolver,
  repository: ProductionReadOnlyRepositoryRuntime,
  cwd: string,
  historicalAvailable: boolean,
): Promise<DoctorReport> {
  const bundleReady = bundleIsBound(selection);
  const sessionResult = await diagnostic(() => targetSessionResolver.resolve({ cwd }));
  if (!sessionResult.ok) return unavailableDoctorReport(bundleReady, historicalAvailable);
  const session = sessionResult.value;
  const assertNoCredentialExposure = credentialAssertionFor(session);
  const [repositoryResult, userResult, membersResult, projectResult, capabilityResult, inventoryResult] = await Promise.all([
    diagnostic(() => inspectDoctorRepository(session, repository, cwd)),
    credentialDiagnostic(() => session.gitlab.getCurrentUser(), assertNoCredentialExposure),
    credentialDiagnostic(() => session.gitlab.listUsers(session.project.id), assertNoCredentialExposure),
    credentialDiagnostic(() => session.gitlab.getProject(session.project.id), assertNoCredentialExposure),
    credentialDiagnostic(() => session.gitlab.probeCapabilities(), assertNoCredentialExposure),
    credentialDiagnostic(() => session.gitlab.labelInventory(session.project.id), assertNoCredentialExposure),
  ]);
  const snapshotReady = repositoryResult.ok;
  const repositoryReady = snapshotReady && repositoryResult.value.changeSetReady;
  const authenticationReady = userResult.ok && validCurrentUser(userResult.value);
  const permissionsReady = authenticationReady && membersResult.ok &&
    validMinimumPermissions(userResult.value, membersResult.value);
  const projectReady = projectResult.ok && validProject(projectResult.value, session);
  const capabilityReady = capabilityResult.ok && validCapabilities(capabilityResult.value);
  const labelsReady = inventoryResult.ok && validLabelInventory(inventoryResult.value);
  const requiredLabelsReady = labelsReady && requiredLabelCoverage(selection, inventoryResult.value);
  const protocolReady = bundleReady && selection.bundle.manifest.inputSchema === 1 &&
    selection.bundle.manifest.policySchema === 1;
  const checks: readonly DoctorCheck[] = Object.freeze([
    doctorCheck("repository", repositoryReady ? "passed" : "failed", repositoryReady
      ? "Repository identity and canonical change set are bound to one snapshot."
      : "Repository identity or canonical change-set binding could not be verified."),
    doctorCheck("remote", snapshotReady ? "passed" : "failed", snapshotReady
      ? "Git remote and GitLab host identity are bound to the target session."
      : "Git remote and GitLab host identity could not be verified."),
    doctorCheck("worktree", snapshotReady
      ? (repositoryResult.value.snapshot.worktree.clean ? "passed" : "warning")
      : "warning", snapshotReady
      ? (repositoryResult.value.snapshot.worktree.clean ? "Git worktree is clean." : "Git worktree has local changes.")
      : "Worktree state is unavailable."),
    doctorCheck("git-identity", "warning", "Git identity diagnostics are unavailable because no identity probe is installed."),
    doctorCheck("gitlab-authentication", authenticationReady ? "passed" : "failed", authenticationReady
      ? "GitLab authentication resolved an active user."
      : "GitLab authentication could not resolve an active user."),
    doctorCheck("gitlab-minimum-permissions", permissionsReady ? "passed" : "failed", permissionsReady
      ? "GitLab project membership meets the minimum Developer access level."
      : "Minimum GitLab project permissions could not be verified."),
    doctorCheck("gitlab-project-rest", projectReady ? "passed" : "failed", projectReady
      ? "GitLab project REST identity matches the target session."
      : "GitLab project REST identity could not be verified."),
    doctorCheck("gitlab-capabilities", capabilityReady ? "passed" : "failed", capabilityReady
      ? "GitLab supports GraphQL label ADD and REMOVE by global ID."
      : "GitLab GraphQL label mutation capabilities could not be verified."),
    doctorCheck("gitlab-labels-rest", labelsReady ? "passed" : "failed", labelsReady
      ? "GitLab label inventory REST access completed."
      : "GitLab label inventory REST access could not be verified."),
    doctorCheck("gitlab-issue-mr-rest", "warning", "Issue and merge request REST probes are unavailable without bound object IDs."),
    doctorCheck("bundle", bundleReady ? "passed" : "failed", bundleReady
      ? "Template Bundle integrity is valid."
      : "Template Bundle integrity could not be verified."),
    doctorCheck("required-label-candidates", requiredLabelsReady ? "passed" : "failed", requiredLabelsReady
      ? "Every required label category and lifecycle state has a live candidate."
      : "One or more required label candidates could not be verified."),
    doctorCheck("protocols", protocolReady ? "passed" : "failed", protocolReady
      ? "CLI input and Policy schema protocols are compatible."
      : "CLI input or Policy schema compatibility could not be verified."),
    doctorCheck("skill-protocol", "warning", "Skill protocol state is unavailable because no Skill state probe is installed."),
    doctorCheck("release-set", bundleReady ? "passed" : "failed", bundleReady
      ? "The current release set is bound to the verified Bundle."
      : "The current release set could not be verified."),
    doctorCheck("candidate-context-state", "warning", "Candidate context state is unavailable to doctor because the private state path is not accessed."),
    doctorCheck("signed-cache", "warning", "Signed release cache state is unavailable because no cache probe is installed."),
    doctorCheck("update-state", "warning", "Update state is unavailable because no update probe is installed."),
    doctorCheck("rollback-state", "warning", "Rollback state is unavailable because no rollback probe is installed."),
    doctorCheck("installation", "warning", "Installation update and rollback safety is unavailable because no installation probe is installed."),
  ]);
  const audit = session.gitlab.audit();
  assertNoCredentialExposure(audit);
  const report = Object.freeze({
    checks,
    capabilities: Object.freeze({
      context: false,
      "historical-mr-context": historicalAvailable,
      "labels-list": repositoryReady && projectReady && labelsReady,
      preview: false,
      "gitlab-authentication": authenticationReady,
      "gitlab-minimum-permissions": permissionsReady,
      "gitlab-project-rest": projectReady,
      "gitlab-labels-rest": labelsReady,
      "gitlab-issues-rest": false,
      "gitlab-merge-requests-rest": false,
      "gitlab-label-id-mutation": capabilityReady,
    }),
    audit,
  });
  assertNoCredentialExposure(report);
  return report;
}

function wizardContextInvocation(invocation: CliInvocation): CliInvocation {
  const command = invocation.command;
  const mrIid = command.kind === "update" ? command.iid : null;
  const migrateTemplate = command.kind === "update" && command.migrateTemplate;
  return Object.freeze({
    ...invocation,
    command: Object.freeze({ kind: "context", mrIid, migrateTemplate }),
  });
}

export function createProductionReadOnlyDefaults(
  options: ProductionReadOnlyDefaultsOptions,
): Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd"> {
  const repository = options.repository ?? defaultReadOnlyRepository;
  const targetSessionResolver = options.targetSessionResolver ?? createGitLabTargetSessionResolver();
  const contextStore = options.contextStore ?? lazyDefaultContextStore(options);
  let composition: Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd"> | undefined;
  const wizard = options.wizard ?? createInteractiveRequestWizard({
    catalogSource: Object.freeze({
      load: async ({
        invocation,
        issueIid,
      }: Parameters<WizardCatalogSource["load"]>[0]) => {
        if (composition === undefined) throw readonlyCompositionError();
        const contextInvocation = wizardContextInvocation(invocation);
        const prepared = await composition.planner.prepare({
          cliVersion: options.cliVersion,
          command: "context",
          currentBundle: options.currentBundle,
          cwd: options.cwd,
          invocation: contextInvocation,
          request: null,
          contextIssueIid: issueIid,
        });
        const discovered = await getContext({
          ...prepared.options,
          store: contextStore,
        });
        prepared.assertNoCredentialExposure(discovered);
        return buildWizardCatalog({
          bundle: prepared.selection.bundle,
          discovered,
          suggestedProfileIds: prepared.profileDetection.kind === "detected"
            ? prepared.profileDetection.profileIds
            : [],
          confirmations: null,
        });
      },
    }),
    console: options.wizardConsole ?? createNodeWizardConsole(),
    editor: options.wizardEditor ?? createSecureWizardLongFormEditor(),
  });
  const requestSource = createProductionRequestSource({
    ...(options.inputIo === undefined ? {} : { inputIo: options.inputIo }),
    ...(options.stdinIsTerminal === undefined ? {} : { stdinIsTerminal: options.stdinIsTerminal }),
    wizard,
  });

  composition = Object.freeze({
    contextIssueIid: options.contextIssueIid,
    contextStore,
    doctorProbe: Object.freeze({
      inspect: async ({ currentBundle }: Parameters<ReadOnlyCommandDependencies["doctorProbe"]["inspect"]>[0]) => productionDoctorReport(
        currentBundle,
        targetSessionResolver,
        repository,
        options.cwd,
        options.historicalMrBundleLoader !== undefined,
      ),
    }),
    planner: Object.freeze({
      prepare: async (
        input: Parameters<ReadOnlyCommandDependencies["planner"]["prepare"]>[0],
      ): Promise<PreparedReadOnlyContext> => {
        const operation = operationFor(input.command, input.invocation);
        const mrIid = input.command === "context" && input.invocation.command.kind === "context"
          ? input.invocation.command.mrIid
          : null;
        const session = await targetSessionResolver.resolve({ cwd: options.cwd });
        const assertNoCredentialExposure = credentialAssertionFor(session);
        const mr = mrIid === null
          ? null
          : await session.gitlab.getMergeRequest(session.project.id, mrIid);
        if (mr !== null) assertNoCredentialExposure(mr);
        const historical = mr === null
          ? null
          : await loadHistorical(options.historicalMrBundleLoader, {
              iid: mrIid!,
              targetProjectId: session.project.id,
              description: mr.description,
            });
        const selection = operation === "update" && historical !== null
          ? historicalSelection(historical)
          : options.currentBundle;
        const snapshot = await repository.discover({
          cwd: options.cwd,
          expectedTargetProject: session.identity,
          targetBranch: session.project.defaultBranch,
          targetRemote: session.targetRemote,
        });
        assertRepositoryBinding(session, snapshot);
        const [changeSet, pushPlan] = await Promise.all([
          repository.readChangeSet(snapshot),
          repository.planPush(snapshot),
        ]);
        assertChangeSetBinding(snapshot, changeSet);
        assertPushPlanBinding(snapshot, pushPlan);
        const sourceProject = await sourceProjectFor(session, snapshot, assertNoCredentialExposure);
        if (mr !== null && mrIid !== null) {
          assertMrBinding(session, snapshot, sourceProject.id, mrIid, mr);
        }

        const prepared: PreparedReadOnlyContext = {
          assertNoCredentialExposure,
          selection,
          options: Object.freeze({
            operation,
            gitlabOrigin: session.origin,
            targetProject: session.project.fullPath,
            mrIid,
            issueIid: input.command === "context"
              ? input.contextIssueIid
              : requestIssueIid(input.request),
            git: Object.freeze({
              sourceProject: Object.freeze({ id: sourceProject.id, path: sourceProject.fullPath }),
              sourceBranch: snapshot.sourceBranch,
              sourceRemote: snapshot.sourceRemote,
              sourceRemoteRef: snapshot.sourceRemoteRef,
              targetRefSha: changeSet.targetRefSha,
              mergeBaseSha: changeSet.mergeBaseSha,
              sourceHeadSha: changeSet.sourceHeadSha,
              targetBranch: session.project.defaultBranch,
              targetRemote: snapshot.targetRemote,
              targetRef: snapshot.targetRef,
              localChecks: localChecks(snapshot),
            }),
            bundle: selection.bundle,
            release: Object.freeze({
              releaseSetId: selection.releaseSetId,
              releaseTag: selection.releaseTag,
              bundleManifestHash: selection.bundleManifestHash,
              cliVersion: options.cliVersion,
              skillProtocol: input.invocation.options.skillProtocol,
            }),
            gitlab: session.gitlab,
          }),
          profileDetection: profileDetection(selection, changeSet, input.request),
          gitDiffSummary: Object.freeze({
            changedFileCount: changeSet.items.length,
            targetRefSha: changeSet.targetRefSha,
            mergeBaseSha: changeSet.mergeBaseSha,
            sourceHeadSha: changeSet.sourceHeadSha,
          }),
          pushPlan,
          mergeRequestPlan: mr === null
            ? Object.freeze({ action: "create", iid: null, webUrl: null })
            : Object.freeze({ action: "update", iid: mr.iid, webUrl: mr.webUrl }),
          ...(operation !== "migrate" || historical === null
            ? {}
            : {
                migration: Object.freeze({
                  oldReleaseTag: historical.reference.releaseTag,
                  newReleaseTag: options.currentBundle.releaseTag,
                  oldBundleManifestHash: historical.bundleManifestHash,
                  newBundleManifestHash: options.currentBundle.bundleManifestHash,
                  oldPolicySchema: historical.bundle.manifest.policySchema,
                  newPolicySchema: options.currentBundle.bundle.manifest.policySchema,
                  historicalBundleEol: historical.eol,
                }),
              }),
        };
        return Object.freeze(prepared);
      },
    }),
    requestSource,
    resolveCandidates: async (
      input: Parameters<ReadOnlyCommandDependencies["resolveCandidates"]>[0],
    ) => {
      const resolved = await resolveRequestCandidates(input);
      return Object.freeze({
        binding: resolved.binding,
        snapshot: resolved.snapshot as unknown as JsonValue,
        candidates: resolved.candidates,
        candidateSelectionDigest: resolved.candidateSelectionDigest,
      });
    },
  });
  return composition;
}

export interface ProductionRuntimeDependencies {
  readonly cliVersion: string;
  readonly cwd: string;
  readonly currentBundle: TrustedBundleSelection;
  /** This port is scoped to profiles.detect and must not resolve MR targets. */
  readonly profileRepository: ProfileDetectionRepositoryRuntime;
  readonly targetProjectResolver: TargetProjectResolver;
  readonly readOnly?: Omit<
    ReadOnlyCommandDependencies,
    "cliVersion" | "currentBundle" | "cwd"
  >;
  readonly services?: Omit<ProductionCommandServices, "cliVersion" | "profilesDetect">;
}

export function createProductionRuntime(
  dependencies: ProductionRuntimeDependencies,
): CliCommandHandlers {
  const readOnly = dependencies.readOnly === undefined
    ? {}
    : createReadOnlyCommandServices({
        ...dependencies.readOnly,
        cliVersion: dependencies.cliVersion,
        currentBundle: dependencies.currentBundle,
        cwd: dependencies.cwd,
      });
  return createProductionCommandHandlers({
    cliVersion: dependencies.cliVersion,
    ...dependencies.services,
    ...readOnly,
    ...createProfileDetectionCommandServices(dependencies),
  });
}
