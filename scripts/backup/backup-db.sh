#!/usr/bin/env sh
# FunWind · MySQL 全备脚本（M13 Step 3）
# ============================================================
# 形态：在宿主机执行，经 docker exec 调容器内 mysqldump——宿主机无需 mysql 客户端，
# 口令取容器 env（$MYSQL_ROOT_PASSWORD），不出现在宿主机命令行/进程列表。
# 用法：
#   BACKUP_DIR=/opt/funwind/backups/mysql CONTAINER=funwind-mysql DATABASE=qingyisub \
#     scripts/backup/backup-db.sh
# 环境变量（均有默认值）：
#   BACKUP_DIR 备份输出目录（默认 /opt/funwind/backups/mysql）
#   CONTAINER  MySQL 容器名（默认 funwind-mysql；本机 dev 为 qysub-next-mysql）
#   DATABASE   库名（默认 qingyisub）
#   RETAIN_DAYS 保留天数（默认 14，按文件 mtime 轮转）
# 产出：$BACKUP_DIR/db-$DATABASE-YYYYmmdd-HHMMSS.sql.gz（+ 同名 .sha256）
# 语义：--single-transaction（InnoDB 一致性快照，不锁写）；绝不 DROP/改动源库。
# binlog：MySQL 8.4 默认 log_bin=ON，binlog 在数据卷内（不在本备份目录）——PITR 说明见 docs/ops/BACKUP.md。
set -eu

BACKUP_DIR="${BACKUP_DIR:-/opt/funwind/backups/mysql}"
CONTAINER="${CONTAINER:-funwind-mysql}"
DATABASE="${DATABASE:-qingyisub}"
RETAIN_DAYS="${RETAIN_DAYS:-14}"

command -v docker >/dev/null || { echo "需要 docker CLI"; exit 1; }
docker inspect "$CONTAINER" >/dev/null 2>&1 || { echo "容器不存在：$CONTAINER"; exit 1; }

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/db-$DATABASE-$STAMP.sql.gz"

# 容器内 mysqldump：--single-transaction 一致性快照；--set-gtid-purged=OFF（生产未启用 GTID，
# 避免 8.4 dump 头带 GTID 段干扰恢复到无 GTID 实例）；routines/triggers/events 全量包含。
docker exec "$CONTAINER" sh -c '
  exec mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
    --single-transaction --set-gtid-purged=OFF \
    --routines --triggers --events --default-character-set=utf8mb4 "$1"
' sh "$DATABASE" | gzip > "$OUT"

# 完整性自检：gzip 可解压、非空、包含建表语句结尾（防管道中断产出半截文件）
[ -s "$OUT" ] || { echo "备份文件为空：$OUT"; exit 1; }
gzip -t "$OUT" || { echo "gzip 校验失败：$OUT"; exit 1; }
if ! gzip -dc "$OUT" | tail -c 200 | grep -q "Dump completed"; then
  echo "备份未完整结束（缺 Dump completed 尾标）：$OUT"; exit 1;
fi

# 校验和（恢复前先比对外部记录，防备份介质静默损坏）
shasum -a 256 "$OUT" > "$OUT.sha256"

# 轮转：删除超过保留期的备份与校验文件（仅限本目录，mtime 判定）
find "$BACKUP_DIR" -name "db-*.sql.gz" -mtime "+$RETAIN_DAYS" -delete
find "$BACKUP_DIR" -name "db-*.sql.gz.sha256" -mtime "+$RETAIN_DAYS" -delete

SIZE="$(du -h "$OUT" | cut -f1)"
LEFT="$(find "$BACKUP_DIR" -name "db-*.sql.gz" | wc -l | tr -d ' ')"
echo "✔ 备份完成：$OUT ($SIZE)；保留 ${LEFT} 份（RETAIN_DAYS=${RETAIN_DAYS}）"
