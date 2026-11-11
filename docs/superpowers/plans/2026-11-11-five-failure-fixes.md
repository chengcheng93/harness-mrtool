# Five failure fixes

User authorized minimal implementation, Superpowers continuation and retesting. Base: 548d77a99983c221fa8a7354e10e2583c0a4d571; existing isolated branch codex/thin-submit-future-milestone.

## Scope
- Correct Windows file versus directory ACL flags and reject ineffective/empty authorization; retain private-owner rules.
- Correct readiness shared-deadline test isolation and packaged-exe version fixture; retain production deadlines.
- Make the 304 race test exercise the intended in-budget response; retain ordinary 2-second policy and state rollback guards.
- Preserve immutable Bundle1.2.0 bytes; replace accidental raw-schema byte equality with meaningful historical/current contract and normalized-legacy compatibility checks.
- No new dependencies, runtime framework, CLI/config/API, Bundle regeneration or unrelated changes. Keep version0.1.11 local candidate.

## Tasks
### Task1 — ACL implementation and real regression
Owner: src/platform/state-path.ts and narrowly related real ACL tests. Record RED, implement minimum file/directory distinction and effective-current-user authorization guard, GREEN native materialization plus directory regression. No weakened checks.
### Task2 — Three deterministic test fixes
Owner: test/integration/native-readiness.test.ts and test/integration/production-channel.test.ts. Keep real behavior assertions: shared timeout spans probes, exact real binary version/Bundle, 304 race refuses stale state. Use existing held lease/force budget seams, no production clock API. RED evidence already exists; run amended tests to GREEN.
### Task3 — Schema contract
Owner: test/unit/bundle.test.ts and narrowly necessary contract test. Retain manifest/hash/frozen checks; prove frozen Bundle legacy schema and current raw Request extensions are intentionally distinct, and current normalized legacy Requests remain valid for Bundle. Do not touch schemas/template-bundle bytes.
### Task4 — Review and integration
- [x] Independent spec/quality review of combined diff, then focused corrections if needed.
- [x] Typecheck, app/SEA build and source-bound receipt/native smoke.
- [x] All four existing Windows CI groups, each internally serial; account every file and every failure/skip without inventing aggregate results.
- [x] Repack actual Skill/plugin assets and compare sizes/hashes against prior candidate; report runtime source delta and dependency/Bundle invariants.
- [x] Commit exact owned paths serially, update verification and deliver local artifacts. No production GitLab, push, release or global installation.

## Workflow
Parallel ownership is disjoint; commits serialized by root. Keep RED/GREEN logs and concise reports in the SDD workspace. Root coordinates one combined independent review; do not rerun suites unnecessarily or expand scope.

## 结果

五项修复完成，专项及独立复审通过。完整163文件已执行，首轮并行失败与后续覆盖复测分开记录，详见../verification/2026-11-11-five-failure-fixes.md。额外两行修复发布测试的Windows PATH分隔符；生产路径仅净增3行、制品零体积增长。
