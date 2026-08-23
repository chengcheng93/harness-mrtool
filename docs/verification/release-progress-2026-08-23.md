# harness-mrtool 发布收尾进展（2026-08-23）

## 当前结论

本次提交整理了 CLI 的安装器、便携包、Skill 打包、Windows 持久化/状态目录安全检查、发布契约测试和发布工作流基础设施。当前**没有创建正式 Tag、没有推送、没有创建 GitHub Release**。

正式发布仍需在一台不受本机加密文件存储影响的 Windows 机器上完成 SEA 构建和最终验收。

## 已确认的验证结果

- `npm run typecheck`：此前通过。
- 安装器和 Release 契约测试：此前为 `19 pass / 1 skip / 0 fail`。
- 远端 `origin/main` 曾有开发构建 CI 验收记录：typecheck、回归测试和 Windows SEA 验收曾通过。
- 当前机器的工作区文件落盘会把若干源码写成二进制乱码，典型首字节为 `17 DA 5F A0 16 33 CD 9A`，导致：
  - `src/production-main.ts` 无法被 esbuild 读取；
  - `npm run build:sea` 报 `Unexpected "\\x17"`；
  - 因此本机不能作为最终发布构建机。

## 本次纳入提交的内容

- PowerShell/Unix 安装器、卸载和 repair 脚本。
- portable zip 和 Skill zip 打包脚本。
- Release/CI 工作流与契约测试。
- Windows 原子可执行文件轮换和写入持久化辅助代码。
- Windows 私有状态目录及 ACL 校验增强。
- Skill bootstrap 的固定 GitHub Release 来源、重定向限制和下载大小限制。
- 安全、验证、故障排查和命令文档。

## 明确未提交的内容

- `src/main.ts`：当前工作区中的磁盘内容已被本机加密/文件过滤影响，表现为二进制乱码；不能把该版本提交。
- `.tmp-acl-probe.ps1`：临时探针。
- `probe.zip`：临时探测产物。

提交后应在干净机器上从提交内容重新 checkout，并重点验证源码字节、模板 manifest、SEA 构建和非零字节 exe。

## 正式发布所需步骤

1. 在干净 Windows 环境使用 Node `24.16.0` checkout 本提交。
2. 执行 `npm ci`、`npm run typecheck`、完整测试和 `npm run build:sea`。
3. 确认 `dist/harness-mrtool.exe`、`dist/sea-build-receipt.json` 均为非零字节。
4. 运行 exe 的 `self-test`、contract probe、renderer probe。
5. 生成并注入明确标记为 development 的 Bundle Receipt；不得冒充生产签名 receipt。
6. 运行 portable 打包、SHA-256、安装器、repair、uninstall 和 Skill install/activate 验证。
7. 检查最终 diff 后，另行决定版本号、Tag、推送和 GitHub Release。

## macOS 构建说明

这是 Node.js CLI 项目。普通 TypeScript/portable CLI 构建可以跨平台运行，但当前 `scripts/build-sea.mjs` 是 Windows 专用发布路径：它复制当前 Node 可执行文件、注入 SEA blob，并输出 `harness-mrtool.exe`，验证逻辑也使用 Windows 环境和 `.exe` 路径。

因此：

- macOS 可以运行 `npm ci`、typecheck、portable 构建和大部分测试；
- 当前 macOS 不能直接产出可发布的 Windows `.exe`；
- 若要发布 macOS SEA，需要新增 macOS 目标文件名、SEA 注入、可执行文件验证、权限/签名（如需要）和对应 CI runner；
- Windows 和 macOS 的 SEA 产物必须分别在各自平台构建，不能把一个平台的 Node 可执行文件跨平台注入后当作另一个平台产物。
