# GitHub Production Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish every locally executable Task 15-17 deliverable on `feature/production-composition`, prove it through the real CLI against a fake stack, and merge it into the private GitHub baseline only after CI and independent review pass.

**Architecture:** A new injected production runtime composes existing repository, GitLab, transaction, updater, receipt, and Skill ports without moving domain behavior into `src/main.ts`. Focused CLI adapters own command projections, while durable stores and historical loaders preserve trust across processes. Release tooling and fake-stack E2E consume the same production entrypoint used by the SEA executable.

**Tech Stack:** TypeScript 5.9, Node.js 24.16.0, `node:test`, esbuild/Node SEA, GitHub Actions, PowerShell 5.1, POSIX shell, local HTTP fake servers, and bare Git repositories.

---

## File Map

- `src/cli/production-runtime.ts`: dependency-injected production composition root.
- `src/cli/wizard.ts`: TTY-only enumerated input flow and secure editor handoff.
- `src/cli/commands/repository.ts`: doctor, context, profiles, labels, and preview adapters.
- `src/cli/commands/merge-request.ts`: create, update, verify, and migration adapters.
- `src/cli/commands/updater.ts`: template/self-update command adapters.
- `src/cli/commands/skill.ts`: Skill install, activate, and status adapters.
- `src/app/external-context.ts`: pure GitLab snapshot/inventory reads without token issuance.
- `src/app/resolve-candidates.ts`: binding reconstruction, token resolution, and live identity revalidation.
- `src/platform/gitlab-credential.ts`: host-scoped credential provider with fixed redacted failures.
- `src/platform/verification-receipt-store.ts`: atomic private receipt writer/loader.
- `src/update/service.ts`: signed channel, download, cache, activation, and rollback orchestration.
- `src/update/preflight.ts`: every-invocation update policy and bounded handoff.
- `src/update/trust-config.ts`: immutable production/test build trust configuration.
- `src/update/historical-bundle-loader.ts`: exact receipt-anchored historical Bundle loading.
- `src/skill/installation-registry.ts`: private active/staged Skill installation metadata.
- `test/helpers/fake-github.ts`: signed channel/release fake HTTP service.
- `test/helpers/process.ts`: asynchronous real-process runner for live fake servers.
- `test/helpers/pty-process.ts`: pinned ConPTY/PTY real-process test adapter.
- `scripts/build-test-sea.mjs`: isolated compile-time test-trust SEA builder.
- `test/e2e/fake-stack.test.ts`: actual CLI process journeys.
- `test/contract/release-assets.test.ts`: release/archive/workflow/install contract.
- `docs/verification/*.md`: AC 1-47 and external-gate evidence.

## Task 1: Production Runtime And Read-Only Commands

**Files:**
- Create: `src/cli/production-runtime.ts`
- Create: `src/cli/commands/repository.ts`
- Create: `src/app/external-context.ts`
- Create: `src/platform/gitlab-credential.ts`
- Modify: `src/app/get-context.ts`
- Modify: `src/git/repository.ts`
- Modify: `src/main.ts`
- Test: `test/contract/production-runtime.test.ts`
- Test: `test/integration/production-readonly.test.ts`
- Test: `test/integration/git.test.ts`

- [ ] **Step 1: Write the failing production-runtime contract**

```ts
test("production runtime wires every read-only route lazily", async () => {
  const calls: string[] = [];
  const handlers = createProductionRuntime(fakeRuntime({ calls }));
  const invocation = parseCliInvocation(["profiles", "detect", "--output", "json"]);
  if (invocation.command.kind !== "profiles.detect") throw new Error("unexpected route");
  await handlers["profiles.detect"]!({...invocation, command: invocation.command});
  assert.deepEqual(calls, ["repository", "change-set"]);
  assert.equal(calls.includes("credential"), false);
});

test("preview and context perform no GitLab mutation and no source push", async () => {
  const result = await runReadOnlyJourney();
  assert.equal(result.gitlabMutations.length, 0);
  assert.equal(result.pushes.length, 0);
  assert.equal(result.preview.description.match(/^## /gm)?.length, 8);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/production-runtime.test.ts test/integration/production-readonly.test.ts`

Expected: FAIL because `createProductionRuntime` and read-only adapters do not exist.

- [ ] **Step 3: Extract pure snapshot reads and add exact target resolution**

Implement `readExternalContext()` as the side-effect-free portion of `getContext()` and make token issuance an explicit final step. Resolve one target GitLab project, read and pin its `defaultBranch`, then require the corresponding canonical tracking ref. A remote symbolic HEAD, when present, is only an exact consistency check; it is never the production source of the target branch. Ambiguous project/remote mappings or inconsistent refs throw `REPOSITORY_ERROR` without guessing or reflecting rejected values.

```ts
export interface ExternalContextReader {
  read(input: ExternalContextReadInput): Promise<ExternalContextSnapshot>;
}

export interface ProductionRuntimeDependencies {
  readonly cwd: string;
  readonly cliVersion: string;
  readonly currentBundle: TrustedBundleSelection;
  readonly repository: RepositoryRuntime;
  readonly gitlab: GitLabRuntimeFactory;
  readonly contextStore: CandidateContextStore;
}

export function createProductionRuntime(
  dependencies: ProductionRuntimeDependencies,
): CliCommandHandlers;
```

- [ ] **Step 4: Implement read-only handlers and safe projections**

Wire `doctor`, `context`, `profiles.detect`, `labels.list`, and `preview`. Only `context` may return `contextId` and candidate bearer tokens, and only at the output paths already authorized by `src/cli/output.ts`. `preview` resolves without consuming tokens and returns title, description, profile reasons, and push plan while recording zero writes.

- [ ] **Step 5: Run GREEN and regressions**

Run separately:

```powershell
npm test -- test/contract/production-runtime.test.ts
npm test -- test/integration/production-readonly.test.ts
npm test -- test/integration/git.test.ts test/contract/gitlab-client.test.ts
npm run typecheck
```

Expected: all PASS; rejected values and credentials are absent from serialized failures.

- [ ] **Step 6: Commit**

```powershell
git add src/cli/production-runtime.ts src/cli/commands/repository.ts src/app/external-context.ts src/platform/gitlab-credential.ts src/app/get-context.ts src/git/repository.ts src/main.ts test/contract/production-runtime.test.ts test/integration/production-readonly.test.ts test/integration/git.test.ts
git commit -m "feat: wire production read-only commands"
```

## Task 1B: Unified Input Transports And Interactive Wizard

**Files:**
- Create: `src/cli/wizard.ts`
- Modify: `src/cli/input.ts`
- Modify: `src/cli/production-runtime.ts`
- Modify: `src/main.ts`
- Test: `test/contract/cli-input.test.ts`
- Test: `test/integration/production-input.test.ts`

- [ ] **Step 1: Write RED tests for all supported transports**

Cover TTY interactive input, YAML file, JSON file, YAML stdin, and JSON stdin.
Assert a non-TTY invocation without `--input` fails immediately and never reads
stdin. Assert long text uses a private temporary YAML file passed to
`$VISUAL`/`$EDITOR`, never argv, and all modes converge on the same normalized
Request bytes.

- [ ] **Step 2: Implement the wizard and one normalization boundary**

The wizard presents only enumerated profile/label/user candidates, uses the
existing schema normalizer after collection, and never accepts raw labels or
tokens through an editor command line. Interactive update/migration prompts use
exact marker/digest confirmations; automation requires their explicit flags.

- [ ] **Step 3: Run GREEN and commit**

```powershell
npm test -- test/contract/cli-input.test.ts test/integration/production-input.test.ts
npm run typecheck
git add src/cli/wizard.ts src/cli/input.ts src/cli/production-runtime.ts src/main.ts test/contract/cli-input.test.ts test/integration/production-input.test.ts
git commit -m "feat: add unified cli input workflow"
```

## Task 2: Durable Candidate, MR, And Verification Composition

**Files:**
- Create: `src/app/resolve-candidates.ts`
- Create: `src/cli/commands/merge-request.ts`
- Create: `src/platform/verification-receipt-store.ts`
- Create: `src/update/historical-bundle-loader.ts`
- Modify: `src/cli/production-runtime.ts`
- Modify: `src/cli/commands/repository.ts`
- Modify: `src/cli/commands/local.ts`
- Modify: `src/main.ts`
- Test: `test/integration/production-write.test.ts`
- Test: `test/integration/verification-receipt-store.test.ts`
- Test: `test/integration/production-migration.test.ts`

- [ ] **Step 1: Write failing receipt and write-path tests**

```ts
test("create consumes candidates only after every preflight and writes Ready last", async () => {
  const fixture = await productionWriteFixture();
  const result = await fixture.createReady();
  assert.deepEqual(fixture.operations.slice(-2), ["lifecycle-status-ready", "mark-ready"]);
  assert.equal(fixture.createdLabels.length, 0);
  assert.equal(result.transaction.finalState, "ready-proven");
  assert.equal(await fixture.contextCanResolveAgain(), false);
});

test("stored verify rejects a receipt bound to another marker", async () => {
  const fixture = await receiptStoreFixture();
  await fixture.store.stageAuthenticated(fixture.receipt);
  await assert.rejects(
    fixture.store.loadVerified({...fixture.locator, markerDigest: "0".repeat(64)}),
    hasCode("UNMANAGED_MR"),
  );
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/production-write.test.ts test/integration/verification-receipt-store.test.ts test/integration/production-migration.test.ts`

Expected: FAIL because production MR handlers and the concrete receipt store are absent.

- [ ] **Step 3: Implement the private receipt store**

Use `defaultStateDirectory()`, the existing private-directory verifier, bounded single-handle reads, strict canonical JSON, exact locator binding, same-directory temp write, fsync, atomic replace, and corruption quarantine. The public adapter implements both `VerificationReceiptWriter` and `VerificationReceiptLoader`.

```ts
export interface VerificationReceiptStoreOptions {
  readonly stateDirectory: string;
  readonly windowsAclVerifier?: WindowsAclVerifier;
}

export class VerificationReceiptStore
  implements VerificationReceiptWriter, VerificationReceiptLoader {
  stageAuthenticated(receipt: VerificationReceiptV1): Promise<void>;
  loadVerified(locator: VerificationReceiptLocator): Promise<TrustedVerificationReceiptLoad | null>;
}
```

- [ ] **Step 4: Implement candidate resolution and MR handlers**

Reconstruct the exact `ContextBinding`, call `CandidateContextStore.resolve`, re-read label/user identities before the first mutation, and consume tokens only after all repository/Bundle/push/remote preconditions pass. Compose `GitLabMergeRequestRemote`, `createMergeRequest`, `updateMergeRequest`, `migrateTemplate`, and `verifyStoredMergeRequest`; map transaction audit into output-v1 without copying raw request/context tokens.

Wire `context --mr` and `schema show --from-mr` through the same receipt-anchored
historical Bundle loader. A markerless MR, missing receipt, or unavailable exact
Bundle fails closed and never falls back to the current Bundle.

- [ ] **Step 5: Run GREEN and transaction regressions**

Run separately:

```powershell
npm test -- test/integration/verification-receipt-store.test.ts
npm test -- test/integration/production-write.test.ts test/integration/production-migration.test.ts
npm test -- test/integration/mr-transaction.test.ts test/integration/template-migration.test.ts
npm run typecheck
```

Expected: all PASS; `preview` remains zero-write; Ready remains the final normal mutation; receipt staging failure prevents the final description write.

- [ ] **Step 6: Commit**

```powershell
git add src/app/resolve-candidates.ts src/cli/commands/merge-request.ts src/platform/verification-receipt-store.ts src/update/historical-bundle-loader.ts src/cli/production-runtime.ts src/cli/commands/repository.ts src/cli/commands/local.ts src/main.ts test/integration/production-write.test.ts test/integration/verification-receipt-store.test.ts test/integration/production-migration.test.ts
git commit -m "feat: compose durable merge request commands"
```

## Task 3: Signed Updater And Skill Commands

**Files:**
- Create: `src/update/service.ts`
- Create: `src/update/preflight.ts`
- Create: `src/update/trust-config.ts`
- Create: `src/cli/commands/updater.ts`
- Create: `src/cli/commands/skill.ts`
- Create: `src/skill/installation-registry.ts`
- Modify: `src/cli/production-runtime.ts`
- Modify: `src/main.ts`
- Modify: `src/update/invocation-envelope.ts`
- Modify: `scripts/build.mjs`
- Create: `scripts/build-test-sea.mjs`
- Modify: `package.json`
- Modify: `test/helpers/process.ts`
- Test: `test/integration/production-updater.test.ts`
- Test: `test/contract/production-skill.test.ts`

- [ ] **Step 1: Write failing updater/Skill composition tests**

```ts
test("offline update check uses only a previously verified LKG", async () => {
  const fixture = await updaterFixture({ channel: "offline" });
  const result = await fixture.check();
  assert.equal(result.context.update.usingLastKnownGood, true);
  assert.equal(result.context.update.latestVersionConfirmed, false);
});

test("Skill activation is explicit and keeps the invocation pin", async () => {
  const fixture = await skillRuntimeFixture();
  await fixture.install("1.2.3");
  assert.equal((await fixture.status()).installedSkillVersion, null);
  const activated = await fixture.activate("1.2.3");
  assert.equal(activated.hostRefreshMayBeRequired, true);
  assert.equal(fixture.invocationPin.loadedSkillVersion, "1.0.0");
});

for (const command of EVERY_PUBLIC_COMMAND) {
  test(`${command} runs exactly one update preflight`, async () => {
    const result = await invokeWithPreflight(command);
    assert.equal(result.parentPreflightCount, 1);
    assert.equal(result.updateChildPreflightCount, 0);
  });
}

test("piped stdin handoff binds one bounded copy while TTY inherits handles", async () => {
  const piped = await handoffFixture({ transport: "stdin", bytes: readyJson });
  assert.equal(piped.envelope.inputLength, readyJson.byteLength);
  assert.equal(piped.envelope.inputSha256, sha256(readyJson));
  assert.equal(piped.parentStdinReads, 1);
  const tty = await handoffFixture({ transport: "tty" });
  assert.equal(tty.parentStdinReads, 0);
  assert.equal(tty.inheritedConsoleHandles, true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/production-updater.test.ts test/contract/production-skill.test.ts`

Expected: FAIL because updater and Skill production adapters do not exist.

- [ ] **Step 3: Implement the updater service**

The service pins repository, Pages origin, and bootstrap keys from build-time trust configuration; checks the signed channel with the existing total budget; downloads exact assets with size/hash limits; verifies the channel and Bundle receipt; stores one `ReleaseSetSnapshot`; activates through `activateReleaseSet`; and rolls back only through a newer signed manifest sequence. Absence or corruption of production trust throws `UPDATE_SECURITY_ERROR`.

Add one preflight wrapper around every public invocation except the bounded
update child process. A parameterized contract enumerates every public
`CliCommand.kind`, proves exactly one preflight, and proves the update child runs
zero preflights. Cover normal, `--offline`, `--no-update`, verified revocation,
JSON/YAML stdin, and TTY handoff.

For piped `--input -`, read the bounded input exactly once before handoff, write
it to a private temporary file, and bind its byte length and SHA-256 in the
invocation envelope. The child consumes that file and cannot reread parent stdin.
For a TTY wizard, do not pre-read; transfer the console handles directly. Tests
assert the private temp lifecycle, length/hash binding, one stdout document,
stderr forwarding, and exact exit-code propagation for both paths.

A test-only build may compile a loopback origin and fake key with
`scripts/build-test-sea.mjs`. It writes only to a unique `dist/test-sea-*`
directory and emits a visibly test-only receipt; it never overwrites the canonical
release artifact. Release builds reject test configuration, and runtime argv/env
cannot override trust.

- [ ] **Step 4: Implement Skill command composition**

Persist only installation paths and verified component metadata in a private registry. `skill.install` downloads/verifies then stages; `skill.activate` requires exact version/path and invokes `SkillManager.activate`; `skill.status` verifies active and pending state. No command accepts signing keys, update URLs, or credentials from argv.

- [ ] **Step 5: Run GREEN and updater regressions**

Run separately:

```powershell
npm test -- test/integration/production-updater.test.ts
npm test -- test/contract/production-skill.test.ts test/contract/skill.test.ts
npm test -- test/unit/update-manifest.test.ts test/unit/update-cache.test.ts test/integration/updater.test.ts
npm run typecheck
```

Expected: all PASS, including offline LKG, revocation write-block, crash recovery, staged Skill isolation, and explicit activation.

- [ ] **Step 6: Commit**

```powershell
git add src/update/service.ts src/update/preflight.ts src/update/trust-config.ts src/cli/commands/updater.ts src/cli/commands/skill.ts src/skill/installation-registry.ts src/cli/production-runtime.ts src/main.ts src/update/invocation-envelope.ts scripts/build.mjs scripts/build-test-sea.mjs package.json test/helpers/process.ts test/integration/production-updater.test.ts test/contract/production-skill.test.ts
git commit -m "feat: wire signed updater and Skill commands"
```

## Task 4: Installers, Release Contracts, And GitHub Workflows

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/install.sh`
- Create: `scripts/uninstall.ps1`
- Create: `scripts/repair.ps1`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-cli.yml`
- Create: `.github/workflows/release-template.yml`
- Create: `.github/workflows/release-skill.yml`
- Create: `.github/workflows/publish-channel.yml`
- Create: `scripts/package-portable.mjs`
- Create: `README.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `docs/commands/reference.md`
- Create: `docs/security/authentication.md`
- Create: `docs/troubleshooting/update-repair.md`
- Create: `docs/verification/external-gates.md`
- Create: `test/contract/release-assets.test.ts`
- Create: `test/integration/installer.test.ts`
- Modify: `.gitignore`
- Modify: `package.json`

- [ ] **Step 1: Write failing artifact and static workflow tests**

```ts
test("release archive has one executable, checksums, notices, and receipt", async () => {
  const archive = await buildReleaseFixture();
  assert.deepEqual(archive.names, [
    "SHA256SUMS",
    "THIRD_PARTY_NOTICES.md",
    "bundle-receipt.envelope.json",
    "harness-mrtool.exe",
    "licenses/Node.txt",
  ]);
  assert.equal(archive.sha256sumsMatchesFinalBytes(), true);
});

test("workflows never publish before verification", async () => {
  const workflows = await loadReleaseWorkflows();
  assert.equal(workflows.releaseCli.publishDependsOn, "verify-draft-assets");
  assert.equal(workflows.publishChannel.requiresAllImmutableReleases, true);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/release-assets.test.ts`

Expected: FAIL with missing scripts, workflows, notices, and packaging contract.

- [ ] **Step 3: Implement bounded installers and repair paths**

Both installers accept an exact release tag and expected asset hash, download only from the fixed repository, cap bytes, verify SHA-256 before extraction, reject links/traversal/device names, stage on the destination volume, run `self-test`, then atomically publish. PowerShell repair reuses updater recovery; uninstall removes only manager-owned exact paths after verification. `install.sh` installs portable non-Windows assets produced by `scripts/package-portable.mjs` and never claims Windows SEA/Authenticode support. Integration tests use temporary install roots and cover exact success, hash mismatch, traversal/link/device entries, self-test failure, repair, and owned-only uninstall.

- [ ] **Step 4: Implement CI and release workflows**

CI runs `npm ci`, typecheck, portable tests, Windows SEA build/smoke, secret scan, PowerShell AST checks, `bash -n`, and release-contract tests with Node 24.16.0. Release jobs start from a clean checkout and empty `dist`, reject test-mode defines/receipts, build SEA, optionally sign after injection, hash final bytes, create a draft immutable release, attest, verify downloaded draft assets, then publish. Template, Skill, and channel jobs use protected signing secrets and never echo key material. The channel is publishable only after immutable CLI, Template, and Skill releases all exist and their exact receipts/assets verify.

- [ ] **Step 5: Write operator documentation and notices**

Document every public route, JSON/exit contracts, GitLab credential precedence, no-argv token rule, update trust, unsigned Windows status, offline LKG, activation repair, external gate status, and private-baseline limitations. Keep `package.json.private` true until the public licensing/release decision is made.

- [ ] **Step 6: Run GREEN**

Run separately:

```powershell
npm test -- test/contract/release-assets.test.ts
npm test -- test/integration/installer.test.ts
npm run typecheck
powershell -NoProfile -Command "Get-ChildItem scripts -Filter *.ps1 | ForEach-Object { [void][scriptblock]::Create((Get-Content -Raw $_.FullName)) }"
bash -n scripts/install.sh
npm run build:sea
.\dist\harness-mrtool.exe self-test --output json
```

Expected: all available local checks PASS. On a WIP-protected checkout where native esbuild cannot read protected sources, `build:sea` is required to pass in GitHub CI and the local limitation is recorded in `docs/verification/external-gates.md`.

- [ ] **Step 7: Commit**

```powershell
git add scripts .github README.md THIRD_PARTY_NOTICES.md docs/commands docs/security docs/troubleshooting docs/verification/external-gates.md test/contract/release-assets.test.ts test/integration/installer.test.ts .gitignore package.json
git commit -m "build: add installation and release workflows"
```

## Task 5: Real-Process Fake-Stack E2E And Traceability

**Files:**
- Create: `test/helpers/fake-github.ts`
- Create: `test/e2e/fake-stack.test.ts`
- Create: `docs/verification/requirements-traceability.md`
- Modify: `docs/verification/external-gates.md`
- Modify: `test/helpers/fake-gitlab.ts`
- Modify: `test/helpers/process.ts`
- Create: `test/helpers/pty-process.ts`
- Modify: `scripts/build.mjs`
- Modify: `scripts/build-test-sea.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing real-process journeys**

```ts
test("JSON stdin creates and verifies a Ready MR without creating labels", async () => {
  const stack = await startFakeStack();
  const result = await stack.runCli(["create", "--input", "-", "--output", "json"], readyJson);
  assert.equal(result.exitCode, 0);
  assert.equal(stack.gitlab.createdLabels.length, 0);
  assert.deepEqual(stack.gitlab.descriptionHeadings(), REQUIRED_H2);
  assert.equal(stack.gitlab.lastMutation, "mark-ready");
});

test("unknown write followed by unreadable state exits partial with a journal", async () => {
  const stack = await startFakeStack({ fault: "description-write-unknown-read-fails" });
  const result = await stack.runCreate();
  assert.equal(result.exitCode, 6);
  assert.equal(result.output.remoteWrite.state, "unknown");
  assert.equal(result.output.data.transaction.steps.at(-1)?.postRead.outcome, "failed");
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/e2e/fake-stack.test.ts`

Expected: FAIL until the production runtime and fake GitHub service are complete.

- [ ] **Step 3: Implement the stateful fake stack**

Use loopback HTTP only, random free ports, strict request recording, fake signed channel/release assets, the existing GitLab wire contracts, and local bare Git remotes. Spawn the actual source entry and built SEA asynchronously through `test/helpers/process.ts` so the in-process fake servers keep servicing requests; do not call domain functions directly in E2E assertions. Use a pinned ConPTY/PTY adapter in `test/helpers/pty-process.ts` for real interactive journeys on Windows CI; ordinary pipes do not count as TTY evidence.

After the fake stack selects its random port, invoke `scripts/build-test-sea.mjs`
with a private compile-time fixture and run only the isolated test artifact. The
test deletes its directory afterward. A clean release workflow removes all
`dist/test-sea-*` paths, rebuilds from scratch, and rejects any test-mode define or
test-only receipt before publication.

- [ ] **Step 4: Cover the acceptance matrix**

Add separate journeys for TTY interactive input, YAML and JSON files, YAML and JSON stdin, noninteractive missing input, all Profile combinations, ambiguous profile, context expiry/replay, absent/equal/behind source branch, Draft and Ready, update ownership, `context --mr`, `schema show --from-mr`, verification levels, partial/unknown outcomes, readback mismatch, offline LKG, update/apply/rollback, historical Bundle migration, label/user drift, and forbidden label creation/force push/shell invocation.

- [ ] **Step 5: Build AC 1-47 evidence**

For every acceptance criterion, record requirement text, automated test name, command, evidence type, and status. Use only `Automated`, `Manual evidence`, or `Pending external prerequisite`; no local row may remain `Missing`.

- [ ] **Step 6: Run the local acceptance gate**

Run separately and stop on the first failure:

```powershell
npm ci
npm run typecheck
npm run test:node
npm run test:e2e:source
npm run build:sea
npm run test:e2e:sea
.\dist\harness-mrtool.exe self-test --output json
```

Expected: zero CI failures. `doctor --offline` runs inside the prepared fake GitLab repository/credential fixture, not a plain GitHub checkout. On a WIP-protected workstation, `test:node` and source E2E still run; only the two SEA-dependent steps may remain pending with the reproduced policy error. A GitHub Actions Windows runner is the authoritative SEA gate; Linux CI proves portable tests but cannot substitute for the Windows SEA artifact.

- [ ] **Step 7: Commit**

```powershell
git add test/helpers/fake-github.ts test/helpers/fake-gitlab.ts test/helpers/process.ts test/helpers/pty-process.ts test/e2e/fake-stack.test.ts scripts/build.mjs scripts/build-test-sea.mjs package.json docs/verification
git commit -m "test: verify complete local mr workflow"
```

## Task 6: Independent Review, CI, And Merge Evidence

**Files:**
- Modify: `docs/verification/requirements-traceability.md`
- Modify: `docs/verification/external-gates.md`
- Modify: `docs/requirements/harness-mrtool-requirements.md`

- [ ] **Step 1: Push the feature branch and require CI**

Run:

```powershell
git push -u origin feature/production-composition
```

Expected: GitHub Actions CI passes on a clean runner. Keep the repository private and do not publish a Release.

- [ ] **Step 2: Run independent spec-compliance review**

Give the reviewer HMR-REQ-001, both implementation plans, the `main..feature/production-composition` diff, and the traceability matrix. Fix every Critical/Important finding, rerun its focused RED/GREEN test, and repeat review until approved.

- [ ] **Step 3: Run independent security/code-quality review**

Review credential handling, candidate bearer persistence, receipt ownership, marker/Bundle binding, Git endpoint identity, subprocess argv/env, archive extraction, update trust replay, activation/Skill recovery, partial-remote journaling, workflow permissions, and test fault realism. Fix and re-review every P0/P1.

- [ ] **Step 4: Run fresh final verification**

Run separately:

```powershell
npm ci
npm run typecheck
npm run test:node
npm run test:e2e:source
npm run build:sea
npm run test:e2e:sea
.\dist\harness-mrtool.exe self-test --output json
git diff --check main...HEAD
```

Expected: all tests and CI PASS, with only documented platform capability skips.

- [ ] **Step 5: Record external gates honestly**

Record the clean Windows VM, isolated real GitLab, public immutable GitHub prerelease/attestation/Pages, and real Codex Skill host as `Pending external prerequisite` unless executed. Each pending row names the owner, prerequisite, exact command/journey, and acceptance evidence to collect.

- [ ] **Step 6: Commit final evidence**

```powershell
git add docs/verification docs/requirements/harness-mrtool-requirements.md
git commit -m "docs: record harness mrtool verification"
```

- [ ] **Step 7: Re-push and re-verify the exact final SHA**

Push the evidence commit, wait for CI on that exact SHA, and ask both independent
reviewers to confirm the exact final SHA. Any code or evidence change after review
invalidates the gate and requires another push and focused review.

- [ ] **Step 8: Merge through review**

Create a pull request from `feature/production-composition` to `main`, require green CI and approved independent reviews, then merge without rewriting history. Re-run `git ls-remote origin refs/heads/main` and confirm the remote SHA equals the reviewed merge commit.

## Plan Self-Review

- **Spec coverage:** Tasks 1-3 close the production CLI routes; Task 4 closes installers/docs/workflows; Task 5 closes fake-stack E2E and AC 1-47; Task 6 closes review and evidence without fabricating external results.
- **Placeholder scan:** Every implementation step names concrete files, behavior, command, and expected result; no deferred implementation marker remains.
- **Type consistency:** Production handlers return `CliCommandExecution`; MR paths reuse `CandidateContextStore`, `VerificationReceiptWriter/Loader`, `HistoricalBundleLoader`, `MergeRequestRemote`, `TransactionAuditV1`, `UpdateCache`, and `SkillManager` rather than parallel contracts.
- **Security consistency:** Trust roots are build-supplied, credentials are host-scoped, exact historical Bundle/receipt binding is mandatory, updates and Skill activations use existing recovery state machines, and external gates remain pending until proven.
