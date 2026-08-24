---
name: harness-mr
description: Build and submit deterministic merge requests through harness-mrtool's structured CLI contract.
---

# Harness MR

This Skill is a thin natural-language adapter. The CLI is the only authority
for schemas, profiles, labels, candidate identity, rendering, Git operations,
and GitLab writes. Do not copy those rules into Skill instructions.

## Invocation

At the beginning of every invocation, keep the loaded Skill version and
protocol fixed. The default path is SSH-first and does not require a GitLab
Token. Start with local Bundle inspection:

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
```

Use the returned JSON Schema and local repository evidence. Ask the user only
for values that the repository cannot establish. Never invent labels, user IDs,
review states, issue data, or template text.

Render the default token-free SSH handoff:

```text
harness-mrtool manual --auth ssh --input - --input-format json --output json
```

Manual SSH mode never calls GitLab and never resolves labels, assignees, or
reviewers. Show the deterministic title, description, target branch, and
`pushPlan`; ask for confirmation before rerunning with `--push`. After the
branch is pushed, the user creates the Merge Request in GitLab and selects
labels, assignee, and reviewers in the web UI.

For an explicit basic Draft MR request through GitLab SSH Push Options, add
`--ssh-mr`. Only create, target, title, description, and optional draft options
are generated. The result is `requested-unverified` until the user checks the
GitLab UI.

Run the read-only preview after constructing the structured Request:

```text
harness-mrtool preview --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Show the user the CLI JSON result and obtain any confirmation required by the
CLI. For a create or update, stream the exact normalized Request through
stdin; never put request contents, candidate tokens, credentials, or long
text in command-line arguments:

```text
harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
harness-mrtool create --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool update <iid> --auth api --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Report only the single CLI JSON document. Preserve its `ok`, `code`, partial
Draft state, transaction audit, `activationRequired`, and
`hostRefreshMayBeRequired` fields without reinterpretation. A failed or
partially completed transaction is not success.

## Updates

If the CLI is absent, use the bundled bootstrap script with an explicit
versioned public HTTPS release and its published SHA-256. The script must not
receive or print credentials. A newer Skill is first staged in the CLI-owned,
non-scanned directory. It becomes active only after the user explicitly runs
`skill activate --version <semver> --path <user-owned-skill-root>`.

Activation does not reload this invocation's instructions. Treat
`hostRefreshMayBeRequired: true` as an honest host-dependent signal; the host
may discover the new Skill later in this session or after a new session.
