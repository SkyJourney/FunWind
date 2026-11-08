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

## 2. 备份脚本

### backup-db.sh（宿主机执行，经容器内 mysqldump）

```sh
# 生产（每日 crontab；口令取容器 env，不出现在宿主机命令行）
BACKUP_DIR=/opt/funwind/backups/mysql CONTAINER=funwind-mysql DATABASE=qingyisub \
  /opt/funwind/app/scripts/backup/backup-db.sh
```

- `--single-transaction`：InnoDB 一致性快照，不锁写（备份期间站点可用）。
- 产出 `db-<库名>-YYYYmmdd-HHMMSS.sql.gz` + 同名 `.sha256`；内置完整性自检
  （gzip 可解压 + `Dump completed` 尾标——管道中断不会产出半截文件冒充成功）。
- 轮转：`RETAIN_DAYS`（默认 14）按 mtime 删除过期备份。
- 本机对 dev 库：`CONTAINER=qysub-next-mysql DATABASE=qysub_next`。

### backup-storage.sh（rsync 增量镜像）

```sh
# 生产：STORAGE_DIR 用宿主机上的实际卷路径（docker volume 在 /var/lib/docker/volumes/funwind-storage/_data）
STORAGE_DIR=/var/lib/docker/volumes/funwind-storage/_data BACKUP_DIR=/opt/funwind/backups \
  /opt/funwind/app/scripts/backup/backup-storage.sh
```

- 严格镜像（默认 `--delete`：源端删除会同步到备份）；`WITH_DELETE=0` 可保守保留已删文件。
- 护栏：DEST 固定 `$BACKUP_DIR/storage` 且与 SRC 互不嵌套——参数颠倒会拒绝执行。
- 排除 `.cache/`（缩略图缓存）与 `.tmp/`（可再生）。

### 建议的 crontab（宝塔「计划任务」→ Shell 脚本）

```cron
# 每日 03:10 数据库全备（保留 14 天）
10 3 * * * BACKUP_DIR=/opt/funwind/backups/mysql CONTAINER=funwind-mysql DATABASE=qingyisub /opt/funwind/app/scripts/backup/backup-db.sh >> /opt/funwind/backups/backup.log 2>&1
# 每日 03:40 存储镜像
40 3 * * * STORAGE_DIR=/var/lib/docker/volumes/funwind-storage/_data BACKUP_DIR=/opt/funwind/backups /opt/funwind/app/scripts/backup/backup-storage.sh >> /opt/funwind/backups/backup.log 2>&1
```

备份目录建议再做一层异地保护（对象存储/另一台机器 rsync/pull 式拉取）——单机备份不抗整机故障。

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
