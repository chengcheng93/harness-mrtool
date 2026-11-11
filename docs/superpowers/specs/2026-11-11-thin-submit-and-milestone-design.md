# 最小提交编排与未来里程碑设计

日期：2026-11-11
状态：设计草案，等待用户审阅；尚未修改产品代码
范围：harness-mrtool 默认 Issue-first 提交与配套 Skill

## 1. 目标与已确认的取舍

用户已确认采用最小方案：CLI 继续负责协议、候选身份、标签、模板、授权与 GitLab 写入；插件提供薄执行脚本，复用既有命令并自动计时；默认使用说明保持简短。另补充按提交时间自动选择最近未来里程碑。

目标：
- G1：固定 schema/profiles/context/create 的调用与计时，减少每次临时生成长脚本、手写轮询和事后统计。
- G2：在默认新 Issue/MR 创建中自动填写最近未来里程碑，与已有标签一起进入初始 POST。
- G3：默认 SKILL 正文不超过 80 行；历史 MR、安装和手动流程按需读取。用户仍可用一句自然语言发起提交。
- G4：有可复现测试、调用序列与逐步耗时证据；不以 mock 的耗时冒充真实 GitLab 端到端性能。

既有基线：0.1.10 上次提交的 create 调用约18秒，记录窗口约247秒，其中命令执行覆盖约49秒，其余主要是代理准备、调度、轮询和整理结果。优化优先针对这些固定编排开销；1～1.5分钟只是待实测目标，不是网络条件无关的验收保证。

## 2. 方案选择

A．继续让代理临时写完整脚本：无新增文件，但保留重复生成、易漏计时和重复调用问题。
B．增加薄插件执行脚本，调用现有 CLI：复用权威实现，新增范围小。用户已选择此路线。
C．增加统一提交子命令、配置体系或后台服务：需要扩展 CLI 与状态管理，超出本次轻量目标。

本次采用 B。默认执行仍由代理理解真实差异并填写业务说明；runner 不包含 AI 调用、标签规则、模板渲染、恢复策略或另一份 Request 验证器。

## 3. 薄 runner 的具体边界

当前原生发行以 Windows x64 为主，首次 runner 使用系统 Windows PowerShell 5.1 与现有 native exe，不要求用户安装 Node、Python 或 PowerShell 7。其他平台保持现有 CLI 路径；本轮不承诺新增跨平台 runner。

新增建议接口（当前尚未实现）：

~~~text
scripts/run-flow.ps1 -Phase context -Repository <absolute-repo>
  -ClientVersion <本次已加载Skill版本> -SkillProtocol <本次协议>
  [-Executable <absolute-cli>]

scripts/run-flow.ps1 -Phase create -Repository <absolute-repo>
  -ClientVersion <同一Skill版本> -SkillProtocol <同一协议>
  -RequestPath <absolute-request-file或-> [-Executable <absolute-cli>]
~~~

- context 阶段顺序运行现有 schema show、profiles list、context；使用 API/codex-skill/JSON 及本次固定的版本和协议。任一步非零退出、无合法结果或 ok=false 时停止。
- 代理先检查精确文件范围、项目授权；用户授权提交未提交变更时，只处理已检查的文件，再 commit 与普通非 force push。Git 修改不藏进 runner，不自动 add全部、stash 或 clean，不顺带提交其他 staged 内容。
- context 成功后，代理依据实际 diff 和返回 schema 只新建一次完整 Request；默认 workItem.relation=new。
- assignee 只使用唯一的 kind=assignee 且 defaultSelected=true 候选；不猜用户ID。未指定 reviewer 保持空数组，显式用户名只匹配真实 reviewer 候选，不能把作者设为自审。
- create 阶段只读 Request 原始字节，通过 stdin 透传给现有 create --input - --input-format json --output json。禁止改写原文件、重序列化、在 argv 中携带正文、候选 token 或凭据。
- Request 的重复键、编码、长度、字段、候选与权限校验仍全部由 CLI 完成。
- stderr 只输出不含凭据/正文/token的安全进度；正常或受控失败时 stdout 恰好一个 runner JSON，CLI envelope 原样位于 cliResult。
- wrapper 使用 runnerSchemaVersion=1、phase、elapsedMs、steps 和 cliResult，不能把自定义计时字段混进 CLI envelope。context 的 cliResult 为最后一个 context 结果；失败时为失败步骤的原结果。
- 计时采用单调 Stopwatch；steps 每项记录 command、exitCode、elapsedMs。单独保留 CLI 执行耗时与 wrapper 总耗时，代理不得将轮询观察时间冒充子进程耗时。
- 同时异步排空 stdout/stderr，等待原进程真正退出，不设固定30秒杀死。宿主 yield 后继续等同一 session，不能重新启动 create。
- 宿主强杀时不能保证最终 JSON。create 已启动但没有完整 CLI 结果时，标记结果未知并停止；取消、失败、部分成功均不自动重试、查询恢复或回滚。
- 默认流程应收敛为检查与提交准备、一次 Request 与 create、返回创建响应三个业务阶段。runner 不保证固定的模型/工具调用次数，也不把必要的真实差异审阅省掉。

建议脚本正本：skill/harness-mr/scripts/run-flow.ps1；插件镜像：plugins/harness-mrtool/skills/harness-mr/scripts/run-flow.ps1。沿用现有打包器递归收集，不新增依赖或构建入口。

## 4. 里程碑规则

这里的“里程碑标签”落实为 GitLab milestone_id 字段，而不是第四个 label。已有 type、priority、status 三标签规则保持原样。

代理提出以下确定性默认值，供本次设计审阅：
- 在默认新建流程的预检开始时冻结一次时刻，以 Asia/Shanghai 转成提交日期；Issue日期、due_date及里程碑选择复用同一日期。
- 读取目标项目可用的 active 项目及祖先组里程碑，使用 GitLab 项目 milestones API 的 include_ancestors=true，并按现有客户端上限完整处理分页。
- 候选必须有合法日历日期形式的 due_date，且 due_date 严格大于提交日期；“今天”不属于未来。无日期、非法日期和 closed 候选不参与选择。
- 按 due_date 升序，选择最近日期；同日候选按数值 id 升序，确保结果稳定；使用返回的全局数值 id，不能误用 iid、标题或 label ID。
- 将同一个 milestoneId 同时用于新 Issue 与 MR 的初始 POST；保留现有 Issue 当前用户负责人、当日due_date及原有标签。
- 没有未来候选时省略 milestone_id，在创建结果中给出结构化的 no-future-milestone 提示；不创建新里程碑、不猜名字、不新增确认问题。
- 里程碑 API 读取/分页失败在任何 POST 之前结束，不继续创建 Issue。读取成功但没有候选与 API 失败必须区分。
- 在读取完成前不消费用于写入的候选票据；未开始的写入不应因只读失败耗尽票据。

API参考：https://docs.gitlab.com/api/milestones/#list-all-project-milestones

## 5. 接入位置与协议约束

最小接入：
- src/gitlab/types.ts：添加 GitLabMilestone 类型、两个快速创建 input 的可选 milestoneId。
- src/gitlab/client.ts：添加 listProjectMilestones(project) 读取方法，以及两个现有 POST 的 milestone_id 序列化。
- src/app/select-submission-milestone.ts：纯选择函数 selectSubmissionMilestone(candidates, submissionDate)，无网络、无时钟读取。
- src/cli/default-write-services.ts：仅在 create + workItem=new 分支冻结 now、预取里程碑；读取成功后再消费候选并继续既有 fresh Git guard。
- src/app/create-submission.ts：复用 chinaDate(now)，用选择结果组装两个 POST 的 metadata，并返回选择结果供 CLI 输出。
- 不将里程碑塞入历史 Request、ExternalContextSnapshot、Bundle 1.2.0 或历史 marker/receipt，不重写历史 MR 事务。

结果增加 data.milestoneSelection，至少包含 submissionDate、reason（nearest-future或no-future-milestone）及选中时的 id/title/dueDate。只有上述经过客户端校验的公开元数据可进入结果；不要输出候选能力票据或凭据。

保持0.1.10写入边界：所有读取和校验发生于首POST之前；之后只有一次 Issue POST 和一次 MR POST。成功以创建响应返回 created；不追加 GET、PUT、GraphQL、verify、重试、查询恢复或补偿。任何部分失败保留原 ok/code/remoteWrite/Issue链接，并立即停止。

## 6. 默认说明与包同步

- skill/harness-mr/SKILL.md：保留默认提交与关键边界，正文最多80行，链接 references/workflows.md 按需查看历史/手动/安装细节。
- plugins/harness-mrtool/skills/harness-mr/SKILL.md：与独立Skill字节一致。
- src/skill/projection.ts：同步生成版默认说明及相对路径，不能只改静态两份。
- 新增的 runner 与 references 正本、镜像逐字一致；scripts/package-skill.mjs 与 scripts/package-plugin.mjs 的实际产物均须包含这些文件。沿用既有bootstrap与installer约束，并将新PowerShell脚本加入CI语法检查。
- 实现完成时统一升级 package、lock、plugin manifest 至0.1.11；不在本次规划阶段发布或更新全局安装。

## 7. 详细执行顺序

1. 按该设计编写正式 writing-plans 任务计划；每项给出准确文件、接口、失败测试、验证命令和验收证据。
2. 实现里程碑客户端及纯选择函数，先用合同/单元测试证明日期、ID和分页规则，再接入默认提交路径。
3. 实现PowerShell薄runner，使用假CLI子进程证明调用次序、stdin原字节、计时、失败和长进程处理。
4. 收短默认Skill，迁移按需文档，保持正本/插件/生成版同步；补充打包与版本契约。
5. 做独立规格与质量审查，运行聚焦测试、typecheck、build、diff检查；生成简短验收与耗时说明。

实施在隔离分支/工作树进行；保留用户现有工作。此设计中的默认值经用户审阅后进入实施计划，不在审阅前写产品代码或安装依赖。

## 8. 必须证明的验收条件

- 纯函数：过去、今天、未来、closed、null日期、非法日期、同日ID消歧、上海跨UTC午夜、闰日。
- 客户端：项目及祖先组候选、分页第二页最近值、重复ID、畸形ID/日期、读取失败、两POST的可选milestone_id。
- 提交：Issue/MR同一选中ID，三标签未增加，无候选能区分于读取失败；首POST后任何GET/PUT/GraphQL/retry均使测试失败。
- runner：精确现有命令、stdin原字节与原文件不变、Request编码/重复键错误由CLI决定、stdout单JSON、stderr无敏感值；超过30秒的活进程不被重启/杀死，取消后不创建第二次操作。
- 回归：显式旧workItem和历史MR不新增里程碑读取或自动写；preview/dry-run保持零写入。
- 包：两份runner、references和SKILL一致，生成版保留同一语义，包内不含Node/node_modules/.git/凭据；未引入运行依赖。
- 性能：记录真实子进程耗时与总耗时，验证schema/profiles/context/create各一次、元数据读取不重复；不创建生产Issue/MR作为压测。
- 文档：默认正文不超过80行，使用者无需阅读实现脚本；详细历史内容只按需加载。

## 9. 本次范围之外

不新增服务、数据库、通用任务引擎、新配置体系、远端label/milestone创建、AI二次调用或legacy恢复重构。不声称已完成真实GitLab集成验收、发行签名或正式发布。
