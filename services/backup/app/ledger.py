"""运行台账（ops_runs）与触发器状态（ops_trigger_state）：管线自治建表与写入，web 只读（M14 D1/D7）。

台账由 v1 的 backup_runs 幂等演进而来（D7）：启动时若只有旧表，单语句改名并补列——数据与 id 全保
（恢复按 run id 定位备份文件，id 不能断）。新旧两表并存只会出现在「回滚后再升级」的场景：旧镜像会
重建 backup_runs 并写入回滚期记录，两边 id 会冲突，这里不自动合并，只告警留给人工核对。
"""
import logging
from collections.abc import Iterable

from . import db

log = logging.getLogger("ops.ledger")

LEDGER_TABLE = "ops_runs"
LEGACY_TABLE = "backup_runs"
STATE_TABLE = "ops_trigger_state"

# 枚举只许在末尾追加取值（InnoDB 对末尾追加是即时元数据变更，不重建表）
RUN_KINDS = ("db", "storage", "restore", "drill", "holiday")
TRIGGER_SOURCES = ("cron", "manual", "once")
TRIGGER_RESULTS = ("success", "failed", "skipped")

# 旧台账没有 task_key：按 kind 回填（v1 只有这三类记录）
LEGACY_TASK_KEYS = {"db": "backup.db", "storage": "backup.storage", "restore": "restore"}


def _enum(values: Iterable[str]) -> str:
    return "ENUM(" + ",".join(f"'{v}'" for v in values) + ")"


LEDGER_DDL = f"""
CREATE TABLE IF NOT EXISTS `{LEDGER_TABLE}` (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  kind {_enum(RUN_KINDS)} NOT NULL,
  task_key VARCHAR(64) NULL,
  trigger_source {_enum(TRIGGER_SOURCES)} NOT NULL,
  status ENUM('running','success','failed') NOT NULL,
  path VARCHAR(255) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  detail TEXT NULL,
  error TEXT NULL,
  started_at DATETIME NOT NULL,
  finished_at DATETIME NULL,
  INDEX idx_started (started_at),
  INDEX idx_kind_status (kind, status),
  INDEX idx_task_started (task_key, started_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""

STATE_DDL = f"""
CREATE TABLE IF NOT EXISTS `{STATE_TABLE}` (
  trigger_key VARCHAR(96) NOT NULL PRIMARY KEY,
  task_key VARCHAR(64) NOT NULL,
  next_fire_at DATETIME NULL,
  last_fired_at DATETIME NULL,
  last_run_id BIGINT UNSIGNED NULL,
  last_result {_enum(TRIGGER_RESULTS)} NULL,
  updated_at DATETIME NOT NULL,
  INDEX idx_task (task_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""


def ensure_schema(conn) -> list[str]:
    """台账与状态表的幂等建表/演进；返回本次实际执行的动作（日志与测试断言用）。"""
    actions: list[str] = []
    has_ledger = db.table_exists(conn, LEDGER_TABLE)
    has_legacy = db.table_exists(conn, LEGACY_TABLE)
    with conn.cursor() as cur:
        if not has_ledger and has_legacy:
            cur.execute(f"ALTER TABLE `{LEGACY_TABLE}` RENAME TO `{LEDGER_TABLE}`")
            actions.append("rename-legacy")
        elif not has_ledger:
            cur.execute(LEDGER_DDL)
            actions.append("create-ledger")
        elif has_legacy:
            log.warning(
                "旧台账 %s 与新台账 %s 并存（回滚期旧镜像写入？）：未自动合并，请人工核对",
                LEGACY_TABLE,
                LEDGER_TABLE,
            )
            actions.append("legacy-coexists")

        if db.column_type(conn, LEDGER_TABLE, "task_key") is None:
            cur.execute(
                f"ALTER TABLE `{LEDGER_TABLE}` ADD COLUMN task_key VARCHAR(64) NULL AFTER kind, "
                "ADD INDEX idx_task_started (task_key, started_at)"
            )
            for kind, task_key in LEGACY_TASK_KEYS.items():
                cur.execute(
                    f"UPDATE `{LEDGER_TABLE}` SET task_key = %s WHERE task_key IS NULL AND kind = %s",
                    (task_key, kind),
                )
            actions.append("add-task-key")

        for column, values in (("kind", RUN_KINDS), ("trigger_source", TRIGGER_SOURCES)):
            if (db.column_type(conn, LEDGER_TABLE, column) or "").lower() != _enum(values).lower():
                cur.execute(f"ALTER TABLE `{LEDGER_TABLE}` MODIFY COLUMN `{column}` {_enum(values)} NOT NULL")
                actions.append(f"widen-{column}")

        if not db.table_exists(conn, STATE_TABLE):
            cur.execute(STATE_DDL)
            actions.append("create-state")
    return actions


# ── 运行记录 ─────────────────────────────────────────────


def insert_run(kind: str, trigger_source: str, task_key: str) -> int:
    """插入一条 running 记录并返回 id。"""
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"INSERT INTO `{LEDGER_TABLE}` (kind, task_key, trigger_source, status, started_at) "
                "VALUES (%s, %s, %s, 'running', %s)",
                (kind, task_key, trigger_source, db.now()),
            )
            return int(cur.lastrowid)
    finally:
        conn.close()


def finish_run(
    run_id: int,
    status: str,
    *,
    path: str | None = None,
    size: int | None = None,
    detail: str | None = None,
    error: str | None = None,
) -> bool:
    """记录结束状态（只收尾仍在 running 的记录，避免覆盖已被回收为 failed 的残留）；返回是否命中。"""
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE `{LEDGER_TABLE}` SET status=%s, path=%s, size_bytes=%s, detail=%s, error=%s, "
                "finished_at=%s WHERE id=%s AND status='running'",
                (status, path, size, detail, error, db.now(), run_id),
            )
            return cur.rowcount > 0
    finally:
        conn.close()


_RUN_COLUMNS = (
    "id",
    "kind",
    "task_key",
    "trigger_source",
    "status",
    "path",
    "size_bytes",
    "detail",
    "error",
    "started_at",
    "finished_at",
)


def _rows_to_dicts(cur) -> list[dict]:
    return [dict(zip(_RUN_COLUMNS, row)) for row in cur.fetchall()]


def get_run(run_id: int) -> dict | None:
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT {', '.join(_RUN_COLUMNS)} FROM `{LEDGER_TABLE}` WHERE id=%s", (run_id,))
            rows = _rows_to_dicts(cur)
            return rows[0] if rows else None
    finally:
        conn.close()


def list_runs(limit: int = 50) -> list[dict]:
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {', '.join(_RUN_COLUMNS)} FROM `{LEDGER_TABLE}` ORDER BY id DESC LIMIT %s",
                (max(1, min(limit, 200)),),
            )
            return _rows_to_dicts(cur)
    finally:
        conn.close()


def running_count(kinds: Iterable[str]) -> int:
    """指定类别中仍在 running 的记录数（手动触发前的忙碌预检）。"""
    kinds = tuple(kinds)
    if not kinds:
        return 0
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            placeholders = ",".join(["%s"] * len(kinds))
            cur.execute(
                f"SELECT COUNT(*) FROM `{LEDGER_TABLE}` WHERE status='running' AND kind IN ({placeholders})",
                kinds,
            )
            return int(cur.fetchone()[0])
    finally:
        conn.close()


def recover_stale_runs(max_minutes: int) -> int:
    """回收进程中断残留（M14 清账 C5）：running 超过 max_minutes 的记录标记 failed，返回回收条数。

    时间比较放在 SQL 里用 NOW()——依赖连接层的会话时区 +08:00（C4），与库内墙面时间同口径。
    """
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE `{LEDGER_TABLE}` SET status='failed', finished_at=NOW(), "
                "error=CONCAT('进程中断推定：运行超过 ', %s, ' 分钟仍未结束（服务重启或崩溃残留）') "
                "WHERE status='running' AND started_at < NOW() - INTERVAL %s MINUTE",
                (max_minutes, max_minutes),
            )
            return int(cur.rowcount)
    finally:
        conn.close()


# ── 触发器状态（后台「下次运行」的数据源，web 不复算 cron） ──────────────


def sync_trigger_states(entries: dict[str, tuple[str, str | None]]) -> None:
    """按当前生效的触发器集合刷新状态表：entries = {trigger_key: (task_key, next_fire_at)}。

    不在集合里的旧状态行一并删除（触发器被删/停用后不该再展示「下次运行」）。
    """
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            stamp = db.now()
            for trigger_key, (task_key, next_fire_at) in entries.items():
                cur.execute(
                    f"INSERT INTO `{STATE_TABLE}` (trigger_key, task_key, next_fire_at, updated_at) "
                    "VALUES (%s, %s, %s, %s) AS new "
                    "ON DUPLICATE KEY UPDATE task_key = new.task_key, next_fire_at = new.next_fire_at, "
                    "updated_at = new.updated_at",
                    (trigger_key, task_key, next_fire_at, stamp),
                )
            if entries:
                placeholders = ",".join(["%s"] * len(entries))
                cur.execute(
                    f"DELETE FROM `{STATE_TABLE}` WHERE trigger_key NOT IN ({placeholders})",
                    tuple(entries),
                )
            else:
                cur.execute(f"DELETE FROM `{STATE_TABLE}`")
    finally:
        conn.close()


def record_trigger_fire(
    trigger_key: str, task_key: str, run_id: int | None, result: str, next_fire_at: str | None
) -> None:
    """记一次触发结果（成功/失败/因互斥跳过）与新的下次触发时间。"""
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            stamp = db.now()
            cur.execute(
                f"INSERT INTO `{STATE_TABLE}` "
                "(trigger_key, task_key, next_fire_at, last_fired_at, last_run_id, last_result, updated_at) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) AS new "
                "ON DUPLICATE KEY UPDATE next_fire_at = new.next_fire_at, last_fired_at = new.last_fired_at, "
                "last_run_id = new.last_run_id, last_result = new.last_result, updated_at = new.updated_at",
                (trigger_key, task_key, next_fire_at, stamp, run_id, result, stamp),
            )
    finally:
        conn.close()


def fired_trigger_keys() -> set[str]:
    """触发过的触发器键（单次触发器据此不再重复登记）。"""
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT trigger_key FROM `{STATE_TABLE}` WHERE last_fired_at IS NOT NULL")
            return {str(row[0]) for row in cur.fetchall()}
    finally:
        conn.close()


def load_trigger_states() -> dict[str, dict]:
    conn = db.connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT trigger_key, task_key, next_fire_at, last_fired_at, last_run_id, last_result "
                f"FROM `{STATE_TABLE}`"
            )
            cols = ("trigger_key", "task_key", "next_fire_at", "last_fired_at", "last_run_id", "last_result")
            return {str(row[0]): dict(zip(cols, row)) for row in cur.fetchall()}
    finally:
        conn.close()
