# SSH-first 使用与验收手册

## 目标

`harness-mrtool` 现在采用双通道：

- 默认 SSH-first：本地生成 MR 内容，通过 SSH 推送分支，再由用户在 GitLab 网页创建 MR。
- SSH MR 创建禁用：`manual --ssh-mr` 返回 `LABEL_ERROR`，在 push 规划或执行前停止。
- API 完整模式：显式使用 `--auth api`，用于实时标签、负责人、审核人、已有 MR 更新和回读验证。

GitLab Token 不再是普通提交流程的前置条件。SSH 只负责 Git 传输，不会替代 GitLab API 的实时元数据能力。

## 安装

先安装 CLI，再安装 Codex Plugin：

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref release-candidate-0.1.0
codex plugin add harness-mrtool@harness-mrtool
```

安装后新开一个 Codex task/thread。进入目标 Git 仓库后使用“准备当前分支的 merge request”。

源码运行精确固定 Node `24.16.0`。macOS native process lock 依赖 Perl 的
`flock`；这不代表已声明 macOS 发布平台验收通过。

## 一次性配置 SSH

```powershell
ssh-keygen -t ed25519 -C "your-email@example.com"
Get-Content "$env:USERPROFILE\.ssh\id_ed25519.pub"
```

把 `.pub` 公钥添加到 GitLab 的 `Preferences -> SSH Keys`。不要上传或粘贴私钥。

```powershell
ssh -T git@gitlab.example.com
git remote -v
```

如果 Remote 是 HTTPS，改为 SSH：

```powershell
git remote set-url origin git@gitlab.example.com:group/project.git
```

当前账号仍必须拥有源项目分支的推送权限。SSH 不会绕过 GitLab 受保护分支规则。

## 默认 SSH-first 流程

Plugin 会先读取本地 Schema 和 Profile，不要求 Token。CLI 等价流程如下：

```text
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
harness-mrtool manual --auth ssh --input request.json --input-format json --output json
```

审查输出中的 `title`、`description`、`targetBranch`、`sourceHeadSha` 和 `pushPlan`。确认后才允许远端写入：

```text
harness-mrtool manual --auth ssh --input request.json --input-format json --push --output json
```

普通 SSH push 只更新分支，不代表 MR 标签已完成。强制标签池使用一个类型、默认 `priority::p2` 和一个状态标签，不包含排期标签。需要由工具创建 MR 时必须经过 API 标签写入和回读链路；默认 production 入口已接入 create/update/upsert/verify 和自动标签向导，但这不是已发布或真实 GitLab 验收声明。不能用 SSH 基础 MR 创建替代。

## SSH MR 创建已禁用

`manual --ssh-mr` 返回 `LABEL_ERROR`，在规划或执行 push 之前停止。
SSH-only 路径没有标签库存校验和完整回读能力，因此不能声称满足强制标签流程。
不再提供无标签的 `merge_request.create` 绕过路径。

## API 完整模式

需要实时上下文和自动更新时显式选择 API：

```powershell
$env:HARNESS_MRTOOL_GITLAB_HOST = 'gitlab.example.com'
$env:HARNESS_MRTOOL_GITLAB_TOKEN = '<只在本机输入>'
```

```text
harness-mrtool doctor --auth api --output json
harness-mrtool context --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --output json
harness-mrtool preview --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
harness-mrtool create --auth api --client codex-skill --client-version <skill-semver> --skill-protocol <protocol> --input - --input-format json --output json
```

API 标签规则见[标签选择策略](label-selection-policy.md)：Bundle `1.1.0` 固定
14 标签池，最终恰好 type/priority/status 各一个；默认 p2，提升至 p0/p1 必须
提供理由，Draft/Ready 对应 doing/review。更新移除额外标签和 week 标签；
所需标签必须已存在，CLI 不会自动创建远端标签。类型来自绑定 HEAD/target/
merge-base 的真实 canonical diff；未知类型必须显式确认并绑定 CLI digest，
不能用标题提示代替。向导自动接入相同规则。

`preview` 和 API create/update `--dry-run` 无远端写入且不消费候选 context，
但仍可进行实时读取。`create --upsert` 认证已有 MR 的 receipt；Bundle 不同
时使用 `context --mr <iid>` 后 `update <iid>` 或显式迁移，不静默回退当前
Bundle。可信旧签名 policy 仍可读取；迁移 adapter 正在单独补齐，不在此
宣称完成或验收。这些保证仅覆盖 mrtool，不限制原始 Git/API 或网页操作。

Token 不得进入命令行参数、Remote URL、Request、日志、MR 正文或聊天消息。使用结束后清理当前会话：

```powershell
Remove-Item Env:HARNESS_MRTOOL_GITLAB_TOKEN
Remove-Item Env:HARNESS_MRTOOL_GITLAB_HOST
```

## 状态与失败处理

| 状态 | 含义 | 操作 |
| --- | --- | --- |
| `manual` | 本地生成内容和普通 SSH 推送计划 | 确认后 `--push`，再在网页创建 MR |
| `LABEL_ERROR`（`--ssh-mr`） | 在 push 前拒绝 SSH MR 创建 | 使用 API 验证路径，或仅生成普通 manual handoff |
| `AUTH_ERROR` | API 模式没有可用 Host-scoped Token | 配置 API 所需环境变量；仅需手工 handoff 时可改用 SSH |
| `REPOSITORY_ERROR` | Remote、权限、分支或 SSH 不满足 | 检查 `git remote -v`、`ssh -T` 和分支权限 |
| `PARTIAL_REMOTE_STATE` | 远端写入结果无法证明 | 先读取远端/MR 状态，不要立即重试 |

## 验收清单

- [ ] Git Remote 为 SSH，`ssh -T` 成功。
- [ ] 普通 `manual --auth ssh` 不读取 GitLab API，也不要求 Token。
- [ ] 普通推送不 force push，且执行前后校验本地/远端 SHA。
- [ ] `--ssh-mr`（含 `--push`）返回 `LABEL_ERROR`，未规划或执行 push。
- [ ] 全局 `push.pushOption` 不会注入或覆盖工具生成的选项。
- [ ] 标签、负责人和审核人不会被 SSH 模式猜测或自动创建。
- [ ] API 模式仍可执行完整 `context -> preview -> create/update -> verify`。
- [ ] 普通 manual handoff 或分支 push 不会报告为已验证 MR。
- [ ] `--dry-run` 无远端写入且不消费 context；最终标签恰好三个且无 week/额外标签。

以上是待执行的验收清单，不是本次已通过的现场验收记录。
