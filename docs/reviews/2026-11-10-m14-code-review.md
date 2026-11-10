# M14 收口前代码审查报告（Step 5.5）

- 审查日期：2026-11-10
- 审查范围：M14 Step 1–5 全部交付（services/ops 管线、apps/web 运维任务中心与内部接口、
  packages/db 种子与迁移 0025/0026、nginx conf、文档）
- 审查方式：AI 两路并行自查（A 路 = 安全与架构，B 路 = 评审规范与文档一致性），全部结论
  以读代码与查库实证为准；复跑命令见文末。
- 结论：**无 P0；P1 1 项（已整改）；P2 13 项（整改 4 项、记录 9 项）**。整改后门禁全绿
  （见文末复跑记录）。站长人工评审通过后进入 Step 6 部署收口。

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

## 三、整改后复跑门禁

- `verify:all` 退出码 0（jscpd 1397 ≤ 基线 1400）；
- 全量 `test:e2e` 生产 488 + dev 8 全过（退出码 0）；
- 管线 pytest 245 项全过（镜像内 drill/restore 真链路 7 项全过）；
- db 包 124 项、scheduler 110 项、通知 37 项、ops 契约/单测/集成（executors 105 / tasks 27 / runs 6 / client 15 / 内部路由 14）全过；
- admin-ops E2E 12 项全过；
- `check:secrets` / `format:check` 退出码 0。

## 四、站长人工评审清单（评审规范四条 + 安全）

1. G-15：/admin/ops 全部提示参数抽查（queued/task/policy/tasks/holiday/holidayErr/err）；
2. G-16：admin-ops.spec 12 项覆盖面是否满足（错误路径清单见 §一.B）；
3. G-19：节日表单失败/冲突草稿保留的交互体验目视确认；
4. 安全：内部接口三保险（nginx 404 / token / 写服务校验）与恢复命令只预览不执行的取舍确认；
5. P2 记录项（R-3/R-7/R-10/R-11）是否接受为「多实例前置时统一处理」。
