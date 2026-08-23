# harness-mrtool：原理、实现逻辑与使用手册

> 适合复制到 Notion 的项目说明文档
>
> 当前正式版本：`0.1.0`
> GitHub 仓库：<https://github.com/chengcheng93/harness-mrtool>
> Windows Release：<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.0>

## 1. 一句话理解

`harness-mrtool` 是一个确定性的 GitLab Merge Request CLI。它把“整理变更说明、选择标签和人员、创建或更新 MR、回读验证”编译成一条可审计的事务流程。

它不是聊天机器人，也不是 GitLab 的合并门禁。它不会自动合并 MR，不创建项目标签，不强制 push，不修改不属于自己管理范围的标签，也不把自然语言直接拼进 GitLab 请求。

## 2. 解决什么问题

人工或 AI 临时创建 MR 时，常见问题是：

- MR 描述格式不一致，缺少验证证据；
- 标签、负责人、审核人使用了错误名称或错误项目范围；
- 远端写入成功后没有回读，调用方误以为成功；
- 并发修改、网络超时或进程崩溃后，不知道 MR 实际处于什么状态；
- 更新程序、Skill 或模板被替换时，版本和内容不匹配；
- GitLab Token 出现在命令行、日志或错误输出中。

工具的核心目标是：只有当 GitLab 的最终状态、模板版本、验证证据和本地审计记录都符合合同，CLI 才返回成功。

## 3. 总体实现原理

```text
Human / Script / Codex Skill
          |
          v
  harness-mrtool CLI
    |       |       |
    v       v       v
 Local Git GitLab  Signed GitHub channel
                    |
                    v
             Immutable Releases

Private local state:
  context token / verified Bundle / update journal / Skill state / receipts
```

代码按“领域核心 + 外部适配器”组织：

| 层 | 主要职责 |
| --- | --- |
| `src/contracts` | 错误码、退出码、Request/Output 合同、JSON Canonicalization |
| `src/input` | 严格 JSON/YAML、UTF-8、重复键、大小和深度边界、Schema 校验 |
| `src/bundle` | Template Bundle、manifest、文件哈希、Profile 和 Policy |
| `src/render` | 标题、八段英文 MR 描述、诊断 marker、项目模板投影 |
| `src/context` | GitLab 候选快照、opaque token、TTL、私有状态文件 |
| `src/git` | 仓库身份、merge-base、ChangeSet、非强制 push 计划 |
| `src/gitlab` | GitLab REST/GraphQL 读取、分页、最小字段 mutation |
| `src/app` | preview/create/update/verify 业务状态机和事务审计 |
| `src/update` | 签名 channel、版本兼容、下载、激活、回滚和恢复 |
| `src/skill` | Skill 校验、暂存、显式激活和状态恢复 |
| `src/cli` | 命令行解析、交互向导、输出格式和退出码映射 |
| `src/platform` | 文件、锁、凭据、进程、Windows 原子替换等平台实现 |

领域层不直接依赖 HTTP、文件系统、进程或命令行。测试可以注入 fake Git/GitLab/文件系统，验证真实业务逻辑而不是只测 mock 包装层。

## 4. 一次 create 的实现逻辑

### 4.1 启动和更新预检查

每个业务命令先加载内置的 Bootstrap Template Bundle，并检查是否存在更高的可信版本。普通检查使用短网络预算；网络不可用时，如果本地存在已验证的 last-known-good 版本，可以继续离线业务。

生产构建内置固定的 GitHub 仓库、Pages 来源和 Ed25519 公钥。调用方不能通过命令行传入任意更新 URL 或公钥。

### 4.2 读取本地 Git 和 GitLab 上下文

CLI 会解析：

1. 当前 Git 仓库和 remote；
2. source project、target project、source branch、target branch；
3. target ref、merge-base、source HEAD；
4. 项目和祖先组的标签；
5. 项目成员、Issue、已有 MR 和 GitLab 能力。

这一步生成 `ExternalContextSnapshot`。标签和人员不会直接返回可伪造的名称或 GitLab 原始 ID，而是返回绑定到当前 Host、Project、类型、Bundle 和过期时间的 opaque candidate token。

token 默认只在短时间内有效，原始 token 不落盘；本地只保存 SHA-256 digest。`create`/`update` 使用 token 时还会重新向 GitLab 验证对象存在、未归档、范围正确且没有被重命名或删除。

### 4.3 输入标准化和确定性渲染

输入可以来自交互向导、YAML 文件或 JSON stdin。输入经过：

```text
bytes
  -> strict JSON/YAML parser
  -> UTF-8 / size / depth / duplicate-key checks
  -> request-v1 Schema
  -> context token resolution
  -> Bundle + Profile composition
  -> normalized Request
  -> deterministic title + eight-section Markdown
```

相同的 `Request + Bundle + CLI protocol + ExternalContextSnapshot` 必须生成相同的标题和正文。固定 heading、checkbox、标签类别和诊断 marker 由 Bundle 所有，用户只能提供业务内容和合法候选 token。

### 4.4 preview

`preview` 只生成 WritePlan，不写 GitLab、不消耗候选 token。输出包含标题、Profile、标签计划、负责人/审核人计划、描述正文、验证证据和 source branch push 计划。

这一步是人工或 Codex 的确认点：先看 CLI 的结构化结果，再决定是否执行 `create` 或 `update`。

### 4.5 create 的远端事务

正常 create 顺序如下：

```text
检查是否已有同源 MR
        |
        v
创建 Draft MR（临时正文）
        |
        v
写入受管字段和最小标签 ADD/REMOVE
        |
        v
独立回读并校验真实状态
        |
        v
生成最终正文和 verification receipt
        |
        v
写入最终 description，再次回读
        |
        +--> intent=draft：结束
        |
        v
检查 ready gate，写入 ready 标签并切换 Ready
        |
        v
只读最终回读，返回成功
```

每一步都会写入事务 journal。远端 mutation 超时后不会盲目重试造成重复写入，而是先查询真实状态。若无法证明结果，返回 `PARTIAL_REMOTE_STATE`，而不是伪造成功。

`Ready` 是正常流程最后一次远端写操作；切 Ready 后只做只读回读。这样即使最后一步失败，也不会留下“正文还没写完但 MR 已 Ready”的可控流程错误。

### 4.6 update 的额外保护

更新已有 MR 时，CLI 要求 description 中存在由工具生成的诊断 marker，并且 marker 必须对应原始 Bundle 和 durable receipt。

如果用户手工改过受管正文，默认拒绝覆盖；只有显式 `--force-replace-description` 才能替换。没有合法 marker 的 MR 返回 `UNMANAGED_MR`，V1 不接管。

## 5. 更新、签名和恢复原理

### 5.1 为什么需要 Bundle receipt

MR description 中的 marker 可以被人工修改，所以不能作为唯一信任根。每个历史 Template Bundle 还需要签名 receipt，绑定：

- Release tag；
- Bundle manifest hash；
- 每个文件的 path、size、SHA-256；
- input/policy/skill protocol；
- signing sequence 和 key ID。

只有“签名 receipt + exact tag + manifest + 所有实际文件字节”全部通过，Bundle 才能进入 verified cache。

### 5.2 Release-set 原子激活

CLI、Template 和 Policy 通过一个 release-set 指针一起切换：

1. 下载到同卷 staging；
2. 验证大小、哈希、签名、归档路径和 Bundle；
3. 执行新 CLI self-test；
4. 写入并 fsync activation journal；
5. 原子发布版本目录；
6. 原子替换单一 release-set pointer；
7. 标记 journal committed，再清理旧版本。

因此业务只能看到完整旧版本或完整新版本，不能出现“新 CLI + 旧 Bundle”的混合状态。

### 5.3 Windows 单文件更新

Windows 不能可靠覆盖正在运行的 `.exe`。工具使用 staging handoff：新 exe 先自检并接管本次业务，旧进程退出后由 helper 原子替换正式 exe。替换失败会留下 pending journal，下次启动或 repair 再恢复；业务结果和安装持久化状态会分开报告。

## 6. Skill 的实现原理

`skill/harness-mr/SKILL.md` 是一个薄适配器，不复制 CLI 的 Schema、标签规则或 GitLab 业务逻辑。

Skill 每次调用：

1. 固定当前 Skill version 和 protocol；
2. 先执行 `harness-mrtool context`；
3. 只使用 CLI 返回的 Schema、Profile、候选 token 和 diff 证据；
4. 生成结构化 Request；
5. 执行只读 `preview`；
6. 展示 CLI JSON 并等待确认；
7. 把同一份 Request 通过 stdin 交给 `create`/`update`；
8. 原样保留 `ok`、`code`、partial state、activationRequired 和 hostRefreshMayBeRequired。

Skill 更新先进入 CLI 管理的 staging 目录，只有用户显式执行 `skill activate --version ... --path ...` 才会切换 active path。激活不会强制当前会话重新加载 Skill，宿主是否立即发现新 Skill 会通过状态字段明确报告。

## 7. 安装与首次使用

### 7.1 Windows 正式安装

当前 Release 支持 Windows x64。安装脚本会下载固定 tag 的 portable zip，校验 SHA-256，拒绝危险归档路径，运行 `self-test`，然后原子发布到默认目录 `%LOCALAPPDATA%\HarnessMrTool`。

PowerShell 示例：

```powershell
$tag = 'cli-v0.1.0'
$sha256 = 'a5fd31fa9efab0056e3e992d0d1a9afd84818d8150f0755905ac81120e13ac40'
$installer = Join-Path $env:TEMP 'harness-mrtool-install.ps1'

Invoke-WebRequest `
  -Uri "https://raw.githubusercontent.com/chengcheng93/harness-mrtool/refs/tags/$tag/scripts/install.ps1" `
  -OutFile $installer

powershell -ExecutionPolicy Bypass -File $installer `
  -Tag $tag `
  -Sha256 $sha256
```

安装完成后：

```powershell
$exe = Join-Path $env:LOCALAPPDATA 'HarnessMrTool\harness-mrtool.exe'
& $exe version --output json
& $exe self-test --output json
& $exe doctor --output json
```

安装脚本不会自动修改 PATH。后续可以继续使用上面的 `$exe` 路径，或把
`%LOCALAPPDATA%\HarnessMrTool` 手动加入当前用户的 PATH 后重新打开 PowerShell。
加入 PATH 后，下面的命令示例即可直接使用 `harness-mrtool`。

也可以直接从 Release 页面下载 `harness-mrtool.exe`；但推荐使用 portable zip 和安装脚本，因为脚本会验证完整归档、receipt、SHA256SUMS 和安装目录所有权。

### 7.2 配置 GitLab 认证

当前 CLI 使用 Host-scoped 环境变量作为可用的生产入口：

```powershell
$env:HARNESS_MRTOOL_GITLAB_HOST = 'gitlab.example.com'
$env:HARNESS_MRTOOL_GITLAB_TOKEN = '<只在本机输入，不要发给聊天或写入文件>'
```

Host 必须与当前 Git remote 对应。Token 不允许作为命令行参数，也不应写进 remote URL、Request、日志或 MR 正文。使用完成后可以清理当前 PowerShell 会话中的变量：

```powershell
Remove-Item Env:HARNESS_MRTOOL_GITLAB_TOKEN
Remove-Item Env:HARNESS_MRTOOL_GITLAB_HOST
```

### 7.3 最小工作流

在目标 Git 仓库目录执行：

```powershell
git status
git remote -v
harness-mrtool doctor --output json
harness-mrtool profiles detect --output json
harness-mrtool labels list --output json
```

最简单的人工模式：

```powershell
harness-mrtool create
```

向导会收集标题、变更、动机、影响、验证、文档、风险和审核信息，然后先创建 Draft 并按事务顺序完成回读验证。

### 7.4 文件或 stdin 模式

长文本推荐使用 YAML/JSON 文件，自动化和 Codex 推荐 JSON stdin：

```powershell
harness-mrtool context --output json

Get-Content .\mr-request.json -Raw |
  harness-mrtool preview `
    --input - `
    --input-format json `
    --non-interactive `
    --output json

Get-Content .\mr-request.json -Raw |
  harness-mrtool create `
    --input - `
    --input-format json `
    --non-interactive `
    --output json
```

`mr-request.json` 中的 `contextId`、`labelCandidateTokens`、`assigneeCandidateToken` 和 `reviewerCandidateTokens` 必须来自同一次 `context` 输出，不能手工编造标签名称或 GitLab ID。完整字段以当前 Bundle 为准，可用下面的命令查看：

```powershell
harness-mrtool schema show --output json
harness-mrtool profiles list --output json
harness-mrtool template export --profile general --destination .\MR-template.md --output json
```

### 7.5 更新和验证 MR

```powershell
harness-mrtool update 123 --input .\mr-request.yaml
harness-mrtool verify 123 --level structure --output json
harness-mrtool verify 123 --level ready --output json
harness-mrtool verify 123 --level merge --output json
```

三个 verify 等级都是只读：

| 等级 | 检查内容 |
| --- | --- |
| `structure` | marker、Bundle、标题、八段正文、受管字段 |
| `ready` | structure + Ready 所需标签、验证和状态 |
| `merge` | ready + 当前 MR、讨论、审批、CI 等合并前状态 |

## 8. 常用命令速查

| 命令 | 用途 | 是否写远端 |
| --- | --- | --- |
| `doctor` | 检查仓库、GitLab、Bundle、权限和能力 | 否 |
| `context` | 生成当前上下文和候选 token | 否 |
| `preview` | 生成确定性写入计划 | 否 |
| `create` | 创建或按 `--upsert` 更新 MR | 是 |
| `update <iid>` | 更新已有受管 MR | 是 |
| `verify <iid>` | 验证 MR 状态 | 否 |
| `profiles detect` | 根据 committed diff 检测 Profile | 否 |
| `labels list` | 读取实时标签候选 | 否 |
| `template show/export` | 查看或导出 Bundle 模板 | 否 |
| `self-update check/status` | 查看签名更新状态 | 否 |
| `self-update apply/rollback` | 应用或回滚已验证版本 | 可能修改本地安装 |
| `skill install` | 下载并暂存已验证 Skill | 修改本地 Skill staging |
| `skill activate` | 显式激活指定 Skill 版本 | 修改本地 active path |
| `skill status` | 查看 Skill 版本和激活状态 | 否 |

## 9. 输出和退出码

使用 `--output json` 时，stdout 只输出一份稳定的 `output-v1` JSON；日志只进 stderr。调用方应读取 `ok` 和 `code`，不能只看进程是否结束。

| 退出码 | 含义 |
| ---: | --- |
| `0` | 成功 |
| `2` | 输入或参数错误 |
| `3` | 认证错误 |
| `4` | GitLab 或仓库访问错误 |
| `5` | 更新安全或签名错误 |
| `6` | 已发生但无法完全证明的远端部分状态 |
| `7` | 内部错误 |

出现 `PARTIAL_REMOTE_STATE` 时不要立即重复执行 create。先运行 `context`、读取 MR 实际状态或使用 `verify`，确认远端结果后再决定下一步。

## 10. 安全边界

- GitLab Token 不进入 argv、日志、stdout、MR 正文或 verification receipt；
- remote URL 不允许携带用户名密码；
- 标签和人员必须来自当前 GitLab 上下文的 opaque token；
- 归档下载限制大小、重定向 Host、路径、设备名、符号链接和文件数量；
- Bundle、Skill 和更新必须经过大小、哈希、签名、兼容性和归档验证；
- 本地 context、journal、receipt 和 Skill 状态放在用户私有目录，并使用原子写入和恢复流程；
- 业务成功必须经过 GitLab 独立回读，不以 mutation 请求返回作为唯一成功依据；
- 工具不会创建标签、合并 MR、force push 或接管没有合法 marker 的 MR。

## 11. 当前版本的范围和未完成项

`cli-v0.1.0` 已完成 Windows x64 CLI Release、portable zip、Bundle receipt、SEA receipt、不可变 GitHub Release 和发布前后字节复核。

以下事项仍属于后续外部门禁，不应在当前版本中当作已完成能力：

- Linux/macOS 原生 SEA 和对应安装包；
- Signed GitHub Pages stable channel 的生产 Channel Envelope；
- `templates-vX.Y.Z` 和 `skill-vX.Y.Z` 产品 Release；
- 真实用户 Windows 安装、repair、uninstall、Skill activate 的完整端到端验收；
- 隔离 GitLab 集成和真实 Codex host 的外部环境验收。

## 12. 建议的实际使用顺序

```text
安装 Release
  -> 配置当前 GitLab Host 的 Token
  -> doctor
  -> context
  -> profiles detect / labels list
  -> create（人工向导）或 preview + create（自动化）
  -> verify structure
  -> 需要 Ready 时再显式更新为 ready
  -> verify ready / merge
```

最重要的使用原则只有三条：

1. 先 `preview`，再执行有副作用的命令；
2. 只回传 CLI 发放的 candidate token，不手填标签名或 GitLab ID；
3. 看到 `PARTIAL_REMOTE_STATE` 或 `UPDATE_SECURITY_ERROR` 时停止重试，先按输出中的安全下一步处理。
