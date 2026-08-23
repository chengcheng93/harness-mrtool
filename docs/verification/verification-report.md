# Local Verification Report

Date: 2026-08-22  
Repository: `harness-mrtool`  
HEAD: `1ebdea6` (`chore: ignore development worktrees`)

## Scope

This report covers the current working tree and the local ACL, portable
packaging, installer, release workflow, and CI changes. No reset, deletion,
push, GitHub release, or other external publication was performed. The
untracked `probe.zip` file is retained as the installer-audit fixture found in
the working tree.

## Verification Evidence

| Check | Result |
| --- | --- |
| `npm run typecheck` | Pass |
| Unit shard (`test/unit`, serial) | 290 passed, 4 skipped, 0 failed |
| Core contract shard (CLI/GitLab/JSON/release/Skill/test runner) | 131 passed, 0 failed |
| Build contract shard (non-esbuild) | 13 passed, 0 failed |
| Full `test/build` shard | 13 passed, 2 failed at native esbuild application-bundle tests |
| Release contracts | 11 passed, 1 skipped, 0 failed (Windows device-name fixture skipped on Windows) |
| Installer contracts/integration | 8 passed, 0 failed |
| MR transaction integration | 49 passed, 0 failed |
| Template migration integration | 10 passed, 0 failed |
| Updater integration | 14 passed, 0 failed |
| Windows helper recovery integration | 12 passed, 0 failed |
| Windows write-through move integration | 12 passed, 0 failed |
| Slow Git discovery/ChangeSet group (`--test-timeout=180000`) | 9 passed, 0 failed; 173 s |
| ACL/write-through smoke (serial, focused) | 4 passed, 0 failed |
| PowerShell AST for installers/bootstrap | Pass for all four scripts |
| `bash -n scripts/install.sh` | Pass |
| YAML parse for all five workflows | Pass |
| `git diff --check` | Pass (line-ending warning only) |
| ACL probe | Protected directory; rules limited to SYSTEM, Administrators, and current user |

The portable package fixture produced a valid ZIP with the exact five required
entries and a matching release receipt. Release and installer source-contract
tests cover archive bounds, non-empty required assets, checksum handling,
redirect restrictions, marker validation, final standalone/ZIP executable byte
comparison in the CLI workflow, draft-byte comparisons for CLI/Template/Skill
and channel assets, retry-safe run-scoped artifact names, Skill output limits
and Windows device-name rejection, installer archive re-verification,
fixed-entry POSIX extraction, reparse-safe uninstall traversal, and workflow
asset names.

## Local Limitations

`npm run build`, `npm run build:sea`, and the two native-esbuild application
bundle tests fail before producing artifacts because
native esbuild reads the workstation's protected WIP source projection as
non-source bytes (`src/main.ts:1:0`, `Unexpected "\\x17"`). This is an
environment boundary, not a source edit made by this task. The SEA smoke
contracts therefore cannot pass locally without a clean hosted/Windows
checkout. The full serial test command also exceeded the local aggregate
timeout; the unit, contract, build-contract, focused integration, and slow Git
groups above were run separately. The remaining aggregate timeout is not
reported as a passing full-suite result.

The checked-in `install.sh` passes Bash syntax validation and now avoids Bash 4
case-conversion syntax, but it remains a Bash wrapper around the Windows x64
PE asset and uses GNU-style command options. It is not evidence that Linux or
macOS binaries/install/update flows are supported. The release scripts also
perform receipt shape/hash checks only; Ed25519 receipt verification and the
fixed bootstrap trust chain remain production gates.

## External Gates

Still pending outside this workstation: a clean Windows SEA build and smoke
run, production Ed25519 signing roots and signed GitHub Pages channel
publication (including schema and tag/hash binding), cryptographically bound
template/Skill receipt verification, immutable release asset verification,
Linux/macOS binaries and installer fixtures, Windows custom-destination ACL
verification, real GitLab and Codex Skill-host journeys, and any authorized
branch push or release publication. These actions require protected
credentials, hosted runners, or explicit user authorization and were not
attempted. The release plan's illustrative `LICENSES/Node.txt` spelling also
needs owner confirmation against the current canonical `licenses/Node.txt`
asset path before a public release.
