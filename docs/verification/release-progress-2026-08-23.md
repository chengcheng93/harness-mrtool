# harness-mrtool 发布收尾进展（2026-08-23）

## 当前结论

本次提交整理了 CLI 的安装器、便携包、Skill 打包、Windows 持久化/状态目录安全检查、发布契约测试和发布工作流基础设施。当前已推送发布候选分支，但**没有创建正式 Tag、没有创建 GitHub Release**。

正式发布仍需在一台不受本机加密文件存储影响的 Windows 机器上完成 SEA 构建和最终验收。

## 发布候选整合状态

- 候选分支：`release-candidate-0.1.0`。
- 候选验证基线：`83647765ae4c17cece7a724cae07ef0ba124b2ba`（CI #107 已通过）。
- `main` 与 `publish/cli-release-pipeline-v2` 没有共同祖先，不能安全地按普通分叉合并。
- 候选以最新 `main` 为代码基线，只移植发布分支的工作流、安装器、打包器、发布契约测试和验收文档；没有把发布分支的旧生产入口覆盖回 `main`。
- 远端 `main`、原发布分支均未被覆盖。

## 本次正式发布准备

- 正式 CLI 版本：`0.1.0`，目标 Tag：`cli-v0.1.0`。
- 已生成第一把生产 Ed25519 根：`release-key-1`。
- 公钥指纹：`75f4bca790273aa6079eead3bb071db7cc9ead8442f3d9cb112249bec15d0eaf`。
- Bundle receipt 已按 `templates-v1.0.0`、当前 manifest 和全部模板文件哈希生成并签名；私钥和 Base64 Secret 保存在仓库外的受限目录，未写入 Git。
- GitHub Secret、正式 Tag、Windows SEA 发布构建和 GitHub Release 仍待完成。
- 当前私有个人仓库不支持 GitHub Artifact Attestations；CLI Release 工作流已调整为在该环境跳过 Attestation，但仍执行最终文件、归档和收据的完整字节校验。

## 已确认的验证结果

- CI #107（`8364776`）：GitHub Actions 全部通过，使用 Node `24.16.0` 的 Windows runner 完成最终门禁。
- Portable tests：通过（2 分 43 秒）。
- Secret scan：通过，Gitleaks 报告 `No leaks detected`；历史测试夹具通过精确 `.gitleaksignore` 指纹处理。
- Windows SEA gate：通过（7 分 29 秒），生成并上传 Windows SEA 可执行文件及校验产物。
- 本地 `npm run typecheck`：在 Node `25.8.0` 上通过；项目正式门禁以 CI 的 Node `24.16.0` 结果为准。
- 发布、安装器、Bundle 和打包契约测试：`84 pass / 1 skip / 0 fail`。
- 全量 portable 测试已在 Windows CI 通过；macOS 本地运行仍可能受系统进程锁提供器限制，不作为发布门禁依据。

## 本次纳入提交的内容

- PowerShell/Unix 安装器、卸载和 repair 脚本。
- portable zip 和 Skill zip 打包脚本。
- Release/CI 工作流与契约测试。
- Windows 原子可执行文件轮换和写入持久化辅助代码。
- Windows 私有状态目录及 ACL 校验增强。
- Skill bootstrap 的固定 GitHub Release 来源、重定向限制和下载大小限制。
- 安全、验证、故障排查和命令文档。

## 当前未完成的内容

- `templates-vX.Y.Z` 和 `skill-vX.Y.Z` Tag 尚未确定或创建；CLI `cli-v0.1.0` Tag 尚未创建。
- Windows Node `24.16.0` SEA 构建、非零字节 exe、receipt 和三个 probe 已在 CI #107 的干净 Windows runner 完成。
- CLI 生产签名根和 Bundle Receipt 已准备；Channel Envelope、GitHub Secret 和 GitHub Release 资产尚未注入或发布。
- portable 安装、repair、uninstall、Skill install/activate 的完整 Windows 端到端验收仍需作为正式 Release 前的人工验收项。

后续应从候选分支重新 checkout，并重点验证源码字节、模板 manifest、SEA 构建和非零字节 exe。

## 正式发布所需步骤

1. 在干净 Windows 环境使用 Node `24.16.0` checkout `release-candidate-0.1.0`。
2. 执行 `npm ci`、`npm run typecheck`、完整测试和 `npm run build:sea`。
3. 确认 `dist/harness-mrtool.exe`、`dist/sea-build-receipt.json` 均为非零字节。
4. 运行 exe 的 `self-test`、contract probe、renderer probe。
5. 生成并注入明确标记为 development 的 Bundle Receipt；不得冒充生产签名 receipt。
6. 运行 portable 打包、SHA-256、安装器、repair、uninstall 和 Skill install/activate 验证。
7. 检查最终 diff 后，决定版本号并创建三类 immutable Tag；再按工作流顺序创建 GitHub Release，最后发布 stable channel。

## macOS 构建说明

这是 Node.js CLI 项目。普通 TypeScript/portable CLI 构建可以跨平台运行，但当前 `scripts/build-sea.mjs` 是 Windows 专用发布路径：它复制当前 Node 可执行文件、注入 SEA blob，并输出 `harness-mrtool.exe`，验证逻辑也使用 Windows 环境和 `.exe` 路径。

因此：

- macOS 可以运行 `npm ci`、typecheck、portable 构建和大部分测试；
- 当前 macOS 不能直接产出可发布的 Windows `.exe`；
- 若要发布 macOS SEA，需要新增 macOS 目标文件名、SEA 注入、可执行文件验证、权限/签名（如需要）和对应 CI runner；
- Windows 和 macOS 的 SEA 产物必须分别在各自平台构建，不能把一个平台的 Node 可执行文件跨平台注入后当作另一个平台产物。
