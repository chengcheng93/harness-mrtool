# External gates

This file records evidence without converting an unavailable environment into
a success claim.

| Gate | Status | Evidence or owner action |
| --- | --- | --- |
| Node/typecheck | Automated | `npm run typecheck` on Node 24.16.0. |
| Portable tests | Automated | Linux CI runs every test except the Windows-only SEA smoke contract; the Windows CI job builds SEA first and then runs the full suite. |
| Release and installer contracts | Automated | Release archive, workflow ordering, PowerShell AST, and POSIX installer bounds run in CI and local focused tests. |
| Windows SEA build and smoke | Pending external prerequisite | Run the Windows CI job on a clean runner; local WIP policy blocks native esbuild access to protected sources. |
| Production signing roots | Pending external prerequisite | Inject approved immutable Ed25519 roots at release build time. |
| Immutable GitHub release assets | Pending external prerequisite | Verify final bytes, receipts, and downloaded draft assets before publishing. |
| Isolated GitLab integration | Pending external prerequisite | Run fake-stack and real GitLab journeys with host-scoped credentials. |
| Real Codex Skill host | Pending external prerequisite | Test standalone Skill staging, explicit activation, and host refresh. |
| GitHub branch push | User authorization required | The private repository exists; GCM persistence permission is still required. |

Local tests do not replace the Windows SEA, signing, real GitLab, or real-host gates.
