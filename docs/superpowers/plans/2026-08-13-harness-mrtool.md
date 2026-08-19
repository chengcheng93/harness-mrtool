# Harness MR Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and fully verify a deterministic, self-contained GitLab MR CLI that implements `HMR-REQ-001` v0.3.0 without imposing a GitLab merge gate.

**Architecture:** A TypeScript domain core owns strict input parsing, Bundle/Profile composition, deterministic rendering, candidate-token resolution, Git/GitLab write planning, and postcondition verification. All external effects sit behind injected ports so unit and fault-injection tests use real domain code with fake GitHub/GitLab servers and local bare Git remotes. Release packaging bundles all JavaScript into one CommonJS entry and injects it into Node 24.16.0 SEA; the executable embeds a signed bootstrap Bundle while newer Bundles live in a signed version cache.

**Tech Stack:** Node.js 24.16.0, TypeScript 5.9.3, esbuild 0.28.2, Node test runner through tsx 4.23.12, Commander 15.0.0, YAML 2.9.0, Ajv 8.20.0, jsonc-parser 3.3.1, json-canonicalize 2.0.0, semver 7.8.5, fflate 0.8.3, postject 1.0.0-alpha.6, Git CLI, GitLab REST/GraphQL APIs.

---

## Repository Map

```text
src/
  app/                 command use cases and transaction orchestration
  contracts/           stable errors, request/output types, schemas
  input/               strict JSON/YAML transports and normalization
  bundle/              signed Bundle loading, registries, profiles
  render/              title, Markdown, JCS marker, projection
  context/             opaque candidate tokens and persisted contexts
  git/                 repository discovery, diff classification, push plan
  gitlab/              REST/GraphQL ports and production adapter
  update/              signed channel, LKG, activation and recovery
  cli/                 argv, wizard, stdout/stderr and exit mapping
  platform/            filesystem, clock, locks, credentials, processes
  main.ts              SEA-compatible single entry
template-bundle/
  layout.md
  policy.yml
  schema.json
  registries/*.json
  profiles/*.yml
schemas/
  request-v1.schema.json
  output-v1.schema.json
skill/harness-mr/
scripts/
test/
  unit/ contract/ golden/ integration/ e2e/ fixtures/
docs/
  requirements/ architecture/ commands/ security/ troubleshooting/
```

The dependency direction is `cli -> app -> domain ports`; adapters implement ports but domain modules never import CLI or concrete HTTP/process implementations.

## Non-Negotiable Design Decisions

1. `contextId` and every candidate token bind host, project, expiry, external snapshot, CLI protocol, and exact release-set/Bundle hash. A later `create` either loads that verified Bundle or returns a context mismatch; it never silently validates with a newer Schema.
2. Each `templates-v*` Release includes `bundle-receipt.envelope.json`, signed by the same Ed25519 trust chain as the channel manifest. An MR marker locates tag/hash; the signed receipt authenticates it. Marker data is never a trust root.
3. Candidate tokens are 256-bit random values. Only SHA-256 token digests are persisted in a mode-0600/user-private context file; raw tokens are returned once to the caller. Resolution is local, locked, TTL-bound, and followed by live GitLab revalidation.
4. GitLab has no MR CAS. Writes use minimal field mutations, pre/post reads, source-SHA checks and explicit residual TOCTOU reporting. The CLI never claims atomic server locking.
5. The Ready transition is the last normal remote write. Unknown outcomes are queried and compensated; unverifiable state returns `PARTIAL_REMOTE_STATE`.
6. Runtime dependencies must be pure JavaScript and statically bundleable. SEA uses one CommonJS entry, `useSnapshot=false`, `useCodeCache=false`, and `execArgvExtension=none`.

## Task 1: Bootstrap, Toolchain Lock and SEA Spike

**Files:**
- Create: `package.json`
- Create: `package-lock.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.editorconfig`
- Create: `scripts/build.mjs`
- Create: `scripts/build-sea.mjs`
- Create: `scripts/test.mjs`
- Create: `sea-config.json`
- Create: `src/main.ts`
- Create: `test/helpers/process.ts`
- Test: `test/contract/sea-smoke.test.ts`

- [ ] **Step 1: Bootstrap only the test toolchain and add the failing SEA smoke contract**

Create the pinned `package.json`, lockfile, TypeScript configuration and `scripts/test.mjs`, then run `npm ci`. These are test/build infrastructure only; do not create `src/main.ts`, `scripts/build.mjs`, `scripts/build-sea.mjs` or an executable yet. The test helper must run an absolute executable path from a newly-created empty temporary working directory and capture exact stdout, stderr and exit code.

```ts
test('built executable is SEA and runs without project files', async () => {
  const result = await runBuiltExe(['self-test', '--output', 'json'], emptyDirectory);
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    code: 'OK',
    sea: true,
    version: '0.1.0-dev'
  });
});
```

- [ ] **Step 2: Run RED and confirm the intended failure**

Run: `npm test -- --test-name-pattern="built executable is SEA"`

Expected: FAIL because `dist/harness-mrtool.exe` does not exist. A test-discovery, TypeScript-loader or fixture error is not the intended RED state and must be fixed before proceeding.

- [ ] **Step 3: Add the minimal self-test entry and SEA build**

```json
{
  "name": "harness-mrtool",
  "version": "0.1.0-dev",
  "private": true,
  "type": "module",
  "engines": { "node": "24.16.0" },
  "scripts": {
    "build": "node scripts/build.mjs",
    "build:sea": "node scripts/build-sea.mjs",
    "test": "node scripts/test.mjs",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "ajv": "8.20.0",
    "commander": "15.0.0",
    "fflate": "0.8.3",
    "json-canonicalize": "2.0.0",
    "jsonc-parser": "3.3.1",
    "semver": "7.8.5",
    "yaml": "2.9.0"
  },
  "devDependencies": {
    "@types/node": "24.13.3",
    "@types/semver": "7.7.1",
    "esbuild": "0.28.2",
    "postject": "1.0.0-alpha.6",
    "tsx": "4.23.12",
    "typescript": "5.9.3"
  }
}
```

`scripts/test.mjs` must discover `*.test.ts` files itself and pass explicit paths plus any caller filters to the Node test runner, so PowerShell glob behavior cannot change the suite. `build-sea.mjs` must bundle `src/main.ts` to one CJS file, generate the SEA blob with the running Node 24.16.0, copy that exact `process.execPath`, inject with the pinned local `postject`, and execute `self-test`. It must fail when the Node version differs. No application dependency may be externalized from the esbuild CJS bundle.

- [ ] **Step 4: Run GREEN and baseline checks**

Run, stopping immediately if any command fails:

```powershell
npm run typecheck
npm run build:sea
npm test
.\dist\harness-mrtool.exe self-test --output json
```

Expected: typecheck PASS, tests PASS, EXE exits 0 with `sea:true`.

- [ ] **Step 5: Commit**

```powershell
git add package.json package-lock.json tsconfig.json .gitignore .editorconfig scripts sea-config.json src/main.ts test/contract/sea-smoke.test.ts
git commit -m "build: bootstrap node sea toolchain"
```

## Task 2: Stable Contracts, Errors and Canonical JSON

**Files:**
- Create: `src/contracts/errors.ts`
- Create: `src/contracts/output.ts`
- Create: `src/contracts/request.ts`
- Create: `src/contracts/exit-codes.ts`
- Create: `src/contracts/jcs.ts`
- Create: `schemas/output-v1.schema.json`
- Test: `test/unit/contracts.test.ts`

- [ ] **Step 1: Write table-driven failing tests**

```ts
for (const [code, expected] of [
  ['INPUT_ERROR', 2], ['AUTH_ERROR', 3], ['GITLAB_ERROR', 4],
  ['UPDATE_SECURITY_ERROR', 5], ['PARTIAL_REMOTE_STATE', 6], ['INTERNAL_ERROR', 7]
] as const) {
  test(`${code} maps to exit ${expected}`, () => {
    assert.equal(exitCodeFor(code), expected);
  });
}

test('JCS is independent of object insertion order', () => {
  assert.equal(canonicalize({ b: 2, a: 1 }), canonicalize({ a: 1, b: 2 }));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern="maps to exit|JCS"`

Expected: FAIL with missing modules.

- [ ] **Step 3: Implement stable discriminated contracts**

```ts
export type ErrorCode =
  | 'UPDATE_CHECK_WARNING' | 'UPDATE_SECURITY_ERROR' | 'UPDATE_REQUIRED'
  | 'REPOSITORY_ERROR' | 'AUTH_ERROR' | 'PROFILE_REQUIRED'
  | 'TEMPLATE_ERROR' | 'POLICY_ERROR' | 'LABEL_ERROR' | 'INPUT_ERROR'
  | 'INPUT_TOO_LARGE' | 'RENDER_ERROR' | 'GITLAB_ERROR'
  | 'CONCURRENT_UPDATE' | 'MANUAL_DESCRIPTION_CHANGE' | 'UNMANAGED_MR'
  | 'POSTCONDITION_ERROR' | 'PARTIAL_DRAFT' | 'PARTIAL_REMOTE_STATE'
  | 'INTERNAL_ERROR';
```

Use `json-canonicalize` for RFC 8785 and SHA-256 helpers over exact UTF-8 bytes. Output constructors must always include `ok`, `code`, `message`, version tuple, update state, validation details and remote-write status without serializing `undefined` inconsistently.

- [ ] **Step 4: Run GREEN**

Run separately: `npm run typecheck`, then `npm test -- test/unit/contracts.test.ts`.

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/contracts schemas/output-v1.schema.json test/unit/contracts.test.ts
git commit -m "feat: define stable cli contracts"
```

## Task 3: Strict Input Transports and Request Schema

**Files:**
- Create: `schemas/request-v1.schema.json`
- Create: `src/input/strict-json.ts`
- Create: `src/input/strict-yaml.ts`
- Create: `src/input/load-input.ts`
- Create: `src/input/normalize.ts`
- Test: `test/unit/input.test.ts`
- Test: `test/fixtures/requests/code-docs.json`
- Test: `test/fixtures/requests/code-docs.yml`

- [ ] **Step 1: Write failing parser and equivalence tests**

```ts
test('rejects duplicate JSON keys', () => {
  assert.throws(() => parseStrictJson('{"title":1,"title":2}'), /duplicate/i);
});

test('rejects YAML aliases, tags and multiple documents', () => {
  for (const raw of ['a: &x 1\nb: *x', 'a: !custom value', 'a: 1\n---\nb: 2']) {
    assert.throws(() => parseStrictYaml(raw));
  }
});

test('equivalent YAML and JSON normalize identically', async () => {
  assert.deepEqual(await loadFixture('code-docs.yml'), await loadFixture('code-docs.json'));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/unit/input.test.ts`

Expected: FAIL because strict parsers do not exist.

- [ ] **Step 3: Implement strict parsing and Ajv validation**

Use `jsonc-parser` visitor events to reject duplicate keys before `JSON.parse`. Use `yaml.parseAllDocuments` with `uniqueKeys:true`, then walk AST nodes to reject aliases and non-core/custom tags. Reject files over 2 MiB before decode, require UTF-8, and never prompt in non-interactive mode. Normalize arrays, line endings and absent optional values without altering user text.

- [ ] **Step 4: Run GREEN plus malformed corpus**

Run separately: `npm run typecheck`, then `npm test -- test/unit/input.test.ts`.

Expected: PASS for JSON/YAML files and stdin fixtures; all malformed fixtures rejected with `INPUT_ERROR` or `INPUT_TOO_LARGE`.

- [ ] **Step 5: Commit**

```powershell
git add schemas/request-v1.schema.json src/input test/unit/input.test.ts test/fixtures/requests
git commit -m "feat: add strict structured input"
```

## Task 4: Template Bundle, Registries and Profile Composition

**Files:**
- Create: `template-bundle/layout.md`
- Create: `template-bundle/policy.yml`
- Create: `template-bundle/schema.json`
- Create: `template-bundle/registries/checkboxes.json`
- Create: `template-bundle/registries/fields.json`
- Create: `template-bundle/profiles/{code,docs,ops,general}.yml`
- Create: `src/bundle/types.ts`
- Create: `src/bundle/load.ts`
- Create: `src/bundle/validate.ts`
- Create: `src/bundle/compose.ts`
- Create: `src/bundle/detect-profile.ts`
- Test: `test/unit/bundle.test.ts`

- [ ] **Step 1: Write failing Bundle invariants**

```ts
test('Bundle has exactly eight ordered H2 headings', async () => {
  const bundle = await loadBundle(fixtureBundlePath);
  assert.deepEqual(bundle.layout.h2, REQUIRED_H2);
});

test('every allowed profile combination composes without registry conflict', () => {
  for (const ids of [['code'], ['docs'], ['ops'], ['code','docs'], ['code','ops'], ['docs','ops'], ['code','docs','ops']]) {
    assert.doesNotThrow(() => composeProfiles(bundle, ids));
  }
});

test('known plus unknown diff is ambiguous', () => {
  assert.equal(detectProfiles(['src/a.ts', 'vendor/data.bin']).kind, 'ambiguous');
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/unit/bundle.test.ts`

Expected: FAIL because Bundle files/loaders are absent.

- [ ] **Step 3: Implement one central registry and exhaustive composer**

Copy the exact English eight-section contract and stable IDs from HMR-REQ-001. Bundle validation must reject a ninth H2, unknown IDs, duplicate order, type/cardinality redefinition, conflicting requirements and invalid lifecycle label names. Auto detection classifies the merge-base-to-HEAD committed diff; any unknown item produces `PROFILE_REQUIRED` non-interactively.

- [ ] **Step 4: Run GREEN and publish-time validation**

Run separately: `npm test -- test/unit/bundle.test.ts`, `npm run build`, then `node dist/main.cjs internal validate-bundle template-bundle`.

Expected: PASS and a deterministic Bundle manifest/hash.

- [ ] **Step 5: Commit**

```powershell
git add template-bundle src/bundle test/unit/bundle.test.ts
git commit -m "feat: add versioned mr template bundle"
```

## Task 5: Deterministic Renderer, Marker and Web Projection

**Files:**
- Create: `src/render/title.ts`
- Create: `src/render/markdown.ts`
- Create: `src/render/marker.ts`
- Create: `src/render/project-template.ts`
- Test: `test/golden/render.test.ts`
- Test: `test/golden/fixtures/*.md`

- [ ] **Step 1: Write failing golden and injection tests**

```ts
test('code+docs render matches the canonical golden', () => {
  assert.equal(renderDescription(request, snapshot, bundle), readGolden('code-docs.md'));
});

test('user content cannot inject an H2 or diagnostic marker', () => {
  assert.throws(() => renderDescription(withSummary('x\n## 9. Surprise\n<!-- harness-mrtool:v1 bad -->'), snapshot, bundle));
});

test('render digest excludes its own marker', () => {
  const output = renderDescription(request, snapshot, bundle);
  assert.equal(verifyMarker(output).renderedDigest, digestWithoutMarker(output));
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/golden/render.test.ts`

Expected: FAIL with missing renderer.

- [ ] **Step 3: Implement deterministic rendering**

Render fixed English labels only from registries; preserve UTF-8 user text; enforce typed categorical/evidence/derived states; implement canonical `Closes`/`Related`/none; render all empty optional fields as `None.`; sort Profile slots by registry order. Marker metadata uses JCS and separately hashes normalized Request, snapshot (excluding self-produced fields), desired WritePlan and LF-normalized body without marker.

- [ ] **Step 4: Run GREEN and repeatability loop**

Run: `npm test -- test/golden/render.test.ts`

Then render the same fixture 100 times and assert one SHA-256.

Expected: PASS with byte-identical output.

- [ ] **Step 5: Commit**

```powershell
git add src/render test/golden
git commit -m "feat: render deterministic merge requests"
```

## Task 6: Persisted Context and Opaque Candidate Tokens

**Files:**
- Create: `src/context/types.ts`
- Create: `src/context/store.ts`
- Create: `src/context/tokens.ts`
- Create: `src/platform/state-path.ts`
- Test: `test/unit/context-store.test.ts`

- [ ] **Step 1: Write failing persistence/security tests**

```ts
test('raw candidate token is never persisted', async () => {
  const issued = await store.issue(context, candidate);
  assert.equal((await fs.readFile(store.path, 'utf8')).includes(issued.token), false);
});

test('token is bound to context, host, project, kind and 30 minute TTL', async () => {
  const issued = await store.issue(context, candidate);
  await assert.rejects(store.resolve(issued.token, wrongProject), /scope/i);
  clock.advance('PT31M');
  await assert.rejects(store.resolve(issued.token, context), /expired/i);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/unit/context-store.test.ts`

Expected: FAIL with missing store.

- [ ] **Step 3: Implement locked atomic store**

Persist only token digest and candidate metadata in an atomic user-private file. The context record pins the signed release-set/Bundle hash and ExternalContextSnapshot digest. Implement cleanup, one-time optional use, TTL checks, lock timeout and corruption quarantine. Windows ACL verification belongs in the platform adapter; POSIX uses mode `0600`.

- [ ] **Step 4: Run GREEN including concurrent processes**

Run: `npm test -- test/unit/context-store.test.ts`

Expected: PASS for concurrent issuance/resolution without lost records.

- [ ] **Step 5: Commit**

```powershell
git add src/context src/platform/state-path.ts test/unit/context-store.test.ts
git commit -m "feat: persist scoped candidate contexts"
```

## Task 7: Git Repository Discovery, ChangeSet and Push Planning

**Files:**
- Create: `src/git/runner.ts`
- Create: `src/git/repository.ts`
- Create: `src/git/change-set.ts`
- Create: `src/git/push-plan.ts`
- Test: `test/integration/git.test.ts`
- Create: `test/helpers/git-fixture.ts`

- [ ] **Step 1: Write failing local bare-remote scenarios**

```ts
test('non-interactive create requires --push for an absent source ref', async () => {
  const plan = await repo.planPush({ allowPush: false });
  assert.equal(plan.kind, 'confirmation-required');
});

test('diverged source never produces a force push plan', async () => {
  await fixture.divergeLocalAndRemote();
  await assert.rejects(repo.planPush({ allowPush: true }), /diverged/i);
  assert.equal(fixture.commands.includes('push --force'), false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/git.test.ts`

Expected: FAIL with missing Git adapter.

- [ ] **Step 3: Implement argument-array Git execution**

Never invoke a shell string. Discover root/remotes/host/source/target/HEAD, require a clean worktree for side effects, compute merge-base committed diff with rename/delete/submodule metadata, and classify using the pinned Bundle. Push only the selected branch with a normal fast-forward command and re-read remote SHA.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/integration/git.test.ts`

Expected: PASS for absent, equal, behind, ahead, diverged and protected/rejected push fixtures.

- [ ] **Step 5: Commit**

```powershell
git add src/git test/integration/git.test.ts test/helpers/git-fixture.ts
git commit -m "feat: add safe git repository planning"
```

## Task 8: GitLab HTTP/GraphQL Adapter and Context Discovery

**Files:**
- Create: `src/gitlab/types.ts`
- Create: `src/gitlab/http.ts`
- Create: `src/gitlab/client.ts`
- Create: `src/gitlab/queries.ts`
- Create: `src/app/get-context.ts`
- Test: `test/contract/gitlab-client.test.ts`
- Create: `test/helpers/fake-gitlab.ts`

- [ ] **Step 1: Write failing pagination and identity tests**

```ts
test('reads every project and ancestor-group label page and filters archived labels', async () => {
  fakeGitLab.labelsAcrossThreePages();
  const context = await getContext(deps);
  assert.deepEqual(context.labels.map(x => x.name), ['priority::p1', 'status::doing', 'type::bug', 'week::2026-w32-0803-0809']);
});

test('doctor rejects a GitLab that cannot mutate labels by global ID', async () => {
  fakeGitLab.disableMergeRequestSetLabels();
  await assert.rejects(client.probeCapabilities(), /label id mutation/i);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/gitlab-client.test.ts`

Expected: FAIL with missing client.

- [ ] **Step 3: Implement authenticated, redacted API calls**

Use REST for project, Issue, MR, member, pipeline and discussion reads; use GraphQL for global label IDs and `mergeRequestSetLabels` ADD/REMOVE. Follow pagination headers/cursors, preserve project/group type, apply project-over-group same-name policy, reject ambiguity/archived values, and expose request IDs without headers/tokens. `doctor` probes actual server capability and version.

- [ ] **Step 4: Run GREEN and request-shape snapshots**

Run: `npm test -- test/contract/gitlab-client.test.ts`

Expected: PASS; snapshots contain no token and no label-create endpoint.

- [ ] **Step 5: Commit**

```powershell
git add src/gitlab src/app/get-context.ts test/contract/gitlab-client.test.ts test/helpers/fake-gitlab.ts
git commit -m "feat: discover live gitlab context"
```

## Task 9: WritePlan, Draft/Ready Transaction and Verification

**Files:**
- Create: `src/app/write-plan.ts`
- Create: `src/app/create-mr.ts`
- Create: `src/app/update-mr.ts`
- Create: `src/app/verify-mr.ts`
- Create: `src/app/compensate.ts`
- Test: `test/integration/mr-transaction.test.ts`

- [ ] **Step 1: Write failing fault-injection state-machine tests**

```ts
test('Ready is the final normal write', async () => {
  await createMr(readyRequest, deps);
  assert.deepEqual(fakeGitLab.writeKinds().slice(-1), ['mark-ready']);
});

test('unknown Ready outcome is queried and compensated when inconsistent', async () => {
  fakeGitLab.timeoutAfterApplyingReadyWithMismatch();
  const result = await createMr(readyRequest, deps);
  assert.equal(result.code, 'PARTIAL_REMOTE_STATE');
  assert.equal(fakeGitLab.currentMr.draft, true);
  assert.deepEqual(fakeGitLab.currentMr.labels.status, 'status::doing');
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/mr-transaction.test.ts`

Expected: FAIL with missing use cases.

- [ ] **Step 3: Implement the explicit state machine**

Create provisional Draft, set minimal label ADD/REMOVE and personnel/options, read snapshot, write final description from desired plan, verify structure, set Ready status, then make Ready the last normal write and perform only readback. Implement failure journal, Draft compensation, unknown-outcome recovery, unmanaged/manual-description rejection, Policy-outside label preservation, source SHA checks and `structure|ready|merge` read-only verification.

- [ ] **Step 4: Run GREEN across every injected failure point**

Run: `npm test -- test/integration/mr-transaction.test.ts`

Expected: PASS with one test per remote write and readback failure; no test creates a label, merges, deletes a branch, or force pushes.

- [ ] **Step 5: Commit**

```powershell
git add src/app test/integration/mr-transaction.test.ts
git commit -m "feat: orchestrate verified merge requests"
```

## Task 10: CLI Commands, Wizard and Machine Output

**Files:**
- Create: `src/cli/program.ts`
- Create: `src/cli/options.ts`
- Create: `src/cli/wizard.ts`
- Create: `src/cli/output.ts`
- Create: `src/cli/commands/*.ts`
- Modify: `src/main.ts`
- Test: `test/contract/cli.test.ts`

- [ ] **Step 1: Write failing subprocess contracts**

```ts
test('JSON mode writes one JSON document to stdout and logs only to stderr', async () => {
  const run = await cli(['context', '--output', 'json', '--offline']);
  assert.doesNotThrow(() => JSON.parse(run.stdout));
  assert.equal(run.stdout.trim().split('\n').length, 1);
});

test('non-interactive missing fields exits 2 without reading the console', async () => {
  const run = await cli(['create', '--non-interactive', '--input', incompleteFixture]);
  assert.equal(run.exitCode, 2);
  assert.equal(run.stderr.includes('prompt'), false);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/cli.test.ts`

Expected: FAIL because commands are absent.

- [ ] **Step 3: Implement every V1 command**

Implement `doctor`, `context`, `create`, `update`, `verify`, `preview`, `schema show`, `profiles list/detect`, `labels list`, `template show/refresh/export`, `self-update check/status/apply/rollback`, `skill install/activate/status`, `version`, plus internal `self-test/apply-update`. Long interactive text uses a secure temp YAML opened in `$VISUAL`/`$EDITOR`; checkbox/labels use enumerated prompts. Token and full content never appear in argv.

- [ ] **Step 4: Run GREEN for transports and exit mapping**

Run: `npm test -- test/contract/cli.test.ts`

Expected: PASS for interactive harness, YAML/JSON file, YAML/JSON stdin, `--dry-run`, `--push`, `--offline`, `--no-update`, stdout/stderr and exit 0/2..7.

- [ ] **Step 5: Commit**

```powershell
git add src/cli src/main.ts test/contract/cli.test.ts
git commit -m "feat: expose deterministic cli workflows"
```

## Task 11: Signed Channel, Historical Bundle Receipts and LKG

**Files:**
- Create: `src/update/envelope.ts`
- Create: `src/update/manifest.ts`
- Create: `src/update/compatibility.ts`
- Create: `src/update/http.ts`
- Create: `src/update/cache.ts`
- Create: `src/update/bundle-receipt.ts`
- Test: `test/unit/update-manifest.test.ts`
- Test: `test/helpers/signing.ts`

- [ ] **Step 1: Write failing signature-before-parse tests**

```ts
test('rejects a bad signature before reporting malformed payload JSON', () => {
  const malformedPayloadWithBadSignature = makeEnvelope('{not-json', INVALID_SIGNATURE);
  assert.throws(
    () => verifyEnvelope(malformedPayloadWithBadSignature, trustedKeys),
    (error: unknown) => isToolError(error, 'UPDATE_SECURITY_ERROR', /signature/i)
  );
});

test('historical Bundle requires a trusted signed receipt, not marker hash alone', async () => {
  await assert.rejects(loadHistoricalBundle(markerOnlyFixture), /signed bundle receipt/i);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/unit/update-manifest.test.ts`

Expected: FAIL with missing updater.

- [ ] **Step 3: Implement trust-chain verification**

Verify exact base64url payload bytes with `node:crypto` Ed25519 before JSON parse; enforce 256 KiB envelope, sequence monotonicity, fixed origin/repo/tag grammar, compatibility tuple, revocation and key rotation. The signed channel carries an append-only `templateHistory` binding each immutable tag to its Bundle manifest and receipt payload digest. Historical Bundle receipts contain tag, Bundle manifest hash, every file hash/size, schema versions and signing sequence; a single fail-closed API verifies the trusted history anchor, receipt, manifest, and all actual file bytes before cache acceptance.

- [ ] **Step 4: Run GREEN with fake clock/server**

Run: `npm test -- test/unit/update-manifest.test.ts`

Expected: PASS for valid/invalid signature, 304, timeout, old sequence, rotation, revoked version, exact rollback, bad hash/size and valid historical receipt.

- [ ] **Step 5: Commit**

```powershell
git add src/update test/unit/update-manifest.test.ts test/helpers/signing.ts
git commit -m "feat: verify signed release channels"
```

## Task 12: Atomic Release-Set Activation and Windows Self-Update

**Files:**
- Create: `src/update/activation.ts`
- Create: `src/update/journal.ts`
- Create: `src/update/download.ts`
- Create: `src/update/invocation-envelope.ts`
- Create: `src/update/windows-helper.ts`
- Create: `src/platform/lock.ts`
- Test: `test/integration/updater.test.ts`

- [ ] **Step 1: Write failing crash/stdio tests**

```ts
test('activation exposes either old or new release tuple, never a mixed tuple', async () => {
  for (const crashPoint of ACTIVATION_CRASH_POINTS) {
    const fs = faultingFs(crashPoint);
    await attemptActivation(fs);
    assert.ok([OLD_TUPLE, NEW_TUPLE].some(x => deepEqual(recover(fs), x)));
  }
});

test('JSON stdin is consumed once and child exit/stdout are forwarded exactly', async () => {
  const result = await runUpdateHandoff('{"schemaVersion":1}');
  assert.equal(result.childReads, 1);
  assert.equal(result.parentStdout, result.childStdout);
  assert.equal(result.parentExit, result.childExit);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/updater.test.ts`

Expected: FAIL with missing activation/journal logic.

- [ ] **Step 3: Implement recoverable activation**

Use one lock, append/replace journal and atomic `active-release-set.json` pointer. Validate archive paths, duplicate entries and symlink escape. Pre-business budgets are 2 seconds manifest and 5 minutes assets; enforce component size caps. On Windows, validated `.new` executes the business invocation, parent forwards stdio/exit, then temporary helper waits for parent exit, rotates canonical EXE/`.old`, commits activation and reports persistence pending on recoverable failure.

- [ ] **Step 4: Run GREEN with process and filesystem fault injection**

Run: `npm test -- test/integration/updater.test.ts`

Expected: PASS for concurrent starts, every crash point, lock timeout, stale staging, failed readiness, rollback/repair, TTY inheritance and piped stdin.

- [ ] **Step 5: Commit**

```powershell
git add src/update src/platform/lock.ts test/integration/updater.test.ts
git commit -m "feat: add recoverable self update"
```

## Task 13: Old Bundle Update and Explicit Migration

**Files:**
- Create: `src/app/load-mr-bundle.ts`
- Create: `src/app/migrate-template.ts`
- Create: `src/bundle/migration.ts`
- Test: `test/integration/template-migration.test.ts`

- [ ] **Step 1: Write failing pin/migration tests**

```ts
test('ordinary update uses the marker Bundle even after stable advances', async () => {
  const context = await contextFromMr(oldMr);
  assert.equal(context.bundle.hash, OLD_SIGNED_BUNDLE_HASH);
});

test('non-interactive migration requires exact old:new hash confirmation', async () => {
  await assert.rejects(migrate(oldMr, { confirmation: 'yes' }), /old.*new.*hash/i);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/integration/template-migration.test.ts`

Expected: FAIL with missing loader/migrator.

- [ ] **Step 3: Implement signed historical loading and lossless mapping**

Load by immutable tag, verify signed receipt and all files, support EOL verification but block unsupported updates, produce old/new Schema, mapped values, missing fields and full Markdown diff. Never guess new required values. Unmanaged or malformed-marker MR returns `UNMANAGED_MR`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/integration/template-migration.test.ts`

Expected: PASS for missing release, bad receipt/hash, EOL, new required field, confirmation mismatch and successful migration.

- [ ] **Step 5: Commit**

```powershell
git add src/app/load-mr-bundle.ts src/app/migrate-template.ts src/bundle/migration.ts test/integration/template-migration.test.ts
git commit -m "feat: pin and migrate template bundles"
```

## Task 14: Standalone Codex Skill and Template Projection

**Files:**
- Create: `skill/harness-mr/SKILL.md`
- Create: `skill/harness-mr/agents/openai.yaml`
- Create: `skill/harness-mr/scripts/bootstrap.ps1`
- Create: `src/app/skill-manager.ts`
- Test: `test/contract/skill.test.ts`
- Test: `test/golden/projection.test.ts`

- [ ] **Step 1: Write failing Skill-boundary tests**

```ts
test('Skill invokes context before any create/update call', async () => {
  const trace = await runSkillScenario('create an MR');
  assert.equal(trace[0].command, 'context');
});

test('staging does not modify the active Skill path', async () => {
  await manager.stage(newSkill);
  assert.equal(await hashTree(activePath), activeHashBefore);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/skill.test.ts test/golden/projection.test.ts`

Expected: FAIL because Skill/manager are absent.

- [ ] **Step 3: Implement thin Skill and explicit activation**

Skill instructions must call `context`, analyze actual diff/test evidence, ask for missing values, call `preview`, then stream JSON to `create/update`, reporting only CLI JSON. It must not duplicate template or labels. Skill updates stage to a non-scanned path and only `skill activate --version --path` changes the user-owned active path; current invocation protocol stays pinned and output says `hostRefreshMayBeRequired:true`.

- [ ] **Step 4: Run GREEN**

Run: `npm test -- test/contract/skill.test.ts test/golden/projection.test.ts`

Expected: PASS; exported Default/Code/Docs/Ops templates have exactly eight H2 and no hard-coded labels.

- [ ] **Step 5: Commit**

```powershell
git add skill src/app/skill-manager.ts test/contract/skill.test.ts test/golden/projection.test.ts
git commit -m "feat: add codex skill integration"
```

## Task 15: Installers, Documentation and GitHub Workflows

**Files:**
- Create: `scripts/install.ps1`
- Create: `scripts/install.sh`
- Create: `scripts/uninstall.ps1`
- Create: `scripts/repair.ps1`
- Create: `.github/workflows/ci.yml`
- Create: `.github/workflows/release-cli.yml`
- Create: `.github/workflows/release-template.yml`
- Create: `.github/workflows/publish-channel.yml`
- Create: `docs/commands/reference.md`
- Create: `docs/security/authentication.md`
- Create: `docs/troubleshooting/update-repair.md`
- Create: `THIRD_PARTY_NOTICES.md`
- Test: `test/contract/release-assets.test.ts`

- [ ] **Step 1: Write failing artifact-contract tests**

```ts
test('release asset contains EXE, checksums, licenses and bootstrap Bundle receipt', async () => {
  const asset = await inspectReleaseZip(buildRelease());
  assertSubset(asset.names, ['harness-mrtool.exe', 'SHA256SUMS', 'LICENSES/Node.txt', 'bundle-receipt.envelope.json']);
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/contract/release-assets.test.ts`

Expected: FAIL with missing release packaging.

- [ ] **Step 3: Implement release pipeline contracts**

CI runs typecheck, unit/contract/golden/integration, SEA smoke and secret scan. Release jobs build with exact Node 24.16.0, inject SEA, optionally Authenticode-sign after injection, calculate final hashes, attest, upload to Draft immutable Release, validate, then publish. Template workflow signs receipt; channel workflow signs Pages envelope after both releases exist. Installer downloads exact tag/asset and verifies pinned hash/signing key; no mutable default-branch script execution.

- [ ] **Step 4: Run local workflow/static checks**

Run separately: `npm test -- test/contract/release-assets.test.ts`, `npm run build:sea`, then `.\dist\harness-mrtool.exe doctor --offline --output json`.

Expected: PASS and unsigned disclosure is explicit when no Authenticode certificate exists.

- [ ] **Step 5: Commit**

```powershell
git add scripts .github docs THIRD_PARTY_NOTICES.md test/contract/release-assets.test.ts
git commit -m "build: add installation and release workflows"
```

## Task 16: Full Fake-Server E2E and Requirement Traceability

**Files:**
- Create: `test/e2e/fake-stack.test.ts`
- Create: `test/helpers/fake-github.ts`
- Create: `docs/verification/requirements-traceability.md`
- Create: `docs/verification/external-gates.md`

- [ ] **Step 1: Write failing end-to-end journeys**

```ts
test('Codex JSON stdin creates a verified Ready MR without creating labels', async () => {
  const result = await runCliAgainstFakeStack(validReadyRequest);
  assert.equal(result.exitCode, 0);
  assert.equal(fakeGitLab.createdLabels.length, 0);
  assert.deepEqual(fakeGitLab.mrHeadings(), REQUIRED_H2);
  assert.equal(fakeGitLab.lastWriteKind, 'mark-ready');
});
```

- [ ] **Step 2: Run RED**

Run: `npm test -- test/e2e/fake-stack.test.ts`

Expected: FAIL until adapters are wired into the production composition root.

- [ ] **Step 3: Wire the real composition root and evidence index**

Run the actual CLI process against local fake GitHub/GitLab HTTP and bare Git. Cover interactive/YAML/JSON, all Profiles/combinations, partial failures, readback mismatch, offline LKG, upgrade/rollback, old Bundle migration, token races and forbidden operations. Map every HMR-REQ-001 AC 1-47 to exact automated test names and external evidence where mocks cannot prove supplier/OS behavior.

- [ ] **Step 4: Run the complete local acceptance suite**

Run separately and stop at the first failure: `npm ci`, `npm run typecheck`, `npm test`, `npm run build:sea`, then `.\dist\harness-mrtool.exe self-test --output json`.

Expected: all local tests PASS, SEA smoke PASS, and traceability has no `Missing` local evidence rows.

- [ ] **Step 5: Commit**

```powershell
git add test/e2e test/helpers/fake-github.ts docs/verification
git commit -m "test: verify complete local mr workflow"
```

## Task 17: Independent Reviews and External Acceptance Gates

**Files:**
- Modify: `docs/verification/requirements-traceability.md`
- Modify: `docs/verification/external-gates.md`
- Modify: `docs/requirements/harness-mrtool-requirements.md`

- [ ] **Step 1: Run independent spec-compliance review**

Provide HMR-REQ-001, this plan, the commit range and traceability matrix to a fresh reviewer. Fix every Critical/Important gap and repeat review until approved.

- [ ] **Step 2: Run independent code-quality/security review**

Review trust boundaries, token persistence, redaction, update parsing order, archive extraction, subprocess arguments, compensation state machine and test quality. Fix and re-review.

- [ ] **Step 3: Run fresh local verification**

Run separately and stop at the first failure: `npm ci`, `npm run typecheck`, `npm test`, `npm run build:sea`, then `.\dist\harness-mrtool.exe self-test --output json`.

Expected: zero failures/warnings except the documented unsigned Windows status.

- [ ] **Step 4: Execute external gates when prerequisites exist**

1. Clean Windows x64 VM without Node/Python/gh/glab: install, create/preview, self-update lock/crash/repair.
2. Isolated real GitLab project: validate API capabilities, group/project/scoped labels, reviewers, pipeline/discussion states, partial failures and no unexpected labels.
3. Public GitHub prerelease after owner/slug/license/key are chosen: immutable CLI/Template/Skill Releases, attestations, Pages conditional manifest, real upgrade/rollback.
4. Real Codex standalone Skill root: bootstrap, stage, explicit activate, current-invocation protocol pin and host refresh behavior.

Do not mark an unavailable external gate passed. Record `Pending external prerequisite` with owner/action instead.

- [ ] **Step 5: Commit final evidence**

```powershell
git add docs/verification docs/requirements/harness-mrtool-requirements.md
git commit -m "docs: record harness mrtool verification"
```

## Plan Self-Review

- Spec coverage: Tasks 1-17 cover all 24 requirement chapters and AC 1-47; external-only evidence is isolated in Task 17 rather than represented by fake tests.
- Placeholder scan: no implementation step delegates an unspecified behavior; retained angle-bracket CLI metavariables are command syntax, not unfinished work.
- Type consistency: `contextId`, `labelCandidateTokens`, `reviewerCandidateTokens`, `assigneeCandidateToken`, `ExternalContextSnapshot`, `WritePlan`, `BundleReceipt`, and stable error codes retain the names defined in HMR-REQ-001.
- Security additions: signed historical Bundle receipt and release-set pinning close the two gaps discovered during architecture review.
