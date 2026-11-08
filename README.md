# harness-mrtool

一个根据 **Git 已提交的真实 diff** 准备、创建、更新和验证 **GitLab Merge Request** 的 CLI。
AI/人负责填写变更说明，工具负责输入校验、自动标签、写前复核、写后回读和审计；
不是 GitLab 服务端合并门禁，也不能限制绕过工具的网页或原始 Git/API 操作。

> **版本状态**：当前 main 已实现强制标签策略（Template Bundle **1.2.0**）。
> CLI/Plugin **0.1.9** 是待验收发布候选，不代表已有可安装的新 Release。
> 既有 [CLI 0.1.5](https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.5)
> 和 [Plugin 0.1.5](https://github.com/chengcheng93/harness-mrtool/releases/tag/plugin-v0.1.5)
> 不包含本次强制标签改造。新版尚未发布，完成发布后才更新正式下载链接。
> 当前体验方式为源码构建；请同时核对源码提交和 `schema show` 返回的模板版本。

## 1. 先选使用方式

| 需求 | 路径 | 是否需要 GitLab API Token | 保证范围 |
| --- | --- | --- | --- |
| 默认：工具自动选择标签、创建/更新 MR、回读确认 | `context` → `create/update` → `verify` → 返回 MR 链接（默认 `--auth api`） | 是 | 经过强制标签和事务验证的 MR 操作 |
| 看将要写入什么，不提交 | `preview` 或 API `create/update --dry-run` | API 路径需要 | 零远端写入，不消费候选上下文；仍可能读网络 |
| 仅在人类明确要求手工交接时：生成标题/正文，自己在 GitLab 创建 MR | `manual --auth ssh` | 否 | 本地交接材料；可显式推送普通分支，**不保证网页创建的 MR 标签** |

CLI 与 Skill 默认通过 API 完成自动 MR 流程。用户要求提交或更新 MR 即为本次操作授权：
后台校验后直接 `create/update`、`verify`，成功返回 MR 链接，不再展示预览或重复确认。
只有用户主动要求预览时才运行 `preview` 或 `--dry-run`；缺少必要信息、类型歧义或执行失败时才中断。
未传 `--auth` 时使用 `api`；
`--auth auto` 仅保留为 API 选择的兼容写法，不会回退 SSH。缺少 Token 或 API
请求失败时停止并报告问题，不自动切换到 manual/SSH 交接；只有人类明确要求
手工交接时才使用 `manual --auth ssh`。`manual --ssh-mr` 已被禁用，
返回 `LABEL_ERROR` 并在 push 前停止；它不是 API 标签验证的替代方案。

## 2. 安装与源码运行

### 源码运行本分支

要求 Git、npm 和 **精确的 Node 24.16.0**。不要修改版本门禁来适配其他 Node 版本。
macOS 本地进程锁还需要系统 Perl 的 `flock`。本地 Darwin 构建通过不代表已提供 macOS 正式安装包。

```sh
git clone --branch release-candidate-0.1.0 git@github.com:chengcheng93/harness-mrtool.git
cd harness-mrtool
node --version                         # 必须是 v24.16.0
npm ci
npm run build
```

然后定义一个便利命令（Bash/Zsh）；**`MRTOOL_HOME` 指向工具仓库，不是业务仓库**：

```sh
export MRTOOL_HOME="$(pwd)"
hmr() { node "$MRTOOL_HOME/dist/main.cjs" "$@"; }
cd /absolute/path/to/your-business-repository
hmr version --output json
hmr schema show --output json
```

PowerShell 对应写法：

```powershell
$env:MRTOOL_HOME = (Get-Location).Path
function hmr { & node (Join-Path $env:MRTOOL_HOME 'dist/main.cjs') @args }
Set-Location 'C:\path\to\your-business-repository'
hmr version --output json
hmr schema show --output json
```

以下示例均用 `hmr`。如果你安装的是包含所需功能的正式 CLI，可将其替换为
`harness-mrtool`。**所有 MR 命令都在目标业务 Git 仓库内运行。**

### 已发布安装包与 AI 插件

已有 Windows x64 安装包及安装脚本见 [发布页](https://github.com/chengcheng93/harness-mrtool/releases)
和 [API 默认流程与操作手册](docs/usage/ssh-first-operation-manual.md)。按发布流程验证归档、
SHA256SUMS 和签名 receipt；不要把本机生成的 Darwin `dist/harness-mrtool.exe` 当成 Windows EXE。

[Plugin 源码](plugins/harness-mrtool/) 和 [独立 Skill](skill/harness-mr/SKILL.md)
用于让 AI 按 CLI 合同填写输入；它们**不包含 CLI 二进制**。CLI 与插件需匹配，更新源码
不等于已更新插件或已激活 Skill。插件安装说明见上述操作手册；不使用 AI 插件也可直接运行 CLI。

## 3. 准备业务仓库和认证

### Git 前置条件

- 当前位于自己的功能分支；MR diff 与分支推送只使用已提交的 `HEAD`。
- staged、unstaged 和 untracked 文件（包括 `.superpowers` 报告）均可保留，不要求工作区干净；工具不自动 add、stash、clean 或删除文件。
- remote 指向正确的 GitLab 项目，目标项目/默认目标分支能够识别，目标跟踪引用保持最新。
- **API MR 命令不自动 push**：源分支必须已经发布，并且远端源 SHA 与当前提交一致。
- `request.targetBranch` 必须与工具发现的目标分支一致，不要直接照抄示例中的 `develop`。

```sh
git status
git remote -v
git fetch origin
# 检查并提交自己的改动之后，检查将要推送的分支/提交：
git push -u origin HEAD
hmr doctor --auth api --output json
```

`git push` 是实际远端写入；按用户已授权的目标直接执行，不增加审批。后续每次代码或远端引用变化，都重新获取 context。
Git remote 可以继续使用 SSH 推送分支；Git 传输方式与创建 MR 的 API 认证方式相互独立。
GitLab API 支持 HTTP 和 HTTPS。显式 `http://` / `https://` remote 保留原协议；
SSH/scp/git remote 推断 API 地址时优先 HTTP，HTTP 不可用时兼容尝试同主机 HTTPS。

### 安装后立即初始化 GitLab

先执行只读 `hmr auth check --output json`，验证 host、Token 和 API 权限，不能仅凭插件安装成功宣称工具可用。
Windows 安装器会立即运行安全配置向导；已有 CLI 可用 `scripts/setup-gitlab.ps1`。缺授权时明确报告初始化未完成。
详见[安装后 GitLab 初始化](docs/usage/gitlab-initialization.md)，包括隐藏 Token 输入、非交互处理、旧 Codex 进程重启及 SessionStart hook 的信任边界。

### API Token（自动 MR 功能必须配置）

默认凭据适配器读取以下 **host-scoped 环境变量**。Host 与 Git remote 对应，只填写主机，
不要带 `http://`、`https://` 或项目路径。Token 需具备所需 GitLab API 读写权限及目标项目访问权。
**不得把 Token 写进命令参数、remote URL、Request JSON、仓库或聊天。**

Bash 使用隐藏输入，避免在历史中保存 Token 字面量：

```bash
export HARNESS_MRTOOL_GITLAB_HOST='gitlab.example.com'
read -r -s -p 'GitLab API token: ' HARNESS_MRTOOL_GITLAB_TOKEN
printf '\n'
export HARNESS_MRTOOL_GITLAB_TOKEN
```

Zsh 将 `read` 那一行替换为：

```zsh
read -r -s 'HARNESS_MRTOOL_GITLAB_TOKEN?GitLab API token: '
```

PowerShell 7 可使用隐藏输入：

```powershell
$env:HARNESS_MRTOOL_GITLAB_HOST = 'gitlab.example.com'
$env:HARNESS_MRTOOL_GITLAB_TOKEN = Read-Host 'GitLab API token' -MaskInput
```

用完后执行 `unset HARNESS_MRTOOL_GITLAB_TOKEN HARNESS_MRTOOL_GITLAB_HOST`；PowerShell
使用 `Remove-Item Env:HARNESS_MRTOOL_GITLAB_TOKEN, Env:HARNESS_MRTOOL_GITLAB_HOST`。
不要打印这些变量。环境中的秘密仍需由本机账号/进程安全边界保护。

只有人类明确要求的 `manual --auth ssh` 手工交接不需要 API Token。若 Git 传输
使用 SSH，需事先把自己的 SSH 公钥配置到 GitLab，并验证
`ssh -T git@gitlab.example.com`；不要上传私钥。API 认证失败不会授权改走此路径。

## 4. 第一次使用：推荐交互向导

在真实终端中，不传 `--input` 时会启动向导。先配置会等待编辑结束的编辑器，例如
`export EDITOR=vi`；Windows 可用 `$env:EDITOR = 'notepad.exe'`。
使用其他编辑器时确保它不会启动后立即退出（例如 VS Code 需要 `code --wait`）。

```sh
hmr profiles detect --output json
hmr create --auth api --output json
```

向导收集缺少的 Profile、人员、风险和验证信息，并打开编辑器填写长文本，完成后直接创建。
标签由 CLI 自动计算，默认 p2，不再要求接受自动标签或询问是否提优先级。
注释和文档改动自动归为 doc，未知或歧义类型自动归为 chore；不再询问类型、标签或哈希确认。显式提升优先级仍要求理由。不要将尚未执行的测试填写成通过。

**交互 dry-run 和正式 create 是两次独立收集，不自动复用上次编辑内容。**
希望先预览再原样提交同一个 Request，请使用下面的 JSON 流程。
非终端/CI 中不应依赖向导，必须提供结构化输入。

## 5. 可重复执行的 JSON 流程

### 5.1 查看合同，获取真实候选上下文

```sh
hmr schema show --output json
hmr profiles list --output json
hmr profiles detect --output json
hmr labels list --auth api --output json
hmr context --auth api --output json
```

输出是 JSON envelope：业务数据在 `data`，先检查 `ok` / `code`。
用本次 `context` 的 `data.contextId` 填写 Request；负责人和审核人 token 来自
同一次 `data.userCandidates`。**不要编造 token，也不要复用已消费或陈旧的 context。**
`mergeRequest.labelCandidateTokens` 使用 `[]`，不再手选 type/priority/status/week。

### 5.2 填写 Request

复制 [输入样例](examples/request.json) 到**业务仓库之外**的私有目录：

```sh
mkdir -p /absolute/private/mr-input
cp "$MRTOOL_HOME/examples/request.json" /absolute/private/mr-input/request.json
```

样例仅提供结构，**不能不修改就提交**：

| 字段 | 如何填写 |
| --- | --- |
| `contextId` | 刚取得的 `data.contextId` |
| `profileIds` | 根据 `profiles detect/list` 及实际变更填写；样例为 code |
| `targetBranch` | 工具发现的目标项目默认分支 |
| `title`、`changes`、`motivation`、`impact`、`risk` 等 | 替换为本次真实内容；标签 type 由程序从真实 diff 自动选择 |
| `verification.items` | 填写真实证据；没验证就是 pending，不能保留示例当验收证据 |
| `profileFields` | 按选中 Profile 补充；例如 docs 有额外必填字段 |
| `mergeRequest.assigneeCandidateToken`、`review.reviewerCandidateTokens` | 来自本次 context；审核人可以为空，之后在 GitLab 中添加，工具不强制最少人数 |
| `mergeRequest.labelCandidateTokens` | 保持 `[]`，CLI 自动选标签 |

输入文件可放在私有目录，避免把人员信息/说明误提交进仓库；它不影响基于已提交 `HEAD` 的 MR 流程。
完整合同以当前 `schema show`、`profiles list` 和验证错误为准。

### 5.3 直接创建 → 验证 → 返回链接

```sh
hmr create --auth api --input /absolute/private/mr-input/request.json --input-format json --output json
hmr verify 88 --auth api --level structure --output json
```

把 `88` 换成实际 MR IID。普通流程不要求额外确认，验证通过后返回真实 MR 链接。
只有主动要求预览时才执行以下可选命令，它们不是创建前置步骤：

```sh
hmr preview --auth api --input /absolute/private/mr-input/request.json --input-format json --output json
hmr create --auth api --input /absolute/private/mr-input/request.json --input-format json --dry-run --output json
```

`preview` 和 dry-run 不写 GitLab、不 push、不消费候选；
成功写入会消费相应上下文，重试/下一次更新请重新获取。
`create --upsert` 可复用同分支已有 MR，但必须验证该 MR 的 receipt 和精确历史模板；
若历史 Bundle 不同，按错误提示改走 `context --mr` + `update`，不能跳过认证。

如果 `create` 已经创建了 MR，但在写入最终 description 前中断（返回 `PARTIAL_WRITE`），可以直接改用
`update <iid>` 继续；也可以保留原始 Request 文件和私有证明，修复阻断后重新
运行普通 `context`（不加 `--mr`），把原来选中的人员映射到新候选票据，其余 Request 内容保持
一致，然后显式恢复已有 MR：

```sh
hmr create --resume 157 --resume-from /absolute/private/original.json --input /absolute/private/fresh.json --dry-run --output json
hmr create --resume 157 --resume-from /absolute/private/original.json --input /absolute/private/fresh.json --output json
hmr verify 157 --level structure --output json
```

恢复要求 MR 仍处于 open 状态、原始 provisional 描述完全不变，且远端恰好处于以下正常事务前缀之一：

- 标签为空，assignee/reviewers 为空。
- 标签恰好为计划的完整三标签组（type、priority、`status::review`），assignee/reviewers 仍为空。
- 同一完整三标签组，assignee/reviewers 全部与计划一致。

标题、目标分支、squash 和删除源分支选项始终须匹配原计划。部分/额外标签、混合字段、描述编辑、
已定稿描述均拒绝恢复；旧版工具留下的半成品 MR 不能恢复，改用 `update <iid>`（见第 7 节）。
核对项目、分支、提交、模板和新旧候选身份后，正常事务跳过已完整
写入的标签和 metadata，继续剩余步骤。它不创建第二个 MR，不把过期票据重新变成写权限，
也不代替普通 `update` 的回执校验；`verify` 只验证存储状态，不恢复事务。
私有上下文的历史证明保留至过期后 24 小时，最多 16 条；原始文件、私有证明丢失或计划变化时
会拒绝恢复。恢复时程序重新计算类型和 diff 绑定，不需要人工确认或复用确认参数。

## 6. 自动标签规则

| 类别 | 固定池 | 规则 |
| --- | --- | --- |
| type | feature / bug / doc / test / refactor / performance / build / ci / chore | 从真实 diff 自动判定；注释/文档为 doc，无法细分为 chore |
| priority | p0 / p1 / p2 | 默认 p2；p0/p1 需要理由 |
| status | review | 每个 MR 都写入 `status::review`；项目不再需要 `status::doing` |

实际远端名称带前缀，例如 `type::bug`、`priority::p2`、`status::review`。
目标项目或祖先组必须已有可唯一解析的所需标签；工具**不会创建标签定义**。
最终 MR **恰好三个标签**：更新时既移除旧 week，也移除池外人工标签关联，
不是仅增加三个标签，更不是删除远端标签定义。

类型完全由程序决定，不接受人工类型确认参数。注释和纯文档修改使用 `type::doc`，
确定的其他改动使用对应类型；未知或混合且无法细分时使用 `type::chore`。
`diffDigest` 只用于自动校验当前提交与计划一致，程序不会要求用户复制或输入它。
`--type` 只是标题提示，不能覆盖真实 diff 的自动标签。

显式提升优先级时，在 create/update 中提供参数和理由；如主动要求预览，沿用同样的参数：

```sh
hmr create --auth api --input /absolute/private/mr-input/request.json --priority p1 --priority-reason '说明本次为何需要优先处理' --output json
```

## 7. 更新、历史模板和显式迁移

普通更新沿用 MR 的可信历史 Bundle；先取得 **update 专用 context**，更新 JSON 中的
contextId/人员 token，然后直接更新并验证（不要拿 create 的 context 更新 MR）：

```sh
hmr context --mr 88 --auth api --output json
hmr update 88 --auth api --input /absolute/private/mr-input/request.json --output json
hmr verify 88 --auth api --level structure --output json
```

未受管的手工 MR、丢失/不可信的 receipt、正文被手工修改等情况默认拒绝，不会自动接管。
`update` 依次同步标签、写入受管字段、写入最终 description 并回读；对旧版工具创建、标题仍带旧前缀的半成品
MR 执行一次 `update`，会按 `[type][module] 摘要` 重写标题并打上 `status::review`，使其成为普通 MR。
`--force-replace-description` 只用于明确决定覆盖受管正文的情况，不能绕过 marker/receipt 认证。
私有状态目录包含候选、回执、信任状态，不能把删除状态当成“修复”方案。

旧模板升级时，获取 **migrate 专用 context**，程序自动绑定和校验旧/新 manifest hash：

```sh
hmr context --mr 88 --migrate-template --auth api --output json
hmr update 88 --migrate-template --auth api --input /absolute/private/mr-input/request.json --output json
```

先更新 Request 中的迁移 contextId/人员 token。交互与非交互迁移都由程序校验
精确 old:new 绑定，不要求用户输入哈希或再次确认。
历史资产不可用、无签名锚点或文件被篡改时停止，不以当前模板冒充旧模板。

## 8. 仅在人类明确要求时使用手工 SSH 交接

默认不启用此路径。只有人类明确要求手工交接后，才准备符合 Schema 的 JSON 并执行
`manual --auth ssh`；`manual` 省略认证选项时不会自动选择 SSH：

```sh
hmr manual --auth ssh --input /absolute/private/mr-input/request.json --output json
# 审查生成的 title、description、targetBranch、sourceHeadSha、pushPlan 后再推送普通分支：
hmr manual --auth ssh --input /absolute/private/mr-input/request.json --push --output json
```

输出供用户在 GitLab 网页创建 MR；它不是已验证的 MR。SSH handoff 不需要 API context
或真实候选 token，CLI 对手工交接请求进行专门归一化；不要因此把 API 的 context/token
规则省略。`manual --ssh-mr` 即使配合 `--push` 也会被拒绝。

## 9. 常见问题

| 现象 | 处理 |
| --- | --- |
| `AUTH_ERROR` | 停止 API 流程，核对 host 与 remote 一致、Token 有效且有项目权限；不自动回退 manual/SSH，不打印 Token |
| `REPOSITORY_ERROR` | 检查功能分支、目标引用和已提交的源 SHA；源提交未发布就先 push，再刷新 context |
| `LABEL_ERROR` | 检查所需远端标签是否存在/唯一及 diff 是否有效；类型由程序自动选择 |
| `CONCURRENT_UPDATE` | 代码、引用、人员或标签已经漂移；重新读取 context 和计划，不复用旧授权 |
| `MANUAL_DESCRIPTION_CHANGE` / `UNMANAGED_MR` | 核对正文所有权和历史 receipt；不要盲目强制覆盖 |
| `UPDATE_SECURITY_ERROR` | 检查签名历史资产/信任状态；不得跳过校验、伪造回执或用新模板顶替旧模板 |
| `PARTIAL_WRITE` | MR 已创建且状态已回读，但事务未完成；按输出的 audit 和 safeNextStep 用 `update <iid>` 或 `create --resume` 继续，不能盲重试创建 |
| `PARTIAL_REMOTE_STATE` | 远端写入结果无法证明；先读取 MR 实际状态，不能盲重试创建 |
| `Structured input is required` | 当前不是 TTY；提供 `--input` 和完整 JSON，或在真实终端运行向导 |

自动化调用同时检查退出码、`ok`、`code`、`remoteWrite` 和审计结果。
API 错误按输出的安全下一步处理；不得以网络、权限或凭据问题为由自动改走 SSH 交接。
`doctor` 的命令成功不代表所有诊断项通过，必须看 `data.checks`。
`--offline` 不支持 live create/update/verify；`--no-update` 不代表跳过业务/签名/标签校验。

## 自更新与发布候选的当前边界

当前候选的 `self-update check` 已接入固定更新源、签名验证和持久化信任状态：

```sh
hmr self-update check --output json
hmr self-update check --force --output json
```

该命令只报告经过认证的候选元数据，**不会安装**。缓存回退会明确标记未确认最新版本；
`--offline` / `--no-update` 与显式网络检查冲突时拒绝请求。固定源不可用或验签失败，
不能改用任意 URL 或跳过签名。`apply`、`rollback`、正式平台安装和宿主激活仍在收尾，
在完整验收完成前不要将候选文档视为“自动更新已可用”的承诺。

发布工作流已增加版本一致性、Template/Skill 实际签名与归档内容校验；Mac ARM64
原生打包和 CI 已纳入候选代码，但尚无对应正式安装包的发布/安装成功声明。

## 10. 开发验证与更多文档

在工具源码目录执行：

```sh
npm ci
npm run typecheck
npm run build
npm run build:sea                 # 全量测试中的 SEA smoke 依赖当前源码对应的产物
npm test -- --test-concurrency=1
```

默认生产入口是 `src/production-main.ts`，源码和构建产物使用同一组服务。
生产信任根由源码固定；历史模板需要正确签名链，不能通过参数或 JSON 更换信任根。
本次本地验收（含 README 命令/样例校验）为 **1399 项 / 1391 通过 / 0 失败 / 8 个 Windows 专属跳过**。
Windows CI、正式签名发布、真实 GitLab 与真实插件宿主验收属于独立外部步骤。

- [完整命令说明](docs/commands/reference.md)
- [标签选择策略](docs/usage/label-selection-policy.md)
- [API 默认流程与操作手册](docs/usage/ssh-first-operation-manual.md)
- [认证与信任边界](docs/security/authentication.md)
- [架构](docs/architecture/harness-mrtool-architecture.md)
- [本次逐需求验收与外部边界](docs/verification/mandatory-labels-2026-09-14.md)
- [发布验收门槛](docs/verification/external-gates.md)
