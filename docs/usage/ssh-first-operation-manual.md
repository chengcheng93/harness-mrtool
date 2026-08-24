# SSH-first 使用与验收手册

## 目标

`harness-mrtool` 现在采用双通道：

- 默认 SSH-first：本地生成 MR 内容，通过 SSH 推送分支，再由用户在 GitLab 网页创建 MR。
- 可选 SSH Push Options：显式使用 `--ssh-mr` 请求 GitLab 创建基础 MR；Draft 请求会额外发送 `merge_request.draft`。
- API 完整模式：显式使用 `--auth api`，用于实时标签、负责人、审核人、已有 MR 更新和回读验证。

GitLab Token 不再是普通提交流程的前置条件。SSH 只负责 Git 传输，不会替代 GitLab API 的实时元数据能力。

## 安装

先安装 CLI，再安装 Codex Plugin：

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref release-candidate-0.1.0
codex plugin add harness-mrtool@harness-mrtool
```

安装后新开一个 Codex task/thread。进入目标 Git 仓库后使用“准备当前分支的 merge request”。

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

成功推送后，在 GitLab 网页中选择源分支和目标分支，粘贴标题/正文，然后手动选择标签、负责人和审核人。

## SSH Push Options（显式可选）

仅当目标 GitLab 支持 Push Options，且 Git 版本为 2.18 或更高时使用：

```text
harness-mrtool manual --auth ssh --ssh-mr --input request.json --input-format json --output json
harness-mrtool manual --auth ssh --ssh-mr --input request.json --input-format json --push --output json
```

工具只生成以下选项：

- `merge_request.create`
- `merge_request.target=<branch>`
- `merge_request.title=<title>`
- `merge_request.description=<description>`
- `merge_request.draft`（仅 Draft 请求）

工具不会通过 SSH Push Options 发送标签、负责人、审核人、目标项目、自动合并或删除源分支选项。原因是标签选项可能自动创建不存在的标签，且 Push Options 没有完整的审核人和回读能力。

输出状态为 `mrCreation=requested-unverified` 时，只能表示“已请求 GitLab 创建”，不能表示已验证创建。必须打开 GitLab 网页确认 MR 存在，再补充标签和审核人。

如果远端分支已经等于本地 SHA，工具会拒绝 `--ssh-mr`，因为没有新的 push 事件可以触发 GitLab MR 创建。此时使用普通 `manual --push` 或直接在网页创建 MR。

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

Token 不得进入命令行参数、Remote URL、Request、日志、MR 正文或聊天消息。使用结束后清理当前会话：

```powershell
Remove-Item Env:HARNESS_MRTOOL_GITLAB_TOKEN
Remove-Item Env:HARNESS_MRTOOL_GITLAB_HOST
```

## 状态与失败处理

| 状态 | 含义 | 操作 |
| --- | --- | --- |
| `manual` | 本地生成内容和普通 SSH 推送计划 | 确认后 `--push`，再在网页创建 MR |
| `ssh-mr` + `not-requested` | 只生成了 Push Options 计划 | 审查后重新加 `--push` |
| `ssh-mr` + `requested-unverified` | 推送完成，但没有 API/UI 回读 | 打开 GitLab 确认 MR，不能重复执行 |
| `AUTH_ERROR` | API 模式没有可用 Host-scoped Token | 改用 SSH，或配置 `--auth api` 所需环境变量 |
| `REPOSITORY_ERROR` | Remote、权限、分支或 SSH 不满足 | 检查 `git remote -v`、`ssh -T` 和分支权限 |
| `PARTIAL_REMOTE_STATE` | 远端写入结果无法证明 | 先读取远端/MR 状态，不要立即重试 |

## 验收清单

- [ ] Git Remote 为 SSH，`ssh -T` 成功。
- [ ] 普通 `manual --auth ssh` 不读取 GitLab API，也不要求 Token。
- [ ] 普通推送不 force push，且执行前后校验本地/远端 SHA。
- [ ] `--ssh-mr` 只发送批准的五类 Push Options。
- [ ] 全局 `push.pushOption` 不会注入或覆盖工具生成的选项。
- [ ] 标签、负责人和审核人不会被 SSH 模式猜测或自动创建。
- [ ] API 模式仍可执行完整 `context -> preview -> create/update -> verify`。
- [ ] 未回读的 SSH MR 创建结果不会报告为已验证成功。
