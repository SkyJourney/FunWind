# 定时任务汇总

> 一处看全所有周期性任务，上线时对着它核对，不会漏配。最后更新：2026-11-10（M14 Step 5）。
> 设计与取舍见 [M11.5](milestones/M11.5-scheduler.md)。

## 1. 总表

运维任务管线（funwind-ops 容器，M14）还承载两类**运维侧**周期任务——它们不走进程内调度器，见
[BACKUP.md](ops/BACKUP.md) 与 [M14](milestones/M14-ops-pipeline.md)：备份（每日 03:10 / 03:40）与
恢复演练（drill.restore，每周五 02:00，最新备份导入同实例临时库对账后清理）；节日装扮自检
（campaign.holiday，每日 09:00，默认**停用**——启用是站长显式动作）。任务/触发器在后台
「运维」页配置（ops_tasks / ops_triggers 表），运行台账在 ops_runs。它们与进程内调度器互不相干：



| 任务 | 做什么 | 谁调度 | 频率（北京时间） | 命令行入口 | 互斥 |
|---|---|---|---|---|---|
| `account-deletion.drain` | 处理冷静期已到的账号注销申请 | **进程内调度器**（`SCHEDULER=on`） | 每 15 分钟 | `pnpm --filter @funwind/web account-deletion:drain` | 命名锁 |
| `unverified-accounts.purge` | 清理超过 7 天仍未验证的注册账号，释放用户名与邮箱 | **进程内调度器**（`SCHEDULER=on`） | 每天 03:30 | `pnpm --filter @funwind/web unverified-accounts:purge [--apply]` | 命名锁（仅 `--apply`） |
| `ops.alerts`（M14） | 扫描运维台账（`ops_runs`）近 7 天的失败记录，给 admin 角色用户发系统类告警（dedup 按运行 id 防重） | **进程内调度器**（`SCHEDULER=on`） | 每 15 分钟 | —（告警扫描无命令行入口） | 无（读-only 扫描 + 通知 dedup 幂等） |
| `email.digest`（M17） | 给近 24 小时未登录、开了邮件汇总的用户发每日汇总 | **进程内调度器**（`SCHEDULER=on`） | 每小时整点跑，run 内按北京墙面时间比对后台配置时刻（默认 20 点） | `pnpm --filter @funwind/web digest:run [--user <id>] [--force]` | 命名锁 + **当日幂等**（同一北京日只发一封） |
| `push.cleanup`（M18） | 清除超期（180 天）未重建的失效推送订阅，兜底投递时 404/410 即时清理 | **进程内调度器**（`SCHEDULER=on`） | 每天 03:40 | —（清扫无命令行入口） | 命名锁 |
| outbox 补派 | 把消费失败而停在 outbox 里的事件补派出去 | **手动** | — | `pnpm --filter @funwind/web outbox:drain` | 无 |
| 孤儿文件巡检 | 报告库内无引用的文件与磁盘上有而库里没有的孤儿 | **手动** | — | `pnpm db:gc-files --dry-run` | 无 |
| 缓存计数重算 | 全量重算缓存计数 | **手动** | — | `pnpm db:recount [--check]` | 无 |

**每日汇总邮件已于 M17 Step 1 迁入**（原「不迁」理由已消除）：当初的顾虑是「系统 cron 与进程内调度
同时跑可能重复发信」——根因是未读私信计数不受 `since` 时间窗约束，同日第二次运行会给有未读私信的用户
再发一封。M17 给 `runDigestOnce` 补了**当日幂等闸**（同一北京日已发过则跳过，`--force` 可绕过用于手动补发），
命名锁防并发 + 当日闸防先后双跑，顾虑即消除。

迁入的直接动因是实测发现它**从未真正运行过**：生产宿主机 crontab 只有一条宝塔 ACME 证书续期任务，
从未配过 digest 条目，`email_log` 全表零 digest 记录（M17 Step 0）。接进调度器后只需 `SCHEDULER=on`
（生产已满足），不再依赖仓库外、易漏配的 crontab。顺带修掉旧脚本用 `new Date().getHours()` 读进程本地
时区的隐患——容器 `TZ=UTC` 时后台配的「20 点」会错位成北京凌晨 4 点；现在统一按北京墙面时间比对。

没有迁入调度器的原因：

- **outbox 补派**：目前由业务流量捎带驱动（`sweepPending`）；多实例下的互斥是 [M13](milestones/M13-launch.md) 清单第 3 条，迁入调度器是它的自然落点，**候选，未做**。
- 其余是运维一次性操作，不需要周期运行。

## 2. 进程内调度器怎么用

### 开关

| 环境变量 | 取值 | 说明 |
|---|---|---|
| `SCHEDULER` | `on` 才启动，**其余任何值（含 `ON`、`1`、`true`、留空）都不启动** | 默认关闭 |

为什么默认关闭、不按 `NODE_ENV` 自动开启：开发库连的是真实 SMTP；E2E 的生产构建也是 `next start`，自动开启会让定时任务踩到正在测试的数据。

启动后服务日志里应有一行（没有就说明没启用）：

```
[scheduler] 已登记 5 个任务：account-deletion.drain、unverified-accounts.purge、ops.alerts、email.digest、push.cleanup（时区 Asia/Shanghai）
```

### 部署

- 在**承载定时任务的实例**上设 `SCHEDULER=on`。多个实例同时开也安全：每次执行前用 MySQL 命名锁互斥，抢不到的实例跳过本轮。
- 命名锁是**服务器级**的，锁名里带了库名，同一台 MySQL 上的开发库、E2E 库、临时库互不干扰。
- **进程重启（发布）会重置定时器，错过的触发不补跑。**这些任务都幂等且频繁，下一轮自然补上；每天一次的清理最多晚一天。
- 日志格式（便于检索）：`[scheduler] job=<任务键> status=ok|skipped|failed durationMs=… <摘要>`。
  - `status=skipped`：别的实例或命令行正在执行，正常；
  - `status=failed`：看后面的原因；部分失败（摘要里 `failed>0`）也记为 failed；
  - 超过超时时间会有一条警告「**锁保持到任务结束**」——任务不会被强杀，也不会提前释放锁，否则别的实例会并发执行同一个任务。

### 与命令行的关系

命令行脚本与调度器**共用同一份任务代码和同一把命名锁**。调度器正在执行时手动跑 `account-deletion:drain` 或 `unverified-accounts:purge --apply`，命令行会被跳过并以退出码 0 结束。`unverified-accounts:purge` 不带 `--apply` 是只读的，不抢锁，随时可跑。

迁移后请删除这两个任务对应的系统 crontab 条目；不删也安全（命令行会和调度器互斥），只是多一次空跑。

## 3. 新增一个定时任务

1. 在 `apps/web/src/lib/scheduler/tasks.ts` 写任务工厂，返回 `{ key, cron, timeoutMs, run }`。`key` 同时是命名锁与日志标识，**定了就不要改名**；`run` 返回 `{ summary, failed? }`。
2. 加进 `jobs.ts` 的 `defaultJobs()`。
3. 任务必须**幂等**：重复执行、多实例竞争、进程中途崩溃重启都不能造成损害。
4. 需要命令行入口的，脚本里调 `runJob(task, { locks: createMysqlLocks(), log: consoleLogger })`，保证与调度器共用锁；脚本收尾要显式 `process.exit`（连接池会占着事件循环）。
5. 在本文件的总表里加一行。
6. 测试：任务本身的集成测试；脚本的真起进程测试（`src/test/script-runner.ts`）。

## 4. 已知限制

- **单进程内的调度**：只在应用进程运行时才执行。进程停了就不跑。
- **没有持久化的运行记录表**：运行结果只在日志里。破坏性任务（清理）本身写 `audit_log`。
- **没有后台管理页**：看不到下次运行时间。需要时可用 croner 的 `nextRun()` 做只读状态页，列为后续。
- 命名锁占用连接池里的 1 条专用连接，调度器串行执行，所以最多额外占 1 条；连接池共 8 条。
