# harness-mrtool

`harness-mrtool` is a deterministic CLI for preparing, previewing, creating,
updating, and verifying GitLab merge requests from repository changes.

使用说明（原理、实现逻辑、安装、配置和命令示例）：
[Notion-ready 使用手册](docs/usage/harness-mrtool-notion.md)

正式 Windows x64 Release：
<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.1>

Codex Plugin 构建产物：
<https://github.com/chengcheng93/harness-mrtool/releases/tag/plugin-v0.1.2>

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

The repository requires Node `24.16.0`:

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
