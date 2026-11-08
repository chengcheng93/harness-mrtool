# 直接创建正式 MR，移除 Draft 阶段（2026-11-06）

用户要求：作为提交工具，harness-mrtool 不应先建 Draft 再切 Ready；MR 一上来就是正式提交，流程里不再出现 Draft。用户同时确认：彻底删除 Request 的 `intent` 字段；取消审核人最少人数门槛（reviewer 可为空，由人在 GitLab 补）。

## 最终行为

- `create`：直接 POST 普通 MR（标题 `[type][module] 摘要`，临时 description，无标签无人员）→ 同步恰好三个标签（type、priority、`status::review`）→ 写标题/人员/选项 → 写最终 description 并回读校验 → 完成。没有 Draft 前缀、没有 Ready 切换、没有补偿写操作。最终 description 写入是最后一次远端写操作。
- `update <iid>`：同步标签 → 写受管字段 → 写最终 description。旧版工具留下的 Draft MR 经一次 `update` 后标题去掉前缀，自动成为普通 MR。
- Request 契约删除 `intent`（schema `required` 与 `properties` 均删除，`additionalProperties: false` 保持，旧请求文件带该字段会被拒绝）。
- Template Bundle 升级为 `1.2.0`：`policy.yml` 删除 `lifecycle.expectedNames.draft` 与 `review.draftMinimumReviewers`；`schema.json` 删除 `intent`；manifest 重新生成。校验按 manifest 版本分叉：`< 1.2.0-0` 保持旧精确规则与旧 schema 哈希，`>= 1.2.0-0` 使用新形状与新哈希；1.0.0/1.1.0 历史包继续可加载，钉在其上的旧 MR 仍可 context/update/verify。
- 固定标签池由 14 个变为 13 个，项目不再需要 `status::doing`。
- 任何地方都不再强制最少 reviewer 数；policy 的 `readyMinimumReviewers`/`highRiskMinimumReviewers` 只用于 description 中 Review 勾选项的提示和 `verify --level merge` 的审批数门槛。
- 错误码 `PARTIAL_DRAFT` 改名 `PARTIAL_WRITE`（退出码仍为 6）：MR 已存在且状态可读但事务未完成，用 `update <iid>` 或 `create --resume` 续写；`PARTIAL_REMOTE_STATE` 含义不变。`remoteWrite.state` 删除 `compensated`。
- 事务审计 `journalVersion: 2`：操作 `create | labels-add | labels-remove | fields-write | description-write | create-outcome-query`，阶段 `normal | recovery`，终态 `not-started | partial | complete | unknown`。
- 写入计划形状：`{ writePlanVersion, provisional, desired, statusLabelId, managedLabelIds, preservedLabelIds }`。
- `create --resume` 保留：可续写前缀为「无标签无人员」「完整标签组无人员」「完整标签组＋全部人员」，MR 须为 open 且非 Draft。旧版 `Draft:` 半成品不能续写，改走 `update`。
- `verify` 三个等级保留：`ready` = structure + 线上 MR 不是 GitLab Draft。从未更新过的旧 Draft MR 会因标签不是 `status::review` 校验失败，先 `update` 一次即可。
- 交互向导不再询问 intent；SSH 手工 handoff 不再生成 `merge_request.draft` 推送选项。
- GitLab 读侧仍解析 `draft` 布尔值与快照 lifecycle `draft`，旧收据（`lifecycle: "draft"`）继续可解析；新收据恒为 `ready`。

## 改动范围

- 源码：`src/contracts/*`、`src/input/normalize.ts`、`src/render/{title,markdown}.ts`、`src/app/{create-mr,update-mr,compensate,transaction-journal,write-plan,resume-create,verify-mr,mandatory-labels,label-defaults,get-context}.ts`、`src/gitlab/{mr-remote,client,types}.ts`、`src/cli/{commands/merge-request,commands/manual,commands/readonly,default-write-services,wizard}.ts`、`src/git/push-plan.ts`、`src/bundle/{load,validate}.ts`、`src/main.ts`。
- 契约与模板包：`schemas/request-v1.schema.json`、`schemas/output-v1.schema.json`、`template-bundle/{schema.json,policy.yml,bundle-manifest.json}`。
- 测试：重写事务、远端、日志、续写、渲染、模板包兼容等测试；新增 `test/fixtures/template-bundle/` 冻结 1.1.0 之前的 schema/policy/manifest 字节，供历史包测试使用。
- 文档：README、命令参考、架构、需求（含验收项 28/30/40/41 与 v0.4.0 变更记录）、三份 usage 文档、两份 SKILL.md（字节一致）、样例改名为 `examples/request.json`。

## 验证命令

在 `harness-mrtool` 目录、Node 24.16.0 下执行：

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node scripts/build.mjs
node scripts/build-sea.mjs
node dist/main.cjs self-test --output json
node dist/main.cjs self-test --contract-probe --output json
node dist/main.cjs self-test --renderer-probe --output json
node dist/main.cjs version --offline --no-update --output json
node scripts/test.mjs --test-concurrency=1
```

## 验证结果

- 类型检查：0 错误。
- `scripts/build.mjs` 构建成功（保留原有 2 条 CJS/`import.meta` 警告，本次未改动对应模块）。
- 新构建 CLI 的 `self-test`、`--contract-probe`、`--renderer-probe` 均返回 `ok: true`；`version` 报告 `templateVersion: 1.2.0`、`inputSchema: 1`、`policySchema: 1`。
- 定向测试：事务核心、GitLab 远端/客户端契约、事务日志、续写、渲染黄金用例、模板包兼容（含 1.0.0 与冻结 1.1.0 历史包、跨 1.2.0 重标版本的拒绝）、生产写入适配器、真实 Git 标签流程、文档与 Skill 契约均通过。
- 全量测试（`node scripts/test.mjs --test-concurrency=1`，147 个文件，耗时 2291.8 秒）：2266 项，2186 通过，7 失败，73 跳过（跳过项均为既有的平台条件跳过）。7 个失败逐一处置如下：
  - `historical-bundle-loader.test.ts`「signed historical loader retains frozen 1.0.0 week policy…」：本次改动遗漏。该测试用冻结的 1.0.0 清单搭配当前 `schema.json`，而 1.0.0 清单钉的是旧 schema 字节哈希。已改为同时使用冻结的旧 schema 字节；单独复跑 10 项全部通过。
  - `sea-smoke.test.ts` 3 项与 `native-readiness.test.ts`「actual packaged SEA authenticates…」：`dist/harness-mrtool.exe` 与收据是 2026-11-04 的旧产物，与变更后的源码输入集不匹配（"SEA build receipt input set mismatch"）。本机执行 `node scripts/build-sea.mjs` 重建成功后，两文件复跑 38 项中 37 项通过，剩余 1 项见下。
  - `production-channel.test.ts`「a 304 racing a newer accepted channel…」：全量满负载下失败（Missing expected rejection），空闲机器单独复跑 29 项全部通过，判定为负载相关抖动。
  - `native-readiness.test.ts`「readiness shares one deadline across all probes…」：全量与单独复跑均失败（`calls >= 2` 不成立）。该用例要求在 Windows 1500ms 共享截止时间内至少完成 2 次子进程探针，每次探针自带 350ms 延时；实测本机 `node` 子进程启动加 350ms 延时单次耗时 737–810ms，两次无法在窗口内完成。测试文件与被测 `src/update/native-readiness.ts` 均未被本次改动触及，判定为本机进程启动延迟导致，未在本机证明其通过。
- 未执行：真实 GitLab 创建/更新 MR；`templates-v1.2.0` 签名模板包发布。其他机器要校验/更新用 1.2.0 创建的 MR，需先发布签名的 `templates-v1.2.0`。本地 SEA 重建产物未签名，仅用于本机测试。
