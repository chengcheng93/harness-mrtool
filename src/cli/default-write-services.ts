import { loadMrBundle } from "../app/load-mr-bundle.ts";
import { resolveRequestCandidates } from "../app/resolve-candidates.ts";
import { validateUpdateMigration, type UpdateMergeRequestMigration } from "../app/update-mr.ts";
import { buildWritePlan } from "../app/write-plan.ts";
import { defaultExternalContextReader } from "../app/external-context.ts";
import { selectMandatoryLabels } from "../app/mandatory-labels.ts";
import type { MergeRequestRemote } from "../app/create-mr.ts";
import { RemoteMutationError } from "../app/remote-outcome.ts";
import type { Candidate } from "../context/types.ts";
import { canonicalizeJson, sha256Utf8, copyJsonValue, type JsonObject } from "../contracts/jcs.ts";
import { ToolError } from "../contracts/errors.ts";
import { GitLabMergeRequestRemote } from "../gitlab/mr-remote.ts";
import { normalizeAndValidateRequest } from "../input/normalize.ts";
import { defaultStateDirectory } from "../platform/state-path.ts";
import { VerificationReceiptStore } from "../platform/verification-receipt-store.ts";
import { validateExternalContextSnapshot, type ExternalContextSnapshot } from "../render/marker.ts";
import { createMergeRequestCommandAdapter } from "./commands/merge-request.ts";
import type { ProductionCommandServices } from "./commands/production.ts";
import type { ReadOnlyCommandDependencies } from "./commands/readonly.ts";
import { createDefaultHistoricalBundleLoader } from "./default-historical-bundles.ts";
import { labelOptionsForProductionInvocation, updateConfirmationsForProductionInvocation } from "./production-invocation.ts";
import { defaultReadOnlyRepository, type ProductionReadOnlyDefaultsOptions } from "./production-runtime.ts";
import type { CliInvocation } from "./program.ts";

interface DefaultWriteDependencies {
  readonly options: ProductionReadOnlyDefaultsOptions;
  readonly currentBundle: ReadOnlyCommandDependencies["currentBundle"];
  readonly readOnly: Omit<ReadOnlyCommandDependencies, "cliVersion" | "currentBundle" | "cwd">;
}

function changed(): ToolError<"CONCURRENT_UPDATE"> {
  return new ToolError("CONCURRENT_UPDATE", "Repository or candidate identity changed before writing", {
    field: "changeSet", expected: "the exact prepared diff and live candidate identities",
    actual: "prepared evidence is stale", safeNextStep: "Refresh context and preview the current diff before retrying.",
  });
}

function candidatesMatch(snapshot: ExternalContextSnapshot, candidates: readonly Candidate[]): boolean {
  return candidates.every((candidate) => candidate.kind === "label"
    ? snapshot.labelCandidates.some((label) => label.id === candidate.globalId && label.name === candidate.name)
    : snapshot.userCandidates.some((user) => user.id === candidate.userId &&
      user.username === candidate.username && user.displayName === candidate.displayName));
}

/** Lazy command-scoped composition: read-only commands never initialize write resources. */
export function createDefaultWriteServices(
  dependencies: DefaultWriteDependencies,
): Pick<ProductionCommandServices, "create" | "update" | "verify"> {
  const { options, currentBundle, readOnly } = dependencies;

  async function execute(invocation: CliInvocation) {
    const command = invocation.command;
    if (command.kind !== "create" && command.kind !== "update" && command.kind !== "verify") {
      throw new TypeError("Expected an MR write or verification command");
    }
    if (invocation.options.offline) throw new ToolError("INPUT_ERROR", "Live MR commands are unavailable in offline mode", {
      field: "--offline", expected: "online live candidate and MR readback verification", actual: "offline",
      safeNextStep: "Use manual for a local handoff, or retry without --offline when GitLab is reachable.",
    });
    const reader = readOnly.externalContextReader ?? defaultExternalContextReader;
    const repository = options.repository ?? defaultReadOnlyRepository;
    const receiptStore = new VerificationReceiptStore({
      stateDirectory: options.stateDirectory ?? defaultStateDirectory(),
      ...(options.windowsAclVerifier === undefined ? {} : { windowsAclVerifier: options.windowsAclVerifier }),
    });
    const historical = createDefaultHistoricalBundleLoader(currentBundle, { ...options.historicalBundleDefaults, stateDirectory: options.stateDirectory });
    const mrIid = command.kind === "create" ? null : command.iid;
    if (command.kind !== "create" && mrIid === null) throw new ToolError("INPUT_ERROR", "An MR IID is required", {
      field: "iid", expected: "a resolved MR IID", actual: null, safeNextStep: "Specify the merge request IID and retry.",
    });
    const request = command.kind === "verify" ? null
      : normalizeAndValidateRequest(await readOnly.requestSource.read(invocation));
    const contextInvocation: CliInvocation = Object.freeze({ ...invocation, command: Object.freeze({
      kind: "context", mrIid, migrateTemplate: command.kind === "update" && command.migrateTemplate,
    }) });
    const planned = await readOnly.planner.prepare({
      cliVersion: options.cliVersion, command: "context", currentBundle, cwd: options.cwd,
      invocation: contextInvocation, request,
      allowManualDescriptionDrift: command.kind === "update" && (command.forceReplaceDescription || command.migrateTemplate),
      contextIssueIid: request === null ? options.contextIssueIid : request.workItem.relation === "none" ? null : request.workItem.iid,
    });
    const confirmed = updateConfirmationsForProductionInvocation(invocation);
    if (confirmed !== null && canonicalizeJson(confirmed) !== canonicalizeJson(planned.updateConfirmations ?? null)) throw changed();
    const live = await reader.read(planned.options);
    const snapshot = validateExternalContextSnapshot(live.snapshot);
    planned.assertNoCredentialExposure(snapshot);
    const selection = request === null ? null : selectMandatoryLabels({
      diff: planned.labelDiff, binding: snapshot, inventory: snapshot.labelCandidates,
      intent: request.intent, options: labelOptionsForProductionInvocation(invocation),
    });

    let mutationStarted = false;
    // Re-discover immediately before writing, rather than trusting a captured SHA tuple.
    async function fresh() {
      const git = planned.options.git;
      const url = new URL(planned.options.gitlabOrigin);
      const repo = await repository.discover({ cwd: options.cwd,
        expectedTargetProject: { host: url.host, path: planned.options.targetProject },
        targetBranch: git.targetBranch, targetRemote: git.targetRemote });
      if (!repo.worktree.clean || repo.targetProject?.host !== url.host ||
          repo.targetProject.path !== planned.options.targetProject || repo.targetRemote !== git.targetRemote ||
          repo.sourceRemote !== git.sourceRemote || repo.sourceRemoteRef !== git.sourceRemoteRef) throw changed();
      if (!invocation.options.dryRun) {
        const push = await repository.planPush(repo);
        if (push.kind !== "up-to-date" || push.remote !== git.sourceRemote || push.ref !== git.sourceRemoteRef ||
            push.sourceHeadSha !== planned.labelDiff.sourceHeadSha || push.remoteSha !== planned.labelDiff.sourceHeadSha) throw changed();
      }
      const diff = await repository.readChangeSet(repo);
      if (repo.sourceBranch !== git.sourceBranch || repo.sourceProject?.path !== git.sourceProject.path ||
          diff.sourceHeadSha !== planned.labelDiff.sourceHeadSha ||
          diff.targetRefSha !== planned.labelDiff.targetRefSha || diff.mergeBaseSha !== planned.labelDiff.mergeBaseSha ||
          canonicalizeJson(diff) !== canonicalizeJson(planned.labelDiff)) throw changed();
      if (confirmed !== null && mrIid !== null) {
        const mr = await planned.options.gitlab.getMergeRequest(snapshot.targetProject.id, mrIid);
        // The initial approval is bound to the pre-write description. Subsequent
        // transaction writes are protected by the transaction's own readback checks.
        if (!mutationStarted && sha256Utf8(mr.description) !== confirmed.descriptionDigest) throw changed();
      }
      const value = await reader.read(planned.options);
      const current = validateExternalContextSnapshot(value.snapshot);
      planned.assertNoCredentialExposure(current);
      if (selection !== null && selection.ids.some((id, index) =>
        !current.labelCandidates.some((label) => label.id === id && label.name === selection.names[index]))) throw changed();
      return value;
    }

    if (invocation.options.dryRun && request !== null) {
      const current = await fresh();
      if (canonicalizeJson(current.binding) !== canonicalizeJson(live.binding)) throw changed();
      const resolved = await resolveRequestCandidates({ request, expectedBinding: live.binding,
        store: readOnly.contextStore, consume: false });
      if (canonicalizeJson(resolved.snapshot) !== canonicalizeJson(snapshot)) throw changed();
      const plan = buildWritePlan({ request, snapshot, resolvedCandidates: resolved.candidates,
        bundle: planned.selection.bundle, labelDiff: planned.labelDiff,
        labelOptions: labelOptionsForProductionInvocation(invocation) });
      const output = { output: { message: "Dry run validated; no remote writes or candidate consumption",
        data: copyJsonValue({ command: command.kind, dryRun: true, mandatoryLabels: selection,
          writePlan: plan, pushPlan: planned.pushPlan }) as JsonObject } };
      planned.assertNoCredentialExposure(output);
      return output;
    }

    if (request !== null && planned.pushPlan.kind !== "up-to-date") {
      throw new ToolError("REPOSITORY_ERROR", "The source branch must match the committed diff on the remote before MR writes", {
        field: "pushPlan", expected: "the remote source branch at the selected source SHA", actual: planned.pushPlan.kind,
        safeNextStep: "Push the branch with manual --push or the displayed push command, then refresh context and retry; API MR commands do not push implicitly.",
      });
    }
    const rawRemote = new GitLabMergeRequestRemote({
      gitlab: planned.options.gitlab,
      targetProject: { id: snapshot.targetProject.id, fullPath: snapshot.targetProject.path },
      snapshotReader: async (mr) => {
        const result = await reader.read({ ...planned.options, operation: "update", mrIid: mr.iid });
        planned.assertNoCredentialExposure(result.snapshot);
        return validateExternalContextSnapshot(result.snapshot);
      },
    });
    const authenticatedRemote: MergeRequestRemote = {
      ...guardedRemote(rawRemote, async () => {}),
      findOpen: async (input) => {
        const found = await rawRemote.findOpen(input);
        if (command.kind === "create" && command.upsert && !mutationStarted && found.value.length === 1) {
          const existing = found.value[0]!;
          const pinned = await loadMrBundle({ current: { iid: existing.iid,
            targetProjectId: existing.targetProjectId, description: existing.description }, source: {
            gitlabOrigin: planned.options.gitlabOrigin, receiptLoader: receiptStore, bundleLoader: historical,
          } });
          if (pinned.bundleManifestHash !== planned.selection.bundleManifestHash || pinned.reference.releaseTag !== planned.selection.releaseTag) {
            throw new ToolError("UPDATE_REQUIRED", "Upsert context is not bound to the existing MR's historical template", {
              field: "contextId", expected: "context issued for the exact historical MR template",
              actual: "create context uses a different template", safeNextStep: "Run context --mr for this MR, then update with its newly issued context; use explicit migration to change templates.",
            });
          }
        }
        return found;
      },
    };
    const remote = guardedRemote(authenticatedRemote, async () => {
      try { await fresh(); mutationStarted = true; } catch { throw new RemoteMutationError("rejected", "conflict", null); }
    });
    const adapter = createMergeRequestCommandAdapter({
      gitlabOrigin: planned.options.gitlabOrigin,
      readCurrentBinding: async () => (await fresh()).binding,
      candidateStore: readOnly.contextStore,
      verifyLiveCandidateIdentities: async ({ candidates }) => {
        const value = await fresh();
        if (!candidatesMatch(validateExternalContextSnapshot(value.snapshot), candidates)) throw changed();
      },
      verificationReceiptWriter: receiptStore, verificationReceiptLoader: receiptStore,
      historicalBundleLoader: historical,
    });
    if (command.kind === "verify") {
      return adapter.verify({ level: command.level, prepare: async () => ({ current: (await rawRemote.read(mrIid!)).value }) });
    }
    let migration: UpdateMergeRequestMigration | undefined;
    if (command.kind === "update" && command.migrateTemplate) {
      const existing = (await rawRemote.read(mrIid!)).value;
      const previous = await loadMrBundle({ current: { iid: existing.iid,
        targetProjectId: existing.targetProjectId, description: existing.description }, source: {
        gitlabOrigin: planned.options.gitlabOrigin, receiptLoader: receiptStore,
        bundleLoader: historical, allowManualDescriptionDrift: true,
      } });
      migration = {
        previousBundle: previous.bundle, previousReleaseTag: previous.reference.releaseTag,
        confirmation: confirmed?.migrationDigest ?? command.confirmation ?? "",
        oldHash: previous.bundleManifestHash, newHash: planned.selection.bundleManifestHash,
      };
      validateUpdateMigration(migration, planned.selection.bundle, planned.selection.releaseTag);
    }
    const base = {
      labelDiff: planned.labelDiff, labelOptions: labelOptionsForProductionInvocation(invocation), request: request!,
      binding: live.binding, bundle: planned.selection.bundle, releaseTag: planned.selection.releaseTag,
      cliVersion: options.cliVersion, sourceBranch: planned.options.git.sourceBranch, remote,
    };
    const result = command.kind === "create"
      ? await adapter.create({ upsert: command.upsert, prepare: async () => ({ ...base, initialSnapshot: snapshot }) })
      : await adapter.update({ forceReplaceDescription: command.forceReplaceDescription,
        prepare: async () => ({ ...base, initial: (await rawRemote.read(mrIid!)).value, ...(migration === undefined ? {} : { migration }) }) });
    planned.assertNoCredentialExposure(result);
    return result;
  }
  return Object.freeze({ create: execute, update: execute, verify: execute });
}

function guardedRemote(remote: MergeRequestRemote, guard: () => Promise<void>): MergeRequestRemote {
  return {
    read: (iid) => remote.read(iid), findOpen: (input) => remote.findOpen(input),
    createDraft: async (input) => { await guard(); return remote.createDraft(input); },
    addLabels: async (iid, ids) => { await guard(); return remote.addLabels(iid, ids); },
    removeLabels: async (iid, ids) => { await guard(); return remote.removeLabels(iid, ids); },
    writeManagedFields: async (iid, input) => { await guard(); return remote.writeManagedFields(iid, input); },
    writeDescription: async (iid, description) => { await guard(); return remote.writeDescription(iid, description); },
    markDraft: async (iid, title) => { await guard(); return remote.markDraft(iid, title); },
    markReady: async (iid, title) => { await guard(); return remote.markReady(iid, title); },
  };
}
