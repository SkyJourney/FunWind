"""台账演进（D7 三态）、会话时区（C4）、残留回收（C5）与触发器状态——真实 MySQL 临时库。"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from app import ledger
from contract import LEGACY_BACKUP_RUNS_DDL

pytestmark = pytest.mark.db
SHANGHAI = ZoneInfo("Asia/Shanghai")


def _tables(conn) -> set[str]:
    with conn.cursor() as cur:
        cur.execute("SHOW TABLES")
        return {row[0] for row in cur.fetchall()}


def _beijing(delta: timedelta) -> str:
    return (datetime.now(SHANGHAI) + delta).strftime("%Y-%m-%d %H:%M:%S")


def test_session_time_zone_is_beijing(db_conn):
    with db_conn.cursor() as cur:
        cur.execute("SELECT @@session.time_zone")
        assert cur.fetchone()[0] == "+08:00"


def test_fresh_database_creates_ledger_and_state_then_is_idempotent(db_conn):
    assert ledger.ensure_schema(db_conn) == ["create-ledger", "create-state"]
    assert ledger.ensure_schema(db_conn) == []
    assert {"ops_runs", "ops_trigger_state"} <= _tables(db_conn)


def test_legacy_backup_runs_is_renamed_with_rows_and_ids_preserved(db_conn):
    with db_conn.cursor() as cur:
        cur.execute(LEGACY_BACKUP_RUNS_DDL)
        for kind in ("db", "storage", "restore"):
            cur.execute(
                "INSERT INTO backup_runs (kind, trigger_source, status, path, started_at) "
                "VALUES (%s, 'cron', 'success', %s, NOW())",
                (kind, f"/data/{kind}.gz"),
            )
        cur.execute("DELETE FROM backup_runs WHERE kind = 'storage'")  # 制造 id 空洞：AUTO_INCREMENT 不得回退

    actions = ledger.ensure_schema(db_conn)

    assert actions == ["rename-legacy", "add-task-key", "widen-kind", "widen-trigger_source", "create-state"]
    tables = _tables(db_conn)
    assert "backup_runs" not in tables and "ops_runs" in tables
    with db_conn.cursor() as cur:
        cur.execute("SELECT id, kind, task_key, path FROM ops_runs ORDER BY id")
        assert cur.fetchall() == ((1, "db", "backup.db", "/data/db.gz"), (3, "restore", "restore", "/data/restore.gz"))
    # 新类别与新触发来源可写，且 id 接续旧序列（恢复按 run id 定位，id 不能断）
    assert ledger.insert_run("drill", "once", "drill.restore") == 4
    assert ledger.ensure_schema(db_conn) == []


def test_coexisting_legacy_table_is_left_for_manual_review(db_conn):
    ledger.ensure_schema(db_conn)
    with db_conn.cursor() as cur:
        cur.execute(LEGACY_BACKUP_RUNS_DDL)
    assert ledger.ensure_schema(db_conn) == ["legacy-coexists"]
    assert "backup_runs" in _tables(db_conn)


def test_recover_stale_runs_only_touches_old_running_rows(db_conn):
    """两条记录的开始时间都用北京墙面时间写入：会话时区若不是 +08:00，NOW() 偏 8 小时，判定会错。"""
    ledger.ensure_schema(db_conn)
    with db_conn.cursor() as cur:
        cur.execute(
            "INSERT INTO ops_runs (kind, task_key, trigger_source, status, started_at) "
            "VALUES ('db', 'backup.db', 'cron', 'running', %s)",
            (_beijing(timedelta(hours=-3)),),
        )
        stale_id = cur.lastrowid
        cur.execute(
            "INSERT INTO ops_runs (kind, task_key, trigger_source, status, started_at) "
            "VALUES ('storage', 'backup.storage', 'cron', 'running', %s)",
            (_beijing(timedelta(minutes=-30)),),
        )
        fresh_id = cur.lastrowid

    assert ledger.recover_stale_runs(120) == 1
    stale, fresh = ledger.get_run(stale_id), ledger.get_run(fresh_id)
    assert stale["status"] == "failed" and "进程中断推定" in stale["error"] and stale["finished_at"] is not None
    assert fresh["status"] == "running"
    assert ledger.recover_stale_runs(120) == 0


def test_finish_run_never_overwrites_a_settled_row(db_conn):
    ledger.ensure_schema(db_conn)
    run_id = ledger.insert_run("db", "cron", "backup.db")
    assert ledger.finish_run(run_id, "failed", error="中断") is True
    assert ledger.finish_run(run_id, "success") is False
    assert ledger.get_run(run_id)["status"] == "failed"


def test_trigger_state_sync_prunes_and_keeps_fire_history(db_conn):
    ledger.ensure_schema(db_conn)
    ledger.sync_trigger_states({"t1": ("backup.db", "2026-11-10 03:10:00"), "t2": ("backup.storage", None)})
    ledger.record_trigger_fire("t1", "backup.db", 7, "success", "2026-11-11 03:10:00")
    ledger.sync_trigger_states({"t1": ("backup.db", "2026-11-11 03:10:00")})

    states = ledger.load_trigger_states()
    assert set(states) == {"t1"}
    assert states["t1"]["last_result"] == "success" and states["t1"]["last_run_id"] == 7
    assert str(states["t1"]["next_fire_at"]) == "2026-11-11 03:10:00"
    assert ledger.fired_trigger_keys() == {"t1"}


def test_running_count_by_kinds(db_conn):
    ledger.ensure_schema(db_conn)
    ledger.insert_run("storage", "manual", "backup.storage")
    assert ledger.running_count(("db", "storage")) == 1
    assert ledger.running_count(("holiday",)) == 0
    assert ledger.running_count(()) == 0
