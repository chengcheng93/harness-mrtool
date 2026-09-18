# Mandatory labels — 0.1.6 release progress (2026-09-17)

**Status: not published; full release/install goal remains incomplete.**
This is new-version evidence, not a rewrite of the older 0.1.5 release history.

## Candidate and protected baseline

- Starting main: `2eea0bab09db5bb4ab4d2abfa2fd9c2b9001856f`.
- CLI and Plugin candidate version: 0.1.6; planned standalone Skill: 0.1.6.
- Template Bundle: 1.1.0 (independently versioned).
- Inherited 12-file dirty tree was backed up before any resumed edits.
- Target host confirmed Darwin ARM64. `harness-mrtool` absent from PATH;
  the Codex plugin inventory has no harness-mrtool installation and neither
  checked standalone harness-mr Skill directory exists.

## Baseline recovery, not a security downgrade

The previous run's 57 failures included at least three independent causes:
noncanonical `/var/tmp` fixture roots, current context fixtures hardcoded to
0.1.5 after package version moved to 0.1.6, and a stale SEA build receipt after
package/lock edits. These were not all application failures or one path problem.

- Retained the scoped physical-temp fixture corrections. Deliberate symlink,
  hardlink and path-replacement security tests remain unchanged.
- Current production context fixtures now use package metadata. Real historical
  0.1.5 receipt fixtures retain their original versions.
- Rebuilt SEA using exact Node **24.16.0** before the no-exclusion full suite.
- Restored old release evidence and download links; candidate 0.1.6 is not
  represented as an already published release.
- Plugin archive README also marks the unpublished candidate, uses current main
  for source marketplace installation, and documents pre-push SSH MR refusal.

Baseline evidence: **1145 tests, 1137 pass, 0 fail, 8 native-Windows skips**;
typecheck and SEA build exit 0, build receipt matches source/executable, strict
Darwin codesign check passes, and the pinned Node executable hash is unchanged.
That baseline precedes the new production-channel implementation below; it must
not be reused as its final validation.

## Critical-path discoveries

1. Default production had only `self-update status`; check/apply/rollback were
   unavailable. Private apply-update, active release tuple loading and default
   Skill service composition also require completion.
2. Portable archive validation checks signature-envelope structure and byte
   integrity, not cryptographic authenticity. Zero-filled signature bytes can
   pass that structural layer. The runtime cryptographic verifier correctly
   rejects them. Publication needs a real signed release verifier, not a renamed
   checksum check.
3. The fixed stable channel endpoint returned HTTP 404. The workflow currently
   publishes a stable-* Release attachment; this is not a Pages deployment.
4. POSIX installer currently targets a Windows ZIP. Native Mac packaging,
   platform-specific install/upgrade/rollback and authenticated executable
   materialization remain necessary.

## In-progress implementation boundaries

- **Production channel check:** reuse bounded channel HTTP, source-pinned trust,
  monotonic real state persistence and signature verification. A check must not
  claim installation. This is the first updater slice, not full apply/rollback.
- **Release version gates:** require tags to match package/lock/plugin/template
  metadata before workflows build/package. This gate is not signature validation.

Remaining work: cryptographic release validation/generation, authenticated
release-set downloading and executable/template activation, native handoff and
rollback, Mac package/install support, production Skill composition, verified
component promotion and Pages deployment, actual install/update/host/GitLab tests.

## External prerequisites, verified early

- `gh auth status`: no authenticated GitHub host; no GH_TOKEN/GITHUB_TOKEN present.
  Git SSH works but does not authorize Secrets/Pages/Release API operations.
- The proposed 0.1.6/1.1.0 tags were not returned by exact `git ls-remote` queries.
- Public API main CI run `34856741541` for 2eea0ba was cancelled, not successful.
- Source-pinned Ed25519 signing key's authorized custody/service is not yet
  identified. No private keys or credential stores were searched or printed.
- GitLab host/token environment absent; authorized isolated API target pending.

User action requested: normal GitHub CLI login. Signing should be provided via
an authorized signer or an explicitly supplied restricted key path, never secret
contents in chat. Actual GitLab tests wait for a specific isolated target and
secure API authentication. These requirements do not prevent safe local work,
but no new signed release, supported installer or live-service success is claimed.

## Bounded implementation checkpoint (not release completion)

Implemented after the initial candidate baseline:
- Actual default channel-check dispatch, signed metadata persistence, 304/replay
  and cached fallback handling. It does not apply/install releases.
- Real source-entry disabled-check tests (not only imported entrypoint tests).
- Four component tag/metadata equality gates, before release build/package.
- Publication-only Template and Skill cryptographic verifiers, production-root
  CLIs, and workflow gates before attestation/upload/create. Historical runtime
  receipt loading still requires its signed-channel anchors.
- Template gate verifies actual final ZIP against signed file hashes and source
  bytes, with bounded parsing and no filesystem extraction. FIFO replacement
  cannot block its input open. Canonical-byte checks reject BOM envelopes,
  payloads, manifests and relevant archive names.
- Deterministic Skill archive generation, with timezone-independent DOS fields,
  sorted entries, fixed file modes and final16MiB cap. Signing externally supplied
  final archive bytes is reproducible; this is not itself receipt generation.
- Optional `darwin-arm64` structural portable packaging, native filename/mode,
  Mach-O ARM64 executable format checks and native macOS CI gate. Windows
  packager defaults remain unchanged; platform installation is not yet wired.

Independent review closed wrong-object Template ZIP verification and Skill BOM
normalization findings with real signed counterexamples; metadata-only/structural
checks are no longer misrepresented as cryptographic publication verification.
No private production key was accessed, and no new tag/release was published.

Next critical path remains signed snapshot download/provenance + actual
apply/rollback/handoff and active tuple selection, native installers, production
Skill activation, component signing/promotion, Pages deployment and real
installation/GitLab acceptance. Authentication and signing custody remain external
prerequisites, not reasons to pretend the remaining code is complete.

## Verified source checkpoint — September 17

- Exact Node24.16.0 typecheck: exit0.
- Rebuilt current SEA; full suite after review fixes: **1399 tests / 1391 pass /
  0 fail / 8 native-Windows skips**, 210 seconds, no SEA exclusion.
- Source/artifact receipt, strict codesign and unchanged original Node hash: pass.
- Independent closure: Template archive/FIFO and Skill canonical-BOM findings
  closed; deterministic packaging independently verified with one generated-key
  receipt across UTC/Shanghai/Los Angeles. Near-cap ZIP overhead rejected.
- Real Darwin candidate structurally packaged, extracted and self-tested as
  `harness-mrtool` with version0.1.6. The fixture used an explicitly untrusted
  receipt and was deleted: this is **not a trusted release or installation**.
- Commit/push of this checkpoint does not authorize new tags or imply passing
  hosted CI, signature production-key availability, installed updater/Skill,
  real GitLab acceptance or goal completion.

## September 18 continuation — source work, not a released installation

- Authenticated release snapshots retain re-verifiable signed channel/rotation
  provenance and the anchored Template receipt. Identical signed payloads acquired
  through different valid histories can be retried without replacing the installed
  proof; same-sequence different signed payloads remain rejected.
- Bounded release downloads and preparation recheck the signed channel after all
  assets arrive. This prepares bytes only; it does not install or activate them.
- Native materialization writes into a separate private, sealed directory rather
  than executing ZIP cache files. POSIX writes are relative to an inherited pinned
  directory descriptor; the Windows helper pins non-reparse ancestors without
  delete sharing. Current-owner file identity, exact mode, bounded content and
  post-read checks are enforced. Independent review found and drove closure of
  both the opened-mode and parent-redirection regressions. Native Windows remains
  a required live CI gate, not proven by Windows archive fixtures on macOS.
- CLI release workflow now requires verified Windows and Darwin ARM64 artifacts
  before one draft can publish; both platform archives, executables, receipts and
  checksum files are downloaded and compared before publication. This workflow
  has not been used to publish the candidate.
- Git compatibility uses a private source index instead of the newer attr-source
  option; inherited GIT_ATTR_SOURCE is scrubbed at the trusted process boundary.
  Actual host CI must confirm the remaining portability result.
- Windows CI previously ended cancelled after about30minutes. The serial full
  test command is unchanged and the job budget is60minutes; cancellation is still
  failure, never successful verification.

The old pinned runtime path disappeared during continuation. Recent PATH-based
24.18 runs were explicitly invalidated as24.16 evidence. A fresh official archive
was SHA-256 checked and exact Node24.16 execution was asserted before replacement
checks. Typecheck and183 targeted tests passed under the restored runtime.

The next full run found one stale single-platform workflow dependency assertion
(reported as child+parent failures). The corrected contract now requires both
platform gates;100 targeted release/version tests passed. A fresh rebuild/full
suite is required after the subsequent Git ambient-attribute fix; no all-green
claim is made here until that completes.

The unchanged final acceptance scope still includes production apply/rollback,
active executable/template selection, native installer/repair, Skill composition
and host activation, legitimate signing, real channel hosting, actual downloaded
installation/upgrade/rollback and isolated GitLab API acceptance. No source-only
checkpoint can replace those gates. No new release/tag or local installation has
been performed by this continuation.

### September 18 verified checkpoint result

After the ambient Git attribute fix and dependency-contract update, a fresh exact
Node24.16.0 typecheck, SEA rebuild and **unfiltered serial full suite** completed:
**1585 tests /1573 passed /0 failed /12 platform-specific skips**, about260seconds.
Current-source SEA receipt and strict codesign verified; the restored Node binary
SHA-256 remained unchanged. This supersedes the intermediate failing run above.

Independent review closed the snapshot-idempotency, native opened-mode,
parent-anchored-writer, workflow-gating and Git ambient-attribute findings. The Git
closure separately exercised2.39.5, Apple2.50.1 and2.55.0. Hosted native CI is the
next gate; skipped Windows cases remain unproven on this Mac. Publishing, default
apply/rollback, actual installation/activation and live GitLab acceptance are still
incomplete and are not implied by this source checkpoint.

### September18 status/transaction follow-up

Hosted CI35304381915: portable and secret scan passed; Mac had one fixture failure,
reproduced locally under the diagnostic step's umask077 (mkdir0755 started as0700).
The test now explicitly chmods only its owned external fixture to0755 before
checking that a linked root leaves those permissions unchanged. No production
permission, symlink or signature check was relaxed. Windows result was still
pending at the latest observation; it is not counted as passed.

Default self-update.status now actually authenticates the selected configured
cache using the production snapshot verifier. It reports the running CLI version
separately from the cached version, and keeps physical installation unknown until
native installation is proven. The checked-in test uses cached0.1.7 vs running0.1.6
and rejects the wrong signing root, with no network request.

UpdateStateStore.load, activation and recovery can now borrow one root-branded
update lease. Invalid/other-root/expired capabilities are rejected before filesystem
preparation. Activation/recovery capture the validated capability before yielding,
so mutable caller options cannot trigger a nested acquisition. This is prerequisite
transaction composition, not a completed installer/apply handler.

Fresh exactNode24.16.0 typecheck, SEA rebuild and full serial suite underumask077:
**1621 tests /1609 passed /0 failed /12 platform skips**, about186seconds. Current
source/artifact receipt, strictcodesign and unchangedNode hash verified. Independent
status review and transaction-lease closure approved. Production canonical install,
apply/rollback/handoff/startup tuple selection and all live release/installation/
GitLab acceptance gates remain outstanding.
