# Issue First Fast Submission Design

日期：2026-11-10　版本：CLI / Plugin 0.1.10　状态：依据用户已确认方案实施

## 1. 目标与边界

普通提交从真实已提交 diff 生成一个统一 Issue，再创建关联 MR并返回链接。默认无预览、人工确认、事后读回、自动重试、查询恢复或自动补偿。只修改提交链路，不重写历史 MR 的强验证、签名更新或安装体系。

创建 Issue 与创建 MR 是两次顺序业务写请求；必要的项目、当前用户、标签与分支预检仍可读取，并复用现有上下文。首个 POST 后不得 GET、PUT、GraphQL 标签补写或重复 POST。

## 2. 接口与兼容

- Request schema 1 增加 workItem: { relation: "new" }；省略 workItem 时规范化为 new。普通 wizard、Skill和首选样例使用 new。
- 显式旧 closes / related / none 输入保留既有语义和旧事务，避免静默丢弃调用者指定的 Issue。旧 MR 的 update / verify / upsert / resume 继续可用。
- new 不支持 upsert/resume；在任何远端写入前给明确 INPUT_ERROR。
- 快 MR 使用独立 submission marker，表示创建响应已收到，而非旧 final/verified receipt。旧 verify/update遇到这种 marker 明确报告模式不支持，不当作损坏的历史 MR；新 MR 分支后续普通 Git push 仍由 GitLab正常跟踪。
- 不新增数据库、响应记录仓库、自动恢复 journal、远端模板选择或第二次 AI调用。旧 Template Bundle 1.2.0及历史 receipt 不改写。

## 3. 统一 Issue 内容

固定八部分：基本信息；背景与目标；工作内容与交付物；方案与影响范围；验收标准；验证记录；风险与回滚；关联信息。

内容确定性复用已由调用方依据 diff 填写的 title、motivation、changes、impact、verification、documentation、risk、profileFields。专项信息直接在这些说明内展开，不选择八套模板：Bug保留复现/实际/预期/环境/证据，Feature保留范围边界，DevOps保留影响环境及回滚，发布保留版本/制品/检查。无依据的可选信息写未提供或省略，不杜撰测试通过。

| 字段 | 默认规则 |
| --- | --- |
| 标题 | [module] titleSummary |
| 负责人 | 新 MR上下文中的当前 GitLab API用户真实ID |
| 阶段日期 / 计划日期 | 一次取得 Asia/Shanghai 当日；计划日期写 due_date |
| Milestone / TAPD | 可空，不读取候选或要求补充 |
| 验收 | 可判断的交付条件；Review、合并等尚未完成项保持未勾选 |

Issue只使用已解析可用的类型/优先级标签；不要求周标签、阶段配置或新增标签。MR仍遵循现有自动三标签规则，所有MR标签及人员一次传入创建请求。

## 4. 写入链路

1. 规范化输入，取得一次可用项目/用户/标签上下文，校验已提交 HEAD、目标分支和源分支已发布且 SHA一致；保留本地脏文件，不隐式 push。
2. 解析并消费现有候选，构建完整写计划，渲染Issue；尽可能在首个POST前捕获输入/权限/分支问题。
3. POST目标项目Issue。负责人为当前用户，issue_type=issue，milestone省略，due_date为当日。直接校验响应id/iid/project_id/web_url，不GET Issue、不查历史列表。
4. 用新IID生成含 Closes #iid 的MR正文；Issue始终属于MR目标项目。一次POST源项目merge_requests并指定目标项目、标题、正文、标签、人员、squash/removeSourceBranch。
5. 本地解析响应IID/URL/项目/分支身份。返回created、verification=creation-response及MR链接，不标verified。

使用旧MR renderer的preview态生成不夸大完成情况的正文后，替换其诊断尾部为独立 submission marker；不得伪造final快照或验证receipt。所有正文和返回值仍通过现有凭据暴露检查。

## 5. 失败与性能

| 失败点 | 行为 |
| --- | --- |
| 首次写入前失败 | 直接报错，零写入 |
| Issue明确拒绝 | 报错，不创建MR |
| Issue响应未知或无法验证身份 | 报unknown并停止，不查询/重发 |
| Issue成功、MR明确拒绝 | 报部分失败，返回已知Issue链接 |
| MR超时或响应未知 | 报部分/未知状态，附Issue链接；不查询MR、重发、删除或关闭Issue |

HTTP transport只请求一次。业务请求失败即结束；用户另发新的普通提交属于新操作、创建新Issue，不做历史相似匹配。

## 6. 文件与验收

新增小型Issue renderer和create-submission服务；扩展现有GitLab client两个直接REST方法；在default-write-services分派new；同步schema/wizard/Skill/文档/0.1.10版本。单元测试和production入口集成测试共同断言真实payload与请求次数。

必须覆盖：统一八部分及专项内容不丢失；默认当前用户和中国日期（含跨UTC午夜）；两POST成功且首POST后零GET/PUT/GraphQL；Issue失败不发MR；MR失败无重试并保留Issue链接；成功回包畸形视为unknown；独立两次操作各建Issue；缺Milestone/TAPD不阻塞；旧显式WorkItem和历史MR继续旧路径；预览/dry-run零写入；真实Git source SHA和脏文件保留。

不使用生产GitLab创建测试Issue/MR，不正式发布。交付前运行相关合同/集成测试、typecheck、build和diff检查，完成规格审查与代码质量审查。
