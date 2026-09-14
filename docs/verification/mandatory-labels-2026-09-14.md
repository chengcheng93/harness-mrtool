# Mandatory labels — closure evidence (2026-09-14)

## Scope and baseline

Complete the accepted mandatory-diff-label plan, not a new classification design.
The authoritative checkout is the existing `release-candidate-0.1.0` branch, base
`f1b3d0f0c9be61fd9f79c25b13633093ddf4ea3f`; inherited edits and new files are backed
up in the coordinating task before modification. CLI package remains 0.1.5;
Template Bundle is 1.1.0. These working-tree bytes are not the published 0.1.5 release.

Ruling: continue the explicitly requested existing checkout rather than create a
second worktree — the user asked to take over this dirty implementation, and an
unrelated clean HEAD would lose the accumulated work. No reset/clean or global
runtime replacement. The accepted fixed-three policy removes pool-external MR
labels as well as week labels; it never deletes GitLab label definitions.

## Execution ledger

- [x] Restore task history, protect inherited changes, establish pinned-runtime baseline.
- [x] Independently rerun full baseline: 1105 tests / 1093 pass / 0 fail / 12 skip.
- [x] Independent review: domain diff/label transaction invariants; reproduced issues fixed with regressions.
- [x] Independent review: default production composition, wizard, historical trust; stronger real-Git and signed-history composition tests added.
- [x] Correct stale Windows trust-root regression without weakening private-state checks.
  Portable source commands plus a labeled Windows state-path seam cover laziness;
  empty/substituted production roots remain rejected. Native Windows is not emulated.
- [x] Reconcile migration documentation and mirrored Skill instructions with implemented route.
- [x] Close concrete review findings with failing-then-passing regressions; final independent closure review approved.
- [x] Rebuild application and local SEA with exact Node 24.16.0 after source stabilizes.
- [x] Run full no-exclusion tests, typecheck, diff check, receipt/signature checks.
- [x] Final requirement-by-requirement verdict recorded below; delivery report saved in the coordinating task outputs.

## Requirement evidence map

| Requirement | Primary source | Verification scope |
| --- | --- | --- |
| Fixed 14-label pool; exactly type/priority/status; p2 default; no week | `src/app/label-defaults.ts`, `mandatory-labels.ts`, Bundle policy | `test/unit/label-defaults.test.ts`, `mandatory-labels.test.ts`, `test/integration/mandatory-write-plan.test.ts` |
| True canonical committed diff and bounded classification, no unknown-to-chore fallback | `src/git/change-set.ts`, `src/app/diff-labels.ts` | Real temporary Git repositories in `test/integration/label-diff.test.ts`; classifier cases in `test/unit/diff-labels.test.ts` |
| Digest/SHA-bound explicit confirmation and inventory failures | `src/app/mandatory-labels.ts`, default write services | `test/unit/mandatory-labels.test.ts`, `test/integration/production-default-label-flow.test.ts` |
| Default create/update/upsert, zero-write failure gates and exact readback | `src/production-main.ts`, `src/cli/default-write-services.ts`, transaction adapter | `test/integration/production-default-label-flow.test.ts`, `default-write-services.test.ts`, `mr-transaction.test.ts` |
| Automatic wizard, priority reason, update/migration confirmation | `src/cli/wizard.ts`, `wizard-catalog.ts`, `production-invocation.ts` | `test/unit/wizard.test.ts`, `production-invocation.test.ts`, actual TTY flow in `production-default-label-flow.test.ts` |
| SSH/offline/dry-run do not bypass enforcement | `src/cli/commands/manual.ts`, default write services | Manual/routing contracts plus default-flow zero-write tests |
| Precise authenticated historical Bundle, no substitution | `src/cli/default-historical-bundles.ts`, `src/update/production-historical-source.ts` | Signed fixtures in `default-historical-bundles.test.ts`, `historical-bundle-loader.test.ts`; source transport tests |
| 1.0.0 compatibility and explicit 1.1.0 migration | Bundle validator, migration adapter | `bundle-compatibility.test.ts`, `template-migration.test.ts`, `production-migration-adapter.test.ts` |
| Automatically derived labels in audit and credential guards | Write-plan and transaction adapter | Audit/credential assertions in production write/default-flow tests; final review required |
| Correct template version/hash and immutable historical fixtures | Bundle manifest builder, `template-bundle/bundle-manifest.json` | Builder byte-coherence, version-source, historical-byte tamper tests |
| Documentation and two Skills agree | README, command reference, architecture, policy, mirrored Skills | Text inspection and Skill contract tests |
| Local artifact matches verified source | Build scripts and SEA receipt | Exact runtime build, full SEA smoke, receipt verification, codesign |

A source/test map is not a completion claim: final verdict requires reading each
invariant and the actual assertions, closing findings, and fresh verification.

## Evidence boundaries

- GitLab production-route tests use controlled transports; no live MR has been
  created or updated for this feature. Historical signature verification is tested
  through the real default history loader in the full migration route: explicit
  in-process signing-root/transport seams supply signed old bytes, while validation
  and persistent trust transitions are unchanged. No module-level trusted-loader
  replacement is used. Real network/service availability is not established.
- A local Darwin SEA demonstrates local artifact execution only. It does not
  qualify Windows releases or provide a supported macOS installer.
- Old external-gate records for SSH-first 0.1.5 must not be reused as evidence for
  this mandatory-label change. Signed release/channel publication and real-host
  acceptance remain separate from local implementation/build completion.
- New release signing must use protected release material; do not fabricate or
  bypass signed receipts just to publish 1.1.0 templates.

## Review closure, round 1 (resolved)

| Finding | Decision / implementation | Evidence |
| --- | --- | --- |
| Historical migration route bypasses signature pipeline via module replacement | Accepted; remove module substitution, add lower trust/transport composition seams to shared defaults | New real signed-history route fails before transport wiring, then passes; missing anchor and corrupted policy bytes make zero writes; same context reused after correction; old receipt retained and signed trust anchor persisted |
| Default Git adapter not covered by production route | Accepted; bounded real temporary-Git integration added | Five real Git/client-transport tests pass; copied-workspace mutation to path-only reader makes happy-path and dry-run tests fail |
| New duplicate required label name may pass readback/Ready | Fixed; live unique-name verification before subsequent mutations, Ready and stored/final verification | Failing regressions before fix; 200-test focused domain/production run passes |
| Comment/quoted export example classified feature | Fixed; uncertain comment/string prefixes require confirmation | Comment/template-literal/append-only regressions plus genuine declaration controls pass |
| Bare domain fake remote creates before fresh snapshot | Withdrawn as a production CLI bypass after tracing both caller guards | Default fresh/guardedRemote and command adapter mutation gate reject stale evidence before transport; existing zero-write regressions pass |
| SEA protection compares paths rather than executable identity | Fixed; compare device/inode identity before mutation and fail closed on unusable metadata | Runtime symlink/hardlink/APFS alias rejected without mutation; real copied runtime accepted |
| Darwin lock consumers still skipped | Fixed; enable three predicates and canonicalize fixtures | Darwin writer exclusion, reader ordering, and timeout tests execute in full suite; 71 ancillary tests pass |

The history endpoint override is an explicit in-process dependency only, not a
CLI flag, request field, or environment setting. Its URL still passes canonical
HTTPS validation; signed payloads remain checked against the selected trusted
roots, and immutable/monotonic private state remains real. Production defaults
continue using the source-pinned origin/roots with no caller-supplied overrides.

## Final local verification (source frozen, 2026-09-14)

| Check | Result |
| --- | --- |
| Exact Node | v24.16.0 |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run build:sea` | exit 0; local Darwin ARM64 artifact |
| `npm test -- --test-concurrency=1` | **1142 tests; 1134 pass; 0 fail; 8 skip**, 155.3 seconds; no SEA exclusion |
| Current-source SEA receipt | Matches executable and all tracked build input hashes |
| Strict Darwin codesign verification | exit 0 |
| Original pinned Node executable SHA-256 | Identical before/after build |
| `git diff --check` | exit 0 |

The eight remaining skips are native Windows Git-executable/temporary-cleanup,
PowerShell installer syntax, MoveFileExW publication, and Windows ACL checks.
They are not successes; all three previously skipped Darwin lock tests now run.
The build retains two existing `import.meta`/CJS warnings in source fallback paths;
actual embedded-artifact self-test, output, and renderer smoke contracts pass.

Logs in the coordinating task's `work/closure-2026-09-14/final-*.log` record the
full output. The repository's source/build receipt, not an old task message, is
used to bind this verification to current implementation bytes.

GitHub CLI is not authenticated in the current environment. No Windows CI or
publication was started from this task, and no new immutable release/channel,
real GitLab MR, or host Skill activation is claimed. The accepted implementation
and local build/test scope is separate from those external deployment actions.

## Final verdict

**Accepted local implementation/build/test scope is complete.** Independent final
closure review found no remaining actionable source/test issues. Its independent
runs covered 178 non-SEA tests and 23 mock-only SEA alias tests with zero failures
or skips; scoped source and original runtime hashes remained unchanged.

Every requirement in the evidence map has current implementation and executed
coverage: real diff classification/confirmation, fixed pool/cardinality/defaults,
real inventory, default command composition, fresh pre-mutation guards, exact
readback, automatic wizard, audit/credential checks, SSH/offline/dry-run boundary,
explicit signed historical migration, versioned template bytes, and local builds.
Stronger real-Git connection tests and a signed historical-route test close the
previously weak integration evidence. The original goal was feature delivery and
verification, not automatic publication or mutation of a real user's MR; the
external actions listed above have not been redefined as locally completed gates.

The coordinating task retains red/green logs, review reports, original dirty-tree
backup, final full-suite/build logs and artifact hashes. Preserve the current
branch for review/delivery; no shared-branch merge, push, release, installed CLI
replacement, or Skill activation is part of this local checkpoint.
