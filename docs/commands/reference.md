# Command reference

All commands support `--output json` for the machine contract. Text output is
for human workflows and never dumps raw request, context, credential, or
installation-path material.

| Command | Purpose |
| --- | --- |
| `auth check [--host <http-or-https-origin>]` | Read-only installation preflight: identity and api scope; without --host, a bound repository also checks project permissions. Independent of branches, diffs, and Template Bundle. |
| `doctor` | Read-only repository, GitLab, Bundle, capability, and update diagnostics. |
| `context` | Resolve real project/group label candidates from the fixed pool; default priority is p2. Existing-MR context requires a trusted exact Bundle. |
| `preview` | Produce a deterministic write plan without consuming candidates or mutating GitLab. |
| `manual` | Disabled for every workItem/auth selection before repository inspection or push; use Issue-first API create. |
| `create` | Must create and link a unified Issue before MR creation; all MR fields enter its initial POST. Old workItem modes and --upsert are rejected. |
| `create --resume <iid> --resume-from <original-request>` | Historical strong transactions only: finish a verified provisional transaction prefix using original private proof and an equivalent fresh `--input` request. Never creates another MR. |
| `update <iid>` | Historical managed MRs only: update an existing merge request with readback and journal evidence. |
| `verify <iid> --level structure` | Historical managed MRs only: verify stored merge-request state and historical Bundle evidence; `ready` and `merge` request additional checks. |
| `profiles detect` | Detect profiles from the local committed-diff baseline. |
| `labels list` | Read the live label inventory. |
| `self-update check/status` | Check or inspect a verified release set. |
| `skill install/activate/status` | Stage, explicitly activate, or inspect a standalone Skill. |

`--auth auto|ssh|api` selects the authentication path. `api` is the default for
the CLI and Codex Skill:
`schema/profiles -> context -> Request workItem:new -> create -> creation-response MR URL`.
A submission request authorizes the normal write; validation runs in the
background without another confirmation. Preview and dry-run are optional
and run only when explicitly requested. `--auth auto` remains a compatibility
selection of API without SSH fallback. Missing credentials or API errors stop
the flow; they do not authorize automatic manual handoff.

Manual MR creation handoff is disabled, including `--push` and `--ssh-mr`.
It stops before repository inspection, push planning, Git push, or network calls.
Git may still use SSH to publish the source branch before the API flow.
`examples/request.json` is a historical rendering fixture, not a new-submission sample.

GitLab supports HTTP and HTTPS. Explicit HTTP/HTTPS remotes preserve their
scheme. SSH/scp/git remotes infer HTTP first, with same-host HTTPS compatibility
fallback when HTTP is unavailable during project discovery.

`--offline` uses only verified local state. `--no-update` skips network update
work but does not bypass command or trust validation. Tokens and update URLs
are never accepted as command-line options.

## Default Issue-first creation

Local schema/profiles -> API context (no Issue lookup) -> rich Request
`workItem: { "relation": "new" }` -> create -> creation-response MR URL.
Omitting workItem also selects new. Every new MR requires successful Issue
creation first. Explicit closes/related/none and `--upsert` are rejected before
planning or ticket consumption; existing historical MRs use `update <iid>`.

Use existing motivation/changes/verification/risk/profile text for complete
problem, reproduction or feature scenarios, implementation, test, deployment,
rollback, and acceptance details. The CLI renders one unified eight-section Issue
without a template choice, extra AI call, or new required Issue fields.
Issue owner is the current API user; phase/due dates are today's Asia/Shanghai
date. TAPD is optional. The CLI automatically selects the nearest active project/ancestor-group milestone with a valid due_date strictly after the frozen Asia/Shanghai submission date (same date: smallest numeric ID), sharing milestone_id across the initial Issue/MR POSTs. No future candidate omits the field with structured no-future-milestone; a read failure stops before writes or ticket consumption. Pending evidence remains pending.

All validation and context resolution precede writes. Then Issue POST is followed
by MR POST; the initial MR POST includes exactly three planned labels and selected
personnel. The Issue uses available type/priority labels only. After the first
POST there are no GET, PUT, GraphQL, readback, retry, query recovery, or rollback
calls. Success means created from the creation response, not verified.
Failure stops immediately and reports any known Issue URL and MR failure or
unknown outcome. Do not blindly retry or run legacy recovery.

Ordinary create rejects upsert; new-Issue mode also rejects resume before writes. Fast-submission MRs use a
separate marker and do not support legacy update, verify, upsert, or resume.

## GitLab initialization

Run `auth check` after installation or connecting a new host, not for the first
time during MR submission. `--host` selects an exact HTTP(S) origin without
credentials, path, query, or fragment, and performs instance-only validation.
Without it, the command selects the repository remote or configured credential
host. Missing authorization is `AUTH_ERROR` with a setup next step. Unknown or
insufficient token scope is not reported as ready. `--offline` and `--auth ssh`
are incompatible with live API validation. The check performs no remote writes.

## Mandatory labels (working tree; Bundle 1.2.0)

The default production services wire API `create`, historical `update`,
and `verify`; the interactive wizard uses the same automatic label selector.
This does not claim a published release or live acceptance. The fixed 13-label
pool and examples are documented in [label selection policy](../usage/label-selection-policy.md).

The final MR has exactly one type, one priority, and one lifecycle status label.
The type uses canonical actual committed-diff evidence bound to source HEAD,
target SHA, and merge-base—not a title, branch name, or caller-provided summary.
Every MR receives `status::review`; projects no longer need a `status::doing`
label. Existing extras, including week labels, are removed rather than
preserved. Required labels must exist in the project/ancestor groups; no
command creates remote labels automatically.

Type selection is automatic: documentation and source-comment-only changes use
`doc`, recognized changes use their detected type, and unknown or ambiguous
changes use `chore`. No type/digest confirmation flags or human approval are
required. The diff digest remains an automatic consistency binding. The ordinary
`--type` title hint cannot override automatic labels. Omitting `--priority` selects
`p2`; `--priority p0|p1` requires a nonblank `--priority-reason`.

## Preview, dry-run, and historical MRs

The legacy recovery/update bullets below apply only to historical managed MRs,
never to new creation or fast-submission markers.

- `preview` and API `create`/`update --dry-run` make zero remote writes: no push
  or GitLab mutation, and no candidate-context consumption. They still validate
  the diff, live inventory, and request; dry-run is not offline or a completed MR.
- `create --upsert` is rejected. Use `context --mr <iid>` and `update <iid>`
  to authenticate an existing historical receipt and exact Bundle.
- `create --resume <iid> --resume-from <original-request>` is separate from upsert.
  Obtain a fresh ordinary create context, select the same candidate identities,
  pass the equivalent request through `--input`. An explicit recovery dry-run verifies
  the provisional MR without consuming candidates. Recovery requires the original
  private context, exact request/description/Bundle/diff identity, and a unique
  matching open MR that GitLab does not mark as work in progress. The description
  must remain exactly the original provisional render. Allowed prefixes are empty
  labels with no assignee/reviewers; the complete planned label set (`type::…`,
  `priority::…`, `status::review`) with no assignee/reviewers; or that same
  complete set with all planned assignee/reviewer selections. Title, target branch,
  squash, and source-removal flags must match the original plan. Partial/extra
  labels, mixed fields, edited or final descriptions are rejected. Half-finished
  MRs left by older tool versions, whose title still carries the old prefix,
  cannot be resumed; continue them with `update <iid>`. The normal transaction
  skips already complete labels and managed fields, then writes the remaining
  steps. It never creates another MR; `verify` only reads stored state and cannot
  recover the transaction. Retained expired contexts are read-only proof for at most
  24 hours after expiry and at most 16 contexts. Expired or consumed tokens remain
  invalid for normal writes. Original diff-bound type/priority options also apply.
- Existing-MR `context --mr <iid>`, `update <iid>`, and `verify <iid>` retain trusted
  historical Bundle/policy evidence. MRs created with Bundle `1.0.0` or `1.1.0`
  can still be read, updated, and verified; old signed policies remain readable
  and are not rewritten or retroactively treated as Bundle `1.2.0`. `update <iid>`
  syncs the three labels, writes the managed fields, writes the final description,
  and reads back. Run once on a half-finished MR left by an older tool version, it
  rewrites the title without the old prefix and applies `status::review`; until
  then such an MR fails `verify` on its labels.
- `update <iid> --migrate-template` is the explicit migration route; its production
  adapter verifies the previous receipt and exact historical Bundle, consumes a
  migration-bound context. The program derives and validates the exact old:new
  Bundle binding automatically; neither TTY nor automation asks for hash entry
  or human approval.
  Controlled integration coverage does not replace live GitLab acceptance.

The initial POST label plan and historical verification guarantees belong to
mrtool's respective workflows; they do not constrain raw Git/API calls or
manual GitLab UI operations.

## Runtime prerequisites

Source/development builds pin Node `24.16.0`. The macOS native process lock
requires Perl for `flock`; release-platform acceptance remains a separate gate.

API MR writes require the source branch to be already published at the selected
commit. If the push plan is missing/behind, review and execute the ordinary Git
push command, then refresh context. API MR commands never push implicitly.
MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain for push, create, and update;
a clean worktree is not required. The tool does not
automatically add, stash, clean, or delete local files.
`--offline` is rejected for live create/update/verify. Manual MR handoff is disabled.

On Windows the default Skill uses its bundled `scripts/run-flow.ps1` with system Windows PowerShell 5.1 and the native CLI; no Node, Python or PowerShell 7 is required. Context runs schema/profiles/context once, then create sends the original Request bytes via stdin. The runner returns one JSON with complete `cliResult`, Stopwatch `elapsedMs` and per-step timings. Keep waiting on the same process beyond 30 seconds; a started create without a complete CLI result is unknown and must not be retried. See [detailed workflows](../../skill/harness-mr/references/workflows.md).
