# harness-mrtool 发布收尾进展（2026-08-23）

## 当前结论

本次提交整理了 CLI 的安装器、便携包、Skill 打包、Windows 持久化/状态目录安全检查、发布契约测试和发布工作流基础设施。正式 CLI `0.1.3` 已完成 Windows SEA 构建、字节复核并发布为 GitHub 不可变 Release；该版本修复 PowerShell `ContentLength.HasValue`、`ZipArchive` 运行时兼容性以及生产更新信任 preflight 无条件失败的问题。

正式 Release：<https://github.com/chengcheng93/harness-mrtool/releases/tag/cli-v0.1.3>

修复版 Portable SHA-256：`dcd873807a61c008132272ad3f49930cbec7c8b4ce60d44590523ad8b839b469`。

## 发布候选整合状态

- 候选分支：`release-candidate-0.1.0`。
- 候选验证基线：`83647765ae4c17cece7a724cae07ef0ba124b2ba`（CI #107 已通过）。
- `main` 与 `publish/cli-release-pipeline-v2` 没有共同祖先，不能安全地按普通分叉合并。
- 候选以最新 `main` 为代码基线，只移植发布分支的工作流、安装器、打包器、发布契约测试和验收文档；没有把发布分支的旧生产入口覆盖回 `main`。
- 远端 `main`、原发布分支均未被覆盖。

## 本次正式发布准备

- 正式 CLI 版本：`0.1.3`，目标 Tag：`cli-v0.1.3`。
- 已生成第一把生产 Ed25519 根：`release-key-1`。
- 公钥指纹：`75f4bca790273aa6079eead3bb071db7cc9ead8442f3d9cb112249bec15d0eaf`。
- Bundle receipt 已按 `templates-v1.0.0`、当前 manifest 和全部模板文件哈希生成并签名；私钥和 Base64 Secret 保存在仓库外的受限目录，未写入 Git。
- GitHub Secret `BUNDLE_RECEIPT_B64` 已配置；正式 Tag `cli-v0.1.0` 已锁定到提交 `7b67ded5b0bfdf526b227832c61ce47d6e071732`。
- GitHub Release #3（Actions run `32635454627`）已成功完成，页面显示 `Immutable release`。
- Release #3 构建时仓库仍为私有，工作流在该次运行跳过了 GitHub Artifact Attestations，但完成了最终文件、归档和收据的完整字节校验；随后仓库已按发布要求切换为 Public，后续 Release 可启用 Artifact Attestations。

## 已确认的验证结果

- CI #107（`8364776`）：GitHub Actions 全部通过，使用 Node `24.16.0` 的 Windows runner 完成最终门禁。
- Portable tests：通过（2 分 43 秒）。
- Secret scan：通过，Gitleaks 报告 `No leaks detected`；历史测试夹具通过精确 `.gitleaksignore` 指纹处理。
- Windows SEA gate：通过（7 分 29 秒），生成并上传 Windows SEA 可执行文件及校验产物。
- 本地 `npm run typecheck`：在 Node `25.8.0` 上通过；项目正式门禁以 CI 的 Node `24.16.0` 结果为准。
- 发布、安装器、Bundle 和打包契约测试：`84 pass / 1 skip / 0 fail`。
- 全量 portable 测试已在 Windows CI 通过；macOS 本地运行仍可能受系统进程锁提供器限制，不作为发布门禁依据。
- Release #3 的构建、验收和发布三个 job 全部成功；Release 页面包含 `.exe`、portable `.zip`、Bundle receipt、SEA build receipt 和 GitHub Release attestation。
- Release CLI #4（Actions run `32644748847`）成功完成修复版构建、验收和不可变发布。
- Release CLI #5（Actions run `32646019146`）和 Plugin #5（Actions run `32646019087`）成功完成第二次兼容性修复发布。
- Release CLI #6（Actions run `32647676578`）成功发布 `cli-v0.1.3`，修复生产更新信任 preflight 无条件失败问题；Release 已确认 immutable。

## 本次纳入提交的内容

- PowerShell/Unix 安装器、卸载和 repair 脚本。
- portable zip 和 Skill zip 打包脚本。
- Release/CI 工作流与契约测试。
- Windows 原子可执行文件轮换和写入持久化辅助代码。
- Windows 私有状态目录及 ACL 校验增强。
- Skill bootstrap 的固定 GitHub Release 来源、重定向限制和下载大小限制。
- 安全、验证、故障排查和命令文档。

## 当前未完成的内容

- `templates-vX.Y.Z` 和 `skill-vX.Y.Z` 的产品 Tag/Release 仍未确定；本次只完成 CLI `0.1.0`。
- Signed GitHub Pages stable channel 尚未部署，Channel Envelope 的生产签名和端到端客户端拉取仍需单独验收。
- portable 安装、repair、uninstall、Skill install/activate 的真实用户环境端到端验收仍需补做；Release 工作流已完成构建和归档字节门禁，但不替代这些产品流程验收。
- 隔离 GitLab 集成和真实 Codex Skill host 仍是外部环境门禁。

## 正式发布已完成

1. `release-candidate-0.1.0` 在 GitHub Actions Windows runner 上完成 Node `24.16.0` SEA 构建。
2. `BUNDLE_RECEIPT_B64` 在构建 job 中解码，Bundle receipt、SEA receipt 和 portable archive 均通过发布前后字节复核。
3. 仓库已启用 Release immutability；工作流先创建草稿、下载复核资产，再发布不可变 Release。
4. Release `cli-v0.1.0` 已锁定到 `7b67ded`，正式安装资产可从 Release 页面下载。

## macOS 构建说明

这是 Node.js CLI 项目。普通 TypeScript/portable CLI 构建可以跨平台运行，但当前 `scripts/build-sea.mjs` 是 Windows 专用发布路径：它复制当前 Node 可执行文件、注入 SEA blob，并输出 `harness-mrtool.exe`，验证逻辑也使用 Windows 环境和 `.exe` 路径。

因此：

- macOS 可以运行 `npm ci`、typecheck、portable 构建和大部分测试；
- 当前 macOS 不能直接产出可发布的 Windows `.exe`；
- 若要发布 macOS SEA，需要新增 macOS 目标文件名、SEA 注入、可执行文件验证、权限/签名（如需要）和对应 CI runner；
- Windows 和 macOS 的 SEA 产物必须分别在各自平台构建，不能把一个平台的 Node 可执行文件跨平台注入后当作另一个平台产物。
