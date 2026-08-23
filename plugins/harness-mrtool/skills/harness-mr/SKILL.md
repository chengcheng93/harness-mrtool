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
protocol fixed and run this command before any other executable command:

```text
harness-mrtool context --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

Use the returned JSON Schema, profile detection, diff evidence, test output,
and candidate tokens. Ask the user only for values that the repository and
the returned context cannot establish. Never invent labels, user IDs, review
states, issue data, or template text.

If the context command returns `ok: false` with `code: AUTH_ERROR` or
`code: GITLAB_ERROR`, switch to the local manual handoff path instead of
asking for a token or retrying the API. Read the local schema and profiles:

```text
harness-mrtool schema.show --output json
harness-mrtool profiles.list --output json
```

Construct the same normalized Request from the repository changes and the
user's answers, then render a token-free handoff:

```text
harness-mrtool manual --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Manual mode never calls GitLab and never resolves labels, assignees, or
reviewers. It returns the deterministic title and description plus an SSH
compatible `pushPlan`. Show those values and ask for confirmation before
rerunning the command with `--push`; after the branch is pushed, the user
creates the Merge Request in GitLab and selects labels, assignee, and
reviewers in the web UI. A manual handoff is not a created Merge Request.

Run the read-only preview after constructing the structured Request:

```text
harness-mrtool preview --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Show the user the CLI JSON result and obtain any confirmation required by the
CLI. For a create or update, stream the exact normalized Request through
stdin; never put request contents, candidate tokens, credentials, or long
text in command-line arguments:

```text
harness-mrtool create --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool update <iid> --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
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
