# Thin Submission and Future Milestone Implementation Plan

> For agentic workers: use superpowers:subagent-driven-development task by task. Track checkboxes and RED/GREEN evidence. 用户已批准设计并授权直接实施，不追加确认。

**Goal:** 交付0.1.11薄Windows执行器、自动计时和默认提交的最近未来里程碑选择。
**Architecture:** CLI继续管理所有业务规则；插件仅串联现有context/create调用并计时。里程碑作为fast-submit预写metadata，不进入历史Request/marker/receipt。
**Tech Stack:** TypeScript，Node24.16.0，Windows PowerShell5.1，现有node:test/tsx/FakeGitLab，无新增运行依赖。
**Spec:** ../specs/2026-11-11-thin-submit-and-milestone-design.md

## Global Constraints

- 原三标签与默认Issue-first两个POST保留；首POST后零GET/PUT/GraphQL/verify/retry/补偿。
- 上海日期冻结一次；active、合法due_date且严格晚于当天，最早日期、同日数值ID最小；Issue/MR同一个milestone_id；无候选省略并结构化提示。
- 里程碑读取失败在首POST和consume之前结束；分页完整，继承目标项目祖先组候选，不猜ID、不创建资源。
- runner仅Windows PowerShell5.1/native exe；不要求Node/Python/pwsh7，不增加CLI子命令/配置/服务。
- Request原字节stdin透传、原文件不改、正文/token/凭据不入argv；CLI是解析、校验和写入权威。
- stdout单runner JSON，完整CLI结果在cliResult；stderr安全进度；Stopwatch计时；长进程不因固定30秒重启/杀死。
- 正常/受控失败可返回JSON；宿主强杀不能保证最终输出。create已启动却无完整CLI结果属于unknown，不可重试。
- 独立/插件脚本和references逐字一致；两份SKILL正文<=80行，生成版同义，包实际包含新文件。
- 统一版本0.1.11；不修改Bundle1.2.0与历史签名/receipt，不访问生产GitLab做测试，不发布/推送共享分支。

## Review Focus

1. 祖先组/分页/重复ID：第二页的最近候选被选中；相同ID冲突响应拒绝而不是猜。
2. 上海午夜/非法日期：同一次操作日期不漂移，今天/非法日期被排除；有效闰日可用。
3. API失败与消耗顺序：里程碑读取失败时零POST，票据仍可用于后续明确的新调用。
4. stdin/Unicode/大量stderr：字节保真、无死锁、原文件不变、stdout单JSON、无秘密日志。
5. 取消/未知结果/长任务：没有第二次create或隐式verify，>30秒正常子进程保持同一个PID。

## Task 1: Milestone client, selection and fast-submit integration

**Files:** Create src/app/select-submission-milestone.ts, test/unit/select-submission-milestone.test.ts, test/contract/gitlab-milestones.test.ts. Modify src/gitlab/types.ts, src/gitlab/client.ts, src/app/create-submission.ts, src/cli/default-write-services.ts, test/helpers/fake-gitlab.ts, test/contract/gitlab-submit.test.ts, test/unit/create-submission.test.ts, test/integration/default-write-performance.test.ts. Other directly affected fixture tests may be updated to implement the new client method, with explanation.

**Interfaces:**
~~~ts
interface GitLabMilestone { id: number; title: string; state: 'active'|'closed'; dueDate: string|null }
GitLabClient.listProjectMilestones(project: string): Promise<readonly GitLabMilestone[]>
selectSubmissionMilestone(candidates: readonly GitLabMilestone[], submissionDate: string): SubmissionMilestoneSelection
// selection = {submissionDate, reason:'nearest-future'|'no-future-milestone', milestone:{id,title,dueDate}|null}
~~~

- [x] RED: table-driven selector test expects literal IDs for past/today/future, closed, null/invalid dates, leap day and same-day tie. A two-page FakeGitLab contract expects include_ancestors=true/state=active and a closest value only on page2; invalid IDs or conflicting duplicates fail before writes.
- [x] Run pinned Node scripts/test.mjs --test-concurrency=1 test/unit/select-submission-milestone.test.ts test/contract/gitlab-milestones.test.ts; record missing-function or wrong-selection failures.
- [x] GREEN: implement bounded client pagination and the pure selector using strict Gregorian YYYY-MM-DD validation. Do not read clock/network in selector. Stable same-ID duplicates dedupe; conflicting duplicates reject. Ignore invalid date strings in selection, reject malformed date field types at client boundary.
- [x] RED integration: assert same milestone_id in initial Issue and MR POST, exact3 MR labels, no candidate omission versus read-error confusion, zero reads after firstPOST; prefetch failure must not consume candidates. Add UTC23:xx/Shanghai next-day case using injected now. Preserve explicit legacy workItem and dry-run behavior.
- [x] GREEN: freeze now in fast-submit branch; read all milestones before consume; pass candidates and now into createSubmission; reuse chinaDate once and return data.milestoneSelection. Add optional milestoneId only to fast Issue/MR inputs, serialize only if selected and valid.
- [x] Verify selector, milestone client, gitlab-submit, create-submission, default-write-performance and directly affected fixtures. Record exact pass/fail/skip counts, then self-review.
- [x] Commit only Task1-owned paths after controller grants the serial commit slot.

## Task 2: Windows thin runner and behavioral tests

**Files:** Create skill/harness-mr/scripts/run-flow.ps1, plugins/harness-mrtool/skills/harness-mr/scripts/run-flow.ps1, test/contract/run-flow.test.ts and necessary focused test fixture under test/helpers. Do not modify SKILL/projection/version files owned by Task3.

**Consumes:** Existing native schema show/profiles list/context/create JSON contracts. **Produces:** run-flow.ps1 -Phase context|create -Repository <abs> -ClientVersion <loaded> -SkillProtocol <positive> [-Executable <abs>] [-RequestPath <abs|->].

- [x] RED: execute absent runner with a temporary native fake CLI; test failures must name missing runner, then behavior tests catch wrong argv/stdin/order, not source text.
- [x] GREEN context: invoke schema show and profiles list with JSON output, then API context with codex-skill/fixed client/version/protocol/JSON. Preserve context's complete schema/profiles/candidates/binding in cliResult. Stop on nonzero, invalid envelope or ok=false.
- [x] GREEN create: read Request bytes from file or stdin, send verbatim through redirected stdin to one existing create --input - --input-format json --output json. Preserve caller's file, do not normalize/rewrite JSON or change personnel/labels. Keep child stdout/stderr drained concurrently.
- [x] Emit runnerSchemaVersion=1, phase, elapsedMs, steps[{command,exitCode,elapsedMs}], cliResult; runner errors use a separate bounded error/outcome field without inventing a CLI envelope. Safe progress only on stderr. Never disclose raw stderr on parse/startup failure.
- [x] Handle lifecycle through real process completion and cleanup; no fixed30s kill. Controlled cancellation cleans up child; when create started without complete envelope report unknown and stop. Document hard-kill limitation. No preview/verify/context refresh/retry/recovery in create phase.
- [x] Tests: native fake CLI confirms argv and stdin hashes for Unicode/duplicate-key/invalid-UTF8 bytes; original file stays byte-identical; large simultaneous stdout/stderr cannot deadlock; nonzero/ok=false/invalidJSON/start failure stop without second call. Real >30s child retains one PID and completes. Exercise controlled cancellation where harness supports it, with precise evidence and no false portability claim.
- [x] Verify Windows PS5.1 AST parse and focused native runner tests; report skips on non-Windows, not silent success. Self-review for simplicity and secret exposure.
- [x] Commit Task2-owned paths only after controller grants slot; keep both runner copies identical.

## Task 3: Short Skill, references, package/version/CI alignment

**Files:** Modify skill/harness-mr/SKILL.md, plugins/harness-mrtool/skills/harness-mr/SKILL.md, src/skill/projection.ts, package.json, package-lock.json, plugins/harness-mrtool/.codex-plugin/plugin.json, README.md, plugins/harness-mrtool/README.md, docs/commands/reference.md, .github/workflows/ci.yml, test/contract/skill.test.ts, test/contract/plugin-assets.test.ts and actual standalone skill packaging tests. Create skill/harness-mr/references/workflows.md and identical plugin mirror. Do not change runner/source owned by Tasks1/2.

- [x] RED: existing plugin/skill packaging behavior test must show missing runner/references, not only grep source. Add checks against actual ZIP entries and static/compiled generated Skill relationship, plus short default正文 and version alignment contract.
- [x] GREEN: default SKILL正文<=80行 with exact reviewed-file selection/commit/push, context, one Request, create, response link/timings; milestone automatic defaults and unknown/failure boundaries remain clear. Keep full install/manual/historical contract in references and preserve non-Windows direct CLI path.
- [x] Synchronize projection-generated instructions and both static Skill copies; relative runner/reference links resolve in standalone and plugin assets. No extra human confirmation or opaque hash entry.
- [x] Verify real package-skill and package-plugin contents include new files, bounded existing packaging rules remain, no runtime/dependency/.git/credential files. CI PS AST list includes runner.
- [x] Set package/lock/plugin version to0.1.11 and update relevant runtime-generated version smoke/tests; no dependency version changes or release/signing action.
- [x] Verify focused skill/plugin/packaging tests; self-review default readability and legacy reference completeness.
- [x] Commit only Task3-owned paths after controller grants slot.

## Task 4: Integration, independent review and delivery

- [x] Controller reviews each task with a fresh reviewer using its brief, evidence report and owned diff. Fix actual Important/Critical findings with RED→GREEN and a scoped re-review.
- [x] Run the complete project inventory once on integrated code using all four existing Windows CI groups: Node24.16.0 scripts/windows-suite-group.mjs --group 0|1|2|3 --groups 4; each group keeps --test-concurrency=1. Preserve logs, report every failure and platform skip; never call a partial batch the full suite.
- [x] Run pinned Node node_modules/typescript/bin/tsc --noEmit; scripts/build.mjs; Windows SEA build scripts/build-sea.mjs; built CLI schema/self-test smoke; Git diff --check; actual artifact packaging.
- [x] Whole-branch independent review against all spec requirements, with final fixes tested. Verify docs/versions/actual zip/runtime source branch all agree.
- [x] Update design state, plan checkboxes and verification record with real commands/results. Save readable user-facing copy under outputs. Do not create production Issue/MR, publish or push a shared branch.
- [x] Completion audit: map every explicit spec requirement to source/test/artifact evidence; leave goal active if any required item is unproven. Only then mark goal complete.

## Execution rulings

- User approved design and explicitly authorized plan then direct implementation; no repeated plan approval.
- Native create_worktree request produced no usable result; it was canceled and a clean isolated feature branch codex/thin-submit-future-milestone was created in the existing checkout. Existing unrelated worktrees untouched.
- Higher-priority task instructions require useful parallel delegation. Tasks1/2/3 have separate owned paths and may edit in parallel; commits are serialized by controller, with task-owned diff packages and a full integrated review. No implementer spawns extra agents.
- Baseline before product edits: focused create-submission/gitlab-submit/default-write-performance batch passed104/104, 0failed/0skipped, about137seconds. Full-suite evidence is still required at final gate.

## Final acceptance record

Implemented at96cd26e onlocalfeaturebranch. Allnewscope requirements are mapped in ../verification/2026-11-11-thin-submit-and-milestone.md. Final scoped re-review closed5Important/1Minor with no newfindings. Complete163file suite was executed once (2493tests) and remains non-green due documentedbaseline limitations:5initialfailures in4unchangedareas after targetedfixes/retests. No claim of complete-suite success, release readiness, productionGitLab latency or publication. Localimplementation/build/artifacts are delivered; broaderbaseline repair is outside this plan.
