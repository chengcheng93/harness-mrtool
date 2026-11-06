# Authentication and trust

The default CLI and Skill submission path uses GitLab API authentication with
`--auth api`: context, preview, MR creation or update, and verified readback.
`--auth auto` remains a compatibility selection of API without SSH fallback.
Missing credentials or API failures stop the flow; they do not automatically
switch it to manual handoff.

GitLab API authentication is host-scoped and resolved by the credential adapter.
The default provider accepts `HARNESS_MRTOOL_GITLAB_HOST` and
`HARNESS_MRTOOL_GITLAB_TOKEN` from the local process environment and binds the
token to the selected host. Never place token literals in argv, repository files,
remote URLs or chat; see the README for hidden-input examples.
The adapter rejects local paths and unsupported endpoint forms before reading a
credential. Credentials are treated as secrets even when a remote response
tries to reflect them; successful projections run the session exposure guard.

Manual handoff is available only after an explicit human request and requires
`manual --auth ssh`; it does not read or require a GitLab API token. Its source
remote must use an SSH URL, with key authentication performed by the host SSH
agent or system credential manager. SSH private keys never enter CLI argv,
Request data, logs, or MR descriptions. Git may also use SSH to publish a source
branch before the default API MR flow; Git transport and API authentication are
separate choices.

MR diffs and pushes use committed `HEAD` only. Push, create, update, and manual
handoff allow staged, unstaged, and untracked files, including `.superpowers`
reports. They do not require a clean worktree or automatically add, stash,
clean, or delete local files.

The mandatory-label CLI rejects `manual --ssh-mr` with `LABEL_ERROR` before
push planning or execution for every auth selection, including with `--push`.
Ordinary SSH branch push remains available, but it
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
