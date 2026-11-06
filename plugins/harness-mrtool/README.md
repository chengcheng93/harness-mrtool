# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

CLI/Plugin 0.1.7 is a release candidate, not yet published. Build the CLI from
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

## Skill flow

The default invocation follows this order (`--auth api` is the CLI default):

```text
context --auth api -> structured Request -> preview -> user confirmation -> create/update -> verify
```

Missing credentials or API failures stop the flow; never automatically fall back
to SSH or manual handoff. `--auth auto` remains a compatibility alias for API
selection without SSH fallback. Git may still use SSH to push the source branch
before the API flow; Git transport does not select the MR creation mode.

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

The Skill sends the exact normalized Request over JSON stdin and reports the
CLI's `ok`, `code`, transaction audit, and partial-state fields without
reinterpretation.

## Development layout

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/harness-mr/`: bundled Skill instructions and bootstrap script.
- `scripts/`: optional CLI install, repair, and uninstall helpers.

The distributable artifact is built by the repository's plugin packaging
script and published as `harness-mrtool-codex-plugin.zip`.
