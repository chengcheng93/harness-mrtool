# 五项失败修复与复测

日期：2026-11-11。版本：0.1.11 本地候选。运行时代码提交：b5ef654；发布测试路径修复：45d5667。

## 最小修复

| 项目 | 修复 | 验证 |
|---|---|---|
| Windows ACL | 文件用(F)，目录用(OI)(CI)(F)；检查当前用户有效FullControl；拒绝作用于当前对象的Deny | 真实文件/目录、原生落盘、Everyone与OWNER RIGHTS拒绝规则回归通过 |
| readiness共享预算 | 使用已有held lease隔离锁启动，再用3秒共享预算和1.2秒子进程证明不能重置每步预算 | 保留拒绝、至少2且少于4个探针及有限耗时断言 |
| 真实SEA版本 | 从package元数据生成签名测试夹具与预期版本 | 真实0.1.11可执行文件及嵌入Bundle通过 |
| 304竞态 | 该竞态测试使用已有forced预算，避免夹具真实Windows锁耗时触发另一条超时回退 | 仍要求拒绝旧状态并保留序号43和ETag；生产2秒普通预算未变 |
| Bundle契约 | 移除错误的跨版本schema字节相等要求，改验归一化legacy兼容及new/omitted边界 | 40项Bundle测试通过；历史Bundle1.2.0字节、manifest、签名不变 |

ACL采用保守私有路径策略：所有当前对象Deny均拒绝，包括针对无关主体的Deny；不引入完整Windows有效权限计算器。继承专用规则仍按InheritOnly处理。目录回归明确检查OI和CI，避免创建者默认DACL掩盖问题。

## 专项、审查与构建

- 原生文件测试21项：13通过、8项既有POSIX平台跳过；上下文ACL/路径5项通过；最终继承断言单项通过。
- readiness与channel两份完整文件64/64通过；Bundle完整单元40/40通过。
- 独立审查：Task2/3直接通过；Task1的一项Important和一项Minor经一轮修正及定向复审关闭，无新增问题。
- 最终typecheck、应用/SEA构建、source-bound receipt验证均通过。空目录下5项实际原生烟测通过。构建仍有原有CJS import.meta与PE注入提示，未引入新警告类别。

## 完整套件与覆盖复测

四个既有Windows CI分组均内部串行，最终完整运行覆盖163个测试文件，全部完成且无缺漏/重复。首轮统计：2521项、2413通过、35失败、73跳过、0取消。**这次并行首轮不是全绿。**

失败分布及后续证据：

| 文件 | 首轮失败 | 覆盖复测 |
|---|---:|---|
| channel-pages-deployment |8| 查明夹具硬编码冒号拼PATH，Windows首个目录失效导致Bash ENOENT；仅两行改用node:path.delimiter。同Git-first环境整文件12/12通过，Node-first单项亦通过 |
| default-write-performance |13| 单项多次通过；完整诊断重跑19/20，捕获初始issue的Candidate context lock timed out；最终低并发串行覆盖通过 |
| production-migration-adapter |5| 最终串行覆盖通过 |
| verification-receipt-store |9| 最终串行覆盖通过 |

后三份文件合并串行复测：64项、63通过、0失败、1项平台跳过、0取消，268.335秒。所有首轮失败用例都有后续覆盖通过记录；没有把多次结果相加伪装成一次全绿。只确认降低并发后的覆盖通过，不声称本机并行锁启动稳定性已被修复；生产锁超时和逻辑未扩大修改。

原五项在完整套件中全部通过：native store 13通过/8跳过，readiness35/35，channel29/29，Bundle40/40。首个被审查修正替代的预运行已停止并单独保留，未计入完整覆盖。

## 体积与边界

| 制品 | 修复前 | 修复后 | 差值 |
|---|---:|---:|---:|
| CLI exe |94541312字节|94541312字节|0|
| 独立Skill ZIP |64927字节|64927字节|0，SHA256相同|
| 插件ZIP |126485字节|126485字节|0，SHA256相同|

运行时代码仅state-path.ts净增3行（8增5删）。没有新增依赖、CLI选项、配置、运行框架；默认Skill仍65行。实际应用修复在新CLI中，插件与Skill内容未变。制品位于Codex工作区 outputs/harness-mrtool-0.1.11-fixed，包含SHA256SUMS和原始证据。

未创建生产GitLab Issue/MR，未推送共享分支、发布或更新全局安装。保留本地分支和SDD证据，供后续集成。
