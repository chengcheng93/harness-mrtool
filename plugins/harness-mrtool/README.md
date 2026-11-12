# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

Install a verified, versioned CLI package from the [releases page](https://github.com/chengcheng93/harness-mrtool/releases).
CLI releases provide Windows x64 and macOS ARM64 packages.
The plugin does not include or upgrade the CLI binary; check its installed version separately.
Source/plugin version numbers alone do not confirm that the matching CLI Release is published.
Every new MR requires successful API creation and association of a unified Issue first.

Configure a GitLab token in the host-scoped environment
variables documented by the CLI. Never put a GitLab token in a command line,
plugin file, or prompt.

## Install from the Git marketplace

The repository includes a Codex marketplace entry. With Codex CLI installed,
run:

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref main
codex plugin add harness-mrtool@harness-mrtool
```

Start a new Codex thread after installation so the host discovers the Skill.

## Initialize GitLab immediately after installation

Before reporting the plugin ready, run the bundled Windows
`scripts/setup-gitlab.ps1` with the matching CLI and the exact GitLab origin:

~~~powershell
.\scripts\setup-gitlab.ps1 -Executable <installed-cli> -GitLabHost http://gitlab.example.com
~~~

The wizard checks complete Process/User host-token pairs, prompts for a missing
token with a hidden input, calls the read-only `auth check --output json` command,
and saves Windows User credentials only after API validation passes. Use
`-NonInteractive -CheckOnly` for a check with no prompt or credential write, or
`-Reconfigure` to replace an invalid token. Existing Codex and terminal
processes must restart to inherit saved environment variables.

The standalone Windows installer embeds the same setup and invokes it immediately
after binary installation. If authorization is incomplete it exits nonzero while
keeping the verified CLI. Retry that installer with `-SetupOnly` and the installed
destination; no download is needed. POSIX installers run a real authorization
check and fail clearly with setup instructions when credentials are unavailable.

The plugin bundles a cross-platform `SessionStart` hook for startup/resume/clear.
Users must **review and trust** the hook before Codex runs it. There is **no PostInstall**
event: marketplace registration and plugin asset installation cannot silently
complete authorization. Start a new Codex chat and complete initialization
immediately; do not wait for an MR submission. The hook never prompts, downloads,
saves credentials, or creates an MR. Missing/stale credentials produce setup
guidance; a process that inherited old environment variables must restart.
Set `HARNESS_MRTOOL_EXECUTABLE` to the absolute path of a locally built CLI when
it is outside the standard installation directory. The default POSIX hook uses shell
and the existing Perl/JSON::PP runtime prerequisites; `commandWindows` selects the
Windows PowerShell hook. Missing runtimes produce explicit setup guidance.

See the repository's [initialization guide](../../docs/usage/gitlab-initialization.md)
for commands and platform boundaries.

## Skill flow

The default invocation follows this order (`--auth api` is the CLI default):

```text
schema/profiles -> context --auth api -> Request workItem:new -> create -> creation-response MR URL
```

A user request to submit an MR authorizes the normal write. Validate in the
background, build a rich Request with `workItem: { "relation": "new" }`, and
submit directly. The CLI creates one unified eight-section Issue then the MR,
with labels and personnel in the initial MR POST. After the first POST, there
are no GET, PUT, GraphQL, readback, retry, recovery query, or rollback calls.
Return the creation-response MR URL and describe it as created.

The host AI fills existing motivation/changes/verification/risk/profile text
with the actual problem, scenarios, implementation, test, deployment, rollback,
and acceptance details; no extra template choice or AI call is required.
Issue owner is the API user; phase/due dates use today's Asia/Shanghai date.
TAPD is optional. The CLI automatically selects the nearest active project/ancestor-group milestone with a valid due_date strictly after the frozen Asia/Shanghai submission date (same date: smallest numeric ID), sharing milestone_id across the initial Issue/MR POSTs. No future candidate omits the field with structured no-future-milestone; a read failure stops before writes or ticket consumption. Pending checks stay pending.

Run preview only when explicitly requested. Ask only for required factual
information that cannot be established or a real blocker. On failure, stop
immediately and report any known Issue URL and MR failure or unknown outcome;
do not report success or blindly retry.

Historical managed MRs retain their receipt/Bundle-based update and verification
flow only for an already-existing authenticated MR. New submissions reject
none/closes/related and --upsert before planning or ticket consumption. Explicit
resume can only recover a proven existing IID; it cannot create an MR. New-Issue
mode also rejects resume before writes;
fast-submission markers do not support legacy update, verify, upsert, or resume.

Missing credentials or API failures stop the flow; never automatically fall back
to SSH or manual handoff. `--auth auto` remains a compatibility alias for API
selection without SSH fallback. Git may still use SSH to push the source branch
before the API flow; Git transport does not select the MR creation mode.
GitLab supports HTTP and HTTPS. Explicit HTTP/HTTPS remotes preserve their scheme;
SSH/scp/git remotes infer HTTP first and try same-host HTTPS when HTTP is unavailable.

MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain in the worktree. The tool
does not automatically add, stash, clean, or delete them.

Manual MR creation handoff is disabled for every workItem/auth selection,
including `--push` and `--ssh-mr`, before repository inspection, push planning,
Git push, or network calls. Use Issue-first API create.
`examples/request.json` is a historical rendering fixture, not a new-submission sample.

The Skill sends the exact normalized Request over JSON stdin. On creation-response
success, it returns a concise Markdown MR link with at most one short summary
sentence; raw JSON is shown only on request. On failure or partial writes, it
faithfully reports the CLI status, error code, actual remote state, and relevant
audit and activation fields without claiming success.

## Development layout

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/harness-mr/`: bundled Skill instructions and bootstrap script.
- `scripts/`: optional CLI install, repair, and uninstall helpers.

The distributable artifact is built by the repository's plugin packaging
script and published as `harness-mrtool-codex-plugin.zip`.

On Windows the default Skill uses its bundled `scripts/run-flow.ps1` with system Windows PowerShell 5.1 and the native CLI; no Node, Python or PowerShell 7 is required. Context runs schema/profiles/context once, then create sends the original Request bytes via stdin. The runner returns one JSON with complete `cliResult`, Stopwatch `elapsedMs` and per-step timings. Keep waiting on the same process beyond 30 seconds; a started create without a complete CLI result is unknown and must not be retried. See [detailed workflows](skills/harness-mr/references/workflows.md).
