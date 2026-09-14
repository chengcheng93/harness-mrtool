# harness-mrtool

`harness-mrtool` is a deterministic CLI for preparing, previewing, creating,
updating, and verifying GitLab merge requests from repository changes. A
GitLab token is optional: the default path is SSH-first and the `manual`
command generates a token-free title, description, and SSH push plan for a
user-created MR. The API path remains available explicitly with `--auth api`.

## Working-tree changes (unreleased)

The default production entry now wires API `create`, `create --upsert`, `update`,
and `verify`, including the automatic-label wizard. This is an implementation
status, not a published release or evidence of live GitLab acceptance.

Template Bundle `1.1.0` requires exactly three labels from a fixed 14-label pool:
one type from the canonical actual committed diff, one priority (`p2` by default),
and one lifecycle status (Draft: `doing`; Ready: `review`). Unknown or ambiguous
diffs require explicit type confirmation bound to the CLI's diff digest;
priority escalation to `p0`/`p1` requires a reason. Week labels are retired, and
updates replace extras so the final set is exactly three. Required labels must
already exist in the project/ancestor-group inventory; the CLI never creates
remote labels. See [label selection policy](docs/usage/label-selection-policy.md).

`preview` and API create/update `--dry-run` perform no remote writes and do not
consume candidate contexts. Upsert authenticates the existing MR's receipt;
if its Bundle differs from the create context, use `context --mr <iid>` followed
by `update <iid>`, or an explicit template migration—not a current-Bundle fallback.
Previously signed historical policies remain readable with trusted evidence.
The production migration adapter requires explicit old:new manifest-hash
confirmation and authenticated historical receipts. Controlled integration tests
cover 1.0.0-to-1.1.0 migration; they do not replace live GitLab or release acceptance.

SSH-only `manual --ssh-mr` is rejected with `LABEL_ERROR` before push planning or
execution. Ordinary manual handoff/push remains available, but is not a verified
MR. These guarantees apply to `harness-mrtool`, not raw Git/API calls or GitLab UI
operations outside it.

使用说明（原理、实现逻辑、安装、配置和命令示例）：
[Notion-ready 使用手册](docs/usage/harness-mrtool-notion.md)

SSH-first 迁移、验收和排障：
[SSH-first 操作手册](docs/usage/ssh-first-operation-manual.md)

既有 Windows x64 Release 链接（不代表以上未发布变更已包含其中）：
<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.5>

既有 Codex Plugin 构建产物链接（同样不代表本次变更已发布）：
<https://github.com/chengcheng93/harness-mrtool/releases/tag/plugin-v0.1.5>

插件源码位于 `plugins/harness-mrtool/`，其中包含 `.codex-plugin/plugin.json`
和 `harness-mr` Skill。插件依赖已安装的 `harness-mrtool` CLI；两者是两个
独立产物，分别按 CLI Release 和 Plugin Release 发布。

Codex CLI 安装方式（先安装 CLI，再安装插件）：

```text
codex plugin marketplace add chengcheng93/harness-mrtool --ref release-candidate-0.1.0
codex plugin add harness-mrtool@harness-mrtool
```

安装后请新开一个 Codex task/thread，再在目标 Git 仓库中使用
“准备当前分支的 merge request”之类的请求。

The repository pins Node `24.16.0` exactly. The macOS native process-lock
implementation also requires Perl (for `flock`); this is not a declaration of
macOS release support.

Local checks:

```text
npm ci
npm run typecheck
npm test
```

The production entry is `src/production-main.ts`; the same entry is used by
the application and SEA build configuration. Production update trust roots are
build-supplied. A source checkout without those roots fails closed with
`UPDATE_SECURITY_ERROR` and must not be treated as a release artifact.

GitLab credentials are host-scoped and never belong in argv, request bodies,
logs, or caller-supplied environment values. Update state and Skill activation
state are private, canonical, identity-checked records. Skill installation is
staged first; activation is explicit.

Windows SEA builds, release signing, immutable GitHub assets, isolated GitLab,
and a real Codex host remain external gates. See
`docs/verification/external-gates.md`.
