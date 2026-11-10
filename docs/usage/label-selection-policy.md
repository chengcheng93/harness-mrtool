# MR 标签选择策略

## 状态与适用范围

本工作树的 Template Bundle 为 `1.2.0`。默认 production 入口已接入 API
`create`、`create --upsert`、`update`、`verify` 和自动标签交互向导。
CLI 与 Skill 默认使用 API 自动 MR 流程；缺少 Token 或 API 失败时停止，
不会自动回退到 manual/SSH。`--auth auto` 仅兼容选择 API。
这是本地实现状态，不代表已发布、已上线或通过真实 GitLab 验收。
策略由 mrtool 代码执行，不依赖 Skill 文案；它无法限制绕过工具的原始 Git/API
调用或 GitLab 网页操作，也不是服务端合并门禁。

## 固定 13 标签池

| 类别 | 允许值 | 每个 MR 数量 |
| --- | --- | --- |
| type | `type::feature`、`type::bug`、`type::doc`、`type::test`、`type::refactor`、`type::performance`、`type::build`、`type::ci`、`type::chore` | 恰好 1 |
| priority | `priority::p0`、`priority::p1`、`priority::p2` | 恰好 1 |
| status | `status::review` | 恰好 1 |

最终标签集合恰好为三个，不是“至少三个”。`week::` 排期标签已移除；更新时
移除额外标签（包括旧 week 标签和池外人工标签），而不是保留它们。
所需标签必须已存在于目标项目或祖先组的真实标签库存，且能唯一解析；缺失、
歧义或写前漂移时失败关闭。工具不会自动创建、删除或改名远端标签定义；
从 MR 移除标签关联不等于删除标签定义。

## 以真实 diff 选择类型

CLI 读取已提交的 canonical actual diff，绑定 `sourceHeadSha`、`targetRefSha`
和 `mergeBaseSha`，并对规范化证据计算 diff digest。文件变更及内容证据参与
有界分类；标题、分支名、文件名中的意图词或调用者摘要不能替代真实变更证据。
未提交内容不参与 MR diff 或推送。staged、unstaged、untracked 文件（包括
`.superpowers` 报告）均可保留；不要求工作区干净，不自动 add、stash、clean 或删除。
支持性文档/测试不会覆盖唯一的主变更类型。纯文档或源码注释修改自动使用
`type::doc`；能够识别的其他改动直接使用对应类型。未知、混合且无法细分或
不支持的内容统一使用 `type::chore`，不再交给人选择或确认。

类型由程序自动决定，不接受人工类型或摘要确认参数。`--type` 只是标题提示，
不能覆盖真实 diff 的自动标签。diff digest 继续由程序计算并用于并发一致性校验，
无需用户复制或输入。空或失效的 canonical diff 仍然是错误，不能当作未知类型。

## 优先级与生命周期

- 未显式指定优先级时使用 `priority::p2`，不是根据标题猜测紧急程度。
- 提升为 `p0` 或 `p1` 必须明确选择并提供非空理由：
  `--priority p1 --priority-reason "<reason>"`。
- 每个 MR 都使用 `status::review`；项目不再需要 `status::doing` 标签。
- 自动交互向导和非交互调用使用同一选择器；类型、标签、哈希、squash 和删除源分支
  不再弹出确认，使用程序规则或请求中已有的值。提优先级仍需事实理由。

## 写入、dry-run 与已有 MR

默认 `workItem: new`（省略时相同）校验 diff 和实时库存后，创建 Issue，再以完整初始 POST 创建关联 MR，直接返回创建响应中的链接；写入后不回读、不补写、不重试。三标签在 MR 创建请求中一次发送，输出只声明 `creation-response`。
不增加普通预览或确认步骤。只有用户主动要求时才执行 preview/dry-run。历史显式 `closes/related/none` 仍用原事务回读验证。`preview` 以及 API create/update 的 `--dry-run` 不推送、
不执行 GitLab 写入，也不消费候选 context；仍可读取实时上下文，不等于离线。

新模式不支持 upsert、resume、旧强验证或更新入口；后续普通 Git push 仍会更新分支内容。历史显式 `closes/related/none` 的 `create --upsert` 必须认证已有 MR 的 receipt 和历史 Bundle。如果已有 MR
使用的 Bundle 与 create context 不同，当前路径要求 `context --mr <iid>` 后
执行 `update <iid>`，或显式迁移；不得静默回退到当前 Bundle。
已有可信签名的历史 policy 仍可按其原 Bundle 读取和验证，不能原地改写成新策略。
新 `1.2.0` 写入的三标签约束也不能被历史 policy 宽松规则绕过。
`--migrate-template` 是显式迁移入口：先用
`context --mr <iid> --migrate-template` 获取迁移绑定的上下文，再执行
`update <iid> --migrate-template`。程序自动构造并校验精确 old:new 绑定，
不要求用户抄写哈希或确认。
production adapter 验证原 receipt、精确历史 Bundle 和迁移绑定后执行事务。
用 Bundle 1.0.0 或 1.1.0 创建的 MR 仍可读取、更新和验证；旧版工具留下、从未更新过的半成品 MR
在执行一次 `update` 之前会在 `verify` 的标签检查中失败。受控迁移集成测试不代表已发布或完成真实 GitLab 验收。

## SSH 边界

`manual --ssh-mr` 返回 `LABEL_ERROR`，在 push 规划或执行前停止，即使同时
传入 `--push` 也不能创建基础 MR。仅在人类明确要求手工交接时，才使用
`manual --auth ssh` 生成本地 handoff，已要求推送时直接附加 `--push` 执行；这不是
已验证 MR，更不代表标签达标。Git 本身仍可使用 SSH 发布源分支，随后由
默认 API 快速路径创建 Issue 与 MR；历史显式模式仍使用原事务校验标签。manual 必须显式提供旧 workItem，不支持 new 或省略。
