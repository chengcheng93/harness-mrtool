# Command reference

All commands support `--output json` for the machine contract. Text output is
for human workflows and never dumps raw request, context, credential, or
installation-path material.

| Command | Purpose |
| --- | --- |
| `doctor` | Read-only repository, GitLab, Bundle, capability, and update diagnostics. |
| `context` | Resolve real project/group label candidates from the fixed pool; default priority is p2. Existing-MR context requires a trusted exact Bundle. |
| `preview` | Produce a deterministic write plan without consuming candidates or mutating GitLab. |
| `manual --auth ssh` | Render a local handoff and ordinary branch push plan only after an explicit human request. `--ssh-mr` is rejected with LABEL_ERROR; no unverified MR creation is allowed. |
| `create` | Create or upsert a merge request through the verified transaction path. |
| `update <iid>` | Update an existing merge request with readback and journal evidence. |
| `verify <iid> --level structure` | Verify stored merge-request state and historical Bundle evidence; `ready` and `merge` request additional checks. |
| `profiles detect` | Detect profiles from the local committed-diff baseline. |
| `labels list` | Read the live label inventory. |
| `self-update check/status` | Check or inspect a verified release set. |
| `skill install/activate/status` | Stage, explicitly activate, or inspect a standalone Skill. |

`--auth auto|ssh|api` selects the authentication path. `api` is the default for
the CLI and Codex Skill: `context -> preview -> create/update -> verify` uses
GitLab credentials and verified readback. `--auth auto` remains a compatibility
selection of API without SSH fallback. Missing credentials or API errors stop
the flow; they do not authorize automatic manual handoff.

Use `manual --auth ssh` only after an explicit human request for manual handoff;
omitting `--auth ssh` does not enable this path. SSH mode rejects API-only
commands. `manual --ssh-mr` is rejected with `LABEL_ERROR` before push planning or
execution for every auth selection, including when `--push` is supplied.
Ordinary manual handoff or branch push is not a verified MR. Git may still use
SSH to publish the source branch before the default API flow.

`--offline` uses only verified local state. `--no-update` skips network update
work but does not bypass command or trust validation. Tokens and update URLs
are never accepted as command-line options.

## Mandatory labels (working tree; Bundle 1.1.0)

The default production services wire API `create`, `create --upsert`, `update`,
and `verify`; the interactive wizard uses the same automatic label selector.
This does not claim a published release or live acceptance. The fixed 14-label
pool and examples are documented in [label selection policy](../usage/label-selection-policy.md).

The final MR has exactly one type, one priority, and one lifecycle status label.
The type uses canonical actual committed-diff evidence bound to source HEAD,
target SHA, and merge-base—not a title, branch name, or caller-provided summary.
Draft uses `status::doing`; Ready uses `status::review`. Existing extras, including
week labels, are removed rather than preserved. Required labels must exist in
the project/ancestor groups; no command creates remote labels automatically.

`create`, `update`, and `preview` accept `--confirm-label-type <suffix>` together
with `--label-diff-digest <sha256>`. Review the actual diff before confirming an
unknown or ambiguous type. Use the digest returned by the CLI; a stale digest or
confirmation conflicting with a known classification is rejected. The ordinary
`--type` title hint is not confirmation. Omitting `--priority` selects `p2`;
`--priority p0|p1` requires a nonblank `--priority-reason`. The wizard presents
automatic labels, requires digest-bound confirmation for ambiguity, and collects
an explicit priority escalation reason when needed.

## Preview, dry-run, and existing MRs

- `preview` and API `create`/`update --dry-run` make zero remote writes: no push
  or GitLab mutation, and no candidate-context consumption. They still validate
  the diff, live inventory, and request; dry-run is not offline or a completed MR.
- `create --upsert` authenticates the existing MR's receipt and exact historical
  Bundle. If it differs from the create context, the current path rejects that
  mismatch and directs the caller to `context --mr <iid>` plus `update <iid>`, or
  explicit template migration. It does not silently substitute the current Bundle.
- Existing-MR `context --mr <iid>`, `update <iid>`, and `verify <iid>` retain trusted
  historical Bundle/policy evidence. Old signed policies remain readable; they
  are not rewritten or retroactively treated as Bundle `1.1.0`.
- `update <iid> --migrate-template` is the explicit migration route; its production
  adapter verifies the previous receipt and exact historical Bundle, consumes a
  migration-bound context, and requires `--confirm-migration <oldHash>:<newHash>`.
  In a TTY, the wizard displays the hashes before accepting confirmation.
  Controlled integration coverage does not replace live GitLab acceptance.

The label guarantee belongs to mrtool's verified transaction path; it does not
constrain raw Git/API calls or manual GitLab UI operations.

## Runtime prerequisites

Source/development builds pin Node `24.16.0`. The macOS native process lock
requires Perl for `flock`; release-platform acceptance remains a separate gate.

API MR writes require the source branch to be already published at the selected
commit. If the push plan is missing/behind, review and execute the ordinary Git
push command, then refresh context. API MR commands never push implicitly.
MR diffs and pushes use committed `HEAD` only. Staged, unstaged, and untracked
files, including `.superpowers` reports, may remain for push, create, update,
and manual handoff; a clean worktree is not required. The tool does not
automatically add, stash, clean, or delete local files.
`--offline` is rejected for live create/update/verify; a local handoff still
requires an explicit human request and `manual --auth ssh`.
