# External gates

This file records evidence without converting an unavailable environment into
a success claim.

| Gate | Status | Evidence or owner action |
| --- | --- | --- |
| Node/typecheck | Automated | `npm run typecheck` on Node 24.16.0. |
| Portable tests | Automated | Linux CI runs every test except the Windows-only SEA smoke contract; the Windows CI job builds SEA first and then runs the full suite. The current POSIX wrapper still targets the Windows x64 asset and requires GNU-style tools, so Linux/macOS support is not claimed. |
| Release and installer contracts | Automated | Release archive, workflow ordering, final standalone/ZIP CLI byte comparison, PowerShell AST (including Skill bootstrap), bounded POSIX inspection, and fixed-entry extraction run in CI and local focused tests. |
| Windows SEA build and smoke | Completed | Release CLI run `32650924186` completed the Windows Node `24.16.0` SEA build, standalone/portable byte comparison, and release byte gates for CLI `0.1.4`. |
| Linux/macOS CLI assets and installers | Pending product/release prerequisite | The current release workflow produces the supported Windows x64 SEA asset only; non-Windows binaries and their smoke fixtures must exist before claiming cross-platform support. |
| Signed GitHub Pages channel | Pending external prerequisite | The publish workflow validates release inputs and envelope size locally, but production Ed25519 signing, schema/tag/hash binding, Pages deployment, and an end-to-end client fetch require protected release material and a hosted environment. |
| Skill bootstrap origin and receipt trust | Pending external prerequisite | The bootstrap now pins the repository, exact `skill-v` release path, and bounded GitHub redirects. Production testing must still exercise the final immutable URL and signed receipt/key chain; no arbitrary host or unsigned receipt is accepted as a release claim. |
| Production signing roots | Completed for CLI 0.1.4 | `release-key-1` is pinned in the production trust configuration; the signed Bundle receipt was injected through `BUNDLE_RECEIPT_B64` and verified by Release CLI run `32650924186`. |
| Immutable GitHub release assets | Completed for CLI/Plugin 0.1.4 | Releases [`cli-v0.1.4`](https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.4) and [`plugin-v0.1.4`](https://github.com/chengcheng93/harness-mrtool/releases/tag/plugin-v0.1.4) are non-draft and immutable. Their workflows verified final bytes and downloaded draft assets before publishing; the public repository also permits Artifact Attestations. |
| Isolated GitLab integration | Pending external prerequisite | Run fake-stack and real GitLab journeys with host-scoped credentials. |
| Real Codex Skill host | Pending external prerequisite | Test standalone Skill staging, explicit activation, and host refresh. |
| GitHub branch push | Completed | `release-candidate-0.1.0`, immutable `cli-v0.1.4`, and immutable `plugin-v0.1.4` are pushed without changing `main`. |

Local tests do not replace the Windows SEA, signing, real GitLab, or real-host gates.
