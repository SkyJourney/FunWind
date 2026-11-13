# FunWind · 可观测性（M13 Step 4，D3 最小自建）

> 范围：健康拨测 + 日志约定 + 告警触达验证 + 日级汇总。Sentry 等错误聚合留作后续可选
> （M13 文档 §遗留事项）；多实例监控不在边界内（G-17 未处置前不改拓扑）。

## 1. 健康端点与拨测

`GET /api/health`（无鉴权，不泄露细节）：

- 探两项：DB 连通（`SELECT 1`，3s 超时兜底）与 `STORAGE_DIR` 可写。
- 全部健康：200 `{"status":"ok","db":true,"storage":true}`；任一失败：503 `{"status":"error",...}`。
- 容器 HEALTHCHECK 已配置打此端点（`docker/production/Dockerfile`，30s 间隔）。

### 外部拨测（M17 Step 3：从「建议」升级为待执行清单）

> **实测结论（M17 Step 0）**：外部拨测**从未配置过**。站点日志 `www.qingyisub.top.log` 连续覆盖
> 11-09 17:33 → 11-13 09:30（4 天、90420 行、无轮转归档），其中 `/api/health` 请求数 **0**。
> 不是日志轮转假象：容器 HEALTHCHECK 用的是 `wget http://127.0.0.1:3311/api/health`，
> **直连容器端口、绕过 nginx**，所以 nginx 侧看不到它。
>
> 这意味着「容器挂 / 服务器宕 / 证书过期 / 反代断」四类故障目前**没有任何外部探测**——
> 容器内 HEALTHCHECK 在容器自身挂掉时毫无意义。**这是必须由站长执行的一项**（注册账号无法代做）。

**逐步配置清单**（UptimeRobot 免费档为例，BetterStack 同理）：

1. 注册并登录，新建 Monitor，类型选 **HTTP(s)**。
2. 建**两条** monitor（apex 与 www 都对外提供 200，且证书是通配 `*.qingyisub.top`，两者都要覆盖）：
   - `https://qingyisub.top/api/health`
   - `https://www.qingyisub.top/api/health`
3. 间隔 **5 分钟**（免费档最小粒度）；超时按平台默认（建议 ≤30s）。
4. 判定：**HTTP 200 = up**，其余（含超时、503）= down。503 表示 DB 或存储异常，端点已能区分。
5. 告警联系人绑定**站长主邮箱**；平台若支持手机推送/Telegram 等渠道一并加上（离站触达越快越好）。
6. 建议开启 **SSL 到期提醒**（当前证书有效期至 2027-02-08，通配 `*.qingyisub.top`）。
7. 保存后确认 monitor 状态变为 up。

**配好后的实证核对**（不要只看平台显示 up，要确认请求真的打到了站点）：

```sh
# 在服务器上看 nginx 日志里是否出现周期性外部 /api/health 请求
ssh QY_HK 'grep "/api/health" /www/wwwlogs/www.qingyisub.top.log | tail -5'
# 期望：能看到来自拨测平台 IP 的请求，且间隔约 5 分钟；来源 IP 不是 127.0.0.1
```

核对通过后勾选 §6 检查单第一项。**没验证过请求真的到达，就等于没配。**

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

> M17 Step 3（2026-11-13）逐项实证核对结果。**未验证的不勾**，注明原因与前置条件。

- [ ] **外部拨测已配置且首告警触达验证通过**（§1 清单 / §2 验证）——**未配置**，Step 0 实测 4 天
      90420 行日志零 `/api/health`。§1 已升级为可照做的逐步清单，**待站长执行**（注册账号无法代做）；
      配好后按 §1 的实证核对确认请求真的到达，再勾此项。
- [x] `docker logs funwind-app` 无持续刷屏的 error——近 24h **error/fatal/unhandled 计数 0**；
      `funwind-ops` 同期亦 0；CSP 违规报告 0。
- [ ] **digest 次日到达站长邮箱**——**暂无法核对**：digest 接线在 M17 Step 1（分支
      `feat/m17-quality-observability`），**尚未部署到生产**，生产仍是 M16.1 代码。
      Step 0 实测生产 `email_log` 零 digest 记录。待 M17 部署后次日复核 `scene=digest` 再勾。
- [x] slow log 开启与否已记录决策——**当前关闭**（`@@slow_query_log=0`，`@@long_query_time=10s`）。
      决策：公测期单实例、规模小，**暂不开启**；出现慢查询投诉或 perf 门禁回退时再开。

### 生产检查单其余项（M17 Step 3 实证，对应 M13 遗留「域名/证书/robots/sitemap/性能预算」）

- [x] **域名**：`https://qingyisub.top` 与 `https://www.qingyisub.top` 均直接返回 200（无重定向链）。
- [x] **证书**：通配 `*.qingyisub.top`，有效期 2026-11-10 → **2027-02-08**（核对时余量充足）。
- [x] **robots.txt**：200，规则正确（`Allow: /`；禁抓 `/admin`、`/api/`、`/files`、`/login`、`/register`、`/forgot`）。
- [x] **sitemap.xml**：200，合法 `urlset`，**980 条 `<loc>` 全为本站域名**。
- [x] **性能预算**：M16.1 部署后生产实测 LCP 首页 716 / 版块 832 / 帖子 948 / 搜索 564ms，
      全部远低于 2500ms 预算（当前生产即该构建，未再变更）。
- [x] **健康端点**：`/api/health` 公网 200（DB + 存储双探针）。
