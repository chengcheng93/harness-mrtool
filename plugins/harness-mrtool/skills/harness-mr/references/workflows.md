# Detailed workflows

Read only the section needed for installation/auth, non-Windows direct CLI, explicit preview or historical MR operations. Windows default submission uses ../scripts/run-flow.ps1 as described in ../SKILL.md.

This Skill is a thin natural-language adapter. The CLI is the authority for
schemas, profiles, label selection, candidate identity, rendering, Git operations,
and GitLab writes. Do not duplicate its classifier or invent labels, user IDs,
review states, issue data, or template text.

For Windows runner stdin (`-RequestPath '-'`), invoke `& '<skill-root>/scripts/run-flow.ps1' ... -RequestPath '-'` in an open PowerShell session, or use `powershell.exe -Command "& '<skill-root>/scripts/run-flow.ps1' ... -RequestPath '-'"`; PowerShell 5.1 `powershell.exe -File ... -RequestPath -` rejects the dash during host argument binding before the script starts. Prefer an absolute Request file when using `-File`.

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

Keep the loaded Skill version and protocol fixed for the invocation.

## Non-Windows direct CLI submission

The default path is API automation for a new Issue and MR. Inspect the local
schema and profiles before requesting API context:

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
```

MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain; a clean worktree is not
required. Do not automatically add, stash, clean, or delete local files.
API MR commands do not push: publish the selected source commit first when authorized.
API mode may still use ordinary Git SSH transport for branch pushes.

```text
harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

Build the Request only after API context succeeds, using the returned schema,
CLI-issued context/candidate identities, and repository evidence. Use
`workItem: { "relation": "new" }`; omission also selects a new Issue.
Every new MR requires successful Issue creation first. New submissions reject
`none`, `closes`, `related`, and `--upsert` before planning or ticket consumption.
Do not look up or select an existing Issue for an ordinary submission.
Put the complete problem background, reproduction or feature scenarios,
implementation, impact, test evidence, deployment, rollback, and acceptance
details into the existing motivation/changes/verification/risk/profile text
fields as appropriate. Mark checks that have not run as pending. The CLI renders
one unified eight-section Issue; do not choose a template, request an extra AI
call, or add required Issue fields. Owner is the current API user; phase date
and due date use today's Asia/Shanghai date. TAPD is optional. The CLI automatically selects the nearest active project/ancestor-group milestone with a valid due_date strictly after the frozen Asia/Shanghai submission date, breaking same-date ties by numeric ID; both initial POSTs share milestone_id. No candidate omits the field with no-future-milestone; milestone reads fail before any POST or ticket consumption.

If API credentials are missing or API requests fail, stop and explain the API
blocker and required next step. Never automatically fall back to manual mode,
SSH MR creation, or a web handoff. GitLab supports HTTP and HTTPS. Explicit
HTTP/HTTPS remotes preserve their scheme; SSH/scp/git remotes infer HTTP first
and try same-host HTTPS when HTTP is unavailable.

A user request to submit or create an MR authorizes the normal API write.
Run automatic checks and proceed directly to create; do not add preview,
repeat human confirmation, type/label selection, or hash entry. Ask only for
required factual information that cannot be established. The CLI classifies the
committed diff automatically: documentation/comments use doc, recognized
changes use their detected type, unknown or ambiguous changes use chore.
Default priority is p2; explicit p0/p1 requires a nonblank priority reason.
Required labels must already exist; never create labels. The MR receives exactly
three planned labels and all selected personnel in its initial POST. The Issue
uses available type/priority labels only.

Stream the complete structured Request through JSON stdin; never put request
contents, candidate tokens, credentials, or long text in arguments:

```text
harness-mrtool create --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

The write sequence is Issue POST then MR POST. After the first POST, perform no
GET, PUT, GraphQL, readback, retry, query recovery, or rollback. On success,
return the creation-response MR URL as a concise Markdown link, with at most
one short summary sentence. Say created, not verified. Do not add a separate
verification call. Keep CLI calls on `--output json`; show raw JSON only when the user explicitly requests it.

On failure or partial write, faithfully report the CLI's ok, code, known Issue
URL, MR failure or unknown outcome, remote state, audit, and applicable
activationRequired or hostRefreshMayBeRequired fields. Stop immediately; do not
claim success, retry ordinary create, or recover through legacy commands.

Run the read-only preview only when the user explicitly requests it. Return the
preview without submitting when the request is to preview before submission:

```text
harness-mrtool preview --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

Preview and API dry-run make zero remote writes and do not consume candidate
contexts; they may read live data and are not completed submissions.

## Historical managed MR workflow

This section applies only to already-existing historical managed MRs. Their
`closes`, `related`, or `none` values remain readable and updateable; they do not
authorize new MR creation. Ordinary create rejects upsert; explicit resume
requires proof of the existing IID and can never create. Fast-submission MRs have a
separate marker and do not support legacy update, verify, upsert, or resume.
Do not use this section to recover a fast submission.

For an existing historical MR, obtain `context --mr <iid>`, preserve its exact
trusted Bundle/receipt and original explicit workItem (`closes`, `related`, or
`none`), then update and verify. Do not reuse a new-Issue Request for updates:

```text
harness-mrtool update <iid> --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

Use `context --mr <iid>` and `update <iid>` for an existing historical MR, or
explicitly requested template migration. Never substitute the current Bundle
for a historical one. `create --upsert` is rejected. Migration automatically binds and
verifies old:new hashes; do not ask for human hash entry or repeated approval.
On historical verified success, return the verified MR link.

### Resume a historical provisional transaction prefix

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
same Request meaning and automatic diff binding for resume. Historical private proof is read-only: at most 16 expired contexts
remain for up to 24 hours after expiry; retention never revives expired or
consumed candidate tickets.

Validate explicit resume with `--dry-run`. After it succeeds, repeat the resume
command with `--dry-run` removed, then run structure verification and return the
MR link. Do not ask again for an unchanged, already authorized submission:

```text
harness-mrtool create --resume <iid> --resume-from <original-request.json> --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input <fresh-request.json> --dry-run --output json
harness-mrtool verify <iid> --auth api --level structure --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
```

## Manual creation is disabled

Manual MR creation handoff is disabled for every workItem and auth selection,
including `--push` and `--ssh-mr`. It stops before repository inspection, push
planning, Git push, or network calls. Use API create so the tool first creates
and links an Issue. Do not substitute a web handoff or raw Git push options.
`examples/request.json` is a historical rendering fixture, not a new-submission sample.

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
