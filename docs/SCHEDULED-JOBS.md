# 定时任务汇总

> 一处看全所有周期性任务，上线时对着它核对，不会漏配。最后更新：2026-11-04（M11.5）。
> 设计与取舍见 [M11.5](milestones/M11.5-scheduler.md)。

## 1. 总表

| 任务 | 做什么 | 谁调度 | 频率（北京时间） | 命令行入口 | 互斥 |
|---|---|---|---|---|---|
| `account-deletion.drain` | 处理冷静期已到的账号注销申请 | **进程内调度器**（`SCHEDULER=on`） | 每 15 分钟 | `pnpm --filter @funwind/web account-deletion:drain` | 命名锁 |
| `unverified-accounts.purge` | 清理超过 7 天仍未验证的注册账号，释放用户名与邮箱 | **进程内调度器**（`SCHEDULER=on`） | 每天 03:30 | `pnpm --filter @funwind/web unverified-accounts:purge [--apply]` | 命名锁（仅 `--apply`） |
| 每日汇总邮件 | 给近 24 小时未登录、开了邮件汇总的用户发汇总 | **系统 cron**（每小时整点） | 脚本内部按后台配置的时刻判断，默认 20 点 | `pnpm --filter @funwind/web digest:run` | 无（靠脚本内的整点与活跃判定） |
| outbox 补派 | 把消费失败而停在 outbox 里的事件补派出去 | **手动** | — | `pnpm --filter @funwind/web outbox:drain` | 无 |
| 孤儿文件巡检 | 报告库内无引用的文件与磁盘上有而库里没有的孤儿 | **手动** | — | `pnpm db:gc-files --dry-run` | 无 |
| 缓存计数重算 | 全量重算缓存计数 | **手动** | — | `pnpm db:recount [--check]` | 无 |

没有迁入调度器的原因：

- **每日汇总邮件**：它有「整点 + 24 小时活跃跳过」的判定。系统 cron 与进程内调度同时跑可能重复发信，需要先评估去重语义，所以本期不迁。
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
[scheduler] 已登记 2 个任务：account-deletion.drain、unverified-accounts.purge（时区 Asia/Shanghai）
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
