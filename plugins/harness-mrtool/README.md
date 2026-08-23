# Harness MR Codex Plugin

This plugin adds the `harness-mr` Skill to Codex. The Skill is a thin adapter;
the `harness-mrtool` CLI remains the authority for GitLab context, schemas,
profiles, rendering, labels, writes, and verification.

## Prerequisites

Install the matching CLI Release first:

<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.0>

The current published CLI supports Windows x64. Configure credentials only in
the host-scoped environment variables documented by the CLI. Do not put a
GitLab token in a command line, plugin file, or prompt.

## Skill flow

Every invocation follows this order:

```text
context -> structured Request -> preview -> user confirmation -> create/update
```

The Skill sends the exact normalized Request over JSON stdin and reports the
CLI's `ok`, `code`, transaction audit, and partial-state fields without
reinterpretation.

## Development layout

- `.codex-plugin/plugin.json`: Codex plugin manifest.
- `skills/harness-mr/`: bundled Skill instructions and bootstrap script.
- `scripts/`: optional CLI install, repair, and uninstall helpers.

The distributable artifact is built by the repository's plugin packaging
script and published as `harness-mrtool-codex-plugin.zip`.
