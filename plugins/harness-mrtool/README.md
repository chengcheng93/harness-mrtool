# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

CLI/Plugin 0.1.8 is a release candidate, not yet published. Build the CLI from
current `main` source using the pinned-runtime instructions in the repository's
root README; the plugin does not include a CLI binary. New release download links
will be added only after publication.

CLI 0.1.5 is historical and is not the matching CLI for this candidate; it does
not include the mandatory-label changes:

<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.5>

The historical published CLI supports Windows x64. The default CLI and Skill
flow uses the GitLab API to create or update an MR and read back its final state.
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
context --auth api -> structured Request -> create/update -> verify -> MR URL
```

A user request to submit or update an MR authorizes the normal write. Validate in
the background, submit directly, verify the stored result, and return the MR URL
without another confirmation. Run preview only when explicitly requested; it is
not a prerequisite for create/update. Ask only for required information that
cannot be established, ambiguous diff classification, or a real blocker.

Preview runs only when explicitly requested.

Missing credentials or API failures stop the flow; never automatically fall back
to SSH or manual handoff. `--auth auto` remains a compatibility alias for API
selection without SSH fallback. Git may still use SSH to push the source branch
before the API flow; Git transport does not select the MR creation mode.
GitLab supports HTTP and HTTPS. Explicit HTTP/HTTPS remotes preserve their scheme;
SSH/scp/git remotes infer HTTP first and try same-host HTTPS when HTTP is unavailable.

MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain in the worktree. The tool
does not automatically add, stash, clean, or delete them.

Use `manual --auth ssh` only after an explicit human request for manual handoff:

```text
schema/profiles -> structured Request -> manual --auth ssh -> user confirmation -> manual --auth ssh --push -> web MR
```

The manual path does not claim a remote MR was created and does not choose live
labels, assignee, or reviewers. `manual --auth ssh --ssh-mr --push` is rejected
with `LABEL_ERROR` before push planning or execution. Use the API flow for
mandatory-label-verified MR creation. An ordinary branch push followed by a
user-created web MR remains outside the tool's label-verification guarantees.

The Skill sends the exact normalized Request over JSON stdin. On verified
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
