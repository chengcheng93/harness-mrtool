# 安装后立即完成 GitLab 初始化

安装 CLI 或插件后，先验证 GitLab API 授权，再将工具视为可用。网页登录、Git SSH 授权与 API Token 相互独立。初始化不会提交代码、推送分支或创建 MR，也不要求离开 develop 分支。

## Windows

Windows 安装器在已验证的二进制发布到目标目录后，立即运行授权检查。已有本机凭据会先检查；缺失时在交互终端提示 GitLab origin 和隐藏 Token 输入：

~~~powershell
.\scripts\install.ps1 -Tag <matching-cli-tag> -Sha256 <verified-release-sha256> -GitLabHost http://gitlab.example.com
~~~

安装器包含同源初始化实现，单独下载 install.ps1 也可使用，不会下载额外未验证脚本。若 CLI 已安装但授权未完成，安装器返回非零，并保留已安装的二进制。重试只配置授权，不重新下载安装包：

~~~powershell
.\install.ps1 -SetupOnly -Destination "$env:LOCALAPPDATA\HarnessMrTool" -GitLabHost http://gitlab.example.com
~~~

从源码构建或已装好匹配版本时，也可直接运行独立向导：

~~~powershell
.\scripts\setup-gitlab.ps1 -Executable D:\program\harness-mrtool\dist\harness-mrtool.exe -GitLabHost http://gitlab.example.com
~~~

Token 需要 api scope；在向导的隐藏提示中输入。只有只读 API 验证成功后，向导才把 HOST/TOKEN 保存到当前 Windows 用户环境，并更新本脚本进程。失败不会保存新凭据。替换过期或无效 Token 时加 -Reconfigure。不要把 Token 放在命令行、文件或聊天中。

已有凭据按完整的 host/token 配对读取，不会把一个作用域的 host 与另一个作用域的 token 拼接。同 host 的 User 凭据优先验证，随后才尝试进程凭据；两个作用域指向不同 host 且没有明确选择 origin 时，初始化拒绝覆盖并要求指定 -GitLabHost。

已打开的 Codex 或终端不会被子脚本回填环境变量；保存后需重启这些旧进程。仅检查已有凭据、不保存、不提示输入：

~~~powershell
.\scripts\setup-gitlab.ps1 -Executable <installed-cli> -GitLabHost http://gitlab.example.com -NonInteractive -CheckOnly
~~~

没有可用凭据的非交互调用立即返回明确错误和下一步，不挂起等待输入。

## macOS / POSIX

安装脚本发布二进制后立即调用 auth check。可用 --gitlab-host 指定精确 origin。缺授权或网络失败时，报告“CLI 已安装、初始化未完成”，返回非零并保留二进制。当前 POSIX 安装器没有交互隐藏 Token 向导；先按 [认证文档](../security/authentication.md) 在当前环境安全配置 HOST/TOKEN，再执行：

~~~text
harness-mrtool auth check --output json --host https://gitlab.example.com
~~~

HOST 环境变量只放 host[:port]，不带 scheme 或项目路径；--host 参数放精确的 http(s) origin。显式 origin 不会切换协议；省略 origin 的已有 bare HOST 沿用 CLI 的 HTTP 优先、同 host HTTPS 兼容行为。网络错误与授权错误分别报告。

## Codex 插件

marketplace add 负责登记市场，plugin add 负责安装插件资产；它们不是本工具可拦截的安装事务。当前官方事件没有 PostInstall，不能声称插件文件下载完成时已自动完成授权。

本插件打包了跨平台 SessionStart hook，在新建、恢复、清空会话时尽早检查。需要先在 Codex 的 Hooks 设置中 review and trust。未信任时，Codex 不会运行该 hook；此时必须显式运行上述向导或 auth check 完成初始化。安装后启动新会话，不能等到请求提交 MR 才执行初始化。

hook 默认使用 POSIX shell，Windows 通过官方 commandWindows 字段使用本机 PowerShell；不下载 CLI、不输入 Token、不保存凭据、不创建 MR。若缺 CLI、缺授权、检查失败或当前 Codex 继承的进程环境过旧，会向模型提供明确的初始化指引，并要求不要宣称工具已就绪。自建 CLI 可通过 HARNESS_MRTOOL_EXECUTABLE 指定绝对可执行文件路径。POSIX hook 使用现有 macOS 原生运行前提中的 Perl/JSON::PP 校验完整授权成功合同；缺运行环境时明确提示手工执行 auth check，不能宣称就绪。

初始化成功只验证当前授权；提交时仍会复查凭据有效性、目标项目权限和分支状态。

官方依据：[插件打包与 hook 信任](https://developers.openai.com/plugins/build/plugins)、[支持的 hook 事件与 SessionStart 输出](https://learn.chatgpt.com/docs/hooks)。
