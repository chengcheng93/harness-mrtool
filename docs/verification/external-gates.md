# External gates

This file records evidence without converting an unavailable environment into
a success claim.

| Gate | Status | Evidence or owner action |
| --- | --- | --- |
| Node/typecheck | Automated | `npm run typecheck` on Node 24.16.0. |
| Portable tests | Automated | Linux CI runs every test except the Windows-only SEA smoke contract; the Windows CI job builds SEA first and then runs the full suite. The current POSIX wrapper still targets the Windows x64 asset and requires GNU-style tools, so Linux/macOS support is not claimed. |
| Release and installer contracts | Automated | Release archive, workflow ordering, final standalone/ZIP CLI byte comparison, PowerShell AST (including Skill bootstrap), bounded POSIX inspection, and fixed-entry extraction run in CI and local focused tests. |
| Windows SEA build and smoke | Pending external prerequisite | Run the Windows CI job on a clean runner; local WIP policy blocks native esbuild access to protected sources. |
| Linux/macOS CLI assets and installers | Pending product/release prerequisite | The current release workflow produces the supported Windows x64 SEA asset only; non-Windows binaries and their smoke fixtures must exist before claiming cross-platform support. |
| Signed GitHub Pages channel | Pending external prerequisite | The publish workflow validates release inputs and envelope size locally, but production Ed25519 signing, schema/tag/hash binding, Pages deployment, and an end-to-end client fetch require protected release material and a hosted environment. |
| Skill bootstrap origin and receipt trust | Pending external prerequisite | The bootstrap now pins the repository, exact `skill-v` release path, and bounded GitHub redirects. Production testing must still exercise the final immutable URL and signed receipt/key chain; no arbitrary host or unsigned receipt is accepted as a release claim. |
| Production signing roots | Prepared locally | `release-key-1` is pinned in the production trust configuration; hosted release execution must still use the matching protected private key and verify the final immutable assets. |
| Immutable GitHub release assets | Pending external prerequisite | Verify final bytes, receipts, and downloaded draft assets before publishing. |
| Isolated GitLab integration | Pending external prerequisite | Run fake-stack and real GitLab journeys with host-scoped credentials. |
| Real Codex Skill host | Pending external prerequisite | Test standalone Skill staging, explicit activation, and host refresh. |
| GitHub branch push | User authorization required | The private repository exists; GCM persistence permission is still required. |

Local tests do not replace the Windows SEA, signing, real GitLab, or real-host gates.
