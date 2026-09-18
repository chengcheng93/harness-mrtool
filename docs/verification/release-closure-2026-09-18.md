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
