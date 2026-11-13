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
- binlog 空间：默认无过期自动清理会持续增长。**生产编排 `docker/mysql/compose.yaml` 已配**
  `--binlog-expire-logs-seconds=604800`（7 天）+ `--max-binlog-size=268435456`（256MB，
  默认是 1GB）。两个一起加的原因：过期只在**轮转**时判定，文件越大，7 天窗口的溢出越多。
  数据卷本身也在备份考量内（见 §4 方式 B）。

### 3.1 本机 dev/预览实例：binlog 已关闭（2026-11-12）

本机的 `qysub-next` 预览实例（`docker/qysub-next/compose.yaml`，127.0.0.1:33621）
是**本地开发 + 预览**用途，**已加 `--skip-log-bin` 关掉 binlog**：

- 依据：上面的 RPO 口径本就是「每日全备 → 最坏丢 24h」，binlog 只服务 PITR，本机不需要；
  每日 mysqldump 全备（`scripts/backup/backup-db.sh`，含 sha256 与 14 天轮转）已覆盖恢复需求。
- 收益：此前 binlog 无过期策略，13 个文件累积到 8.6G；关闭后数据目录 9.7G → 1.1G。
- 代价：**本实例没有 PITR**，损坏时只能回到最近一次全备（最坏丢 24h），不能做秒级回滚。
- 一次性清理存量 binlog 用（MySQL 8.4 已移除 `RESET MASTER`，改用新语法）：
  ```sh
  docker exec qysub-next-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" \
    -e "RESET BINARY LOGS AND GTIDS;"'
  ```
- ⚠️ **生产编排（`funwind-mysql`）不要照抄这条**——那边需要 PITR，保持 `log_bin=ON`，
  按需配 `--binlog_expire_logs_seconds` 控制空间。

### 3.2 各 MySQL 实例的 binlog 现状（2026-11-12 盘点）

| 实例 | 版本 | binlog | 保留策略 |
|---|---|---|---|
| `funwind-mysql`（生产，站长服务器） | 8.4 | ON | `--binlog-expire-logs-seconds=604800` + `--max-binlog-size=256M` |
| `qysub-next-mysql`（本机 dev/预览） | 8.4 | **OFF** | 无需，见 §3.1 |
| `qingyisub-mysql`（本机 phpwind 只读副本） | 5.7.44 | **OFF** | 5.7 服务端默认就是 OFF |
| `mysql-260422/260529/260615`（health-data，本机） | 8.4 | **OFF** | `conf.d/custom.cnf` 已配 `skip-log-bin` |

> ⚠️ **版本坑**：`--binlog-expire-logs-seconds` 是 MySQL **8.0+** 才有的秒级参数。
> 5.7 只认 `--expire-logs-days`（整数天），写成秒级参数会让 mysqld 直接
> `unknown variable` 启动失败（已实测 mysql:5.7.44 报此错）。

## 4. 恢复演练（已实测的命令序列）

> 演练目标：备份 → **临时实例**恢复 → 对账全过 → 再考虑切换。绝不直接覆盖线上库。

> **路径勘误（M17 Step 3 实测修正）**：本节旧版命令指向 `/opt/funwind/backups/mysql/` 与
> `/opt/funwind/backups/storage`——那是 **M13 宿主机 crontab 时代**的路径，M14 换成 ops 容器后
> 已不再写入，那里只剩 2026-11-08 的遗留文件。**照旧命令做演练会把 5 天前的旧备份当「最新」**。
> 真实落盘位置由 ops 容器挂载决定（`docker inspect funwind-ops` 可查）：
> `/var/lib/docker/volumes/funwind-backup-files/_data/{db,storage}/`，文件名含完整时间戳与随机后缀。
> 另：存储备份是 **`.tgz` 归档而非目录**，旧版用 `find` 比对目录的写法不适用，已改为归档清单比对。

```sh
# ⑩ 先定位最新备份（不要用文档里的示例文件名，每次都在变）
ssh QY_HK 'B=/var/lib/docker/volumes/funwind-backup-files/_data; ls -lt $B/db/ | head -3; ls -lt $B/storage/ | head -3'
# 台账 ops_runs 的 path 字段也记录了每次备份的真实路径，可交叉核对：
#   SELECT kind, status, path, size_bytes FROM qingyisub.ops_runs ORDER BY id DESC LIMIT 6;

# ① 起临时 MySQL 8.4（同版本！跨大版本恢复不受支持）
docker run -d --name funwind-restore-test -e MYSQL_ROOT_PASSWORD=<临时口令> \
  -p 127.0.0.1:33622:3306 mysql:8.4 --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci
# 等待就绪：docker exec funwind-restore-test mysqladmin ping -uroot -p'<临时口令>'

# ② 取备份并校验完整性（在本机做演练时先 scp 下来，sha256 必须与生产一致）
scp QY_HK:/var/lib/docker/volumes/funwind-backup-files/_data/db/<最新文件>.sql.gz /tmp/
ssh QY_HK 'sha256sum /var/lib/docker/volumes/funwind-backup-files/_data/db/<最新文件>.sql.gz'
shasum -a 256 /tmp/<最新文件>.sql.gz   # 两个哈希必须相同

# ③ 建库并导入（注意 --default-character-set 与备份一致）
docker exec funwind-restore-test mysql -uroot -p'<临时口令>' \
  -e "CREATE DATABASE qingyisub CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
gzip -dc /tmp/<最新文件>.sql.gz | \
  docker exec -i funwind-restore-test mysql -uroot -p'<临时口令>' --default-character-set=utf8mb4 qingyisub

# ④ 对账（21 项：积分台账/outbox/结构完整性/……；用仓库脚本，env 指向临时实例）
NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33622 NEW_DB_USER=root NEW_DB_PASSWORD=<临时口令> NEW_DB_NAME=qingyisub \
  pnpm --filter @funwind/db verify

# ⑤ 幂等 bootstrap 冒烟（迁移版本对齐 + 三列 _bin 校验，已恢复库应全部「跳过」）
NEW_DB_HOST=127.0.0.1 NEW_DB_PORT=33622 NEW_DB_USER=root NEW_DB_PASSWORD=<临时口令> NEW_DB_NAME=qingyisub \
  pnpm db:bootstrap

# ⑥ 存储镜像核对（归档清单 vs 生产卷清单，逐条 diff 应为空；再抽样做字节级校验）
ssh QY_HK 'B=/var/lib/docker/volumes/funwind-backup-files/_data/storage/<最新>.tgz; \
  S=/var/lib/docker/volumes/funwind-storage/_data; \
  tar -tzf "$B" | grep -v "/$" | sed "s|^\./||" | sort > /tmp/bak.txt; \
  (cd "$S" && find . -type f -not -path "./.cache/*" -not -path "./.tmp/*" | sed "s|^\./||" | sort) > /tmp/prod.txt; \
  diff /tmp/bak.txt /tmp/prod.txt && echo "(清单一致)"; \
  for f in $(head -3 /tmp/prod.txt); do \
    a=$(sha256sum "$S/$f" | cut -d" " -f1); \
    b=$(tar -xzOf "$B" "./$f" | sha256sum | cut -d" " -f1); \
    [ "$a" = "$b" ] && echo "OK $f" || echo "MISMATCH $f"; done; \
  rm -f /tmp/bak.txt /tmp/prod.txt'

# ⑦ 清理演练实例与本机临时文件（不要留临时 MySQL 占资源）
docker rm -f funwind-restore-test && rm -f /tmp/<最新文件>.sql.gz
```

实测记录（2026-11-08，本机对 dev 库 `qysub_next`）：dump 4.5MB → 导入 55 表/10763 用户 →
`db:verify` 21 项全过 → 假名账号（さくら/サクラ）字节级无损 → bootstrap 三列 `_bin` 全部「已跳过」。

**实测记录（2026-11-13，M17 Step 3，对生产备份跨实例演练）**：
最新备份 `db-qingyisub-2026-11-13-031000-001937-a6c3d7.sql.gz`（4,767,862 字节）→
scp 到本机后 **sha256 与生产双向一致**（`84e62057…b02e`）→ 临时 MySQL 8.4（本机 33622）→
**导入 3 秒、59 张表**（drizzle schema 56 + 管线自治 3：`ops_runs`/`ops_trigger_state`/`backup_runs`）、
**10763 用户** → **`db:verify` 21 项全过**（含三列 `utf8mb4_bin` 精确比较、积分余额=台账之和无负余额、
孤儿引用全 0、outbox 无滞留）→ **bootstrap 幂等**：三列 `_bin` 全部「patch 跳过」、新增授权/设置/运维任务全 0
（证明备份与当前迁移版本对齐）→ **存储镜像**：归档与生产卷各 **2048 个文件、清单逐条一致**，
抽样 3 个文件字节级 sha256 全 OK → 演练实例与本机临时文件已清理（容器 0 / 端口 0 / 目录已删）。
备份保留策略实测正常：db 与 storage **各 9 份**。

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
