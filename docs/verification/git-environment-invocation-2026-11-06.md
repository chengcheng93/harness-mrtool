# Git 环境调用调整（2026-11-06）

用户要求删除插件内针对 Git 程序的防伪造逻辑，不再设置可信安装根目录或限制 PATH。

## 最终行为

- `GitRunner` 默认调用 `git`，由进程环境的 PATH 解析可执行程序。
- 调用方提供 `gitExecutable` 时直接使用该值；不区分生产和测试运行器。
- 不再验证 Git 程序的身份、安装根目录、路径替换或目录权限，不再使用 `trustedGitRoots`。
- 保留仓库文件身份检查、参数数组、`shell: false`、超时、输出限制及其他仓库操作约束。
- 真实 Git 标签流程集成测试直接使用生产默认仓库适配器和环境中的 Git；删除 `HARNESS_MRTOOL_TEST_GIT_EXECUTABLE`、自定义进程运行器和可信根目录注入。测试仍仅重定向外部传输端点，使用本地真实 Git 仓库验证 MR 标签流程。

## 验证命令

在 `harness-mrtool` 目录执行：

```powershell
node scripts/test.mjs test/integration/git-executable-environment.test.ts
npm run typecheck
npm test -- --test-concurrency=6
npm run build
```

## 验证结果

- 使用项目要求的 Node 24.16.0。
- 新增4例回归：旧实现4例均失败；删除限制后4例均通过。覆盖默认Git读取仓库、PATH优先级、生产运行器指定程序及缺少Git时的原生查找错误。
- 额外验证仓库发现流程确实传递调用方指定的程序：1例通过。
- 类型检查通过，CLI构建成功。构建仍有原有的2条CJS/import.meta警告，本次未改动对应模块。
- 在本机03-apps运行新构建CLI的profiles detect，已越过Git仓库读取，返回GitLab AUTH_ERROR；不再出现原先的Git可信安装目录错误。未执行业务仓库提交、推送或MR创建。
- 独立代码审查确认无阻塞问题；22个原有未提交文件的SHA256保持一致。
- 已启动147文件全量测试，但在高负载下出现下列失败，随后停止该轮；不能声称全量通过。另以单并发完整重跑本次涉及的3个集成测试文件：57项通过，0失败、0跳过，耗时267.54秒。覆盖真实Git推送、MR创建与回读、dry-run及并发变更检查。

全量测试停止前已记录的失败用例：

- `sea-injection.test.ts`：darwin、linux、win32的`rejects an active-runtime symlink by identity before any mutation`（3例）。
- `channel-pages-deployment.test.ts`：`immutable readback downloads only the envelope into a fresh directory and compares before upload`；`immutable Pages gate fails closed for exact readback`、`changed readback`、`missing readback`、`download-failed readback`、`draft readback`、`mutable readback`、`metadata-failed readback`、`preexisting readback`（共9例）。
- `cli-production-handlers.test.ts`：`self-update status reads the real cache and reports an empty bootstrap safely`。
- `gitlab-client.test.ts`：`discovers tokenized live candidates while keeping lifecycle labels derived and snapshots tokenless`。
- `native-cli-release-workflow.test.ts`：`all POSIX release scripts parse and use fail-closed shell execution`。
- `sea-smoke.test.ts`：`SEA executable runs self-test from an empty working directory`、`SEA executable runs the embedded output contract probe`、`SEA executable runs the embedded deterministic renderer probe`（3例）。

这些是观察到的失败清单，不把尚未定位的失败全部归因为环境。重复的并发专项运行也已停止；其锁超时和中断结果不作为本次通过证据。

对3类失败做了精确单并发复跑（共5例，1通过、4失败）：

- 3个active-runtime symlink用例均在创建文件符号链接时抛出EPERM，尚未调用待测的SEA注入函数；是当前Windows环境的符号链接权限条件。
- immutable readback downloads用例的`spawnSync("bash", ["-n"])`失败，独立探针确认ENOENT；当前PATH没有bash。
- tokenized live candidates用例复跑通过（约1.72秒），其使用预构造Git快照，不调用GitRunner；原始失败原因尚不能确定。
- 其余全量失败未逐一定位，未修改这些测试或相关实现，不据此声称全量通过。
