# MR 标签选择策略

## 状态与适用范围

本工作树的 Template Bundle 为 `1.1.0`。默认 production 入口已接入 API
`create`、`create --upsert`、`update`、`verify` 和自动标签交互向导。
这是本地实现状态，不代表已发布、已上线或通过真实 GitLab 验收。
策略由 mrtool 代码执行，不依赖 Skill 文案；它无法限制绕过工具的原始 Git/API
调用或 GitLab 网页操作，也不是服务端合并门禁。

## 固定 14 标签池

| 类别 | 允许值 | 每个 MR 数量 |
| --- | --- | --- |
| type | `type::feature`、`type::bug`、`type::doc`、`type::test`、`type::refactor`、`type::performance`、`type::build`、`type::ci`、`type::chore` | 恰好 1 |
| priority | `priority::p0`、`priority::p1`、`priority::p2` | 恰好 1 |
| status | `status::doing`、`status::review` | 恰好 1 |

最终标签集合恰好为三个，不是“至少三个”。`week::` 排期标签已移除；更新时
移除额外标签（包括旧 week 标签和池外人工标签），而不是保留它们。
所需标签必须已存在于目标项目或祖先组的真实标签库存，且能唯一解析；缺失、
歧义或写前漂移时失败关闭。工具不会自动创建、删除或改名远端标签定义；
从 MR 移除标签关联不等于删除标签定义。

## 以真实 diff 选择类型

CLI 读取已提交的 canonical actual diff，绑定 `sourceHeadSha`、`targetRefSha`
和 `mergeBaseSha`，并对规范化证据计算 diff digest。文件变更及内容证据参与
有界分类；标题、分支名、文件名中的意图词或调用者摘要不能替代真实变更证据。
支持性文档/测试不会覆盖唯一的主变更类型；未知、混合且无法确定或不支持的
变更不会自动兜底为 `chore`。

遇到未知/歧义类型，先审查实际 diff，再使用 CLI 返回的 digest 显式确认：

```text
harness-mrtool preview --auth api --input request.json --input-format json --confirm-label-type <type-suffix> --label-diff-digest <sha256> --output json
```

`<type-suffix>` 为固定池中的类型后缀，例如 `doc`，不是标题类型 `docs`。
`--type` 只是标题提示，不构成类型确认。两个确认参数必须一起提供；digest
过期或与已知分类冲突时拒绝。执行 create/update 时保留对应确认；diff 改变后
重新获取证据并确认，不复用旧 digest。空或失效的 canonical diff 不是可绕过的
“未知类型”。

## 优先级与生命周期

- 未显式指定优先级时使用 `priority::p2`，不是根据标题猜测紧急程度。
- 提升为 `p0` 或 `p1` 必须明确选择并提供非空理由：
  `--priority p1 --priority-reason "<reason>"`。
- Draft 使用 `status::doing`；Ready 使用 `status::review`，不能任意组合。
- 自动交互向导使用同一选择器，展示自动标签和 digest；歧义时要求类型与
  digest 确认，提优先级时收集理由。非交互调用缺证据时失败，不擅自代答。

## 写入、dry-run 与已有 MR

API 写入前校验 diff 和实时库存，事务写入后回读完整标签集合；无法证明结果
时不能报告成功。`preview` 以及 API create/update 的 `--dry-run` 不推送、
不执行 GitLab 写入，也不消费候选 context；仍可读取实时上下文，不等于离线。

`create --upsert` 必须认证已有 MR 的 receipt 和历史 Bundle。如果已有 MR
使用的 Bundle 与 create context 不同，当前路径要求 `context --mr <iid>` 后
执行 `update <iid>`，或显式迁移；不得静默回退到当前 Bundle。
已有可信签名的历史 policy 仍可按其原 Bundle 读取和验证，不能原地改写成新策略。
新 `1.1.0` 写入的三标签约束也不能被历史 policy 宽松规则绕过。
`--migrate-template` 是显式迁移入口：先用
`context --mr <iid> --migrate-template` 获取迁移绑定的上下文，再在 update 中提供
`--confirm-migration <oldHash>:<newHash>`；TTY 向导展示哈希并收集确认。
production adapter 验证原 receipt、精确历史 Bundle 和迁移绑定后执行事务。
已有受控的 1.0.0 → 1.1.0 集成测试，但不代表已发布或完成真实 GitLab 验收。

## SSH 边界

`manual --ssh-mr` 返回 `LABEL_ERROR`，在 push 规划或执行前停止，即使同时
传入 `--push` 也不能创建基础 MR。普通 `manual --auth ssh` 仍可生成本地
handoff，确认后可执行普通分支推送；这不是已验证 MR，更不代表标签达标。
需要工具创建、更新并证明标签状态时使用 API 事务路径。
