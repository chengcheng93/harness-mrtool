# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

CLI/Plugin 0.1.6 is a release candidate, not yet published. Build the CLI from
current `main` source using the pinned-runtime instructions in the repository's
root README; the plugin does not include a CLI binary. New release download links
will be added only after publication.

CLI 0.1.5 is historical and is not the matching CLI for this candidate; it does
not include the mandatory-label changes:

<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.5>

The current published CLI supports Windows x64. A GitLab token is optional:
the default Skill path is SSH-first and renders a local handoff before the user
creates the MR in the GitLab web UI. The live context and API write path remain
available explicitly with `--auth api`.
When credentials are used, configure them only in the host-scoped environment
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

The default invocation follows this order:

```text
schema/profiles -> structured Request -> manual --auth ssh -> user confirmation -> SSH push
```

The optional API invocation follows this order:

```text
context --auth api -> structured Request -> preview -> user confirmation -> create/update/verify
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
