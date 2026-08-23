# Command reference

All commands support `--output json` for the machine contract. Text output is
for human workflows and never dumps raw request, context, credential, or
installation-path material.

| Command | Purpose |
| --- | --- |
| `doctor` | Read-only repository, GitLab, Bundle, capability, and update diagnostics. |
| `context` | Resolve a request context; `context --mr <iid>` requires the exact historical Bundle. |
| `preview` | Produce a deterministic write plan without consuming candidates or mutating GitLab. |
| `manual` | Render a token-free local handoff with title, body, and an SSH-compatible push plan; it never creates an MR. |
| `create` | Create or upsert a merge request through the verified transaction path. |
| `update <iid>` | Update an existing merge request with readback and journal evidence. |
| `verify <iid>` | Verify stored merge-request state and historical Bundle evidence. |
| `profiles detect` | Detect profiles from the local committed-diff baseline. |
| `labels list` | Read the live label inventory. |
| `self-update check/status` | Check or inspect a verified release set. |
| `skill install/activate/status` | Stage, explicitly activate, or inspect a standalone Skill. |

`--offline` uses only verified local state. `--no-update` skips network update
work but does not bypass command or trust validation. Tokens and update URLs
are never accepted as command-line options.
