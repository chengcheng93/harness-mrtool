# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

Install the matching CLI Release first:

<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.4>

The current published CLI supports Windows x64. A GitLab token is optional:
with one, the Skill uses the live context and API write path; without one, it
renders a local manual handoff and leaves MR creation to the GitLab web UI.
When credentials are used, configure them only in the host-scoped environment
variables documented by the CLI. Never put a GitLab token in a command line,
plugin file, or prompt.

## Install from the Git marketplace

The repository includes a Codex marketplace entry. With Codex CLI installed,
run:

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref release-candidate-0.1.0
codex plugin add harness-mrtool@harness-mrtool
```

Start a new Codex thread after installation so the host discovers the Skill.

## Skill flow

Every invocation follows this order:

```text
context -> structured Request -> preview -> user confirmation -> create/update
```

When `context` reports `AUTH_ERROR` or `GITLAB_ERROR`, the Skill switches to:

```text
schema/profiles -> structured Request -> manual -> optional SSH push -> user creates the MR
```

The manual path does not claim a remote MR was created and does not choose
live labels, assignee, or reviewers.

The Skill sends the exact normalized Request over JSON stdin and reports the
CLI's `ok`, `code`, transaction audit, and partial-state fields without
reinterpretation.

## Development layout

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/harness-mr/`: bundled Skill instructions and bootstrap script.
- `scripts/`: optional CLI install, repair, and uninstall helpers.

The distributable artifact is built by the repository's plugin packaging
script and published as `harness-mrtool-codex-plugin.zip`.
