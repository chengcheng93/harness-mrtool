# Authentication and trust

The default CLI and Skill submission path uses GitLab API authentication with
`--auth api`: context, MR creation or update, verified readback, and the MR URL.
An explicit submission request authorizes the normal write; validation stays in
the background without another confirmation. Preview and dry-run are optional
and run only when the user requests them.
`--auth auto` remains a compatibility selection of API without SSH fallback.
Missing credentials or API failures stop the flow; they do not automatically
switch it to manual handoff.

GitLab API authentication is host-scoped and resolved by the credential adapter.
GitLab API origins and MR URLs support HTTP and HTTPS on ordinary hosts.
Explicit HTTP/HTTPS remotes preserve their scheme. SSH/scp/git remotes infer
HTTP first and try same-host HTTPS when HTTP is unavailable during project
discovery. The selected origin remains bound to context and MR readback.
The default provider accepts `HARNESS_MRTOOL_GITLAB_HOST` and
`HARNESS_MRTOOL_GITLAB_TOKEN` from the local process environment and binds the
token to the selected host. Never place token literals in argv, repository files,
remote URLs or chat; see the README for hidden-input examples.
The adapter rejects local paths and unsupported endpoint forms before reading a
credential. Credentials are treated as secrets even when a remote response
tries to reflect them; successful projections run the session exposure guard.

## Installation and authorization initialization

Run `harness-mrtool auth check --host <http-or-https-origin> --output json`
immediately after installation, before declaring the tool ready. This is a
read-only check of the authenticated user and the token's `api` scope. An
instance-only result does not establish project access. Run
`harness-mrtool auth check --output json` inside a bound repository to check
project access and minimum Developer permissions, independently of its current
branch, diff, and Template Bundle.

On Windows, `scripts/setup-gitlab.ps1` reuses matching Process/User credentials
or guides hidden-input configuration. It validates before persisting the
credential to the current Windows user's environment. No token is accepted in
arguments or written to a repository file. Other running programs keep their
previous environment; restart them or use the setup launcher to load saved
credentials into its child process. No API preflight creates a branch or MR.

The CLI installer runs authorization initialization after publishing its verified
binary. A failed check leaves the binary installed and reports initialization
incomplete. The plugin includes a SessionStart check; Codex requires the user to
review and trust plugin hooks before running them. If hooks are unavailable or
untrusted, run initialization explicitly. See the
[GitLab initialization guide](../usage/gitlab-initialization.md).

Local credential errors keep `field: gitlab.credential` and a fixed reason such
as `host-missing`, `host-mismatch`, or `token-missing`; no network request has
been made. A real remote HTTP 401 or 403 retains its status. Network errors and
timeouts are separate GitLab failures. Raw token-provider exceptions and tokens
must never appear in diagnostics.

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
source configuration pins the reviewed `release-key-2` public root and its
fingerprint (`release-key-1` was retired on 2026-11-09 after its private key
was lost; nothing had been published under it). Missing/substituted roots and
invalid signed evidence fail closed; the private signing key is not stored in
this repository. Test-only loopback trust is branded and cannot be relabeled as
production trust.

The bundled Skill bootstrap accepts only the fixed GitHub repository and the
exact `skill-v<version>` release path. It follows a bounded set of HTTPS GitHub
asset redirects and rejects arbitrary caller-supplied hosts. Download hashes
and archive manifests are checked locally; production receipt signatures still
require the approved Ed25519 trust chain.

The update cache, trust state, activation journal, Skill state, and verification
receipts are private state. They use canonical records, identity checks, atomic
publication, and recovery paths that retain evidence on ambiguity. A missing or
corrupt verifier is an error, not permission to fall back to an unsigned hash.
