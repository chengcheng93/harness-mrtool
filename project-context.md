# Project Context

Repository: `harness-mrtool` (single Node/TypeScript project; project path `.`).

## Guidance Read

- No repository `AGENTS.md`, `CLAUDE.md`, `README.md`, or `CONTRIBUTING.md` was present at setup.
- The repository requirements, architecture, verification, and superpowers plan documents under `docs/` are the durable project references.
- Node runtime is pinned to `24.16.0` in `package.json` and `tsconfig.json`.

## Commands

Run from the repository root:

- Install: `npm ci`
- Typecheck: `npm run typecheck`
- Tests: `npm test -- --test-concurrency=1`
- Build: `npm run build`
- Windows SEA build: `npm run build:sea`
- POSIX installer syntax: `bash -n scripts/install.sh`
- PowerShell syntax: parse `scripts/install.ps1`, `scripts/repair.ps1`, `scripts/uninstall.ps1`, and `skill/harness-mr/scripts/bootstrap.ps1` with the PowerShell AST parser.

## Layout

- Application source: `src/`
- Unit, contract, build, and integration tests: `test/`
- Release and installer scripts: `scripts/`
- GitHub workflows: `.github/workflows/`
- Template bundle: `template-bundle/`
- Skill package: `skill/harness-mr/`
- Verification records: `docs/verification/`

## Environment Notes

The local workstation's WIP source projection exposes non-source bytes to native esbuild, so `npm run build` and `npm run build:sea` remain hosted-runner gates. Git integration tests that create many Windows temporary Git repositories can exceed a short local test timeout; they are run separately with an expanded timeout when diagnosing this environment.

Cross-platform CLI assets, signed channel/Pages publication, production signing roots, and real GitLab/Skill-host checks require release credentials or hosted runners and are not claimed as local successes.
