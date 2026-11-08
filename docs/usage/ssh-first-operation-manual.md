# API 默认流程与使用验收手册

## 目标

CLI/Plugin `0.1.7` 当前为待验收发布候选，不代表已有新 Release。
历史 `0.1.5` 的 SSH-first 行为不作为当前候选的默认流程。
本文件保留原路径，便于已有链接继续访问。

- 默认 API：`context -> preview -> create/update -> verify`，用于自动标签、负责人、审核人、MR 写入和回读验证。
- 手工交接仅在人类明确要求时启用，命令必须显式使用 `manual --auth ssh`。
- SSH MR 创建禁用：`manual --ssh-mr` 返回 `LABEL_ERROR`，在 push 规划或执行前停止。

未传 `--auth` 时使用 `api`；`--auth auto` 仅保留为 API 选择的兼容写法，
不会回退 SSH。缺少 Token、认证失败或 API 请求失败时停止并报告问题，
不得自动改走手工交接。Git 仍可使用 SSH 推送分支，这与 MR 使用 API 无冲突。

## 安装

当前候选按[仓库 README](../../README.md)的精确运行时说明源码构建 CLI，
再安装 Codex Plugin；历史 Release 不包含当前全部改造：

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref main
codex plugin add harness-mrtool@harness-mrtool
```

安装后新开一个 Codex task/thread。进入目标 Git 仓库后使用“准备当前分支的 merge request”。

源码运行精确固定 Node `24.16.0`。macOS native process lock 依赖 Perl 的
`flock`；这不代表已声明 macOS 发布平台验收通过。

## 默认 API 流程

在业务仓库内检查工作区、分支和 remote，提交本次改动并发布源分支。
API MR 命令不自动 push，远端源 SHA 必须与本地提交一致。原有 SSH Git remote
可以继续使用，不需要为 API 创建 MR 改成 HTTPS。
GitLab API 支持 HTTP/HTTPS；显式 HTTP/HTTPS remote 保留协议，SSH/scp/git
remote 推断时优先 HTTP，HTTP 不可用时兼容尝试同主机 HTTPS。
MR diff 和推送只使用已提交的 `HEAD`；staged、unstaged、untracked 文件及
`.superpowers` 报告可以保留，不要求工作区干净，也不会自动 add、stash、clean 或删除。

```powershell
git status
git remote -v
git fetch origin
# 检查并提交自己的改动，确认分支后：
git push -u origin HEAD
```

配置与 Git remote Host 一致的 API 凭据。PowerShell 7 使用隐藏输入：

```powershell
$env:HARNESS_MRTOOL_GITLAB_HOST = 'gitlab.example.com'
$env:HARNESS_MRTOOL_GITLAB_TOKEN = Read-Host 'GitLab API token' -MaskInput
```

以下示例显式写出默认的 `--auth api`。输入文件可放在私有目录，使用当前
`context` 的 `contextId` 和人员 candidate token；`labelCandidateTokens` 保持
`[]`，由 CLI 自动选择标签：

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
harness-mrtool doctor --auth api --output json
harness-mrtool context --auth api --output json
harness-mrtool preview --auth api --input /absolute/private/request.json --input-format json --output json
harness-mrtool create --auth api --input /absolute/private/request.json --input-format json --dry-run --output json
harness-mrtool create --auth api --input /absolute/private/request.json --input-format json --output json
harness-mrtool verify <iid> --auth api --level structure --output json
```

用实际 MR IID 替换 `<iid>`。Skill 调用还会为命令附带当前
`--client codex-skill --client-version <skill-semver> --skill-protocol <protocol>`。
更新已有受管 MR 时先使用 `context --mr <iid>` 获取更新上下文，再预览和执行
`update <iid>`，最后 `verify <iid>`。

API 标签规则见[标签选择策略](label-selection-policy.md)：Bundle `1.2.0` 固定
13 标签池，最终恰好 type/priority/status 各一个；默认 p2，提升至 p0/p1 必须
提供理由，每个 MR 的 status 固定为 `status::review`。更新移除额外标签和 week 标签；
所需标签必须已存在，CLI 不会自动创建远端标签。类型来自绑定 HEAD/target/
merge-base 的真实 canonical diff；未知类型必须显式确认并绑定 CLI digest，
不能用标题提示代替。向导自动接入相同规则。

`preview` 和 API create/update `--dry-run` 无远端写入且不消费候选 context，
但仍可进行实时读取。`create --upsert` 认证已有 MR 的 receipt；Bundle 不同
时使用 `context --mr <iid>` 后 `update <iid>` 或显式迁移，不静默回退当前
Bundle。可信旧签名 policy 仍可读取，显式迁移需专用 context 和准确的
old:new 哈希确认；这些本地实现不代表已发布或完成真实 GitLab 验收。
这些保证仅覆盖 mrtool，不限制原始 Git/API 或网页操作。

Token 不得进入命令行参数、Remote URL、Request、日志、MR 正文或聊天消息。使用结束后清理当前会话：

```powershell
Remove-Item Env:HARNESS_MRTOOL_GITLAB_TOKEN
Remove-Item Env:HARNESS_MRTOOL_GITLAB_HOST
```

## 仅在人类明确要求时使用手工 SSH 交接

此路径默认关闭，不作为缺少 Token 或 API 失败时的后备方案。
只有人类明确要求手工交接后，才使用本地 Schema/Profile 准备 Request：

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
harness-mrtool manual --auth ssh --input /absolute/private/request.json --input-format json --output json
```

审查输出中的 `title`、`description`、`targetBranch`、`sourceHeadSha` 和
`pushPlan`，确认后可显式推送普通分支：

```text
harness-mrtool manual --auth ssh --input /absolute/private/request.json --input-format json --push --output json
```

再由用户在 GitLab 网页创建 MR。此流程不读取 API Token，不选择实时标签或人员，
也不证明网页 MR 的标签状态。省略 `--auth ssh` 的 `manual` 不会自动启用交接。

Git 使用 SSH 时，需已有公钥和源项目推送权限，可用 `ssh -T git@gitlab.example.com`
检查；不要上传私钥。普通 SSH push 只更新分支，不会创建 MR，也不会绕过受保护分支。

`manual --ssh-mr`（包括同时传入 `--push`）返回 `LABEL_ERROR`，在规划或
执行 push 前停止。不再提供无标签的 `merge_request.create` 绕过路径。

## 状态与失败处理

| 状态 | 含义 | 操作 |
| --- | --- | --- |
| `manual` | 人类明确要求的本地交接材料和普通分支推送计划 | 确认后显式 `manual --auth ssh --push`，再在网页创建 MR |
| `LABEL_ERROR`（`--ssh-mr`） | 在 push 前拒绝 SSH MR 创建 | 使用默认 API 验证路径 |
| `AUTH_ERROR` | API 模式没有可用 Host-scoped Token | 停止并配置 API 凭据，不自动回退 manual/SSH |
| API 请求失败 | 当前 API 操作失败或结果未证明 | 按输出安全下一步处理，不自动回退 manual/SSH |
| `REPOSITORY_ERROR` | Remote、权限或分支不满足 | 检查 remote、分支权限和当前 Git 传输配置 |
| `PARTIAL_WRITE` | MR 已创建且状态已回读，但事务未完成 | 按输出的 safeNextStep 用 `update <iid>` 或 `create --resume` 继续，不要重新 create |
| `PARTIAL_REMOTE_STATE` | 远端写入结果无法证明 | 先读取远端/MR 状态，不要立即重试 |

## 验收清单

- [ ] 默认 CLI/Skill 使用 API，`--auth auto` 不触发 SSH fallback。
- [ ] 缺少 Token 或 API 失败时停止，不自动生成 manual handoff。
- [ ] Git 源分支已发布；若 Git remote 使用 SSH，传输仍可正常使用。
- [ ] 仅在人类明确要求时运行 `manual --auth ssh`；它不读取 GitLab API，也不要求 Token。
- [ ] 普通推送不 force push，且执行前后校验本地/远端 SHA。
- [ ] `--ssh-mr`（含 `--push`）返回 `LABEL_ERROR`，未规划或执行 push。
- [ ] 全局 `push.pushOption` 不会注入或覆盖工具生成的选项。
- [ ] 标签、负责人和审核人不会被 SSH 模式猜测或自动创建。
- [ ] 默认 API 模式可执行完整 `context -> preview -> create/update -> verify`。
- [ ] 普通 manual handoff 或分支 push 不会报告为已验证 MR。
- [ ] `--dry-run` 无远端写入且不消费 context；最终标签恰好三个且无 week/额外标签。

以上是待执行的验收清单，不是本次已通过的现场验收记录。
