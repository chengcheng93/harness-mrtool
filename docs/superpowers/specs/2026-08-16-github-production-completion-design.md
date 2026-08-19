# GitHub Production Completion Design

**Date:** 2026-08-16

**Status:** Approved (方案 A)

## Objective

Publish the verified local implementation as a private development baseline at
`chengcheng93/harness-mrtool`, then finish the remaining production composition,
release, end-to-end, and evidence work on `feature/production-composition`.
`main` remains a reviewable baseline until the feature branch passes CI and both
spec-compliance and security-quality review.

## Repository And Branch Model

- GitHub repository: `https://github.com/chengcheng93/harness-mrtool`
- Visibility during completion: private
- Baseline branch: `main`
- Completion branch: `feature/production-composition`
- Baseline source commit: `441278f` plus the worktree-ignore housekeeping commit
- Merge rule: no direct feature implementation on `main`; merge only after the
  complete local/CI gate and independent review are green.
- GitHub must not initialize README, license, or `.gitignore`, because the local
  repository and history are authoritative.

## Completion Boundary

The current core is not a release candidate. It has the deterministic renderer,
Git/GitLab adapters, MR transaction state machine, signed update primitives,
cache/activation recovery, template migration, and Skill manager, but the real
CLI composition root only wires local commands and `self-update.status`.

Completion therefore has four ordered deliverables:

1. **Production command composition**
   - Wire read-only repository/GitLab commands first.
   - Resolve the target project first and treat GitLab's `defaultBranch` as the
     authoritative target branch; a local remote HEAD is only a consistency
     check and never a substitute for the GitLab value.
   - Provide one normalized input path for the interactive wizard, YAML/JSON
     files, and YAML/JSON stdin. Non-TTY calls never wait for interactive input.
   - Add private credential, receipt, historical Bundle, updater, and Skill
     adapters behind injected ports.
   - Run signed-update preflight before every public invocation except the
     explicitly bounded update child process, including offline/no-update and
     stdin/TTY handoff paths.
   - Wire MR writes only after candidate revalidation and durable receipt storage
     are present.
   - Keep unavailable trust material fail-closed; test fixtures must never become
     production trust roots.

2. **Install and release surface**
   - Add bounded installers, uninstall/repair scripts, release asset contracts,
     CI, CLI/Template/Skill/channel workflows, portable packaging,
     command/security/repair documentation, and third-party notices.
   - A release workflow may produce a draft only when signing keys or public
     repository prerequisites are unavailable. It must not claim publication.

3. **Full fake-stack evidence**
   - Run the actual CLI process against local fake GitHub/GitLab servers and bare
     Git repositories.
   - Cover transports, profiles, Draft/Ready transactions, partial outcomes,
     offline LKG, update/rollback, migration, token races, and forbidden writes.
   - Map AC 1-47 to concrete automated tests or an explicit external gate.

4. **Review and acceptance evidence**
   - Fresh spec review, then independent security/code-quality review.
   - Typecheck, complete test suite, SEA build/smoke, and secret scan.
   - Real GitLab, clean Windows VM, public GitHub prerelease, and real Codex Skill
     remain `Pending external prerequisite` unless actually executed.

## Architectural Boundaries

### Composition root

`src/main.ts` owns process I/O and selects a single production runtime. Business
orchestration lives in focused CLI adapter modules, while domain code continues
to depend on injected ports. The route registry in
`src/cli/commands/production.ts` remains a closed dispatcher with safe fallbacks.
The composition root also owns the single update-preflight wrapper and the
interactive/noninteractive transport boundary; individual handlers cannot bypass
either one.

### Context and candidate resolution

Live GitLab snapshot discovery must be separable from token issuance. Preview is
read-only and does not consume tokens. Create/update consume candidate tokens only
after repository, Bundle, binding, and live candidate identity checks pass.

### Durable verification

Create/update stage an authenticated verification receipt before the final managed
description write. Standalone verify resolves the marker to the exact receipt and
historical Bundle; it never substitutes the current Bundle.

### Update and Skill trust

Production update and Skill handlers require fixed repository/origin and bootstrap
trust material supplied by the build. Missing or unverifiable trust is an
`UPDATE_SECURITY_ERROR`, not a hash-only success; `UPDATE_REQUIRED` is reserved
for a verified manifest that blocks the running release and cannot be applied.
Activation uses the existing cache/journal and Skill recovery state machines
rather than parallel pointer formats.

Test-only loopback origins and signing roots are compile-time inputs to a
dedicated test build. Production builds reject that configuration, and no
runtime argv or environment variable can replace production trust roots.

### Secrets

GitLab credentials come from a host-scoped provider and never from argv. GitHub
signing keys, GitLab tokens, OAuth tokens, certificates, and environment-specific
credentials are never committed. Test canaries remain obviously fake and are
scanned as fixtures.

## Verification Strategy

- Every behavior change starts with a focused failing test.
- Each implementation batch receives spec review before code-quality review.
- A GitHub Actions Windows runner is the authoritative Windows SEA build/smoke
  gate when Windows Information Protection prevents local native `esbuild` from
  reading Git-created files. Linux CI remains a portable typecheck/test gate and
  cannot substitute for a Windows SEA artifact.
- CI builds the SEA before SEA-dependent tests. Real-process coverage includes
  TTY interactive input, YAML/JSON files, and YAML/JSON stdin.
- Local Node/TypeScript tests remain required; environment-caused native build
  limitations are recorded, not hidden.
- No unavailable external gate is represented as passed.

## Non-Goals For The Private Baseline

- Making the repository public.
- Choosing a public license without an explicit product/legal decision.
- Publishing immutable Releases, Pages, or attestations before production signing
  and repository prerequisites exist.
- Storing any GitHub/GitLab credential in source, workflow YAML, test output, or
  generated documentation.

## Done Criteria

The feature branch is mergeable only when all local-completable Task 15-17 work is
implemented, the fake-stack E2E and AC 1-47 traceability are complete, CI is green,
independent reviewers report no open Critical/Important issue, and every external
gate is either backed by evidence or explicitly marked pending with owner/action.
The exact final evidence commit must be pushed, pass CI, and receive the final
independent review; an earlier green SHA is not sufficient for merge.
