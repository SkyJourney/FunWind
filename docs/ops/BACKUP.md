# FunWind · 备份与恢复（M13 Step 3）

> 原则：**备份必须演练过才算数**。本文档的全部命令已在本机 docker 对 dev 库实测一轮
> （备份 → 临时容器恢复 → `db:verify` 21 项全过 → 幂等 bootstrap），服务器可照做。
> 恢复演练是上线验收门禁之一（M13 文档 §验收门禁「备份恢复演练签字」）。

## 1. 备份对象（四件套）

| 对象 | 内容 | 工具 | 频率 |
|---|---|---|---|
| MySQL 数据 | `qingyisub` 全库（55 表） | `backup-db.sh`（mysqldump 一致性快照） | 每日 |
| STORAGE_DIR | hex 桶附件/头像 + `site/` 品牌位 + install.lock（排除 `.cache/.tmp` 可再生内容） | `backup-storage.sh`（rsync 增量镜像） | 每日 |
| 根 `.env` | 生产全部环境变量与口令（`/opt/funwind/app/.env`、`/opt/funwind/mysql/.env`） | 手动：改 .env 时同步拷到备份目录（chmod 600） | 变更时 |
| 旧库最终转储 | phpwind 旧库（GBK）+ Flarum 库的归档 dump | 退役窗口执行（见 §5） | 一次性（签字前保留） |

表情包随 git（`public/emoji`），不在存储备份范围。

## 2. 运维任务管线容器（funwind-ops，M13 引入 / M14 更名）

备份执行体已从宿主机脚本迁移为**独立服务容器**（Python + FastAPI + APScheduler，源码 `services/ops/`，2026-11-10 随服务更名）：

- **定时**：服务内置 cron（默认每日 03:10 数据库 / 03:40 存储，`BACKUP_DB_CRON` / `BACKUP_STORAGE_CRON` 可配）。
- **手动**：后台 `/admin/ops`「备份数据库 / 备份存储」按钮（走备份服务 API）；CLI 兜底
  `docker exec funwind-ops python cli.py backup db`。
- **保留策略**：按份数轮转（`BACKUP_KEEP_DB=14` / `BACKUP_KEEP_STORAGE=7`），手动与定时同池，删最旧。
- **产物**：备份卷 `funwind-backup-files`（`db/*.sql.gz`、`storage/*.tgz`，均 gzip 压缩）；
  应用容器只读挂载同卷提供后台下载。
- **元数据**：`ops_runs` 运行台账 + `ops_trigger_state` 触发器状态（管线自治建表；后台历史列表直接查库，
  web 只读）。v1 的 `backup_runs` 由管线启动时幂等改名演进（id 连续保留）。默认任务由 web 侧 bootstrap
  种子写入 `ops_tasks` / `ops_triggers`（M14 起配置与执行解耦，改 cron/份数在后台改配置，管线热加载生效）。
- **互斥**：MySQL `GET_LOCK`——定时/手动/恢复互相排斥。

### 恢复（restore，服务内置）

覆盖式恢复，全部有安全前置（恢复前自动对目标库做一次现场 dump）：

```sh
# 预览（不执行）
docker exec funwind-ops python cli.py restore <run_id> --target-db qingyisub --dry-run
# 真实恢复（--yes 显式确认；MRG_MYISAM 表自动容忍跳过并在结果标注）
docker exec funwind-ops python cli.py restore <run_id> --target-db qingyisub --yes
```

恢复完成后跑 `pnpm db:verify`（env 指向恢复实例）对账。**恢复是覆盖生产库的核弹级操作**：
UI 后续提供，当前仅 CLI/API（`POST /restore`，OPS_TOKEN + confirm 双确认）。

### 保留策略说明

DB 备份单份 ~4.7MB（14 份 ≈ 66MB）、storage 备份单份 ~95MB（7 份 ≈ 665MB）——备份卷峰值约 0.8GB，
持续受保留份数约束不会膨胀。目录继续做异地保护（对象存储/另一台机器拉取）——单机备份不抗整机故障。

### 恢复演练（drill.restore，M14 Step 5 自动化）

「备份必须演练过才算数」的常态化：管线内置 `drill.restore` 任务（默认**每周五 02:00**，启用中），
把最新成功的数据库备份导入**同实例临时库**（`ops_drill_时间戳`）→ 表对账（结构一致 + 核心表行数
抽样进明细）→ 清理。同实例天然同版本；跨实例/跨版本恢复仍按 §4 人工执行（部署/大版本变更时）。
结果在运维页台账可见（kind=drill）；对账失败记 failed 并触发失败告警（ops.alerts）。
与 §4 人工演练互为补充：本任务验证「每周都可用」，人工演练验证「跨实例恢复」。

备份服务容器自带调度器（`BACKUP_DB_CRON` / `BACKUP_STORAGE_CRON` 环境变量，默认每日 03:10 / 03:40），
宿主机无需配置定时任务。备份/恢复的历史在后台 `/admin/ops` 可查（含失败原因），
日志落在管线容器 stdout（`docker logs funwind-ops`；M14 勘误：v1 文档所写
  `/opt/funwind/backups/backup.log` 为 crontab 时代残留，实际无宿主机日志文件）。

> 2026-11-08 历史：初版为宿主机 crontab + `scripts/backup/*.sh`（含服务器 tar 变体），
> 已被备份服务容器整体替代；脚本保留于仓库作参照。手动备份 = 后台 `/admin/ops` 按钮。

## 3. binlog 说明（PITR 边界）

MySQL 8.4 容器默认 `log_bin=ON`，binlog 落在数据卷 `funwind-mysql-data` 内（不在备份目录）：

- **RPO 口径**：dump 每日一次 → 最坏丢 24h；如需更小 RPO，可备份 binlog（`SHOW BINARY LOGS` 后
  `mysqlbinlog --raw` 拉取到备份目录）并按位点重放——当前规模（日均发帖个位数）不值得，记为口径。
- binlog 空间：默认无过期自动清理会持续增长；生产编排可按需加
  `--binlog_expire_logs_seconds=604800`（7 天）。数据卷本身也在备份考量内（见 §4 方式 B）。

## 4. 恢复演练（本机已实测的命令序列）

> 演练目标：备份 → **临时实例**恢复 → 对账全过 → 再考虑切换。绝不直接覆盖线上库。

```sh
# ① 起临时 MySQL 8.4（同版本！跨大版本恢复不受支持）
docker run -d --name funwind-restore-test -e MYSQL_ROOT_PASSWORD=<临时口令> \
  -p 127.0.0.1:33622:3306 mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
# 等待就绪（healthcheck 变 healthy，约 30–60s）

# ② 建库并导入（注意 --default-character-set 与备份一致）
docker exec funwind-restore-test mysql -uroot -p'<临时口令>' \
  -e "CREATE DATABASE qingyisub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc /opt/funwind/backups/mysql/db-qingyisub-<时间戳>.sql.gz | \
  docker exec -i funwind-restore-test mysql -uroot -p'<临时口令>' --default-character-set=utf8mb4 qingyisub

# ③ 对账（21 项：积分台账/outbox/结构完整性/……；用仓库脚本，env 指向临时实例）
NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33622 NEW_DB_PASSWORD=<临时口令> NEW_DB_NAME=qingyisub \
  pnpm --filter @funwind/db verify

# ④ 幂等 bootstrap 冒烟（迁移版本对齐 + 三列 _bin 校验，已恢复库应全部「跳过」）
NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33622 NEW_DB_PASSWORD=<临时口令> NEW_DB_NAME=qingyisub pnpm db:bootstrap

# ⑤ 存储镜像核对（文件清单 diff 应为空）
diff <(cd <生产 storage 卷路径> && find . -type f -not -path './.cache/*' -not -path './.tmp/*' | sort) \
     <(cd /opt/funwind/backups/storage && find . -type f -not -path './.cache/*' -not -path './.tmp/*' | sort)

# ⑥ 清理演练实例
docker rm -f funwind-restore-test
```

实测记录（2026-11-08，本机对 dev 库 `qysub_next`）：dump 4.5MB → 导入 55 表/10763 用户 →
`db:verify` 21 项全过 → 假名账号（さくら/サクラ）字节级无损 → bootstrap 三列 `_bin` 全部「已跳过」。

### 真实故障时的切换（演练通过后才做）

1. `docker compose -f /opt/funwind/app/compose.yaml stop app`（停写）。
2. 确认故障原因；若数据卷损坏，起新卷容器并按 §4 导入最近备份 + 补 binlog（如已备份）。
3. `app/.env` 的 `NEW_DB_*` 指向恢复实例（或换回主库），`docker compose up -d`。
4. `/api/health` 200 + 首页/帖抽样 + `db:verify` 复核。
5. 旧数据卷**保留不删**，问题彻底关闭后再清理。

## 5. 旧库最终转储与旧栈退役序列

> 退役序列详版（含检查单与回滚口）在 `docs/ops/LAUNCH-RUNBOOK.md`（Step 6 交付）；
> 本节是数据口径的权威记录。

```sh
# 旧库（phpwind，GBK）全量转储：连接层转码为 utf8mb4 输出（与迁移管线同一字符集语义）
ssh QY_HK "mysqldump -uroot -p'<旧库口令>' --default-character-set=utf8mb4 --single-transaction \
  --routines --triggers qingyisub | gzip > /opt/funwind-backups/legacy-qingyisub-final-$(date +%Y%m%d).sql.gz"
sha256sum /opt/funwind-backups/legacy-qingyisub-final-*.sql.gz   # 记录校验和到签收单
```

退役序列（上线窗口内、站点未开放时执行）：

1. **① 旧库 dump 归档**（上述命令；utf8mb4 转码输出）。随后停写窗口开始。
2. **② 停旧栈**：`systemctl stop mysqld`（MariaDB，3306 腾出）+ 停 php-fpm-56/php-fpm-83 +
   注释 Flarum 与旧站 vhost（`nginx -t && nginx -s reload`）。**不删任何数据/目录**。
3. **③ MySQL 8.4 独立编排起 3306**（`docker/mysql/compose.yaml`）。
4. **④ 迁移源口径（二选一，演练两条都验证后取稳者）**：
   - 主路径：迁移**在线读 MariaDB**——迁移本为 GBK 源设计；需临时以非 3306 端口拉起 MariaDB
     （如 `127.0.0.1:33620`）供迁移读取，读完即停。
   - 备选：归档恢复为 `qingyisub_legacy` 源库（MySQL 实例导入 dump，改 utf8mb4 口径读）。
5. 迁移 + `verify:migration` 全过后进入新站验收；旧 dump 与数据目录保留至**站长签字**，签字前不删。
