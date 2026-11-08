# FunWind · 可观测性（M13 Step 4，D3 最小自建）

> 范围：健康拨测 + 日志约定 + 告警触达验证 + 日级汇总。Sentry 等错误聚合留作后续可选
> （M13 文档 §遗留事项）；多实例监控不在边界内（G-17 未处置前不改拓扑）。

## 1. 健康端点与拨测

`GET /api/health`（无鉴权，不泄露细节）：

- 探两项：DB 连通（`SELECT 1`，3s 超时兜底）与 `STORAGE_DIR` 可写。
- 全部健康：200 `{"status":"ok","db":true,"storage":true}`；任一失败：503 `{"status":"error",...}`。
- 容器 HEALTHCHECK 已配置打此端点（`docker/production/Dockerfile`，30s 间隔）。

**外部拨测配置建议**（免费档即可，如 UptimeRobot/BetterStack）：

| 监视项 | 配置 |
|---|---|
| URL | `https://www.qingyisub.top/api/health` |
| 间隔 | 5 分钟（免费档最小粒度） |
| 判定 | HTTP 200 = up，其余（含超时）= down |
| 通知 | 邮件（站长主邮箱）；可加手机推送渠道 |

拨测走公网，天然覆盖「容器挂 / 服务器宕 / 证书过期 / 反代断」四类故障；DB/存储故障由 503 区分。

## 2. 告警触达验证（上线门禁「人为制造一次错误」）

上线后执行一次，确认「故障 → 告警到手机/邮箱」全链路：

```sh
# 在服务器上停 app 容器制造故障
cd /opt/funwind/app && docker compose stop app
# 等 1–2 个拨测周期（5–10 分钟），确认收到 down 告警
docker compose start app
# 确认收到恢复（up）通知
```

若 15 分钟内未收到告警：检查拨测平台配置（URL/关键词/通知渠道），修完重验——
**没验证过触达的监控等于没有监控**。

## 3. 日志约定（结构化前缀）

应用日志统一 `[前缀] 消息`（stdout → `docker logs funwind-app`；nginx 侧另见
`/www/wwwlogs/www.qingyisub.top.log` 与 `.error.log`）。检索：`docker logs funwind-app 2>&1 | grep "\[安装\]"`。

| 前缀 | 模块 | 典型内容 |
|---|---|---|
| `[install]` | 安装管线 | 步骤失败原因、默认站标初始化 |
| `[bootstrap]` | 建表/系统种子 | 迁移应用、排序规则对齐、_bin 补丁、种子计数 |
| `[recall]` | 召回发送 | （由 email_log 承载；stdout 只有 CLI 进度行） |
| `[digest]` | 每日汇总 | digest 周期执行结果（runDigestOnce 计数） |
| `[scheduler]` | 定时任务调度器 | 任务启停、命名锁竞争 |
| `[audit]` | 审计写入失败 | 审计落库异常（安全相关，出现即需排查） |

错误日志的处理原则：`console.error` 都带原始 Error 对象（栈完整）；面向用户的文案不含内部细节
（与 `/api/health` 同口径）。生产日志轮转由 compose `max-size: 10m / max-file: 5` 承担。

## 4. 日级汇总（digest 邮件）

站长（及所有开启偏好的用户）每日收到社区动态汇总（S7 管线，`docs/EMAIL-SCENARIOS.md`）——
它是「站点活着」的日级心跳：**连续两天没收到 digest 本身就是告警信号**（SMTP 挂了或调度器没跑）。
调度器开启方式见 `docs/SCHEDULED-JOBS.md`（生产单实例：`SCHEDULER=on`）。

## 5. 数据库侧

- 慢查询：生产编排按需开启 MySQL slow log
  （`docker/mysql/compose.yaml` 的 command 追加
  `--slow_query_log=1 --long_query_time=1 --slow_query_log_file=/var/lib/mysql/slow.log`），
  `docker exec funwind-mysql cat /var/lib/mysql/slow.log` 查看。
- 对账：`pnpm db:verify`（21 项：积分台账/结构完整性/outbox 滞留/…）——恢复演练与月度巡检跑。
- 连接数/内存：`docker stats funwind-mysql`（256M buffer pool 基线，2GB 服务器）。

## 6. 上线检查单（可观测段）

- [ ] 外部拨测已配置且首告警触达验证通过（§2）
- [ ] `docker logs funwind-app` 无持续刷屏的 error
- [ ] digest 次日到达站长邮箱
- [ ] slow log 开启与否已记录决策（规模小可不开）
