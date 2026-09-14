# Mandatory diff labels implementation plan

Approved user scope: fixed 14 labels; remove week; one type, priority, status; default p2;
CLI selects from actual diff rather than caller title; unknown intent requires explicit
confirmation; every write path must enforce the policy and verify readback.

## Initial evidence / hazards (September 9; historical)
- Source tree includes earlier uncommitted label-default work. Preserve unrelated work.
- The previous path-substring classifier (`fix`, `cache`, `new`) is not credible intent
  evidence and must be replaced, not wired into production as-is.
- An optional `changeSet` argument allows bypass and cannot be the final write contract.
- `production-main.ts` currently registers manual and read-only command services, but no
  concrete API create/update service. The app transaction adapter exists separately.
  End-to-end completion requires verifying and wiring actual executable entry points.
- Existing tests still select week tokens; migrate current-policy fixtures without
  weakening new checks. Historical signed bundles require explicit migration semantics.
- Tests run locally on Node 24.18.0; the release build pins 24.16.0. Do not change that pin
  just to make a local build pass.

## Tasks / verification gates
1. Central fixed pool + type mapping, exact category cardinality; default p2. Tests
   reject names outside the pool, duplicates, missing categories, week, status mismatch.
2. Conservative diff classifier with auditable rules. Tests include path-substring false
   positives, unknown/binary/submodule data, mixed bug + regression test, maintenance,
   docs/tests/build/CI, and ambiguous code. No unknown-to-chore fallback.
3. Read before/after blobs from pinned merge-base/HEAD with isolated Git settings and
   bounded output; bind evidence and explicit ambiguity confirmation to diff identity.
   Test real temporary Git repositories and changed HEAD/target, rename, binary cases.
4. Shared mandatory label resolution at preview/create/update/upsert. Automatically
   select real inventory IDs, normalize title consistently, use p2 unless explicit
   priority choice, fail before any mutation on absent/ambiguous labels. No optional
   production gate; selected tokens alone are not evidence of automatic classification.
5. Wire production executable (not only injected transaction services), wizard and
   noninteractive entry points. SSH must either meet write/readback contract or reject MR
   creation before push; dry-run handoff must not claim verified MR creation.
6. Final readback verifies exact three managed labels and no week. Migrate old week
   selections and fixtures; preserve appropriate unrelated remote metadata explicitly.
7. Update docs/skill copies to describe enforced behavior rather than carry enforcement.
   Rebuild/version the template manifest; verify historical compatibility explicitly.
8. Run typecheck, focused tests, full tests and build with required runtime. Review changes
   against each requirement, including real command-dispatch zero-write tests. No push,
   commit, release, remote label creation or live MR mutation without user authorization.

## Status (September 14, 2026)
Implementation, local full regression, and independent final review are complete for
the accepted feature scope. Historical checkpoints below are superseded. Latest
verified local result: Node 24.16.0; 1142 tests, 1134 pass, 0 fail, 8 skip. Typecheck,
application/SEA builds, diff check, current-source SEA receipt, and Darwin codesign verification pass. This
is not evidence of a new published release, Windows gate, or live GitLab acceptance.

The September 9 hazards/checkpoints are retained as history, not current to-dos.
The completed closure ledger and external-release boundaries are in `docs/verification/mandatory-labels-2026-09-14.md`.

## Checkpoint (September 9, 2026)

Progress, not completion:
- Replaced substring filename heuristics with explicit maintenance surfaces and bounded
  source-content patterns; unknown/unsupported data returns ambiguity. Added real Git
  tests proving committed blobs, before/after fixes, rename, binary, symlink, and size cap.
- Mandatory selector binds source/target/merge-base, emits fixed three names/real IDs,
  defaults p2, requires priority reason and diff-digest-bound type confirmation.
- `BuildWritePlanInputs`, create/update/upsert inputs, preview prepared context and command
  adapter now require `labelDiff` (no optional bypass). Title follows selected type.
  Removed synthetic ID attempt: label IDs come directly from snapshot inventory, user
  candidates remain verified separately.
- Direct transaction checks remove all old labels, producing exactly three. Added
  independent final transaction cardinality/pool check and drift regression.
- CLI parses --confirm-label-type, --label-diff-digest, --priority and --priority-reason;
  preview consumes options. Production create/update options still need composition.
- `manual --ssh-mr` fails before any push planning; ordinary handoff remains unverified.
- Existing contextual label output filters fixed pool. Wizard still prompts old-style
  label selection; needs replacement with automatic/confirmation UI.

Verification:
- `npm run typecheck` passes after mandatory interface/caller fixture migration.
- Focused classifier, Git evidence, mandatory plan, transaction, production adapter,
  preview, routing and manual tests: 167 passed (before the last docs-only edits).
- Transaction suite with independent final-label check: 50 passed.
- Full suite with a canonical TMPDIR: 994 tests, 904 passed, 78 failed (remaining
  entries skipped); not green. Old policy/golden assertions and other failures remain.
- Baseline archived HEAD independently reproduces missing macOS process-lock support
  and obsolete trust-root expectation (60-test subset: 56 pass, 2 fail, 2 skipped).
  Do NOT weaken platform safety/trust checks to conceal them. Default /var temp ancestor
  symlink caused extra platform failures; canonical TMPDIR removed that variable.
- Source tree currently still has version 1.0.0 manifest with changed policy; needs
  deliberate version/migration decision before release, not republishing immutable tag.

Next critical path:
1. Build production API services and wire `production-main.ts` (currently no actual
   create/update service despite an existing tested adapter). Use real session,
   snapshot reader, private receipt store and live candidate/repository revalidation.
   No mocked-only delivery. First add dispatched-command tests for automatic labels,
   empty input labels, missing p2, unknown type, stale diff, write/readback and zero-write.
2. Propagate explicit confirmation/priority options through production create/update;
   remove wizard manual type-label/priority prompts; surface computed result/digest.
3. Revalidate current Git immediately before mutation. Carry immutable evidence in
   prepared fingerprint; map automatically resolved labels into audit/credential checks
   (currently selectedCandidates output still reflects caller tokens, not derived labels).
4. Historical bundle migration + versioned manifest + final receipt verification policy;
   full fixtures/docs cleanup, full suite/build and independent review still pending.

## Checkpoint 2 (September 9, 2026)

- `BuildWritePlan` and transaction callers now ignore caller-supplied label candidates
  for managed labels; the selector owns the three IDs and only user candidates are
  validated from the context. This removes the last practical “AI chose labels” path
  inside the domain write plan.
- Production preview and the tested merge-request adapter pass the bound label diff.
- SSH MR push remains rejected before push planning.
- Focused regression suite: 170 passed, including full transaction suite and changed
  production-readonly/production-write tests; typecheck and `git diff --check` pass.
- Full repository suite remains non-green: 994 tests, 803 pass, 179 fail, largely due
  existing platform/process-lock behavior under this macOS environment and older
  release/cache tests. This is not evidence to mark completion.
- Default executable production create/update handlers are still not composed in
  `production-main.ts`; `createProductionRuntime` currently receives no default
  merge-request command adapter. This remains the main end-to-end gap.
