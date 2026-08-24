# Authentication and trust

The default submission path is Git SSH: the selected source remote must use an
SSH URL and the host SSH agent or system credential manager performs key
authentication. SSH private keys never enter CLI argv, Request data, logs, or
MR descriptions. This path generates a local handoff and does not require a
GitLab API token.

GitLab API authentication is host-scoped and resolved by the credential adapter
only when the caller explicitly selects `--auth api`.
The adapter rejects local paths and unsupported endpoint forms before reading a
credential. Credentials are treated as secrets even when a remote response
tries to reflect them; successful projections run the session exposure guard.

SSH Push Options are an explicit, restricted extension of the SSH path. The
tool allows only `merge_request.create`, `merge_request.target`,
`merge_request.title`, `merge_request.description`, and optional
`merge_request.draft`. Labels, assignees, reviewers, target projects, and
auto-merge remain web/API-only. A Push Options request is never reported as
verified until GitLab is opened and checked.

Update trust is build-time data. The repository, Pages channel, Ed25519 roots,
and bootstrap metadata are immutable inputs to a production build. The checked
in source configuration intentionally contains no production roots, so a
source invocation fails closed. Test-only loopback trust is branded and cannot
be relabeled as production trust.

The bundled Skill bootstrap accepts only the fixed GitHub repository and the
exact `skill-v<version>` release path. It follows a bounded set of HTTPS GitHub
asset redirects and rejects arbitrary caller-supplied hosts. Download hashes
and archive manifests are checked locally; production receipt signatures still
require the approved Ed25519 trust chain.

The update cache, trust state, activation journal, Skill state, and verification
receipts are private state. They use canonical records, identity checks, atomic
publication, and recovery paths that retain evidence on ambiguity. A missing or
corrupt verifier is an error, not permission to fall back to an unsigned hash.
