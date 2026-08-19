# harness-mrtool

`harness-mrtool` is a deterministic CLI for preparing, previewing, creating,
updating, and verifying GitLab merge requests from repository changes.

The repository requires Node `24.16.0`:

```text
npm ci
npm run typecheck
npm test
```

The production entry is `src/production-main.ts`; the same entry is used by
the application and SEA build configuration. Production update trust roots are
build-supplied. A source checkout without those roots fails closed with
`UPDATE_SECURITY_ERROR` and must not be treated as a release artifact.

GitLab credentials are host-scoped and never belong in argv, request bodies,
logs, or caller-supplied environment values. Update state and Skill activation
state are private, canonical, identity-checked records. Skill installation is
staged first; activation is explicit.

Windows SEA builds, release signing, immutable GitHub assets, isolated GitLab,
and a real Codex host remain external gates. See
`docs/verification/external-gates.md`.
