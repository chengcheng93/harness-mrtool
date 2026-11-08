---
name: harness-mr
description: Use when installing or initializing harness-mrtool GitLab authorization, or preparing, creating, updating, or verifying GitLab merge requests through its structured CLI contract.
---

# Harness MR

This Skill is a thin natural-language adapter. The CLI is the authority for
schemas, profiles, label selection, candidate identity, rendering, Git operations,
and GitLab writes. Do not duplicate its classifier or invent labels, user IDs,
review states, issue data, or template text.

## Initialize GitLab access after installation

After installing the CLI/plugin, or connecting a new GitLab host, run the read-only
initialization check immediately; do not postpone it until MR submission:

```text
harness-mrtool auth check --host <http-or-https-origin> --output json
```

Reuse existing host-bound credentials. On Windows, the plugin's
`scripts/setup-gitlab.ps1` guides configuration with hidden token input, verifies
it before saving, and loads the current user's saved environment for the check.
If configuration is missing, guide this setup immediately; never request a token
in chat, put it in argv, or store it in repository files. A GitLab PAT needs
`api` scope. A browser login or successful Git SSH authentication does not
establish API authorization.

Plugin SessionStart checks run only after the user trusts its hooks. If hooks are
unavailable or untrusted, perform the same initialization explicitly. Report
initialization as incomplete until the check succeeds. An instance-only check
has not established access to a particular project: when binding a repository,
run `harness-mrtool auth check --output json` there to verify project permissions.
These checks do not require a work branch and never submit an MR.

## Start with local evidence

Keep the loaded Skill version and protocol fixed for the invocation. The default
path is API automation for creating, updating, and verifying MRs. Inspect the local
Bundle before constructing a Request:

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
```

Use the returned schema and repository evidence; ask only for values that cannot
be established. The source runtime pins Node `24.16.0`; native macOS process
locking also requires Perl. This is not a platform-release acceptance claim.

MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain; a clean worktree is not
required. Do not automatically add, stash, clean, or delete local files to run
push, create, update, or manual handoff.

Obtain API context before constructing the Request. For an existing managed MR,
add `--mr <iid>` and use the resulting pinned Bundle and schema:

```text
harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

Build the Request only after API context succeeds, using CLI-issued context and
candidate identities together with repository evidence. If API credentials are
missing or API requests fail, stop and explain the API blocker
and required next step. Never automatically fall back to manual mode, SSH MR
creation, or a web handoff. API mode may still use ordinary Git SSH transport for
branch pushes; API authentication controls GitLab MR operations.

GitLab supports HTTP and HTTPS. Explicit HTTP/HTTPS remotes preserve their scheme;
SSH/scp/git remotes infer HTTP first and try same-host HTTPS when HTTP is unavailable.

## API workflow and mandatory labels

The default production entry wires API create/update/upsert/verify and the
automatic-label wizard. These are working-tree capabilities, not proof of a
published release or live GitLab acceptance. Bundle `1.2.0` uses a fixed 13-label
pool and exactly three final labels: one type, one priority, one lifecycle status.

- Let the CLI classify the canonical actual committed diff and compute its digest.
  A title, branch name, or `--type` hint is not classification confirmation.
- For unknown/ambiguous changes, show the actual diff and obtain explicit user
  type confirmation. Pass `--confirm-label-type <suffix>` together with the CLI's
  `--label-diff-digest <sha256>`; never invent a digest, silently choose `chore`, or
  reuse confirmation after the diff changes. Known conflicting types are rejected.
- Default priority is p2. Only an explicit p0/p1 escalation with a nonblank
  `--priority-reason` may override it. Every merge request gets the review
  lifecycle status label.
- Required labels must already exist in project/ancestor-group inventory. Never
  create remote labels. Updates remove extras, including week labels, leaving
  exactly three; do not promise to preserve out-of-pool manual labels.
- Use CLI-issued context/candidate identities for other request selections. Do
  not manufacture label candidate tokens or use them to override automatic labels.

A user request to submit, create, or update an MR authorizes the normal API write.
Run automatic checks and proceed directly to create/update; do not add a preview
or repeat human confirmation for an already authorized submission. Ask only for
required information that cannot be established or an explicit confirmation
required by a genuine blocker, such as unknown/ambiguous diff classification.

Stream the structured Request through stdin; never place request contents,
candidate tokens, credentials, or long text in arguments. Preserve the exact
normalized Request and any diff-bound confirmation. Use exactly one of create
for a new MR or update for an existing MR:

```text
harness-mrtool create --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool update <iid> --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

After create/update succeeds, verify the resulting stored MR state automatically
before reporting completion, then return the verified MR link. Keep routine
checks internal; explain a real blocker or partial failure instead of presenting
it as a completed submission:

```text
harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

Run the read-only preview only when the user explicitly requests it; it is not a
prerequisite for ordinary API create/update. If the user asks to review a preview
before submission, show it and wait for their decision:

```text
harness-mrtool preview --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

`preview` and API create/update `--dry-run` make zero remote writes and do not
consume candidate contexts; they may still read live data and are not completed
submissions.

`create --upsert` authenticates the existing MR's receipt and historical Bundle.
If that Bundle differs from the create context, follow the CLI's direction to
`context --mr <iid>` plus `update <iid>`, or explicit template migration; never
fall back to the current Bundle. Trusted old signed policies remain readable.
For explicit migration, obtain `context --mr <iid> --migrate-template` and use
`update <iid> --migrate-template --confirm-migration <oldHash>:<newHash>`.
Read the displayed hashes before confirming; do not invent or reuse stale
confirmation. The adapter verifies the previous receipt and exact historical
Bundle. Controlled migration tests are not proof of live acceptance or publication.

On verified success, return a concise Markdown MR link, with at most one short
summary sentence. Keep CLI calls on `--output json`; show raw JSON only when the
user explicitly requests it.

On failure or partial write, faithfully report the CLI's `ok`, `code`, actual
remote state, transaction audit, and applicable `activationRequired` or
`hostRefreshMayBeRequired` fields. Do not rewrite these values or present a
failed or partial transaction as success.

## Resume a provisional transaction prefix

If a partial create already produced a merge request (`PARTIAL_WRITE`), preserve
its IID, original Request file, private context proof, and transaction audit.
Stop on the API blocker and resolve it before continuing. Never blindly retry
ordinary create or patch the MR with raw API calls. Either continue with
`update <iid>`, or resume explicitly. Explicit resume requires an open MR, the
exact original provisional description, and one complete transaction prefix:

- No labels and no assignee/reviewers.
- The full planned label set and no assignee/reviewers.
- That same full planned label set and all planned assignee/reviewer selections.

Title, target branch, squash, and source-removal flags must match the original
plan throughout. Partial/extra labels, mixed fields, edited descriptions, and
final descriptions are unsupported, and half-finished MRs left by older tool
versions with a prefixed title cannot be resumed; continue those with
`update <iid>`. Resume skips already complete labels and managed fields;
`verify` reads stored state and does not recover the transaction.

After resolving the blocker, obtain a fresh ordinary create context using the
API context command above without `--mr`. Build a separate fresh Request with
the same committed diff, request meaning, and selected candidate identities.
Carry forward the existing authorization for this unchanged submission and the
same diff-bound confirmation flags for resume and any explicitly requested
preview. Historical private proof is read-only: at most 16 expired contexts
remain for up to 24 hours after expiry; retention never revives expired or
consumed candidate tickets.

Validate explicit resume with `--dry-run`. After it succeeds, repeat the resume
command with `--dry-run` removed, then run structure verification and return the
MR link. Preview remains optional on explicit request; do not ask again for an
unchanged, already authorized submission:

```text
harness-mrtool create --resume <iid> --resume-from <original-request.json> --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input <fresh-request.json> --dry-run --output json
harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

## Explicitly requested SSH manual handoff

Manual mode is disabled by default. Use it only when the human explicitly requests
an SSH manual handoff, with explicit `--auth ssh`:

```text
harness-mrtool manual --auth ssh --input - --input-format json --output json
```

Manual mode never calls GitLab or resolves labels, assignees, or reviewers. Show
the title, description, target branch, and push plan; obtain confirmation before
rerunning with `--push`. A branch push or subsequent user-created web MR is not
mrtool-verified. `--ssh-mr` is disabled and returns `LABEL_ERROR` before push
planning or execution, even with `--push`. Do not substitute raw Git push options
or API calls to bypass this refusal. mrtool's guarantees do not govern operations
outside it.

## Updates

If the CLI is absent, use the verified CLI installer: `scripts/install.ps1` in
the source distribution or `scripts/install-cli.ps1` in the plugin. The bundled
Skill bootstrap manages Skill files only; it does not install the CLI or configure
GitLab access. Complete the authorization initialization above after installing
the CLI. Release bootstrap downloads require an explicit versioned public HTTPS
release and its published SHA-256; bootstrap arguments must not contain credentials. A newer Skill is staged in the CLI-owned,
non-scanned directory; activation requires the user's explicit
`skill activate --version <semver> --path <user-owned-skill-root>`.

Activation does not reload this invocation's instructions. Preserve
`hostRefreshMayBeRequired: true`; discovery may require a new session.
