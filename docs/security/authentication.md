# Authentication and trust

GitLab authentication is host-scoped and resolved by the credential adapter.
The adapter rejects local paths and unsupported endpoint forms before reading a
credential. Credentials are treated as secrets even when a remote response
tries to reflect them; successful projections run the session exposure guard.

Update trust is build-time data. The repository, Pages channel, Ed25519 roots,
and bootstrap metadata are immutable inputs to a production build. The checked
in source configuration intentionally contains no production roots, so a
source invocation fails closed. Test-only loopback trust is branded and cannot
be relabeled as production trust.

The update cache, trust state, activation journal, Skill state, and verification
receipts are private state. They use canonical records, identity checks, atomic
publication, and recovery paths that retain evidence on ambiguity. A missing or
corrupt verifier is an error, not permission to fall back to an unsigned hash.
