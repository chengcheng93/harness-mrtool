# External gates

This file records evidence without converting an unavailable environment into
a success claim. The SSH-first `0.1.5` candidate is tracked separately from
the already-published `0.1.4` assets below.

| Gate | Status | Evidence or owner action |
| --- | --- | --- |
| Node/typecheck | Automated | `npm run typecheck` on Node 24.16.0. |
| Portable tests | Automated | Linux CI runs every test except the Windows-only SEA smoke contract; the Windows CI job builds SEA first and then runs the full suite. The current POSIX wrapper still targets the Windows x64 asset and requires GNU-style tools, so Linux/macOS support is not claimed. |
| Release and installer contracts | Automated | Release archive, workflow ordering, final standalone/ZIP CLI byte comparison, PowerShell AST (including Skill bootstrap), bounded POSIX inspection, and fixed-entry extraction run in CI and local focused tests. |
| Windows SEA build and smoke | Completed | Release CLI run `32713773931` completed the Windows Node `24.16.0` SEA build, standalone/portable byte comparison, and release byte gates for CLI `0.1.5`. |
| Linux/macOS CLI assets and installers | Pending product/release prerequisite | The current release workflow produces the supported Windows x64 SEA asset only; non-Windows binaries and their smoke fixtures must exist before claiming cross-platform support. |
| Signed GitHub Pages channel | Pending external prerequisite | The publish workflow validates release inputs and envelope size locally, but production Ed25519 signing, schema/tag/hash binding, Pages deployment, and an end-to-end client fetch require protected release material and a hosted environment. |
| Skill bootstrap origin and receipt trust | Completed for Skill 0.1.5 | The bootstrap pins the repository, exact `skill-v` release path, and bounded GitHub redirects. Skill Release run `32713774061` attempt 2 created immutable [`skill-v0.1.5`](https://github.com/chengcheng93/harness-mrtool/releases/tag/skill-v0.1.5) and verified its signed receipt and archive. |
| Production signing roots | Completed for CLI 0.1.5 | `release-key-1` is pinned in the production trust configuration; the signed Bundle receipt was injected through `BUNDLE_RECEIPT_B64` and verified by Release CLI run `32713773931`. |
| Immutable GitHub release assets | Completed for CLI/Plugin 0.1.5 | Releases [`cli-v0.1.5`](https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.5) and [`plugin-v0.1.5`](https://github.com/chengcheng93/harness-mrtool/releases/tag/plugin-v0.1.5) are non-draft and immutable. Their workflows verified final bytes and downloaded draft assets before publishing; the public repository also permits Artifact Attestations. |
| Isolated GitLab integration | Completed | Real SSH acceptance completed against `bjxcjg/Luban/00-workspace`: GitLab SSH handshake succeeded, the acceptance branch was pushed with `merge_request.create`, target/title/description and Draft options, and MR `!25` was confirmed through `refs/merge-requests/25/head` and `refs/merge-requests/25/merge`. No API Token was used. |
| Real Codex Skill host | Pending external prerequisite | Test standalone Skill staging, explicit activation, and host refresh. |
| GitHub branch push | Completed | `release-candidate-0.1.0`, immutable `cli-v0.1.5`, and immutable `plugin-v0.1.5` are pushed without changing `main`. |

## SSH-first 0.1.5 candidate

- Local implementation commit: `123c387` (`feat: make Codex MR flow SSH-first`).
- Verification completed locally: typecheck, 11 targeted authentication/manual/Skill contract tests, and 7 targeted Git push integration tests.
- CLI/Plugin publication completed: Windows SEA and immutable `cli-v0.1.5` / `plugin-v0.1.5` are available.
- Skill publication completed: `SKILL_BUNDLE_RECEIPT_B64` is configured, and Skill Release run `32713774061` attempt 2 published immutable `skill-v0.1.5`.
- Real GitLab acceptance completed against `bjxc-git.maxphotonics.com:bjxcjg/Luban/00-workspace.git` using the preconfigured `id_ed25519_00_workspace` key. MR `!25` was created from `harness-mrtool-ssh-acceptance-20260825` and confirmed through GitLab's SSH merge-request refs; no GitLab API Token was used.

Local tests do not replace the Windows SEA, signing, real GitLab, or real-host gates.
