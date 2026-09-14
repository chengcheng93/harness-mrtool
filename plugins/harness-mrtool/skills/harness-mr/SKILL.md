---
name: harness-mr
description: Use when preparing, creating, updating, or verifying GitLab merge requests through harness-mrtool's structured CLI contract.
---

# Harness MR

This Skill is a thin natural-language adapter. The CLI is the authority for
schemas, profiles, label selection, candidate identity, rendering, Git operations,
and GitLab writes. Do not duplicate its classifier or invent labels, user IDs,
review states, issue data, or template text.

## Start with local evidence

Keep the loaded Skill version and protocol fixed for the invocation. Inspect
the local Bundle before constructing a Request:

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
```

Use the returned schema and repository evidence; ask only for values that cannot
be established. The source runtime pins Node `24.16.0`; native macOS process
locking also requires Perl. This is not a platform-release acceptance claim.

## Choose the submission path

| User intent | Path |
| --- | --- |
| Token-free draft or ordinary branch push | `manual --auth ssh`; not a verified MR |
| Tool-created/updated MR with verified labels | API `context -> preview -> create/update -> verify` |
| Existing managed MR | `context --mr <iid>`, then `update <iid>` with its newly issued context |

Render the default token-free handoff through stdin:

```text
harness-mrtool manual --auth ssh --input - --input-format json --output json
```

Manual mode never calls GitLab or resolves labels, assignees, or reviewers. Show
the title, description, target branch, and push plan; obtain confirmation before
rerunning with `--push`. A branch push or subsequent user-created web MR is not
mrtool-verified. `manual --ssh-mr` returns `LABEL_ERROR` before push planning or
execution, even with `--push`. Do not substitute raw Git push options or API calls
to bypass this refusal. mrtool's guarantees do not govern operations outside it.

## API workflow and mandatory labels

The default production entry wires API create/update/upsert/verify and the
automatic-label wizard. These are working-tree capabilities, not proof of a
published release or live GitLab acceptance. Bundle `1.1.0` uses a fixed 14-label
pool and exactly three final labels: one type, one priority, one lifecycle status.

- Let the CLI classify the canonical actual committed diff and compute its digest.
  A title, branch name, or `--type` hint is not classification confirmation.
- For unknown/ambiguous changes, show the actual diff and obtain explicit user
  type confirmation. Pass `--confirm-label-type <suffix>` together with the CLI's
  `--label-diff-digest <sha256>`; never invent a digest, silently choose `chore`, or
  reuse confirmation after the diff changes. Known conflicting types are rejected.
- Default priority is p2. Only an explicit p0/p1 escalation with a nonblank
  `--priority-reason` may override it. Draft uses doing; Ready uses review.
- Required labels must already exist in project/ancestor-group inventory. Never
  create remote labels. Updates remove extras, including week labels, leaving
  exactly three; do not promise to preserve out-of-pool manual labels.
- Use CLI-issued context/candidate identities for other request selections. Do
  not manufacture label candidate tokens or use them to override automatic labels.

For a new MR, obtain context before preview. For an existing MR, add `--mr <iid>`
to context and use the resulting pinned Bundle and schema. Stream the structured
Request through stdin; never place request contents, candidate tokens, credentials,
or long text in arguments:

```text
harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
harness-mrtool preview --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool create --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Show the preview and obtain required confirmation before writing. Preserve the
exact normalized Request and any diff-bound confirmation for create/update.
Replace create with `update <iid>` for the existing-MR flow; use `verify <iid>` to
check stored MR state. `preview` and API create/update `--dry-run` make zero remote
writes and do not consume candidate contexts; they may still read live data and
are not completed submissions.

`create --upsert` authenticates the existing MR's receipt and historical Bundle.
If that Bundle differs from the create context, follow the CLI's direction to
`context --mr <iid>` plus `update <iid>`, or explicit template migration; never
fall back to the current Bundle. Trusted old signed policies remain readable.
For explicit migration, obtain `context --mr <iid> --migrate-template` and use
`update <iid> --migrate-template --confirm-migration <oldHash>:<newHash>`.
Read the displayed hashes before confirming; do not invent or reuse stale
confirmation. The adapter verifies the previous receipt and exact historical
Bundle. Controlled migration tests are not proof of live acceptance or publication.

Report the single CLI JSON document without rewriting its `ok`, `code`, partial
Draft state, transaction audit, `activationRequired`, or
`hostRefreshMayBeRequired` fields. A failed or partial transaction is not success.

## Updates

If the CLI is absent, use the bundled bootstrap script with an explicit
versioned public HTTPS release and its published SHA-256. The script must not
receive or print credentials. A newer Skill is staged in the CLI-owned,
non-scanned directory; activation requires the user's explicit
`skill activate --version <semver> --path <user-owned-skill-root>`.

Activation does not reload this invocation's instructions. Preserve
`hostRefreshMayBeRequired: true`; discovery may require a new session.
