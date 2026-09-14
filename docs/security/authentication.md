# Authentication and trust

The default submission path is Git SSH: the selected source remote must use an
SSH URL and the host SSH agent or system credential manager performs key
authentication. SSH private keys never enter CLI argv, Request data, logs, or
MR descriptions. This path generates a local handoff and does not require a
GitLab API token.

GitLab API authentication is host-scoped and resolved by the credential adapter
for API operations. Explicit `--auth api` is recommended; direct API commands
also retain legacy API behavior under `--auth auto`.
The default provider accepts `HARNESS_MRTOOL_GITLAB_HOST` and
`HARNESS_MRTOOL_GITLAB_TOKEN` from the local process environment and binds the
token to the selected host. Never place token literals in argv, repository files,
remote URLs or chat; see the README for hidden-input examples.
The adapter rejects local paths and unsupported endpoint forms before reading a
credential. Credentials are treated as secrets even when a remote response
tries to reflect them; successful projections run the session exposure guard.

The mandatory-label CLI rejects `manual --ssh-mr` with `LABEL_ERROR` before
push planning or execution. Ordinary SSH branch push remains available, but it
cannot prove MR labels or metadata. Use the API transaction path for creation,
updates, inventory checks and verified readback. Raw Git push options outside
this tool are not subject to its guarantees.

Update trust is build-time data. The repository, Pages channel, Ed25519 roots,
and bootstrap metadata are immutable inputs to a production build. The checked-in
source configuration pins the reviewed `release-key-1` public root and its
fingerprint. Missing/substituted roots and invalid signed evidence
fail closed; the private signing key is not stored in this repository. Test-only
loopback trust is branded and cannot be relabeled as production trust.

The bundled Skill bootstrap accepts only the fixed GitHub repository and the
exact `skill-v<version>` release path. It follows a bounded set of HTTPS GitHub
asset redirects and rejects arbitrary caller-supplied hosts. Download hashes
and archive manifests are checked locally; production receipt signatures still
require the approved Ed25519 trust chain.

The update cache, trust state, activation journal, Skill state, and verification
receipts are private state. They use canonical records, identity checks, atomic
publication, and recovery paths that retain evidence on ambiguity. A missing or
corrupt verifier is an error, not permission to fall back to an unsigned hash.
