# M14 收口前代码审查报告（Step 5.5）

- 审查日期：2026-11-10
- 审查范围：M14 Step 1–5 全部交付（services/ops 管线、apps/web 运维任务中心与内部接口、
  packages/db 种子与迁移 0025/0026、nginx conf、文档）
- 审查方式：AI 两路并行自查（A 路 = 安全与架构，B 路 = 评审规范与文档一致性），全部结论
  以读代码与查库实证为准；复跑命令见文末。
- 结论：**无 P0；P1 5 项（全部已整改）；P2 15 项（整改 8 项、记录 7 项）**（P2 计数按表逐行重计，
  原稿「整改 4、记录 9」有误）。整改后门禁全绿（见文末复跑记录）。**站长人工评审已通过
  （2026-11-10，交互式逐项确认含 R-20 复测）——Step 5.5 完成，进入 Step 6 部署收口。**
- 补记（同日，交互式评审环境预检）：按站长要求搭建本地可交互评审环境（生产构建 + 开发库 +
  真实管线容器）时，又实测出 3 项 P1（R-15 告警只送达一名管理员、R-16 system 类通知读侧未接入、
  R-17 恢复演练对全库 dump 必然误报）与 1 项 P2（R-18/19）。三项 P1 在单测/集成/E2E 全绿的前提下
  漏网，共同根因是**夹具比真实环境「干净」**——见 §五。站长交互式评审再发现 1 项 P1（R-20 公历
  非真实日期可保存），已整改。评审结束后评审环境（3300 服务器、funwind-ops-review 容器、
  三个评审脚本）已按约定清理。

## 一、核查结论（A–K + A–J 逐项）

### 安全与架构（A 路）

| 项 | 结论 | 关键证据 |
|---|---|---|
| A 注入面 | ✓ | restore 白名单覆盖全部 shell/SQL 入口（restore.py:27-33/106、api.py:118、cli.py:87 同一白名单）；dump/mysql 参数经 shlex.quote；DROP/CREATE 参数化；drill 临时名纯数字必过白名单 |
| B 口令 | ✓ | 全部 `--defaults-extra-file`（首选项）+ mkstemp 0600 + 用后删；无 `-p` 残留；转义 `\` 与 `"` 正确（换行不可达，见 P2-8） |
| C token | ✓ | 管线 api.py:31 与 web route 均常量时间比较；空 token 双侧 fail-closed |
| D 时区 | ✓ | db.py init_command 全连接 +08:00；recover_stale_runs 的 NOW() 与台账墙钟同会话口径 |
| E 降级韧性 | ✓ | config 无 import 期 raise；runtime 非阻塞启动 + 后台重试；/health 降级 503；TZ=Asia/Shanghai 已设 |
| F 并发互斥 | ✓ | backup 组共用一把 GET_LOCK（restore/drill 间接持锁）；holiday 独立组（幂等 HTTP 合理）；异步预检 TOCTOU 有真锁兜底（P2-9 记录） |
| G 内部接口三保险 | ✓ | nginx 前缀 404 先于 location /；token 常量时间；写服务单一路径。create-if-absent 非原子 → P2-10 记录 |
| H 架构边界 | ✓ | server-only-guard 登记 client/tasks/runs；executors 纯模块有意豁免；internal route 未直连 @funwind/db；无依赖环 |
| I 读写分离 | ✓ | web 侧 ops_runs/ops_trigger_state 仅 SELECT；verify 豁免恰 3 项最小 |
| J 零表韧性 | ✓ | 台账/状态表缺失全降级（page/runs/告警）；管线配置表缺失回落内置默认。配置表缺失的页面降级为审查中发现并整改（R-4） |
| K 种子 | ✓ | 任务+触发器+记账同事务、每键独立事务；记账并发互覆 → P2-11 记录（单实例部署不触发） |

### 评审规范与文档一致性（B 路）

| 项 | 结论 |
|---|---|
| A G-15 提示参数成对 | ✓ queued/task/policy/tasks/holiday/holidayErr/err/draft 全部有生产方与消费方，无孤儿 |
| B G-16 E2E 错误路径 | ✓ 九类全覆盖（404/降级/被拒回显/失败展示/轮询端到端/恢复命令/启停审计/分页）；节日表单语义校验经 HTML5 拦截或 items 空路径覆盖 |
| C G-19 草稿与冲突 | ✓ draft 带回全部字段并回填；冲突不换版本（e2e 断言 revision 不变）；campaigns 同模式未破坏 |
| D G-20 revision 全写路径 | ✓ create/update/toggle/delete/触发器四写/保留份数双任务均 bump+审计；bootstrap 首写 rev1 合规 |
| E 权限矩阵 | ✓ 页面与四 Action 均 site.admin；download requireAdmin；internal 路由按设计走 token+nginx |
| F 零表韧性 | 台账 ✓；**配置表缺失曾 500 → R-4 整改**（listOpsTasks/getBackupRetention 降级空态） |
| G 迁移幂等 | ✓ journal 在册、0026 enum 追加保留存量、dev 库实查已应用 |
| H 文档一致性 | ✓ 抽查 6 处兑现；过期文案见 P2 记录（已整改 2 处） |
| I CHANGELOG | **P1-1 缺 Step 3–5 → 已补**（R-1） |
| J 双端夹具 | ✓ 同一夹具双端全量消费（4 执行器/92 用例），重排不破坏语义 |

## 二、发现的问题与整改

### P1（应修，已整改）

| # | 问题 | 整改 |
|---|---|---|
| R-1 | CHANGELOG Unreleased 缺 M14 Step 3–5 用户可见变更（运维任务中心改版、轮询与下载列、节日装扮规则卡、drill.restore、ops.alerts、system 类别） | 补三条 Added（Step 3 / Step 4 / Step 5），核对既有段式 |
| R-15 | **失败告警只送达 id 最小的一名管理员**：`ops.alerts` 的 dedupKey 为 `ops-failed:{runId}`（不含接收人），而 `notifications.uq_nf_dedup` 是**全局**唯一索引——首个管理员落库后，其余管理员被 notify 当作「重放」静默跳过。开发库实测 22 名管理员只有 user 2 收到 7 条，站长本人一条没有 | **已修**：一次 notify 全体管理员，dedupKey 改 `ops-failed:{runId}:{uid}`（与 reports/审核类多接收人通知同口径）；集成测试补「两名管理员各收一条、重扫不重复」；变异验证：回退旧键 2 项失败 |
| R-16 | **system 类通知读侧未接入**：Step 5 只在写侧（schema 枚举/注册表/渲染/通知页签）加了 system，读侧四处手抄的类别清单都漏了它——未读汇总不计 system（铃铛角标与通知页「未读 N」不含运维告警，只剩告警时连「全部已读」按钮都不出现）、铃铛类别标签缺失、流式分页白名单缺 system（系统页签向下加载会混入全部类别）、按类已读接口拒收 system | **已修**：`FEED_CATEGORIES = [...NOTIFICATION_CATEGORIES, "announcement"]` 作为读侧单一来源（schema 枚举派生），未读汇总改 `Record<FeedCategory \| "total">`（新增类别时类型系统强制补齐），两路由白名单与铃铛标签改为引用/类型穷举；集成测试补「system 计入分类与总数、分类时间线与按类已读只动 system」，路由测试补按类已读三类；变异验证：去掉 system 计数或回退旧白名单各 1 项失败 |
| R-17 | **恢复演练对真实全库备份必然判失败**：mysqldump 全库产物含管线自治表（ops_runs/ops_trigger_state），对账只从源库一侧排除 → 演练库「多出 2 张表」→ 每周定时演练都会 failed 并触发告警；另临时库名用 `date.today()` 格式化时分秒恒为 000000，同日多次演练撞同名库；行数抽样会抽到 `__drizzle_migrations` 内部表 | **已修**：管线表两侧对称排除；临时库名改 `datetime.today()`；抽样只取业务表（跳过 `__` 前缀）。回归测试：全库式 dump（含管线表 + 迁移表）演练通过且抽样不含内部表、临时库名带时分秒并过恢复白名单；变异验证：HEAD 版 drill.py 下 2 项失败 |
| R-20 | **公历不存在日期可保存（站长交互式评审发现）**：双端只校验字段范围（公历日 1–31），2/31、4/31 保存成功，管线要到执行时 `date(2026, 2, 31)` 才抛 ValueError（台账里是英文异常）；同理公历 2/29（闰日）在「今年/明年」候选年大多不存在，任务会持续失败告警；农历 30 日遇小月同样会抛库的英文异常 | **已修**：双端 `check_params`/语义校验加真实日历判断——公历日须在该月存在、闰日直接拒绝（提示改用 2/28），错误文案两端同文（「公历 2 月没有 31 日」）；农历 30 日遇小月由 `compute_window` 顺延到下一个候选年（lunar_python 按月天数预检），两年都无时报可读中文错误；公历日字段标签加「须为真实日期」提示；双端夹具加 4 案例（2/28 有效、2/31、4/31、2/29 无效）；变异验证：分别回退两端实现，管线 9 项 / web 4 项失败 |

### P2（记录或低成本整改）

| # | 问题 | 处置 |
|---|---|---|
| R-2 | 节日装扮方案名 = 任务名·年份，任务名 >53 字时超 SSR 方案名上限 60 → 422 | **已修**：管线生成名前截任务名前 50 字（截断一致 ⇒ 幂等键仍稳定） |
| R-3 | 内部接口 create-if-absent 非原子（campaigns 无 name+effect 唯一键），双管线实例并发可双插 | 记录：单实例部署不可达；多实例前与 GA-1（告警共享存储）一并处理 |
| R-4 | **配置表（ops_tasks）缺失时 /admin/ops 整页 500**（listOpsTasks/getBackupRetention 无兜底） | **已修**：两查询缺表降级空态（对齐 F12 修复口径），并补「配置表缺失」降级测试 |
| R-5 | web 节日表单 day 语义校验（农历 0–30/公历 1–31）无本地单测 | **已覆盖**：双端夹具含 lunar day=31 与 solar day=0 两用例（it.each 全量跑），审查代理漏检；另在 executors.test 补显式两条断言防夹具回退 |
| R-6 | 生产 compose 旧名 token 变量与 .env.example 缺新键；注释指向旧目录 | **已修**：compose 传 OPS_API_TOKEN（主）+ BACKUP_OPS_TOKEN（兜底镜像回滚用）；.env.example 补 OPS_API_TOKEN；注释指向 docker/ops |
| R-7 | 管线 OPS_TOKEN 与 web OPS_API_TOKEN 两名同值，一致性靠人工 | 记录：RUNBOOK 附录（Step 6）加「新键同值」对账步骤；多实例前与共享存储一并收敛 |
| R-8 | option 文件转义不含换行（compose .env 无法携带裸换行，现网不可达） | 记录 |
| R-9 | drill._count f-string 拼标识符（来源为自家 information_schema） | **已修**：标识符含反引号即抛错（纵深防御） |
| R-10 | trigger_manual 预检与锁获取之间有 TOCTOU 窗口（输家被锁拒绝标 failed，无双重执行） | 记录（真锁兜底，后果可接受） |
| R-11 | bootstrap 记账（ops.tasks.seeded）循环前快照覆盖写，双实例并发可能丢键 | 记录（单实例部署不触发；唯一键保证不双行） |
| R-12 | SCHEDULED-JOBS「已登记 2 个任务」日志示例过期 | **已修**：改 3 个任务并列 ops.alerts |
| R-13 | CLAUDE.md 阶段行仍称 M14「未开工」 | **已修**：改「执行中：Step 1–5 已完成并更名 funwind-ops，余 Step 5.5/6」 |
| R-14 | holiday.py 结构调整中曾引入缩进/缺失导入错误（开发期自愈，未入库） | 记录：整改后全量回归通过 |
| R-18 | services/ops/README.md 测试段仍写 `cd services/backup`（更名遗漏） | **已修** |
| R-19 | 六个流式路由（conversations/points/follows/home/messages/notifications）共用一段「限流 → 取会话用户 → 401」前导，属存量克隆族；R-16 删掉通知路由里手抄的类别清单后，该路由与 conversations 的克隆窗口从 10 行延长到 18 行，jscpd 重复行 1397 → 1405（克隆数不变 159） | 记录：重复基线按仓库约定显式重锚到 1405（diff 随整改提交）；前导抽成 `lib/stream/respond` 的公共守卫留待下次改动流式端点时一并做（跨 6 路由，超出 M14 范围） |

## 三、整改后复跑门禁

第一轮（R-1–R-14 整改后）：

- `verify:all` 退出码 0（jscpd 1397 ≤ 基线 1400）；
- 全量 `test:e2e` 生产 488 + dev 8 全过（退出码 0）；
- 管线 pytest 245 项全过（镜像内 drill/restore 真链路 7 项全过）；
- db 包 124 项、scheduler 110 项、通知 37 项、ops 契约/单测/集成（executors 105 / tasks 27 / runs 6 / client 15 / 内部路由 14）全过；
- admin-ops E2E 12 项全过；
- `check:secrets` / `format:check` 退出码 0。

第二轮（R-15–R-17 整改后，最终口径）：

- `verify:all` 退出码 0：web 4114 项 / db 包 124 项 / scripts 55 项全过，next build 成功；
  jscpd 重复行 1405 = 重锚后基线（R-19，diff 随整改提交）；lint / format / secrets 干净；
- M12 零数据安装 E2E（`test:e2e:install`，站长要求确认的安装链路）与全量 `test:e2e`
  生产 488 + dev 8 复跑全过；
- notifications + admin-ops 两个 spec（生产构建）16 项全过；
- 管线 pytest 镜像内 256 项全过（新增 drill 回归 2 项）；
- 变异验证三项均成立（分别回退三项修复 → 对应新测试失败，见 §二表）；
- 评审环境实测（生产构建 + 开发库 + 真实管线容器）：7 条失败运行 × 22 名管理员告警各 154 行、
  铃铛未读 7、/notifications 系统页签 7 条、台账三页分页、备份下载 200（gzip 魔数 1f8b +
  attachment 头）与路径穿越 400、内部接口无/错 token 均 401、手动告警轮幂等（154 行不增）。

第三轮（R-20 整改后）：

- 管线 pytest 镜像内 266 项全过（夹具 4 案例 + 跳年/双年无日/公历非法日期 4 项新测试）；
- web ops 契约与单测 158 项全过（含真实日历断言与 4 条新夹具案例）；
- 变异验证成立（回退 holiday.py → 管线 9 项失败；回退 executors.ts → web 4 项失败）；
- 评审环境实测：公历 2/31 保存被拒（错误条「公历 2 月没有 31 日」+ 草稿保留 + 库数据不变）、
  2/29 提示改用 2/28、表单公历日标签显示「须为真实日期」；
- `verify:all` 退出码 0（web 4118 / db 124 / scripts 55，jscpd 1405 = 基线）。

## 四、站长人工评审清单（评审规范四条 + 安全）

1. G-15：/admin/ops 全部提示参数抽查（queued/task/policy/tasks/holiday/holidayErr/err）；
2. G-16：admin-ops.spec 12 项覆盖面是否满足（错误路径清单见 §一.B）；
3. G-19：节日表单失败/冲突草稿保留的交互体验目视确认；
4. 安全：内部接口三保险（nginx 404 / token / 写服务校验）与恢复命令只预览不执行的取舍确认；
5. P2 记录项（R-3/R-7/R-10/R-11）是否接受为「多实例前置时统一处理」。

## 五、补记：交互式评审环境预检（同日）

站长要求「本地搭建可人工评审的环境（含需要触发的情况）」后，预检用生产构建 + 开发库（22 名管理员、
真实全库备份）+ 真实管线容器把告警、通知、演练链路实跑了一遍，查出 R-15/R-16/R-17 三项 P1。
三项在单测、集成、E2E 全绿的前提下漏网，根因相同：**夹具比真实环境干净**。

| 缺陷 | 夹具的「干净」之处 | 真实环境 |
|---|---|---|
| R-15 告警只到一人 | 集成测试先把管理员清成「确定性单管理员」 | 开发库 22 名管理员，生产至少站长 + 兜底超管 |
| R-16 system 读侧缺失 | 通知读取测试只覆盖 M8 时代的四类 + 公告；E2E 数据里没有 system 类通知 | 告警是第一种 system 类通知，铃铛角标直接显示 0 |
| R-17 演练必然误报 | 演练测试的备份是手写的单表 SQL | mysqldump 全库产物带管线自治表与迁移记账表 |

R-20（公历 2/31 可保存）同属此类——校验只盯「字段范围」这一层，而真实日历的约束在范围之外；
且 web 与管线是同一份不完整规则的两份手抄实现，靠双端夹具对齐后一起补齐。

由此沉淀两条做法（收口时写入 M14 文档教训节）：

1. **多接收人 / 多实例语义的测试至少放两个主体**——单个接收人的测试对「全局唯一键」「首个即止」类缺陷天然失明；
2. **备份/恢复/演练类测试的夹具取真实产物形态**——用 mysqldump 风格的全库 dump（含自治表与内部表），
   不用只含业务表的手写 SQL；新增枚举成员时检索全部读侧清单，能派生的改为从单一来源派生（R-16 已改）。
