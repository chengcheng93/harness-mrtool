# Release closure execution — 2026-09-18

Status: **in progress, not released or installed**. This record continues the full
CLI / Plugin / Skill / Template delivery objective; it does not replace real
platform, publication, host, or GitLab acceptance with local unit tests.

## T00: authoritative baseline

- Source main / remote main: `2c6b681631f9630c0ab7bd4f5d08ec95554406ae`.
- Clean source checkout preserved. Implementation is isolated on branch
  `codex/release-closure-20260918` in a linked worktree.
- Runtime explicitly checked: Node `v24.16.0`, Darwin ARM64; physical TMPDIR.
- Fresh `npm ci`, typecheck, SEA rebuild, full serial suite, strict Darwin
  codesign verification: exit 0.
- Full suite: **1691 tests, 1679 passed, 0 failed, 12 skipped**, 422377.635208 ms.
- All twelve skipped cases are Windows gates on this Darwin host: three
  anchored-writer kernel tests, repository-local git.exe rejection, two Windows
  file-lock cleanup failure tests, PowerShell parsing, native materialization,
  write-through publication, and three Windows private-state/ACL tests. They
  are not counted as passing and remain mandatory on native Windows.
- SEA build has existing esbuild `import.meta` CJS warnings. Successful native
  smoke/receipt checks do not eliminate those warnings or prove notarization.

Evidence filenames retained with the execution task: `baseline-runtime.log`,
`baseline-npm-ci.log`, `baseline-typecheck.log`, `baseline-build-sea.log`,
`baseline-tests.log`, `baseline-codesign.log`.

## T01: Windows evidence, not inferred success

Public GitHub API rechecked on 2026-09-18: current-main CI `35321667582` is
`completed/cancelled`. Portable, macOS and secret-scan jobs succeeded; Windows
was canceled after its 90-minute limit. Annotations identify failures in
reporter contracts, anchored writer, authenticated release snapshot, default
channel, label diff, native store/readiness and process-lock tests. Multiple
file failure markers do not establish independent root causes.

The job-log endpoint returned HTTP 403 without authentication. `gh auth status`
is not logged in. Standard login has been requested; no credential discovery or
workaround is permitted. SSH can read the expected remote main.

Confirmed bounded portability defect: custom reporter contracts pass an absolute
filesystem path to Node's ESM reporter loader. A Windows drive-letter path is
parsed as an unsupported `c:` URL scheme. The correction must use file URLs,
retain failing-child exit-code assertions, and test URL-significant characters.

Label-diff fixture review also found Windows-unrepresentable `*` filenames and
an unnecessary host symlink-creation requirement. These fixtures must preserve
actual committed blob/mode evidence and literal-path ambiguity coverage rather
than skipping the cases or weakening the production classifier.

## Required external gates

- GitHub standard authentication with authorized Actions/Release/Pages access.
- Authorized production signing mechanism and protected receipt/channel inputs;
  their existence is not inferred from workflow secret names.
- Native Windows hosted-runner results for the actual candidate commit.
- Explicit isolated GitLab target and credential mechanism before real MR writes.
- Real installation and host Plugin/Skill refresh/discovery after release gates.

## Remaining work

T01 native closure, T02 installation design/contracts, T03–T07 recoverable
managed installation/default update routing, T08 native bootstrap/old-version
migration, T09 Skill/Plugin integration, T10 current-SHA release gates,
T11–T12 signed publication/channel and real updates, T13 host/GitLab acceptance,
T14 final evidence audit are not complete.

## T01 bounded fixes and post-integration local verification

- Committed fixture portability: `12ce23eeba24d47d7ed10db3f886174ce4097852`.
- Committed reporter import/diagnostic fix: `dbbdcf30fede0f4cacf6513f240c1eceaa61abb6`.
- Both scoped independent reviews passed spec and quality gates; no P0–P2
  findings. A pre-existing optional missing nonempty symlink-diff assertion is
  recorded for a later test-hardening slice, not hidden as native verification.
- Exact Node24.16.0 typecheck → SEA rebuild → full serial suite → Darwin strict
  codesign → git diff --check: exit0.
- Full integrated suite: **1700 tests / 1688 passed / 0 failed / 12 skipped**,
  240593.505167 ms. Same twelve Windows-only cases remain open on this host.
- Reporter URL-loading regressions failed before the fix (including real #/%
  filenames); fixed-enum diagnostics also have recorded RED/GREEN coverage.
- Existing CI is enabled for the exact isolated work branch with read-only
  permissions. The complete serial Windows command and 90-minute limit are
  unchanged; no release tag is created by this checkpoint.
- **T01 remains open until native Windows current-commit evidence is available.**
  No installation, release, active-pointer update or GitLab write occurred.

## Current candidate checkpoint — 2026-09-19

The historical sections above are retained as audit history. The following is
fresh evidence for the current release-closure branch and supersedes earlier
in-progress counts for the candidate code gates; it does **not** change the
overall status from not formally released or installed.

- Branch: `codex/release-closure-20260918`; current commit: `850ad97`
  (`fix: classify native context lock failures`). Exact runtime: Node
  `v24.16.0`, Darwin ARM64, `TMPDIR=/private/var/tmp`.
- Fresh current-tree sequence: `npm run build:sea` exit `0` (known esbuild
  `import.meta`/CJS warnings only); SEA self-test returned
  `{"ok":true,"code":"OK","sea":true,"version":"0.1.6"}`; serial
  `npm test -- --test-concurrency=1` returned **2020 tests / 2005 passed /
  0 failed / 15 skipped**; `git diff --check` exit `0`. The 15 skips are
  platform-conditional native-Windows gates on this Darwin host and are not
  counted as passes.
- Fresh hosted run `35476440174` for SHA
  `850ad978c4e6650c0a4b60e70671ba40519b3d5d` completed `success` on
  2026-09-19. Portable, secret scan, macOS ARM64 native, and all four Windows
  SEA groups succeeded. This is current CI evidence, not formal publication
  evidence.
- The prior Windows group-3 failure was localized by the safe test digest to
  `discovers tokenized live candidates while keeping lifecycle labels derived
  and snapshots tokenless`, which enters the real `CandidateContextStore`
  process identity/lock path. The current change preserves only bounded native
  failure-stage diagnostics; it does not weaken lock, identity, ACL, path, or
  persistence checks.

The mandatory remaining gates are still external and current-state evidence is
required before completion: independent current-SHA review; protected signed
immutable CLI/Template/Skill/Plugin publication; stable channel deployment and
real Darwin/Windows install, upgrade, rollback, repair, and restart recovery;
current Mac PATH plus explicit Skill activation and official Plugin host
installation/refresh/discovery; and an authorized isolated GitLab target for
context, preview, dry-run, create/update/verify/readback and failure-closed
label acceptance. No release tag, signed production asset, real installation,
host activation, or GitLab mutation is claimed by this checkpoint.


## Bounded recovery and deployment follow-up — 2026-09-20

This supersedes statements above that all remaining gates are external. The
candidate is **not ready for formal publication**, even though the earlier
`60ff701` CI completed successfully.

### Changes and fresh evidence

- Darwin recovery now finishes a fully published, authenticated next CLI/marker
  pair across publish-intent, canonical-published, marker-published,
  commit-intent, and already-updated-active boundaries. It revalidates the exact
  policy checkpoint, signed snapshot, journal slot identities, roots, and (until
  active is next) the authenticated predecessor and pinned backup pair. Tests
  recover in a fresh Node process and then verify idempotence. Substituted
  inodes and tampered backups preserve the journal and active pointer.
- Verify the next installed pair before committing the active pointer in the
  normal path. Cleanup accepts already-moved POSIX leaves after success;
  failures preserve journal-owned staged evidence instead of deleting it.
- Windows committed cleanup removes and verifies the descriptor before removing
  the journal. An interrupted cleanup with an absent descriptor can resume only
  after launch ownership and authenticated installed-tuple checks. Legacy
  descriptor-without-journal cases remain fail-closed, not silently deleted.
- The Windows lock contract explicitly separates bounded PowerShell startup
  from the caller contention budget; deterministic tests cover exact timers,
  fragmented/duplicate/missing READY, late LOCKED, exit/close and helper reaping.
  The startup split from `60ff701` is preserved, not reverted.
- Channel workflow adds least-privilege Pages deployment only after published
  immutable envelope readback and byte equality. No re-signing or envelope
  rewriting. Repository Pages was enabled with GitHub Actions as the source;
  this is configuration, **not a deployed signed channel**.
- Exact Node **24.16.0**, Darwin ARM64: typecheck exit 0; combined 11-file scoped
  verification **111 tests / 109 passed / 0 failed / 2 skipped** in 60.659s;
  SEA build exit 0; SEA self-test OK (version 0.1.6); strict codesign verification
  and git diff whitespace check exit 0. The two skipped cases require real
  Windows PowerShell/C#; doubles do not substitute for native evidence. The SEA
  build retains two existing esbuild import.meta/CJS warnings.
- Independent review of the bounded Darwin recovery/cleanup patch found no
  unresolved actionable P1/P2 in that scope after fixing the review's test gap:
  assert the child's durable recovery result before the parent can run recovery.
  Fresh follow-up typecheck and the two delta tests passed (2/2, no skips).
  This is not approval of the remaining partial
  native publication path, nor proof that all T00–T14 gates are complete.

### Still open; do not turn into a release claim

1. Partial native publication recovery, the POSIX interval with no canonical
   executable, and restart-persistent stage/retention cleanup remain code gates.
   The new recovery branch intentionally does not guess at mixed or absent
   canonical pairs. Do not release or install this candidate as completed.
2. Production signing custody is still unidentified. GitHub authentication works,
   but repository secret names currently contain only BUNDLE_RECEIPT_B64 and
   SKILL_BUNDLE_RECEIPT_B64; no CHANNEL_ENVELOPE_B64 is configured. Secret names
   and dates do not prove their values match new component versions. Never
   extract private secret values, replace the production trust root, or
   fabricate a signed production release to bypass this gate.
3. The already-pushed cli/plugin/skill-v0.1.6 and templates-v1.1.0 tags still pin
   `60ff701`. They are not moved or overwritten by this follow-up. There were
   no corresponding candidate Releases at the last authenticated preflight.
   A later corrected release needs a fresh unused version after all code gates.
4. New-SHA native Windows CI, real signed dual-platform installation/update/
   rollback/recovery, host Skill/Plugin activation, and an explicitly identified
   authorized isolated GitLab project remain uncompleted. Broad authorization
   removes repeated permission questions; it does not identify a signing
   service or a GitLab acceptance target.
