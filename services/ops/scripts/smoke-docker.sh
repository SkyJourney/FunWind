#!/usr/bin/env bash
# 运维任务管线 · 本机 docker 全链路冒烟（M14 Step 1 门禁；Step 6 部署前复跑）
#
# 用法：services/ops/scripts/smoke-docker.sh [镜像标签]（默认 funwind-ops:smoke，需先 docker build）
# 全程自建临时 MySQL 8.4 容器、临时网络与临时目录，口令随机生成且只经 env 文件传入；结束自动清理，
# 不触碰任何开发库 / 生产库。任一断言失败立即以非零退出。
#
# 覆盖：v1 旧台账 backup_runs 演进（改名保 id + 回填 task_key）→ 健康 200 → 异步手动触发 db/storage →
# 同组忙碌 409 → 旧同步端点 → 保留策略轮转（site_settings）→ CLI 状态/台账/恢复（dry-run 与真实恢复，
# 假名字节级核对，安全 dump 不参与轮转）→ 日志不含口令 → 缺必需配置降级不崩溃 → 库不可达降级并自愈。
set -euo pipefail

IMAGE="${1:-funwind-ops:smoke}"
PREFIX="ops-smoke-$$"
NET="$PREFIX-net"
DB="$PREFIX-mysql"
OPS="$PREFIX-ops"
NOENV="$PREFIX-noenv"
HEAL="$PREFIX-heal"
DB_NAME="qingyisub_smoke"
PORT="${OPS_SMOKE_PORT:-18480}"
WORK="$(mktemp -d)"
ROOT_PW="$(openssl rand -hex 16)"
TOKEN="$(openssl rand -hex 16)"
BASE="http://127.0.0.1:$PORT"

cleanup() {
  docker rm -f "$DB" "$OPS" "$NOENV" "$HEAL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

pass() { echo "✔ $*"; }
fail() {
  echo "✘ $*"
  echo "---- $OPS 日志尾部 ----"
  docker logs --tail 40 "$OPS" 2>&1 || true
  exit 1
}

# 断言辅助：先完整捕获输出，再在字符串里匹配。不写「生产者 | grep -q」——grep -q 命中即退出，
# 生产者后续写入撞 SIGPIPE，pipefail 下整条管道判失败（命中反被当成失败）。
has() { grep -q -- "$2" <<<"$1"; }
has_fixed() { grep -qF -- "$2" <<<"$1"; }
has_line() { grep -qx -- "$2" <<<"$1"; }

# 容器内 mysql 客户端执行 SQL（口令经 MYSQL_PWD 环境变量，不进命令行参数）
sql() { docker exec -e MYSQL_PWD="$ROOT_PW" "$DB" mysql -uroot -N -B "$DB_NAME" -e "$1"; }

# 从容器内部取 /health 状态码（未发布端口的容器也能探）
health_code() {
  docker exec "$1" python -c 'import urllib.request, urllib.error
try:
    print(urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=3).status)
except urllib.error.HTTPError as exc:
    print(exc.code)
except Exception:
    print(0)'
}

json_field() { python3 -c "import json,sys; print(json.load(sys.stdin)$1)"; }

wait_mysql_ready() {
  local i
  for i in $(seq 1 90); do
    if docker exec -e MYSQL_PWD="$ROOT_PW" "$DB" mysql -uroot -N -e "SELECT 1" "$DB_NAME" >/dev/null 2>&1 \
      && has "$(docker logs "$DB" 2>&1)" "ready for connections.*port: 3306"; then
      return 0
    fi
    sleep 2
  done
  fail "临时 MySQL 未就绪"
}

wait_run() {
  local run_id="$1" status i
  for i in $(seq 1 60); do
    status="$(curl -sf -H "X-OPS-Token: $TOKEN" "$BASE/runs/$run_id" | json_field '["status"]')"
    [ "$status" != "running" ] && { echo "$status"; return 0; }
    sleep 1
  done
  echo "timeout"
}

trigger_async() {
  local task_key="$1" code
  code="$(curl -s -o "$WORK/resp.json" -w '%{http_code}' -X POST -H "X-OPS-Token: $TOKEN" "$BASE/tasks/$task_key/runs")"
  [ "$code" = "202" ] || fail "异步触发 ${task_key} 期望 202，实际 ${code}：$(cat "$WORK/resp.json")"
  json_field '["run_id"]' <"$WORK/resp.json"
}

# ── 1. 临时 MySQL 8.4 + 种子（模拟生产现状：v1 旧台账、后台保留策略、业务数据） ──
cat >"$WORK/mysql.env" <<EOF
MYSQL_ROOT_PASSWORD=$ROOT_PW
MYSQL_DATABASE=$DB_NAME
EOF
docker network create "$NET" >/dev/null
docker run -d --name "$DB" --network "$NET" --env-file "$WORK/mysql.env" mysql:8.4 \
  --character-set-server=utf8mb4 --collation-server=utf8mb4_unicode_ci >/dev/null
wait_mysql_ready
pass "临时 MySQL 8.4 就绪"

sql "CREATE TABLE backup_runs (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('db','storage','restore') NOT NULL,
  trigger_source ENUM('cron','manual') NOT NULL,
  status ENUM('running','success','failed') NOT NULL,
  path VARCHAR(255) NULL, size_bytes BIGINT UNSIGNED NULL, detail TEXT NULL, error TEXT NULL,
  started_at DATETIME NOT NULL, finished_at DATETIME NULL,
  INDEX idx_started (started_at), INDEX idx_kind_status (kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
INSERT INTO backup_runs (kind, trigger_source, status, path, started_at, finished_at) VALUES
  ('db', 'cron', 'success', '/data/backups/db/legacy.sql.gz', NOW(), NOW()),
  ('storage', 'cron', 'success', '/data/backups/storage/legacy.tgz', NOW(), NOW());
CREATE TABLE site_settings (\`key\` VARCHAR(64) PRIMARY KEY, value JSON NOT NULL);
INSERT INTO site_settings VALUES ('ops.backup.policy', '{\"keepDb\": 3, \"keepStorage\": 2}');
CREATE TABLE notes (id INT PRIMARY KEY, body VARCHAR(32) COLLATE utf8mb4_bin) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
INSERT INTO notes VALUES (1, 'さくら'), (2, 'サクラ'), (3, '青翼');"
pass "种子：v1 旧台账 2 行 + 保留策略 keepDb=3 + 假名样例数据"

mkdir -p "$WORK/backups" "$WORK/storage/ab" "$WORK/storage/.cache"
echo "payload" >"$WORK/storage/ab/file.bin"
echo "regenerable" >"$WORK/storage/.cache/thumb.webp"

# ── 2. 起管线（与生产同样的 restart 策略） ──
cat >"$WORK/ops.env" <<EOF
BACKUP_DB_HOST=$DB
BACKUP_DB_PASSWORD=$ROOT_PW
BACKUP_DB_NAME=$DB_NAME
OPS_TOKEN=$TOKEN
EOF
docker run -d --name "$OPS" --network "$NET" --restart unless-stopped -p "127.0.0.1:$PORT:8000" \
  --env-file "$WORK/ops.env" -v "$WORK/backups:/data/backups" -v "$WORK/storage:/source/storage:ro" \
  "$IMAGE" >/dev/null
for i in $(seq 1 60); do
  [ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" = "200" ] && break
  sleep 1
done
[ "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")" = "200" ] || fail "管线未在 60 秒内健康"
logs="$(docker logs "$OPS" 2>&1)"
has "$logs" "管线就绪" || fail "日志缺少「管线就绪」"
has "$logs" "台账演进=rename-legacy、add-task-key、widen-kind、widen-trigger_source、create-state" \
  || fail "台账演进动作与预期不符"
pass "管线健康 200，引导日志含完整台账演进动作"

# ── 3. 台账演进核对 ──
tables="$(sql "SHOW TABLES")"
has_line "$tables" "ops_runs" || fail "缺少 ops_runs"
has_line "$tables" "ops_trigger_state" || fail "缺少 ops_trigger_state"
has_line "$tables" "backup_runs" && fail "旧表 backup_runs 未改名"
[ "$(sql "SELECT GROUP_CONCAT(CONCAT(id, ':', task_key) ORDER BY id) FROM ops_runs")" = "1:backup.db,2:backup.storage" ] \
  || fail "旧台账 id 或 task_key 回填不符"
pass "backup_runs → ops_runs：id 1/2 保留、task_key 回填"

# ── 4. 异步手动触发：db / storage ──
run_db="$(trigger_async backup.db)"
[ "$(wait_run "$run_db")" = "success" ] || fail "db 备份 run #$run_db 未成功"
db_file="$(curl -sf -H "X-OPS-Token: $TOKEN" "$BASE/runs/$run_db" | json_field '["path"]')"
host_db_file="$WORK/backups/${db_file#/data/backups/}"
gzip -t "$host_db_file" || fail "db 备份 gzip 校验失败"
has "$(gzip -dc "$host_db_file" | tail -c 200)" "Dump completed" || fail "db 备份缺尾标"
pass "异步触发 db 备份 → run #$run_db success，产物 gzip 完整、含尾标（真实 mysqldump）"

run_st="$(trigger_async backup.storage)"
[ "$(wait_run "$run_st")" = "success" ] || fail "storage 备份 run #$run_st 未成功"
st_file="$(curl -sf -H "X-OPS-Token: $TOKEN" "$BASE/runs/$run_st" | json_field '["path"]')"
listing="$(tar -tzf "$WORK/backups/${st_file#/data/backups/}")"
has "$listing" "ab/file.bin" || fail "storage 备份缺少业务文件"
has "$listing" "\.cache" && fail "storage 备份不应包含 .cache"
pass "异步触发 storage 备份 → run #$run_st success，排除 .cache"

# ── 5. 同组忙碌 409（恢复与备份同一互斥组） ──
sql "INSERT INTO ops_runs (kind, task_key, trigger_source, status, started_at) VALUES ('restore', 'restore', 'manual', 'running', NOW())"
code="$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-OPS-Token: $TOKEN" "$BASE/tasks/backup.db/runs")"
sql "DELETE FROM ops_runs WHERE kind = 'restore' AND status = 'running'"
[ "$code" = "409" ] || fail "同组忙碌期望 409，实际 $code"
pass "同组有任务运行时手动触发返回 409"

# ── 6. 鉴权与旧同步端点 ──
[ "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H "X-OPS-Token: wrong" "$BASE/tasks/backup.db/runs")" = "401" ] \
  || fail "错误口令应 401"
[ "$(curl -s -o "$WORK/legacy.json" -w '%{http_code}' -X POST -H "X-OPS-Token: $TOKEN" "$BASE/runs?kind=db")" = "200" ] \
  || fail "旧同步端点失败：$(cat "$WORK/legacy.json")"
pass "错误口令 401；旧同步端点 POST /runs?kind=db 200（兼容期）"

# ── 7. 保留策略轮转（site_settings keepDb=3） ──
for _ in 1 2; do
  run="$(trigger_async backup.db)"
  [ "$(wait_run "$run")" = "success" ] || fail "轮转用 db 备份 run #$run 未成功"
done
count="$(find "$WORK/backups/db" -name "db-$DB_NAME-[0-9]*.sql.gz" | wc -l | tr -d ' ')"
[ "$count" = "3" ] || fail "保留 3 份期望 3，实际 $count"
pass "4 次 db 备份后按 site_settings 保留 3 份"

# ── 8. CLI：状态 / 台账 / 恢复（dry-run 与真实恢复） ──
out="$(docker exec "$OPS" python cli.py status)" || fail "CLI status 退出非零"
has "$out" "配置来源：default" || fail "CLI status 输出缺配置来源：$out"
docker exec "$OPS" python cli.py runs 3 >/dev/null || fail "CLI runs 失败"
out="$(docker exec "$OPS" python cli.py restore "$run_db" --target-db smoke_scratch --dry-run)" || fail "CLI dry-run 退出非零"
has "$out" "\[dry-run\]" || fail "CLI restore dry-run 输出异常：$out"
if docker exec "$OPS" python cli.py restore "$run_db" --target-db 'bad;name' --yes >/dev/null 2>&1; then
  fail "非法目标库名应被拒绝"
fi
# 恢复源用新鲜备份：run_db 的产物可能已被上一节轮转删除（保留份数语义），恢复器报「文件缺失」是正确行为
run_src="$(trigger_async backup.db)"
[ "$(wait_run "$run_src")" = "success" ] || fail "恢复源 db 备份 run #$run_src 未成功"
out="$(docker exec "$OPS" python cli.py restore "$run_src" --target-db smoke_scratch --yes)" || fail "CLI 真实恢复退出非零"
has "$out" "恢复完成" || fail "CLI 真实恢复输出异常：$out"
restored="$(docker exec -e MYSQL_PWD="$ROOT_PW" "$DB" mysql -uroot -N -B smoke_scratch -e "SELECT GROUP_CONCAT(body ORDER BY id) FROM notes")"
[ "$restored" = "さくら,サクラ,青翼" ] || fail "恢复数据不符：$restored"
out="$(docker exec "$OPS" python cli.py restore "$run_src" --target-db smoke_scratch --yes)" || fail "CLI 二次恢复退出非零"
has "$out" "恢复前现场 dump" || fail "覆盖已有库时应先做安全 dump：$out"
pre_count="$(find "$WORK/backups/db" -name "db-smoke_scratch-pre-restore-*.sql.gz" | wc -l | tr -d ' ')"
[ "$pre_count" = "1" ] || fail "安全 dump 期望 1 份，实际 $pre_count"
run="$(trigger_async backup.db)"
[ "$(wait_run "$run")" = "success" ] || fail "恢复后 db 备份失败"
[ -n "$(find "$WORK/backups/db" -name "db-smoke_scratch-pre-restore-*.sql.gz")" ] || fail "安全 dump 被轮转误删"
pass "CLI：status/runs/dry-run/白名单拒绝/真实恢复（假名字节级一致）/覆盖前安全 dump 且不参与轮转"

# ── 9. 日志：结构化前缀在、口令不在 ──
logs="$(docker logs "$OPS" 2>&1)"
has "$logs" "\[ops\] task=backup.db" || fail "缺少 [ops] 结构化日志"
has_fixed "$logs" "$ROOT_PW" && fail "日志里出现了数据库口令"
pass "日志含 [ops] 结构化前缀，且不含数据库口令"

# ── 10. 降级：缺必需配置——存活、不崩溃循环、/health 503 ──
grep -v '^OPS_TOKEN=' "$WORK/ops.env" >"$WORK/noenv.env"
docker run -d --name "$NOENV" --network "$NET" --restart unless-stopped --env-file "$WORK/noenv.env" "$IMAGE" >/dev/null
sleep 8
[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$NOENV")" = "true 0" ] || fail "缺配置时容器崩溃或重启"
[ "$(health_code "$NOENV")" = "503" ] || fail "缺配置时 /health 应 503"
has "$(docker logs "$NOENV" 2>&1)" "缺少必需环境变量 OPS_TOKEN" || fail "缺配置日志不明确"
pass "缺 OPS_TOKEN：容器存活、重启 0 次、/health 503、日志点名缺失项"

# ── 11. 降级 + 自愈：库不可达时重试，库恢复后无需重启即健康 ──
docker stop "$DB" >/dev/null
docker run -d --name "$HEAL" --network "$NET" --restart unless-stopped --env-file "$WORK/ops.env" \
  -e OPS_BOOTSTRAP_RETRY_SECONDS=2 -v "$WORK/backups:/data/backups" -v "$WORK/storage:/source/storage:ro" \
  "$IMAGE" >/dev/null
sleep 8
[ "$(docker inspect -f '{{.State.Running}} {{.RestartCount}}' "$HEAL")" = "true 0" ] || fail "库不可达时容器崩溃或重启"
[ "$(health_code "$HEAL")" = "503" ] || fail "库不可达时 /health 应 503"
has "$(docker logs "$HEAL" 2>&1)" "引导失败" || fail "库不可达日志缺少重试记录"
docker start "$DB" >/dev/null
wait_mysql_ready
for i in $(seq 1 30); do
  [ "$(health_code "$HEAL")" = "200" ] && break
  sleep 2
done
[ "$(health_code "$HEAL")" = "200" ] || fail "库恢复后 60 秒内未自愈"
[ "$(docker inspect -f '{{.RestartCount}}' "$HEAL")" = "0" ] || fail "自愈过程中发生了容器重启"
pass "库不可达：存活 + 503 + 按间隔重试；库恢复后自愈为 200，全程 0 次重启"

echo "全部冒烟断言通过（镜像 ${IMAGE}）"
