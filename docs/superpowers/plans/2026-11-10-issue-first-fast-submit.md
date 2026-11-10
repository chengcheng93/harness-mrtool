# Issue First Fast Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement task-by-task. 已有设计讨论获用户确认；按本计划执行，不追加审批关卡。

**Goal:** 用统一Issue模板和两次业务POST完成默认提交，失败即停。

**Architecture:** workItem=new（省略时默认）走独立快速提交服务；显式旧WorkItem保留既有事务。复用已有上下文、候选、Git预检及正文renderer，不重写receipt框架。

**Tech Stack:** TypeScript，Node 24.16.0，现有GitLab HTTP client、node:test/tsx。

## Task 1 REST创建接口

Files: src/gitlab/types.ts，src/gitlab/client.ts；test/contract/gitlab-submit.test.ts。

- [x] RED：用FakeGitLab断言 createIssue 与 createMergeRequestSubmission 的准确端点、全部payload、响应身份和无额外请求。

~~~ts
assert.deepEqual(fake.requests.map(r => r.method), ["POST", "POST"]);
assert.equal(issue.iid, 42);
assert.equal(mr.webUrl, expectedMrUrl);
~~~

- [x] GREEN：新增GitLabCreateIssueInput/GitLabCreatedIssue、GitLabCreateMergeRequestSubmissionInput/GitLabSubmittedMergeRequest及同名方法；Issue负责人数组仅一人，MR一次附labels/assignee/reviewer，跨项目端点用sourceProjectId。
- [x] 验证：node scripts/test.mjs --test-concurrency=1 test/contract/gitlab-submit.test.ts；覆盖拒绝、未知、响应畸形及无额外GET，随后提交。

## Task 2 统一Issue渲染

Files: src/render/issue.ts；test/unit/issue-render.test.ts。

- [x] RED：固定输入Request和Asia/Shanghai日期，断言8部分、当前用户、同日dueDate、风险/验证/专项文字完整，缺TAPD/Milestone不报错。

~~~ts
const rendered = renderIssue({ request, projectPath: "group/apps", authorUserId: "7", date: "2026-11-10" });
assert.equal(rendered.dueDate, "2026-11-10");
assert.match(rendered.description, /验收标准/);
assert.doesNotMatch(rendered.description, /\[x\] MR 已合并/);
~~~

- [x] GREEN：纯函数复用Request全部相关说明，统一模板，不调用网络或选择模板；提供一次计算中国当日的可注入时间函数。
- [x] 验证：node scripts/test.mjs --test-concurrency=1 test/unit/issue-render.test.ts；随后提交。

## Task 3 编排和默认CLI

Files: src/app/create-submission.ts，src/render/submission.ts，src/cli/default-write-services.ts，src/contracts/request.ts，schemas/request-v1.schema.json，src/input/normalize.ts，src/cli/wizard.ts及现有直接引用点；test/unit/create-submission.test.ts，test/integration/default-write-performance.test.ts、test/integration/production-default-label-flow.test.ts。

- [x] RED：编排依赖只允许两POST，任何写后读都抛错；成功取创建响应，Issue/MR各一次；Issue失败MR为零，MR失败Issue不重建。

~~~ts
assert.deepEqual(calls, ["issue.create", "mergeRequest.create"]);
assert.equal(result.verification, "creation-response");
~~~

- [x] GREEN：添加relation=new及省略时默认，纯新create接到快服务；必要fresh预检和候选消费仅在首POST前；保留显式旧WorkItem分支。
- [x] 添加submission marker，旧强验证入口识别后明确拒绝模式；preview/dry-run/new upsert-resume均不得误写。
- [x] 验证相关单元、performance/production输入/真实Git回归；审查无隐式readback、retry或额外Issue列表查询。

## Task 4 技能与交付

Files: skill/harness-mr、plugins/harness-mrtool技能副本、src/skill/projection.ts、README.md、docs/commands/reference.md、examples/submission.json、package.json/package-lock/plugin manifest及直接契约测试。

- [x] 默认指令使用new/省略workItem，统一模板和自动默认值，成功直接返回链接；verify仅显式请求、说明快模式边界；两份技能字节同步。
- [x] CLI/Plugin升级0.1.10；保留旧样例用于兼容，新增首选提交样例；不改历史验证记录和签名Bundle。
- [x] 依次做规格审查、代码质量审查并修复真实问题。
- [x] 最终运行相关测试、node node_modules/typescript/bin/tsc --noEmit、node scripts/build.mjs、git diff --check，记录准确结果和调用次数；提交可审查的变更。

## 验证记录

- 核心合同、输入、渲染与入口聚焦批次：237/237通过；default-write-performance：16/16通过（标签/成员各读取一次，首写后仅两POST）。
- 真实Git新流程：显式new/省略两项通过，验证真实SHA及staged/unstaged/untracked保留；TTY默认创建和文本成功/部分失败链接三项通过。旧create/update/verify/upsert/迁移回归按用例验证。
- Skill/插件文档聚焦40项、版本状态2项通过；规格及质量独立审查均通过。
- tsc --noEmit、build、构建版0.1.10 version/schema smoke、diff --check通过。构建保留既有两条CJS import.meta警告。
- Windows长测试批次按用例拆分；未声明全仓安装/发布套件通过，未创建真实GitLab测试Issue/MR或正式发布。
